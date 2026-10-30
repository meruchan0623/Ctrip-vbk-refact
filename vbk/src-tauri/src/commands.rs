//! App-level Tauri commands. Every command (a) is listed in
//! `commands.txt` so the ACL permission exists, (b) re-checks the source
//! window label against `ViewRegistry` (defense in depth), and (c) returns
//! `Result<T, AppErrorDto>`.
//!
//! No command sends a customer message, finishes a conversation or opens an
//! arbitrary URL. The alarm window can only act on `(round_id, version)`.

use contracts::{AlarmCommand, AppError};
use core_net::url::{validate_official_im_url, UrlPolicy};
use core_notify::{CommandAck, CommandSource};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State, Window};

use crate::dto::{
    hide_all_cmd, hide_round_cmd, open_conversation_cmd, snooze_cmd, snooze_from_minutes,
    AdapterFactEnvelopeDto, AlarmSnapshotDto, AppErrorDto, ReminderSettingsDto, RoundRefDto,
    SeenRoundDto,
};
use crate::state::HostState;
use crate::views;
use crate::windows;

type CmdResult<T> = Result<T, AppErrorDto>;

fn guard(state: &HostState, window: &Window, command: &str) -> CmdResult<()> {
    state
        .authorize(window.label(), command)
        .map_err(AppErrorDto::from)
}

fn source_for(window: &Window) -> CommandSource {
    match window.label() {
        views::ALARM => CommandSource::Alarm,
        views::SETTING => CommandSource::Setting,
        _ => CommandSource::Tray,
    }
}

fn err(e: AppError) -> AppErrorDto {
    e.into()
}

// ------------------------------------------------------------------ notify

