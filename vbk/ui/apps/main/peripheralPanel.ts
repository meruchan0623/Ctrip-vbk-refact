/** Conversation-scoped peripheral actions. No DOM, browser calls or automatic write retries. */
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import type { UiMembers, UiInviteCandidates, UiCustomerScripts, UiPeripheralWrite } from '../../packages/ipc/src/client.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { sameAccount, errorMessage } from './viewmodel.ts';

export type PeripheralKind = 'members' | 'scripts' | 'invite' | 'transfer' | 'finish';
export interface PeripheralScope { readonly account: AccountContext; readonly gid: string }
export interface PeripheralPanelState {
  readonly kind: PeripheralKind;
  readonly scope: PeripheralScope;
  readonly busy: boolean;
  readonly selected: readonly string[];
  readonly members: UiMembers | null;
  readonly candidates: UiInviteCandidates | null;
  readonly scripts: UiCustomerScripts | null;
  readonly write: UiPeripheralWrite | null;
  readonly submitted: boolean;
  readonly error: string | null;
  readonly notice: string | null;
}
interface Dependencies {
  current(): PeripheralScope | null;
  invoke(command: string, payload: unknown): Promise<unknown>;
  publish(state: PeripheralPanelState | null): void;
  refreshConversation(scope: PeripheralScope): Promise<void>;
  now(): number;
}
const scopeKey = (scope: PeripheralScope, kind: PeripheralKind) => JSON.stringify([scope.account.environment, scope.account.account_id, scope.account.session_generation, scope.gid, kind]);

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
    return member && nonblank(member['uid']) && (member['nickname'] === null || typeof member['nickname'] === 'string') && typeof member['status'] === 'string' && typeof member['can_transfer'] === 'boolean' && Array.isArray(member['roles']) && member['roles'].every((role) => Number.isSafeInteger(role));
  })) throw new Error('成员返回格式无效，请只读刷新。');
  return value as UiMembers;
}
function readCandidates(value: unknown): UiInviteCandidates {
  const row = record(value);
  if (!row || !selectionEnvelope(row) || !Array.isArray(row['agents']) || !Array.isArray(row['skill_groups']) || !row['agents'].every((raw) => {
    const agent = record(raw); return agent && nonblank(agent['uid']) && (agent['nickname'] === null || typeof agent['nickname'] === 'string');
  }) || !row['skill_groups'].every((raw) => {
    const group = record(raw); return group && Number.isSafeInteger(group['skill_group_id']) && typeof group['name'] === 'string';
  })) throw new Error('候选返回格式无效，请只读刷新。');
  return value as UiInviteCandidates;
}
function readScripts(value: unknown): UiCustomerScripts {
  const row = record(value);
  if (!row || (row['kind'] !== 'empty' && row['kind'] !== 'unsupported') || !Number.isSafeInteger(row['raw_count']) || (row['raw_count'] as number) < 0) throw new Error('话术返回格式无效，请刷新。');
  return value as UiCustomerScripts;
}

