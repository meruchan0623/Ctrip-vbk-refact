//! Serde DTOs crossing the IPC boundary. They mirror
//! `ui/packages/ipc/src/contracts.ts` field-for-field (snake_case, tagged
//! unions on `kind`) and convert to/from the std-only `contracts` types.
//!
//! Nothing here carries cookies, tickets or customer message text.

use contracts::{
    AccountContext, AccountId, AlarmCommand, AlarmEntry, AlarmLevel, AlarmSnapshot, AppError,
    ConversationFact, ConversationStatus, Environment, MessageFact, MessageSource, MsgKind,
    ReminderSettings, SendDisposition, SenderRole,
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

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
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
    /// Latest message preview from the in-memory display cache, filled by
    /// `adapter::alarm_snapshot` for local windows. Customer text: never logged.
    #[serde(default)]
    pub preview: Option<String>,
}

impl std::fmt::Debug for AlarmEntryDto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AlarmEntryDto")
            .field("gid", &self.gid)
            .field("round_id", &self.round_id)
            .field("version", &self.version)
            .field("level", &self.level)
            .field("has_preview", &self.preview.is_some())
            .finish()
    }
}

/// Single-line, bounded form of a list preview; `None` when there is no text.
pub fn alarm_preview(raw: &str) -> Option<String> {
    const MAX_CHARS: usize = 200;
    let mut text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some((end, _)) = text.char_indices().nth(MAX_CHARS) {
        text.truncate(end);
        text.push('…');
    }
    (!text.is_empty()).then_some(text)
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
            preview: None,
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
    pub account: AccountContextDto,
    pub gid: String,
    pub round_id: String,
    pub version: u64,
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
            .map(|s| contracts::WaitingRoundRef {
                account: s.account.into(),
                gid: s.gid,
                round_id: s.round_id,
                version: s.version,
            })
            .collect(),
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
    Message {
        fact: MessageFactDto,
    },
    Conversation {
        fact: ConversationFactDto,
    },
    ConversationListSync {
        full: bool,
        last_update_time_ms: Option<i64>,
    },
    CompensationSync {
        last_message_timestamp_ms: Option<i64>,
    },
    Transport {
        state: String,
    },
    AuthInvalid,
    /// Host-only terminal control; never enters the IM core.
    BridgeFault {
        fault: BridgeFaultDto,
    },
    /// Page feature fact (typing / recalled / queue notice). Never enters the
    /// IM core: `adapter_push_fact` validates it and forwards it to the main
    /// window as `feature://fact` (`FeatureFactEventDto`).
    Feature {
        fact: FeatureFactDto,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BridgeFaultReason {
    QueueOverflow,
    DeliveryFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BridgeFaultDto {
    pub boot_epoch: u64,
    pub reason: BridgeFaultReason,
}

/// Mirrors `FeatureFact` in contracts.ts (adapter side, no account).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FeatureFactDto {
    Typing {
        gid: String,
        from: String,
        until_ms: i64,
    },
    Recalled {
        gid: String,
        message_id: String,
    },
    QueueNotice {
        gid: String,
    },
}

impl From<FeatureFactDto> for core_im::feature_rules::FeatureFact {
    fn from(d: FeatureFactDto) -> Self {
        use core_im::feature_rules::FeatureFact as F;
        match d {
            FeatureFactDto::Typing {
                gid,
                from,
                until_ms,
            } => F::Typing {
                gid,
                from,
                until_ms,
            },
            FeatureFactDto::Recalled { gid, message_id } => F::Recalled { gid, message_id },
            FeatureFactDto::QueueNotice { gid } => F::QueueNotice { gid },
        }
    }
}

impl From<core_im::feature_rules::FeatureFact> for FeatureFactDto {
    fn from(f: core_im::feature_rules::FeatureFact) -> Self {
        use core_im::feature_rules::FeatureFact as F;
        match f {
            F::Typing {
                gid,
                from,
                until_ms,
            } => FeatureFactDto::Typing {
                gid,
                from,
                until_ms,
            },
            F::Recalled { gid, message_id } => FeatureFactDto::Recalled { gid, message_id },
            F::QueueNotice { gid } => FeatureFactDto::QueueNotice { gid },
        }
    }
}

/// `feature://fact` payload: the validated fact with the host-bound account
/// flattened in (mirrors `FeatureFact` in `ui/apps/main/features/context.ts`,
/// `{kind, account, gid, ...}`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FeatureFactEventDto {
    #[serde(flatten)]
    pub fact: FeatureFactDto,
    pub account: AccountContextDto,
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
    #[test]
    fn alarm_preview_is_single_line_and_bounded() {
        assert_eq!(super::alarm_preview("  a\n b\t c "), Some("a b c".into()));
        assert_eq!(super::alarm_preview(" \n "), None);
        let long = super::alarm_preview(&"客".repeat(500)).expect("text");
        assert_eq!(long.chars().count(), 201);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn alarm_entry_debug_never_prints_the_preview() {
        let entry = super::AlarmEntryDto {
            account: super::AccountContextDto {
                account_id: "a".into(),
                environment: "test".into(),
                session_generation: 1,
            },
            gid: "g".into(),
            round_id: "r".into(),
            version: 1,
            label: "l".into(),
            waiting_since_ms: None,
            waited_seconds: 1,
            level: "L3".into(),
            start_confirmed: true,
            snoozed_until_ms: None,
            preview: Some("synthetic-secret".into()),
        };
        let printed = format!("{entry:?}");
        assert!(!printed.contains("synthetic-secret"));
        assert!(printed.contains("has_preview: true"));
    }

    use super::*;

    #[test]
    fn hide_all_requires_identity_and_preserves_it() {
        let legacy = r#"{"gid":"g","round_id":"r","version":1}"#;
        assert!(serde_json::from_str::<SeenRoundDto>(legacy).is_err());
        let current = r#"{"account":{"account_id":"a","environment":"production","session_generation":2},"gid":"g","round_id":"r","version":1}"#;
        let dto: SeenRoundDto =
            serde_json::from_str(current).expect("current identity is required");
        let account: AccountContext = dto.account.clone().into();
        assert_eq!(
            hide_all_cmd(vec![dto]),
            AlarmCommand::HideAll {
                seen: vec![contracts::WaitingRoundRef {
                    account,
                    gid: "g".into(),
                    round_id: "r".into(),
                    version: 1
                }]
            }
        );
    }

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

    /// Same samples as `ui/packages/ipc/src/contracts.test.ts`
    /// ("feature fact JSON shapes mirror dto.rs"): keep both in step.
    #[test]
    fn feature_fact_json_shape_matches_ts() {
        let json = r#"{"account":{"account_id":"a","environment":"production","session_generation":2},
            "stream":"im.feature","epoch":1,"seq":3,
            "fact":{"kind":"feature","fact":{"kind":"typing","gid":"1234567890123456789","from":"cust-9","until_ms":1761800005000}}}"#;
        let env: AdapterFactEnvelopeDto = serde_json::from_str(json).expect("parse");
        let AdapterFactDto::Feature { fact } = env.fact else {
            panic!("wrong variant");
        };
        assert_eq!(
            fact,
            FeatureFactDto::Typing {
                gid: "1234567890123456789".into(),
                from: "cust-9".into(),
                until_ms: 1_761_800_005_000
            }
        );
        let recalled: FeatureFactDto = serde_json::from_str(
            r#"{"kind":"recalled","gid":"1234567890123456789","message_id":"9876543210987654321"}"#,
        )
        .expect("parse");
        assert!(matches!(recalled, FeatureFactDto::Recalled { .. }));
        let queue: FeatureFactDto =
            serde_json::from_str(r#"{"kind":"queue_notice","gid":"1234567890123456789"}"#)
                .expect("parse");
        assert_eq!(
            queue,
            FeatureFactDto::QueueNotice {
                gid: "1234567890123456789".into()
            }
        );
        // round trip through the core type keeps every field
        let core: core_im::feature_rules::FeatureFact = fact.clone().into();
        assert_eq!(FeatureFactDto::from(core), fact);
        // host → main window event: flat `{kind, ..., account}`
        let event = FeatureFactEventDto {
            fact,
            account: AccountContextDto {
                account_id: "a".into(),
                environment: "production".into(),
                session_generation: 2,
            },
        };
        let v = serde_json::to_value(&event).expect("serialize");
        assert_eq!(
            v,
            serde_json::json!({
                "kind": "typing", "gid": "1234567890123456789", "from": "cust-9", "until_ms": 1761800005000_i64,
                "account": {"account_id": "a", "environment": "production", "session_generation": 2}
            })
        );
    }

    #[test]
    fn disposition_tagged_union() {
        let d: SendDispositionDto = serde_json::from_str(
            r#"{"kind":"confirmed","server_message_id":"t","server_time_ms":1}"#,
        )
        .expect("parse");
        assert!(matches!(d, SendDispositionDto::Confirmed { .. }));
        let u: SendDispositionDto = serde_json::from_str(r#"{"kind":"unknown"}"#).expect("parse");
        assert_eq!(u, SendDispositionDto::Unknown);
    }
}
