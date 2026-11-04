//! Banner reminders for the notice categories the user opted into (right-click
//! a category in the 通知 view). The notice center has no realtime channel in
//! the web page, so while any category is opted in this reads the category
//! overview every `POLL_PERIOD` through the account's own page, and asks for
//! the list only when a category moved. Reads only: nothing marks a notice read.
//!
//! The first read of a category only sets its mark: notices that arrived before
//! the opt-in, a restart or a re-login never pop up. Notice text goes only to
//! the local `notice` window; `WatchedNotice` has no `Debug`, so it cannot reach
//! a log.

use std::{
    collections::{BTreeMap, HashMap},
    time::{Duration, Instant},
};

use contracts::{AccountContext, AppError};
use core_notify::BANNER_STAY_MS;
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::{adapter, dto::AccountContextDto, events, notifications, prefs, state::HostState};

const POLL_PERIOD: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
struct WatchedCategory {
    id: String,
    name: String,
    last_msg_time: i64,
    last_msg_id: Option<String>,
}

#[derive(Deserialize)]
struct WatchedNotice {
    id: String,
    title: String,
    body: String,
    time_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Mark {
    time: i64,
    id: Option<String>,
}

#[derive(Default)]
struct AccountWatch {
    generation: u64,
    marks: HashMap<String, Mark>,
    /// Count on the category's card, while that card may still be on screen.
    shown: HashMap<String, (u32, Instant)>,
}

impl AccountWatch {
    /// Moves the marks forward; returns each moved category with its old mark.
    /// Categories missing from this read keep their mark.
    fn advance<'a>(
        &mut self,
        subscribed: &[String],
        seen: &'a [WatchedCategory],
    ) -> Vec<(&'a WatchedCategory, Mark)> {
        self.marks.retain(|id, _| subscribed.contains(id));
        self.shown.retain(|id, _| subscribed.contains(id));
        let mut moved = Vec::new();
        for category in seen.iter().filter(|c| subscribed.contains(&c.id)) {
            let next = Mark {
                time: category.last_msg_time,
                id: category.last_msg_id.clone(),
            };
            let Some(mark) = self.marks.get_mut(&category.id) else {
                self.marks.insert(category.id.clone(), next);
                continue;
            };
            let same_time_new_id =
                next.time == mark.time && next.id.is_some() && next.id != mark.id;
            if next.time > mark.time || same_time_new_id {
                moved.push((category, std::mem::replace(mark, next)));
            }
        }
        moved
    }

    /// One card per category: while it is up, later notices add to its count.
    fn card_count(&mut self, category: &str, added: u32, now: Instant) -> u32 {
        let stay = Duration::from_millis(BANNER_STAY_MS);
        let previous = match self.shown.get(category) {
            Some((count, until)) if *until > now => *count,
            _ => 0,
        };
        let count = previous.saturating_add(added);
        self.shown.insert(category.to_string(), (count, now + stay));
        count
    }
}

/// Notices newer than the old mark. The mark's id decides when the page still
/// holds it, so a category timestamp in another unit cannot invent notices.
fn newer_than<'a>(notices: &'a [WatchedNotice], mark: &Mark) -> Vec<&'a WatchedNotice> {
    let mut ordered: Vec<&WatchedNotice> = notices.iter().collect();
    ordered.sort_by_key(|n| n.time_ms);
    match ordered
        .iter()
        .rposition(|n| Some(&n.id) == mark.id.as_ref())
    {
        Some(at) => ordered.split_off(at + 1),
        None => {
            ordered.retain(|n| n.time_ms > mark.time);
            ordered
        }
    }
}

fn preview(notice: &WatchedNotice) -> Option<String> {
    crate::dto::alarm_preview(&notice.title).or_else(|| crate::dto::alarm_preview(&notice.body))
}

fn contexts(app: &AppHandle) -> Vec<AccountContext> {
    let state = app.state::<HostState>();
    let cores = state.lock();
    cores
        .accounts
        .account_ids()
        .iter()
        .filter_map(|id| cores.accounts.current_context(id))
        .filter(|ctx| cores.accounts.validate(ctx).is_ok())
        .collect()
}

