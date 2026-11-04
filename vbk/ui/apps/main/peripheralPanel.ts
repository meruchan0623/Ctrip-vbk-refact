/** Conversation-scoped peripheral actions. Automatic reads never retry writes. */
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import type { UiMembers, UiInviteAgent, UiInviteCandidates, UiCustomerScripts, UiPeripheralWrite } from '../../packages/ipc/src/client.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { sameAccount, errorMessage } from './viewmodel.ts';

export type PeripheralKind = 'members' | 'scripts' | 'invite' | 'transfer' | 'finish';
/** Write actions. The members panel (official「群聊人员」) submits transfer or
 * remove from its own selection; remove is never a mode of finish. */
export type PeripheralAction = 'invite' | 'transfer' | 'finish' | 'remove';
/** One loaded batch of the official directory, keyed by parent ids or 'root'. */
export interface InviteLevel { readonly groups: UiInviteCandidates['skill_groups']; readonly agents: readonly UiInviteAgent[] }
export const INVITE_ROOT = 'root';
export interface PeripheralScope { readonly account: AccountContext; readonly gid: string }
export interface PeripheralPanelState {
  readonly kind: PeripheralKind;
  readonly scope: PeripheralScope;
  readonly busy: boolean;
  readonly refreshing: boolean;
  readonly onlineOnly: boolean;
  readonly roleFilter: string;
  readonly updatedAt: number | null;
  readonly selected: readonly string[];
  readonly members: UiMembers | null;
  readonly candidates: UiInviteCandidates | null;
  readonly scripts: UiCustomerScripts | null;
  readonly write: UiPeripheralWrite | null;
  /** Action that produced `write` (members panel may transfer or remove). */
  readonly action: PeripheralAction | null;
  /** Members panel: removal is a second explicit step (official confirm dialog). */
  readonly confirming: 'remove' | null;
  /** Invite tree levels, expanded group ids, the group being loaded, active search. */
  readonly tree: { readonly [parent: string]: InviteLevel } | null;
  readonly expanded: readonly string[];
  readonly loading: string | null;
  readonly query: string;
  /** Every agent loaded under the current token, for the "已选" list. */
  readonly known: { readonly [uid: string]: UiInviteAgent };
  readonly submitted: boolean;
  readonly error: string | null;
  readonly notice: string | null;
}
export interface MemberPreloadSnapshot { readonly members?: UiMembers; readonly candidates?: UiInviteCandidates; readonly updatedAt: number }
interface Dependencies {
  preload?(scope: PeripheralScope): MemberPreloadSnapshot | null;
  rememberMembers?(scope: PeripheralScope, members: UiMembers): void;
  rememberDirectory?(scope: PeripheralScope, agents: readonly UiInviteAgent[]): void;
  current(): PeripheralScope | null;
  invoke(command: string, payload: unknown): Promise<unknown>;
  publish(state: PeripheralPanelState | null): void;
  refreshConversation(scope: PeripheralScope): Promise<void>;
  now(): number;
  /** Tests and non-browser hosts may provide their own cancellable clock. */
  schedule?(callback: () => void, delayMs: number): () => void;
  isVisible?(): boolean;
}
const scopeKey = (scope: PeripheralScope, kind: PeripheralKind | PeripheralAction) => JSON.stringify([scope.account.environment, scope.account.account_id, scope.account.session_generation, scope.gid, kind]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function selectionEnvelope(value: Record<string, unknown>): boolean {
  return nonblank(value['selection_token']) && finite(value['expires_at_ms']) && value['expires_at_ms'] > 0;
}
function readMembers(value: unknown): UiMembers {
  const row = record(value);
  if (!row || !selectionEnvelope(row) || !finite(row['fetched_at_ms']) || !Array.isArray(row['members']) || !row['members'].every((raw) => {
    const member = record(raw);
    return member && nonblank(member['uid']) && (member['nickname'] === null || typeof member['nickname'] === 'string') && typeof member['status'] === 'string' && typeof member['can_transfer'] === 'boolean' && (member['can_remove'] === undefined || typeof member['can_remove'] === 'boolean') && Array.isArray(member['roles']) && member['roles'].every((role) => Number.isSafeInteger(role));
  })) throw new Error('成员返回格式无效，正在等待自动更新。');
  return value as UiMembers;
}
function readCandidates(value: unknown): UiInviteCandidates {
  const row = record(value);
  if (!row || !selectionEnvelope(row) || !Array.isArray(row['agents']) || !Array.isArray(row['skill_groups']) || !row['agents'].every((raw) => {
    const agent = record(raw); return agent && nonblank(agent['uid']) && (agent['nickname'] === null || typeof agent['nickname'] === 'string');
  }) || !row['skill_groups'].every((raw) => {
    const group = record(raw); return group && Number.isSafeInteger(group['skill_group_id']) && typeof group['name'] === 'string';
  })) throw new Error('候选返回格式无效，正在等待自动更新。');
  return value as UiInviteCandidates;
}
function readScripts(value: unknown): UiCustomerScripts {
  const row = record(value);
  if (!row || (row['kind'] !== 'empty' && row['kind'] !== 'unsupported') || !Number.isSafeInteger(row['raw_count']) || (row['raw_count'] as number) < 0) throw new Error('话术返回格式无效，请刷新。');
  return value as UiCustomerScripts;
}

export const MEMBER_REFRESH_MS = 15_000;
const MAX_INVITE_GROUPS = 512;
const INVITE_GROUP_BATCH = 50;

const EMPTY = { tree: null, expanded: [], loading: null, query: '', known: {} } as const;
const levelOf = (c: UiInviteCandidates): InviteLevel => ({ groups: c.skill_groups, agents: c.agents });
function index(known: PeripheralPanelState['known'], agents: readonly UiInviteAgent[]) {
  const next = { ...known };
  for (const agent of agents) next[agent.uid] = agent;
  return next;
}

/** Role is independent from a member's department/skill group. */
export function inviteAgentRole(agent: UiInviteAgent): string {
  if (agent.job_position_type != null && [1, 2, 3, 4].includes(agent.job_position_type)) return String(agent.job_position_type);
  return ({ 管理员: '1', 财务: '2', 运营: '3', 客服: '4' } as Record<string, string>)[agent.job_position?.trim() ?? ''] ?? 'unknown';
}
export function filteredInviteAgents(state: PeripheralPanelState): readonly UiInviteAgent[] {
  const query = state.query.trim().toLocaleLowerCase();
  return Object.values(state.known).filter(agent =>
    (!state.onlineOnly || agent.status != null && [0, 1, 2].includes(agent.status)) &&
    (state.roleFilter === 'all' || inviteAgentRole(agent) === state.roleFilter) &&
    (!query || [agent.nickname, agent.uid, agent.skill_group_full_name, agent.job_position].some(value => value?.toLocaleLowerCase().includes(query))))
    .sort((a, b) => ([0, 1, 2].includes(a.status ?? -1) ? a.status! : 3) - ([0, 1, 2].includes(b.status ?? -1) ? b.status! : 3) || (a.nickname ?? a.uid).localeCompare(b.nickname ?? b.uid, 'zh-CN'));
}

export function createPeripheralPanel(deps: Dependencies) {
  let state: PeripheralPanelState | null = null;
  let request = 0;
  let activeRead = 0;
  let cancelTimer: (() => void) | null = null;
  const attempts = new Map<string, UiPeripheralWrite>();
  function current(scope: PeripheralScope): boolean {
    const active = deps.current();
    return !!active && active.gid === scope.gid && sameAccount(active.account, scope.account) && active.account.session_generation === scope.account.session_generation;
  }
  function valid(ticket: number, scope: PeripheralScope): boolean {
    return ticket === request && state !== null && current(scope);
  }
  function patch(update: Partial<PeripheralPanelState>) {
    if (!state) return;
    state = { ...state, ...update }; deps.publish(state);
  }
  function stopTimer() { cancelTimer?.(); cancelTimer = null; }
  function scheduleRefresh() {
    stopTimer();
    if (!state || !['members', 'invite', 'transfer'].includes(state.kind)) return;
    const snapshot = state.scope;
    const callback = () => {
      cancelTimer = null;
      if (!state || state.scope !== snapshot) return;
      if (!current(snapshot)) { close(); return; }
      const visible = deps.isVisible?.() ?? (typeof document === 'undefined' || document.visibilityState !== 'hidden');
      if (!visible || state.busy || state.refreshing) { scheduleRefresh(); return; }
      void reload(undefined, state.query, true);
    };
    if (deps.schedule) cancelTimer = deps.schedule(callback, MEMBER_REFRESH_MS);
    else if (typeof document !== 'undefined') {
      const timer = setTimeout(callback, MEMBER_REFRESH_MS);
      cancelTimer = () => clearTimeout(timer);
    }
  }
  function close() { stopTimer(); request++; activeRead = 0; state = null; deps.publish(null); }
  /** Fetch the complete directory across departments. Each level extends the
   * last live selection token; only the complete snapshot is published. */
  async function loadDirectory(ticket: number, scope: PeripheralScope, parents?: readonly number[]) {
    const payload = { account: scope.account, gid: scope.gid };
    let candidates = readCandidates(await deps.invoke(UiCommands.IM_INVITE_CANDIDATES, { ...payload, ...(parents ? { parent_skill_group_ids: parents } : {}) }));
    if (!valid(ticket, scope)) return null;
    const tree: Record<string, InviteLevel> = { [INVITE_ROOT]: levelOf(candidates) };
    let known = index({}, candidates.agents);
    const visited = new Set<number>(parents ?? []);
    const queued = new Set<number>();
    const pending: number[] = [];
    const enqueue = (level: UiInviteCandidates) => {
      for (const group of level.skill_groups) if (!visited.has(group.skill_group_id) && !queued.has(group.skill_group_id)) {
        if (visited.size + queued.size >= MAX_INVITE_GROUPS) throw new Error('部门目录过大，暂时无法完整加载。');
        pending.push(group.skill_group_id); queued.add(group.skill_group_id);
      }
    };
    enqueue(candidates);
    while (pending.length) {
      if (!valid(ticket, scope)) return null;
      const batch = pending.splice(0, INVITE_GROUP_BATCH);
      for (const id of batch) { queued.delete(id); visited.add(id); }
      const prior = candidates;
      if (prior.expires_at_ms <= deps.now()) throw new Error('成员状态读取超时，正在等待自动更新。');
      candidates = readCandidates(await deps.invoke(UiCommands.IM_INVITE_CANDIDATES, { ...payload, parent_skill_group_ids: batch, extend_token: prior.selection_token }));
      if (!valid(ticket, scope)) return null;
      // The host does not merge an expired token. Never publish earlier rows
      // under a token that might authorize only the last directory level.
      if (prior.expires_at_ms <= deps.now()) throw new Error('成员状态读取超时，正在等待自动更新。');
      tree[batch.join(',')] = levelOf(candidates);
      known = index(known, candidates.agents);
      enqueue(candidates);
    }
    return { candidates, tree, known };
  }
  async function reload(parentSkillGroupIds?: readonly number[], content = '', automatic = false) {
    if (!state || state.busy || state.refreshing || !current(state.scope)) return;
    stopTimer();
    const { kind, scope } = state;
    const ticket = ++request;
    activeRead = ticket;
    patch({ busy: !automatic, refreshing: automatic, error: null, ...(automatic ? {} : { confirming: null }),
      ...(kind === 'invite' ? { query: content.trim() } : {}) });
    try {
      const payload = { account: scope.account, gid: scope.gid };
      if (kind === 'scripts') {
        const scripts = readScripts(await deps.invoke(UiCommands.IM_CUSTOMER_SCRIPTS, { account: scope.account, content }));
        if (valid(ticket, scope)) patch({ scripts, updatedAt: deps.now() });
      } else if (kind === 'invite') {
        const directory = await loadDirectory(ticket, scope, parentSkillGroupIds);
        if (valid(ticket, scope) && directory) { deps.rememberDirectory?.(scope, Object.values(directory.known)); patch({ ...directory, selected: state!.selected.filter(uid => directory.known[uid] && directory.known[uid].in_group !== true), updatedAt: deps.now() }); }
      } else {
        const members = readMembers(await deps.invoke(UiCommands.IM_MEMBERS, payload));
        if (valid(ticket, scope)) {
          deps.rememberMembers?.(scope, members);
          const selected = state!.selected.filter(uid => members.members.some(member => member.uid === uid && (member.can_transfer || (kind === 'members' && member.can_remove))));
          const confirming = state!.confirming === 'remove' && selected.length === state!.selected.length && selected.every(uid => members.members.some(member => member.uid === uid && member.can_remove === true)) ? 'remove' : null;
          patch({ members, selected, confirming, updatedAt: deps.now() });
        }
      }
      if (valid(ticket, scope) && kind !== 'scripts') await deps.refreshConversation(scope);
    } catch (error) {
      if (valid(ticket, scope)) patch({ error: errorMessage(error) });
    } finally {
      if (activeRead === ticket) activeRead = 0;
      if (valid(ticket, scope)) { patch({ busy: false, refreshing: false }); scheduleRefresh(); }
    }
  }
  async function refresh(parentSkillGroupIds?: readonly number[], content?: string) {
    if (state?.kind === 'invite' && parentSkillGroupIds === undefined && content !== undefined) {
      patch({ query: content.trim() });
      if (state.candidates) return;
    }
    await reload(parentSkillGroupIds, content ?? state?.query ?? '');
  }
  /** Kept for older callers; all departments are already loaded together. */
  async function expand(groupId: number) {
    if (!state || state.kind !== 'invite' || state.busy || state.refreshing || state.submitted || !current(state.scope)) return;
    const key = String(groupId);
    patch({ expanded: state.expanded.includes(key) ? state.expanded.filter(id => id !== key) : [...state.expanded, key] });
  }
  function setOnlineOnly(onlineOnly: boolean) { if (state?.kind === 'invite') patch({ onlineOnly }); }
  function setRoleFilter(roleFilter: string) {
    if (state?.kind === 'invite' && (roleFilter === 'all' || roleFilter === 'unknown' || /^\d{1,3}$/.test(roleFilter))) patch({ roleFilter });
  }
  async function open(kind: PeripheralKind) {
    const scope = deps.current();
    if (!scope) return;
    stopTimer();
    request++;
    activeRead = 0;
    const copy = { account: { ...scope.account }, gid: scope.gid };
    // The members panel shares the transfer/remove fences with their own entries.
    const actions: readonly PeripheralAction[] = kind === 'members' ? ['remove', 'transfer'] : kind === 'scripts' ? [] : [kind];
    const action = actions.find((a) => attempts.has(scopeKey(copy, a))) ?? null;
    const write = action ? attempts.get(scopeKey(copy, action))! : null;
    state = { kind, scope: copy, busy: false, refreshing: false, onlineOnly: true, roleFilter: '4', updatedAt: null, selected: [], members: null, candidates: null, scripts: null, write, action, confirming: null, ...EMPTY, submitted: write !== null, error: null, notice: null };
    const cached = deps.preload?.(copy);
    if (cached) {
      if (kind === 'invite' && cached.candidates) {
        const candidates = { ...cached.candidates, selection_token: '', expires_at_ms: 0 };
        state = { ...state, candidates, known: index({}, candidates.agents), updatedAt: cached.updatedAt };
      } else if ((kind === 'members' || kind === 'transfer') && cached.members) {
        state = { ...state, members: { ...cached.members, selection_token: '', expires_at_ms: 0 }, updatedAt: cached.updatedAt };
      }
    }
    deps.publish(state);
    await refresh();
  }
  function select(uid: string) {
    if (!state || state.busy || state.submitted || !current(state.scope)) return;
    const toggle = () => patch({ selected: state!.selected.includes(uid) ? state!.selected.filter((id) => id !== uid) : [...state!.selected, uid], confirming: null });
    if (state.kind === 'transfer') {
      if (!state.members?.members.some((member) => member.uid === uid && member.can_transfer === true)) return;
      patch({ selected: [uid] });
    } else if (state.kind === 'members') {
      if (state.members?.members.some((member) => member.uid === uid && (member.can_transfer === true || member.can_remove === true))) toggle();
    } else if (state.kind === 'invite') {
      const agent = state.known[uid] ?? state.candidates?.agents.find((a) => a.uid === uid);
      if (agent && agent.in_group !== true) toggle();
    }
  }
  function confirmRemove(on = true) {
    if (!state || state.kind !== 'members' || state.busy || state.submitted) return;
    patch({ confirming: on ? 'remove' : null });
  }
  async function submit(requested?: PeripheralAction) {
    if (!state || state.busy || state.refreshing || activeRead || state.submitted || !current(state.scope)) return;
    const { kind, scope, selected, members, candidates } = state;
    const action: PeripheralAction | null = kind === 'members' ? (requested === 'transfer' || requested === 'remove' ? requested : null)
      : kind === 'finish' || kind === 'invite' || kind === 'transfer' ? kind : null;
    if (!action) return;
    const selection = action === 'invite' ? candidates : members;
    if (!selection || !nonblank(selection.selection_token)) return;
    if (selection.expires_at_ms <= deps.now()) {
      const expectedRequest = request + 1;
      patch({ selected: [] });
      await refresh();
      if (valid(expectedRequest, scope) && state?.kind === kind) patch({ notice: action === 'finish' ? '会话确认已过期，已只读刷新。请再次确认结束。' : '候选已过期，已自动更新。请重新选择。' });
      return;
    }
    if (action !== 'finish') {
      if (!selected.length || (action === 'transfer' && selected.length !== 1)) return;
      if (action === 'transfer' && !members?.members.some((member) => member.uid === selected[0] && member.can_transfer === true)) return;
      if (action === 'remove' && (state.confirming !== 'remove' || !selected.every((uid) => members?.members.some((member) => member.uid === uid && member.can_remove === true)))) return;
    }
    stopTimer();
    const ticket = ++request;
    const key = scopeKey(scope, kind === 'members' ? action : kind);
    // Persist the local no-replay fence before crossing IPC, including a lost reply.
    const uncertain: UiPeripheralWrite = { kind: 'unknown', confirmed: false };
    attempts.set(key, uncertain);
    patch({ busy: true, submitted: true, write: null, action, confirming: null, error: null, notice: null });
    const base = { account: scope.account, gid: scope.gid };
    try {
      const command = action === 'finish' ? UiCommands.IM_FINISH : action === 'invite' ? UiCommands.IM_INVITE : action === 'remove' ? UiCommands.IM_REMOVE : UiCommands.IM_TRANSFER;
      const payload = action === 'finish' ? { ...base, selection_token: selection.selection_token }
        : action === 'transfer' ? { ...base, selection_token: selection.selection_token, target_uid: selected[0] }
        : { ...base, selection_token: selection.selection_token, target_uids: selected };
      const raw = await deps.invoke(command, payload) as UiPeripheralWrite;
      const result: UiPeripheralWrite = raw?.kind === 'confirmed' && raw.confirmed === true ? raw
        : raw?.kind === 'not_submitted' && raw.confirmed === false ? raw
        : raw?.kind === 'accepted' ? { ...raw, confirmed: false }
        : { kind: 'unknown', confirmed: false, ...(typeof raw?.reason === 'string' ? { reason: raw.reason } : {}) };
      if ((result.kind === 'confirmed' && result.confirmed) || result.kind === 'not_submitted') attempts.delete(key);
      else attempts.set(key, result);
      if (valid(ticket, scope)) patch(result.kind === 'not_submitted'
        ? { write: result, submitted: false, members: null, candidates: null, selected: [], ...EMPTY, query: state!.query, notice: kind === 'finish' ? '本次操作尚未提交。请刷新会话后再次确认。' : '本次操作尚未提交，成员和会话将自动更新，请稍后再次确认。' }
        : { write: result });
      // A confirmed invite finishes the flow: close the dialog like the official client.
      if (action === 'invite' && result.kind === 'confirmed' && result.confirmed && valid(ticket, scope)) { close(); return; }
      // A confirmed member change is re-read like the official refreshGroupMember.
      if (kind === 'members' && result.kind === 'confirmed' && valid(ticket, scope)) {
        const members = readMembers(await deps.invoke(UiCommands.IM_MEMBERS, base));
        if (valid(ticket, scope)) patch({ members, selected: [], submitted: false });
      }
    } catch (error) {
      if (valid(ticket, scope)) patch({ write: state?.write ?? uncertain, error: errorMessage(error) });
    } finally {
      if (valid(ticket, scope)) { patch({ busy: false }); scheduleRefresh(); }
    }
  }
  return { open, close, refresh, expand, select, confirmRemove, submit, setOnlineOnly, setRoleFilter };
}
