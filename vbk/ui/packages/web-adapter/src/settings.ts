/**
 * Read-back helpers for agent settings. Shapes are kept as `unknown` with
 * narrow accessors because only one or two samples exist per endpoint and
 * nothing beyond the observed fields may be assumed.
 *
 * - `17092/listNoticeReceiveConfig` (online.ctrip.com) `{scene, head}` → `configList[]`
 * - `16037/getAgentWorkingSchedule` `{head, locale, venAgentUid}` → `workingSchedule`
 * - `16037/getVenAgentByUid` `{head}` → `venAgent`, `venAgentOption`
 * - `16037/syncVenAgentInfo` `{head}` (write; read back with getVenAgentByUid afterwards)
 */

import type { AdapterDeps } from './deps.ts';
import { Endpoints } from './endpoints.ts';
import { businessHead } from './heads.ts';
import { isBizSuccess, recordOrNull, type SoaClient, type SoaOutcome } from './soa.ts';

export type ReadResult<T> = { readonly kind: 'ok'; readonly value: T; readonly raw: unknown } | { readonly kind: 'failed'; readonly outcome: SoaOutcome<unknown> } | { readonly kind: 'biz_failure'; readonly raw: unknown };

export const NOTICE_SCENE_OBSERVED = 'vbk_notice_h5';

export interface NoticeReceiveConfig {
  readonly noticeCategoryCode: string;
  readonly noticeCategoryName: string;
  readonly noticeValueList: readonly string[];
}

export async function listNoticeReceiveConfig(deps: AdapterDeps, soa: SoaClient, scene: string = NOTICE_SCENE_OBSERVED): Promise<ReadResult<readonly NoticeReceiveConfig[]>> {
  const outcome = await soa.post<{ configList?: unknown }>(Endpoints.LIST_NOTICE_RECEIVE_CONFIG, { scene, head: businessHead(deps.context) });
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
