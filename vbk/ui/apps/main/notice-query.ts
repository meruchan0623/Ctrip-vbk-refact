import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import { UiCommands, type UiNotice, type UiNoticeCategory } from '../../packages/ipc/src/client.ts';

export interface NoticeQueryState {
  readonly noticeCats: readonly UiNoticeCategory[];
  readonly noticeCat: string | null;
  readonly notices: readonly UiNotice[];
  readonly noticeCatsStatus: 'idle' | 'loading' | 'loaded' | 'error' | 'expired';
  readonly noticeListStatus: 'idle' | 'loading' | 'loaded' | 'error' | 'expired';
  readonly noticeCatsError: string | null;
  readonly noticeListError: string | null;
  readonly noticeMoreStatus: 'idle' | 'loading' | 'error' | 'expired';
  readonly noticeMoreError: string | null;
  readonly noticeHasMore: boolean;
  readonly noticeBeforeMs: number | null;
}
function failureStatus(error: unknown): 'error' | 'expired' {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'account.ticket_expired' ? 'expired' : 'error';
}

export const EMPTY_NOTICE_QUERY: NoticeQueryState = {
  noticeMoreStatus: 'idle', noticeMoreError: null, noticeHasMore: false, noticeBeforeMs: null,
  noticeCats: [], noticeCat: null, notices: [], noticeCatsStatus: 'idle', noticeListStatus: 'idle', noticeCatsError: null, noticeListError: null,
};

