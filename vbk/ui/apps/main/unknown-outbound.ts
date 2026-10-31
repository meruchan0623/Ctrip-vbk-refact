import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import { UiCommands, type UiUnknownOutboundRecord } from '../../packages/ipc/src/client.ts';

export interface UnknownOutboundResult {
  readonly kind: 'unknown' | 'found';
  readonly server_id: string | null;
  readonly message: string;
}
export interface UnknownOutboundView {
  readonly scope: AccountContext;
  readonly busy: boolean;
  readonly records: readonly UiUnknownOutboundRecord[];
  readonly selected: { readonly gid: string; readonly local_id: string } | null;
  readonly result: UnknownOutboundResult | null;
  readonly notice: string | null;
}
interface Dependencies {
  current(): AccountContext | null;
  invoke(command: string, payload: { account: AccountContext; gid?: string }): Promise<unknown>;
  publish(view: UnknownOutboundView | null): void;
}
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const exactString = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value;
const safeNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const safeTime = (value: unknown): value is number => safeNumber(value) && Number.isFinite(new Date(value).getTime());
const sameScope = (a: AccountContext | null, b: AccountContext | null): boolean => !!a && !!b && a.account_id === b.account_id && a.environment === b.environment && a.session_generation === b.session_generation;
const unknown = (message: string): UnknownOutboundResult => ({ kind: 'unknown', server_id: null, message });

/** Copy only audited metadata; never preserve extra IPC fields or message bodies. */
function metadata(value: unknown, scope: AccountContext): UiUnknownOutboundRecord | null {
  const row = record(value);
  if (!row || row['account_id'] !== scope.account_id || row['environment'] !== scope.environment || !exactString(row['local_id']) || !exactString(row['gid']) || !safeNumber(row['creation_generation']) || !safeTime(row['created_at_ms']) || row['write_started'] !== true || (row['phase'] !== 'write_started' && row['phase'] !== 'unknown')) return null;
  return { environment: scope.environment, account_id: scope.account_id, local_id: row['local_id'], gid: row['gid'], creation_generation: row['creation_generation'], created_at_ms: row['created_at_ms'], write_started: true, phase: row['phase'] };
}

/** This controller has only two read operations. A match never settles or deletes the journal. */
export function createUnknownOutbound(deps: Dependencies) {
  let view: UnknownOutboundView | null = null;
  let sequence = 0;
  function close(): void { sequence++; view = null; deps.publish(null); }
  function valid(ticket: number, scope: AccountContext): boolean {
    if (ticket !== sequence || !view) return false;
    if (!sameScope(scope, deps.current())) { close(); return false; }
    return true;
  }
  async function refresh(): Promise<void> {
    if (!view || view.busy) return;
    const scope = view.scope;
    if (!sameScope(scope, deps.current())) { close(); return; }
    const ticket = ++sequence;
    view = { ...view, busy: true, selected: null, result: null, notice: null }; deps.publish(view);
    let records: UiUnknownOutboundRecord[] = [], notice: string | null = null;
    try {
      const raw = await deps.invoke(UiCommands.IM_UNKNOWN_OUTBOUND, { account: scope });
      if (!Array.isArray(raw)) notice = '未知发送元数据暂不可用，账本保持不变。';
      else {
        records = raw.map(row => metadata(row, scope)).filter((row): row is UiUnknownOutboundRecord => row !== null);
        if (records.length !== raw.length) notice = '部分元数据不属于当前账号或格式无效，已隐藏；账本保持不变。';
      }
    } catch { notice = '读取未知发送元数据失败，账本保持不变。'; }
    if (!valid(ticket, scope) || !view) return;
    view = { ...view, busy: false, records, notice }; deps.publish(view);
  }
  async function open(): Promise<void> {
    close();
    const current = deps.current();
    if (!current) return;
    view = { scope: { ...current }, busy: false, records: [], selected: null, result: null, notice: null }; deps.publish(view);
    await refresh();
  }
  function select(gid: string, localId: string): void {
    if (!view || view.busy) return;
    if (!sameScope(view.scope, deps.current())) { close(); return; }
    const matches = view.records.filter(row => row.gid === gid && row.local_id === localId);
    view = { ...view, selected: matches.length === 1 ? { gid, local_id: localId } : null, result: matches.length === 1 ? null : unknown('元数据重复或不可用，无法核验；结果仍未知。') }; deps.publish(view);
  }
  async function verify(): Promise<void> {
    if (!view || view.busy || !view.selected) return;
    const { scope, selected } = view;
    if (!sameScope(scope, deps.current())) { close(); return; }
    if (view.records.filter(row => row.gid === selected.gid && row.local_id === selected.local_id).length !== 1) return;
    const ticket = ++sequence;
    view = { ...view, busy: true, result: null }; deps.publish(view);
    let result: UnknownOutboundResult;
    try {
      const raw = record(await deps.invoke(UiCommands.IM_OUTBOUND_LOOKUP, { account: scope, gid: selected.gid }));
      if (!raw || !Array.isArray(raw['items'])) result = unknown('最新页格式不可用，结果仍未知。');
      else {
        const matches = raw['items'].map(record).filter(row => {
          if (!row || row['gid'] !== selected.gid || row['local_id'] !== selected.local_id || row['sender_role'] !== 'merchant_self') return false;
          // Typed page rows need no account field; an explicit conflicting owner is never ignored.
          if (!('account' in row)) return true;
          const owner = record(row['account']);
          return !!owner && owner['account_id'] === scope.account_id && owner['environment'] === scope.environment && owner['session_generation'] === scope.session_generation;
        });
        const serverId = matches.length === 1 ? matches[0]?.['message_id'] : null;
        result = exactString(serverId)
          ? { kind: 'found', server_id: serverId, message: '找到服务端记录，ID可核对；账本仍保留未知，不会自动重发。' }
          : unknown(matches.length > 1 ? '找到多条匹配记录，无法唯一核验；结果仍未知。' : '当前最新页未找到唯一有效记录；这不是发送被拒绝的证据，结果仍未知。');
      }
    } catch { result = unknown('只读查询失败，结果仍未知；不会重发。'); }
    if (!valid(ticket, scope) || !view) return;
    view = { ...view, busy: false, result }; deps.publish(view);
  }
  return { open, refresh, select, verify, close };
}
