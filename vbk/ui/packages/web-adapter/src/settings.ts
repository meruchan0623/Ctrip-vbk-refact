/**
 * Read-back helpers for agent settings. Shapes are kept as `unknown` with
 * narrow accessors because only one or two samples exist per endpoint and
 * nothing beyond the observed fields may be assumed.
 *
 * - `17092/listNoticeReceiveConfig` (online.ctrip.com) `{scene, head}` → `configList[]`
 *   (platform head: `cver:"1.0"`, empty extension, no appId — sample 63)
 * - `16037/getAgentWorkingSchedule` `{head, locale, venAgentUid}` → `workingSchedule`
 * - `16037/getVenAgentByUid` `{head}` → `venAgent`, `venAgentOption`
 * - `16037/syncVenAgentInfo` `{head}` (write; read back with getVenAgentByUid afterwards)
 */

import type { AdapterDeps, TimerHandle } from './deps.ts';
import { Endpoints, M } from './endpoints.ts';
import { businessHead, platformHead } from './heads.ts';
import { endpoint, isBizSuccess, recordOrNull, type SoaClient, type SoaOutcome } from './soa.ts';

export type ReadResult<T> = { readonly kind: 'ok'; readonly value: T; readonly raw: unknown } | { readonly kind: 'failed'; readonly outcome: SoaOutcome<unknown> } | { readonly kind: 'biz_failure'; readonly raw: unknown };

export const NOTICE_SCENE_OBSERVED = 'vbk_notice_h5';

export interface NoticeReceiveConfig {
  readonly noticeCategoryCode: string;
  readonly noticeCategoryName: string;
  readonly noticeValueList: readonly string[];
}

export async function listNoticeReceiveConfig(deps: AdapterDeps, soa: SoaClient, scene: string = NOTICE_SCENE_OBSERVED): Promise<ReadResult<readonly NoticeReceiveConfig[]>> {
  const outcome = await soa.post<{ configList?: unknown }>(Endpoints.LIST_NOTICE_RECEIVE_CONFIG, { scene, head: platformHead(deps.context) });
  if (outcome.kind !== 'success') return { kind: 'failed', outcome };
  const list = Array.isArray(outcome.body.configList) ? outcome.body.configList : [];
  const value: NoticeReceiveConfig[] = [];
  for (const item of list) {
    const r = recordOrNull(item);
    if (!r) continue;
    value.push({
      noticeCategoryCode: typeof r['noticeCategoryCode'] === 'string' ? (r['noticeCategoryCode'] as string) : '',
      noticeCategoryName: typeof r['noticeCategoryName'] === 'string' ? (r['noticeCategoryName'] as string) : '',
      noticeValueList: Array.isArray(r['noticeValueList']) ? (r['noticeValueList'] as unknown[]).filter((v): v is string => typeof v === 'string') : [],
    });
  }
  return { kind: 'ok', value, raw: outcome.body };
}

export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
export const WEEKDAYS: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface WorkingSchedule {
  readonly venAgentUid: string | null;
  readonly timeZone: string | null;
  readonly timeZoneDisplayName: string | null;
  /** Raw per-day string lists as returned; format of the entries is unverified. */
  readonly days: Readonly<Record<Weekday, readonly string[]>>;
  readonly offdays: readonly string[];
  readonly workdays: readonly string[];
}

function strList(x: unknown): readonly string[] {
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : [];
}

export async function getAgentWorkingSchedule(deps: AdapterDeps, soa: SoaClient, venAgentUid: string): Promise<ReadResult<WorkingSchedule>> {
  const outcome = await soa.post<{ workingSchedule?: unknown }>(Endpoints.AGENT_WORKING_SCHEDULE, { head: businessHead(deps.context), locale: deps.context.locale, venAgentUid });
  if (outcome.kind !== 'success') return { kind: 'failed', outcome };
  if (!isBizSuccess(outcome.body)) return { kind: 'biz_failure', raw: outcome.body };
  const ws = recordOrNull(outcome.body.workingSchedule) ?? {};
  const days = {} as Record<Weekday, readonly string[]>;
  for (const d of WEEKDAYS) days[d] = strList(ws[d]);
  return {
    kind: 'ok',
    raw: outcome.body,
    value: {
      venAgentUid: typeof ws['venAgentUid'] === 'string' ? (ws['venAgentUid'] as string) : null,
      timeZone: typeof ws['timeZone'] === 'string' ? (ws['timeZone'] as string) : null,
      timeZoneDisplayName: typeof ws['timeZoneDisplayName'] === 'string' ? (ws['timeZoneDisplayName'] as string) : null,
      days,
      offdays: strList(ws['offdays']),
      workdays: strList(ws['workdays']),
    },
  };
}

export interface VenAgentInfo {
  readonly venAgent: Readonly<Record<string, unknown>> | null;
  readonly venAgentOption: Readonly<Record<string, unknown>> | null;
}

