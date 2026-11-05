/**
 * Quick-reply management (I-26): category and script writes exactly as the
 * official personal-settings dialog sends them (static call sites in the
 * official desktop renderer; see docs/decisions/2026-11-05-quick-reply-manage.md).
 *
 * Every write follows the same shape and never replays:
 *   1. pre-read (`getCategories` for the one type, plus the leader check and
 *      the skill-group list for team writes) — the target, its `code`,
 *      `ownerType` and current content come from this read, never from the UI;
 *      a missing target is `rejected('stale')` and nothing is sent;
 *   2. exactly one write request (SoaClient never retries writes);
 *   3. read back `getCategories` and prove the intended change.
 *
 * Outcome: `applied` only when the read-back proves the change; `rejected`
 * when nothing was sent or the server refused (Ack `Failure`, or a business
 * result code with a read-back that proves the target is exactly as before);
 * everything else is `unknown` — the caller shows the read-back and asks the
 * user to check, never resubmits.
 */

import type { AdapterDeps } from './deps.ts';
import { Endpoints } from './endpoints.ts';
import { businessHead } from './heads.ts';
import { bizResultCode, recordOrNull, type EndpointSpec, type SoaClient, type SoaOutcome } from './soa.ts';
import { GET_CATEGORIES, idText, parseQuickReplyCategories, parseSkillGroups, quickReplyCategoriesBody, QUICK_REPLY_CATEGORY_TYPE, QUICK_REPLY_MAX_DEPTH, QUICK_REPLY_STATUS, type QuickReplyCategory, type QuickReplySkillGroup } from './settings.ts';

export type QuickReplyType = 'VAGENT' | 'VSKILLGROUP';

export type QuickReplyEdit =
  | { readonly op: 'create_category'; readonly name: string; readonly skill_group_ids: readonly string[] }
  | { readonly op: 'update_category'; readonly category_id: string; readonly name: string; readonly skill_group_ids: readonly string[] }
  | { readonly op: 'delete_category'; readonly category_id: string }
  | { readonly op: 'sort_categories'; readonly category_ids: readonly string[] }
  | { readonly op: 'add_script'; readonly category_id: string; readonly content: string }
  | { readonly op: 'update_script'; readonly script_id: string; readonly content: string }
  | { readonly op: 'move_script'; readonly script_id: string; readonly target_category_id: string }
  | { readonly op: 'delete_script'; readonly script_id: string }
  | { readonly op: 'sort_scripts'; readonly category_id: string; readonly script_ids: readonly string[] };

export type QuickReplyEditOp = QuickReplyEdit['op'];

/**
 * Protocol reason codes (the UI maps them to copy):
 * - `invalid`: request failed local validation, nothing sent
 * - `stale`: target / skill group not in the fresh pre-read, nothing sent
 * - `not_leader`: team write by a non-leader, nothing sent
 * - `busy`: another write of this account is in flight, nothing sent
 * - `not_submitted`: a pre-read failed or the page session changed, nothing sent
 * - `auth`: login expired
 * - `business`: server refused
 * - `write_unknown`: the write got no classified answer
 * - `readback_failed`: the write was answered but the read-back failed
 * - `unverified`: the read-back does not prove the change
 */
export type QuickReplyEditReason = 'invalid' | 'stale' | 'not_leader' | 'busy' | 'not_submitted' | 'auth' | 'business' | 'write_unknown' | 'readback_failed' | 'unverified';

export interface QuickReplyEditOutcome {
  readonly kind: 'applied' | 'rejected' | 'unknown';
  readonly reason?: QuickReplyEditReason;
  /** First server error code of an Ack failure (no message text). */
  readonly detail?: string;
  /** Fresh read-back (or the pre-read when nothing was sent); absent when no read succeeded. */
  readonly categories?: readonly QuickReplyCategory[];
}

export interface QuickReplyManageInfo {
  readonly can_edit: boolean;
  readonly skill_groups: readonly QuickReplySkillGroup[];
}

