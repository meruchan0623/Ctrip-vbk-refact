/** Bounded, read-only display preloading. Selection tokens never enter this cache. */
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import { UiCommands, type UiInviteAgent, type UiInviteCandidates, type UiMembers } from '../../packages/ipc/src/client.ts';

export interface MemberPreloadScope { readonly account: AccountContext; readonly gid: string }
export interface MemberPreloadContext {
  readonly account: AccountContext;
  readonly gids: readonly string[];
  readonly activeGid: string | null;
  readonly paused?: boolean;
}
export type PreloadedMembers = Omit<UiMembers, 'selection_token' | 'expires_at_ms'>;
export interface PreloadedDirectory {
  readonly agents: readonly UiInviteAgent[];
  readonly fetched_at_ms: number;
  readonly complete: true;
}
interface Dependencies {
  invoke(command: string, payload: unknown): Promise<unknown>;
  now(): number;
  schedule?(callback: () => void, delayMs: number): () => void;
  isVisible?(): boolean;
  publish?(): void;
}
export const MEMBER_PRELOAD_POLICY = {
  cacheLimit: 128,
  visibleRequestsPerMinute: 6,
  hiddenRequestsPerMinute: 2,
  visibleTickMs: 5_000,
  hiddenTickMs: 15_000,
  activeMembersMs: 30_000,
  hiddenActiveMembersMs: 120_000,
  otherMembersMs: 300_000,
  hiddenOtherMembersMs: 900_000,
  directoryMs: 60_000,
  hiddenDirectoryMs: 300_000,
  groupBatchSize: 25,
  maxDirectoryGroups: 512,
  maxDirectoryAgents: 10_000,
  initialBackoffMs: 15_000,
  maxBackoffMs: 900_000,
} as const;
const accountKey = (account: AccountContext) => JSON.stringify([account.environment, account.account_id, account.session_generation]);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function membersSnapshot(value: unknown): PreloadedMembers {
  const row = object(value);
  if (!row || !Number.isFinite(row['fetched_at_ms']) || !Array.isArray(row['members']) || !row['members'].every(raw => {
    const member = object(raw);
    return member && nonempty(member['uid']) && (member['nickname'] === null || typeof member['nickname'] === 'string') && typeof member['status'] === 'string' && Array.isArray(member['roles']) && member['roles'].every(Number.isSafeInteger) && typeof member['can_transfer'] === 'boolean' && (member['can_remove'] === undefined || typeof member['can_remove'] === 'boolean');
  })) throw new Error('invalid preloaded members');
  // Explicit projection rather than spreading a token-bearing RPC envelope.
  const source = value as UiMembers;
  return { members: source.members.map(member => ({ ...member })), fetched_at_ms: source.fetched_at_ms, ...(source.self_is_master === undefined ? {} : { self_is_master: source.self_is_master }) };
}
function directoryLevel(value: unknown): Pick<UiInviteCandidates, 'agents' | 'skill_groups'> {
  const row = object(value);
  if (!row || !Array.isArray(row['agents']) || !row['agents'].every(raw => {
    const agent = object(raw);
    return agent && nonempty(agent['uid']) && (agent['nickname'] === null || typeof agent['nickname'] === 'string');
  }) || !Array.isArray(row['skill_groups']) || !row['skill_groups'].every(raw => {
    const group = object(raw);
    return group && Number.isSafeInteger(group['skill_group_id']) && (group['skill_group_id'] as number) >= 0 && typeof group['name'] === 'string';
  })) throw new Error('invalid preloaded directory');
  return value as UiInviteCandidates;
}
interface CachedMembers { readonly value: PreloadedMembers; readonly updatedAt: number }
interface DirectoryCache { readonly gid: string; readonly value: PreloadedDirectory; readonly completedAt: number }
interface Scan { readonly gid: string; readonly startedAt: number; readonly agents: Map<string, UiInviteAgent>; readonly visited: Set<number>; readonly pending: number[]; rooted: boolean }
interface Failure { readonly attempts: number; readonly nextAt: number }