export async function getVenAgentByUid(deps: AdapterDeps, soa: SoaClient): Promise<ReadResult<VenAgentInfo>> {
  const outcome = await soa.post<{ venAgent?: unknown; venAgentOption?: unknown }>(Endpoints.VEN_AGENT_BY_UID, { head: businessHead(deps.context) });
  if (outcome.kind !== 'success') return { kind: 'failed', outcome };
  return { kind: 'ok', raw: outcome.body, value: { venAgent: recordOrNull(outcome.body.venAgent), venAgentOption: recordOrNull(outcome.body.venAgentOption) } };
}

/**
 * Reads `venAgentOption.agentOption.venOptionList[]` for an option code
 * (e.g. `automatic_translation` → `'Y'`/`'N'`); `null` when absent.
 * The nesting was observed once; the accessor tolerates missing levels.
 */
export function venOptionValue(info: VenAgentInfo, optionCode: string): string | null {
  const agentOption = recordOrNull(info.venAgentOption?.['agentOption']);
  const list = agentOption?.['venOptionList'];
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    const r = recordOrNull(item);
    if (!r) continue;
    const code = r['optionCode'] ?? r['code'] ?? r['name'];
    if (code === optionCode) return typeof r['optionValue'] === 'string' ? (r['optionValue'] as string) : null;
  }
  return null;
}

export type SyncResult = { readonly kind: 'synced'; readonly readback: ReadResult<VenAgentInfo> } | { readonly kind: 'unknown'; readonly readback: ReadResult<VenAgentInfo> } | { readonly kind: 'failed'; readonly outcome: SoaOutcome<unknown> };

/** Write `{head}` then always read back; an unknown write outcome is reported together with the read-back. */
export async function syncVenAgentInfo(deps: AdapterDeps, soa: SoaClient): Promise<SyncResult> {
  const outcome = await soa.post<unknown>(Endpoints.SYNC_VEN_AGENT_INFO, { head: businessHead(deps.context) });
  if (outcome.kind === 'success') return { kind: 'synced', readback: await getVenAgentByUid(deps, soa) };
  if (outcome.kind === 'unknown') return { kind: 'unknown', readback: await getVenAgentByUid(deps, soa) };
  return { kind: 'failed', outcome };
}

/** `16037/getCustomerScripts` `{head, content}` → `customerScripts[]` (raw rows). */
export async function getCustomerScripts(deps: AdapterDeps, soa: SoaClient, content: string): Promise<ReadResult<readonly Readonly<Record<string, unknown>>[]>> {
  const outcome = await soa.post<{ customerScripts?: unknown }>(Endpoints.CUSTOMER_SCRIPTS, { head: businessHead(deps.context), content });
  if (outcome.kind !== 'success') return { kind: 'failed', outcome };
  const list = Array.isArray(outcome.body.customerScripts) ? outcome.body.customerScripts : [];
  return { kind: 'ok', raw: outcome.body, value: list.map((x) => recordOrNull(x)).filter((x): x is Record<string, unknown> => x !== null) };
}

// ----------------------------------------------------------- quick replies (read)

/**
 * `16037/getCategories {head, typeList, categoryType:"CUSTOMSCRIPT", status:"ACTIVE"}`
 * (evidence 65-quick-replies-read; the observed `typeList` is `["VAGENT"]`).
 * Read only: create/edit/delete of quick replies belongs to I-26.
 * Response `categories[]`: `{id:number, name, code, subCategories[], customerScripts[{id:number, shortCut, content, type, sortNo}]}`.
 */
export const GET_CATEGORIES = endpoint('getCategories', M, '16037/getCategories', 'read');
export const QUICK_REPLY_CATEGORY_TYPE = 'CUSTOMSCRIPT';
export const QUICK_REPLY_STATUS = 'ACTIVE';
export const QUICK_REPLY_DEFAULT_TYPES: readonly string[] = ['VAGENT'];
export const QUICK_REPLY_MAX_DEPTH = 3;
export const QUICK_REPLY_MAX_SCRIPTS = 1000;
/** Typing-suggestion debounce (plan I-23 B2): one request per pause, not per keystroke. */
export const SCRIPT_SUGGEST_DEBOUNCE_MS = 200;

export interface QuickReplyScript {
  /** Numeric on the wire; kept as a decimal string. */
  readonly id: string;
  readonly content: string;
  readonly shortCut: string;
  readonly sortNo: number;
}

export interface QuickReplyCategory {
  readonly id: string;
  readonly name: string;
  readonly code: string | null;
  readonly scripts: readonly QuickReplyScript[];
  readonly subCategories: readonly QuickReplyCategory[];
}

function idText(x: unknown): string | null {
  if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) return String(x);
  if (typeof x === 'string' && /^\d{1,19}$/.test(x)) return x;
  return null;
}