export const LEADER_JOB_POSITION = 'LEADER';
export const CATEGORY_NAME_MAX = 15;
export const SCRIPT_CONTENT_MAX = 5000;
export const ID_LIST_MAX = 1000;
/**
 * Per-request budgets. Pre-reads run in parallel and a read may retry once
 * after a transport error (SoaClient), so the worst case is 2*3 + 6 + 2*3 =
 * 18 s, inside the host's 20 s write wait (`adapter.rs` WRITE_TIMEOUT).
 */
export const PRE_READ_TIMEOUT_MS = 3000;
export const WRITE_REQUEST_TIMEOUT_MS = 6000;
export const READ_BACK_TIMEOUT_MS = 3000;
/** `detail` carries only a short machine code (never server message text). */
const DETAIL_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const RAW_SCAN_MAX = 5000;

const ID_RE = /^\d{1,19}$/;

/** UTF-16 length, the same unit the host validates with `encode_utf16().count()`. */
function units(s: string): number {
  return s.length;
}

export function validateEdit(type: QuickReplyType, edit: QuickReplyEdit): boolean {
  const id = (x: unknown): boolean => typeof x === 'string' && ID_RE.test(x);
  const ids = (x: unknown): boolean => Array.isArray(x) && x.length >= 1 && x.length <= ID_LIST_MAX && x.every(id) && new Set(x).size === x.length;
  const name = (x: unknown): boolean => typeof x === 'string' && x.trim() !== '' && units(x.trim()) <= CATEGORY_NAME_MAX;
  const content = (x: unknown): boolean => typeof x === 'string' && x.trim() !== '' && units(x) <= SCRIPT_CONTENT_MAX;
  const groups = (x: unknown): boolean => Array.isArray(x) && x.length <= ID_LIST_MAX && x.every(id) && new Set(x).size === x.length && (type === 'VAGENT' ? x.length === 0 : x.length >= 1);
  switch (edit.op) {
    case 'create_category': return name(edit.name) && groups(edit.skill_group_ids);
    case 'update_category': return id(edit.category_id) && name(edit.name) && groups(edit.skill_group_ids);
    case 'delete_category': return id(edit.category_id);
    case 'sort_categories': return ids(edit.category_ids);
    case 'add_script': return id(edit.category_id) && content(edit.content);
    case 'update_script': return id(edit.script_id) && content(edit.content);
    case 'move_script': return id(edit.script_id) && id(edit.target_category_id);
    case 'delete_script': return id(edit.script_id);
    case 'sort_scripts': return id(edit.category_id) && ids(edit.script_ids);
    default: return false;
  }
}

// ------------------------------------------------------------------ raw index

interface RawCategory {
  readonly id: string;
  readonly rawId: unknown;
  readonly name: string | null;
  readonly code: string | null;
  readonly ownerType: unknown;
  readonly root: boolean;
  /** Direct sub-category IDs (wire order). */
  readonly children: readonly string[];
  /** Script IDs in display order (sortNo ascending, ties in wire order). */
  readonly scripts: readonly string[];
  readonly skillGroups: readonly string[] | null;
  /** Skill-group ID → its raw wire value, so an update can resend a scope entry the leader list does not show. */
  readonly skillGroupRaw: ReadonlyMap<string, unknown>;
}

interface RawScript {
  readonly id: string;
  readonly rawId: unknown;
  readonly category: string;
  readonly content: string | null;
}

/**
 * Proof-oriented index of one `getCategories` answer. Unlike the display
 * parser it keeps every row, and `complete` turns false when anything could
 * hide a row (unparsable IDs, depth past the display limit, oversized lists):
 * absence and order are only proven on a complete index.
 */
export interface RawIndex {
  readonly categories: ReadonlyMap<string, RawCategory>;
  readonly scripts: ReadonlyMap<string, RawScript>;
  readonly rootOrder: readonly string[];
  readonly complete: boolean;
}