/// Same quiet rules as a new-message banner. Checked again after the reads:
/// the account may have logged out while they ran.
fn may_show(app: &AppHandle, account: &AccountContext) -> bool {
    let state = app.state::<HostState>();
    let mut cores = state.lock();
    let now = state.now(&mut cores);
    cores.accounts.validate(account).is_ok()
        && cores.notify.banner_allowed(&now)
        && !cores.notify.system_state().locked
}

async fn read<T: serde::de::DeserializeOwned>(
    app: &AppHandle,
    account: &AccountContext,
    op: &str,
    args: serde_json::Value,
) -> Result<T, AppError> {
    let reply = adapter::request(app, account, op, args, adapter::READ_TIMEOUT).await?;
    serde_json::from_value(reply)
        .map_err(|_| AppError::new("notice.watch_reply", "unexpected notice reply"))
}

async fn poll_account(
    app: &AppHandle,
    account: &AccountContext,
    subscribed: &[String],
    watch: &mut AccountWatch,
) {
    if watch.generation != account.session_generation {
        *watch = AccountWatch {
            generation: account.session_generation,
            ..AccountWatch::default()
        };
    }
    let seen: Vec<WatchedCategory> = match read(app, account, "notice.watch", json!({})).await {
        Ok(seen) => seen,
        Err(error) => {
            log::debug!("notice watch skipped: {}", error.code);
            return;
        }
    };
    for (category, mark) in watch.advance(subscribed, &seen) {
        let args = json!({ "category_id": category.id, "before_ms": null });
        let notices = read::<Vec<WatchedNotice>>(app, account, "notice.list", args).await;
        let (added, text) = match &notices {
            Ok(notices) => {
                let newer = newer_than(notices, &mark);
                // The overview moved without a new notice in the list.
                let Some(newest) = newer.last() else { continue };
                (newer.len() as u32, preview(newest))
            }
            Err(error) => {
                log::debug!("notice watch list failed: {}", error.code);
                (1, None)
            }
        };
        let target = json!({
            "account": AccountContextDto::from(account),
            "category_id": category.id,
        });
        events::to_main(app, events::NOTICE_NEW, target);
        if may_show(app, account) {
            let count = watch.card_count(&category.id, added, Instant::now());
            notifications::show_category(
                app,
                account,
                &category.id,
                &category.name,
                text,
                count,
                BANNER_STAY_MS,
            );
        }
    }
}

async fn poll(
    app: &AppHandle,
    subscriptions: &BTreeMap<String, Vec<String>>,
    watches: &mut HashMap<String, AccountWatch>,
) {
    watches.retain(|key, _| subscriptions.contains_key(key));
    for account in contexts(app) {
        let key = prefs::notice_banner_key(&account);
        let Some(subscribed) = subscriptions.get(&key).filter(|c| !c.is_empty()) else {
            continue;
        };
        poll_account(app, &account, subscribed, watches.entry(key).or_default()).await;
    }
}

