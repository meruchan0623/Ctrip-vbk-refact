//! New-message notifications drawn in the host's own always-on-top `notice`
//! window, independent of the main webview's visibility. Each one carries the
//! account generation and conversation, independently of timeout rounds and
//! the currently selected account. Customer name and message preview come from
//! the in-memory display cache and go only to this window; `Notice` has no
//! `Debug`, so neither can reach a log.
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use contracts::AccountContext;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    adapter::display::DisplayConversationDto, dto::AccountContextDto, events, state::HostState,
    views, windows,
};

/// A card may still gain its preview or real name this long after it shows.
const REFRESH_WINDOW_EXTRA: Duration = Duration::from_secs(4);
const MAX_RECENT: usize = 32;

#[derive(Clone, Serialize)]
struct NoticeContent {
    title: String,
    preview: Option<String>,
}

#[derive(Clone, Serialize)]
struct Notice<'a> {
    account: AccountContextDto,
    gid: &'a str,
    #[serde(flatten)]
    content: NoticeContent,
    count: u32,
    stay_ms: u64,
    /// Set on a notice-center card; a click then opens this category.
    #[serde(skip_serializing_if = "Option::is_none")]
    category_id: Option<&'a str>,
}

#[derive(Clone, Serialize)]
struct NoticeUpdate<'a> {
    account: AccountContextDto,
    gid: &'a str,
    #[serde(flatten)]
    content: NoticeContent,
}

/// Conversations whose card may still be on screen. Message facts and display
/// rows are separate IPC calls in no fixed order, so the row a card needs can
/// land after the card; only these conversations get a follow-up.
#[derive(Default)]
pub struct RecentNotices(Mutex<Vec<RecentNotice>>);

struct RecentNotice {
    account: AccountContext,
    gid: String,
    until: Instant,
}

impl RecentNotices {
    fn note(&self, account: &AccountContext, gid: &str, until: Instant, now: Instant) {
        let mut recent = self.0.lock().unwrap_or_else(|e| e.into_inner());
        recent.retain(|r| r.until > now && !(r.account == *account && r.gid == gid));
        if recent.len() >= MAX_RECENT {
            recent.remove(0);
        }
        recent.push(RecentNotice {
            account: account.clone(),
            gid: gid.to_string(),
            until,
        });
    }

    fn matching(&self, account: &AccountContext, gids: &[String], now: Instant) -> Vec<String> {
        let mut recent = self.0.lock().unwrap_or_else(|e| e.into_inner());
        recent.retain(|r| r.until > now);
        recent
            .iter()
            .filter(|r| r.account == *account && gids.contains(&r.gid))
            .map(|r| r.gid.clone())
            .collect()
    }
}

/// A list row older than the customer's latest message still holds the previous
/// preview: that row must not be shown as this message.
fn notice_content(
    row: Option<&DisplayConversationDto>,
    latest_customer_ms: Option<i64>,
) -> NoticeContent {
    let Some(row) = row else {
        return NoticeContent {
            title: String::new(),
            preview: None,
        };
    };
    let current = matches!(
        (row.fact.last_message_time_ms, latest_customer_ms),
        (Some(shown), Some(latest)) if shown >= latest
    );
    NoticeContent {
        title: row.title.trim().to_string(),
        preview: current
            .then(|| crate::dto::alarm_preview(&row.preview))
            .flatten(),
    }
}

fn read_content(app: &AppHandle, account: &AccountContext, gid: &str) -> NoticeContent {
    let latest_customer_ms = app
        .state::<HostState>()
        .lock()
        .im
        .get(account)
        .and_then(|im| im.index().latest_customer_business(gid))
        .map(|message| message.create_time_ms);
    let row = crate::adapter::display_conversation(app, account, gid);
    notice_content(row.as_ref(), latest_customer_ms)
}

pub fn show(app: &AppHandle, account: &AccountContext, gid: &str, count: u32, stay_ms: u64) {
    if let Err(error) = windows::show_notice(app) {
        log::warn!("notice window failed: {error}");
        return;
    }
    let now = Instant::now();
    app.state::<RecentNotices>().note(
        account,
        gid,
        now + Duration::from_millis(stay_ms) + REFRESH_WINDOW_EXTRA,
        now,
    );
    let notice = Notice {
        account: account.into(),
        gid,
        content: read_content(app, account, gid),
        count,
        stay_ms,
        category_id: None,
    };
    if let Err(error) = app.emit_to(views::NOTICE, events::NOTIFY_NOTICE, notice) {
        log::warn!("notice delivery failed: {error}");
    }
}

/// A new notice in a category the user opted into (`notice_watch`): the same
/// card and chime as a new message. Only `category_id` names the target, so
/// `gid` here is just the card's key and can never equal a conversation's.
pub fn show_category(
    app: &AppHandle,
    account: &AccountContext,
    category_id: &str,
    name: &str,
    preview: Option<String>,
    count: u32,
    stay_ms: u64,
) {
    if let Err(error) = windows::show_notice(app) {
        log::warn!("notice window failed: {error}");
        return;
    }
    let notice = Notice {
        account: account.into(),
        gid: &format!("notice-category:{category_id}"),
        content: NoticeContent {
            title: name.to_string(),
            preview,
        },
        count,
        stay_ms,
        category_id: Some(category_id),
    };
    if let Err(error) = app.emit_to(views::NOTICE, events::NOTIFY_NOTICE, notice) {
        log::warn!("notice delivery failed: {error}");
        return;
    }
    let _ = app.emit_to(views::NOTICE, events::NOTIFY_PLAY_SOUND, "new_message");
}