export function indexCategories(list: unknown): RawIndex {
  const categories = new Map<string, RawCategory>();
  const scripts = new Map<string, RawScript>();
  const rootOrder: string[] = [];
  let complete = Array.isArray(list);
  let scanned = 0;
  const walk = (items: unknown, depth: number, parent: string[] | null): void => {
    if (!Array.isArray(items)) return;
    if (depth >= QUICK_REPLY_MAX_DEPTH) {
      if (items.length > 0) complete = false;
      return;
    }
    for (const item of items) {
      if (++scanned > RAW_SCAN_MAX) { complete = false; return; }
      const r = recordOrNull(item);
      const id = idText(r?.['id']);
      if (!r || id === null || categories.has(id)) { complete = false; continue; }
      const rows: { id: string; sortNo: number; at: number }[] = [];
      const rawScripts = r['customerScripts'];
      if (rawScripts !== undefined && rawScripts !== null && !Array.isArray(rawScripts)) complete = false;
      if (Array.isArray(rawScripts)) {
        rawScripts.forEach((row, at) => {
          if (++scanned > RAW_SCAN_MAX) { complete = false; return; }
          const s = recordOrNull(row);
          const sid = idText(s?.['id']);
          if (!s || sid === null || scripts.has(sid)) { complete = false; return; }
          const sortNo = typeof s['sortNo'] === 'number' && Number.isFinite(s['sortNo']) ? (s['sortNo'] as number) : 0;
          scripts.set(sid, { id: sid, rawId: s['id'], category: id, content: typeof s['content'] === 'string' ? (s['content'] as string) : null });
          rows.push({ id: sid, sortNo, at });
        });
      }
      rows.sort((a, b) => a.sortNo - b.sortNo || a.at - b.at);
      const groups = r['vSkillGroups'];
      const groupRaw = new Map<string, unknown>();
      if (Array.isArray(groups)) {
        for (const g of groups.slice(0, 200)) {
          const gr = recordOrNull(g);
          const gid = idText(gr?.['skillGroupId']);
          if (gr && gid !== null && !groupRaw.has(gid)) groupRaw.set(gid, gr['skillGroupId']);
        }
      }
      const children: string[] = [];
      categories.set(id, {
        id,
        rawId: r['id'],
        name: typeof r['name'] === 'string' ? (r['name'] as string) : null,
        code: typeof r['code'] === 'string' && r['code'] !== '' ? (r['code'] as string) : null,
        ownerType: r['ownerType'],
        root: depth === 0,
        children,
        scripts: rows.map((x) => x.id),
        skillGroups: Array.isArray(groups) ? [...groupRaw.keys()] : null,
        skillGroupRaw: groupRaw,
      });
      if (depth === 0) rootOrder.push(id);
      parent?.push(id);
      walk(r['subCategories'], depth + 1, children);
    }
  };
  walk(list, 0, null);
  return { categories, scripts, rootOrder, complete };
}

// ------------------------------------------------------------------ wire helpers

/** Numeric wire ID: the pre-read value when it is already a safe number, else a checked conversion. */
function numericId(raw: unknown, text: string): number | null {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && String(raw) === text) return raw;
  const n = Number(text);
  return Number.isSafeInteger(n) && String(n) === text ? n : null;
}

interface ReadOk {
  readonly kind: 'ok';
  readonly index: RawIndex;
  readonly categories: readonly QuickReplyCategory[];
}
type ReadFail = { readonly kind: 'failed'; readonly outcome: SoaOutcome<unknown> };

