//! Native-only vbkdesk ingress. Unlike the upstream deep-link runtime plugin,
//! this plugin never broadcasts raw URLs to the remote account webviews.
//! The deep-link installer config supplies protocol metadata via Tauri CLI;
//! macOS Opened events and Windows second-instance argv enter this whitelist.
//! Pending navigation is bounded, expires, and is pulled by the ready main UI.
use crate::{
    dto::{AccountContextDto, AppErrorDto},
    state::HostState,
};
use contracts::{AccountContext, AppError};
use core_update::deeplink::{self, DeepLinkAction};
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State, Window};

const MAX_PENDING: usize = 16;
const TTL: Duration = Duration::from_secs(60);
const PENDING_EVENT: &str = "deeplink://pending";

#[derive(Debug, Clone)]
struct Pending {
    action: DeepLinkAction,
    owner: Option<AccountContext>,
    received: Instant,
}
#[derive(Default)]
struct Inbox {
    queue: Mutex<VecDeque<Pending>>,
    setting: Mutex<Option<(&'static str, Instant)>>,
}

fn push(queue: &mut VecDeque<Pending>, item: Pending) {
    queue.retain(|p| item.received.saturating_duration_since(p.received) < TTL);
    if queue
        .iter()
        .any(|p| p.action == item.action && p.owner == item.owner)
    {
        return;
    }
    if queue.len() == MAX_PENDING {
        queue.pop_front();
    }
    queue.push_back(item);
}

fn enqueue(app: &AppHandle, action: DeepLinkAction) {
    let owner = crate::login::active_context(app);
    if let Some(inbox) = app.try_state::<Inbox>() {
        push(
            &mut inbox.queue.lock().unwrap_or_else(|p| p.into_inner()),
            Pending {
                action,
                owner,
                received: Instant::now(),
            },
        );
        // Plugin setup can receive cold links before storage/HostState exist.
        // Keep the bounded request for the ready UI; never reveal a business
        // window while startup is blocked on an unavailable durable store.
        if app.try_state::<HostState>().is_some() {
            crate::windows::show_main(app);
            crate::events::to_main(app, PENDING_EVENT, ());
        }
    }
}

#[cfg(target_os = "macos")]
fn on_url(app: &AppHandle, url: &str) {
    match deeplink::parse(url) {
        Ok(action) => enqueue(app, action),
        Err(reason) => log::warn!("deep link rejected: {reason:?}"),
    }
}

pub fn on_second_instance(app: &AppHandle, args: Vec<String>) {
    if let Some(action) = crate::startup_args::request(args.into_iter().skip(1)) {
        enqueue(app, action);
    }
}

/// Do not initialize tauri_plugin_deep_link::init(): its global URL event
/// reaches acct-* webviews, which have event-listen rights for adapter RPC.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("vbk-deep-link-runtime")
        .setup(|app, _| {
            app.manage(Inbox::default());
            if let Some(action) = crate::startup_args::request(
                std::env::args_os()
                    .skip(1)
                    .map(|arg| arg.to_string_lossy().into_owned()),
            ) {
                enqueue(app, action);
            }
            Ok(())
        })
        .on_event(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                for url in urls.iter().take(MAX_PENDING) {
                    on_url(app, url.as_str());
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        })
        .build()
}

#[derive(Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Navigation {
    Conversation {
        account: AccountContextDto,
        gid: String,
    },
}

#[derive(Debug, PartialEq)]
enum Decision {
    Drop,
    Wait,
    Focus,
    Conversation(AccountContext, String),
    Settings(&'static str),
}

fn decide(
    pending: &Pending,
    active: Option<&AccountContext>,
    known_gid: bool,
    now: Instant,
) -> Decision {
    if now.saturating_duration_since(pending.received) >= TTL {
        return Decision::Drop;
    }
    match &pending.action {
        DeepLinkAction::FocusMain => Decision::Focus,
        DeepLinkAction::OpenSettings { section } => Decision::Settings(section),
        DeepLinkAction::OpenConversation { session_id } => {
            // A hot link is bound to the account generation at receipt. A cold
            // link may wait for the first login, but never switches accounts.
            if pending
                .owner
                .as_ref()
                .is_some_and(|owner| Some(owner) != active)
            {
                return Decision::Drop;
            }
            match active {
                Some(ctx) if known_gid => Decision::Conversation(ctx.clone(), session_id.clone()),
                _ => Decision::Wait,
            }
        }
    }
}

#[tauri::command]
pub fn deep_link_take(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
) -> Result<Vec<Navigation>, AppErrorDto> {
    state
        .authorize(window.label(), "deep_link_take")
        .map_err(AppErrorDto::from)?;
    if window.label() != crate::views::MAIN {
        return Err(
            AppError::new(contracts::codes::HOST_UNSUPPORTED, "main window required").into(),
        );
    }
    let active = crate::login::active_context(&app);
    let inbox = app.state::<Inbox>();
    let mut queue = inbox.queue.lock().unwrap_or_else(|p| p.into_inner());
    let mut deferred = VecDeque::new();
    let mut result = Vec::new();
    let now = Instant::now();
    while let Some(mut pending) = queue.pop_front() {
        // Bind a cold pending conversation at its first authenticated poll,
        // even if its registry has not hydrated yet. Later account switches
        // cannot redirect the pending request into another account.
        if matches!(pending.action, DeepLinkAction::OpenConversation { .. })
            && pending.owner.is_none()
        {
            pending.owner = active.clone();
        }
        let known = if let (Some(ctx), DeepLinkAction::OpenConversation { session_id }) =
            (&active, &pending.action)
        {
            let mut cores = state.lock();
            cores.accounts.validate(ctx).is_ok()
                && cores
                    .im
                    .get_mut(ctx)
                    .is_some_and(|im| im.conversations().get(session_id).is_some())
        } else {
            false
        };
        match decide(&pending, active.as_ref(), known, now) {
            Decision::Drop => {}
            Decision::Wait => deferred.push_back(pending),
            Decision::Focus => crate::windows::show_main(&app),
            Decision::Settings(section) => {
                *inbox.setting.lock().unwrap_or_else(|p| p.into_inner()) =
                    Some((section, pending.received));
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = crate::windows::open_setting(&handle).await {
                        log::warn!("deep link settings window unavailable: {error}");
                    } else {
                        let _ =
                            handle.emit_to(crate::views::SETTING, "deeplink://setting-pending", ());
                    }
                });
            }
            Decision::Conversation(ctx, gid) => result.push(Navigation::Conversation {
                account: (&ctx).into(),
                gid,
            }),
        }
    }
    *queue = deferred;
    Ok(result)
}

