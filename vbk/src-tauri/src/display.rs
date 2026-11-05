//! In-memory display cache (plan D4): conversation titles, previews and
//! message bodies pushed by the per-account official-page adapter.
//!
//! * Isolated per persistent identity `(environment, account_id)` and bound
//!   to one `session_generation`: a push for an older generation is
//!   rejected, a push for a newer one drops everything cached before.
//! * Never persisted and never logged. `Debug` prints counts only.
//! * Bounded: conversations, message threads and messages per thread are
//!   capped; the oldest thread is evicted first.
//!
//! The local pinned table (`im_set_top`) lives here too; it holds only gids
//! and is the one piece written to disk (`app_data_dir/pinned.json`).

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::path::{Path, PathBuf};

use contracts::{codes, AccountContext, AccountId, AppError, Environment};
use serde::{Deserialize, Serialize};

use crate::dto::{AccountContextDto, ConversationFactDto, SendDispositionDto};

/// Upper bound of cached conversations per account.
pub const MAX_CONVERSATIONS: usize = 2_000;
/// Upper bound of cached message threads per account.
pub const MAX_THREADS: usize = 200;
/// Upper bound of cached messages per thread (newest kept).
pub const MAX_MESSAGES_PER_THREAD: usize = 500;

const INVALID: &str = "adapter.invalid_display";

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::new(INVALID, msg)
}

// ------------------------------------------------------------------ DTOs

/// Mirrors `UiOrderSummary` (client.ts).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiOrderSummaryDto {
    pub order_id: String,
    pub product: String,
    pub use_date: String,
    pub quantity: String,
    pub status: String,
    /// Masked contact label, never a phone number.
    pub contact: String,
    #[serde(default)]
    pub source_channel: String,
    #[serde(default)]
    pub product_id: String,
    #[serde(default)]
    pub customer_language: String,
    #[serde(default)]
    pub product_price: String,
    #[serde(default)]
    pub total_amount: String,
    #[serde(default)]
    pub remark_name: String,
    #[serde(default)]
    pub source_title: String,
    #[serde(default)]
    pub source_description: String,
}

/// Mirrors `DisplayConversation` (adapterProtocol.ts): `UiConversation`
/// minus `account`, `waiting_since_ms`, `waiting_confirmed`, `is_top`,
/// `draft`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayConversationDto {
    /// Raw official business type, deliberately outside the persisted fact schema.
    #[serde(default)]
    pub conversation_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant_context_revision: Option<String>,
    #[serde(default)]
    pub read_target_message_id: Option<String>,
    #[serde(default)]
    pub customer_avatar: Option<String>,
    #[serde(flatten)]
    pub fact: ConversationFactDto,
    pub title: String,
    #[serde(default)]
    pub vendor_name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub lang: String,
    #[serde(default)]
    pub biz: String,
    #[serde(default)]
    pub preview: String,
    #[serde(default)]
    pub mark: u8,
    #[serde(default)]
    pub customer_tags: Vec<String>,
    #[serde(default)]
    pub order: Option<UiOrderSummaryDto>,
}

/// Mirrors `UiConversation` (client.ts). Built by the host from the cached
/// display row plus host-owned fields.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct UiConversationDto {
    #[serde(flatten)]
    pub display: DisplayConversationDto,
    pub account: AccountContextDto,
    pub draft: String,
    pub is_top: bool,
    pub waiting_since_ms: Option<i64>,
    pub waiting_confirmed: bool,
}

/// Mirrors `UiMessage` (client.ts).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiMessageDto {
    pub gid: String,
    pub message_id: Option<String>,
    pub local_id: Option<String>,
    pub create_time_ms: i64,
    pub sender_role: String,
    #[serde(default)]
    pub sender_id: String,
    #[serde(default)]
    pub sender_name: Option<String>,
    #[serde(default)]
    pub sender_avatar: Option<String>,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform_type: Option<i32>,
    pub text: String,
    #[serde(default)]
    pub media_url: Option<String>,
    #[serde(default)]
    pub media_thumbnail: Option<String>,
    #[serde(default)]
    pub media_filename: Option<String>,
    /// `kind: "voice"` only: whole seconds from the message body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_duration_s: Option<u32>,
    #[serde(default)]
    pub recalled_message_id: Option<String>,
    #[serde(default)]
    pub read_status: Option<String>,
    #[serde(default)]
    pub translation: Option<String>,
    #[serde(default)]
    pub original: Option<String>,
    #[serde(default)]
    pub quote: Option<String>,
    #[serde(default)]
    pub order_id: Option<String>,
    #[serde(default)]
    pub disposition: Option<SendDispositionDto>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct UiMessagePageDto {
    pub items: Vec<UiMessageDto>,
    pub has_more: bool,
    pub before_ms: Option<i64>,
}

/// `im://message-new` payload: `UiMessage` plus the owning account.
#[derive(Clone, Serialize)]
pub struct UiMessageEventDto<'a> {
    #[serde(flatten)]
    pub message: &'a UiMessageDto,
    pub account: AccountContextDto,
}

/// Mirrors `UiNoticeCategory` (client.ts).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiNoticeCategoryDto {
    pub id: String,
    pub name: String,
    pub unread: u32,
}

/// Mirrors `AgentStatus` (client.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatusDto {
    Online,
    Hangup,
    Leaving,
    Getoff,
}

/// Mirrors `UiAgentStatus` (client.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiAgentStatusDto {
    pub status: AgentStatusDto,
    pub confirmed: bool,
}

impl UiAgentStatusDto {
    /// Hanging up pauses new assignments, but existing owned customers still
    /// need attention. Away/off-duty and unconfirmed states stay silent.
    pub fn allows_notifications(self) -> bool {
        self.confirmed && matches!(self.status, AgentStatusDto::Online | AgentStatusDto::Hangup)
    }
}

/// Mirrors `TransportState` (contracts.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportDto {
    Connecting,
    Connected,
    Disconnected,
    Reconnecting,
}

/// Mirrors `UiNetStatus` (client.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct UiNetStatusDto {
    pub online: bool,
    pub transport: TransportDto,
}

impl From<TransportDto> for UiNetStatusDto {
    fn from(t: TransportDto) -> Self {
        Self {
            online: t == TransportDto::Connected,
            transport: t,
        }
    }
}

impl UiNetStatusDto {
    pub fn offline() -> Self {
        TransportDto::Disconnected.into()
    }
}