async function readCategories(deps: AdapterDeps, soa: SoaClient, type: QuickReplyType, timeoutMs: number): Promise<ReadOk | ReadFail> {
  const outcome = await soa.post<{ categories?: unknown }>(GET_CATEGORIES, quickReplyCategoriesBody(deps, [type]), { timeoutMs });
  if (outcome.kind !== 'success') return { kind: 'failed', outcome };
  const list = outcome.body.categories;
  if (!Array.isArray(list)) return { kind: 'failed', outcome: { kind: 'malformed', detail: 'missing categories array' } };
  return { kind: 'ok', index: indexCategories(list), categories: parseQuickReplyCategories(list) };
}

type LeaderRead = { readonly kind: 'ok'; readonly leader: boolean } | ReadFail;

async function readLeader(deps: AdapterDeps, soa: SoaClient, timeoutMs: number): Promise<LeaderRead> {
  const outcome = await soa.post<{ venAgent?: unknown }>(Endpoints.VEN_AGENT_BY_UID, { head: businessHead(deps.context) }, { timeoutMs });
  if (outcome.kind !== 'success') return { kind: 'failed', outcome };
  return { kind: 'ok', leader: recordOrNull(outcome.body.venAgent)?.['jobPosition'] === LEADER_JOB_POSITION };
}

type GroupsRead = { readonly kind: 'ok'; readonly groups: readonly QuickReplySkillGroup[]; readonly raw: ReadonlyMap<string, unknown> } | ReadFail;

/** `getSkillGroupInfoByVenAgent {head, agentUid: buid}` → `vskillGroupInfos[]`. */
async function readSkillGroups(deps: AdapterDeps, soa: SoaClient, buid: string, timeoutMs: number): Promise<GroupsRead> {
  const outcome = await soa.post<{ vskillGroupInfos?: unknown }>(Endpoints.SKILL_GROUP_INFO_BY_VEN_AGENT, { head: businessHead(deps.context), agentUid: buid }, { timeoutMs });
  if (outcome.kind !== 'success') return { kind: 'failed', outcome };
  const rows = Array.isArray(outcome.body.vskillGroupInfos) ? outcome.body.vskillGroupInfos : [];
  const raw = new Map<string, unknown>();
  for (const row of rows.slice(0, 200)) {
    const r = recordOrNull(row);
    const id = idText(r?.['skillGroupId']);
    if (r && id !== null && !raw.has(id)) raw.set(id, r['skillGroupId']);
  }
  return { kind: 'ok', groups: parseSkillGroups(rows), raw };
}

export interface ManageDeps {
  readonly deps: AdapterDeps;
  readonly soa: SoaClient;
  /** Platform buid (`getCurrentUserInfo.user.buid`), not the IM uid; `null` disables team skill groups. */
  readonly buid: string | null;
  /** Captured page lifecycle guard; false once the session changed. */
  readonly current: () => boolean;
  /**
   * Receives the write's HTTP exchange, which may outlive the request budget
   * (a timed-out write is still in flight): the caller keeps its write lock
   * until it settles so a later write cannot overtake it on the server.
   */
  readonly onWriteInFlight?: (settled: Promise<void>) => void;
}

export async function quickReplyManageInfo(m: ManageDeps, type: QuickReplyType): Promise<QuickReplyManageInfo | ReadFail> {
  if (type === 'VAGENT') return { can_edit: true, skill_groups: [] };
  const [leader, groups] = await Promise.all([
    readLeader(m.deps, m.soa, PRE_READ_TIMEOUT_MS),
    m.buid ? readSkillGroups(m.deps, m.soa, m.buid, PRE_READ_TIMEOUT_MS) : Promise.resolve(null),
  ]);
  if (leader.kind !== 'ok') return leader;
  return { can_edit: leader.leader, skill_groups: groups?.kind === 'ok' ? groups.groups : [] };
}

// ------------------------------------------------------------------ write

type Plan =
  | { readonly kind: 'refuse'; readonly reason: QuickReplyEditReason }
  | {
    readonly kind: 'send';
    readonly spec: EndpointSpec;
    readonly body: Record<string, unknown>;
    /** The read-back proves the change. `answered`: the write got an Ack Success (a new row then needs no uniqueness). */
    readonly verify: (after: RawIndex, answered: boolean) => boolean;
    /** The read-back proves the target is exactly as before (only then can a business refusal be `rejected`). */
    readonly unchanged: (after: RawIndex) => boolean;
  };

