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
}

/// Mirrors `DisplayConversation` (adapterProtocol.ts): `UiConversation`
/// minus `account`, `waiting_since_ms`, `waiting_confirmed`, `is_top`,
/// `draft`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayConversationDto {
    #[serde(default)]
    pub customer_avatar: Option<String>,
    #[serde(flatten)]
    pub fact: ConversationFactDto,
    pub title: String,
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
    pub text: String,
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
    pub display_entered: u64, pub display_decode_rejected: u64, pub display_apply_rejected: u64,
    pub message_items: u64, pub changed_messages: u64, pub main_emit_attempts: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticGlobalState { Emitter, Missing, Invalid, Unreadable, Disposed }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticListenerHealth { Verified, Missing, Unsupported, Detached }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticBinding {
    pub global_state: DiagnosticGlobalState, pub listener_health: DiagnosticListenerHealth,
    pub attached: bool, pub can_rebind: bool, pub binding_generation: u64, pub attach_count: u64, pub repair_count: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticSdkCounters { pub callbacks: u64, pub stale_callbacks: u64, pub messages: u64, pub acks: u64, pub ignored: u64, pub listener_errors: u64 }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticSdk { pub binding: DiagnosticBinding, pub counters: DiagnosticSdkCounters, pub last_stanza_ms: Option<u64> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticSession {
    pub received: u64, pub ui_mapped: u64, pub ui_dropped: u64, pub display_batches: u64,
    pub display_items: u64, pub display_resolved: u64, pub display_rejected: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticOutcomes { pub success: u64, pub business_failure: u64, pub auth_invalid: u64, pub http_error: u64, pub malformed: u64, pub network_error: u64, pub timeout: u64, pub unknown: u64 }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticCompensationMode { Normal, Frequent, Stopped }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticCompensation {
    pub running: bool, pub mode: DiagnosticCompensationMode, pub cursor_ms: u64, pub last_outcome_ms: Option<u64>,
    pub outcomes: DiagnosticOutcomes, pub rows: u64, pub mapped: u64, pub dropped: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageReceiveDiagnosticsDto {
    pub version: u8, pub captured_at_ms: u64, pub running: bool, pub run_generation: u64,
    pub sdk: Option<DiagnosticSdk>, pub session: DiagnosticSession, pub compensation: DiagnosticCompensation,
}
impl PageReceiveDiagnosticsDto {
    pub fn decode(value: serde_json::Value) -> Option<Self> {
        fn safe(value: &serde_json::Value) -> bool {
            match value {
                serde_json::Value::Number(n) => n.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991),
                serde_json::Value::Array(_) => false,
                serde_json::Value::Object(o) => o.values().all(safe),
                _ => true,
            }
        }
        if !safe(&value) { return None; }
        let page: Self = serde_json::from_value(value).ok()?;
        (page.version == 1).then_some(page)
    }
}
#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticAvailability { Ready, NoAccount, Timeout, Unavailable, Invalid }
#[derive(Clone, Serialize)]
pub struct ReceiveDiagnosticsDto {
    pub version: u8, pub captured_at_ms: u64, pub availability: DiagnosticAvailability,
    pub page: Option<PageReceiveDiagnosticsDto>, pub host: Option<HostReceiveDiagnosticsDto>,
}
#[derive(Serialize)]
pub struct NetStatusResult {
    #[serde(flatten)] pub status: UiNetStatusDto,
    #[serde(skip_serializing_if = "Option::is_none")] pub diagnostics: Option<ReceiveDiagnosticsDto>,
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
    AgentStatus {
        status: AgentStatusDto,
        confirmed: bool,
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
            DisplayDelta::AgentStatus(s) => f.debug_tuple("AgentStatus").field(s).finish(),
            DisplayDelta::Transport(t) => f.debug_tuple("Transport").field(t).finish(),
            DisplayDelta::NoticeCategories => f.write_str("NoticeCategories"),
        }
    }
}

// ------------------------------------------------------------------ validation

const MESSAGE_KINDS: [&str; 6] = ["text", "image", "file", "video", "order_card", "system"];

fn validate_conversation(c: &DisplayConversationDto) -> Result<(), AppError> {
    if c.fact.gid.is_empty() {
        return Err(invalid("conversation gid is empty"));
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

fn same_message(a: &UiMessageDto, b: &UiMessageDto) -> bool {
    match (&a.message_id, &b.message_id) {
        (Some(x), Some(y)) if x == y => return true,
        _ => {}
    }
    matches!((&a.local_id, &b.local_id), (Some(x), Some(y)) if x == y)
}

/// Merges `incoming` into `thread`: same server id or same local id
/// updates in place (an outbound message gets its server id), anything
/// else is appended. Returns the new/changed messages.
fn merge_messages(
    thread: &mut Vec<UiMessageDto>,
    incoming: Vec<UiMessageDto>,
) -> Vec<UiMessageDto> {
    let mut changed = Vec::new();
    for mut m in incoming {
        if let Some(existing) = thread.iter_mut().find(|e| same_message(e, &m)) {
            let old_id = existing.sender_id.trim();
            let new_id = m.sender_id.trim();
            let same_sender = !old_id.is_empty()
                && (if new_id.is_empty() {
                    existing.sender_role == m.sender_role
                } else {
                    old_id.to_lowercase() == new_id.to_lowercase()
                });
            if same_sender {
                m.sender_name = m.sender_name.or_else(|| existing.sender_name.clone());
                m.sender_avatar = m.sender_avatar.or_else(|| existing.sender_avatar.clone());
                if new_id.is_empty() {
                    m.sender_id = existing.sender_id.clone();
                }
            }
            if *existing != m {
                *existing = m.clone();
                changed.push(m);
            }
        } else {
            thread.push(m.clone());
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

// ------------------------------------------------------------------ cache

#[derive(Default)]
struct AccountDisplay {
    generation: u64,
    conversations: BTreeMap<String, DisplayConversationDto>,
    threads: HashMap<String, Vec<UiMessageDto>>,
    /// Thread insertion order for eviction.
    thread_order: VecDeque<String>,
    agent_status: Option<UiAgentStatusDto>,
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
            DisplayPayload::MessageProfiles { gid, items } => {
                if gid.is_empty() || items.iter().any(|p| p.sender_id.trim().is_empty()
                    || (!p.message_id.as_ref().is_some_and(|s| !s.is_empty())
                        && !p.local_id.as_ref().is_some_and(|s| !s.is_empty()))) {
                    return Err(invalid("message profile needs thread, message, and sender identities"));
                }
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
                    acc.conversations.remove(gid);
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
                        acc.conversations.insert(gid.clone(), c);
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
                    fresh
                        .into_iter()
                        .filter(|m| !old.iter().any(|o| o == m))
                        .collect()
                } else {
                    let thread = acc.threads.entry(gid.clone()).or_default();
                    merge_messages(thread, items)
                };
                acc.touch_thread(&gid);
                DisplayDelta::Messages { gid, changed }
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
                            if p.sender_name.is_some() { m.sender_name = p.sender_name; }
                            if p.sender_avatar.is_some() { m.sender_avatar = p.sender_avatar; }
                            if *m != before { changed.push(m.clone()); }
                        }
                    }
                }
                DisplayDelta::Messages { gid, changed }
            }
            DisplayPayload::AgentStatus { status, confirmed } => {
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
            .map(|a| {
                a.conversations
                    .values()
                    .fold(0u32, |acc, c| acc.saturating_add(c.fact.unread_count))
            })
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

fn write_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    let io = |e: std::io::Error| AppError::new(codes::STORE_IO, format!("pinned table: {e}"));
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(io)?;
    }
    let bytes = serde_json::to_vec(value)
        .map_err(|e| AppError::new(codes::STORE_IO, format!("pinned table: {e}")))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(io)?;
    std::fs::rename(&tmp, path).map_err(io)
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

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
            translation: None,
            original: None,
            quote: None,
            order_id: None,
            disposition: None,
        }
    }

    #[test]
    fn unread_requires_authoritative_server_snapshot_and_preserves_same_value() {
        let mut cache = DisplayCache::new();
        cache.apply(&ctx(1), convs(true, &[("g1", 3)], &[])).unwrap();
        assert_eq!(cache.total_unread(&ctx(1)), 3);
        let unchanged = cache.apply(&ctx(1), convs(false, &[("g1", 3)], &[])).unwrap();
        assert_eq!(unchanged, DisplayDelta::Conversations { changed: vec![], removed: vec![] });
        assert_eq!(cache.total_unread(&ctx(1)), 3);
        let cleared = cache.apply(&ctx(1), convs(false, &[("g1", 0)], &[])).unwrap();
        assert_eq!(cleared, DisplayDelta::Conversations { changed: vec!["g1".into()], removed: vec![] });
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
        let mut confirmed = msg("g", Some("server"), Some("local"), 20, "synthetic confirmed body");
        confirmed.sender_id = "self".into();
        confirmed.sender_role = "merchant_self".into();
        confirmed.original = Some("synthetic original".into());
        confirmed.quote = Some("synthetic quote".into());
        confirmed.disposition = Some(SendDispositionDto::Confirmed { server_message_id: "server".into(), server_time_ms: 20 });
        cache.apply(&ctx(1), DisplayPayload::Messages { gid: "g".into(), replace: false, items: vec![confirmed.clone()] }).unwrap();
        let patch = |sender: &str, id: &str| serde_json::json!({ "kind": "message_profiles", "gid": "g", "items": [{ "message_id": id, "local_id": "local", "sender_id": sender, "sender_name": "API Self", "sender_avatar": "https://example.invalid/self.png" }] });
        let delta = cache.apply(&ctx(1), serde_json::from_value(patch("self", "server")).unwrap()).unwrap();
        let mut expected = confirmed.clone();
        expected.sender_name = Some("API Self".into());
        expected.sender_avatar = Some("https://example.invalid/self.png".into());
        assert!(matches!(delta, DisplayDelta::Messages { changed, .. } if changed == vec![expected.clone()]));
        assert!(cache.messages(&ctx(1), "g").unwrap().unwrap() == vec![expected.clone()]);
        for (sender, id) in [("other-person", "server"), ("self", "other-server")] {
            let delta = cache.apply(&ctx(1), serde_json::from_value(patch(sender, id)).unwrap()).unwrap();
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
            "kind": "agent_status", "status": "hangup", "confirmed": true
        }))
        .expect("parse");
        assert!(matches!(
            p,
            DisplayPayload::AgentStatus {
                status: AgentStatusDto::Hangup,
                confirmed: true
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
    pub can_transfer: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct UiMembersDto {
    pub members: Vec<UiMemberDto>,
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
    Empty,
    Unsupported,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct UiCustomerScriptsDto {
    pub kind: CustomerScriptsKindDto,
    pub raw_count: u64,
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