export function createPeripheralPanel(deps: Dependencies) {
  let state: PeripheralPanelState | null = null;
  let request = 0;
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
  function close() { request++; state = null; deps.publish(null); }
  async function refresh(parentSkillGroupIds?: readonly number[], content = '') {
    if (!state || state.busy || !current(state.scope)) return;
    const { kind, scope } = state;
    const ticket = ++request;
    patch({ busy: true, error: null, selected: [], members: null, candidates: null, scripts: null });
    try {
      const payload = { account: scope.account, gid: scope.gid };
      if (kind === 'scripts') {
        const scripts = readScripts(await deps.invoke(UiCommands.IM_CUSTOMER_SCRIPTS, { account: scope.account, content }));
        if (valid(ticket, scope)) patch({ scripts });
      } else if (kind === 'invite') {
        const candidates = readCandidates(await deps.invoke(UiCommands.IM_INVITE_CANDIDATES, { ...payload, ...(parentSkillGroupIds ? { parent_skill_group_ids: parentSkillGroupIds } : {}) }));
        if (valid(ticket, scope)) patch({ candidates });
      } else {
        const members = readMembers(await deps.invoke(UiCommands.IM_MEMBERS, payload));
        if (valid(ticket, scope)) patch({ members });
      }
      if (valid(ticket, scope) && kind !== 'scripts') await deps.refreshConversation(scope);
    } catch (error) {
      if (valid(ticket, scope)) patch({ error: errorMessage(error) });
    } finally {
      if (valid(ticket, scope)) patch({ busy: false });
    }
  }
  async function open(kind: PeripheralKind) {
    const scope = deps.current();
    if (!scope) return;
    request++;
    const copy = { account: { ...scope.account }, gid: scope.gid };
    const write = attempts.get(scopeKey(copy, kind)) ?? null;
    state = { kind, scope: copy, busy: false, selected: [], members: null, candidates: null, scripts: null, write, submitted: write !== null, error: null, notice: null };
    deps.publish(state);
    await refresh();
  }
  function select(uid: string) {
    if (!state || state.busy || state.submitted || !current(state.scope)) return;
    if (state.kind === 'transfer') {
      if (!state.members?.members.some((member) => member.uid === uid && member.can_transfer === true)) return;
      patch({ selected: [uid] });
    } else if (state.kind === 'invite' && state.candidates?.agents.some((agent) => agent.uid === uid)) {
      patch({ selected: state.selected.includes(uid) ? state.selected.filter((id) => id !== uid) : [...state.selected, uid] });
    }
  }
  async function submit() {
    if (!state || state.busy || state.submitted || !current(state.scope)) return;
    const { kind, scope, selected, members, candidates } = state;
    if (kind !== 'finish' && kind !== 'invite' && kind !== 'transfer') return;
    const selection = kind === 'invite' ? candidates : members;
    if (!selection || !nonblank(selection.selection_token)) return;
    if (selection.expires_at_ms <= deps.now()) {
      const expectedRequest = request + 1;
      await refresh();
      if (valid(expectedRequest, scope) && state?.kind === kind) patch({ notice: kind === 'finish' ? '会话确认已过期，已只读刷新。请再次确认结束。' : '候选已过期，已只读刷新。请重新选择。' });
      return;
    }
    if (kind !== 'finish') {
      if (!selected.length || (kind === 'transfer' && selected.length !== 1)) return;
      if (kind === 'transfer' && !members?.members.some((member) => member.uid === selected[0] && member.can_transfer === true)) return;
    }
    const ticket = ++request;
    const key = scopeKey(scope, kind);
    // Persist the local no-replay fence before crossing IPC, including a lost reply.
    const uncertain: UiPeripheralWrite = { kind: 'unknown', confirmed: false };
    attempts.set(key, uncertain);
    patch({ busy: true, submitted: true, write: null, error: null, notice: null });
    const base = { account: scope.account, gid: scope.gid };
    try {
      const command = kind === 'finish' ? UiCommands.IM_FINISH : kind === 'invite' ? UiCommands.IM_INVITE : UiCommands.IM_TRANSFER;
      const payload = kind === 'finish' ? { ...base, selection_token: selection.selection_token } : kind === 'invite' ? { ...base, selection_token: selection!.selection_token, target_uids: selected } : { ...base, selection_token: selection!.selection_token, target_uid: selected[0] };
      const raw = await deps.invoke(command, payload) as UiPeripheralWrite;
      const result: UiPeripheralWrite = raw?.kind === 'confirmed' && raw.confirmed === true ? raw
        : raw?.kind === 'not_submitted' && raw.confirmed === false ? raw
        : raw?.kind === 'accepted' ? { ...raw, confirmed: false }
        : { kind: 'unknown', confirmed: false, ...(typeof raw?.reason === 'string' ? { reason: raw.reason } : {}) };
      if ((result.kind === 'confirmed' && result.confirmed) || result.kind === 'not_submitted') attempts.delete(key);
      else attempts.set(key, result);
      if (valid(ticket, scope)) patch(result.kind === 'not_submitted'
        ? { write: result, submitted: false, members: null, candidates: null, selected: [], notice: '本次操作尚未提交。请只读刷新成员和会话后，再次确认。' }
        : { write: result });
    } catch (error) {
      if (valid(ticket, scope)) patch({ write: uncertain, error: errorMessage(error) });
    } finally {
      if (valid(ticket, scope)) patch({ busy: false });
    }
  }
  return { open, close, refresh, select, submit };
}