const sameText = (a: string | null, b: string): boolean => a !== null && a.trim() === b.trim();
const sameSet = (a: readonly string[] | null, b: readonly string[]): boolean => a !== null && a.length === b.length && b.every((x) => a.includes(x));
const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The category, its sub-categories and every script under them (all IDs that a delete removes). */
function subtree(index: RawIndex, root: RawCategory): { readonly categories: string[]; readonly scripts: string[] } {
  const categories: string[] = [];
  const scripts: string[] = [];
  const stack: RawCategory[] = [root];
  while (stack.length > 0) {
    const c = stack.pop()!;
    categories.push(c.id);
    scripts.push(...c.scripts);
    for (const child of c.children) {
      const sub = index.categories.get(child);
      if (sub) stack.push(sub);
    }
  }
  return { categories, scripts };
}

function planWrite(m: ManageDeps, type: QuickReplyType, edit: QuickReplyEdit, before: RawIndex, groups: ReadonlyMap<string, unknown> | null): Plan {
  const head = businessHead(m.deps.context);
  const refuse = (reason: QuickReplyEditReason): Plan => ({ kind: 'refuse', reason });
  const rootCategory = (id: string): RawCategory | null => {
    const c = before.categories.get(id);
    return c && c.root ? c : null;
  };
  /** Raw skill-group values: the leader's list first, then (update only) the category's current scope. */
  const groupValues = (ids: readonly string[], current?: ReadonlyMap<string, unknown>): unknown[] | null => {
    const out: unknown[] = [];
    for (const id of ids) {
      if (groups?.has(id)) out.push(groups.get(id));
      else if (current?.has(id)) out.push(current.get(id));
      else return null;
    }
    return out;
  };
  const sameScope = (c: RawCategory, ids: readonly string[]): boolean => type === 'VAGENT' || sameSet(c.skillGroups, ids);
  /** New root rows carrying `name` (and, for a team, the submitted scope). */
  const freshRoots = (after: RawIndex, name: string, scope: readonly string[]): RawCategory[] =>
    [...after.categories.values()].filter((c) => c.root && !before.categories.has(c.id) && sameText(c.name, name) && sameScope(c, scope));
  // an unanswered write needs exactly one new matching row: two could be someone else's as well
  const proven = (n: number, answered: boolean): boolean => (answered ? n >= 1 : n === 1);
  switch (edit.op) {
    case 'create_category': {
      const values = groupValues(edit.skill_group_ids);
      if (!values) return refuse('stale');
      const name = edit.name.trim();
      return {
        kind: 'send', spec: Endpoints.CREATE_ROOT_CATEGORY,
        body: { head, name, type: QUICK_REPLY_CATEGORY_TYPE, status: QUICK_REPLY_STATUS, ownerType: type, vSkillGroupIds: values },
        // the official dialog ignores the answer and re-reads; the new row is the one that was not there
        // before, which only a complete pre-read can show
        verify: (after, answered) => before.complete && proven(freshRoots(after, name, edit.skill_group_ids).length, answered),
        unchanged: (after) => before.complete && after.complete && [...after.categories.values()].every((c) => !c.root || before.categories.has(c.id)),
      };
    }
    case 'update_category': {
      const c = rootCategory(edit.category_id);
      const id = c ? numericId(c.rawId, c.id) : null;
      const values = c ? groupValues(edit.skill_group_ids, c.skillGroupRaw) : null;
      if (!c || id === null || !values) return refuse('stale');
      const name = edit.name.trim();
      return {
        kind: 'send', spec: Endpoints.UPDATE_CATEGORY,
        body: { head, id, name, status: QUICK_REPLY_STATUS, vSkillGroupIds: values },
        verify: (after) => {
          const a = after.categories.get(c.id);
          return !!a && sameText(a.name, name) && sameScope(a, edit.skill_group_ids);
        },
        unchanged: (after) => {
          const a = after.categories.get(c.id);
          return !!a && a.name === c.name && (type === 'VAGENT' || (c.skillGroups !== null && sameSet(a.skillGroups, c.skillGroups)));
        },
      };
    }
    case 'delete_category': {
      const c = rootCategory(edit.category_id);
      const id = c ? numericId(c.rawId, c.id) : null;
      if (!c || id === null) return refuse('stale');
      // the official dialog deletes the category with everything under it; prove the whole subtree is gone
      const gone = subtree(before, c);
      return {
        kind: 'send', spec: Endpoints.DELETE_CATEGORY,
        body: c.ownerType === undefined ? { head, id } : { head, id, ownerType: c.ownerType },
        verify: (after) => after.complete && gone.categories.every((x) => !after.categories.has(x)) && gone.scripts.every((x) => !after.scripts.has(x)),
        // presence needs no complete index
        unchanged: (after) => gone.categories.every((x) => after.categories.has(x)) && gone.scripts.every((x) => after.scripts.has(x)),
      };
    }
    case 'sort_categories': {
      if (!before.complete || !sameSet(before.rootOrder, edit.category_ids)) return refuse('stale');
      const list: { id: number; sortNo: number }[] = [];
      for (const [sortNo, text] of edit.category_ids.entries()) {
        const id = numericId(before.categories.get(text)?.rawId, text);
        if (id === null) return refuse('stale');
        list.push({ id, sortNo });
      }
      return {
        kind: 'send', spec: Endpoints.UPDATE_CATEGORY_SORT_NO,
        body: { head, categorySortList: list },
        verify: (after) => after.complete && sameOrder(after.rootOrder, edit.category_ids),
        unchanged: (after) => after.complete && sameOrder(after.rootOrder, before.rootOrder),
      };
    }
    case 'add_script': {
      // the editor offers root groups only; a sub-category target is not something the user picked
      const c = rootCategory(edit.category_id);
      if (!c || c.code === null) return refuse('stale');
      return {
        kind: 'send', spec: Endpoints.ADD_CUSTOMER_SCRIPT,
        // ownerType is echoed exactly as read, like the official dialog (`ownerType: category.ownerType`)
        body: { head, content: edit.content, ownerType: c.ownerType, categoryCode: c.code },
        verify: (after, answered) => before.complete && proven((after.categories.get(c.id)?.scripts ?? []).filter((s) => !before.scripts.has(s) && sameText(after.scripts.get(s)?.content ?? null, edit.content)).length, answered),
        unchanged: (after) => {
          const a = after.categories.get(c.id);
          return before.complete && after.complete && !!a && a.scripts.every((s) => before.scripts.has(s));
        },
      };
    }
    case 'update_script': {
      const s = before.scripts.get(edit.script_id);
      if (!s) return refuse('stale');
      return {
        kind: 'send', spec: Endpoints.UPDATE_CUSTOMER_SCRIPT,
        body: { head, content: edit.content, id: s.id },
        verify: (after) => sameText(after.scripts.get(s.id)?.content ?? null, edit.content),
        unchanged: (after) => after.scripts.get(s.id)?.content === s.content,
      };
    }
    case 'move_script': {
      const s = before.scripts.get(edit.script_id);
      const target = rootCategory(edit.target_category_id);
      if (!s || s.content === null || !target || target.code === null || s.category === target.id) return refuse('stale');
      return {
        kind: 'send', spec: Endpoints.UPDATE_CUSTOMER_SCRIPT,
        body: { head, id: s.id, content: s.content, categoryCode: target.code },
        // a duplicated ID makes the index incomplete and only its first row is kept: that row alone proves nothing
        verify: (after) => after.complete && after.scripts.get(s.id)?.category === target.id,
        unchanged: (after) => after.complete && after.scripts.get(s.id)?.category === s.category,
      };
    }
    case 'delete_script': {
      const s = before.scripts.get(edit.script_id);
      const id = s ? numericId(s.rawId, s.id) : null;
      if (!s || id === null) return refuse('stale');
      return {
        kind: 'send', spec: Endpoints.DELETE_CUSTOMER_SCRIPT,
        body: { head, id },
        verify: (after) => after.complete && !after.scripts.has(s.id),
        unchanged: (after) => after.scripts.has(s.id),
      };
    }
    case 'sort_scripts': {
      const c = rootCategory(edit.category_id);
      if (!c || !before.complete || !sameSet(c.scripts, edit.script_ids)) return refuse('stale');
      const list: { id: number; sortNo: number }[] = [];
      for (const [sortNo, text] of edit.script_ids.entries()) {
        const id = numericId(before.scripts.get(text)?.rawId, text);
        if (id === null) return refuse('stale');
        list.push({ id, sortNo });
      }
      return {
        kind: 'send', spec: Endpoints.UPDATE_CUSTOMER_SCRIPT_SORT,
        body: { head, sortInfos: list },
        verify: (after) => after.complete && sameOrder(after.categories.get(c.id)?.scripts ?? [], edit.script_ids),
        unchanged: (after) => {
          const a = after.categories.get(c.id);
          return after.complete && !!a && sameOrder(a.scripts, c.scripts);
        },
      };
    }
  }
}