/** Account visit epochs and request tickets also reject A → B → A late replies. */
export function createNoticeQuery(port: {
  account(): AccountContext | null;
  current(): NoticeQueryState;
  publish(patch: Partial<NoticeQueryState>): void;
  invoke<T>(command: string, payload: unknown): Promise<T>;
  error(error: unknown): string;
  failed(error: unknown): void;
  /** 当前账号被本机忽略的分类；默认选中和回落选中都会跳过它们。 */
  ignored?(): readonly string[];
}) {
  let epoch = 0, categoriesTicket = 0, listTicket = 0, selectionTicket = 0;
  function scope() {
    const account = port.account(), visit = epoch;
    return account ? { account, valid: () => {
      const now = port.account();
      return visit === epoch && now?.account_id === account.account_id && now.environment === account.environment && now.session_generation === account.session_generation;
    } } : null;
  }
  function pageState(notices: readonly UiNotice[], before: number | null) {
    const oldest = notices.length ? Math.min(...notices.map(n => n.time_ms)) : null;
    return { noticeBeforeMs: oldest, noticeHasMore: notices.length >= 100 && oldest !== null && oldest > 0 && (before === null || oldest < before) };
  }
  async function queryPage(append: boolean): Promise<void> {
    const request = scope(), state = port.current(), category = state.noticeCat;
    const before = append ? state.noticeBeforeMs : null;
    if (!request || !category || (append && (!state.noticeHasMore || before === null || state.noticeMoreStatus === 'loading'))) return;
    const ticket = ++listTicket;
    const valid = () => request.valid() && ticket === listTicket && port.current().noticeCat === category;
    port.publish(append ? { noticeMoreStatus: 'loading', noticeMoreError: null } : { notices: [], noticeListStatus: 'loading', noticeListError: null, noticeMoreStatus: 'idle', noticeMoreError: null, noticeHasMore: false, noticeBeforeMs: null });
    try {
      const notices = await port.invoke<UiNotice[]>(UiCommands.NOTICE_LIST, { account: request.account, category_id: category, before_ms: before });
      if (!Array.isArray(notices) || notices.some(n => !n || n.category_id !== category || typeof n.id !== 'string' || typeof n.unread !== 'boolean' || typeof n.title !== 'string' || typeof n.body !== 'string' || typeof n.url !== 'string' || !Number.isFinite(n.time_ms))) throw new Error('通知列表返回格式不正确');
      if (!valid()) return;
      const merged = new Map((append ? port.current().notices : []).map(n => [n.id, n]));
      for (const notice of notices) if (!merged.has(notice.id)) merged.set(notice.id, notice);
      port.publish({ notices: [...merged.values()].sort((a, b) => b.time_ms - a.time_ms), noticeListStatus: 'loaded', noticeListError: null, noticeMoreStatus: 'idle', noticeMoreError: null, ...pageState(notices, before) });
    } catch (error) {
      if (valid()) port.publish(append ? { noticeMoreStatus: failureStatus(error), noticeMoreError: port.error(error) } : { noticeListStatus: failureStatus(error), noticeListError: port.error(error) });
    }
  }
  async function list(): Promise<void> { await queryPage(false); }
  async function more(): Promise<void> { await queryPage(true); }
  async function categories(loadList = true): Promise<void> {
    const request = scope();
    if (!request) return;
    const ticket = ++categoriesTicket;
    const noticesAtRead = port.current().notices;
    const valid = () => request.valid() && ticket === categoriesTicket;
    port.publish({ noticeCatsStatus: 'loading', noticeCatsError: null });
    try {
      const noticeCats = await port.invoke<UiNoticeCategory[]>(UiCommands.NOTICE_CATEGORIES, { account: request.account });
      if (!Array.isArray(noticeCats) || noticeCats.some(c => !c || typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.unread !== 'number')) throw new Error('通知分类返回格式不正确');
      if (!valid()) return;
      const previous = port.current().noticeCat;
      const hidden = new Set(port.ignored?.() ?? []);
      const usable = noticeCats.filter(c => !hidden.has(c.id));
      const noticeCat = usable.some(c => c.id === previous) ? previous : usable[0]?.id ?? null;
      if (noticeCat !== previous || !noticeCat) { ++listTicket; ++selectionTicket; }
      const confirmedRead = noticeCats.find(c => c.id === noticeCat)?.unread === 0 && port.current().notices === noticesAtRead;
      port.publish({ ...(confirmedRead ? { notices: noticesAtRead.map(n => n.category_id === noticeCat ? { ...n, unread: false } : n) } : {}), noticeCats, noticeCat, noticeCatsStatus: 'loaded', noticeCatsError: null,
        ...(noticeCat !== previous || !noticeCat ? { notices: [], noticeListStatus: 'idle' as const, noticeListError: null, noticeMoreStatus: 'idle' as const, noticeMoreError: null, noticeHasMore: false, noticeBeforeMs: null } : {}) });
      if (noticeCat && (loadList || noticeCat !== previous)) await list();
    } catch (error) {
      if (valid()) port.publish({ noticeCatsStatus: failureStatus(error), noticeCatsError: port.error(error) });
    }
  }
  async function pick(category: string): Promise<void> {
    if (!port.current().noticeCats.some(c => c.id === category)) return;
    ++listTicket;
    ++selectionTicket;
    port.publish({ noticeCat: category, notices: [], noticeListStatus: 'idle', noticeListError: null, noticeMoreStatus: 'idle', noticeMoreError: null, noticeHasMore: false, noticeBeforeMs: null });
    await list();
  }
  async function markRead(category: string, id: string | null): Promise<boolean> {
    const request = scope();
    if (!request || port.current().noticeCat !== category) return false;
    // Selection changes, even a round trip to the same category, invalidate this mutation's UI update.
    const selection = listTicket;
    const requestedNotices = new Set(port.current().notices);
    const valid = () => request.valid() && port.current().noticeCat === category && selection === listTicket;
    try {
      await port.invoke(UiCommands.NOTICE_MARK_READ, { account: request.account, category_id: category, id });
      if (!valid()) return false;
      ++listTicket; // An older page read cannot restore unread state after this receipt.
      port.publish({ noticeMoreStatus: 'idle', noticeMoreError: null, notices: port.current().notices.map(n => n.category_id === category && (id === null ? requestedNotices.has(n) : n.id === id) ? { ...n, unread: false } : n) });
      void categories(false);
      return true;
    } catch (error) { if (valid()) port.failed(error); return false; }
  }
  /** Account-visit guard for asynchronous actions across panels; category selection is independent. */
  function accountGuard(): () => boolean {
    const request = scope();
    return () => !!request && request.valid();
  }
  function selectionGuard(): () => boolean {
    const request = scope(), category = port.current().noticeCat, selection = selectionTicket;
    return () => !!request && request.valid() && selection === selectionTicket && category === port.current().noticeCat;
  }
  return { categories, list, more, pick, markRead, accountGuard, selectionGuard, reset() { ++epoch; ++categoriesTicket; ++listTicket; ++selectionTicket; } };
}
