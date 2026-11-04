import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import type { UiConversation, UiMessage } from '../../packages/ipc/src/client.ts';
import { historyScopeKey, messageHistoryKey } from './viewmodel.ts';

export interface VisibleReadState {
  account: AccountContext | null;
  conversation: UiConversation | null;
  messages: readonly UiMessage[];
  firstPage: string | undefined;
  readContextRevision?: string | undefined;
  view: string;
  blocked: boolean;
}
export interface VisibleReadOptions {
  current(): VisibleReadState;
  pane(): HTMLElement | null;
  visible(): boolean;
  invoke(args: { account: AccountContext; gid: string; expected_message_id: string; expected_context_revision: string }): Promise<unknown>;
}

type MessageIndex = Map<string, UiMessage | null>;
const messageIndexCache = new WeakMap<readonly UiMessage[], MessageIndex>();

/** 按数组身份缓存 (gid, message_id) → 消息；同键出现多次记为 null，保持“恰好一条匹配”的语义。 */
function indexMessages(messages: readonly UiMessage[]): MessageIndex {
  let index = messageIndexCache.get(messages);
  if (index) return index;
  index = new Map();
  for (const m of messages) {
    if (typeof m.message_id !== 'string') continue;
    const key = JSON.stringify([m.gid, m.message_id]);
    index.set(key, index.has(key) ? null : m);
  }
  messageIndexCache.set(messages, index);
  return index;
}

/** A receipt describes a mounted, visible server row, never merely an active room. */
export function createVisibleRead(options: VisibleReadOptions) {
  // Do not retry a rejected/uncertain write on timer redraw or an automatic scope change.
  const attempted = new Map<string, Set<string>>();
  const pending = new Set<string>();
  function retry(account: AccountContext, gid: string, revision = options.current().conversation?.assistant_context_revision): void {
    const base = historyScopeKey(account, gid);
    const owner = JSON.stringify([base, revision]);
    const targets = attempted.get(owner);
    if (!targets) return;
    for (const target of targets) if (!pending.has(target)) targets.delete(target);
    if (targets.size === 0) attempted.delete(owner);
  }
  function afterRender(): void {
    const s = options.current(), c = s.conversation, a = s.account;
    if (!a || !c || s.blocked || s.view !== 'messages' || s.firstPage !== 'loaded' || !options.visible() || c.unread_count <= 0) return;
    const base = historyScopeKey(a, c.gid);
    const revision = s.readContextRevision;
    if (!revision || c.assistant_context_revision !== revision || historyScopeKey(c.account, c.gid) !== base) return;
    const owner = JSON.stringify([base, revision]);
    const pane = options.pane();
    if (!pane?.isConnected || pane.dataset['historyScope'] !== base || pane.dataset['readContextRevision'] !== revision) return;
    const frontier = c.read_target_message_id;
    if (typeof frontier !== 'string' || !frontier.trim() || frontier.length > 512) return;
    // 每次滚动都会进来：先用纯字符串判掉已尝试/进行中的目标，再碰消息数组和 DOM。
    const target = JSON.stringify([owner, frontier]);
    const targetsAttempted = attempted.get(owner);
    if (targetsAttempted?.has(target) || pending.has(target)) return;
    const latest = indexMessages(s.messages).get(JSON.stringify([c.gid, frontier]));
    if (!latest?.message_id || !Number.isFinite(latest.create_time_ms)) return;
    // Preview timestamps are not ownership evidence. Only the exact authoritative
    // frontier can be acknowledged; a newer unseen frontier is rejected below.
    const key = messageHistoryKey(a, c, latest);
    if (!key) return;
    const rows = [...pane.querySelectorAll<HTMLElement>('[data-history-key]')].filter(row => row.dataset['historyKey'] === key);
    if (rows.length !== 1 || !rows[0]!.isConnected) return;
    const bounds = pane.getBoundingClientRect(), rect = rows[0]!.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || rect.width <= 0 || rect.height <= 0 || rect.bottom <= bounds.top || rect.top >= bounds.bottom || rect.right <= bounds.left || rect.left >= bounds.right) return;
    const attemptedSet = targetsAttempted ?? new Set<string>();
    attemptedSet.add(target); attempted.set(owner, attemptedSet); pending.add(target);
    // Do not forget an uncertain A when the authoritative frontier changes A -> B -> A.
    // Retain targets until explicit reopen; a later target is not proof of A's outcome.
    void options.invoke({ account: a, gid: c.gid, expected_message_id: latest.message_id, expected_context_revision: revision }).catch(() => undefined).finally(() => pending.delete(target));
  }
  return { afterRender, retry };
}