/// Called once from `lib.rs` setup. Idle (no page requests) until a category is opted in.
pub fn init(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut watches = HashMap::new();
        loop {
            tokio::time::sleep(POLL_PERIOD).await;
            poll(&app, &prefs::notice_banner_accounts(&app), &mut watches).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn category(id: &str, time: i64, last: Option<&str>) -> WatchedCategory {
        WatchedCategory {
            id: id.into(),
            name: "系统".into(),
            last_msg_time: time,
            last_msg_id: last.map(Into::into),
        }
    }

    fn notice(id: &str, time_ms: i64) -> WatchedNotice {
        WatchedNotice {
            id: id.into(),
            title: format!("标题{id}"),
            body: String::new(),
            time_ms,
        }
    }

    fn moved(
        watch: &mut AccountWatch,
        subscribed: &[&str],
        seen: &[WatchedCategory],
    ) -> Vec<String> {
        let subscribed: Vec<String> = subscribed.iter().map(|s| s.to_string()).collect();
        watch
            .advance(&subscribed, seen)
            .into_iter()
            .map(|(c, _)| c.id.clone())
            .collect()
    }

    #[test]
    fn the_first_read_only_sets_the_mark_and_later_reads_report_new_notices() {
        let mut watch = AccountWatch::default();
        let first = [category("1:1", 100, Some("a")), category("1:2", 50, None)];
        assert!(moved(&mut watch, &["1:1"], &first).is_empty());
        assert!(moved(&mut watch, &["1:1"], &first).is_empty());
        let next = [category("1:1", 200, Some("b")), category("1:2", 90, None)];
        assert_eq!(moved(&mut watch, &["1:1"], &next), ["1:1"]);
        assert!(
            moved(&mut watch, &["1:1"], &next).is_empty(),
            "reported once"
        );
    }

    #[test]
    fn the_same_timestamp_with_a_new_id_counts_but_an_older_one_does_not() {
        let mut watch = AccountWatch::default();
        moved(&mut watch, &["1:1"], &[category("1:1", 100, Some("a"))]);
        let same = [category("1:1", 100, Some("b"))];
        assert_eq!(moved(&mut watch, &["1:1"], &same), ["1:1"]);
        assert!(moved(&mut watch, &["1:1"], &[category("1:1", 90, Some("z"))]).is_empty());
        assert!(moved(&mut watch, &["1:1"], &[category("1:1", 100, None)]).is_empty());
    }

    #[test]
    fn opting_out_forgets_the_mark_so_opting_back_in_does_not_replay_the_backlog() {
        let mut watch = AccountWatch::default();
        moved(&mut watch, &["1:1"], &[category("1:1", 100, Some("a"))]);
        moved(&mut watch, &[], &[category("1:1", 150, Some("b"))]);
        assert!(moved(&mut watch, &["1:1"], &[category("1:1", 200, Some("c"))]).is_empty());
    }

    #[test]
    fn a_missing_category_keeps_its_mark() {
        let mut watch = AccountWatch::default();
        moved(&mut watch, &["1:1"], &[category("1:1", 100, Some("a"))]);
        assert!(moved(&mut watch, &["1:1"], &[]).is_empty());
        assert_eq!(
            moved(&mut watch, &["1:1"], &[category("1:1", 101, Some("b"))]),
            ["1:1"]
        );
    }

    #[test]
    fn newer_notices_follow_the_marked_id_and_fall_back_to_time() {
        let notices = [notice("c", 300), notice("a", 100), notice("b", 200)];
        let ids = |mark: Mark| -> Vec<String> {
            newer_than(&notices, &mark)
                .iter()
                .map(|n| n.id.clone())
                .collect()
        };
        assert_eq!(
            ids(Mark {
                time: 1,
                id: Some("a".into())
            }),
            ["b", "c"]
        );
        assert_eq!(
            ids(Mark {
                time: 150,
                id: Some("gone".into())
            }),
            ["b", "c"]
        );
        assert_eq!(
            ids(Mark {
                time: 150,
                id: None
            }),
            ["b", "c"]
        );
        assert!(ids(Mark {
            time: 999,
            id: Some("c".into())
        })
        .is_empty());
    }

    #[test]
    fn a_card_on_screen_adds_up_and_an_expired_one_starts_over() {
        let mut watch = AccountWatch::default();
        let now = Instant::now();
        assert_eq!(watch.card_count("1:1", 2, now), 2);
        assert_eq!(watch.card_count("1:1", 1, now + Duration::from_secs(1)), 3);
        assert_eq!(watch.card_count("1:2", 1, now), 1);
        let later = now + Duration::from_secs(1) + Duration::from_millis(BANNER_STAY_MS + 1);
        assert_eq!(watch.card_count("1:1", 1, later), 1);
    }

    #[test]
    fn the_preview_uses_the_title_then_the_body() {
        assert_eq!(preview(&notice("a", 1)).as_deref(), Some("标题a"));
        let body_only = WatchedNotice {
            id: "b".into(),
            title: " ".into(),
            body: "正文".into(),
            time_ms: 1,
        };
        assert_eq!(preview(&body_only).as_deref(), Some("正文"));
    }
}