function safeDetail(code: string | null | undefined): string | null {
  return typeof code === 'string' && DETAIL_RE.test(code) ? code : null;
}

function preReadFailure(outcome: SoaOutcome<unknown>): QuickReplyEditOutcome {
  return { kind: 'rejected', reason: outcome.kind === 'auth_invalid' ? 'auth' : 'not_submitted' };
}

/** One write with read-back; see the module comment for the outcome rules. Callers hold the per-account lock. */
export async function editQuickReplies(m: ManageDeps, type: QuickReplyType, edit: QuickReplyEdit): Promise<QuickReplyEditOutcome> {
  if (!validateEdit(type, edit)) return { kind: 'rejected', reason: 'invalid' };
  const team = type === 'VSKILLGROUP';
  // without a buid the skill-group list cannot be read; planWrite then refuses as `stale` after the leader check
  const needsGroups = team && (edit.op === 'create_category' || edit.op === 'update_category');
  const [before, leader, groups] = await Promise.all([
    readCategories(m.deps, m.soa, type, PRE_READ_TIMEOUT_MS),
    team ? readLeader(m.deps, m.soa, PRE_READ_TIMEOUT_MS) : Promise.resolve(null),
    needsGroups && m.buid ? readSkillGroups(m.deps, m.soa, m.buid, PRE_READ_TIMEOUT_MS) : Promise.resolve(null),
  ]);
  if (!m.current()) return { kind: 'rejected', reason: 'not_submitted' };
  if (before.kind !== 'ok') return preReadFailure(before.outcome);
  if (leader && leader.kind !== 'ok') return { ...preReadFailure(leader.outcome), categories: before.categories };
  if (leader && !leader.leader) return { kind: 'rejected', reason: 'not_leader', categories: before.categories };
  if (groups && groups.kind !== 'ok') return { ...preReadFailure(groups.outcome), categories: before.categories };

  const plan = planWrite(m, type, edit, before.index, groups?.kind === 'ok' ? groups.raw : null);
  if (plan.kind === 'refuse') return { kind: 'rejected', reason: plan.reason, categories: before.categories };
  if (!m.current()) return { kind: 'rejected', reason: 'not_submitted', categories: before.categories };

  const written = await m.soa.post<unknown>(plan.spec, plan.body, {
    timeoutMs: WRITE_REQUEST_TIMEOUT_MS,
    ...(m.onWriteInFlight ? { onExchange: m.onWriteInFlight } : {}),
  });
  if (written.kind === 'auth_invalid') return { kind: 'rejected', reason: 'auth', categories: before.categories };
  // Only an explicit `Failure` Ack is a refusal; any other non-Success Ack (a warning, say) proves nothing either way.
  if (written.kind === 'business_failure' && written.ack === 'Failure') {
    const code = safeDetail(written.errors[0]?.ErrorCode);
    return code ? { kind: 'rejected', reason: 'business', detail: code, categories: before.categories } : { kind: 'rejected', reason: 'business', categories: before.categories };
  }
  const answered = written.kind === 'success';
  if (!m.current()) return { kind: 'unknown', reason: answered ? 'readback_failed' : 'write_unknown' };

  const after = await readCategories(m.deps, m.soa, type, READ_BACK_TIMEOUT_MS);
  if (after.kind !== 'ok') return { kind: 'unknown', reason: answered ? 'readback_failed' : 'write_unknown' };
  if (!m.current()) return { kind: 'unknown', reason: answered ? 'readback_failed' : 'write_unknown' };
  if (plan.verify(after.index, answered)) return { kind: 'applied', categories: after.categories };
  if (written.kind !== 'success') return { kind: 'unknown', reason: 'write_unknown', categories: after.categories };
  const biz = bizResultCode(written.body);
  // An explicit business refusal plus a read-back proving the target untouched: the server refused.
  // A read-back that merely fails to prove the change (incomplete, partly changed) stays unknown.
  if (biz !== null && biz !== '' && biz !== 'SUCCESS' && plan.unchanged(after.index)) {
    const code = safeDetail(biz);
    return code ? { kind: 'rejected', reason: 'business', detail: code, categories: after.categories } : { kind: 'rejected', reason: 'business', categories: after.categories };
  }
  return { kind: 'unknown', reason: 'unverified', categories: after.categories };
}

