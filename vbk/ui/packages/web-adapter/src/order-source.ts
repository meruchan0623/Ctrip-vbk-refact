/** Official imExtraInfo sidebar source, verified 2026-11-03. This is separate
 * from paginated chat history; its latest CTL01 may be many pages earlier. */
import type { AdapterDeps } from './deps.ts';
import { Endpoints } from './endpoints.ts';
import { platformHead } from './heads.ts';
import { orderSummaryFromMessage } from './display.ts';
import { recordOrNull, type SoaClient } from './soa.ts';
import type { UiOrderSummary } from '../../ipc/src/client.ts';

export type OrderSourceResult = { readonly kind: 'order'; readonly order: UiOrderSummary } | { readonly kind: 'denied' } | { readonly kind: 'empty' } | { readonly kind: 'unavailable' };

export async function fetchOrderSource(deps: AdapterDeps, soa: SoaClient, gid: string, orderId: string | null): Promise<OrderSourceResult> {
  const result = await soa.post<unknown>(Endpoints.VBK_IM_USER_INFO, { head: platformHead(deps.context), gid, locale: deps.context.locale }, { timeoutMs: 8000 });
  if (result.kind !== 'success') return { kind: 'unavailable' };
  const data = recordOrNull(recordOrNull(result.body)?.['data']);
  const source = recordOrNull(data?.['sourceTraceInfo']);
  if (source?.['hasSourceTracePrivilege'] === false) return { kind: 'denied' };
  if (source?.['hasSourceTracePrivilege'] !== true) return { kind: 'unavailable' };
  if (Object.hasOwn(source, 'lastSourceTrace')) {
    const raw = source['lastSourceTrace'], value = recordOrNull(raw);
    if (raw === null || value && Object.keys(value).length === 0) return { kind: 'empty' };
  }
  const latest = recordOrNull(source['lastSourceTrace']);
  const order = orderSummaryFromMessage({ msgtype: 7, messageBody: latest?.['msg'] });
  return order && (orderId === null || order.order_id === orderId) ? { kind: 'order', order } : { kind: 'unavailable' };
}