// Diagnostic schemas are deliberately closed: deserialization cannot retain
// a free error, identifier, URL, or message field returned by the remote page.
#[derive(Clone, Default, Serialize)]
pub struct HostReceiveDiagnosticsDto {
    pub display_entered: u64,
    pub display_decode_rejected: u64,
    pub display_apply_rejected: u64,
    pub message_items: u64,
    pub changed_messages: u64,
    pub main_emit_attempts: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticGlobalState {
    Emitter,
    Missing,
    Invalid,
    Unreadable,
    Disposed,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticListenerHealth {
    Verified,
    Missing,
    Unsupported,
    Detached,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticBinding {
    pub global_state: DiagnosticGlobalState,
    pub listener_health: DiagnosticListenerHealth,
    pub attached: bool,
    pub can_rebind: bool,
    pub binding_generation: u64,
    pub attach_count: u64,
    pub repair_count: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticSdkCounters {
    pub callbacks: u64,
    pub stale_callbacks: u64,
    pub messages: u64,
    pub acks: u64,
    pub ignored: u64,
    pub listener_errors: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticSdk {
    pub binding: DiagnosticBinding,
    pub counters: DiagnosticSdkCounters,
    pub last_stanza_ms: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticSession {
    pub received: u64,
    pub ui_mapped: u64,
    pub ui_dropped: u64,
    pub display_batches: u64,
    pub display_items: u64,
    pub display_resolved: u64,
    pub display_rejected: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticOutcomes {
    pub success: u64,
    pub business_failure: u64,
    pub auth_invalid: u64,
    pub http_error: u64,
    pub malformed: u64,
    pub network_error: u64,
    pub timeout: u64,
    pub unknown: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticCompensationMode {
    Normal,
    Frequent,
    Stopped,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticCompensation {
    pub running: bool,
    pub mode: DiagnosticCompensationMode,
    pub cursor_ms: u64,
    pub last_outcome_ms: Option<u64>,
    pub outcomes: DiagnosticOutcomes,
    pub rows: u64,
    pub mapped: u64,
    pub dropped: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticBridgeState {
    Active,
    Overflow,
    Disposed,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticBridge {
    pub state: DiagnosticBridgeState,
    pub capacity: u64,
    pub pending: u64,
    pub queued: u64,
    pub in_flight: u64,
    #[serde(default)]
    pub waiting: u64,
    #[serde(default)]
    pub waiting_high_water: u64,
    pub high_water: u64,
    pub accepted: u64,
    pub invoked: u64,
    pub delivered: u64,
    pub failed: u64,
    pub overflow_events: u64,
    pub rejected: u64,
    pub expired: u64,
    pub stale_completions: u64,
    pub callback_errors: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageReceiveDiagnosticsDto {
    pub version: u8,
    pub captured_at_ms: u64,
    pub running: bool,
    pub run_generation: u64,
    pub sdk: Option<DiagnosticSdk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bridge: Option<DiagnosticBridge>,
    pub session: DiagnosticSession,
    pub compensation: DiagnosticCompensation,
}
impl PageReceiveDiagnosticsDto {
    pub fn decode(value: serde_json::Value) -> Option<Self> {
        fn safe(value: &serde_json::Value) -> bool {
            match value {
                serde_json::Value::Number(n) => {
                    n.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991)
                }
                serde_json::Value::Array(_) => false,
                serde_json::Value::Object(o) => o.values().all(safe),
                _ => true,
            }
        }
        if !safe(&value) {
            return None;
        }
        let page: Self = serde_json::from_value(value).ok()?;
        (page.version == 1).then_some(page)
    }
}
#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticAvailability {
    Ready,
    NoAccount,
    Timeout,
    Unavailable,
    Invalid,
}
#[derive(Clone, Serialize)]
pub struct ReceiveDiagnosticsDto {
    pub version: u8,
    pub captured_at_ms: u64,
    pub availability: DiagnosticAvailability,
    pub page: Option<PageReceiveDiagnosticsDto>,
    pub host: Option<HostReceiveDiagnosticsDto>,
}
#[derive(Serialize)]
pub struct NetStatusResult {
    #[serde(flatten)]
    pub status: UiNetStatusDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<ReceiveDiagnosticsDto>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageProfilePatch {
    pub message_id: Option<String>,
    pub local_id: Option<String>,
    pub sender_id: String,
    pub sender_name: Option<String>,
    pub sender_avatar: Option<String>,
}

/// Receipt-only updates never replay message text or local aliases.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageReadStatusPatch {
    pub message_id: String,
    pub sender_id: String,
    pub read_status: String,
}

/// Mirrors `AdapterDisplayPayload` (adapterProtocol.ts).
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DisplayPayload {
    Conversations {
        full: bool,
        items: Vec<DisplayConversationDto>,
        #[serde(default)]
        removed_gids: Vec<String>,
    },
    Messages {
        gid: String,
        replace: bool,
        items: Vec<UiMessageDto>,
    },
    MessageProfiles {
        gid: String,
        items: Vec<MessageProfilePatch>,
    },
    MessageReadStatuses {
        gid: String,
        items: Vec<MessageReadStatusPatch>,
    },
    AgentStatus {
        status: AgentStatusDto,
        confirmed: bool,
        status_epoch: u64,
        status_seq: u64,
    },
    Transport {
        state: TransportDto,
    },
    NoticeCategories {
        items: Vec<UiNoticeCategoryDto>,
    },
}

/// What a push changed; the adapter turns it into directed emits.
#[derive(Clone, PartialEq, Eq)]
pub enum DisplayDelta {
    Conversations {
        changed: Vec<String>,
        removed: Vec<String>,
    },
    Messages {
        gid: String,
        /// New or changed messages, in thread order.
        changed: Vec<UiMessageDto>,
    },
    /// Preserve validated receipt-only patches even for rows evicted from the
    /// bounded host cache: the main UI may still show older history.
    MessageReadStatuses {
        gid: String,
        items: Vec<MessageReadStatusPatch>,
    },
    AgentStatus(UiAgentStatusDto),
    Transport(TransportDto),
    NoticeCategories,
}

impl std::fmt::Debug for DisplayDelta {
    // Counts only: display data is never logged.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DisplayDelta::Conversations { changed, removed } => f
                .debug_struct("Conversations")
                .field("changed", &changed.len())
                .field("removed", &removed.len())
                .finish(),
            DisplayDelta::Messages { changed, .. } => f
                .debug_struct("Messages")
                .field("changed", &changed.len())
                .finish(),
            DisplayDelta::MessageReadStatuses { items, .. } => f
                .debug_struct("MessageReadStatuses")
                .field("items", &items.len())
                .finish(),
            DisplayDelta::AgentStatus(s) => f.debug_tuple("AgentStatus").field(s).finish(),
            DisplayDelta::Transport(t) => f.debug_tuple("Transport").field(t).finish(),
            DisplayDelta::NoticeCategories => f.write_str("NoticeCategories"),
        }
    }
}

// ------------------------------------------------------------------ validation

const MESSAGE_KINDS: [&str; 7] = [
    "text",
    "image",
    "file",
    "video",
    "voice",
    "order_card",
    "system",
];

fn validate_conversation(c: &DisplayConversationDto) -> Result<(), AppError> {
    if c.conversation_type.as_deref().is_some_and(|value| {
        value.encode_utf16().count() > 64
            || value.chars().all(|c| c.is_whitespace() || c == '\u{feff}')
            || value.chars().any(char::is_control)
    }) {
        return Err(invalid("invalid conversation type"));
    }
    if c.fact.gid.is_empty() {
        return Err(invalid("conversation gid is empty"));
    }
    if c.read_target_message_id
        .as_ref()
        .is_some_and(|id| id.trim().is_empty() || id.encode_utf16().count() > 512)
    {
        return Err(invalid("invalid read target message id"));
    }
    if c.mark > 5 {
        return Err(invalid("mark must be 0..=5"));
    }
    Ok(())
}

fn validate_message(gid: &str, m: &UiMessageDto) -> Result<(), AppError> {
    if m.gid != gid {
        return Err(invalid("message gid does not match thread"));
    }
    if !MESSAGE_KINDS.contains(&m.kind.as_str()) {
        return Err(invalid("unknown message kind"));
    }
    Ok(())
}

fn known_message_id(id: &Option<String>) -> Option<&str> {
    id.as_deref().filter(|value| !value.trim().is_empty())
}

fn compatible_sender(a: &UiMessageDto, b: &UiMessageDto) -> bool {
    if a.gid != b.gid || a.sender_role != b.sender_role {
        return false;
    }
    let a_id = a.sender_id.trim();
    let b_id = b.sender_id.trim();
    a_id.is_empty() || b_id.is_empty() || a_id.to_lowercase() == b_id.to_lowercase()
}

fn compatible_alias_group(a: &UiMessageDto, b: &UiMessageDto) -> bool {
    compatible_sender(a, b)
        && match (
            known_message_id(&a.message_id),
            known_message_id(&b.message_id),
        ) {
            (Some(a_id), Some(b_id)) => a_id == b_id,
            _ => true,
        }
}

fn same_message(a: &UiMessageDto, b: &UiMessageDto) -> bool {
    if a.gid != b.gid {
        return false;
    }
    if let (Some(a_id), Some(b_id)) = (
        known_message_id(&a.message_id),
        known_message_id(&b.message_id),
    ) {
        return a_id == b_id;
    }
    compatible_alias_group(a, b)
        && matches!((known_message_id(&a.local_id), known_message_id(&b.local_id)),
            (Some(a_id), Some(b_id)) if a_id == b_id)
}

fn read_status_rank(status: Option<&str>) -> u8 {
    match status {
        Some("read") => 2,
        Some("unread") => 1,
        _ => 0,
    }
}

/// A server correction may replace identity; only the same canonical message
/// and compatible sender can inherit an earlier read observation.
fn preserve_read_status(existing: &UiMessageDto, incoming: &mut UiMessageDto) {
    if compatible_sender(existing, incoming)
        && matches!((known_message_id(&existing.message_id), known_message_id(&incoming.message_id)),
            (Some(a), Some(b)) if a == b)
        && read_status_rank(existing.read_status.as_deref())
            > read_status_rank(incoming.read_status.as_deref())
    {
        incoming.read_status = existing.read_status.clone();
    }
}

fn matching_confirmation(m: &UiMessageDto, server_id: Option<&str>) -> bool {
    matches!((&m.disposition, server_id),
        (Some(SendDispositionDto::Confirmed { server_message_id, .. }), Some(id))
            if server_message_id == id)
}

/// Exact server IDs anchor reconciliation. Local IDs are only aliases within
/// a pairwise compatible sender/server group, never authority to join senders.
/// Stable slots keep existing scan order while merges remove aliases. Both
/// indexes include gid; local IDs only narrow candidates, never prove identity.
#[derive(Default)]
struct MessageIndex {
    server: HashMap<(String, String), BTreeSet<usize>>,
    local: HashMap<(String, String), BTreeSet<usize>>,
}

impl MessageIndex {
    fn update(&mut self, slot: usize, message: &UiMessageDto, insert: bool) {
        for (map, id) in [
            (&mut self.server, known_message_id(&message.message_id)),
            (&mut self.local, known_message_id(&message.local_id)),
        ] {
            let Some(id) = id else { continue };
            let key = (message.gid.clone(), id.to_string());
            if insert {
                map.entry(key).or_default().insert(slot);
            } else if let Some(slots) = map.get_mut(&key) {
                slots.remove(&slot);
                if slots.is_empty() {
                    map.remove(&key);
                }
            }
        }
    }

    fn candidates(&self, message: &UiMessageDto) -> (Vec<usize>, Vec<usize>) {
        let find = |map: &HashMap<(String, String), BTreeSet<usize>>, id: &Option<String>| {
            known_message_id(id)
                .and_then(|id| map.get(&(message.gid.clone(), id.to_string())))
                .map(|slots| slots.iter().copied().collect::<Vec<_>>())
                .unwrap_or_default()
        };
        (
            find(&self.server, &message.message_id),
            find(&self.local, &message.local_id),
        )
    }
}

fn merge_messages(
    thread: &mut Vec<UiMessageDto>,
    incoming: Vec<UiMessageDto>,
) -> Vec<UiMessageDto> {
    merge_messages_indexed(thread, incoming, |_| {})
}

fn merge_messages_indexed(
    thread: &mut Vec<UiMessageDto>,
    incoming: Vec<UiMessageDto>,
    mut note_candidates: impl FnMut(usize),
) -> Vec<UiMessageDto> {
    let mut index = MessageIndex::default();
    for (slot, message) in thread.iter().enumerate() {
        index.update(slot, message, true);
    }
    let mut removed = BTreeSet::new();
    let mut changed = Vec::new();
    for mut m in incoming {
        let (mut selected, local_candidates) = index.candidates(&m);
        note_candidates(selected.len() + local_candidates.len());
        let aliases: Vec<usize> = local_candidates
            .into_iter()
            .filter(|slot| {
                selected.binary_search(slot).is_err()
                    && same_message(&thread[*slot], &m)
                    && compatible_alias_group(&thread[*slot], &m)
            })
            .collect();
        if selected.is_empty() {
            // A missing UID can match several known UIDs independently. It
            // cannot choose a group or bridge those incompatible identities.
            if aliases.iter().all(|a| {
                aliases
                    .iter()
                    .all(|b| compatible_alias_group(&thread[*a], &thread[*b]))
            }) {
                selected = aliases;
            }
        } else {
            let aliases: Vec<usize> = aliases
                .into_iter()
                .filter(|index| {
                    selected
                        .iter()
                        .all(|old| compatible_alias_group(&thread[*old], &thread[*index]))
                })
                .collect();
            // A server anchor with no known UID does not identify which of
            // several conflicting local groups owns that server message.
            if aliases.iter().all(|a| {
                aliases
                    .iter()
                    .all(|b| compatible_alias_group(&thread[*a], &thread[*b]))
            }) {
                selected.extend(aliases);
            }
        }
        if selected.is_empty() {
            index.update(thread.len(), &m, true);
            thread.push(m.clone());
            changed.push(m);
            continue;
        }
        // Exact server IDs may correct an explicit sender conflict. Keep the
        // incoming record, but inherit nothing from the conflicting identity.
        let can_inherit = selected.iter().all(|a| {
            compatible_alias_group(&thread[*a], &m)
                && selected
                    .iter()
                    .all(|b| compatible_alias_group(&thread[*a], &thread[*b]))
        });
        if can_inherit {
            for index in &selected {
                preserve_read_status(&thread[*index], &mut m);
            }
            for index in &selected {
                let old = &thread[*index];
                if known_message_id(&m.message_id).is_none() {
                    m.message_id = old.message_id.clone();
                }
                if known_message_id(&m.local_id).is_none() {
                    m.local_id = old.local_id.clone();
                }
                m.original = m.original.or_else(|| old.original.clone());
                m.translation = m.translation.or_else(|| old.translation.clone());
                if !old.sender_id.trim().is_empty() {
                    m.sender_name = m.sender_name.or_else(|| old.sender_name.clone());
                    m.sender_avatar = m.sender_avatar.or_else(|| old.sender_avatar.clone());
                    if m.sender_id.trim().is_empty() {
                        m.sender_id = old.sender_id.clone();
                    }
                }
            }
            let server_id = known_message_id(&m.message_id);
            if !matching_confirmation(&m, server_id) {
                if let Some(old) = selected
                    .iter()
                    .map(|index| &thread[*index])
                    .find(|old| matching_confirmation(old, server_id))
                {
                    m.disposition = old.disposition.clone();
                } else if m.disposition.is_none() {
                    m.disposition =
                        selected
                            .iter()
                            .find_map(|index| match &thread[*index].disposition {
                                Some(SendDispositionDto::Confirmed { .. }) => None,
                                disposition => disposition.clone(),
                            });
                }
            }
        }
        // A confirmation must always refer to this canonical server message.
        if matches!(&m.disposition, Some(SendDispositionDto::Confirmed { .. }))
            && !matching_confirmation(&m, known_message_id(&m.message_id))
        {
            m.disposition = Some(SendDispositionDto::Unknown);
        }
        selected.sort_unstable();
        let first = selected[0];
        let was_changed = selected.len() > 1 || thread[first] != m;
        for slot in &selected {
            index.update(*slot, &thread[*slot], false);
        }
        for slot in selected.into_iter().skip(1) {
            removed.insert(slot);
        }
        index.update(first, &m, true);
        thread[first] = m.clone();
        if was_changed {
            changed.push(m);
        }
    }
    let mut slot = 0;
    thread.retain(|_| {
        let keep = !removed.contains(&slot);
        slot += 1;
        keep
    });
    thread.sort_by_key(|m| m.create_time_ms);
    if thread.len() > MAX_MESSAGES_PER_THREAD {
        let drop = thread.len() - MAX_MESSAGES_PER_THREAD;
        thread.drain(..drop);
    }
    changed.sort_by_key(|m| m.create_time_ms);
    changed
}

// ------------------------------------------------------------------ cache

#[derive(Default)]
struct AccountDisplay {
    generation: u64,
    conversations: BTreeMap<String, DisplayConversationDto>,
    // At most MAX_CONVERSATIONS u32 values; retain the exact sum across saturation.
    unread_total: u64,
    threads: HashMap<String, Vec<UiMessageDto>>,
    /// Thread insertion order for eviction.
    thread_order: VecDeque<String>,
    agent_status: Option<UiAgentStatusDto>,
    agent_status_cursor: Option<(u64, u64)>,
    transport: Option<TransportDto>,
    notice_categories: Vec<UiNoticeCategoryDto>,
}

impl AccountDisplay {
    fn new(generation: u64) -> Self {
        Self {
            generation,
            ..Self::default()
        }
    }

    fn touch_thread(&mut self, gid: &str) {
        if let Some(pos) = self.thread_order.iter().position(|g| g == gid) {
            self.thread_order.remove(pos);
        }
        self.thread_order.push_back(gid.to_string());
        while self.thread_order.len() > MAX_THREADS {
            if let Some(old) = self.thread_order.pop_front() {
                self.threads.remove(&old);
            }
        }
    }
}

type Key = (Environment, AccountId);

fn key_of(ctx: &AccountContext) -> Key {
    (ctx.environment.clone(), ctx.account_id.clone())
}

fn stale(ctx: &AccountContext, current: u64) -> AppError {
    AppError::new(
        codes::ACCOUNT_STALE_GENERATION,
        format!(
            "display generation {} is older than {}",
            ctx.session_generation, current
        ),
    )
}

/// Display data of every account, keyed by persistent identity.
#[derive(Default)]
pub struct DisplayCache {
    accounts: HashMap<Key, AccountDisplay>,
}

impl std::fmt::Debug for DisplayCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DisplayCache")
            .field("accounts", &self.accounts.len())
            .finish_non_exhaustive()
    }
}

impl DisplayCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Entry for writing: resets on a newer generation, rejects older ones.
    fn entry_mut(&mut self, ctx: &AccountContext) -> Result<&mut AccountDisplay, AppError> {
        let slot = self
            .accounts
            .entry(key_of(ctx))
            .or_insert_with(|| AccountDisplay::new(ctx.session_generation));
        if ctx.session_generation < slot.generation {
            return Err(stale(ctx, slot.generation));
        }
        if ctx.session_generation > slot.generation {
            *slot = AccountDisplay::new(ctx.session_generation);
        }
        Ok(slot)
    }

    /// Entry for reading: only the exact generation sees data.
    fn entry(&self, ctx: &AccountContext) -> Result<Option<&AccountDisplay>, AppError> {
        match self.accounts.get(&key_of(ctx)) {
            None => Ok(None),
            Some(a) if a.generation == ctx.session_generation => Ok(Some(a)),
            Some(a) if ctx.session_generation < a.generation => Err(stale(ctx, a.generation)),
            Some(_) => Ok(None),
        }
    }

    /// Applies one adapter push.
    pub fn apply(
        &mut self,
        ctx: &AccountContext,
        payload: DisplayPayload,
    ) -> Result<DisplayDelta, AppError> {
        // Validate everything before touching the cache.
        match &payload {
            DisplayPayload::Conversations { items, .. } => {
                if items.len() > MAX_CONVERSATIONS {
                    return Err(invalid("too many conversations in one push"));
                }
                items.iter().try_for_each(validate_conversation)?;
            }
            DisplayPayload::Messages { gid, items, .. } => {
                if gid.is_empty() {
                    return Err(invalid("thread gid is empty"));
                }
                items.iter().try_for_each(|m| validate_message(gid, m))?;
            }
            DisplayPayload::MessageReadStatuses { gid, items } => {
                if gid.trim().is_empty()
                    || items.len() > 2000
                    || items.iter().any(|p| {
                        p.message_id.trim().is_empty()
                            || p.message_id.len() > 512
                            || p.sender_id.trim().is_empty()
                            || p.sender_id.len() > 512
                            || !matches!(p.read_status.as_str(), "read" | "unread")
                    })
                {
                    return Err(invalid("invalid message read statuses"));
                }
            }
            DisplayPayload::MessageProfiles { gid, items }
                if gid.is_empty()
                    || items.iter().any(|p| {
                        p.sender_id.trim().is_empty()
                            || (!p.message_id.as_ref().is_some_and(|s| !s.is_empty())
                                && !p.local_id.as_ref().is_some_and(|s| !s.is_empty()))
                    }) =>
            {
                return Err(invalid(
                    "message profile needs thread, message, and sender identities",
                ));
            }
            _ => {}
        }
        let acc = self.entry_mut(ctx)?;
        Ok(match payload {
            DisplayPayload::Conversations {
                full,
                items,
                removed_gids,
            } => {
                let mut removed = Vec::new();
                if full {
                    let keep: BTreeSet<&str> = items.iter().map(|c| c.fact.gid.as_str()).collect();
                    removed.extend(
                        acc.conversations
                            .keys()
                            .filter(|g| !keep.contains(g.as_str()))
                            .cloned(),
                    );
                }
                for gid in removed_gids {
                    if acc.conversations.contains_key(&gid) && !removed.contains(&gid) {
                        removed.push(gid);
                    }
                }
                for gid in &removed {
                    if let Some(old) = acc.conversations.remove(gid) {
                        acc.unread_total -= u64::from(old.fact.unread_count);
                    }
                }
                let mut changed = Vec::new();
                for c in items {
                    let gid = c.fact.gid.clone();
                    if acc.conversations.get(&gid) != Some(&c) {
                        if !acc.conversations.contains_key(&gid)
                            && acc.conversations.len() >= MAX_CONVERSATIONS
                        {
                            continue;
                        }
                        acc.unread_total += u64::from(c.fact.unread_count);
                        if let Some(old) = acc.conversations.insert(gid.clone(), c) {
                            acc.unread_total -= u64::from(old.fact.unread_count);
                        }
                        changed.push(gid);
                    }
                }
                DisplayDelta::Conversations { changed, removed }
            }
            DisplayPayload::Messages {
                gid,
                replace,
                items,
            } => {
                let changed = if replace {
                    let mut fresh = Vec::new();
                    let _ = merge_messages(&mut fresh, items);
                    let old = acc
                        .threads
                        .insert(gid.clone(), fresh.clone())
                        .unwrap_or_default();
                    type MessageIdentity<'a> = (&'a str, Option<&'a str>, Option<&'a str>);
                    let mut by_identity: HashMap<MessageIdentity<'_>, Vec<&UiMessageDto>> =
                        HashMap::new();
                    for message in &old {
                        by_identity
                            .entry((
                                message.gid.as_str(),
                                message.message_id.as_deref(),
                                message.local_id.as_deref(),
                            ))
                            .or_default()
                            .push(message);
                    }
                    fresh
                        .into_iter()
                        .filter(|message| {
                            !by_identity
                                .get(&(
                                    message.gid.as_str(),
                                    message.message_id.as_deref(),
                                    message.local_id.as_deref(),
                                ))
                                .is_some_and(|candidates| candidates.contains(&message))
                        })
                        .collect()
                } else {
                    let thread = acc.threads.entry(gid.clone()).or_default();
                    merge_messages(thread, items)
                };
                acc.touch_thread(&gid);
                DisplayDelta::Messages { gid, changed }
            }
            DisplayPayload::MessageReadStatuses { gid, items } => {
                if let Some(thread) = acc.threads.get_mut(&gid) {
                    for m in thread.iter_mut() {
                        if let Some(status) = items
                            .iter()
                            .filter(|p| {
                                m.gid == gid
                                    && m.message_id.as_deref() == Some(p.message_id.as_str())
                                    && !m.sender_id.trim().is_empty()
                                    && m.sender_id.trim().to_lowercase()
                                        == p.sender_id.trim().to_lowercase()
                            })
                            .map(|p| p.read_status.as_str())
                            .max_by_key(|status| read_status_rank(Some(status)))
                        {
                            if read_status_rank(Some(status))
                                > read_status_rank(m.read_status.as_deref())
                            {
                                m.read_status = Some(status.to_string());
                            }
                        }
                    }
                }
                DisplayDelta::MessageReadStatuses { gid, items }
            }
            DisplayPayload::MessageProfiles { gid, items } => {
                let mut changed = Vec::new();
                if let Some(thread) = acc.threads.get_mut(&gid) {
                    for p in items {
                        let existing = thread.iter_mut().find(|m| {
                            let message_matches = if let Some(id) = p.message_id.as_ref().filter(|id| !id.is_empty()) {
                                m.message_id.as_ref() == Some(id)
                                    && !matches!((&m.local_id, &p.local_id), (Some(a), Some(b)) if a != b)
                            } else {
                                matches!((&m.local_id, &p.local_id), (Some(a), Some(b)) if !b.is_empty() && a == b)
                            };
                            message_matches && !m.sender_id.trim().is_empty()
                                && m.sender_id.trim().to_lowercase() == p.sender_id.trim().to_lowercase()
                        });
                        if let Some(m) = existing {
                            let before = m.clone();
                            if p.sender_name.is_some() {
                                m.sender_name = p.sender_name;
                            }
                            if p.sender_avatar.is_some() {
                                m.sender_avatar = p.sender_avatar;
                            }
                            if *m != before {
                                changed.push(m.clone());
                            }
                        }
                    }
                }
                DisplayDelta::Messages { gid, changed }
            }
            DisplayPayload::AgentStatus {
                status,
                confirmed,
                status_epoch,
                status_seq,
            } => {
                let cursor = (status_epoch, status_seq);
                if status_epoch == 0
                    || status_seq == 0
                    || status_epoch > 9_007_199_254_740_991
                    || status_seq > 9_007_199_254_740_991
                {
                    return Err(invalid("invalid agent status cursor"));
                }
                if acc
                    .agent_status_cursor
                    .is_some_and(|previous| cursor <= previous)
                {
                    return Err(invalid("superseded agent status observation"));
                }
                acc.agent_status_cursor = Some(cursor);
                let s = UiAgentStatusDto { status, confirmed };
                acc.agent_status = Some(s);
                DisplayDelta::AgentStatus(s)
            }
            DisplayPayload::Transport { state } => {
                acc.transport = Some(state);
                DisplayDelta::Transport(state)
            }
            DisplayPayload::NoticeCategories { items } => {
                acc.notice_categories = items;
                DisplayDelta::NoticeCategories
            }
        })
    }

    /// Cached conversation rows (unordered; the UI sorts).
    pub fn conversations(
        &self,
        ctx: &AccountContext,
    ) -> Result<Vec<DisplayConversationDto>, AppError> {
        Ok(self
            .entry(ctx)?
            .map(|a| a.conversations.values().cloned().collect())
            .unwrap_or_default())
    }

    pub fn conversation(
        &self,
        ctx: &AccountContext,
        gid: &str,
    ) -> Result<Option<DisplayConversationDto>, AppError> {
        Ok(self
            .entry(ctx)?
            .and_then(|a| a.conversations.get(gid).cloned()))
    }

    /// Cached thread, `None` when never loaded.
    pub fn messages(
        &self,
        ctx: &AccountContext,
        gid: &str,
    ) -> Result<Option<Vec<UiMessageDto>>, AppError> {
        Ok(self.entry(ctx)?.and_then(|a| a.threads.get(gid).cloned()))
    }

    /// Sum of conversation unread counts (title-bar badge).
    pub fn total_unread(&self, ctx: &AccountContext) -> u32 {
        self.entry(ctx)
            .ok()
            .flatten()
            .map(|a| u32::try_from(a.unread_total).unwrap_or(u32::MAX))
            .unwrap_or(0)
    }

    pub fn agent_status(&self, ctx: &AccountContext) -> Option<UiAgentStatusDto> {
        self.entry(ctx).ok().flatten().and_then(|a| a.agent_status)
    }

    pub fn set_agent_status(
        &mut self,
        ctx: &AccountContext,
        s: UiAgentStatusDto,
    ) -> Result<(), AppError> {
        self.entry_mut(ctx)?.agent_status = Some(s);
        Ok(())
    }

    pub fn transport(&self, ctx: &AccountContext) -> Option<TransportDto> {
        self.entry(ctx).ok().flatten().and_then(|a| a.transport)
    }

    /// `(account generation, transport)` of every account that reported one.
    pub fn transports(&self) -> Vec<(Environment, AccountId, u64, TransportDto)> {
        self.accounts
            .iter()
            .filter_map(|((env, id), a)| {
                a.transport
                    .map(|t| (env.clone(), id.clone(), a.generation, t))
            })
            .collect()
    }

    pub fn notice_categories(&self, ctx: &AccountContext) -> Vec<UiNoticeCategoryDto> {
        self.entry(ctx)
            .ok()
            .flatten()
            .map(|a| a.notice_categories.clone())
            .unwrap_or_default()
    }

    pub fn set_notice_categories(
        &mut self,
        ctx: &AccountContext,
        items: Vec<UiNoticeCategoryDto>,
    ) -> Result<(), AppError> {
        self.entry_mut(ctx)?.notice_categories = items;
        Ok(())
    }

    /// Replaces a thread with a page read-back (`im.messages`).
    pub fn replace_thread(
        &mut self,
        ctx: &AccountContext,
        gid: &str,
        items: Vec<UiMessageDto>,
    ) -> Result<Vec<UiMessageDto>, AppError> {
        items.iter().try_for_each(|m| validate_message(gid, m))?;
        let acc = self.entry_mut(ctx)?;
        let mut fresh = Vec::new();
        let _ = merge_messages(&mut fresh, items);
        acc.threads.insert(gid.to_string(), fresh.clone());
        acc.touch_thread(gid);
        Ok(fresh)
    }

    /// Merge a server page with realtime messages that may have arrived while it was loading.
    pub fn merge_thread(
        &mut self,
        ctx: &AccountContext,
        gid: &str,
        items: Vec<UiMessageDto>,
    ) -> Result<Vec<UiMessageDto>, AppError> {
        items.iter().try_for_each(|m| validate_message(gid, m))?;
        let acc = self.entry_mut(ctx)?;
        let thread = acc.threads.entry(gid.to_string()).or_default();
        merge_messages(thread, items);
        let merged = thread.clone();
        acc.touch_thread(gid);
        Ok(merged)
    }

    /// Records fetched platform translations so thread re-reads keep them, and
    /// returns how many were only an echo of the original. Echoes are not kept,
    /// and neither are flagged bodies: the main window decides whether to show those.
    pub fn set_translations(
        &mut self,
        ctx: &AccountContext,
        gid: &str,
        items: &[UiMessageTranslationDto],
    ) -> Result<usize, AppError> {
        let acc = self.entry_mut(ctx)?;
        let Some(thread) = acc.threads.get_mut(gid) else {
            return Ok(0);
        };
        let mut echoes = 0;
        for item in items {
            let Some(text) = item.translation.as_ref() else {
                continue;
            };
            let flagged = item.reason.as_deref() == Some("flagged");
            for m in thread
                .iter_mut()
                .filter(|m| m.message_id.as_deref() == Some(item.message_id.as_str()))
            {
                if m.text.trim() == text.trim() {
                    echoes += 1;
                } else if !flagged {
                    m.translation = Some(text.clone());
                }
            }
        }
        Ok(echoes)
    }

    /// Local echo after a confirmed `im.set_mark`.
    pub fn set_mark(
        &mut self,
        ctx: &AccountContext,
        gid: &str,
        mark: u8,
    ) -> Result<bool, AppError> {
        let acc = self.entry_mut(ctx)?;
        Ok(match acc.conversations.get_mut(gid) {
            Some(c) if c.mark != mark => {
                c.mark = mark;
                true
            }
            _ => false,
        })
    }

    /// Drops everything cached for `ctx`'s identity at or below its
    /// generation (logout / removal).
    pub fn remove(&mut self, ctx: &AccountContext) {
        let key = key_of(ctx);
        if self
            .accounts
            .get(&key)
            .is_some_and(|a| a.generation <= ctx.session_generation)
        {
            self.accounts.remove(&key);
        }
    }
}

// ------------------------------------------------------------------ pinned

/// Local pinned conversations per persistent identity. Holds gids only.
#[derive(Debug, Default)]
pub struct PinnedTable {
    path: Option<PathBuf>,
    /// `"{environment}/{account_id}"` → gids.
    by_account: BTreeMap<String, BTreeSet<String>>,
}

fn pinned_key(ctx: &AccountContext) -> String {
    format!("{}/{}", ctx.environment.as_str(), ctx.account_id.as_str())
}

impl PinnedTable {
    /// Loads `path`; a missing or unreadable file starts empty (the file is
    /// left in place so nothing is silently wiped).
    pub fn load(path: PathBuf) -> Self {
        let by_account = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<BTreeMap<String, BTreeSet<String>>>(&b).ok())
            .unwrap_or_default();
        Self {
            path: Some(path),
            by_account,
        }
    }

    pub fn is_top(&self, ctx: &AccountContext, gid: &str) -> bool {
        self.by_account
            .get(&pinned_key(ctx))
            .is_some_and(|s| s.contains(gid))
    }

    /// Returns true when the table changed. Persists on change.
    pub fn set(&mut self, ctx: &AccountContext, gid: &str, top: bool) -> Result<bool, AppError> {
        let key = pinned_key(ctx);
        let changed = if top {
            self.by_account
                .entry(key)
                .or_default()
                .insert(gid.to_string())
        } else {
            let changed = self.by_account.get_mut(&key).is_some_and(|s| s.remove(gid));
            if self.by_account.get(&key).is_some_and(|s| s.is_empty()) {
                self.by_account.remove(&key);
            }
            changed
        };
        if changed {
            self.save()?;
        }
        Ok(changed)
    }

    fn save(&self) -> Result<(), AppError> {
        let Some(path) = self.path.as_deref() else {
            return Ok(());
        };
        write_atomic(path, &self.by_account)
    }
}

/// Durable replace through `core_store::write_atomic` (unique temp file,
/// file `fsync`, rename, directory `fsync`): a crash leaves the old or the
/// new table, never a prefix, and concurrent saves never share a temp name.
fn write_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    let bad_path = || AppError::new(codes::STORE_IO, "pinned table: path has no file name");
    let dir = path.parent().ok_or_else(bad_path)?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(bad_path)?;
    let bytes = serde_json::to_vec(value)
        .map_err(|e| AppError::new(codes::STORE_IO, format!("pinned table: {e}")))?;
    core_store::write_atomic(dir, name, &bytes)
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_status_policy() {
        for status in [
            AgentStatusDto::Online,
            AgentStatusDto::Hangup,
            AgentStatusDto::Leaving,
            AgentStatusDto::Getoff,
        ] {
            assert!(!UiAgentStatusDto {
                status,
                confirmed: false
            }
            .allows_notifications());
            assert_eq!(
                UiAgentStatusDto {
                    status,
                    confirmed: true
                }
                .allows_notifications(),
                matches!(status, AgentStatusDto::Online | AgentStatusDto::Hangup)
            );
        }
    }

    fn ctx(gen: u64) -> AccountContext {
        AccountContext::new(AccountId::new("a1"), Environment::production(), gen)
    }

    fn other() -> AccountContext {
        AccountContext::new(AccountId::new("a2"), Environment::production(), 1)
    }

    fn conv_json(gid: &str, unread: u32) -> serde_json::Value {
        serde_json::json!({
            "gid": gid, "status": "active", "agent_in_group": true, "is_owner": true,
            "service_type": "1", "last_message_time_ms": 10, "last_update_time_ms": 10,
            "unread_count": unread, "is_full_snapshot": false,
            "title": "T", "color": "#fff", "lang": "zh", "biz": "b", "preview": "p",
            "mark": 0, "customer_tags": [], "order": null
        })
    }

    #[test]
    fn read_frontier_is_optional_but_typed_and_bounded() {
        let legacy: DisplayConversationDto = serde_json::from_value(conv_json("g", 3)).unwrap();
        assert!(legacy.read_target_message_id.is_none());
        let mut raw = conv_json("g", 3);
        raw["read_target_message_id"] = serde_json::json!("x".repeat(512));
        let valid: DisplayConversationDto = serde_json::from_value(raw.clone()).unwrap();
        assert!(validate_conversation(&valid).is_ok());
        assert_eq!(
            serde_json::to_value(&valid).unwrap()["read_target_message_id"],
            raw["read_target_message_id"]
        );
        for id in ["".to_owned(), " ".to_owned(), "x".repeat(513)] {
            raw["read_target_message_id"] = serde_json::json!(id);
            let invalid: DisplayConversationDto = serde_json::from_value(raw.clone()).unwrap();
            assert!(validate_conversation(&invalid).is_err());
        }
        raw["read_target_message_id"] = serde_json::json!(123);
        assert!(serde_json::from_value::<DisplayConversationDto>(raw).is_err());
    }

    fn convs(full: bool, items: &[(&str, u32)], removed: &[&str]) -> DisplayPayload {
        serde_json::from_value(serde_json::json!({
            "kind": "conversations", "full": full,
            "items": items.iter().map(|(g, u)| conv_json(g, *u)).collect::<Vec<_>>(),
            "removed_gids": removed,
        }))
        .expect("payload")
    }

    fn msg(gid: &str, mid: Option<&str>, lid: Option<&str>, t: i64, text: &str) -> UiMessageDto {
        UiMessageDto {
            platform_type: Some(0),
            gid: gid.into(),
            message_id: mid.map(Into::into),
            local_id: lid.map(Into::into),
            create_time_ms: t,
            sender_role: "customer".into(),
            sender_id: "customer".into(),
            sender_name: None,
            sender_avatar: None,
            kind: "text".into(),
            text: text.into(),
            media_url: None,
            media_thumbnail: None,
            media_filename: None,
            voice_duration_s: None,
            recalled_message_id: None,
            read_status: None,
            translation: None,
            original: None,
            quote: None,
            order_id: None,
            disposition: None,
        }
    }

    #[test]
    fn media_fields_survive_real_display_cache_and_ui_roundtrip() {
        for kind in ["image", "video", "file", "voice"] {
            let source = "https://example.invalid/synthetic-resource";
            let thumb = "https://example.invalid/synthetic-preview";
            let raw = serde_json::json!({
                "kind": "messages", "gid": "synthetic-room", "replace": false,
                "items": [{ "gid": "synthetic-room", "message_id": "900719925474099312345",
                    "local_id": null, "create_time_ms": 1700000000000_i64,
                    "sender_role": "customer", "kind": kind, "text": "SYNTHETIC MEDIA",
                    "media_url": source, "media_thumbnail": thumb, "media_filename": "synthetic.pdf" }]
            });
            let mut cache = DisplayCache::new();
            cache
                .apply(&ctx(1), serde_json::from_value(raw).unwrap())
                .unwrap();
            let rows = cache.messages(&ctx(1), "synthetic-room").unwrap().unwrap();
            let encoded = serde_json::to_value(&rows[0]).unwrap();
            assert_eq!(encoded["media_url"], source);
            assert_eq!(encoded["media_thumbnail"], thumb);
            assert_eq!(encoded["media_filename"], "synthetic.pdf");
            assert_eq!(encoded["message_id"], "900719925474099312345");
            assert_eq!(encoded["kind"], kind);
        }
    }

    #[test]
    fn voice_message_survives_display_cache_with_duration_and_url() {
        let source = "https://example.c-ctrip.com/synthetic.aac";
        let raw = serde_json::json!({
            "kind": "messages", "gid": "synthetic-room", "replace": false,
            "items": [
                { "gid": "synthetic-room", "message_id": "voice-1", "local_id": null,
                  "create_time_ms": 1700000000000_i64, "sender_role": "customer", "kind": "voice",
                  "text": "SYNTHETIC TRANSCRIPT", "media_url": source, "voice_duration_s": 5 },
                { "gid": "synthetic-room", "message_id": "voice-2", "local_id": null,
                  "create_time_ms": 1700000000001_i64, "sender_role": "customer", "kind": "voice",
                  "text": "", "media_url": null, "voice_duration_s": null }
            ]
        });
        let mut cache = DisplayCache::new();
        cache
            .apply(&ctx(1), serde_json::from_value(raw).unwrap())
            .unwrap();
        let rows = cache.messages(&ctx(1), "synthetic-room").unwrap().unwrap();
        let playable = serde_json::to_value(&rows[0]).unwrap();
        assert_eq!(playable["kind"], "voice");
        assert_eq!(playable["media_url"], source);
        assert_eq!(playable["voice_duration_s"], 5);
        assert_eq!(playable["text"], "SYNTHETIC TRANSCRIPT");
        let unplayable = serde_json::to_value(&rows[1]).unwrap();
        assert_eq!(unplayable["kind"], "voice");
        assert!(unplayable["media_url"].is_null());
        assert!(unplayable.get("voice_duration_s").is_none());
    }

    #[test]
    fn recall_target_survives_host_dto_roundtrip_without_numeric_conversion() {
        let target = "900719925474099312345";
        let raw = serde_json::json!({
            "gid": "synthetic-room", "message_id": "synthetic-recall", "local_id": null,
            "create_time_ms": 1700000000000_i64, "sender_role": "system", "kind": "system",
            "text": "消息已撤回", "recalled_message_id": target
        });
        let decoded: UiMessageDto = serde_json::from_value(raw).unwrap();
        let encoded = serde_json::to_value(decoded).unwrap();
        assert_eq!(
            encoded.get("recalled_message_id").and_then(|v| v.as_str()),
            Some(target)
        );
    }

    #[test]
    fn unread_requires_authoritative_server_snapshot_and_preserves_same_value() {
        let mut cache = DisplayCache::new();
        cache
            .apply(&ctx(1), convs(true, &[("g1", 3)], &[]))
            .unwrap();
        assert_eq!(cache.total_unread(&ctx(1)), 3);
        let unchanged = cache
            .apply(&ctx(1), convs(false, &[("g1", 3)], &[]))
            .unwrap();
        assert_eq!(
            unchanged,
            DisplayDelta::Conversations {
                changed: vec![],
                removed: vec![]
            }
        );
        assert_eq!(cache.total_unread(&ctx(1)), 3);
        let cleared = cache
            .apply(&ctx(1), convs(false, &[("g1", 0)], &[]))
            .unwrap();
        assert_eq!(
            cleared,
            DisplayDelta::Conversations {
                changed: vec!["g1".into()],
                removed: vec![]
            }
        );
        assert_eq!(cache.total_unread(&ctx(1)), 0);
    }

    #[test]
    fn conversations_isolated_per_account_and_unread_summed() {
        let mut c = DisplayCache::new();
        c.apply(&ctx(1), convs(true, &[("g1", 2), ("g2", 3)], &[]))
            .expect("apply");
        c.apply(&other(), convs(true, &[("x", 9)], &[]))
            .expect("apply");
        assert_eq!(c.conversations(&ctx(1)).expect("read").len(), 2);
        assert_eq!(c.total_unread(&ctx(1)), 5);
        assert_eq!(c.total_unread(&other()), 9);
        assert!(c.conversation(&ctx(1), "x").expect("read").is_none());
    }

    #[test]
    fn full_snapshot_removes_missing_and_increment_reports_changes() {
        let mut c = DisplayCache::new();
        c.apply(&ctx(1), convs(true, &[("g1", 0), ("g2", 0)], &[]))
            .expect("apply");
        let d = c
            .apply(&ctx(1), convs(true, &[("g2", 0)], &[]))
            .expect("apply");
        assert_eq!(
            d,
            DisplayDelta::Conversations {
                changed: vec![],
                removed: vec!["g1".into()]
            }
        );
        let d = c
            .apply(&ctx(1), convs(false, &[("g3", 1)], &["g2"]))
            .expect("apply");
        assert_eq!(
            d,
            DisplayDelta::Conversations {
                changed: vec!["g3".into()],
                removed: vec!["g2".into()]
            }
        );
    }

    #[test]
    fn stale_generation_rejected_newer_resets() {
        let mut c = DisplayCache::new();
        c.apply(&ctx(2), convs(true, &[("g1", 1)], &[]))
            .expect("apply");
        let e = c
            .apply(&ctx(1), convs(true, &[("g9", 1)], &[]))
            .expect_err("stale");
        assert!(e.is(codes::ACCOUNT_STALE_GENERATION));
        assert!(c.conversations(&ctx(1)).is_err());
        c.apply(&ctx(3), convs(false, &[("g2", 1)], &[]))
            .expect("apply");
        let rows = c.conversations(&ctx(3)).expect("read");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].fact.gid, "g2");
        // The previous generation no longer sees anything.
        assert!(c.conversations(&ctx(2)).is_err());
    }