#[tauri::command]
pub fn notify_snapshot(window: Window, state: State<'_, HostState>) -> CmdResult<AlarmSnapshotDto> {
    guard(&state, &window, "notify_snapshot")?;
    Ok(AlarmSnapshotDto::from(&state.alarm_snapshot()))
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AckDto {
    Navigate {
        account: crate::dto::AccountContextDto,
        gid: String,
    },
    Hidden {
        count: usize,
    },
    Snoozed {
        until_ms: i64,
    },
    Settings {
        settings: ReminderSettingsDto,
    },
    Snapshot {
        snapshot: AlarmSnapshotDto,
    },
}

fn ack_dto(ack: CommandAck) -> AckDto {
    match ack {
        CommandAck::Navigate { account, gid } => AckDto::Navigate {
            account: (&account).into(),
            gid,
        },
        CommandAck::Hidden { count } => AckDto::Hidden { count },
        CommandAck::Snoozed { until_ms } => AckDto::Snoozed { until_ms },
        CommandAck::Settings(s) => AckDto::Settings {
            settings: (&s).into(),
        },
        CommandAck::Snapshot(s) => AckDto::Snapshot {
            snapshot: (&s).into(),
        },
    }
}

#[tauri::command]
pub fn notify_open_conversation(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    round: RoundRefDto,
) -> CmdResult<AckDto> {
    guard(&state, &window, "notify_open_conversation")?;
    let ack = state
        .alarm_command(open_conversation_cmd(round), source_for(&window))
        .map_err(err)?;
    if let CommandAck::Navigate { account, gid } = &ack {
        // Activate main and let it locate the conversation through its own
        // identity; the alarm window never navigates by URL.
        windows::show_main(&app);
        let payload = serde_json::json!({
            "account": crate::dto::AccountContextDto::from(account),
            "gid": gid,
        });
        let _ = app.emit_to(views::MAIN, "im://locate-conversation", payload);
    }
    Ok(ack_dto(ack))
}

#[tauri::command]
pub fn notify_hide_round(
    window: Window,
    state: State<'_, HostState>,
    round: RoundRefDto,
) -> CmdResult<AckDto> {
    guard(&state, &window, "notify_hide_round")?;
    state
        .alarm_command(hide_round_cmd(round), source_for(&window))
        .map(ack_dto)
        .map_err(err)
}

#[tauri::command]
pub fn notify_hide_all(
    window: Window,
    state: State<'_, HostState>,
    seen: Vec<SeenRoundDto>,
) -> CmdResult<AckDto> {
    guard(&state, &window, "notify_hide_all")?;
    state
        .alarm_command(hide_all_cmd(seen), source_for(&window))
        .map(ack_dto)
        .map_err(err)
}

#[tauri::command]
pub fn notify_snooze(
    window: Window,
    state: State<'_, HostState>,
    round: RoundRefDto,
    minutes: u32,
) -> CmdResult<AckDto> {
    guard(&state, &window, "notify_snooze")?;
    let m = snooze_from_minutes(minutes).map_err(err)?;
    state
        .alarm_command(snooze_cmd(round, m), source_for(&window))
        .map(ack_dto)
        .map_err(err)
}

#[tauri::command]
pub fn notify_set_enabled(
    window: Window,
    state: State<'_, HostState>,
    enabled: bool,
) -> CmdResult<AckDto> {
    guard(&state, &window, "notify_set_enabled")?;
    state
        .alarm_command(AlarmCommand::SetEnabled(enabled), source_for(&window))
        .map(ack_dto)
        .map_err(err)
}

// JS sends snake_case keys (`{t1_seconds}` / `{attempt_id}`), not camelCase.
#[tauri::command(rename_all = "snake_case")]
pub fn notify_set_threshold(
    window: Window,
    state: State<'_, HostState>,
    t1_seconds: u32,
) -> CmdResult<AckDto> {
    guard(&state, &window, "notify_set_threshold")?;
    state
        .alarm_command(
            AlarmCommand::SetThreshold { t1_seconds },
            source_for(&window),
        )
        .map(ack_dto)
        .map_err(err)
}

#[tauri::command]
pub fn notify_set_sound_enabled(
    window: Window,
    state: State<'_, HostState>,
    enabled: bool,
) -> CmdResult<AckDto> {
    guard(&state, &window, "notify_set_sound_enabled")?;
    state
        .alarm_command(AlarmCommand::SetSoundEnabled(enabled), source_for(&window))
        .map(ack_dto)
        .map_err(err)
}

// Account commands moved to `login.rs` (2026-10-30).

// ---------------------------------------------------------------------- im

#[derive(Debug, Serialize)]
pub struct IngestReportDto {
    pub applied: bool,
    pub dropped: Option<String>,
    pub needs_resync: Option<String>,
    pub auth_invalid: bool,
}

#[tauri::command]
pub fn im_push_fact(
    window: Window,
    state: State<'_, HostState>,
    envelope: AdapterFactEnvelopeDto,
) -> CmdResult<IngestReportDto> {
    guard(&state, &window, "im_push_fact")?;
    let r = state.push_fact(envelope).map_err(err)?;
    Ok(IngestReportDto {
        applied: r.applied,
        dropped: r.dropped.map(|d| format!("{d:?}")),
        needs_resync: r.needs_resync.map(|s| s.name().to_string()),
        auth_invalid: r.auth_invalid,
    })
}

#[derive(Debug, Serialize)]
pub struct ConversationSummaryDto {
    pub gid: String,
    pub unread: u32,
    pub eligible_for_reminder: bool,
    pub round_state: String,
    pub reconciling: bool,
}

#[tauri::command]
pub fn im_conversation_snapshot(
    window: Window,
    state: State<'_, HostState>,
    account: crate::dto::AccountContextDto,
) -> CmdResult<Vec<ConversationSummaryDto>> {
    guard(&state, &window, "im_conversation_snapshot")?;
    let cores = state.lock();
    let ctx: contracts::AccountContext = account.into();
    cores.accounts.validate(&ctx).map_err(err)?;
    let Some(core) = cores.im.get(&ctx) else {
        return Ok(Vec::new());
    };
    Ok(core
        .active_rounds()
        .map(|(gid, rs)| ConversationSummaryDto {
            gid: gid.to_string(),
            unread: core.unread(gid),
            eligible_for_reminder: core.eligible_for_reminder(gid),
            round_state: format!("{rs:?}"),
            reconciling: core.is_reconciling(),
        })
        .collect())
}

#[tauri::command]
pub fn im_locate_conversation(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    account: crate::dto::AccountContextDto,
    gid: String,
) -> CmdResult<bool> {
    guard(&state, &window, "im_locate_conversation")?;
    let ctx: contracts::AccountContext = account.clone().into();
    let cleared = {
        let mut cores = state.lock();
        cores.accounts.validate(&ctx).map_err(err)?;
        // Opening a conversation clears unread but never a waiting round.
        cores
            .im
            .get_mut(&ctx)
            .map(|c| c.on_open_conversation(&gid))
            .unwrap_or(false)
    };
    // Main selects the conversation through its own identity.
    let payload = serde_json::json!({ "account": account, "gid": gid });
    let _ = app.emit_to(views::MAIN, crate::events::IM_LOCATE_CONVERSATION, payload);
    Ok(cleared)
}

// ------------------------------------------------------------------- order

#[derive(Debug, Serialize)]
pub struct ImLaunchUrlDto {
    pub raw: String,
    pub host: String,
    pub path: String,
    pub init_chat: Option<String>,
    pub service_type: Option<String>,
    pub vendor_role: Option<String>,
    pub current_tab: Option<String>,
    pub order_no: Option<String>,
    pub target_gid: Option<String>,
    pub unknown: Vec<(String, String)>,
}

#[tauri::command]
pub fn order_validate_im_url(
    window: Window,
    state: State<'_, HostState>,
    url: String,
) -> CmdResult<ImLaunchUrlDto> {
    guard(&state, &window, "order_validate_im_url")?;
    let u = validate_official_im_url(&url, &UrlPolicy::official_im()).map_err(err)?;
    Ok(ImLaunchUrlDto {
        raw: u.raw,
        host: u.host,
        path: u.path,
        init_chat: u.init_chat,
        service_type: u.service_type,
        vendor_role: u.vendor_role,
        current_tab: u.current_tab,
        order_no: u.order_no,
        target_gid: u.target_gid,
        unknown: u.unknown,
    })
}

// `prefs_snapshot` moved to `prefs.rs` (2026-10-30).
