/**
 * Read-only identity of the logged-in merchant user, read from inside the
 * official page with the page's own cookies (`credentials: 'include'`).
 * Never reads passwords, cookies or tickets; only the documented identity
 * fields leave this module.
 *
 * Sources (docs/api/endpoints, evidence 01/54):
 * - `online.ctrip.com/12405/getCurrentUserInfo` body
 *   `{needMenu:false, needUserInfo:true, needPermission:true, needToolBar:false,
 *     needHeadBar:false, applicationCode:"vbk_online_new", head:<platform head>}`
 *   → `user.{buid, name, partyName}` (the static main bundle returns
 *   `response.user`; Ack Success alone is not enough — `buid` must be present).
 * - `m.ctrip.com/11679/GetMyInfo.json` `{head:<sdk head>}` → `jid`; the SDK
 *   sets its UID from this jid, so `uid = local part of jid`.
 * - `m.ctrip.com/16037/getVenAgentByUid` `{head:<business head>}` →
 *   `venAgent.{id, nickname}` (`agent_id`; optional).
 *
 * Bounded retries: each read is attempted up to `attempts` times with a
 * growing delay; auth failures are not retried (the user is not logged in).
 */

import type { AdapterIdentityPayload } from '../../ipc/src/adapterProtocol.ts';
import type { AdapterDeps } from './deps.ts';
import { Endpoints } from './endpoints.ts';
import { platformHead, sdkHead } from './heads.ts';
import { recordOrNull, type SoaClient, type SoaOutcome } from './soa.ts';
import { getVenAgentByUid } from './settings.ts';
import { jidLocal } from './facts.ts';

export const CURRENT_USER_APPLICATION_CODE = 'vbk_online_new';

export function currentUserInfoBody(deps: AdapterDeps): Record<string, unknown> {
  return {
    needMenu: false,
    needUserInfo: true,
    needPermission: true,
    needToolBar: false,
    needHeadBar: false,
    applicationCode: CURRENT_USER_APPLICATION_CODE,
    head: platformHead(deps.context),
  };
}

export type IdentityResult =
  | { readonly kind: 'ok'; readonly identity: AdapterIdentityPayload }
  | { readonly kind: 'auth_invalid' }
  | { readonly kind: 'failed'; readonly step: 'user' | 'im_uid'; readonly detail: string };

export interface IdentityOptions {
  readonly attempts?: number;
  readonly retryDelayMs?: number;
}

function s(x: unknown): string | null {
  return typeof x === 'string' && x.trim() !== '' ? x.trim() : null;
}

function delay(deps: AdapterDeps, ms: number): Promise<void> {
  return new Promise((resolve) => {
    deps.setTimeout(resolve, ms);
  });
}

async function withRetry<T>(deps: AdapterDeps, attempts: number, baseDelay: number, run: () => Promise<SoaOutcome<T>>): Promise<SoaOutcome<T>> {
  let last: SoaOutcome<T> = { kind: 'network_error', detail: 'not attempted' };
  for (let i = 0; i < attempts; i++) {
    last = await run();
    if (last.kind === 'success' || last.kind === 'auth_invalid') return last;
    if (i < attempts - 1) await delay(deps, baseDelay * (i + 1));
  }
  return last;
}

interface CurrentUserResponse {
  readonly user?: unknown;
}

interface MyInfoResponse {
  readonly jid?: unknown;
  readonly name?: unknown;
}

export async function readIdentity(deps: AdapterDeps, soa: SoaClient, opts: IdentityOptions = {}): Promise<IdentityResult> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const retryDelayMs = opts.retryDelayMs ?? 2000;

  const userOutcome = await withRetry(deps, attempts, retryDelayMs, () => soa.post<CurrentUserResponse>(Endpoints.CURRENT_USER_INFO, currentUserInfoBody(deps)));
  if (userOutcome.kind === 'auth_invalid') return { kind: 'auth_invalid' };
  if (userOutcome.kind !== 'success') return { kind: 'failed', step: 'user', detail: userOutcome.kind };
  const user = recordOrNull(userOutcome.body.user);
  const buid = s(user?.['buid']);
  if (!user || buid === null) return { kind: 'failed', step: 'user', detail: 'user.buid missing' };

  const myOutcome = await withRetry(deps, attempts, retryDelayMs, () => soa.post<MyInfoResponse>(Endpoints.MY_INFO, { head: sdkHead(deps.context) }));
  if (myOutcome.kind === 'auth_invalid') return { kind: 'auth_invalid' };
  if (myOutcome.kind !== 'success') return { kind: 'failed', step: 'im_uid', detail: myOutcome.kind };
  const jid = s(myOutcome.body.jid);
  const uid = jid ? jidLocal(jid) : null;
  if (!uid) return { kind: 'failed', step: 'im_uid', detail: 'jid missing' };

  // agent id / nickname are optional: a failure here does not block identity
  let agentId: string | null = null;
  let agentNick: string | null = null;
  const agent = await getVenAgentByUid(deps, soa);
  if (agent.kind === 'ok') {
    const v = agent.value.venAgent;
    const id = v?.['id'];
    agentId = typeof id === 'number' && Number.isFinite(id) ? String(id) : s(id);
    agentNick = s(v?.['nickname']);
  }

  return {
    kind: 'ok',
    identity: {
      buid,
      uid,
      agent_id: agentId,
      nick: s(user['name']) ?? agentNick ?? s(myOutcome.body.name) ?? buid,
      party: s(user['partyName']) ?? '',
      environment: 'production',
    },
  };
}