    #[test]
    fn fetched_translations_survive_a_thread_reread() {
        let mut c = DisplayCache::new();
        let thread = vec![
            msg("g", Some("m1"), None, 10, "Да"),
            msg("g", Some("m2"), None, 20, "Нет"),
        ];
        c.merge_thread(&ctx(1), "g", thread.clone()).expect("merge");
        let item = |id: &str, translation: Option<&str>| UiMessageTranslationDto {
            message_id: id.into(),
            status: if translation.is_some() {
                "translated"
            } else {
                "missing"
            }
            .into(),
            translation: translation.map(str::to_string),
            source_kind: translation.map(|_| "text".to_string()),
            reason: None,
        };
        c.set_translations(
            &ctx(1),
            "g",
            &[
                item("m1", Some("是的")),
                item("m2", None),
                item("absent", Some("x")),
            ],
        )
        .expect("translations");
        // An unknown thread is not an error: the row can arrive later.
        c.set_translations(&ctx(1), "other", &[item("m1", Some("是的"))])
            .expect("no thread");
        let merged = c.merge_thread(&ctx(1), "g", thread).expect("re-read");
        assert_eq!(merged[0].translation.as_deref(), Some("是的"));
        assert_eq!(merged[1].translation, None);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn echoed_and_flagged_translations_are_not_kept_for_rereads() {
        let mut c = DisplayCache::new();
        let thread = vec![
            msg("g", Some("m1"), None, 10, "Да"),
            msg("g", Some("m2"), None, 20, "Нет"),
        ];
        c.merge_thread(&ctx(1), "g", thread.clone()).expect("merge");
        let item = |id: &str, text: &str, reason: Option<&str>| UiMessageTranslationDto {
            message_id: id.into(),
            status: "translated".into(),
            translation: Some(text.into()),
            source_kind: Some("text".into()),
            reason: reason.map(str::to_string),
        };
        let echoes = c
            .set_translations(
                &ctx(1),
                "g",
                &[item("m1", "Да", None), item("m2", "不是", Some("flagged"))],
            )
            .expect("translations");
        assert_eq!(echoes, 1);
        let merged = c.merge_thread(&ctx(1), "g", thread).expect("re-read");
        assert_eq!(merged[0].translation, None);
        assert_eq!(merged[1].translation, None);
    }

    #[test]
    fn messages_merge_by_server_or_local_id() {
        let mut c = DisplayCache::new();
        let p = DisplayPayload::Messages {
            gid: "g".into(),
            replace: false,
            items: vec![
                msg("g", None, Some("l1"), 20, "hi"),
                msg("g", Some("m0"), None, 10, "a"),
            ],
        };
        let DisplayDelta::Messages { changed, .. } = c.apply(&ctx(1), p).expect("apply") else {
            panic!("wrong delta");
        };
        assert_eq!(changed.len(), 2);
        // Outbound message confirmed: same local id gains a server id.
        let p = DisplayPayload::Messages {
            gid: "g".into(),
            replace: false,
            items: vec![
                msg("g", Some("m1"), Some("l1"), 20, "hi"),
                msg("g", Some("m0"), None, 10, "a"),
            ],
        };
        let DisplayDelta::Messages { changed, .. } = c.apply(&ctx(1), p).expect("apply") else {
            panic!("wrong delta");
        };
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].message_id.as_deref(), Some("m1"));
        let thread = c.messages(&ctx(1), "g").expect("read").expect("thread");
        assert_eq!(thread.len(), 2);
        assert_eq!(thread[0].create_time_ms, 10);
        assert!(c.messages(&ctx(1), "other").expect("read").is_none());
    }

    #[test]
    fn message_with_wrong_gid_rejected_and_cache_untouched() {
        let mut c = DisplayCache::new();
        let p = DisplayPayload::Messages {
            gid: "g".into(),
            replace: true,
            items: vec![
                msg("g", Some("m"), None, 1, "a"),
                msg("h", Some("n"), None, 2, "b"),
            ],
        };
        assert!(c.apply(&ctx(1), p).is_err());
        assert!(c.messages(&ctx(1), "g").expect("read").is_none());
    }

    #[test]
    fn history_page_merges_realtime_and_keeps_send_correlation() {
        let mut cache = DisplayCache::new();
        let mut sent = msg("g", Some("server"), Some("local"), 20, "hello");
        sent.original = Some("original".into());
        sent.sender_name = Some("agent".into());
        cache
            .merge_thread(
                &ctx(1),
                "g",
                vec![sent, msg("g", Some("live"), None, 30, "latest")],
            )
            .expect("live");
        let merged = cache
            .merge_thread(
                &ctx(1),
                "g",
                vec![
                    msg("g", Some("old"), None, 10, "history"),
                    msg("g", Some("server"), None, 20, "hello"),
                ],
            )
            .expect("page");
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[1].local_id.as_deref(), Some("local"));
        assert_eq!(merged[1].original.as_deref(), Some("original"));
        assert_eq!(merged[1].sender_name.as_deref(), Some("agent"));
        assert_eq!(merged[2].message_id.as_deref(), Some("live"));
    }

    fn alias_message(
        server: Option<&str>,
        local: Option<&str>,
        uid: &str,
        role: &str,
        time: i64,
    ) -> UiMessageDto {
        let mut value = msg("g", server, local, time, "synthetic content");
        value.sender_id = uid.into();
        value.sender_role = role.into();
        value
    }
    fn alias_confirmed() -> UiMessageDto {
        let mut value = alias_message(
            Some("server-self"),
            Some("local-shared"),
            "self",
            "merchant_self",
            10,
        );
        value.original = Some("synthetic self original".into());
        value.translation = Some("synthetic self translation".into());
        value.sender_name = Some("Self".into());
        value.sender_avatar = Some("https://example.invalid/self.png".into());
        value.disposition = Some(SendDispositionDto::Confirmed {
            server_message_id: "server-self".into(),
            server_time_ms: 10,
        });
        value
    }

    #[test]
    fn history_alias_different_sender_sharing_local_id_cannot_replace_or_inherit_from_confirmed_self(
    ) {
        let mut cache = DisplayCache::new();
        cache
            .merge_thread(&ctx(1), "g", vec![alias_confirmed()])
            .unwrap();
        let customer = alias_message(
            Some("server-customer"),
            Some("local-shared"),
            "customer",
            "customer",
            20,
        );
        let merged = cache.merge_thread(&ctx(1), "g", vec![customer]).unwrap();
        assert_eq!(merged.len(), 2);
        let customer = merged
            .iter()
            .find(|m| m.message_id.as_deref() == Some("server-customer"))
            .unwrap();
        assert_eq!(customer.sender_id, "customer");
        assert!(customer.disposition.is_none());
        assert!(customer.original.is_none());
        assert!(customer.translation.is_none());
        let own = merged
            .iter()
            .find(|m| m.message_id.as_deref() == Some("server-self"))
            .unwrap();
        assert!(
            matches!(&own.disposition, Some(SendDispositionDto::Confirmed { server_message_id, .. }) if server_message_id == "server-self")
        );
    }

    #[test]
    fn history_alias_two_known_different_server_ids_do_not_merge_even_for_the_same_sender_and_local_id(
    ) {
        let mut cache = DisplayCache::new();
        cache
            .merge_thread(&ctx(1), "g", vec![alias_confirmed()])
            .unwrap();
        let different = alias_message(
            Some("server-other"),
            Some("local-shared"),
            "self",
            "merchant_self",
            20,
        );
        let merged = cache.merge_thread(&ctx(1), "g", vec![different]).unwrap();
        assert_eq!(merged.len(), 2);
        let other = merged
            .iter()
            .find(|m| m.message_id.as_deref() == Some("server-other"))
            .unwrap();
        assert!(other.original.is_none());
        assert!(other.disposition.is_none());
    }

    #[test]
    fn history_alias_exact_server_match_with_conflicting_sender_does_not_inherit_private_fields_or_receipts(
    ) {
        let mut cache = DisplayCache::new();
        cache
            .merge_thread(&ctx(1), "g", vec![alias_confirmed()])
            .unwrap();
        let changed = alias_message(Some("server-self"), None, "customer", "customer", 20);
        let merged = cache.merge_thread(&ctx(1), "g", vec![changed]).unwrap();
        assert_eq!(merged.len(), 1);
        let row = &merged[0];
        assert_eq!(row.sender_id, "customer");
        assert!(row.local_id.is_none());
        assert!(row.original.is_none());
        assert!(row.translation.is_none());
        assert!(row.disposition.is_none());
        assert!(row.sender_name.is_none());
        assert!(row.sender_avatar.is_none());
    }

    #[test]
    fn history_alias_exact_server_match_takes_priority_over_an_incompatible_local_match() {
        let mut cache = DisplayCache::new();
        let customer = alias_message(
            Some("server-customer"),
            Some("local-shared"),
            "customer",
            "customer",
            5,
        );
        let mut own = alias_confirmed();
        own.local_id = None;
        cache
            .merge_thread(&ctx(1), "g", vec![customer, own])
            .unwrap();
        let incoming = alias_message(
            Some("server-self"),
            Some("local-shared"),
            "self",
            "merchant_self",
            20,
        );
        let merged = cache.merge_thread(&ctx(1), "g", vec![incoming]).unwrap();
        assert_eq!(merged.len(), 2);
        assert_eq!(
            merged
                .iter()
                .filter(|m| m.message_id.as_deref() == Some("server-self"))
                .count(),
            1
        );
        assert!(merged.iter().any(
            |m| m.message_id.as_deref() == Some("server-customer") && m.sender_id == "customer"
        ));
    }

    #[test]
    fn history_alias_compatible_bridge_merges_both_groups_and_preserves_valid_confirmation_and_original(
    ) {
        let mut cache = DisplayCache::new();
        let mut server = alias_confirmed();
        server.local_id = None;
        server.original = None;
        server.translation = None;
        let mut pending = alias_message(None, Some("local-shared"), "SELF", "merchant_self", 15);
        pending.original = Some("synthetic pending original".into());
        cache
            .merge_thread(&ctx(1), "g", vec![server, pending])
            .unwrap();
        let bridge = alias_message(
            Some("server-self"),
            Some("local-shared"),
            "self",
            "merchant_self",
            20,
        );
        let merged = cache.merge_thread(&ctx(1), "g", vec![bridge]).unwrap();
        assert_eq!(merged.len(), 1);
        assert_eq!(
            merged[0].original.as_deref(),
            Some("synthetic pending original")
        );
        assert!(
            matches!(&merged[0].disposition, Some(SendDispositionDto::Confirmed { server_message_id, .. }) if server_message_id == "server-self")
        );
    }

    #[test]
    fn history_alias_missing_uid_bridge_cannot_absorb_a_local_group_with_another_known_uid() {
        let mut cache = DisplayCache::new();
        let mut server = alias_message(Some("server-a"), None, "person-a", "merchant_other", 10);
        server.original = Some("synthetic A original".into());
        let pending = alias_message(None, Some("local-shared"), "person-b", "merchant_other", 15);
        cache
            .merge_thread(&ctx(1), "g", vec![server, pending])
            .unwrap();
        let bridge = alias_message(
            Some("server-a"),
            Some("local-shared"),
            "",
            "merchant_other",
            20,
        );
        let merged = cache.merge_thread(&ctx(1), "g", vec![bridge]).unwrap();
        assert_eq!(merged.len(), 2);
        assert!(merged
            .iter()
            .any(|m| m.message_id.is_none() && m.sender_id == "person-b"));
        assert!(merged
            .iter()
            .any(|m| m.message_id.as_deref() == Some("server-a") && m.sender_id == "person-a"));
    }

    #[test]
    fn history_alias_ambiguous_local_only_packet_does_not_choose_one_of_two_incompatible_groups() {
        let mut cache = DisplayCache::new();
        let a = alias_message(
            Some("server-a"),
            Some("local-shared"),
            "person-a",
            "merchant_other",
            10,
        );
        let b = alias_message(
            Some("server-b"),
            Some("local-shared"),
            "person-b",
            "merchant_other",
            15,
        );
        cache.merge_thread(&ctx(1), "g", vec![a, b]).unwrap();
        let ambiguous = alias_message(None, Some("local-shared"), "", "merchant_other", 20);
        let merged = cache.merge_thread(&ctx(1), "g", vec![ambiguous]).unwrap();
        assert_eq!(merged.len(), 3);
        let pending = merged.iter().find(|m| m.message_id.is_none()).unwrap();
        assert!(pending.sender_id.is_empty());
        assert!(pending.original.is_none());
        assert!(pending.disposition.is_none());
    }

    #[test]
    fn history_alias_unidentified_server_anchor_does_not_choose_between_conflicting_local_groups() {
        let mut cache = DisplayCache::new();
        let server = alias_message(Some("server-a"), None, "", "merchant_other", 10);
        let mut a = alias_message(None, Some("local-shared"), "person-a", "merchant_other", 15);
        a.original = Some("synthetic A original".into());
        let b = alias_message(None, Some("local-shared"), "person-b", "merchant_other", 16);
        cache
            .merge_thread(&ctx(1), "g", vec![server, a, b])
            .unwrap();
        let bridge = alias_message(
            Some("server-a"),
            Some("local-shared"),
            "",
            "merchant_other",
            20,
        );
        let merged = cache.merge_thread(&ctx(1), "g", vec![bridge]).unwrap();
        assert_eq!(merged.len(), 3);
        let server = merged
            .iter()
            .find(|m| m.message_id.as_deref() == Some("server-a"))
            .unwrap();
        assert!(server.sender_id.is_empty());
        assert!(server.original.is_none());
        assert!(merged
            .iter()
            .any(|m| m.message_id.is_none() && m.sender_id == "person-a"));
        assert!(merged
            .iter()
            .any(|m| m.message_id.is_none() && m.sender_id == "person-b"));
    }

    #[test]
    fn sender_profile_survives_sparse_receipt_but_never_crosses_identity() {
        let mut old = msg("g", Some("server"), Some("local"), 20, "synthetic");
        old.sender_id = "PERSON-A".into();
        old.sender_name = Some("Person A".into());
        old.sender_avatar = Some("https://example.invalid/person-a.png".into());
        let mut sparse = old.clone();
        sparse.sender_id.clear();
        sparse.sender_name = None;
        sparse.sender_avatar = None;
        let mut thread = vec![old.clone()];
        merge_messages(&mut thread, vec![sparse]);
        assert_eq!(thread[0].sender_avatar, old.sender_avatar);
        assert_eq!(thread[0].sender_id, old.sender_id);
        let mut changed = old.clone();
        changed.sender_id = "person-b".into();
        changed.sender_name = None;
        changed.sender_avatar = None;
        merge_messages(&mut thread, vec![changed]);
        assert_eq!(thread[0].sender_id, "person-b");
        assert_eq!(thread[0].sender_name, None);
        assert_eq!(thread[0].sender_avatar, None);
        let value = serde_json::to_value(&old).unwrap();
        let restored: UiMessageDto = serde_json::from_value(value).unwrap();
        assert_eq!(restored.sender_id, old.sender_id);
        assert_eq!(restored.sender_avatar, old.sender_avatar);
    }

    #[test]
    fn profile_patch_preserves_confirmed_content_and_rejects_cross_identity() {
        let mut cache = DisplayCache::new();
        let mut confirmed = msg(
            "g",
            Some("server"),
            Some("local"),
            20,
            "synthetic confirmed body",
        );
        confirmed.sender_id = "self".into();
        confirmed.sender_role = "merchant_self".into();
        confirmed.original = Some("synthetic original".into());
        confirmed.quote = Some("synthetic quote".into());
        confirmed.disposition = Some(SendDispositionDto::Confirmed {
            server_message_id: "server".into(),
            server_time_ms: 20,
        });
        cache
            .apply(
                &ctx(1),
                DisplayPayload::Messages {
                    gid: "g".into(),
                    replace: false,
                    items: vec![confirmed.clone()],
                },
            )
            .unwrap();
        let patch = |sender: &str, id: &str| serde_json::json!({ "kind": "message_profiles", "gid": "g", "items": [{ "message_id": id, "local_id": "local", "sender_id": sender, "sender_name": "API Self", "sender_avatar": "https://example.invalid/self.png" }] });
        let delta = cache
            .apply(
                &ctx(1),
                serde_json::from_value(patch("self", "server")).unwrap(),
            )
            .unwrap();
        let mut expected = confirmed.clone();
        expected.sender_name = Some("API Self".into());
        expected.sender_avatar = Some("https://example.invalid/self.png".into());
        assert!(
            matches!(delta, DisplayDelta::Messages { changed, .. } if changed == vec![expected.clone()])
        );
        assert!(cache.messages(&ctx(1), "g").unwrap().unwrap() == vec![expected.clone()]);
        for (sender, id) in [("other-person", "server"), ("self", "other-server")] {
            let delta = cache
                .apply(&ctx(1), serde_json::from_value(patch(sender, id)).unwrap())
                .unwrap();
            assert!(matches!(delta, DisplayDelta::Messages { changed, .. } if changed.is_empty()));
        }
        assert!(cache.messages(&ctx(1), "g").unwrap().unwrap() == vec![expected]);
        let mut illegal = patch("self", "server");
        illegal["items"][0]["text"] = "must never replay body".into();
        assert!(serde_json::from_value::<DisplayPayload>(illegal).is_err());
    }

    #[test]
    fn thread_and_message_caps() {
        let mut c = DisplayCache::new();
        let many: Vec<_> = (0..(MAX_MESSAGES_PER_THREAD as i64 + 10))
            .map(|i| msg("g", Some(&format!("m{i}")), None, i, "x"))
            .collect();
        c.replace_thread(&ctx(1), "g", many).expect("replace");
        let t = c.messages(&ctx(1), "g").expect("read").expect("thread");
        assert_eq!(t.len(), MAX_MESSAGES_PER_THREAD);
        assert_eq!(t[0].create_time_ms, 10);
        for i in 0..=MAX_THREADS {
            c.replace_thread(&ctx(1), &format!("t{i}"), vec![])
                .expect("replace");
        }
        assert!(c.messages(&ctx(1), "g").expect("read").is_none());
    }

    #[test]
    fn remove_drops_identity_only_up_to_generation() {
        let mut c = DisplayCache::new();
        c.apply(&ctx(2), convs(true, &[("g1", 1)], &[]))
            .expect("apply");
        c.remove(&ctx(1));
        assert_eq!(c.conversations(&ctx(2)).expect("read").len(), 1);
        c.remove(&ctx(2));
        assert!(c.conversations(&ctx(2)).expect("read").is_empty());
    }

    #[test]
    fn display_payload_json_shapes() {
        let p: DisplayPayload = serde_json::from_value(serde_json::json!({
            "kind": "agent_status", "status": "hangup", "confirmed": true, "status_epoch": 1, "status_seq": 1
        }))
        .expect("parse");
        assert!(matches!(
            p,
            DisplayPayload::AgentStatus {
                status: AgentStatusDto::Hangup,
                confirmed: true,
                ..
            }
        ));
        let p: DisplayPayload = serde_json::from_value(
            serde_json::json!({"kind": "transport", "state": "reconnecting"}),
        )
        .expect("parse");
        assert!(matches!(
            p,
            DisplayPayload::Transport {
                state: TransportDto::Reconnecting
            }
        ));
        let ui = UiConversationDto {
            display: serde_json::from_value(conv_json("g", 1)).expect("parse"),
            account: (&ctx(1)).into(),
            draft: String::new(),
            is_top: true,
            waiting_since_ms: Some(5),
            waiting_confirmed: true,
        };
        let v = serde_json::to_value(&ui).expect("ser");
        for k in [
            "gid",
            "unread_count",
            "title",
            "account",
            "draft",
            "is_top",
            "waiting_since_ms",
            "mark",
            "order",
        ] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
        let net = serde_json::to_value(UiNetStatusDto::offline()).expect("ser");
        assert_eq!(
            net,
            serde_json::json!({"online": false, "transport": "disconnected"})
        );
    }

    #[test]
    fn agent_status_rejects_reverse_ipc_delivery_duplicate_and_old_boot() {
        let mut cache = DisplayCache::new();
        let packet = |epoch, seq, status, confirmed| DisplayPayload::AgentStatus {
            status_epoch: epoch,
            status_seq: seq,
            status,
            confirmed,
        };
        cache
            .apply(&ctx(1), packet(10, 2, AgentStatusDto::Getoff, true))
            .unwrap();
        for (epoch, seq) in [(10, 1), (10, 2), (9, 999), (0, 1), (11, 0)] {
            assert!(cache
                .apply(&ctx(1), packet(epoch, seq, AgentStatusDto::Online, true))
                .is_err());
            assert_eq!(
                cache.agent_status(&ctx(1)).unwrap().status,
                AgentStatusDto::Getoff
            );
        }
        // A watchdog can revoke certainty without forgetting the last cursor.
        cache
            .set_agent_status(
                &ctx(1),
                UiAgentStatusDto {
                    status: AgentStatusDto::Getoff,
                    confirmed: false,
                },
            )
            .unwrap();
        assert!(cache
            .apply(&ctx(1), packet(10, 2, AgentStatusDto::Online, true))
            .is_err());
        assert!(!cache.agent_status(&ctx(1)).unwrap().confirmed);
        cache
            .apply(&ctx(1), packet(11, 1, AgentStatusDto::Hangup, true))
            .unwrap();
        assert!(cache
            .apply(&ctx(1), packet(10, 999, AgentStatusDto::Online, true))
            .is_err());
        // Account generations remain an independent boundary.
        cache
            .apply(&ctx(2), packet(12, 1, AgentStatusDto::Getoff, false))
            .unwrap();
        assert!(cache
            .apply(&ctx(1), packet(13, 1, AgentStatusDto::Online, true))
            .is_err());
    }

    #[test]
    fn pinned_table_persists() {
        let dir = std::env::temp_dir().join(format!("vbk-pinned-{}", std::process::id()));
        let path = dir.join("pinned.json");
        let _ = std::fs::remove_file(&path);
        let mut t = PinnedTable::load(path.clone());
        assert!(t.set(&ctx(1), "g", true).expect("set"));
        assert!(!t.set(&ctx(1), "g", true).expect("set"));
        // Pinning survives a generation change (persistent identity key).
        let t2 = PinnedTable::load(path.clone());
        assert!(t2.is_top(&ctx(5), "g"));
        assert!(!t2.is_top(&other(), "g"));
        assert!(t.set(&ctx(1), "g", false).expect("unset"));
        assert!(!PinnedTable::load(path.clone()).is_top(&ctx(1), "g"));
        let _ = std::fs::remove_dir_all(dir);
    }
    fn read_patches(gid: &str, patches: &[(&str, &str, &str)]) -> DisplayPayload {
        DisplayPayload::MessageReadStatuses {
            gid: gid.into(),
            items: patches
                .iter()
                .map(
                    |(message_id, sender_id, read_status)| MessageReadStatusPatch {
                        message_id: (*message_id).into(),
                        sender_id: (*sender_id).into(),
                        read_status: (*read_status).into(),
                    },
                )
                .collect(),
        }
    }

    #[test]
    fn receipt_patches_match_exact_server_sender_and_scope_and_are_monotonic() {
        let mut cache = DisplayCache::new();
        cache
            .merge_thread(
                &ctx(1),
                "g",
                vec![msg("g", Some("m"), Some("local"), 1, "body")],
            )
            .unwrap();
        cache
            .merge_thread(
                &ctx(1),
                "other",
                vec![msg("other", Some("m"), None, 1, "other body")],
            )
            .unwrap();
        let delta = cache
            .apply(
                &ctx(1),
                read_patches(
                    "g",
                    &[("m", " CUSTOMER ", "unread"), ("m", "customer", "read")],
                ),
            )
            .unwrap();
        assert!(
            matches!(delta, DisplayDelta::MessageReadStatuses { items, .. } if items.len() == 2)
        );
        let cached = cache.messages(&ctx(1), "g").unwrap().unwrap();
        assert_eq!(cached[0].read_status.as_deref(), Some("read"));
        assert_eq!(cached[0].text, "body");
        for patches in [
            vec![("m", "customer", "read")],
            vec![("m", "customer", "unread")],
            vec![("m", "someone-else", "read")],
            vec![("local", "customer", "read")],
            vec![("absent", "customer", "read")],
        ] {
            assert!(
                matches!(cache.apply(&ctx(1), read_patches("g", &patches)).unwrap(), DisplayDelta::MessageReadStatuses { items, .. } if items.len() == patches.len())
            );
            assert!(
                cache.messages(&ctx(1), "g").unwrap().unwrap()[0]
                    .read_status
                    .as_deref()
                    == Some("read")
            );
        }
        assert!(cache.messages(&ctx(1), "other").unwrap().unwrap()[0]
            .read_status
            .is_none());
        assert!(
            matches!(cache.apply(&ctx(1), read_patches("missing-thread", &[("m", "customer", "read")])).unwrap(), DisplayDelta::MessageReadStatuses { gid, items } if gid == "missing-thread" && items.len() == 1)
        );
        assert!(cache.messages(&ctx(1), "missing-thread").unwrap().is_none());
        assert!(cache
            .apply(&ctx(0), read_patches("g", &[("m", "customer", "read")]))
            .is_err());
    }

    #[test]
    fn receipt_for_evicted_history_still_reaches_the_ui_without_creating_a_cache_row() {
        let mut cache = DisplayCache::new();
        let messages = (0..=MAX_MESSAGES_PER_THREAD)
            .map(|i| msg("g", Some(&format!("m-{i}")), None, i as i64, "body"))
            .collect();
        cache.merge_thread(&ctx(1), "g", messages).unwrap();
        assert!(cache
            .messages(&ctx(1), "g")
            .unwrap()
            .unwrap()
            .iter()
            .all(|m| m.message_id.as_deref() != Some("m-0")));
        let delta = cache
            .apply(&ctx(1), read_patches("g", &[("m-0", "customer", "read")]))
            .unwrap();
        assert!(
            matches!(delta, DisplayDelta::MessageReadStatuses { gid, items } if gid == "g" && items.len() == 1 && items[0].message_id == "m-0" && items[0].read_status == "read")
        );
        let cached = cache.messages(&ctx(1), "g").unwrap().unwrap();
        assert_eq!(cached.len(), MAX_MESSAGES_PER_THREAD);
        assert!(cached
            .iter()
            .all(|m| m.message_id.as_deref() != Some("m-0")));
    }

    #[test]
    fn receipt_patch_validation_is_atomic_and_bounded() {
        let mut cache = DisplayCache::new();
        cache
            .merge_thread(&ctx(1), "g", vec![msg("g", Some("m"), None, 1, "body")])
            .unwrap();
        for invalid_patch in [
            ("", "customer", "read"),
            ("m", " ", "read"),
            ("m", "customer", "unknown"),
        ] {
            assert!(cache
                .apply(
                    &ctx(1),
                    read_patches("g", &[("m", "customer", "read"), invalid_patch])
                )
                .is_err());
            assert!(cache.messages(&ctx(1), "g").unwrap().unwrap()[0]
                .read_status
                .is_none());
        }
        assert!(cache.apply(&ctx(1), read_patches(" ", &[])).is_err());
        assert!(cache
            .apply(
                &ctx(1),
                read_patches("g", &vec![("m", "customer", "read"); 2001])
            )
            .is_err());
        let invalid = serde_json::json!({ "kind": "message_read_statuses", "gid": "g", "items": [{ "message_id": "m", "sender_id": "customer", "read_status": true }] });
        assert!(serde_json::from_value::<DisplayPayload>(invalid).is_err());
    }

    #[test]
    fn read_status_survives_late_sparse_history_but_never_crosses_identity() {
        for status in [None, Some("unknown"), Some("unread")] {
            let mut cache = DisplayCache::new();
            let mut old = msg("g", Some("m"), Some("local"), 1, "body");
            old.read_status = Some("read".into());
            cache.merge_thread(&ctx(1), "g", vec![old]).unwrap();
            let mut incoming = msg("g", Some("m"), Some("local"), 1, "updated body");
            incoming.read_status = status.map(Into::into);
            let merged = cache
                .merge_thread(&ctx(1), "g", vec![incoming.clone()])
                .unwrap();
            assert_eq!(merged[0].read_status.as_deref(), Some("read"));
            assert_eq!(merged[0].text, "updated body");
            incoming.sender_id = "other-customer".into();
            let merged = cache.merge_thread(&ctx(1), "g", vec![incoming]).unwrap();
            assert_eq!(merged[0].read_status.as_deref(), status);
        }
        let mut old = msg("g", Some("m"), Some("local"), 1, "body");
        old.read_status = Some("read".into());
        let mut thread = vec![old];
        merge_messages(
            &mut thread,
            vec![msg("g", None, Some("local"), 1, "sparse local")],
        );
        assert!(
            thread[0].read_status.is_none(),
            "local alias alone is not receipt authority"
        );
    }

    // Frozen pre-index implementation is an oracle for identity/alias semantics.
    fn reference_merge_messages(
        thread: &mut Vec<UiMessageDto>,
        incoming: Vec<UiMessageDto>,
    ) -> Vec<UiMessageDto> {
        let mut changed = Vec::new();
        for mut m in incoming {
            let mut selected: Vec<usize> = thread
                .iter()
                .enumerate()
                .filter_map(|(index, old)| {
                    (old.gid == m.gid
                        && matches!(
                            (known_message_id(&old.message_id), known_message_id(&m.message_id)),
                            (Some(old_id), Some(new_id)) if old_id == new_id
                        ))
                    .then_some(index)
                })
                .collect();
            let aliases: Vec<usize> = thread
                .iter()
                .enumerate()
                .filter_map(|(index, old)| {
                    (!selected.contains(&index)
                        && same_message(old, &m)
                        && compatible_alias_group(old, &m))
                    .then_some(index)
                })
                .collect();
            if selected.is_empty() {
                // A missing UID can match several known UIDs independently. It
                // cannot choose a group or bridge those incompatible identities.
                if aliases.iter().all(|a| {
                    aliases
                        .iter()
                        .all(|b| compatible_alias_group(&thread[*a], &thread[*b]))
                }) {
                    selected = aliases;
                }
            } else {
                let aliases: Vec<usize> = aliases
                    .into_iter()
                    .filter(|index| {
                        selected
                            .iter()
                            .all(|old| compatible_alias_group(&thread[*old], &thread[*index]))
                    })
                    .collect();
                // A server anchor with no known UID does not identify which of
                // several conflicting local groups owns that server message.
                if aliases.iter().all(|a| {
                    aliases
                        .iter()
                        .all(|b| compatible_alias_group(&thread[*a], &thread[*b]))
                }) {
                    selected.extend(aliases);
                }
            }
            if selected.is_empty() {
                thread.push(m.clone());
                changed.push(m);
                continue;
            }
            // Exact server IDs may correct an explicit sender conflict. Keep the
            // incoming record, but inherit nothing from the conflicting identity.
            let can_inherit = selected.iter().all(|a| {
                compatible_alias_group(&thread[*a], &m)
                    && selected
                        .iter()
                        .all(|b| compatible_alias_group(&thread[*a], &thread[*b]))
            });
            if can_inherit {
                for index in &selected {
                    preserve_read_status(&thread[*index], &mut m);
                }
                for index in &selected {
                    let old = &thread[*index];
                    if known_message_id(&m.message_id).is_none() {
                        m.message_id = old.message_id.clone();
                    }
                    if known_message_id(&m.local_id).is_none() {
                        m.local_id = old.local_id.clone();
                    }
                    m.original = m.original.or_else(|| old.original.clone());
                    m.translation = m.translation.or_else(|| old.translation.clone());
                    if !old.sender_id.trim().is_empty() {
                        m.sender_name = m.sender_name.or_else(|| old.sender_name.clone());
                        m.sender_avatar = m.sender_avatar.or_else(|| old.sender_avatar.clone());
                        if m.sender_id.trim().is_empty() {
                            m.sender_id = old.sender_id.clone();
                        }
                    }
                }
                let server_id = known_message_id(&m.message_id);
                if !matching_confirmation(&m, server_id) {
                    if let Some(old) = selected
                        .iter()
                        .map(|index| &thread[*index])
                        .find(|old| matching_confirmation(old, server_id))
                    {
                        m.disposition = old.disposition.clone();
                    } else if m.disposition.is_none() {
                        m.disposition =
                            selected
                                .iter()
                                .find_map(|index| match &thread[*index].disposition {
                                    Some(SendDispositionDto::Confirmed { .. }) => None,
                                    disposition => disposition.clone(),
                                });
                    }
                }
            }
            // A confirmation must always refer to this canonical server message.
            if matches!(&m.disposition, Some(SendDispositionDto::Confirmed { .. }))
                && !matching_confirmation(&m, known_message_id(&m.message_id))
            {
                m.disposition = Some(SendDispositionDto::Unknown);
            }
            selected.sort_unstable();
            let first = selected[0];
            let was_changed = selected.len() > 1 || thread[first] != m;
            for index in selected.into_iter().skip(1).rev() {
                thread.remove(index);
            }
            thread[first] = m.clone();
            if was_changed {
                changed.push(m);
            }
        }
        thread.sort_by_key(|m| m.create_time_ms);
        if thread.len() > MAX_MESSAGES_PER_THREAD {
            let drop = thread.len() - MAX_MESSAGES_PER_THREAD;
            thread.drain(..drop);
        }
        changed.sort_by_key(|m| m.create_time_ms);
        changed
    }

    #[test]
    fn indexed_merge_matches_reference_across_alias_conflicts_and_batches() {
        let mut seed = 0x52dce729u64;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            (seed >> 32) as u32
        };
        let mut indexed = Vec::new();
        let mut reference = Vec::new();
        for batch in 0..150 {
            let incoming: Vec<_> = (0..24)
                .map(|_| {
                    let server = next() % 24;
                    let local = next() % 20;
                    let mut message = msg("g", None, None, i64::from(next() % 100), "body");
                    message.message_id = (server > 3).then(|| format!("s{server}"));
                    message.local_id = (local > 2).then(|| format!("l{local}"));
                    message.sender_id = ["", "Alice", "alice", "Bob"][(next() % 4) as usize].into();
                    message.sender_role = ["customer", "agent"][(next() % 2) as usize].into();
                    message.text = format!("content-{}", next() % 4);
                    if next() % 3 == 0 {
                        message.disposition = Some(SendDispositionDto::Unknown);
                    }
                    message
                })
                .collect();
            let expected = reference_merge_messages(&mut reference, incoming.clone());
            let actual = merge_messages(&mut indexed, incoming);
            assert!(
                actual == expected,
                "changed messages differ in batch {batch}"
            );
            assert!(
                indexed == reference,
                "cached messages differ in batch {batch}"
            );
        }
    }

    #[test]
    fn indexed_replace_preserves_exact_full_object_equality() {
        let mut cache = DisplayCache::new();
        let account = ctx(1);
        let old = vec![
            msg("g", Some("s1"), Some("l1"), 1, "same"),
            msg("g", Some("s2"), None, 2, "old"),
            msg("g", None, None, 3, "anonymous"),
            msg("g", Some(""), Some(""), 4, "blank"),
        ];
        cache.replace_thread(&account, "g", old.clone()).unwrap();
        let incoming = vec![
            old[0].clone(),
            msg("g", Some("s2"), None, 2, "new"),
            old[2].clone(),
            old[3].clone(),
            msg("g", Some("s3"), Some("l3"), 5, "added"),
        ];
        let mut fresh = Vec::new();
        reference_merge_messages(&mut fresh, incoming.clone());
        let expected: Vec<_> = fresh
            .iter()
            .filter(|m| !old.iter().any(|o| o == *m))
            .cloned()
            .collect();
        let delta = cache
            .apply(
                &account,
                DisplayPayload::Messages {
                    gid: "g".into(),
                    replace: true,
                    items: incoming,
                },
            )
            .unwrap();
        let DisplayDelta::Messages { changed, .. } = delta else {
            panic!("message delta")
        };
        assert!(
            changed == expected,
            "replace changed-message equality differs"
        );
        assert!(
            cache.messages(&account, "g").unwrap() == Some(fresh),
            "replace cached-message equality differs"
        );
    }

    #[test]
    fn unread_aggregate_excludes_rows_rejected_at_conversation_cap() {
        let mut cache = DisplayCache::new();
        let account = ctx(1);
        for i in 0..=MAX_CONVERSATIONS {
            cache
                .apply(
                    &account,
                    convs(false, &[(format!("g{i}").as_str(), 2)], &[]),
                )
                .unwrap();
        }
        assert_eq!(cache.total_unread(&account), (MAX_CONVERSATIONS * 2) as u32);
        assert_eq!(
            cache.conversations(&account).unwrap().len(),
            MAX_CONVERSATIONS
        );
        cache
            .apply(&account, convs(false, &[("g0", 9)], &[]))
            .unwrap();
        assert_eq!(
            cache.total_unread(&account),
            (MAX_CONVERSATIONS * 2 + 7) as u32
        );
    }

    #[test]
    fn indexed_merge_large_unique_batch_visits_only_matching_candidates() {
        let mut thread = Vec::new();
        let items: Vec<_> = (0..5_000)
            .map(|i| {
                msg(
                    "g",
                    Some(&format!("s{i}")),
                    Some(&format!("l{i}")),
                    i,
                    "body",
                )
            })
            .collect();
        let mut candidates = 0;
        let changed = merge_messages_indexed(&mut thread, items, |count| candidates += count);
        assert_eq!(changed.len(), 5_000);
        assert_eq!(thread.len(), MAX_MESSAGES_PER_THREAD);
        assert_eq!(thread[0].create_time_ms, 4_500);
        assert_eq!(
            candidates, 0,
            "unique identities must not scan unrelated slots"
        );
        let replay = thread.clone();
        let mut candidates = 0;
        let changed = merge_messages_indexed(&mut thread, replay, |count| candidates += count);
        assert!(changed.is_empty());
        assert_eq!(candidates, MAX_MESSAGES_PER_THREAD * 2);
    }

    #[test]
    fn unread_aggregate_matches_scan_after_full_increment_remove_and_reset() {
        let mut cache = DisplayCache::new();
        let a = ctx(1);
        cache
            .apply(
                &a,
                convs(true, &[("a", u32::MAX), ("b", u32::MAX), ("c", 5)], &[]),
            )
            .unwrap();
        assert_eq!(cache.total_unread(&a), u32::MAX);
        cache.apply(&a, convs(false, &[], &["a"])).unwrap();
        assert_eq!(cache.total_unread(&a), u32::MAX);
        cache.apply(&a, convs(false, &[], &["b", "b"])).unwrap();
        assert_eq!(cache.total_unread(&a), 5);
        for i in 0..100u32 {
            let gid = format!("g{}", i % 17);
            let removed = format!("g{}", (i + 5) % 17);
            cache
                .apply(
                    &a,
                    convs(
                        i % 11 == 0,
                        &[(gid.as_str(), i.saturating_mul(50_000_000))],
                        &[removed.as_str()],
                    ),
                )
                .unwrap();
            let expected: u64 = cache
                .conversations(&a)
                .unwrap()
                .iter()
                .map(|c| u64::from(c.fact.unread_count))
                .sum();
            assert_eq!(
                cache.total_unread(&a),
                u32::try_from(expected).unwrap_or(u32::MAX)
            );
        }
        let b = other();
        cache.apply(&b, convs(true, &[("other", 9)], &[])).unwrap();
        cache
            .apply(&ctx(2), convs(false, &[("new", 3)], &[]))
            .unwrap();
        assert_eq!(cache.total_unread(&ctx(2)), 3);
        assert_eq!(cache.total_unread(&a), 0);
        assert_eq!(cache.total_unread(&b), 9);
        cache.remove(&ctx(2));
        assert_eq!(cache.total_unread(&ctx(2)), 0);
    }
}

