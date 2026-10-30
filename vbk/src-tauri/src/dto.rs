//! Serde DTOs crossing the IPC boundary. They mirror
//! `ui/packages/ipc/src/contracts.ts` field-for-field (snake_case, tagged
//! unions on `kind`) and convert to/from the std-only `contracts` types.
//!
//! Nothing here carries cookies, tickets or customer message text.

use contracts::{
    AccountContext, AccountId, AlarmCommand, AlarmEntry, AlarmLevel, AlarmSnapshot, AppError,
    ConversationFact, ConversationStatus, Environment, MessageFact, MessageSource, MsgKind,
    ReminderSettings, SendDisposition, SenderRole, SnoozeMinutes,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountContextDto {
    pub account_id: String,
    pub environment: String,
    pub session_generation: u64,
}

impl From<&AccountContext> for AccountContextDto {
    fn from(c: &AccountContext) -> Self {
        Self {
            account_id: c.account_id.0.clone(),
            environment: c.environment.0.clone(),
            session_generation: c.session_generation,
        }
    }
}

impl From<AccountContextDto> for AccountContext {
    fn from(d: AccountContextDto) -> Self {
        AccountContext::new(
            AccountId::new(d.account_id),
            Environment::named(d.environment),
            d.session_generation,
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppErrorDto {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl From<AppError> for AppErrorDto {
    fn from(e: AppError) -> Self {
        Self {
            code: e.code,
            message: e.message,
            retryable: e.retryable,
            detail: e.detail,
        }
    }
}

// ------------------------------------------------------------------ alarm

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReminderSettingsDto {
    pub enabled: bool,
    pub t1_seconds: u32,
    pub timeout_sound: bool,
    pub continuous_l4: bool,
    pub position_bottom_right: bool,
    pub alert_during_dnd: bool,
    pub alert_during_fullscreen: bool,
    pub tray_flash: bool,
    pub taskbar_badge: bool,
}

impl From<&ReminderSettings> for ReminderSettingsDto {
    fn from(s: &ReminderSettings) -> Self {
        Self {
            enabled: s.enabled,
            t1_seconds: s.t1_seconds,
            timeout_sound: s.timeout_sound,
            continuous_l4: s.continuous_l4,
            position_bottom_right: s.position_bottom_right,
            alert_during_dnd: s.alert_during_dnd,
            alert_during_fullscreen: s.alert_during_fullscreen,
            tray_flash: s.tray_flash,
            taskbar_badge: s.taskbar_badge,
        }
    }
}

impl From<ReminderSettingsDto> for ReminderSettings {
    fn from(d: ReminderSettingsDto) -> Self {
        ReminderSettings {
            enabled: d.enabled,
            t1_seconds: d.t1_seconds,
            timeout_sound: d.timeout_sound,
            continuous_l4: d.continuous_l4,
            position_bottom_right: d.position_bottom_right,
            alert_during_dnd: d.alert_during_dnd,
            alert_during_fullscreen: d.alert_during_fullscreen,
            tray_flash: d.tray_flash,
            taskbar_badge: d.taskbar_badge,
        }
    }
}

fn level_str(l: AlarmLevel) -> &'static str {
    match l {
        AlarmLevel::L0 => "L0",
        AlarmLevel::L1 => "L1",
        AlarmLevel::L2 => "L2",
        AlarmLevel::L3 => "L3",
        AlarmLevel::L4 => "L4",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AlarmEntryDto {
    pub account: AccountContextDto,
    pub gid: String,
    pub round_id: String,
    pub version: u64,
    pub label: String,
    pub waiting_since_ms: Option<i64>,
    pub waited_seconds: u64,
    pub level: String,
    pub start_confirmed: bool,
    pub snoozed_until_ms: Option<i64>,
}

impl From<&AlarmEntry> for AlarmEntryDto {
    fn from(e: &AlarmEntry) -> Self {
        Self {
            account: (&e.account).into(),
            gid: e.gid.clone(),
            round_id: e.round_id.clone(),
            version: e.version,
            label: e.label.clone(),
            waiting_since_ms: e.waiting_since_ms,
            waited_seconds: e.waited_seconds,
            level: level_str(e.level).to_string(),
            start_confirmed: e.start_confirmed,
            snoozed_until_ms: e.snoozed_until_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AlarmSnapshotDto {
    pub generated_at_ms: i64,
    pub clock_trusted: bool,
    pub reconciling: bool,
    pub settings: ReminderSettingsDto,
    pub entries: Vec<AlarmEntryDto>,
}

impl From<&AlarmSnapshot> for AlarmSnapshotDto {
    fn from(s: &AlarmSnapshot) -> Self {
        Self {
            generated_at_ms: s.generated_at_ms,
            clock_trusted: s.clock_trusted,
            reconciling: s.reconciling,
            settings: (&s.settings).into(),
            entries: s.entries.iter().map(AlarmEntryDto::from).collect(),
        }
    }
}

/// Round reference echoed by every versioned alarm command.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoundRefDto {
    pub account: AccountContextDto,
    pub gid: String,
    pub round_id: String,
    pub version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SeenRoundDto {
    pub gid: String,
    pub round_id: String,
    pub version: u64,
}

pub fn snooze_from_minutes(minutes: u32) -> Result<SnoozeMinutes, AppError> {
    match minutes {
        5 => Ok(SnoozeMinutes::Five),
        10 => Ok(SnoozeMinutes::Ten),
        30 => Ok(SnoozeMinutes::Thirty),
        other => Err(AppError::new(
            "notify.invalid_snooze",
            format!("snooze of {other} minutes is not offered"),
        )),
    }
}

pub fn open_conversation_cmd(r: RoundRefDto) -> AlarmCommand {
    AlarmCommand::OpenConversation {
        account: r.account.into(),
        gid: r.gid,
        round_id: r.round_id,
        version: r.version,
    }
}

pub fn hide_round_cmd(r: RoundRefDto) -> AlarmCommand {
    AlarmCommand::HideRound {
        account: r.account.into(),
        gid: r.gid,
        round_id: r.round_id,
        version: r.version,
    }
}

pub fn hide_all_cmd(seen: Vec<SeenRoundDto>) -> AlarmCommand {
    AlarmCommand::HideAll {
        seen: seen
            .into_iter()
            .map(|s| (s.gid, s.round_id, s.version))
            .collect(),
    }
}

pub fn snooze_cmd(r: RoundRefDto, minutes: SnoozeMinutes) -> AlarmCommand {
    AlarmCommand::Snooze {
        account: r.account.into(),
        gid: r.gid,
        round_id: r.round_id,
        version: r.version,
        minutes,
    }
}

// --------------------------------------------------------------- im facts

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SendDispositionDto {
    Confirmed {
        server_message_id: String,
        server_time_ms: i64,
    },
    Rejected {
        code: String,
        reason: String,
    },
    Unknown,
}

impl From<SendDispositionDto> for SendDisposition {
    fn from(d: SendDispositionDto) -> Self {
        match d {
            SendDispositionDto::Confirmed {
                server_message_id,
                server_time_ms,
            } => SendDisposition::Confirmed {
                server_message_id,
                server_time_ms,
            },
            SendDispositionDto::Rejected { code, reason } => {
                SendDisposition::Rejected { code, reason }
            }
            SendDispositionDto::Unknown => SendDisposition::Unknown,
        }
    }
}

fn parse_role(s: &str) -> SenderRole {
    match s {
        "customer" => SenderRole::Customer,
        "merchant_self" => SenderRole::MerchantSelf,
        "merchant_other" => SenderRole::MerchantOther,
        "ctrip_agent" => SenderRole::CtripAgent,
        "robot" => SenderRole::Robot,
        "system" => SenderRole::System,
        _ => SenderRole::Unknown,
    }
}

fn parse_kind(s: &str) -> MsgKind {
    match s {
        "business" => MsgKind::Business,
        "recall" => MsgKind::Recall,
        "read_receipt" => MsgKind::ReadReceipt,
        "typing" => MsgKind::Typing,
        _ => MsgKind::Control,
    }
}

fn parse_source(s: &str) -> Result<MessageSource, AppError> {
    Ok(match s {
        "realtime" => MessageSource::Realtime,
        "init" => MessageSource::Init,
        "history" => MessageSource::History,
        "compensation" => MessageSource::Compensation,
        other => {
            return Err(AppError::new(
                "im.invalid_fact",
                format!("unknown message source {other:?}"),
            ))
        }
    })
}

fn parse_status(s: &str) -> ConversationStatus {
    match s {
        "active" => ConversationStatus::Active,
        "finished" => ConversationStatus::Finished,
        "transferred_out" => ConversationStatus::TransferredOut,
        _ => ConversationStatus::Unknown,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageFactDto {
    pub gid: String,
    pub message_id: Option<String>,
    pub local_id: Option<String>,
    pub create_time_ms: i64,
    pub sender_role: String,
    pub sender_id: String,
    pub kind: String,
    pub source: String,
    pub disposition: Option<SendDispositionDto>,
}

impl TryFrom<MessageFactDto> for MessageFact {
    type Error = AppError;

    fn try_from(d: MessageFactDto) -> Result<Self, AppError> {
        if d.gid.is_empty() {
            return Err(AppError::new("im.invalid_fact", "gid is empty"));
        }
        Ok(MessageFact {
            gid: d.gid,
            message_id: d.message_id,
            local_id: d.local_id,
            create_time_ms: d.create_time_ms,
            sender_role: parse_role(&d.sender_role),
            sender_id: d.sender_id,
            kind: parse_kind(&d.kind),
            source: parse_source(&d.source)?,
            disposition: d.disposition.map(Into::into),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationFactDto {
    pub gid: String,
    pub status: String,
    pub agent_in_group: bool,
    pub is_owner: bool,
    pub service_type: String,
    pub last_message_time_ms: Option<i64>,
    pub last_update_time_ms: Option<i64>,
    pub unread_count: u32,
    pub is_full_snapshot: bool,
}

impl TryFrom<ConversationFactDto> for ConversationFact {
    type Error = AppError;

    fn try_from(d: ConversationFactDto) -> Result<Self, AppError> {
        if d.gid.is_empty() {
            return Err(AppError::new("im.invalid_fact", "gid is empty"));
        }
        Ok(ConversationFact {
            gid: d.gid,
            status: parse_status(&d.status),
            agent_in_group: d.agent_in_group,
            is_owner: d.is_owner,
            service_type: d.service_type,
            last_message_time_ms: d.last_message_time_ms,
            last_update_time_ms: d.last_update_time_ms,
            unread_count: d.unread_count,
            is_full_snapshot: d.is_full_snapshot,
        })
    }
}

/// Mirrors `AdapterFact` in contracts.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AdapterFactDto {
    Message { fact: MessageFactDto },
    Conversation { fact: ConversationFactDto },
    ConversationListSync { full: bool, last_update_time_ms: Option<i64> },
    CompensationSync { last_message_timestamp_ms: Option<i64> },
    Transport { state: String },
    AuthInvalid,
}

/// Mirrors `AdapterFactEnvelope` in contracts.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AdapterFactEnvelopeDto {
    pub account: AccountContextDto,
    pub stream: String,
    pub epoch: u64,
    pub seq: u64,
    pub fact: AdapterFactDto,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fact_envelope_json_shape_matches_ts() {
        let json = r#"{"account":{"account_id":"a","environment":"production","session_generation":2},
            "stream":"im.message","epoch":1,"seq":7,
            "fact":{"kind":"message","fact":{"gid":"g","message_id":"m","local_id":null,"create_time_ms":1761800000000,
            "sender_role":"customer","sender_id":"u","kind":"business","source":"realtime","disposition":null}}}"#;
        let env: AdapterFactEnvelopeDto = serde_json::from_str(json).expect("parse");
        assert_eq!(env.seq, 7);
        match env.fact {
            AdapterFactDto::Message { fact } => {
                let f: MessageFact = fact.try_into().expect("convert");
                assert!(f.is_customer_business());
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn disposition_tagged_union() {
        let d: SendDispositionDto =
            serde_json::from_str(r#"{"kind":"confirmed","server_message_id":"t","server_time_ms":1}"#)
                .expect("parse");
        assert!(matches!(d, SendDispositionDto::Confirmed { .. }));
        let u: SendDispositionDto = serde_json::from_str(r#"{"kind":"unknown"}"#).expect("parse");
        assert_eq!(u, SendDispositionDto::Unknown);
    }
}