/** Request args → typed edit; `null` when the shape is not one of the nine fixed variants. */
export function parseEdit(x: unknown): QuickReplyEdit | null {
  const r = recordOrNull(x);
  if (!r) return null;
  const str = (k: string): string | null => (typeof r[k] === 'string' ? (r[k] as string) : null);
  const list = (k: string): string[] | null => (Array.isArray(r[k]) && (r[k] as unknown[]).every((v) => typeof v === 'string') ? [...(r[k] as string[])] : null);
  const op = r['op'];
  switch (op) {
    case 'create_category': {
      const name = str('name'), groups = list('skill_group_ids');
      return name !== null && groups ? { op, name, skill_group_ids: groups } : null;
    }
    case 'update_category': {
      const id = str('category_id'), name = str('name'), groups = list('skill_group_ids');
      return id !== null && name !== null && groups ? { op, category_id: id, name, skill_group_ids: groups } : null;
    }
    case 'delete_category': {
      const id = str('category_id');
      return id !== null ? { op, category_id: id } : null;
    }
    case 'sort_categories': {
      const ids = list('category_ids');
      return ids ? { op, category_ids: ids } : null;
    }
    case 'add_script': {
      const id = str('category_id'), content = str('content');
      return id !== null && content !== null ? { op, category_id: id, content } : null;
    }
    case 'update_script': {
      const id = str('script_id'), content = str('content');
      return id !== null && content !== null ? { op, script_id: id, content } : null;
    }
    case 'move_script': {
      const id = str('script_id'), target = str('target_category_id');
      return id !== null && target !== null ? { op, script_id: id, target_category_id: target } : null;
    }
    case 'delete_script': {
      const id = str('script_id');
      return id !== null ? { op, script_id: id } : null;
    }
    case 'sort_scripts': {
      const id = str('category_id'), ids = list('script_ids');
      return id !== null && ids ? { op, category_id: id, script_ids: ids } : null;
    }
    default:
      return null;
  }
}