/// A click on a notice-center card. A re-login since the card showed just closes it.
pub fn open_category(app: &AppHandle, account: AccountContext, category_id: String) {
    if app
        .state::<HostState>()
        .lock()
        .accounts
        .validate(&account)
        .is_err()
    {
        return;
    }
    windows::show_main(app);
    let target = serde_json::json!({ "account": AccountContextDto::from(&account), "category_id": category_id });
    if let Err(error) = app.emit_to(views::MAIN, events::NOTICE_LOCATE_CATEGORY, target) {
        log::warn!("notice category navigation failed: {error}");
    }
}

/// Display rows changed: fill in cards that were shown before their row landed.
pub fn refresh(app: &AppHandle, account: &AccountContext, changed: &[String]) {
    if changed.is_empty() {
        return;
    }
    let gids = app
        .state::<RecentNotices>()
        .matching(account, changed, Instant::now());
    for gid in &gids {
        let update = NoticeUpdate {
            account: account.into(),
            gid,
            content: read_content(app, account, gid),
        };
        if let Err(error) = app.emit_to(views::NOTICE, events::NOTIFY_NOTICE_UPDATE, update) {
            log::warn!("notice update failed: {error}");
        }
    }
}

/// A click on a notice. Revalidates at click time so logout/re-login or a
/// transfer cannot route an old notice; such a click just closes it.
pub fn open(app: &AppHandle, account: AccountContext, gid: String) {
    let state = app.state::<HostState>();
    {
        let cores = state.lock();
        if cores.accounts.validate(&account).is_err() {
            return;
        }
        if !cores
            .im
            .get(&account)
            .and_then(|im| im.conversations().get(&gid))
            .is_some_and(|entry| entry.agent_in_group)
        {
            return;
        }
    }
    // show + unminimize + focus; the existing main handler also switches to
    // the notice's account before opening its gid.
    windows::show_main(app);
    let target = serde_json::json!({ "account": AccountContextDto::from(&account), "gid": gid });
    if let Err(error) = app.emit_to(views::MAIN, events::IM_LOCATE_CONVERSATION, target) {
        log::warn!("notice conversation navigation failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use contracts::{AccountId, Environment};

    use super::*;

    fn account(generation: u64) -> AccountContext {
        AccountContext::new(AccountId::new("a"), Environment::production(), generation)
    }

    fn row(title: &str, preview: &str, time: Option<i64>) -> DisplayConversationDto {
        let mut row: DisplayConversationDto = serde_json::from_value(serde_json::json!({
            "gid": "g", "status": "active", "agent_in_group": true, "is_owner": false,
            "service_type": "1", "last_message_time_ms": 1, "last_update_time_ms": 1,
            "unread_count": 0, "is_full_snapshot": false, "title": title, "mark": 0,
            "preview": preview
        }))
        .expect("row");
        row.fact.last_message_time_ms = time;
        row
    }

    #[test]
    fn preview_only_shows_when_the_row_has_caught_up_with_the_message() {
        let current = notice_content(Some(&row(" 张三 ", "明天\n入住", Some(20))), Some(20));
        assert_eq!(current.title, "张三");
        assert_eq!(current.preview.as_deref(), Some("明天 入住"));
        let stale = notice_content(Some(&row("张三", "上一条", Some(10))), Some(20));
        assert_eq!(stale.title, "张三");
        assert_eq!(stale.preview, None);
        assert_eq!(
            notice_content(Some(&row("张三", "x", None)), Some(20)).preview,
            None
        );
        assert_eq!(
            notice_content(Some(&row("张三", "x", Some(20))), None).preview,
            None
        );
        let missing = notice_content(None, Some(20));
        assert!(missing.title.is_empty() && missing.preview.is_none());
    }

    #[test]
    fn only_unexpired_notices_of_the_same_generation_get_refreshed() {
        let recent = RecentNotices::default();
        let now = Instant::now();
        let later = now + Duration::from_secs(10);
        recent.note(&account(1), "g1", later, now);
        recent.note(&account(1), "g2", now + Duration::from_secs(1), now);
        let changed = ["g1".to_string(), "g2".to_string(), "g3".to_string()];
        assert_eq!(recent.matching(&account(1), &changed, now), ["g1", "g2"]);
        assert!(recent.matching(&account(2), &changed, now).is_empty());
        let expired = now + Duration::from_secs(2);
        assert_eq!(recent.matching(&account(1), &changed, expired), ["g1"]);
    }

    #[test]
    fn recent_notices_stay_bounded_and_do_not_duplicate() {
        let recent = RecentNotices::default();
        let now = Instant::now();
        let later = now + Duration::from_secs(10);
        for i in 0..(MAX_RECENT + 8) {
            recent.note(&account(1), &format!("g{i}"), later, now);
        }
        recent.note(&account(1), "g39", later, now);
        let held = recent.0.lock().unwrap();
        assert_eq!(held.len(), MAX_RECENT);
        assert_eq!(held.iter().filter(|r| r.gid == "g39").count(), 1);
    }
}