/** Row → script; rows without a numeric id or a non-empty string `content` are dropped (never repaired). */
export function parseQuickReplyScript(row: unknown): QuickReplyScript | null {
  const r = recordOrNull(row);
  if (!r) return null;
  const id = idText(r['id']);
  const content = r['content'];
  if (id === null || typeof content !== 'string' || content.trim() === '') return null;
  return {
    id,
    content,
    shortCut: typeof r['shortCut'] === 'string' ? (r['shortCut'] as string) : '',
    sortNo: typeof r['sortNo'] === 'number' && Number.isFinite(r['sortNo']) ? (r['sortNo'] as number) : 0,
  };
}

export function parseQuickReplyCategories(list: unknown, depth = 0, budget: { left: number } = { left: QUICK_REPLY_MAX_SCRIPTS }): QuickReplyCategory[] {
  if (!Array.isArray(list) || depth >= QUICK_REPLY_MAX_DEPTH) return [];
  const out: QuickReplyCategory[] = [];
  for (const item of list) {
    const r = recordOrNull(item);
    const id = idText(r?.['id']);
    if (!r || id === null || typeof r['name'] !== 'string') continue;
    const scripts: QuickReplyScript[] = [];
    if (Array.isArray(r['customerScripts'])) {
      for (const s of r['customerScripts']) {
        if (budget.left <= 0) break;
        const parsed = parseQuickReplyScript(s);
        if (parsed) {
          scripts.push(parsed);
          budget.left--;
        }
      }
    }
    scripts.sort((a, b) => a.sortNo - b.sortNo);
    out.push({
      id,
      name: r['name'] as string,
      code: typeof r['code'] === 'string' && r['code'] !== '' ? (r['code'] as string) : null,
      scripts,
      subCategories: parseQuickReplyCategories(r['subCategories'], depth + 1, budget),
    });
  }
  return out;
}

export function quickReplyCategoriesBody(deps: AdapterDeps, typeList: readonly string[] = QUICK_REPLY_DEFAULT_TYPES): Record<string, unknown> {
  return { head: businessHead(deps.context), typeList: [...typeList], categoryType: QUICK_REPLY_CATEGORY_TYPE, status: QUICK_REPLY_STATUS };
}

export async function getQuickReplyCategories(deps: AdapterDeps, soa: SoaClient, typeList: readonly string[] = QUICK_REPLY_DEFAULT_TYPES): Promise<ReadResult<readonly QuickReplyCategory[]>> {
  if (typeList.length === 0 || !typeList.every((t) => /^[A-Z_]{1,32}$/.test(t))) return { kind: 'failed', outcome: { kind: 'malformed', detail: 'invalid typeList' } };
  const outcome = await soa.post<{ categories?: unknown }>(GET_CATEGORIES, quickReplyCategoriesBody(deps, typeList));
  if (outcome.kind !== 'success') return { kind: 'failed', outcome };
  if (!Array.isArray(outcome.body.categories)) return { kind: 'failed', outcome: { kind: 'malformed', detail: 'missing categories array' } };
  return { kind: 'ok', raw: outcome.body, value: parseQuickReplyCategories(outcome.body.categories) };
}

export interface ScriptSuggestion {
  readonly query: string;
  readonly result: ReadResult<readonly QuickReplyScript[]>;
}

export interface ScriptSuggester {
  /** Latest query wins; a pause of 200 ms triggers exactly one `getCustomerScripts`. Empty query only cancels. */
  query(content: string): void;
  cancel(): void;
}

/**
 * Typing-time suggestion over `getCustomerScripts {content}`. The official page
 * sends one request per character (round 3); this debounces to one per pause
 * and drops answers for superseded queries. Row shape beyond the
 * `getCategories` sample is unproven, so rows failing `parseQuickReplyScript`
 * are dropped, never repaired.
 */
export function createScriptSuggester(deps: AdapterDeps, soa: SoaClient, onSuggestion: (s: ScriptSuggestion) => void): ScriptSuggester {
  let timer: TimerHandle | null = null;
  let generation = 0;
  const clear = (): void => {
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
  };
  return {
    query(content) {
      clear();
      const mine = ++generation;
      if (content.trim() === '') return;
      timer = deps.setTimeout(() => {
        timer = null;
        void getCustomerScripts(deps, soa, content).then((r) => {
          if (mine !== generation) return;
          const result: ReadResult<readonly QuickReplyScript[]> =
            r.kind === 'ok' ? { kind: 'ok', raw: r.raw, value: r.value.map(parseQuickReplyScript).filter((x): x is QuickReplyScript => x !== null) } : r;
          onSuggestion({ query: content, result });
        });
      }, SCRIPT_SUGGEST_DEBOUNCE_MS);
    },
    cancel() {
      clear();
      generation++;
    },
  };
}