// Peripheral command results (client.ts). Display-only, never persisted.
#[derive(Clone, Serialize, Deserialize)]
pub struct UiMemberDto {
    #[serde(default)]
    pub avatar: Option<String>,
    pub uid: String,
    pub nickname: Option<String>,
    pub status: String,
    pub roles: Vec<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub present: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_self: Option<bool>,
    pub can_transfer: bool,
    #[serde(default)]
    pub can_remove: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UiMessageTranslationDto {
    pub message_id: String,
    pub status: String,
    #[serde(default)]
    pub translation: Option<String>,
    #[serde(default)]
    pub source_kind: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct UiMessageTranslationsDto {
    pub items: Vec<UiMessageTranslationDto>,
    #[serde(default)]
    pub supplier: Option<String>,
    #[serde(default)]
    pub session_tag: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct UiMembersDto {
    pub members: Vec<UiMemberDto>,
    #[serde(default)]
    pub self_is_master: bool,
    pub fetched_at_ms: i64,
    pub selection_token: String,
    pub expires_at_ms: i64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct UiSkillGroupDto {
    pub skill_group_id: u64,
    pub name: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct UiInviteAgentDto {
    #[serde(default)]
    pub avatar: Option<String>,
    pub uid: String,
    pub nickname: Option<String>,
    #[serde(default)]
    pub in_group: bool,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub duty_status: Option<u16>,
    #[serde(default)]
    pub job_position: Option<String>,
    #[serde(default)]
    pub job_position_type: Option<u16>,
    #[serde(default)]
    pub skill_group_full_name: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct UiInviteCandidatesDto {
    pub selection_token: String,
    pub expires_at_ms: i64,
    pub skill_groups: Vec<UiSkillGroupDto>,
    pub agents: Vec<UiInviteAgentDto>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomerScriptsKindDto {
    Ready,
    Empty,
    Unsupported,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum QuickReplyCategoryTypeDto {
    VAGENT,
    VSKILLGROUP,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct UiQuickReplyScriptDto {
    pub id: String,
    pub content: String,
    pub short_cut: String,
    pub r#type: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct UiCustomerScriptsDto {
    pub kind: CustomerScriptsKindDto,
    pub raw_count: u64,
    #[serde(default)]
    pub items: Vec<UiQuickReplyScriptDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeripheralWriteKindDto {
    Confirmed,
    Accepted,
    Unknown,
    NotSubmitted,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct UiPeripheralWriteDto {
    pub kind: PeripheralWriteKindDto,
    pub confirmed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// ------------------------------------------------- quick-reply management (I-26)
//
// Bounds mirror `validateEdit` in `web-adapter/src/quick-reply-manage.ts`; both
// sides count UTF-16 units so a value accepted here is accepted by the page.

/// Category name cap after trimming (`CATEGORY_NAME_MAX`).
pub const QUICK_REPLY_NAME_MAX: usize = 15;
/// Script content cap, untrimmed (`SCRIPT_CONTENT_MAX`, same as the send cap).
pub const QUICK_REPLY_CONTENT_MAX: usize = 5_000;
/// Any ID list (`ID_LIST_MAX`).
pub const QUICK_REPLY_ID_LIST_MAX: usize = 1_000;
/// Skill groups in one manage-info reply (`parseSkillGroups` keeps 200).
pub const QUICK_REPLY_SKILL_GROUPS_MAX: usize = 200;
/// Skill group display name in a manage-info reply.
pub const QUICK_REPLY_SKILL_GROUP_NAME_MAX: usize = 256;
/// Top-level categories echoed with one edit result.
pub const QUICK_REPLY_RESULT_CATEGORIES_MAX: usize = 1_000;
/// Serialized size of the categories echoed with one edit result.
pub const QUICK_REPLY_RESULT_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Server error code carried as `detail` of a business refusal.
const QUICK_REPLY_DETAIL_MAX: usize = 64;

/// One quick-reply write (`UiQuickReplyEdit`, client.ts): nine fixed shapes,
/// nothing else. No `Debug`: script content is merchant text.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum QuickReplyEditDto {
    CreateCategory {
        name: String,
        skill_group_ids: Vec<String>,
    },
    UpdateCategory {
        category_id: String,
        name: String,
        skill_group_ids: Vec<String>,
    },
    DeleteCategory {
        category_id: String,
    },
    SortCategories {
        category_ids: Vec<String>,
    },
    AddScript {
        category_id: String,
        content: String,
    },
    UpdateScript {
        script_id: String,
        content: String,
    },
    MoveScript {
        script_id: String,
        target_category_id: String,
    },
    DeleteScript {
        script_id: String,
    },
    SortScripts {
        category_id: String,
        script_ids: Vec<String>,
    },
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `String.prototype.trim`: JS strips U+FEFF but not U+0085, Rust's `trim` the opposite.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// `^\d{1,19}$` with ASCII digits, the adapter's `ID_RE`.
pub fn is_quick_reply_id(s: &str) -> bool {
    (1..=19).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

fn quick_reply_ids_valid(ids: &[String]) -> bool {
    ids.len() <= QUICK_REPLY_ID_LIST_MAX
        && ids.iter().all(|id| is_quick_reply_id(id))
        && ids.iter().collect::<BTreeSet<_>>().len() == ids.len()
}

impl QuickReplyEditDto {
    /// Bounded check run before the adapter is contacted.
    pub fn is_valid_for(&self, kind: QuickReplyCategoryTypeDto) -> bool {
        let id = |s: &String| is_quick_reply_id(s);
        let order = |ids: &Vec<String>| !ids.is_empty() && quick_reply_ids_valid(ids);
        let name = |s: &String| {
            let t = js_trim(s);
            !t.is_empty() && utf16_len(t) <= QUICK_REPLY_NAME_MAX
        };
        let content =
            |s: &String| !js_trim(s).is_empty() && utf16_len(s) <= QUICK_REPLY_CONTENT_MAX;
        let groups = |ids: &Vec<String>| {
            quick_reply_ids_valid(ids)
                && match kind {
                    QuickReplyCategoryTypeDto::VAGENT => ids.is_empty(),
                    QuickReplyCategoryTypeDto::VSKILLGROUP => !ids.is_empty(),
                }
        };
        match self {
            Self::CreateCategory {
                name: n,
                skill_group_ids,
            } => name(n) && groups(skill_group_ids),
            Self::UpdateCategory {
                category_id,
                name: n,
                skill_group_ids,
            } => id(category_id) && name(n) && groups(skill_group_ids),
            Self::DeleteCategory { category_id } => id(category_id),
            Self::SortCategories { category_ids } => order(category_ids),
            Self::AddScript {
                category_id,
                content: c,
            } => id(category_id) && content(c),
            Self::UpdateScript {
                script_id,
                content: c,
            } => id(script_id) && content(c),
            Self::MoveScript {
                script_id,
                target_category_id,
            } => id(script_id) && id(target_category_id),
            Self::DeleteScript { script_id } => id(script_id),
            Self::SortScripts {
                category_id,
                script_ids,
            } => id(category_id) && order(script_ids),
        }
    }
}

/// UI `{type, edit}` → typed request; `None` when either is not an allowed
/// shape (answered `rejected/invalid`, the adapter is never contacted).
pub fn quick_reply_edit_request(
    r#type: serde_json::Value,
    edit: serde_json::Value,
) -> Option<(QuickReplyCategoryTypeDto, QuickReplyEditDto)> {
    let kind: QuickReplyCategoryTypeDto = serde_json::from_value(r#type).ok()?;
    let edit: QuickReplyEditDto = serde_json::from_value(edit).ok()?;
    edit.is_valid_for(kind).then_some((kind, edit))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuickReplyEditKindDto {
    Applied,
    Rejected,
    Unknown,
}

/// `UiQuickReplyEditReason` (client.ts).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuickReplyEditReasonDto {
    Invalid,
    Stale,
    NotLeader,
    Busy,
    NotSubmitted,
    Auth,
    Business,
    WriteUnknown,
    ReadbackFailed,
    Unverified,
}

/// `UiQuickReplyEditResult` (client.ts). `categories` is the page's read-back,
/// passed through unparsed; a result the host synthesizes never carries one,
/// so the UI reads the list again.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiQuickReplyEditResultDto {
    pub kind: QuickReplyEditKindDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<QuickReplyEditReasonDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub categories: Option<serde_json::Value>,
}

/// Counts serialized bytes without buffering them; fails past the budget.
struct ByteBudget(usize);

impl std::io::Write for ByteBudget {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_sub(buf.len())
            .ok_or_else(|| std::io::Error::other("over budget"))?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The echoed list must be an array of objects; anything else is a malformed reply.
fn quick_reply_categories_shaped(v: &serde_json::Value) -> bool {
    v.as_array()
        .is_some_and(|list| list.iter().all(serde_json::Value::is_object))
}

/// A well-shaped list that is too large to forward.
fn quick_reply_categories_bounded(v: &serde_json::Value) -> bool {
    v.as_array()
        .is_some_and(|list| list.len() <= QUICK_REPLY_RESULT_CATEGORIES_MAX)
        && serde_json::to_writer(ByteBudget(QUICK_REPLY_RESULT_MAX_BYTES), v).is_ok()
}

fn quick_reply_detail_bounded(d: &str) -> bool {
    !d.is_empty()
        && d.len() <= QUICK_REPLY_DETAIL_MAX
        && d.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}

impl UiQuickReplyEditResultDto {
    fn bare(kind: QuickReplyEditKindDto, reason: QuickReplyEditReasonDto) -> Self {
        Self {
            kind,
            reason: Some(reason),
            detail: None,
            categories: None,
        }
    }

    /// Local validation failed; nothing was sent.
    pub fn invalid() -> Self {
        Self::bare(
            QuickReplyEditKindDto::Rejected,
            QuickReplyEditReasonDto::Invalid,
        )
    }

    /// The request may have reached the page but no trustworthy answer came
    /// back: read back, never resend.
    pub fn write_unknown() -> Self {
        Self::bare(
            QuickReplyEditKindDto::Unknown,
            QuickReplyEditReasonDto::WriteUnknown,
        )
    }

    /// Accepts only the combinations `editQuickReplies` produces; `None` for
    /// anything else. An out-of-bounds error code is dropped, not trusted.
    pub fn from_reply(v: serde_json::Value) -> Option<Self> {
        use QuickReplyEditKindDto as K;
        use QuickReplyEditReasonDto as R;
        let mut r: Self = serde_json::from_value(v).ok()?;
        let combination = matches!(
            (r.kind, r.reason),
            (K::Applied, None)
                | (
                    K::Rejected,
                    Some(
                        R::Invalid
                            | R::Stale
                            | R::NotLeader
                            | R::Busy
                            | R::NotSubmitted
                            | R::Auth
                            | R::Business
                    ),
                )
                | (
                    K::Unknown,
                    Some(R::WriteUnknown | R::ReadbackFailed | R::Unverified)
                )
        );
        if !combination || (r.detail.is_some() && r.reason != Some(R::Business)) {
            return None;
        }
        if r.categories
            .as_ref()
            .is_some_and(|c| !quick_reply_categories_shaped(c))
        {
            return None;
        }
        // An oversized list does not make the outcome untrustworthy: drop the list and
        // let the UI read again.
        if r.categories
            .as_ref()
            .is_some_and(|c| !quick_reply_categories_bounded(c))
        {
            r.categories = None;
        }
        if r.detail
            .as_deref()
            .is_some_and(|d| !quick_reply_detail_bounded(d))
        {
            r.detail = None;
        }
        Some(r)
    }

    /// The session generation changed while the request was out: the outcome
    /// belongs to a session the UI no longer shows, so it is never final.
    pub fn after_generation_change(self) -> Self {
        match (self.kind, self.reason) {
            (QuickReplyEditKindDto::Unknown, Some(reason)) => {
                Self::bare(QuickReplyEditKindDto::Unknown, reason)
            }
            _ => Self::write_unknown(),
        }
    }
}

/// `UiQuickReplySkillGroup` (client.ts).
#[derive(Clone, Serialize, Deserialize)]
pub struct UiQuickReplySkillGroupDto {
    pub id: String,
    pub name: String,
}

/// `UiQuickReplyManageInfo` (client.ts).
#[derive(Clone, Serialize, Deserialize)]
pub struct UiQuickReplyManageInfoDto {
    pub can_edit: bool,
    pub skill_groups: Vec<UiQuickReplySkillGroupDto>,
}

impl UiQuickReplyManageInfoDto {
    /// Shape check of the page reply; `None` when it is not the bounded shape.
    pub fn from_reply(v: serde_json::Value) -> Option<Self> {
        let mut info: Self = serde_json::from_value(v).ok()?;
        if info.skill_groups.len() > QUICK_REPLY_SKILL_GROUPS_MAX {
            return None;
        }
        // One odd row must not lock the whole team form: drop it, keep the rest.
        info.skill_groups.retain(|g| {
            is_quick_reply_id(&g.id) && utf16_len(&g.name) <= QUICK_REPLY_SKILL_GROUP_NAME_MAX
        });
        Some(info)
    }
}

#[cfg(test)]
mod quick_reply_manage_tests {
    use super::*;
    use serde_json::{json, Value};

    const P: QuickReplyCategoryTypeDto = QuickReplyCategoryTypeDto::VAGENT;
    const T: QuickReplyCategoryTypeDto = QuickReplyCategoryTypeDto::VSKILLGROUP;

    fn ok(kind: QuickReplyCategoryTypeDto, edit: Value) -> bool {
        let tag = match kind {
            QuickReplyCategoryTypeDto::VAGENT => json!("VAGENT"),
            QuickReplyCategoryTypeDto::VSKILLGROUP => json!("VSKILLGROUP"),
        };
        quick_reply_edit_request(tag, edit).is_some()
    }
    fn ids(n: usize) -> Vec<String> {
        (1..=n).map(|i| i.to_string()).collect()
    }
    fn valid_edits() -> Vec<(QuickReplyCategoryTypeDto, Value)> {
        vec![
            (
                P,
                json!({"op":"create_category","name":"Synthetic","skill_group_ids":[]}),
            ),
            (
                T,
                json!({"op":"create_category","name":"Synthetic","skill_group_ids":["11","12"]}),
            ),
            (
                P,
                json!({"op":"update_category","category_id":"1","name":"Synthetic","skill_group_ids":[]}),
            ),
            (
                T,
                json!({"op":"update_category","category_id":"1","name":"Synthetic","skill_group_ids":["11"]}),
            ),
            (
                P,
                json!({"op":"delete_category","category_id":"9223372036854775807"}),
            ),
            (
                P,
                json!({"op":"sort_categories","category_ids":["3","1","2"]}),
            ),
            (
                P,
                json!({"op":"add_script","category_id":"1","content":"Synthetic reply"}),
            ),
            (
                P,
                json!({"op":"update_script","script_id":"2","content":"Synthetic reply"}),
            ),
            (
                P,
                json!({"op":"move_script","script_id":"2","target_category_id":"3"}),
            ),
            (P, json!({"op":"delete_script","script_id":"2"})),
            (
                T,
                json!({"op":"sort_scripts","category_id":"1","script_ids":["5","4"]}),
            ),
        ]
    }

    #[test]
    fn every_variant_accepts_its_exact_shape_and_round_trips() {
        let mut ops = BTreeSet::new();
        for (kind, edit) in valid_edits() {
            let tag = if kind == P { "VAGENT" } else { "VSKILLGROUP" };
            let (k, dto) = quick_reply_edit_request(json!(tag), edit.clone()).expect("valid edit");
            assert!(k == kind);
            assert_eq!(serde_json::to_value(dto).unwrap(), edit);
            ops.insert(edit["op"].as_str().unwrap().to_owned());
        }
        assert_eq!(ops.len(), 9, "all nine variants covered");
    }

    #[test]
    fn unknown_op_extra_missing_or_mistyped_fields_are_invalid() {
        for (kind, edit) in valid_edits() {
            let mut extra = edit.clone();
            extra["unexpected"] = json!("x");
            assert!(!ok(kind, extra), "extra field: {edit}");
            let Value::Object(map) = &edit else {
                unreachable!()
            };
            for key in map.keys().filter(|k| *k != "op") {
                let mut missing = edit.clone();
                missing.as_object_mut().unwrap().remove(key);
                assert!(!ok(kind, missing), "missing {key}: {edit}");
                let mut mistyped = edit.clone();
                mistyped[key] = json!(1);
                assert!(!ok(kind, mistyped), "mistyped {key}: {edit}");
            }
        }
        for edit in [
            json!({"op":"rename_category","category_id":"1"}),
            json!({"op":"CreateCategory","name":"Synthetic","skill_group_ids":[]}),
            json!({"category_id":"1"}),
            json!(null),
            json!("delete_category"),
            json!([{"op":"delete_category","category_id":"1"}]),
        ] {
            assert!(!ok(P, edit.clone()), "{edit}");
        }
    }

    #[test]
    fn type_is_only_personal_or_team() {
        let edit = json!({"op":"delete_script","script_id":"2"});
        for tag in [json!("VAGENT"), json!("VSKILLGROUP")] {
            assert!(quick_reply_edit_request(tag, edit.clone()).is_some());
        }
        for tag in [
            json!("vagent"),
            json!("VSKILL"),
            json!(""),
            json!(null),
            json!(1),
            json!(["VAGENT"]),
        ] {
            assert!(
                quick_reply_edit_request(tag.clone(), edit.clone()).is_none(),
                "{tag}"
            );
        }
    }

    #[test]
    fn ids_are_one_to_nineteen_ascii_digits() {
        let delete = |id: &str| ok(P, json!({"op":"delete_script","script_id":id}));
        assert!(delete("0") && delete("1") && delete(&"9".repeat(19)));
        for bad in [
            "",
            &"9".repeat(20),
            "12a",
            "-1",
            " 1",
            "1 ",
            "1.0",
            "\u{ff11}",
            "\u{0661}",
            "1\n",
        ] {
            assert!(!delete(bad), "{bad:?}");
        }
        for (kind, edit) in valid_edits() {
            for key in ["category_id", "script_id", "target_category_id"] {
                if edit.get(key).is_some() {
                    let mut bad = edit.clone();
                    bad[key] = json!("x1");
                    assert!(!ok(kind, bad), "{key}: {edit}");
                }
            }
        }
    }

    #[test]
    fn names_trim_like_js_and_count_utf16_units() {
        let create = |name: &str| {
            ok(
                P,
                json!({"op":"create_category","name":name,"skill_group_ids":[]}),
            )
        };
        let update = |name: &str| {
            ok(
                P,
                json!({"op":"update_category","category_id":"1","name":name,"skill_group_ids":[]}),
            )
        };
        let cjk15 = "\u{5206}".repeat(15);
        for name in [cjk15.as_str(), "a", " \u{3000}Synthetic\t\n", "\u{85}"] {
            assert!(create(name) && update(name), "{name:?}");
        }
        assert!(
            create(&format!("  {cjk15}\u{feff} ")),
            "surrounding whitespace is trimmed first"
        );
        // Seven astral characters (14 units) plus one BMP character is 15 units.
        assert!(create(&format!("{}x", "\u{1f600}".repeat(7))));
        for name in [
            "\u{5206}".repeat(16),
            "\u{1f600}".repeat(8),
            String::new(),
            " \t\n\u{3000}\u{a0}\u{2028}".into(),
            "\u{feff}".into(),
        ] {
            assert!(!create(&name) && !update(&name), "{name:?}");
        }
    }

    #[test]
    fn content_is_non_blank_and_at_most_5000_raw_units() {
        let add = |content: &str| {
            ok(
                P,
                json!({"op":"add_script","category_id":"1","content":content}),
            )
        };
        let upd = |content: &str| {
            ok(
                P,
                json!({"op":"update_script","script_id":"1","content":content}),
            )
        };
        let max = "\u{8bdd}".repeat(QUICK_REPLY_CONTENT_MAX);
        assert!(add(&max) && upd(&max) && add("x"));
        assert!(add(&format!(
            "{}\u{1f600}",
            "x".repeat(QUICK_REPLY_CONTENT_MAX - 2)
        )));
        for content in [
            "x".repeat(QUICK_REPLY_CONTENT_MAX + 1),
            format!("{}\u{1f600}", "x".repeat(QUICK_REPLY_CONTENT_MAX - 1)),
            // The raw length counts, not the trimmed one.
            format!(" {}", "x".repeat(QUICK_REPLY_CONTENT_MAX)),
            String::new(),
            " \n\t\u{3000}".into(),
            "\u{feff}".into(),
        ] {
            assert!(
                !add(&content) && !upd(&content),
                "{} units",
                utf16_len(&content)
            );
        }
    }

    #[test]
    fn sort_lists_are_non_empty_unique_and_bounded() {
        let cats = |list: Vec<String>| ok(P, json!({"op":"sort_categories","category_ids":list}));
        let scripts = |list: Vec<String>| {
            ok(
                P,
                json!({"op":"sort_scripts","category_id":"1","script_ids":list}),
            )
        };
        for check in [&cats as &dyn Fn(Vec<String>) -> bool, &scripts] {
            assert!(check(ids(1)) && check(ids(QUICK_REPLY_ID_LIST_MAX)));
            assert!(!check(Vec::new()));
            assert!(!check(ids(QUICK_REPLY_ID_LIST_MAX + 1)));
            assert!(!check(vec!["1".into(), "2".into(), "1".into()]));
            assert!(!check(vec!["1".into(), "x".into()]));
        }
    }

    #[test]
    fn skill_groups_are_empty_for_personal_and_required_unique_for_team() {
        for op in ["create", "update"] {
            let edit = |groups: Vec<String>| {
                let mut v = json!({"op":format!("{op}_category"),"name":"Synthetic","skill_group_ids":groups});
                if op == "update" {
                    v["category_id"] = json!("1");
                }
                v
            };
            assert!(ok(P, edit(Vec::new())));
            assert!(
                !ok(P, edit(ids(1))),
                "{op}: personal categories carry no groups"
            );
            assert!(
                !ok(T, edit(Vec::new())),
                "{op}: team categories need a group"
            );
            assert!(ok(T, edit(ids(QUICK_REPLY_ID_LIST_MAX))));
            assert!(!ok(T, edit(ids(QUICK_REPLY_ID_LIST_MAX + 1))));
            assert!(!ok(T, edit(vec!["11".into(), "11".into()])));
            assert!(!ok(T, edit(vec!["sg-1".into()])));
        }
    }

    fn reply(v: Value) -> Option<UiQuickReplyEditResultDto> {
        UiQuickReplyEditResultDto::from_reply(v)
    }

    #[test]
    fn edit_results_accept_only_adapter_combinations() {
        let cats = json!([{"id":"1","name":"Synthetic","scripts":[],"sub_categories":[]}]);
        let applied = reply(json!({"kind":"applied","categories":cats})).expect("applied");
        assert_eq!(applied.kind, QuickReplyEditKindDto::Applied);
        assert_eq!(
            serde_json::to_value(&applied).unwrap(),
            json!({"kind":"applied","categories":cats})
        );
        for reason in [
            "invalid",
            "stale",
            "not_leader",
            "busy",
            "not_submitted",
            "auth",
            "business",
        ] {
            let r = reply(json!({"kind":"rejected","reason":reason})).expect(reason);
            assert_eq!(
                serde_json::to_value(&r).unwrap(),
                json!({"kind":"rejected","reason":reason})
            );
        }
        for reason in ["write_unknown", "readback_failed", "unverified"] {
            assert!(
                reply(json!({"kind":"unknown","reason":reason})).is_some(),
                "{reason}"
            );
            assert!(reply(json!({"kind":"unknown","reason":reason,"categories":cats})).is_some());
        }
        let business =
            reply(json!({"kind":"rejected","reason":"business","detail":"ERR_SYNTHETIC-1"}))
                .unwrap();
        assert_eq!(business.detail.as_deref(), Some("ERR_SYNTHETIC-1"));
        for detail in [
            json!(""),
            json!("x".repeat(65)),
            json!("bad code"),
            json!("\u{9519}"),
        ] {
            let r = reply(json!({"kind":"rejected","reason":"business","detail":detail}))
                .expect("detail dropped");
            assert!(r.detail.is_none(), "{detail}");
        }
        for bad in [
            json!({"kind":"applied","reason":"business"}),
            json!({"kind":"applied","detail":"E1"}),
            json!({"kind":"rejected"}),
            json!({"kind":"rejected","reason":"write_unknown"}),
            json!({"kind":"rejected","reason":"stale","detail":"E1"}),
            json!({"kind":"unknown"}),
            json!({"kind":"unknown","reason":"invalid"}),
            json!({"kind":"unknown","reason":"unverified","detail":"E1"}),
            json!({"kind":"unknown","reason":"other"}),
            json!({"kind":"confirmed"}),
            json!({"kind":"applied","categories":cats,"extra":true}),
            json!({"kind":"applied","categories":{"categories":cats}}),
            json!({"kind":"applied","categories":["1"]}),
            json!({"kind":"rejected","reason":"business","detail":7}),
            json!({"categories":cats}),
            json!(null),
            json!("applied"),
        ] {
            assert!(reply(bad.clone()).is_none(), "{bad}");
        }
    }

    #[test]
    fn echoed_categories_are_size_bounded() {
        let many: Vec<Value> = (0..=QUICK_REPLY_RESULT_CATEGORIES_MAX)
            .map(|i| json!({"id":i.to_string()}))
            .collect();
        assert!(reply(
            json!({"kind":"applied","categories":many[..QUICK_REPLY_RESULT_CATEGORIES_MAX]})
        )
        .is_some());
        // over the bound: the outcome stands, only the list is dropped (the UI reads again)
        let over = reply(json!({"kind":"applied","categories":many})).expect("applied");
        assert!(matches!(over.kind, QuickReplyEditKindDto::Applied) && over.categories.is_none());
        let huge = json!([{"name":"x".repeat(QUICK_REPLY_RESULT_MAX_BYTES)}]);
        let over = reply(json!({"kind":"unknown","reason":"unverified","categories":huge}))
            .expect("unknown");
        assert!(over.categories.is_none());
        assert_eq!(over.reason, Some(QuickReplyEditReasonDto::Unverified));
    }

    #[test]
    fn generation_change_never_leaves_a_final_outcome_or_a_list() {
        let cats = json!([{"id":"1"}]);
        for v in [
            json!({"kind":"applied","categories":cats}),
            json!({"kind":"rejected","reason":"busy"}),
            json!({"kind":"rejected","reason":"business","detail":"E1","categories":cats}),
        ] {
            let r = reply(v).unwrap().after_generation_change();
            assert_eq!(
                serde_json::to_value(&r).unwrap(),
                json!({"kind":"unknown","reason":"write_unknown"})
            );
        }
        let r = reply(json!({"kind":"unknown","reason":"readback_failed","categories":cats}))
            .unwrap()
            .after_generation_change();
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({"kind":"unknown","reason":"readback_failed"})
        );
        assert_eq!(
            serde_json::to_value(UiQuickReplyEditResultDto::invalid()).unwrap(),
            json!({"kind":"rejected","reason":"invalid"})
        );
    }

    #[test]
    fn manage_info_reply_shape_is_bounded() {
        let group = |i: usize| json!({"id": (i + 1).to_string(), "name": "Synthetic group"});
        let value = json!({"can_edit": true, "skill_groups": [group(0)]});
        let info = UiQuickReplyManageInfoDto::from_reply(value.clone()).expect("info");
        assert_eq!(serde_json::to_value(info).unwrap(), value);
        let full: Vec<Value> = (0..QUICK_REPLY_SKILL_GROUPS_MAX).map(group).collect();
        assert!(UiQuickReplyManageInfoDto::from_reply(
            json!({"can_edit": false, "skill_groups": full})
        )
        .is_some());
        let over: Vec<Value> = (0..=QUICK_REPLY_SKILL_GROUPS_MAX).map(group).collect();
        for bad in [
            json!({"can_edit": true, "skill_groups": over}),
            json!({"can_edit": "true", "skill_groups": []}),
            json!({"can_edit": true}),
            json!({"skill_groups": []}),
            json!({"can_edit": true, "skill_groups": [{"id": 1, "name": "x"}]}),
            json!({"can_edit": true, "skill_groups": [{"id": "1", "name": null}]}),
            json!({"can_edit": true, "skill_groups": {}}),
            json!(null),
        ] {
            assert!(
                UiQuickReplyManageInfoDto::from_reply(bad.clone()).is_none(),
                "{bad}"
            );
        }
        // a well-typed but out-of-bounds row is dropped; the rest of the form stays usable
        let mixed = json!({"can_edit": true, "skill_groups": [
            {"id": "sg-1", "name": "x"},
            {"id": "2", "name": "x".repeat(QUICK_REPLY_SKILL_GROUP_NAME_MAX + 1)},
            group(2),
        ]});
        let kept = UiQuickReplyManageInfoDto::from_reply(mixed).expect("info");
        assert_eq!(
            serde_json::to_value(kept).unwrap(),
            json!({"can_edit": true, "skill_groups": [group(2)]})
        );
    }
}

#[cfg(test)]
mod conversation_business_tests {
    use super::*;
    fn account() -> AccountContext {
        AccountContext::new(
            AccountId::new("synthetic-business"),
            Environment::production(),
            1,
        )
    }
    fn row() -> serde_json::Value {
        serde_json::json!({"gid":"synthetic-room","status":"active","agent_in_group":false,"is_owner":false,"service_type":"2573","last_message_time_ms":10,"last_update_time_ms":10,"unread_count":0,"is_full_snapshot":false,"title":"Synthetic","mark":0})
    }
    fn payload(value: serde_json::Value) -> Result<DisplayPayload, serde_json::Error> {
        serde_json::from_value(
            serde_json::json!({"kind":"conversations","full":false,"items":[value],"removed_gids":[]}),
        )
    }
    #[test]
    fn business_display_preserves_exact_known_and_unknown_types_through_real_cache_and_projection()
    {
        for value in [
            "B2C",
            "C2B",
            "B2MC",
            "B2O",
            "O2B",
            "B2B",
            "SYNTHETIC_UNKNOWN",
            " B2C ",
            "未知类型",
        ] {
            let mut r = row();
            r["conversation_type"] = serde_json::json!(value);
            let mut cache = DisplayCache::default();
            cache.apply(&account(), payload(r).unwrap()).unwrap();
            let stored = cache
                .conversation(&account(), "synthetic-room")
                .unwrap()
                .unwrap();
            let dto = UiConversationDto {
                display: stored,
                account: (&account()).into(),
                draft: String::new(),
                is_top: false,
                waiting_since_ms: None,
                waiting_confirmed: false,
            };
            let wire = serde_json::to_value(dto).unwrap();
            assert_eq!(
                wire.get("conversation_type"),
                Some(&serde_json::json!(value))
            );
            assert_eq!(wire["service_type"], "2573");
        }
    }
    #[test]
    fn business_display_legacy_missing_type_is_accepted_and_reprojected_as_explicit_null() {
        let mut cache = DisplayCache::default();
        cache.apply(&account(), payload(row()).unwrap()).unwrap();
        let stored = cache
            .conversation(&account(), "synthetic-room")
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(stored)
                .unwrap()
                .get("conversation_type"),
            Some(&serde_json::Value::Null)
        );
    }
    #[test]
    fn business_display_rejects_invalid_type_atomically_without_changing_a_valid_cached_row() {
        for value in [
            String::new(),
            "  ".into(),
            "X".repeat(65),
            "\u{feff}".into(),
            format!("B2C{}", '\0'),
            format!("B2C{}", '\u{0085}'),
        ] {
            let mut cache = DisplayCache::default();
            cache.apply(&account(), payload(row()).unwrap()).unwrap();
            let mut invalid = row();
            invalid["conversation_type"] = serde_json::json!(value);
            invalid["title"] = serde_json::json!("must not replace");
            assert!(cache.apply(&account(), payload(invalid).unwrap()).is_err());
            assert_eq!(
                cache
                    .conversation(&account(), "synthetic-room")
                    .unwrap()
                    .unwrap()
                    .title,
                "Synthetic"
            );
        }
    }
    #[test]
    fn business_display_non_string_type_is_rejected_at_the_wire_boundary() {
        for value in [
            serde_json::json!(123),
            serde_json::json!({"type":"B2C"}),
            serde_json::json!(["B2C"]),
        ] {
            let mut r = row();
            r["conversation_type"] = value;
            assert!(payload(r).is_err());
        }
    }
    #[test]
    fn business_display_size_limit_matches_typescript_utf16_units() {
        for value in ["X".repeat(64), "😀".repeat(32)] {
            let mut r = row();
            r["conversation_type"] = serde_json::json!(value);
            let mut cache = DisplayCache::default();
            cache.apply(&account(), payload(r).unwrap()).unwrap();
        }
        let mut r = row();
        r["conversation_type"] = serde_json::json!("😀".repeat(33));
        let mut cache = DisplayCache::default();
        assert!(cache.apply(&account(), payload(r).unwrap()).is_err());
    }
}

#[cfg(test)]
mod bridge_diagnostic_schema_tests {
    use super::*;
    use serde_json::json;

    fn page() -> serde_json::Value {
        json!({
            "version":1,"captured_at_ms":1,"running":true,"run_generation":1,"sdk":null,
            "session":{"received":0,"ui_mapped":0,"ui_dropped":0,"display_batches":0,"display_items":0,"display_resolved":0,"display_rejected":0},
            "compensation":{"running":false,"mode":"stopped","cursor_ms":0,"last_outcome_ms":null,"outcomes":{"success":0,"business_failure":0,"auth_invalid":0,"http_error":0,"malformed":0,"network_error":0,"timeout":0,"unknown":0},"rows":0,"mapped":0,"dropped":0},
            "bridge":{"state":"overflow","capacity":1024,"pending":0,"queued":0,"in_flight":0,"high_water":1024,"accepted":1024,"invoked":1,"delivered":0,"failed":1,"overflow_events":1,"rejected":1,"expired":1023,"stale_completions":0,"callback_errors":0}
        })
    }

    #[test]
    fn bridge_diagnostics_are_optional_closed_and_safe_integer_only() {
        let value = page();
        assert!(PageReceiveDiagnosticsDto::decode(value.clone())
            .unwrap()
            .bridge
            .is_some());
        let mut legacy = value.clone();
        legacy.as_object_mut().unwrap().remove("bridge");
        assert!(PageReceiveDiagnosticsDto::decode(legacy)
            .unwrap()
            .bridge
            .is_none());
        for bad in [
            json!(-1),
            json!(1.5),
            json!(9_007_199_254_740_992u64),
            json!("private text"),
        ] {
            let mut v = value.clone();
            v["bridge"]["rejected"] = bad;
            assert!(PageReceiveDiagnosticsDto::decode(v).is_none());
        }
        let mut extra = value.clone();
        extra["bridge"]["payload"] = json!("private text");
        assert!(PageReceiveDiagnosticsDto::decode(extra).is_none());
        let mut unknown = value;
        unknown["bridge"]["state"] = json!("arbitrary message");
        assert!(PageReceiveDiagnosticsDto::decode(unknown).is_none());
    }
}