export function createMemberPreload(deps: Dependencies) {
  let context: MemberPreloadContext | null = null;
  let epoch = 0;
  let running = false;
  let cancelTimer: (() => void) | null = null;
  let directory: DirectoryCache | null = null;
  let scan: Scan | null = null;
  let directoryRevision = 0;
  let rotation = 0;
  let category = 0;
  const members = new Map<string, CachedMembers>();
  const memberRevisions = new Map<string, number>();
  const failures = new Map<string, Failure>();
  // Includes failed requests and persists across account switches: changing an
  // account cannot bypass the per-client network budget.
  let requests: number[] = [];
  const visible = () => deps.isVisible?.() ?? (typeof document === 'undefined' || document.visibilityState !== 'hidden');
  function cancel() { cancelTimer?.(); cancelTimer = null; }
  function schedule(delay?: number) {
    cancel();
    if (!context || context.paused || !context.gids.length || running) return;
    const wait = delay ?? (visible() ? MEMBER_PRELOAD_POLICY.visibleTickMs : MEMBER_PRELOAD_POLICY.hiddenTickMs);
    const callback = () => { cancelTimer = null; void pump(); };
    if (deps.schedule) cancelTimer = deps.schedule(callback, wait);
    else if (typeof document !== 'undefined') { const timer = setTimeout(callback, wait); cancelTimer = () => clearTimeout(timer); }
  }
  function valid(scope: MemberPreloadScope) { return context !== null && accountKey(context.account) === accountKey(scope.account); }
  function putMembers(gid: string, value: PreloadedMembers) {
    members.delete(gid); members.set(gid, { value, updatedAt: deps.now() });
    while (members.size > MEMBER_PRELOAD_POLICY.cacheLimit) {
      const oldest = members.keys().next().value!;
      members.delete(oldest); memberRevisions.delete(oldest); failures.delete(`member:${oldest}`);
    }
    deps.publish?.();
  }
  function observeMembers(scope: MemberPreloadScope, value: UiMembers) {
    if (!valid(scope)) return;
    const snapshot = membersSnapshot(value);
    memberRevisions.set(scope.gid, (memberRevisions.get(scope.gid) ?? 0) + 1);
    putMembers(scope.gid, snapshot); failures.delete(`member:${scope.gid}`);
  }
  function observeDirectory(scope: MemberPreloadScope, agents: readonly UiInviteAgent[]) {
    if (!valid(scope)) return;
    directoryLevel({ agents, skill_groups: [] });
    if (agents.length > MEMBER_PRELOAD_POLICY.maxDirectoryAgents) return;
    directoryRevision++; scan = null;
    directory = { gid: scope.gid, completedAt: deps.now(), value: { agents: agents.map(agent => ({ ...agent })), fetched_at_ms: deps.now(), complete: true } };
    failures.delete('directory'); deps.publish?.();
  }
  function getMembers(scope: MemberPreloadScope): PreloadedMembers | null {
    if (!valid(scope)) return null;
    const cached = members.get(scope.gid);
    if (!cached) return null;
    members.delete(scope.gid); members.set(scope.gid, cached);
    return cached.value;
  }
  function getDirectory(scope: MemberPreloadScope): PreloadedDirectory | null {
    if (!valid(scope) || !directory) return null;
    if (directory.gid === scope.gid) return directory.value;
    // Online/role/profile data is account-wide; membership is specific to the
    // scan's anchor group and cannot be reused in another group.
    return { ...directory.value, agents: directory.value.agents.map(({ in_group: _membership, ...agent }) => agent) };
  }
  function ready(key: string, now: number) { return (failures.get(key)?.nextAt ?? 0) <= now; }
  function fail(key: string) {
    const attempts = (failures.get(key)?.attempts ?? 0) + 1;
    failures.delete(key); failures.set(key, { attempts, nextAt: deps.now() + Math.min(MEMBER_PRELOAD_POLICY.maxBackoffMs, MEMBER_PRELOAD_POLICY.initialBackoffMs * 2 ** Math.min(attempts - 1, 16)) });
    while (failures.size > MEMBER_PRELOAD_POLICY.cacheLimit + 1) failures.delete(failures.keys().next().value!);
  }
  function due(gid: string, interval: number, now: number) { return ready(`member:${gid}`, now) && (!members.has(gid) || now - members.get(gid)!.updatedAt >= interval); }
  function nextTask(now: number, foreground: boolean): { kind: 'member' | 'directory'; gid: string } | null {
    if (!context) return null;
    const active = context.activeGid && context.gids.includes(context.activeGid) ? context.activeGid : null;
    if (!active) return null;
    // Alternate only the entered conversation's membership and candidates.
    for (let checked = 0; checked < 2; checked++) {
      const which = category++ % 2;
      if (which === 0 && due(active, foreground ? MEMBER_PRELOAD_POLICY.activeMembersMs : MEMBER_PRELOAD_POLICY.hiddenActiveMembersMs, now)) return { kind: 'member', gid: active };
      if (which === 1 && ready('directory', now) && (scan || !directory || directory.gid !== active || now - directory.completedAt >= (foreground ? MEMBER_PRELOAD_POLICY.directoryMs : MEMBER_PRELOAD_POLICY.hiddenDirectoryMs))) return { kind: 'directory', gid: active };
    }
    return null;
  }
  async function pump() {
    if (running || !context || context.paused || !context.gids.length) return;
    const now = deps.now(), foreground = visible();
    requests = requests.filter(time => now - time < 60_000);
    if (requests.length >= (foreground ? MEMBER_PRELOAD_POLICY.visibleRequestsPerMinute : MEMBER_PRELOAD_POLICY.hiddenRequestsPerMinute)) { schedule(); return; }
    if (scan && !context.gids.includes(scan.gid)) scan = null;
    const task = nextTask(now, foreground);
    if (!task) { schedule(); return; }
    const ticket = epoch;
    const account = { ...context.account };
    const revision = task.kind === 'member' ? memberRevisions.get(task.gid) ?? 0 : directoryRevision;
    const failureKey = task.kind === 'member' ? `member:${task.gid}` : 'directory';
    running = true; requests.push(now);
    try {
      if (task.kind === 'member') {
        const value = await deps.invoke(UiCommands.IM_MEMBERS, { account, gid: task.gid });
        if (ticket !== epoch || !context || context.paused || !context.gids.includes(task.gid) || revision !== (memberRevisions.get(task.gid) ?? 0)) return;
        putMembers(task.gid, membersSnapshot(value));
      } else {
        const work: Scan = scan ??= { gid: task.gid, startedAt: deps.now(), agents: new Map<string, UiInviteAgent>(), visited: new Set<number>(), pending: [] as number[], rooted: false };
        const parents = work.rooted ? work.pending.slice(0, MEMBER_PRELOAD_POLICY.groupBatchSize) : undefined;
        const value = await deps.invoke(UiCommands.IM_INVITE_CANDIDATES, { account, gid: work.gid, ...(parents ? { parent_skill_group_ids: parents } : {}) });
        if (ticket !== epoch || !context || context.paused || revision !== directoryRevision || scan !== work || !context.gids.includes(work.gid)) return;
        const level = directoryLevel(value);
        if (parents) { work.pending.splice(0, parents.length); parents.forEach(id => work.visited.add(id)); }
        work.rooted = true;
        for (const agent of level.agents) work.agents.set(agent.uid.trim().toLowerCase(), { ...agent });
        for (const group of level.skill_groups) if (!work.visited.has(group.skill_group_id) && !work.pending.includes(group.skill_group_id)) work.pending.push(group.skill_group_id);
        if (work.visited.size + work.pending.length > MEMBER_PRELOAD_POLICY.maxDirectoryGroups || work.agents.size > MEMBER_PRELOAD_POLICY.maxDirectoryAgents) { scan = null; throw new Error('preload directory exceeds cache limits'); }
        if (!work.pending.length) {
          directory = { gid: work.gid, completedAt: deps.now(), value: { agents: [...work.agents.values()], fetched_at_ms: work.startedAt, complete: true } };
          scan = null; deps.publish?.();
        }
      }
      failures.delete(failureKey);
    } catch {
      if (ticket === epoch) fail(failureKey);
    } finally {
      running = false;
      schedule();
    }
  }
  function sync(next: MemberPreloadContext | null) {
    if (context?.activeGid !== next?.activeGid) { epoch++; scan = null; directory = null; category = 0; }
    const changed = (context ? accountKey(context.account) : null) !== (next ? accountKey(next.account) : null);
    if (changed) { epoch++; members.clear(); memberRevisions.clear(); directory = null; directoryRevision++; scan = null; failures.clear(); rotation = 0; category = 0; }
    context = next ? { ...next, account: { ...next.account }, gids: next.activeGid && next.gids.includes(next.activeGid) ? [next.activeGid] : [] } : null;
    if (!context || context.paused || !context.gids.length) cancel();
    else if (!cancelTimer && !running) schedule(0);
  }
  function stop() { sync(null); cancel(); }
  return { sync, getMembers, getDirectory, observeMembers, observeDirectory, stop };
}