#[tauri::command]
pub fn deep_link_setting_take(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
) -> Result<Option<String>, AppErrorDto> {
    state
        .authorize(window.label(), "deep_link_setting_take")
        .map_err(AppErrorDto::from)?;
    if window.label() != crate::views::SETTING {
        return Err(AppError::new(
            contracts::codes::HOST_UNSUPPORTED,
            "settings window required",
        )
        .into());
    }
    let inbox = app.state::<Inbox>();
    let pending = inbox
        .setting
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
    Ok(pending
        .filter(|(_, received)| received.elapsed() < TTL)
        .map(|(section, _)| section.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ctx(generation: u64) -> AccountContext {
        AccountContext::new(
            contracts::AccountId::new("account"),
            contracts::Environment::named("production"),
            generation,
        )
    }
    fn pending(owner: Option<AccountContext>, now: Instant) -> Pending {
        Pending {
            action: DeepLinkAction::OpenConversation {
                session_id: "g".into(),
            },
            owner,
            received: now,
        }
    }
    #[test]
    fn queued_until_login_and_known_conversation_and_expire() {
        let now = Instant::now();
        let account = ctx(1);
        let p = pending(None, now);
        assert_eq!(decide(&p, None, false, now), Decision::Wait);
        assert_eq!(decide(&p, Some(&account), false, now), Decision::Wait);
        assert_eq!(
            decide(&p, Some(&account), true, now),
            Decision::Conversation(account, "g".into())
        );
        assert_eq!(decide(&p, None, false, now + TTL), Decision::Drop);
    }
    #[test]
    fn hot_link_never_crosses_account_generation_or_logout() {
        let now = Instant::now();
        let account = ctx(1);
        let p = pending(Some(account.clone()), now);
        assert_eq!(decide(&p, Some(&ctx(2)), true, now), Decision::Drop);
        assert_eq!(decide(&p, None, true, now), Decision::Drop);
        assert_eq!(
            decide(&p, Some(&account), true, now),
            Decision::Conversation(account, "g".into())
        );
    }
    #[test]
    fn native_ingress_ten_thousand_hostile_invocations_stay_bounded() {
        let mut queue = VecDeque::new();
        let now = Instant::now();
        let mut seed = 42u64;
        for n in 0..10_000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let input = match n % 6 {
                0 => format!("vbkdesk://conversation?session=g_{n}"),
                1 => format!("vbkdesk://conversation?session=%{:x}", seed),
                2 => format!("vbookingChat://open?auth={seed}"),
                3 => format!("vbkdesk://settings?section=keys&cmd={seed}"),
                4 => format!("--remote-debugging-port={seed}"),
                _ => String::from_utf8_lossy(&seed.to_le_bytes()).into_owned(),
            };
            if let Some(action) = crate::startup_args::request([input]) {
                assert!(action.is_within_whitelist());
                push(
                    &mut queue,
                    Pending {
                        action,
                        owner: None,
                        received: now,
                    },
                );
            }
            assert!(queue.len() <= MAX_PENDING);
        }
        assert_eq!(queue.len(), MAX_PENDING);
    }
    #[test]
    fn bounded_queue_deduplicates_and_evicts_oldest() {
        let now = Instant::now();
        let mut queue = VecDeque::new();
        push(&mut queue, pending(None, now));
        push(&mut queue, pending(None, now));
        assert_eq!(queue.len(), 1);
        for n in 0..100 {
            push(
                &mut queue,
                Pending {
                    action: DeepLinkAction::OpenConversation {
                        session_id: format!("g{n}"),
                    },
                    owner: None,
                    received: now,
                },
            );
        }
        assert_eq!(queue.len(), MAX_PENDING);
        assert_eq!(
            queue.front().unwrap().action,
            DeepLinkAction::OpenConversation {
                session_id: "g84".into()
            }
        );
        push(&mut queue, pending(None, now + TTL));
        assert_eq!(queue.len(), 1);
    }
}
