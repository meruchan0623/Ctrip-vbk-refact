//! App-level Tauri commands. Every command (a) is listed in
//! `commands.txt` so the ACL permission exists, (b) re-checks the source
//! window label against `ViewRegistry` (defense in depth), and (c) returns
//! `Result<T, AppErrorDto>`.
//!
//! No command sends a customer message, finishes a conversation or opens an
//! arbitrary URL. The alarm window can only act on `(round_id, version)`.

use contracts::{AlarmCommand, AppError, ContractGate, CONTRACT_VERSION};
use core_net::url::{validate_official_im_url, UrlPolicy};
use core_notify::{CommandAck, CommandSource};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State, Window};

use crate::dto::{
    hide_all_cmd, hide_round_cmd, open_conversation_cmd, AdapterFactEnvelopeDto, AlarmSnapshotDto,
    AppErrorDto, ReminderSettingsDto, RoundRefDto, SeenRoundDto,
};
use crate::state::HostState;
use crate::views;
use crate::windows;

type CmdResult<T> = Result<T, AppErrorDto>;

/// Per-window contract handshake (I-03). Process-wide because it only holds
/// window labels and version numbers; `HostState::authorize` consults it
/// through `contract_check` for every command of every module.
fn contract_gate() -> &'static Mutex<ContractGate> {
    static GATE: OnceLock<Mutex<ContractGate>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(ContractGate::default()))
}

/// Contract verdict for a local window. Called from `HostState::authorize`,
/// so EVERY module's command guard (login, adapter, shell, prefs, assistant,
/// features) rejects a window that announced another contract version or
/// none at all; this module's `guard` is the same path.
pub(crate) fn contract_check(label: &str) -> Result<(), AppError> {
    let verdict = contract_gate()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .check(label);
    if let Err(e) = &verdict {
        log::warn!("contract: command rejected for {label}: {}", e.code);
    }
    verdict
}

/// Drops the handshake verdict of `label` (I-03). Called by the host when a
/// window is destroyed (its label may be reused by a recreated window) and
/// when a local window starts loading a new document (reload/navigation):
/// the new page must announce its version again, and an earlier rejection
/// does not outlive the page that earned it.
pub(crate) fn contract_forget(label: &str) {
    contract_gate()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .forget(label);
}

fn guard(state: &HostState, window: &Window, command: &str) -> CmdResult<()> {
    state
        .authorize(window.label(), command)
        .map_err(AppErrorDto::from)
}

/// First call of every local window: announces the contract version it was
/// built against. A mismatch rejects the window's commands and logs a
/// diagnostic (label and two integers only).
#[tauri::command]
pub fn contract_hello(window: Window, state: State<'_, HostState>, version: u32) -> CmdResult<()> {
    state
        .authorize(window.label(), "contract_hello")
        .map_err(AppErrorDto::from)?;
    let verdict = contract_gate()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .hello(window.label(), version);
    verdict.map_err(|e| {
        log::warn!(
            "contract: window {} announced version {version}, host speaks {CONTRACT_VERSION}",
            window.label()
        );
        AppErrorDto::from(e)
    })
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
pub fn notify_snapshot(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
) -> CmdResult<AlarmSnapshotDto> {
    guard(&state, &window, "notify_snapshot")?;
    Ok(crate::adapter::alarm_snapshot(&app))
}

/// The alarm window hugs its rows, growing up from its corner. Only ever sizes itself.
#[tauri::command]
pub fn notify_alarm_resize(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    height: f64,
) -> CmdResult<()> {
    guard(&state, &window, "notify_alarm_resize")?;
    let corner = state.settings().alarm_corner;
    windows::resize_alarm(&app, corner, height)
        .map_err(|e| err(AppError::new("notify.alarm_resize", e.to_string())))
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

/// The conversation main is showing, so its new messages need no notification
/// while main has focus. Holds no account authority: it only suppresses L2.
#[tauri::command]
pub fn notify_set_viewing(
    window: Window,
    state: State<'_, HostState>,
    gid: Option<String>,
) -> CmdResult<()> {
    guard(&state, &window, "notify_set_viewing")?;
    if let Some(gid) = &gid {
        core_im::feature_rules::validate_gid(gid).map_err(err)?;
    }
    state.update_system_state(|system| system.viewing_gid = gid);
    Ok(())
}

#[tauri::command]
pub fn notice_open(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    account: crate::dto::AccountContextDto,
    gid: String,
) -> CmdResult<()> {
    guard(&state, &window, "notice_open")?;
    core_im::feature_rules::validate_gid(&gid).map_err(err)?;
    crate::notifications::open(&app, account.into(), gid);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn notice_open_category(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    account: crate::dto::AccountContextDto,
    category_id: String,
) -> CmdResult<()> {
    guard(&state, &window, "notice_open_category")?;
    if !crate::prefs::is_notice_category_id(&category_id) {
        return Err(err(AppError::new(
            "notice.invalid_category",
            "invalid notice category id",
        )));
    }
    crate::notifications::open_category(&app, account.into(), category_id);
    Ok(())
}

/// The notice window fits its stack; 0 hides it. Only ever sizes itself.
#[tauri::command]
pub fn notice_resize(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    height: f64,
) -> CmdResult<()> {
    guard(&state, &window, "notice_resize")?;
    windows::resize_notice(&app, height)
        .map_err(|e| err(AppError::new("notice.resize", e.to_string())))
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
