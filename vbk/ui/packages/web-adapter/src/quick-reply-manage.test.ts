/**
 * Quick-reply management writes (I-26): exact official request bodies, the
 * pre-read / leader / skill-group gates, safe-integer wire IDs, read-back
 * proof, the per-page write lock and the lifecycle guard. Placeholder IDs and
 * text only; no real account data.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FetchResponseLike } from './deps.ts';
import { businessHead } from './heads.ts';
import {
  CATEGORY_NAME_MAX,
  editQuickReplies,
  ID_LIST_MAX,
  indexCategories,
  parseEdit,
  PRE_READ_TIMEOUT_MS,
  READ_BACK_TIMEOUT_MS,
  SCRIPT_CONTENT_MAX,
  validateEdit,
  WRITE_REQUEST_TIMEOUT_MS,
  type QuickReplyEdit,
  type QuickReplyEditOutcome,
  type QuickReplyType,
} from './quick-reply-manage.ts';
import { createRpc, QUICK_REPLY_WRITE_HOLD_MAX_MS, type RpcContext } from './rpc.ts';
import { SoaClient } from './soa.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { AUTH_FAILURE_STATUS, FAILURE_STATUS, FAKE_CONTEXT, FakePageSdk, jsonResponse, makeDeps, OK_STATUS, type FakeDeps, type FetchScript } from './testing.ts';

type Rec = Record<string, unknown>;
type Reply = FetchResponseLike | Promise<FetchResponseLike> | 'hang' | Error;

const BUID = 'buid-1';
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const HEAD = clone(businessHead(FAKE_CONTEXT));
const WRITE_ENDPOINTS = new Set([
  'createRootCategory',
  'updateCategory',
  'deleteCategory',
  'updateCategorySortNo',
  'addCustomerScript',
  'updateCustomerScript',
  'deleteCustomerScript',
  'updateCustomerScriptSort',
]);

const nameOf = (url: string): string => new URL(url).pathname.split('/').at(-1) ?? '';
/** Lets every already-resolved fake exchange settle (a macrotask runs after all microtasks). */
const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const ok = (extra: Rec = {}): FetchResponseLike => jsonResponse({ ResponseStatus: OK_STATUS, ...extra });
const readBody = (type: QuickReplyType): Rec => ({ head: HEAD, typeList: [type], categoryType: 'CUSTOMSCRIPT', status: 'ACTIVE' });

function personal(): Rec[] {
  return [
    { id: 101, code: 'cat-a', name: 'Group A', ownerType: 1, vSkillGroups: [], customerScripts: [{ id: 201, content: 'reply-a1', sortNo: 0 }, { id: 202, content: 'reply-a2', sortNo: 1 }] },
    // string wire ID: still sent as a number by the numeric endpoints
    { id: '102', code: 'cat-b', name: 'Group B', ownerType: 1, customerScripts: [{ id: 203, content: 'reply-b1', sortNo: 0 }] },
  ];
}

function team(): Rec[] {
  return [{ id: 301, code: 'team-a', name: 'Team A', ownerType: 2, vSkillGroups: [{ skillGroupId: 501, skillGroupName: 'SG1' }], customerScripts: [{ id: 401, content: 'team-reply', sortNo: 0 }] }];
}

function cat(list: Rec[], id: string): Rec {
  const found = list.find((c) => String(c['id']) === id);
  assert.ok(found, `fixture category ${id}`);
  return found;
}

function scriptsOf(c: Rec): Rec[] {
  return c['customerScripts'] as Rec[];
}

/** Minimal 16037 server: reads answer from `cats`; writes call `onWrite` (mutate `cats`, optionally replace the Ack Success reply). */
class FakeServer {
  cats: Rec[];
  jobPosition: unknown = 'LEADER';
  skillGroups: unknown[] = [{ skillGroupId: 501, skillGroupName: 'SG1' }, { skillGroupId: '502', skillGroupName: 'SG2' }];
  onWrite: (name: string, body: Rec) => Reply | undefined = () => undefined;
  /** Replaces the n-th (0-based) call of one endpoint; `undefined` falls through. */
  readonly override: Record<string, (n: number) => Reply | undefined> = {};
  readonly #counts = new Map<string, number>();

  constructor(cats: Rec[]) {
    this.cats = cats;
  }

  readonly script: FetchScript = (call) => {
    const name = nameOf(call.url);
    const n = this.#counts.get(name) ?? 0;
    this.#counts.set(name, n + 1);
    const forced = this.override[name]?.(n);
    if (forced !== undefined) return forced;
    if (name === 'getCategories') return ok({ categories: clone(this.cats) });
    if (name === 'getVenAgentByUid') return ok({ venAgent: { jobPosition: this.jobPosition } });
    if (name === 'getSkillGroupInfoByVenAgent') return ok({ vskillGroupInfos: this.skillGroups });
    assert.ok(WRITE_ENDPOINTS.has(name), `unexpected endpoint ${name}`);
    return this.onWrite(name, call.bodyJson as Rec) ?? ok();
  };
}

interface Call {
  readonly name: string;
  readonly url: string;
  readonly body: Rec;
}

const callsOf = (deps: FakeDeps): Call[] => deps.fakeFetch.calls.map((c) => ({ name: nameOf(c.url), url: c.url, body: c.bodyJson as Rec }));
const writesOf = (deps: FakeDeps): Call[] => callsOf(deps).filter((c) => WRITE_ENDPOINTS.has(c.name));

interface Opts {
  readonly buid?: string | null;
  readonly current?: () => boolean;
}

function start(srv: FakeServer, type: QuickReplyType, edit: QuickReplyEdit, opts: Opts = {}): { deps: FakeDeps; done: Promise<QuickReplyEditOutcome> } {
  const deps = makeDeps(srv.script);
  const done = editQuickReplies({ deps, soa: new SoaClient(deps), buid: opts.buid === undefined ? BUID : opts.buid, current: opts.current ?? (() => true) }, type, edit);
  return { deps, done };
}

async function run(srv: FakeServer, type: QuickReplyType, edit: QuickReplyEdit, opts: Opts = {}): Promise<{ out: QuickReplyEditOutcome; deps: FakeDeps; calls: Call[] }> {
  const { deps, done } = start(srv, type, edit, opts);
  const out = await done;
  return { out, deps, calls: callsOf(deps) };
}

const verdict = (out: QuickReplyEditOutcome): Rec => ({ kind: out.kind, ...(out.reason ? { reason: out.reason } : {}), ...(out.detail ? { detail: out.detail } : {}) });

// ------------------------------------------------------------------ request bodies

interface BodyCase {
  readonly edit: QuickReplyEdit;
  readonly endpoint: string;
  readonly body: Rec;
  readonly apply: (cats: Rec[]) => void;
}

test('every personal op sends exactly the official body to its own endpoint and is applied once the read-back proves it', async () => {
  const cases: BodyCase[] = [
    {
      edit: { op: 'create_category', name: '  New Group  ', skill_group_ids: [] },
      endpoint: 'createRootCategory',
      // type/status literal, ownerType is the string type, the personal scope list is empty
      body: { head: HEAD, name: 'New Group', type: 'CUSTOMSCRIPT', status: 'ACTIVE', ownerType: 'VAGENT', vSkillGroupIds: [] },
      apply: (cats) => { cats.push({ id: 103, code: 'cat-c', name: 'New Group', ownerType: 1, customerScripts: [] }); },
    },
    {
      edit: { op: 'update_category', category_id: '101', name: ' Renamed ', skill_group_ids: [] },
      endpoint: 'updateCategory',
      body: { head: HEAD, id: 101, name: 'Renamed', status: 'ACTIVE', vSkillGroupIds: [] },
      apply: (cats) => { cat(cats, '101')['name'] = 'Renamed'; },
    },
    {
      edit: { op: 'delete_category', category_id: '102' },
      endpoint: 'deleteCategory',
      // numeric ID even though the read returned '102'; ownerType is the read-back's raw number
      body: { head: HEAD, id: 102, ownerType: 1 },
      apply: (cats) => { cats.splice(1, 1); },
    },
    {
      edit: { op: 'sort_categories', category_ids: ['102', '101'] },
      endpoint: 'updateCategorySortNo',
      body: { head: HEAD, categorySortList: [{ id: 102, sortNo: 0 }, { id: 101, sortNo: 1 }] },
      apply: (cats) => { cats.reverse(); },
    },
    {
      edit: { op: 'add_script', category_id: '102', content: 'new reply' },
      endpoint: 'addCustomerScript',
      body: { head: HEAD, content: 'new reply', ownerType: 1, categoryCode: 'cat-b' },
      apply: (cats) => { scriptsOf(cat(cats, '102')).push({ id: 204, content: 'new reply', sortNo: 1 }); },
    },
    {
      edit: { op: 'update_script', script_id: '201', content: 'edited' },
      endpoint: 'updateCustomerScript',
      // string ID on this endpoint
      body: { head: HEAD, content: 'edited', id: '201' },
      apply: (cats) => { scriptsOf(cat(cats, '101'))[0]!['content'] = 'edited'; },
    },
    {
      edit: { op: 'move_script', script_id: '201', target_category_id: '102' },
      endpoint: 'updateCustomerScript',
      // the content comes from the pre-read, the target code from the target row
      body: { head: HEAD, id: '201', content: 'reply-a1', categoryCode: 'cat-b' },
      apply: (cats) => {
        const moved = scriptsOf(cat(cats, '101')).splice(0, 1);
        scriptsOf(cat(cats, '102')).push(...moved);
      },
    },
    {
      edit: { op: 'delete_script', script_id: '202' },
      endpoint: 'deleteCustomerScript',
      body: { head: HEAD, id: 202 },
      apply: (cats) => { scriptsOf(cat(cats, '101')).splice(1, 1); },
    },
    {
      edit: { op: 'sort_scripts', category_id: '101', script_ids: ['202', '201'] },
      endpoint: 'updateCustomerScriptSort',
      body: { head: HEAD, sortInfos: [{ id: 202, sortNo: 0 }, { id: 201, sortNo: 1 }] },
      apply: (cats) => {
        const [a, b] = scriptsOf(cat(cats, '101'));
        a!['sortNo'] = 1;
        b!['sortNo'] = 0;
      },
    },
  ];
  for (const c of cases) {
    const srv = new FakeServer(personal());
    srv.onWrite = () => { c.apply(srv.cats); return undefined; };
    const { out, calls } = await run(srv, 'VAGENT', c.edit);
    assert.deepEqual(verdict(out), { kind: 'applied' }, c.edit.op);
    // personal writes never ask for the leader or the skill groups
    assert.deepEqual(calls.map((x) => x.name), ['getCategories', c.endpoint, 'getCategories'], c.edit.op);
    assert.deepEqual(calls[0]!.body, readBody('VAGENT'));
    assert.deepEqual(calls[2]!.body, readBody('VAGENT'));
    const write = calls[1]!;
    assert.ok(write.url.startsWith(`https://m.ctrip.com/restapi/soa2/16037/${c.endpoint}?`), write.url);
    assert.deepEqual(write.body, c.body, c.edit.op);
    // the outcome hands the read-back to the UI
    assert.deepEqual(out.categories?.map((x) => x.id), srv.cats.map((x) => String(x['id'])), c.edit.op);
  }
});

test('team writes check the leader first, send the raw skill-group IDs and echo the numeric ownerType', async () => {
  const created = new FakeServer(team());
  created.onWrite = () => {
    created.cats.push({ id: 302, code: 'team-b', name: 'Team B', ownerType: 2, vSkillGroups: [{ skillGroupId: 502 }, { skillGroupId: 501 }], customerScripts: [] });
    return undefined;
  };
  const c = await run(created, 'VSKILLGROUP', { op: 'create_category', name: 'Team B', skill_group_ids: ['502', '501'] });
  assert.deepEqual(verdict(c.out), { kind: 'applied' });
  assert.deepEqual(c.calls.map((x) => x.name), ['getCategories', 'getVenAgentByUid', 'getSkillGroupInfoByVenAgent', 'createRootCategory', 'getCategories']);
  assert.deepEqual(c.calls[0]!.body, readBody('VSKILLGROUP'));
  assert.deepEqual(c.calls[1]!.body, { head: HEAD });
  assert.deepEqual(c.calls[2]!.body, { head: HEAD, agentUid: BUID });
  // skill-group IDs keep the exact value type the skill-group read returned ('502' string, 501 number), in submitted order
  assert.deepEqual(c.calls[3]!.body, { head: HEAD, name: 'Team B', type: 'CUSTOMSCRIPT', status: 'ACTIVE', ownerType: 'VSKILLGROUP', vSkillGroupIds: ['502', 501] });

  const updated = new FakeServer(team());
  updated.onWrite = () => {
    const row = cat(updated.cats, '301');
    row['name'] = 'Team A2';
    row['vSkillGroups'] = [{ skillGroupId: '502', skillGroupName: 'SG2' }];
    return undefined;
  };
  const u = await run(updated, 'VSKILLGROUP', { op: 'update_category', category_id: '301', name: 'Team A2', skill_group_ids: ['502'] });
  assert.deepEqual(verdict(u.out), { kind: 'applied' });
  assert.deepEqual(u.calls.map((x) => x.name), ['getCategories', 'getVenAgentByUid', 'getSkillGroupInfoByVenAgent', 'updateCategory', 'getCategories']);
  assert.deepEqual(u.calls[3]!.body, { head: HEAD, id: 301, name: 'Team A2', status: 'ACTIVE', vSkillGroupIds: ['502'] });

  // renamed but the scope did not change: the team update is not proven
  const scopeKept = new FakeServer(team());
  scopeKept.onWrite = () => { cat(scopeKept.cats, '301')['name'] = 'Team A2'; return undefined; };
  assert.deepEqual(verdict((await run(scopeKept, 'VSKILLGROUP', { op: 'update_category', category_id: '301', name: 'Team A2', skill_group_ids: ['502'] })).out), { kind: 'unknown', reason: 'unverified' });

  const deleted = new FakeServer(team());
  deleted.onWrite = () => { deleted.cats = []; return undefined; };
  const d = await run(deleted, 'VSKILLGROUP', { op: 'delete_category', category_id: '301' });
  assert.deepEqual(verdict(d.out), { kind: 'applied' });
  // only create/update need the skill-group list
  assert.deepEqual(d.calls.map((x) => x.name), ['getCategories', 'getVenAgentByUid', 'deleteCategory', 'getCategories']);
  assert.deepEqual(d.calls[2]!.body, { head: HEAD, id: 301, ownerType: 2 });

  const added = new FakeServer(team());
  added.onWrite = () => { scriptsOf(cat(added.cats, '301')).push({ id: 402, content: 'team new', sortNo: 1 }); return undefined; };
  const a = await run(added, 'VSKILLGROUP', { op: 'add_script', category_id: '301', content: 'team new' });
  assert.deepEqual(verdict(a.out), { kind: 'applied' });
  assert.deepEqual(a.calls[2]!.body, { head: HEAD, content: 'team new', ownerType: 2, categoryCode: 'team-a' });
});

test('deleteCategory and addCustomerScript echo the pre-read ownerType verbatim and omit it when the row has none', async () => {
  const rows = (): Rec[] => [
    { id: 101, code: 'cat-a', name: 'No owner', customerScripts: [] },
    { id: 102, code: 'cat-b', name: 'String owner', ownerType: 'VAGENT', customerScripts: [] },
  ];
  const noOwner = await run(new FakeServer(rows()), 'VAGENT', { op: 'delete_category', category_id: '101' });
  assert.deepEqual(noOwner.calls[1]!.body, { head: HEAD, id: 101 });
  assert.equal('ownerType' in noOwner.calls[1]!.body, false);
  const noOwnerAdd = await run(new FakeServer(rows()), 'VAGENT', { op: 'add_script', category_id: '101', content: 'x' });
  assert.deepEqual(noOwnerAdd.calls[1]!.body, { head: HEAD, content: 'x', categoryCode: 'cat-a' });
  const stringOwner = await run(new FakeServer(rows()), 'VAGENT', { op: 'delete_category', category_id: '102' });
  assert.deepEqual(stringOwner.calls[1]!.body, { head: HEAD, id: 102, ownerType: 'VAGENT' });
});

// ------------------------------------------------------------------ refusals before any write

test('a target missing from the fresh pre-read is rejected as stale and no write is sent', async () => {
  const stale: QuickReplyEdit[] = [
    { op: 'update_category', category_id: '999', name: 'X', skill_group_ids: [] },
    { op: 'delete_category', category_id: '999' },
    { op: 'sort_categories', category_ids: ['101'] },
    { op: 'sort_categories', category_ids: ['101', '102', '999'] },
    { op: 'sort_categories', category_ids: ['101', '999'] },
    { op: 'add_script', category_id: '999', content: 'x' },
    { op: 'update_script', script_id: '999', content: 'x' },
    { op: 'move_script', script_id: '999', target_category_id: '102' },
    { op: 'move_script', script_id: '201', target_category_id: '999' },
    { op: 'move_script', script_id: '201', target_category_id: '101' },
    { op: 'delete_script', script_id: '999' },
    { op: 'sort_scripts', category_id: '101', script_ids: ['201'] },
    { op: 'sort_scripts', category_id: '101', script_ids: ['201', '203'] },
    { op: 'sort_scripts', category_id: '999', script_ids: ['201'] },
  ];
  for (const edit of stale) {
    const { out, calls } = await run(new FakeServer(personal()), 'VAGENT', edit);
    assert.deepEqual(verdict(out), { kind: 'rejected', reason: 'stale' }, JSON.stringify(edit));
    assert.deepEqual(calls.map((c) => c.name), ['getCategories'], JSON.stringify(edit));
    // the pre-read comes back so the UI can refresh
    assert.deepEqual(out.categories?.map((c) => c.id), ['101', '102']);
  }

  // a category without code cannot receive new or moved scripts
  const noCode = personal();
  delete cat(noCode, '102')['code'];
  for (const edit of [{ op: 'add_script', category_id: '102', content: 'x' }, { op: 'move_script', script_id: '201', target_category_id: '102' }] as const) {
    const { out, calls } = await run(new FakeServer(clone(noCode)), 'VAGENT', edit);
    assert.deepEqual(verdict(out), { kind: 'rejected', reason: 'stale' }, edit.op);
    assert.equal(calls.length, 1);
  }

  // category writes only target root categories
  const nested = personal();
  cat(nested, '101')['subCategories'] = [{ id: 105, code: 'cat-sub', name: 'Sub', ownerType: 1, customerScripts: [] }];
  for (const edit of [{ op: 'update_category', category_id: '105', name: 'X', skill_group_ids: [] }, { op: 'delete_category', category_id: '105' }] as const) {
    const { out, calls } = await run(new FakeServer(clone(nested)), 'VAGENT', edit);
    assert.deepEqual(verdict(out), { kind: 'rejected', reason: 'stale' }, edit.op);
    assert.equal(calls.length, 1);
  }

  // team scope: a skill group the leader does not hold is stale; no buid means no skill-group list at all
  for (const edit of [{ op: 'create_category', name: 'T', skill_group_ids: ['503'] }, { op: 'update_category', category_id: '301', name: 'T', skill_group_ids: ['501', '503'] }] as const) {
    const { out, calls } = await run(new FakeServer(team()), 'VSKILLGROUP', edit);
    assert.deepEqual(verdict(out), { kind: 'rejected', reason: 'stale' }, edit.op);
    assert.deepEqual(calls.map((c) => c.name), ['getCategories', 'getVenAgentByUid', 'getSkillGroupInfoByVenAgent']);
  }
  // no buid: the leader gate still runs first, then the missing skill-group list refuses unsent
  const noBuid = await run(new FakeServer(team()), 'VSKILLGROUP', { op: 'create_category', name: 'T', skill_group_ids: ['501'] }, { buid: null });
  assert.deepEqual(verdict(noBuid.out), { kind: 'rejected', reason: 'stale' });
  assert.deepEqual(noBuid.calls.map((c) => c.name), ['getCategories', 'getVenAgentByUid']);
  const noBuidMember = new FakeServer(team());
  noBuidMember.jobPosition = 'MEMBER';
  const nb = await run(noBuidMember, 'VSKILLGROUP', { op: 'create_category', name: 'T', skill_group_ids: ['501'] }, { buid: null });
  assert.deepEqual(verdict(nb.out), { kind: 'rejected', reason: 'not_leader' });
  assert.deepEqual(nb.calls.map((c) => c.name), ['getCategories', 'getVenAgentByUid']);
});

test('team writes by a non-leader are refused before any write; pre-read failures are not_submitted or auth', async () => {
  const teamEdits: QuickReplyEdit[] = [
    { op: 'create_category', name: 'T', skill_group_ids: ['501'] },
    { op: 'delete_category', category_id: '301' },
    { op: 'add_script', category_id: '301', content: 'x' },
    { op: 'sort_scripts', category_id: '301', script_ids: ['401'] },
  ];
  for (const jobPosition of ['MEMBER', 'leader', '', null, undefined]) {
    for (const edit of teamEdits) {
      const srv = new FakeServer(team());
      srv.jobPosition = jobPosition;
      const { out, calls } = await run(srv, 'VSKILLGROUP', edit);
      assert.deepEqual(verdict(out), { kind: 'rejected', reason: 'not_leader' }, `${String(jobPosition)} ${edit.op}`);
      assert.equal(calls.filter((c) => WRITE_ENDPOINTS.has(c.name)).length, 0);
      assert.deepEqual(out.categories?.map((c) => c.id), ['301']);
    }
  }
  const noAgent = new FakeServer(team());
  noAgent.override['getVenAgentByUid'] = () => ok({});
  assert.deepEqual(verdict((await run(noAgent, 'VSKILLGROUP', { op: 'delete_category', category_id: '301' })).out), { kind: 'rejected', reason: 'not_leader' });

  const failures: { readonly endpoint: string; readonly reply: () => Reply; readonly reason: string }[] = [
    { endpoint: 'getCategories', reply: () => jsonResponse('x', 500), reason: 'not_submitted' },
    { endpoint: 'getCategories', reply: () => jsonResponse({ ResponseStatus: AUTH_FAILURE_STATUS }), reason: 'auth' },
    { endpoint: 'getCategories', reply: () => jsonResponse({ ResponseStatus: FAILURE_STATUS }), reason: 'not_submitted' },
    { endpoint: 'getCategories', reply: () => ok({}), reason: 'not_submitted' },
    { endpoint: 'getCategories', reply: () => jsonResponse('not json'), reason: 'not_submitted' },
    { endpoint: 'getVenAgentByUid', reply: () => jsonResponse('x', 502), reason: 'not_submitted' },
    { endpoint: 'getVenAgentByUid', reply: () => jsonResponse({ ResponseStatus: AUTH_FAILURE_STATUS }), reason: 'auth' },
    { endpoint: 'getSkillGroupInfoByVenAgent', reply: () => jsonResponse('x', 500), reason: 'not_submitted' },
    { endpoint: 'getSkillGroupInfoByVenAgent', reply: () => jsonResponse({ ResponseStatus: AUTH_FAILURE_STATUS }), reason: 'auth' },
  ];
  for (const f of failures) {
    const srv = new FakeServer(team());
    srv.override[f.endpoint] = f.reply;
    const { out, calls } = await run(srv, 'VSKILLGROUP', { op: 'create_category', name: 'T', skill_group_ids: ['501'] });
    assert.deepEqual(verdict(out), { kind: 'rejected', reason: f.reason }, `${f.endpoint} -> ${f.reason}`);
    assert.equal(calls.filter((c) => WRITE_ENDPOINTS.has(c.name)).length, 0, f.endpoint);
  }

  // a pre-read that never answers times out at the pre-read budget and nothing is written
  const slow = new FakeServer(personal());
  slow.override['getCategories'] = () => 'hang';
  const { deps, done } = start(slow, 'VAGENT', { op: 'delete_script', script_id: '201' });
  await drain();
  await deps.clock.advance(PRE_READ_TIMEOUT_MS);
  assert.deepEqual(verdict(await done), { kind: 'rejected', reason: 'not_submitted' });
  assert.equal(writesOf(deps).length, 0);
});

test('numeric endpoints refuse IDs beyond the safe-integer range unsent; the string-ID endpoint accepts them', async () => {
  const BIG_CAT = '9999999999999999999';
  const BIG_SCRIPT = '9999999999999999998';
  const rows = (): Rec[] => [
    { id: BIG_CAT, code: 'cat-big', name: 'Big', ownerType: 1, customerScripts: [{ id: BIG_SCRIPT, content: 'big-reply', sortNo: 0 }] },
    { id: 102, code: 'cat-b', name: 'Group B', ownerType: 1, customerScripts: [{ id: '9007199254740993', content: 'edge', sortNo: 0 }, { id: '9007199254740991', content: 'max', sortNo: 1 }] },
  ];
  const refused: QuickReplyEdit[] = [
    { op: 'update_category', category_id: BIG_CAT, name: 'X', skill_group_ids: [] },
    { op: 'delete_category', category_id: BIG_CAT },
    { op: 'sort_categories', category_ids: ['102', BIG_CAT] },
    { op: 'delete_script', script_id: BIG_SCRIPT },
    { op: 'delete_script', script_id: '9007199254740993' },
    { op: 'sort_scripts', category_id: BIG_CAT, script_ids: [BIG_SCRIPT] },
    { op: 'sort_scripts', category_id: '102', script_ids: ['9007199254740991', '9007199254740993'] },
  ];
  for (const edit of refused) {
    const { out, calls } = await run(new FakeServer(rows()), 'VAGENT', edit);
    assert.deepEqual(verdict(out), { kind: 'rejected', reason: 'stale' }, JSON.stringify(edit));
    assert.deepEqual(calls.map((c) => c.name), ['getCategories'], JSON.stringify(edit));
  }

  // the largest safe integer still goes out as a number
  const maxSafe = new FakeServer(rows());
  maxSafe.onWrite = () => { scriptsOf(cat(maxSafe.cats, '102')).splice(1, 1); return undefined; };
  const del = await run(maxSafe, 'VAGENT', { op: 'delete_script', script_id: '9007199254740991' });
  assert.deepEqual(del.calls[1]!.body, { head: HEAD, id: 9007199254740991 });
  assert.deepEqual(verdict(del.out), { kind: 'applied' });

  const edited = new FakeServer(rows());
  edited.onWrite = () => { scriptsOf(cat(edited.cats, BIG_CAT))[0]!['content'] = 'edited'; return undefined; };
  const upd = await run(edited, 'VAGENT', { op: 'update_script', script_id: BIG_SCRIPT, content: 'edited' });
  assert.deepEqual(upd.calls[1]!.body, { head: HEAD, content: 'edited', id: BIG_SCRIPT });
  assert.deepEqual(verdict(upd.out), { kind: 'applied' });

  const moved = new FakeServer(rows());
  moved.onWrite = () => { scriptsOf(cat(moved.cats, '102')).push(...scriptsOf(cat(moved.cats, BIG_CAT)).splice(0, 1)); return undefined; };
  const mv = await run(moved, 'VAGENT', { op: 'move_script', script_id: BIG_SCRIPT, target_category_id: '102' });
  assert.deepEqual(mv.calls[1]!.body, { head: HEAD, id: BIG_SCRIPT, content: 'big-reply', categoryCode: 'cat-b' });
  assert.deepEqual(verdict(mv.out), { kind: 'applied' });

  // the category ID never goes on the wire for a new script, only its code
  const added = new FakeServer(rows());
  added.onWrite = () => { scriptsOf(cat(added.cats, BIG_CAT)).push({ id: 205, content: 'more', sortNo: 1 }); return undefined; };
  const add = await run(added, 'VAGENT', { op: 'add_script', category_id: BIG_CAT, content: 'more' });
  assert.deepEqual(add.calls[1]!.body, { head: HEAD, content: 'more', ownerType: 1, categoryCode: 'cat-big' });
  assert.deepEqual(verdict(add.out), { kind: 'applied' });
});

// ------------------------------------------------------------------ read-back

test('an unanswered write is never resent; the read-back alone decides between applied and unknown', async () => {
  const edit: QuickReplyEdit = { op: 'update_script', script_id: '201', content: 'edited' };
  const applyEdit = (srv: FakeServer): void => { scriptsOf(cat(srv.cats, '101'))[0]!['content'] = 'edited'; };

  // write hangs, the server did not apply it
  {
    const srv = new FakeServer(personal());
    srv.onWrite = () => 'hang';
    const { deps, done } = start(srv, 'VAGENT', edit);
    await drain();
    assert.equal(writesOf(deps).length, 1);
    await deps.clock.advance(WRITE_REQUEST_TIMEOUT_MS);
    const out = await done;
    assert.deepEqual(verdict(out), { kind: 'unknown', reason: 'write_unknown' });
    assert.deepEqual(callsOf(deps).map((c) => c.name), ['getCategories', 'updateCustomerScript', 'getCategories']);
    assert.equal(out.categories?.[0]?.scripts[0]?.content, 'reply-a1');
    await deps.clock.advance(60_000);
    assert.equal(writesOf(deps).length, 1);
    assert.equal(deps.fakeFetch.calls.length, 3);
  }
  // write hangs, but the server applied it
  {
    const srv = new FakeServer(personal());
    srv.onWrite = () => { applyEdit(srv); return 'hang'; };
    const { deps, done } = start(srv, 'VAGENT', edit);
    await drain();
    await deps.clock.advance(WRITE_REQUEST_TIMEOUT_MS);
    assert.deepEqual(verdict(await done), { kind: 'applied' });
    assert.equal(writesOf(deps).length, 1);
  }
  // http error / malformed / transport error on the write: unknown unless the read-back proves it
  for (const reply of [() => jsonResponse('x', 500), () => jsonResponse('not json'), () => jsonResponse({}), () => new Error('synthetic transport')]) {
    const unproven = new FakeServer(personal());
    unproven.onWrite = reply;
    const u = await run(unproven, 'VAGENT', edit);
    assert.deepEqual(verdict(u.out), { kind: 'unknown', reason: 'write_unknown' });
    assert.equal(writesOf(u.deps).length, 1);
    assert.ok(u.out.categories);
    const proven = new FakeServer(personal());
    proven.onWrite = () => { applyEdit(proven); return reply(); };
    const p = await run(proven, 'VAGENT', edit);
    assert.deepEqual(verdict(p.out), { kind: 'applied' });
    assert.equal(writesOf(p.deps).length, 1);
  }
});

test('read-back outcomes: unverified, business refusals, auth, and a failed read-back', async () => {
  const edit: QuickReplyEdit = { op: 'update_script', script_id: '201', content: 'edited' };
  const applyEdit = (srv: FakeServer): void => { scriptsOf(cat(srv.cats, '101'))[0]!['content'] = 'edited'; };

  // Ack Success but nothing changed
  const silent = await run(new FakeServer(personal()), 'VAGENT', edit);
  assert.deepEqual(verdict(silent.out), { kind: 'unknown', reason: 'unverified' });
  assert.equal(silent.calls.length, 3);
  assert.ok(silent.out.categories);

  // Ack Success with an explicit SUCCESS business code but nothing changed: still unverified
  const bizOk = new FakeServer(personal());
  bizOk.onWrite = () => ok({ bizResponseStatus: { resultCode: 'SUCCESS' } });
  assert.deepEqual(verdict((await run(bizOk, 'VAGENT', edit)).out), { kind: 'unknown', reason: 'unverified' });

  // business FAIL and the read-back shows no change: refused
  const bizFail = new FakeServer(personal());
  bizFail.onWrite = () => ok({ bizResponseStatus: { resultCode: 'FAIL' } });
  const bf = await run(bizFail, 'VAGENT', edit);
  assert.deepEqual(verdict(bf.out), { kind: 'rejected', reason: 'business', detail: 'FAIL' });
  assert.equal(bf.calls.length, 3);

  // business FAIL but the read-back shows the change: the read-back wins
  const bizFailApplied = new FakeServer(personal());
  bizFailApplied.onWrite = () => { applyEdit(bizFailApplied); return ok({ bizResponseStatus: { resultCode: 'FAIL' } }); };
  assert.deepEqual(verdict((await run(bizFailApplied, 'VAGENT', edit)).out), { kind: 'applied' });

  // Ack Failure: refused with the first error code, no read-back, the pre-read returned
  const ack = new FakeServer(personal());
  ack.onWrite = () => jsonResponse({ ResponseStatus: { ...FAILURE_STATUS, Errors: [{ ...FAILURE_STATUS.Errors[0], ErrorCode: 'CODE_1001' }] } });
  const af = await run(ack, 'VAGENT', edit);
  assert.deepEqual(verdict(af.out), { kind: 'rejected', reason: 'business', detail: 'CODE_1001' });
  assert.deepEqual(af.calls.map((c) => c.name), ['getCategories', 'updateCustomerScript']);
  assert.deepEqual(af.out.categories?.map((c) => c.id), ['101', '102']);
  const ackNoCode = new FakeServer(personal());
  ackNoCode.onWrite = () => jsonResponse({ ResponseStatus: { ...FAILURE_STATUS, Errors: [] } });
  const anc = await run(ackNoCode, 'VAGENT', edit);
  assert.deepEqual(verdict(anc.out), { kind: 'rejected', reason: 'business' });
  assert.equal('detail' in anc.out, false);

  // login expired on the write
  const auth = new FakeServer(personal());
  auth.onWrite = () => jsonResponse({ ResponseStatus: AUTH_FAILURE_STATUS });
  const au = await run(auth, 'VAGENT', edit);
  assert.deepEqual(verdict(au.out), { kind: 'rejected', reason: 'auth' });
  assert.equal(au.calls.length, 2);

  // the write was answered but the read-back failed
  for (const reply of [() => jsonResponse('x', 500), () => jsonResponse({ ResponseStatus: AUTH_FAILURE_STATUS }), () => ok({})]) {
    const srv = new FakeServer(personal());
    srv.onWrite = () => { applyEdit(srv); return undefined; };
    srv.override['getCategories'] = (n) => (n === 1 ? reply() : undefined);
    const rb = await run(srv, 'VAGENT', edit);
    assert.deepEqual(verdict(rb.out), { kind: 'unknown', reason: 'readback_failed' });
    assert.equal(rb.out.categories, undefined);
    assert.equal(writesOf(rb.deps).length, 1);
  }
  // read-back never answers
  {
    const srv = new FakeServer(personal());
    srv.override['getCategories'] = (n) => (n === 1 ? 'hang' : undefined);
    const { deps, done } = start(srv, 'VAGENT', edit);
    await drain();
    await deps.clock.advance(READ_BACK_TIMEOUT_MS);
    assert.deepEqual(verdict(await done), { kind: 'unknown', reason: 'readback_failed' });
    assert.equal(writesOf(deps).length, 1);
  }
  // the write got no answer and the read-back failed too
  {
    const srv = new FakeServer(personal());
    srv.onWrite = () => jsonResponse('x', 503);
    srv.override['getCategories'] = (n) => (n === 1 ? jsonResponse('x', 500) : undefined);
    assert.deepEqual(verdict((await run(srv, 'VAGENT', edit)).out), { kind: 'unknown', reason: 'write_unknown' });
  }
});

test('an incomplete read-back cannot prove absence or order: deletes and sorts stay unknown', async () => {
  const hideRow = (cats: Rec[], where: 'category' | 'script'): void => {
    if (where === 'category') cats.push({ id: 'not-an-id', name: 'hidden' });
    else scriptsOf(cats[0]!).push({ id: null, content: 'hidden' });
  };
  const cases: { readonly edit: QuickReplyEdit; readonly apply: (cats: Rec[]) => void }[] = [
    { edit: { op: 'delete_script', script_id: '202' }, apply: (cats) => { scriptsOf(cat(cats, '101')).splice(1, 1); } },
    { edit: { op: 'delete_category', category_id: '102' }, apply: (cats) => { cats.splice(1, 1); } },
    { edit: { op: 'sort_categories', category_ids: ['102', '101'] }, apply: (cats) => { cats.reverse(); } },
    {
      edit: { op: 'sort_scripts', category_id: '101', script_ids: ['202', '201'] },
      apply: (cats) => {
        const [a, b] = scriptsOf(cat(cats, '101'));
        a!['sortNo'] = 1;
        b!['sortNo'] = 0;
      },
    },
  ];
  for (const where of ['category', 'script'] as const) {
    for (const c of cases) {
      const srv = new FakeServer(personal());
      srv.onWrite = () => { c.apply(srv.cats); hideRow(srv.cats, where); return undefined; };
      const { out, deps } = await run(srv, 'VAGENT', c.edit);
      assert.deepEqual(verdict(out), { kind: 'unknown', reason: 'unverified' }, `${where} ${c.edit.op}`);
      assert.equal(writesOf(deps).length, 1);
      assert.ok(out.categories);
    }
  }

  // presence checks are still provable on an incomplete read-back
  const upd = new FakeServer(personal());
  upd.onWrite = () => { scriptsOf(cat(upd.cats, '101'))[0]!['content'] = 'edited'; hideRow(upd.cats, 'category'); return undefined; };
  assert.deepEqual(verdict((await run(upd, 'VAGENT', { op: 'update_script', script_id: '201', content: 'edited' })).out), { kind: 'applied' });

  // a sort is refused unsent when the pre-read itself is incomplete (the full set cannot be proven)
  for (const edit of [{ op: 'sort_categories', category_ids: ['101', '102'] }, { op: 'sort_scripts', category_id: '101', script_ids: ['201', '202'] }] as const) {
    const before = personal();
    hideRow(before, 'script');
    const { out, calls } = await run(new FakeServer(before), 'VAGENT', edit);
    assert.deepEqual(verdict(out), { kind: 'rejected', reason: 'stale' }, edit.op);
    assert.equal(calls.length, 1);
  }
});

test('detail carries only a short machine code; anything else is dropped', async () => {
  const edit: QuickReplyEdit = { op: 'update_script', script_id: '201', content: 'edited' };
  for (const code of ['{{code}}', 'has space', 'x'.repeat(65), '']) {
    const ack = new FakeServer(personal());
    ack.onWrite = () => jsonResponse({ ResponseStatus: { ...FAILURE_STATUS, Errors: [{ ...FAILURE_STATUS.Errors[0], ErrorCode: code }] } });
    assert.deepEqual(verdict((await run(ack, 'VAGENT', edit)).out), { kind: 'rejected', reason: 'business' }, JSON.stringify(code));
    const biz = new FakeServer(personal());
    biz.onWrite = () => ok({ bizResponseStatus: { resultCode: code } });
    const out: QuickReplyEditOutcome = (await run(biz, 'VAGENT', edit)).out;
    // an empty code is no business result at all: the read-back cannot prove the edit
    assert.deepEqual(verdict(out), code === '' ? { kind: 'unknown', reason: 'unverified' } : { kind: 'rejected', reason: 'business' }, JSON.stringify(code));
  }
});

test('deleting a category must remove its whole subtree: sub-categories and their scripts', async () => {
  const nested = (): Rec[] => {
    const cats = personal();
    cat(cats, '102')['subCategories'] = [{ id: 106, code: 'cat-sub', name: 'Sub', ownerType: 1, customerScripts: [{ id: 206, content: 'sub-reply', sortNo: 0 }] }];
    return cats;
  };
  const edit: QuickReplyEdit = { op: 'delete_category', category_id: '102' };
  const cases: { readonly apply: (cats: Rec[]) => void; readonly applied: boolean; readonly label: string }[] = [
    { label: 'whole subtree gone', applied: true, apply: (cats) => { cats.splice(1, 1); } },
    {
      label: 'sub-category moved to the root',
      applied: false,
      apply: (cats) => {
        const sub = (cat(cats, '102')['subCategories'] as Rec[])[0]!;
        cats.splice(1, 1, sub);
      },
    },
    {
      label: 'sub-category script re-homed',
      applied: false,
      apply: (cats) => {
        cats.splice(1, 1);
        scriptsOf(cat(cats, '101')).push({ id: 206, content: 'sub-reply', sortNo: 9 });
      },
    },
  ];
  for (const c of cases) {
    const srv = new FakeServer(nested());
    srv.onWrite = () => { c.apply(srv.cats); return undefined; };
    const { out } = await run(srv, 'VAGENT', edit);
    assert.deepEqual(verdict(out), c.applied ? { kind: 'applied' } : { kind: 'unknown', reason: 'unverified' }, c.label);
  }
});

test('indexCategories marks anything that could hide a row as incomplete', () => {
  assert.equal(indexCategories(personal()).complete, true);
  assert.deepEqual(indexCategories(personal()).rootOrder, ['101', '102']);
  assert.equal(indexCategories({}).complete, false);
  assert.equal(indexCategories([{ id: 1, name: 'a' }, { id: 1, name: 'b' }]).complete, false);
  assert.equal(indexCategories([{ id: 1, name: 'a', customerScripts: [{ id: 2 }, { id: 2 }] }]).complete, false);
  assert.equal(indexCategories([{ id: 1, name: 'a', customerScripts: {} }]).complete, false);
  assert.equal(indexCategories([{ id: 1, name: 'a', customerScripts: [{ id: '9007199254740993' }] }]).complete, true);
  assert.equal(indexCategories([{ id: 1, name: 'a', customerScripts: [{ id: 1e19 }] }]).complete, false);
  // three levels are indexed, a fourth is beyond the display limit
  const deep = (levels: number): Rec[] => (levels === 0 ? [] : [{ id: levels, name: `l${levels}`, subCategories: deep(levels - 1) }]);
  assert.equal(indexCategories(deep(3)).complete, true);
  assert.equal(indexCategories(deep(4)).complete, false);
  // scripts follow sortNo, ties keep wire order
  const order = indexCategories([{ id: 1, name: 'a', customerScripts: [{ id: 5, sortNo: 2 }, { id: 6, sortNo: 1 }, { id: 7, sortNo: 1 }] }]);
  assert.deepEqual(order.categories.get('1')?.scripts, ['6', '7', '5']);
});

test('create and add are proven only by a new ID carrying the submitted name or content', async () => {
  const create: QuickReplyEdit = { op: 'create_category', name: 'New Group', skill_group_ids: [] };
  const createCases: { readonly apply: (cats: Rec[]) => void; readonly kind: string }[] = [
    { apply: () => undefined, kind: 'unverified' },
    { apply: (cats) => { cat(cats, '101')['name'] = 'New Group'; }, kind: 'unverified' },
    { apply: (cats) => { cats.push({ id: 103, code: 'cat-c', name: 'Other', customerScripts: [] }); }, kind: 'unverified' },
    { apply: (cats) => { cat(cats, '101')['subCategories'] = [{ id: 103, code: 'cat-c', name: 'New Group' }]; }, kind: 'unverified' },
    { apply: (cats) => { cats.push({ id: 103, code: 'cat-c', name: ' New Group ', customerScripts: [] }); }, kind: 'applied' },
  ];
  for (const [i, c] of createCases.entries()) {
    const srv = new FakeServer(personal());
    srv.onWrite = () => { c.apply(srv.cats); return undefined; };
    const { out } = await run(srv, 'VAGENT', create);
    assert.deepEqual(verdict(out), c.kind === 'applied' ? { kind: 'applied' } : { kind: 'unknown', reason: 'unverified' }, `create case ${i}`);
  }

  const add: QuickReplyEdit = { op: 'add_script', category_id: '102', content: 'new reply' };
  const addCases: { readonly apply: (cats: Rec[]) => void; readonly kind: string }[] = [
    { apply: () => undefined, kind: 'unverified' },
    { apply: (cats) => { scriptsOf(cat(cats, '102'))[0]!['content'] = 'new reply'; }, kind: 'unverified' },
    { apply: (cats) => { scriptsOf(cat(cats, '101')).push({ id: 204, content: 'new reply', sortNo: 2 }); }, kind: 'unverified' },
    { apply: (cats) => { scriptsOf(cat(cats, '102')).push({ id: 204, content: 'something else', sortNo: 1 }); }, kind: 'unverified' },
    { apply: (cats) => { scriptsOf(cat(cats, '102')).push({ id: 204, content: 'new reply', sortNo: 1 }); }, kind: 'applied' },
  ];
  for (const [i, c] of addCases.entries()) {
    const srv = new FakeServer(personal());
    srv.onWrite = () => { c.apply(srv.cats); return undefined; };
    const { out } = await run(srv, 'VAGENT', add);
    assert.deepEqual(verdict(out), c.kind === 'applied' ? { kind: 'applied' } : { kind: 'unknown', reason: 'unverified' }, `add case ${i}`);
  }

  // an incomplete pre-read cannot show which ID is new: even a matching new row stays unverified
  for (const [edit, apply] of [
    [create, (cats: Rec[]) => { cats.push({ id: 103, code: 'cat-c', name: 'New Group', customerScripts: [] }); }],
    [add, (cats: Rec[]) => { scriptsOf(cat(cats, '102')).push({ id: 204, content: 'new reply', sortNo: 1 }); }],
  ] as const) {
    const before = personal();
    scriptsOf(cat(before, '101')).push({ id: null, content: 'hidden' });
    const srv = new FakeServer(before);
    srv.onWrite = () => { apply(srv.cats); return undefined; };
    const { out, deps } = await run(srv, 'VAGENT', edit);
    assert.deepEqual(verdict(out), { kind: 'unknown', reason: 'unverified' }, `incomplete pre-read ${edit.op}`);
    assert.equal(writesOf(deps).length, 1);
  }
});

// ------------------------------------------------------------------ rpc: lock, lifecycle, manage info

function rpcSetup(srv: FakeServer, extra: Partial<Pick<RpcContext, 'buid' | 'captureWriteGuard'>> = {}) {
  const deps = makeDeps(srv.script);
  const rpc = createRpc({
    deps,
    sdk: new FakePageSdk(),
    soa: new SoaClient(deps),
    store: new ConversationStore(),
    roles: new RoleBook('me'),
    pushFact: () => {},
    pushDisplay: () => {},
    agent: { current: () => null, set: () => {} },
    buid: BUID,
    ...extra,
  });
  return { deps, rpc };
}

const editReq = (reqId: string, type: string, edit: unknown): Rec => ({ req_id: reqId, op: 'im.quick_reply_edit', args: { type, edit } });

function dataOf(reply: unknown): Rec {
  const r = reply as { ok?: boolean; data?: unknown } | null;
  assert.equal(r?.ok, true, JSON.stringify(reply));
  return r!.data as Rec;
}

test('one quick-reply write per page at a time: a concurrent edit is busy and sends nothing; the lock frees afterwards', async () => {
  const srv = new FakeServer(personal());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  srv.onWrite = (_name, body) => {
    writes++;
    const apply = (): void => { scriptsOf(cat(srv.cats, '101'))[0]!['content'] = body['content']; };
    if (writes === 1) return gate.then(() => { apply(); return ok(); });
    apply();
    return undefined;
  };
  const { deps, rpc } = rpcSetup(srv);
  const first = rpc.handle(editReq('w1', 'VAGENT', { op: 'update_script', script_id: '201', content: 'edited-1' }));
  await drain();
  assert.deepEqual(callsOf(deps).map((c) => c.name), ['getCategories', 'updateCustomerScript']);

  assert.deepEqual(await rpc.handle(editReq('w2', 'VAGENT', { op: 'update_script', script_id: '201', content: 'edited-2' })), { req_id: 'w2', ok: true, data: { kind: 'rejected', reason: 'busy' } });
  // the lock is per page, not per type
  assert.deepEqual(await rpc.handle(editReq('w3', 'VSKILLGROUP', { op: 'delete_category', category_id: '301' })), { req_id: 'w3', ok: true, data: { kind: 'rejected', reason: 'busy' } });
  assert.equal(deps.fakeFetch.calls.length, 2);
  // reads stay available while the write is pending
  assert.equal(((await rpc.handle({ req_id: 'r1', op: 'im.quick_reply_categories', args: { type: 'VAGENT' } })) as { ok: boolean }).ok, true);

  release();
  const r1 = dataOf(await first);
  assert.equal(r1['kind'], 'applied');
  const firstCategory = (r1['categories'] as Rec[])[0]!;
  assert.deepEqual({ ...firstCategory, scripts: undefined, sub_categories: undefined }, { id: '101', name: 'Group A', code: 'cat-a', owner_type: 1, skill_groups: [], scripts: undefined, sub_categories: undefined, script_total: 2 });
  assert.deepEqual((firstCategory['scripts'] as Rec[])[0], { id: '201', content: 'edited-1', short_cut: '', type: '', sort_no: 0 });

  assert.deepEqual(dataOf(await rpc.handle(editReq('w4', 'VAGENT', { op: 'update_script', script_id: '201', content: 'edited-3' })))['kind'], 'applied');
  // refusals release the lock too
  assert.deepEqual(dataOf(await rpc.handle(editReq('w5', 'VAGENT', { op: 'delete_script', script_id: '999' }))), { kind: 'rejected', reason: 'stale', categories: dataOf(await rpc.handle({ req_id: 'r2', op: 'im.quick_reply_categories', args: { type: 'VAGENT' } }))['categories'] });
  srv.override['getCategories'] = () => jsonResponse('x', 500);
  assert.deepEqual(dataOf(await rpc.handle(editReq('w6', 'VAGENT', { op: 'delete_script', script_id: '201' }))), { kind: 'rejected', reason: 'not_submitted' });
  delete srv.override['getCategories'];
  assert.equal(dataOf(await rpc.handle(editReq('w7', 'VAGENT', { op: 'update_script', script_id: '201', content: 'edited-4' })))['kind'], 'applied');
  assert.equal(writes, 3);
});

test('rpc refuses malformed or invalid edits before any request', async () => {
  const srv = new FakeServer(personal());
  const { deps, rpc } = rpcSetup(srv);
  for (const edit of [null, 'x', {}, { op: 'rename_everything' }, { op: 'delete_script' }, { op: 'delete_script', script_id: 201 }, { op: 'create_category', name: 'x' }]) {
    assert.deepEqual(dataOf(await rpc.handle(editReq('bad', 'VAGENT', edit))), { kind: 'rejected', reason: 'invalid' }, JSON.stringify(edit));
  }
  for (const edit of [{ op: 'create_category', name: 'a'.repeat(CATEGORY_NAME_MAX + 1), skill_group_ids: [] }, { op: 'create_category', name: 'x', skill_group_ids: ['501'] }, { op: 'delete_script', script_id: 'abc' }]) {
    assert.deepEqual(dataOf(await rpc.handle(editReq('bad', 'VAGENT', edit))), { kind: 'rejected', reason: 'invalid' }, JSON.stringify(edit));
  }
  // an unknown type is a refusal, not a page error (the host reads page errors after a send as unknown)
  assert.deepEqual(dataOf(await rpc.handle(editReq('bad-type', 'OTHER', { op: 'delete_script', script_id: '201' }))), { kind: 'rejected', reason: 'invalid' });
  assert.equal(deps.fakeFetch.calls.length, 0);
});

test('a page-session change before the write refuses it unsent; once the write is out the outcome is unknown', async () => {
  let generation = 0;
  const guard = { captureWriteGuard: () => { const mine = generation; return () => mine === generation; } };
  const del = { op: 'delete_script', script_id: '202' };
  const applyDelete = (srv: FakeServer): void => { scriptsOf(cat(srv.cats, '101')).splice(1, 1); };

  // already stale when the request arrives
  {
    const srv = new FakeServer(personal());
    const { deps, rpc } = rpcSetup(srv, { captureWriteGuard: () => () => false });
    assert.deepEqual(dataOf(await rpc.handle(editReq('g0', 'VAGENT', del))), { kind: 'rejected', reason: 'not_submitted' });
    assert.equal(deps.fakeFetch.calls.length, 0);
  }
  // changes during the pre-read
  {
    const srv = new FakeServer(personal());
    srv.override['getCategories'] = (n) => { if (n === 0) generation++; return undefined; };
    const { deps, rpc } = rpcSetup(srv, guard);
    assert.deepEqual(dataOf(await rpc.handle(editReq('g1', 'VAGENT', del))), { kind: 'rejected', reason: 'not_submitted' });
    assert.deepEqual(callsOf(deps).map((c) => c.name), ['getCategories']);
  }
  // changes during the team leader check
  {
    const srv = new FakeServer(team());
    srv.override['getVenAgentByUid'] = () => { generation++; return undefined; };
    const { deps, rpc } = rpcSetup(srv, guard);
    assert.deepEqual(dataOf(await rpc.handle(editReq('g2', 'VSKILLGROUP', { op: 'delete_category', category_id: '301' }))), { kind: 'rejected', reason: 'not_submitted' });
    assert.equal(writesOf(deps).length, 0);
  }
  // changes while the answered write is in flight: no read-back for the old session
  {
    const srv = new FakeServer(personal());
    srv.onWrite = () => { generation++; applyDelete(srv); return undefined; };
    const { deps, rpc } = rpcSetup(srv, guard);
    assert.deepEqual(dataOf(await rpc.handle(editReq('g3', 'VAGENT', del))), { kind: 'unknown', reason: 'readback_failed' });
    assert.deepEqual(callsOf(deps).map((c) => c.name), ['getCategories', 'deleteCustomerScript']);
  }
  // changes while an unanswered write is in flight
  {
    const srv = new FakeServer(personal());
    srv.onWrite = () => { generation++; return jsonResponse('x', 500); };
    const { deps, rpc } = rpcSetup(srv, guard);
    assert.deepEqual(dataOf(await rpc.handle(editReq('g4', 'VAGENT', del))), { kind: 'unknown', reason: 'write_unknown' });
    assert.equal(writesOf(deps).length, 1);
  }
  // changes during the read-back: the result is not proven for this session
  for (const [reply, reason] of [[undefined, 'readback_failed'], [jsonResponse('x', 500), 'write_unknown']] as const) {
    const srv = new FakeServer(personal());
    srv.onWrite = () => { applyDelete(srv); return reply; };
    srv.override['getCategories'] = (n) => { if (n === 1) generation++; return undefined; };
    const { deps, rpc } = rpcSetup(srv, guard);
    assert.deepEqual(dataOf(await rpc.handle(editReq('g5', 'VAGENT', del))), { kind: 'unknown', reason });
    assert.equal(writesOf(deps).length, 1);
  }
});

test('manage info: personal is editable without a request; team asks the leader gate and the buid skill groups', async () => {
  const info = (type: string): Rec => ({ req_id: `m-${type}`, op: 'im.quick_reply_manage_info', args: { type } });
  {
    const { deps, rpc } = rpcSetup(new FakeServer(personal()));
    assert.deepEqual(dataOf(await rpc.handle(info('VAGENT'))), { can_edit: true, skill_groups: [] });
    assert.equal(deps.fakeFetch.calls.length, 0);
  }
  {
    const srv = new FakeServer(team());
    srv.skillGroups = [...srv.skillGroups, { skillGroupName: 'no id' }];
    const { deps, rpc } = rpcSetup(srv);
    assert.deepEqual(dataOf(await rpc.handle(info('VSKILLGROUP'))), { can_edit: true, skill_groups: [{ id: '501', name: 'SG1' }, { id: '502', name: 'SG2' }] });
    const calls = callsOf(deps);
    assert.deepEqual(calls.map((c) => c.name), ['getVenAgentByUid', 'getSkillGroupInfoByVenAgent']);
    assert.deepEqual(calls[0]!.body, { head: HEAD });
    assert.deepEqual(calls[1]!.body, { head: HEAD, agentUid: BUID });
    assert.ok(calls[1]!.url.startsWith('https://m.ctrip.com/restapi/soa2/16037/getSkillGroupInfoByVenAgent?'));
  }
  {
    const { deps, rpc } = rpcSetup(new FakeServer(team()), { buid: null });
    assert.deepEqual(dataOf(await rpc.handle(info('VSKILLGROUP'))), { can_edit: true, skill_groups: [] });
    assert.deepEqual(callsOf(deps).map((c) => c.name), ['getVenAgentByUid']);
  }
  {
    const srv = new FakeServer(team());
    srv.jobPosition = 'MEMBER';
    const { rpc } = rpcSetup(srv);
    assert.equal(dataOf(await rpc.handle(info('VSKILLGROUP')))['can_edit'], false);
  }
  {
    const srv = new FakeServer(team());
    srv.override['getSkillGroupInfoByVenAgent'] = () => jsonResponse('x', 500);
    const { rpc } = rpcSetup(srv);
    assert.deepEqual(dataOf(await rpc.handle(info('VSKILLGROUP'))), { can_edit: true, skill_groups: [] });
  }
  {
    const srv = new FakeServer(team());
    srv.override['getVenAgentByUid'] = () => jsonResponse('x', 500);
    const { rpc } = rpcSetup(srv);
    assert.equal(((await rpc.handle(info('VSKILLGROUP'))) as { ok: boolean }).ok, false);
  }
  {
    const { deps, rpc } = rpcSetup(new FakeServer(team()));
    assert.equal(((await rpc.handle(info('OTHER'))) as { ok: boolean }).ok, false);
    assert.equal(deps.fakeFetch.calls.length, 0);
  }
});

// ------------------------------------------------------------------ validation / parsing

test('validateEdit bounds: trimmed names of 1..15 UTF-16 units, content of 1..5000, owner-scoped skill groups, unique decimal IDs', async () => {
  const name = (n: string): boolean => validateEdit('VAGENT', { op: 'create_category', name: n, skill_group_ids: [] });
  assert.equal(name('a'.repeat(CATEGORY_NAME_MAX)), true);
  assert.equal(name('a'.repeat(CATEGORY_NAME_MAX + 1)), false);
  assert.equal(name(`   ${'a'.repeat(CATEGORY_NAME_MAX)}   `), true);
  assert.equal(name(''), false);
  assert.equal(name('   '), false);
  // UTF-16 units, as the host counts: an astral character is two
  assert.equal(name(`${'\u{1F600}'.repeat(7)}a`), true);
  assert.equal(name('\u{1F600}'.repeat(8)), false);
  assert.equal(validateEdit('VAGENT', { op: 'update_category', category_id: '1', name: 'a'.repeat(CATEGORY_NAME_MAX + 1), skill_group_ids: [] }), false);
  assert.equal(validateEdit('VAGENT', { op: 'update_category', category_id: '1', name: ' a ', skill_group_ids: [] }), true);

  for (const op of ['add_script', 'update_script'] as const) {
    const content = (c: string): boolean => validateEdit('VAGENT', op === 'add_script' ? { op, category_id: '1', content: c } : { op, script_id: '1', content: c });
    assert.equal(content('a'.repeat(SCRIPT_CONTENT_MAX)), true, op);
    assert.equal(content('a'.repeat(SCRIPT_CONTENT_MAX + 1)), false, op);
    assert.equal(content(''), false, op);
    assert.equal(content(' \n '), false, op);
  }

  // skill groups: personal must have none, team at least one, all unique decimal IDs
  assert.equal(validateEdit('VAGENT', { op: 'create_category', name: 'a', skill_group_ids: ['1'] }), false);
  assert.equal(validateEdit('VAGENT', { op: 'update_category', category_id: '1', name: 'a', skill_group_ids: ['1'] }), false);
  assert.equal(validateEdit('VSKILLGROUP', { op: 'create_category', name: 'a', skill_group_ids: [] }), false);
  assert.equal(validateEdit('VSKILLGROUP', { op: 'update_category', category_id: '1', name: 'a', skill_group_ids: [] }), false);
  assert.equal(validateEdit('VSKILLGROUP', { op: 'create_category', name: 'a', skill_group_ids: ['1'] }), true);
  assert.equal(validateEdit('VSKILLGROUP', { op: 'create_category', name: 'a', skill_group_ids: ['1', '1'] }), false);
  assert.equal(validateEdit('VSKILLGROUP', { op: 'create_category', name: 'a', skill_group_ids: ['x'] }), false);

  const id = (x: string): boolean => validateEdit('VAGENT', { op: 'delete_script', script_id: x });
  assert.equal(id('1'.repeat(19)), true);
  assert.equal(id('1'.repeat(20)), false);
  for (const bad of ['', 'abc', '-1', '1.5', ' 1', '1e3']) assert.equal(id(bad), false, bad);
  assert.equal(validateEdit('VAGENT', { op: 'move_script', script_id: '1', target_category_id: 'x' }), false);

  const list = (n: number): string[] => Array.from({ length: n }, (_, i) => String(i + 1));
  assert.equal(validateEdit('VAGENT', { op: 'sort_categories', category_ids: [] }), false);
  assert.equal(validateEdit('VAGENT', { op: 'sort_categories', category_ids: list(ID_LIST_MAX) }), true);
  assert.equal(validateEdit('VAGENT', { op: 'sort_categories', category_ids: list(ID_LIST_MAX + 1) }), false);
  assert.equal(validateEdit('VAGENT', { op: 'sort_categories', category_ids: ['1', '2', '1'] }), false);
  assert.equal(validateEdit('VAGENT', { op: 'sort_scripts', category_id: '1', script_ids: ['2', '2'] }), false);
  assert.equal(validateEdit('VAGENT', { op: 'sort_scripts', category_id: '1', script_ids: ['2', '3'] }), true);

  // an invalid edit never reaches the network
  const { out, calls } = await run(new FakeServer(personal()), 'VAGENT', { op: 'sort_categories', category_ids: ['101', '101'] });
  assert.deepEqual(verdict(out), { kind: 'rejected', reason: 'invalid' });
  assert.equal(calls.length, 0);
});

test('parseEdit accepts only the nine fixed shapes and drops extra fields', () => {
  for (const bad of [null, undefined, 'create_category', 1, [], {}, { op: 'unknown' }, { op: 'toString' }]) assert.equal(parseEdit(bad), null, JSON.stringify(bad));
  const missing: unknown[] = [
    { op: 'create_category', name: 'a' },
    { op: 'create_category', skill_group_ids: [] },
    { op: 'create_category', name: 'a', skill_group_ids: [1] },
    { op: 'update_category', name: 'a', skill_group_ids: [] },
    { op: 'update_category', category_id: '1', skill_group_ids: [] },
    { op: 'update_category', category_id: '1', name: 'a' },
    { op: 'delete_category' },
    { op: 'delete_category', category_id: 1 },
    { op: 'sort_categories' },
    { op: 'sort_categories', category_ids: '1' },
    { op: 'sort_categories', category_ids: ['1', 2] },
    { op: 'add_script', category_id: '1' },
    { op: 'add_script', content: 'x' },
    { op: 'update_script', content: 'x' },
    { op: 'update_script', script_id: '1' },
    { op: 'move_script', script_id: '1' },
    { op: 'move_script', target_category_id: '1' },
    { op: 'delete_script' },
    { op: 'sort_scripts', script_ids: ['1'] },
    { op: 'sort_scripts', category_id: '1' },
  ];
  for (const x of missing) assert.equal(parseEdit(x), null, JSON.stringify(x));

  const ids = ['1', '2'];
  const parsed = parseEdit({ op: 'sort_categories', category_ids: ids, extra: 'dropped' });
  assert.deepEqual(parsed, { op: 'sort_categories', category_ids: ['1', '2'] });
  ids.push('3');
  assert.deepEqual(parsed, { op: 'sort_categories', category_ids: ['1', '2'] });
  assert.deepEqual(parseEdit({ op: 'create_category', name: 'a', skill_group_ids: ['5'] }), { op: 'create_category', name: 'a', skill_group_ids: ['5'] });
  assert.deepEqual(parseEdit({ op: 'update_category', category_id: '1', name: 'a', skill_group_ids: [] }), { op: 'update_category', category_id: '1', name: 'a', skill_group_ids: [] });
  assert.deepEqual(parseEdit({ op: 'delete_category', category_id: '1' }), { op: 'delete_category', category_id: '1' });
  assert.deepEqual(parseEdit({ op: 'add_script', category_id: '1', content: 'x' }), { op: 'add_script', category_id: '1', content: 'x' });
  assert.deepEqual(parseEdit({ op: 'update_script', script_id: '1', content: 'x' }), { op: 'update_script', script_id: '1', content: 'x' });
  assert.deepEqual(parseEdit({ op: 'move_script', script_id: '1', target_category_id: '2' }), { op: 'move_script', script_id: '1', target_category_id: '2' });
  assert.deepEqual(parseEdit({ op: 'delete_script', script_id: '1' }), { op: 'delete_script', script_id: '1' });
  assert.deepEqual(parseEdit({ op: 'sort_scripts', category_id: '1', script_ids: ['2'] }), { op: 'sort_scripts', category_id: '1', script_ids: ['2'] });
});


// ------------------------------------------------------------------ adversarial review regressions

test('a business code is a refusal only when the read-back proves the target untouched', async () => {
  const fail = (): FetchResponseLike => ok({ bizResponseStatus: { resultCode: 'FAIL' } });

  // add with an incomplete pre-read (a row past the display depth): the new row cannot be told apart, so not rejected
  const deep = new FakeServer(personal());
  cat(deep.cats, '102')['subCategories'] = [{ id: 110, code: 'c', name: 's', subCategories: [{ id: 111, code: 'd', name: 'ss', subCategories: [{ id: 112, code: 'e', name: 'sss' }] }] }];
  deep.onWrite = (_n, body) => { scriptsOf(cat(deep.cats, '101')).push({ id: 299, content: body['content'], sortNo: 9 }); return fail(); };
  assert.deepEqual(verdict((await run(deep, 'VAGENT', { op: 'add_script', category_id: '101', content: 'new reply' })).out), { kind: 'unknown', reason: 'unverified' });

  // create with an incomplete pre-read and a row that appeared: unknown
  const odd = new FakeServer(personal());
  odd.cats.push({ id: 'bad-id', name: 'z' });
  odd.onWrite = (_n, body) => { odd.cats.push({ id: 103, code: 'cat-c', name: body['name'], ownerType: 1 }); return fail(); };
  assert.deepEqual(verdict((await run(odd, 'VAGENT', { op: 'create_category', name: 'New', skill_group_ids: [] })).out), { kind: 'unknown', reason: 'unverified' });

  // delete applied, but the read-back is incomplete so absence is unproven: unknown, not "refused"
  const hidden = new FakeServer(personal());
  hidden.override['getCategories'] = (n) => (n === 1 ? ok({ categories: [...clone(hidden.cats), { id: 'not-an-id', name: 'x' }] }) : undefined);
  hidden.onWrite = () => { scriptsOf(cat(hidden.cats, '101')).splice(1, 1); return fail(); };
  assert.deepEqual(verdict((await run(hidden, 'VAGENT', { op: 'delete_script', script_id: '202' })).out), { kind: 'unknown', reason: 'unverified' });

  // a team rename that landed without its scope change: partly changed is not "untouched"
  const partial = new FakeServer(team());
  partial.onWrite = (_n, body) => { cat(partial.cats, '301')['name'] = body['name']; return ok({ bizResponseStatus: { resultCode: 'PARTIAL' } }); };
  assert.deepEqual(verdict((await run(partial, 'VSKILLGROUP', { op: 'update_category', category_id: '301', name: 'Renamed', skill_group_ids: ['501', '502'] })).out), { kind: 'unknown', reason: 'unverified' });

  // complete reads on both sides and nothing new: the refusal stands
  const refused = new FakeServer(personal());
  refused.onWrite = () => fail();
  assert.deepEqual(verdict((await run(refused, 'VAGENT', { op: 'create_category', name: 'New', skill_group_ids: [] })).out), { kind: 'rejected', reason: 'business', detail: 'FAIL' });
  for (const edit of [
    { op: 'add_script', category_id: '101', content: 'x' },
    { op: 'delete_category', category_id: '101' },
    { op: 'sort_categories', category_ids: ['102', '101'] },
    { op: 'move_script', script_id: '201', target_category_id: '102' },
    { op: 'delete_script', script_id: '201' },
    { op: 'sort_scripts', category_id: '101', script_ids: ['202', '201'] },
  ] as QuickReplyEdit[]) {
    const srv = new FakeServer(personal());
    srv.onWrite = () => fail();
    assert.deepEqual(verdict((await run(srv, 'VAGENT', edit)).out), { kind: 'rejected', reason: 'business', detail: 'FAIL' }, edit.op);
  }
});

test('only an Ack Failure is a refusal; any other non-Success Ack is read back', async () => {
  const warn = (): FetchResponseLike => jsonResponse({ ResponseStatus: { ...OK_STATUS, Ack: 'Warning' } });
  const landed = new FakeServer(personal());
  landed.onWrite = (_n, body) => { landed.cats.push({ id: 103, code: 'cat-c', name: body['name'], ownerType: 1 }); return warn(); };
  const a = await run(landed, 'VAGENT', { op: 'create_category', name: 'New', skill_group_ids: [] });
  assert.deepEqual(verdict(a.out), { kind: 'applied' });
  assert.deepEqual(a.calls.map((c) => c.name), ['getCategories', 'createRootCategory', 'getCategories']);

  const silent = new FakeServer(personal());
  silent.onWrite = () => warn();
  assert.deepEqual(verdict((await run(silent, 'VAGENT', { op: 'delete_script', script_id: '201' })).out), { kind: 'unknown', reason: 'write_unknown' });
});

test('a timed-out write keeps the page lock until its request ends, for at most the hold bound', async () => {
  const srv = new FakeServer(personal());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  srv.onWrite = (_n, body) => {
    writes++;
    const apply = (): void => { scriptsOf(cat(srv.cats, '101'))[0]!['content'] = body['content']; };
    if (writes === 1) return gate.then(() => { apply(); return ok(); });
    apply();
    return undefined;
  };
  const { deps, rpc } = rpcSetup(srv);
  const first = rpc.handle(editReq('w1', 'VAGENT', { op: 'update_script', script_id: '201', content: 'X' }));
  await drain();
  await deps.clock.advance(WRITE_REQUEST_TIMEOUT_MS);
  await drain();
  assert.deepEqual(verdict(dataOf(await first) as unknown as QuickReplyEditOutcome), { kind: 'unknown', reason: 'write_unknown' });
  // the first request is still out: a second write could land before it, so it waits
  assert.deepEqual(dataOf(await rpc.handle(editReq('w2', 'VAGENT', { op: 'update_script', script_id: '201', content: 'Y' }))), { kind: 'rejected', reason: 'busy' });
  release();
  await drain();
  assert.equal(dataOf(await rpc.handle(editReq('w3', 'VAGENT', { op: 'update_script', script_id: '201', content: 'Y' })))['kind'], 'applied');
  assert.equal(scriptsOf(cat(srv.cats, '101'))[0]!['content'], 'Y');
  assert.equal(writes, 2);

  // a request that never ends frees the lock after the bound
  const stuck = new FakeServer(personal());
  stuck.onWrite = () => 'hang';
  const s = rpcSetup(stuck);
  const hung = s.rpc.handle(editReq('h1', 'VAGENT', { op: 'delete_script', script_id: '201' }));
  await drain();
  await s.deps.clock.advance(WRITE_REQUEST_TIMEOUT_MS);
  await drain();
  assert.equal(dataOf(await hung)['kind'], 'unknown');
  assert.deepEqual(dataOf(await s.rpc.handle(editReq('h2', 'VAGENT', { op: 'delete_script', script_id: '202' }))), { kind: 'rejected', reason: 'busy' });
  await s.deps.clock.advance(QUICK_REPLY_WRITE_HOLD_MAX_MS);
  await drain();
  stuck.onWrite = () => { scriptsOf(cat(stuck.cats, '101')).splice(1, 1); return undefined; };
  assert.equal(dataOf(await s.rpc.handle(editReq('h3', 'VAGENT', { op: 'delete_script', script_id: '202' })))['kind'], 'applied');
});

test('a crash once the write may be out is unknown, never a page error', async () => {
  const srv = new FakeServer(personal());
  let deps!: FakeDeps;
  const guard = (): (() => boolean) => () => {
    if (writesOf(deps).length > 0) throw new Error('boom');
    return true;
  };
  const s = rpcSetup(srv, { captureWriteGuard: guard });
  deps = s.deps;
  assert.deepEqual(dataOf(await s.rpc.handle(editReq('c1', 'VAGENT', { op: 'delete_script', script_id: '201' }))), { kind: 'unknown', reason: 'write_unknown' });
  assert.equal(writesOf(deps).length, 1);
});

test('an unanswered create or add needs exactly one new matching row', async () => {
  const twice = (answered: boolean): FakeServer => {
    const srv = new FakeServer(personal());
    srv.onWrite = (_n, body) => {
      scriptsOf(cat(srv.cats, '101')).push({ id: 298, content: body['content'], sortNo: 8 }, { id: 299, content: body['content'], sortNo: 9 });
      return answered ? undefined : jsonResponse('x', 502);
    };
    return srv;
  };
  const add: QuickReplyEdit = { op: 'add_script', category_id: '101', content: 'dup' };
  assert.deepEqual(verdict((await run(twice(false), 'VAGENT', add)).out), { kind: 'unknown', reason: 'write_unknown' });
  assert.deepEqual(verdict((await run(twice(true), 'VAGENT', add)).out), { kind: 'applied' });

  const once = new FakeServer(personal());
  once.onWrite = (_n, body) => { once.cats.push({ id: 103, code: 'cat-c', name: body['name'], ownerType: 1 }); return jsonResponse('x', 502); };
  assert.deepEqual(verdict((await run(once, 'VAGENT', { op: 'create_category', name: 'New', skill_group_ids: [] })).out), { kind: 'applied' });
});

test('a team create is proven only with the submitted scope', async () => {
  const srv = new FakeServer(team());
  srv.onWrite = (_n, body) => { srv.cats.push({ id: 302, code: 'team-b', name: body['name'], ownerType: 2, vSkillGroups: [] }); return undefined; };
  assert.deepEqual(verdict((await run(srv, 'VSKILLGROUP', { op: 'create_category', name: 'T2', skill_group_ids: ['501', '502'] })).out), { kind: 'unknown', reason: 'unverified' });
});

test('a move is not proven by a read-back that lists the script twice', async () => {
  const srv = new FakeServer(personal());
  srv.override['getCategories'] = (n) => {
    if (n === 0) return undefined;
    const cats = clone(srv.cats);
    scriptsOf(cat(cats, '102')).push({ id: 201, content: 'reply-a1', sortNo: 5 });
    return ok({ categories: cats.reverse() });
  };
  assert.deepEqual(verdict((await run(srv, 'VAGENT', { op: 'move_script', script_id: '201', target_category_id: '102' })).out), { kind: 'unknown', reason: 'unverified' });
});

test('a team rename may keep scope entries the leader list does not offer, sent as read', async () => {
  const srv = new FakeServer(team());
  cat(srv.cats, '301')['vSkillGroups'] = [{ skillGroupId: 501, skillGroupName: 'SG1' }, { skillGroupId: '999', skillGroupName: 'Other' }];
  srv.onWrite = (_n, body) => { cat(srv.cats, '301')['name'] = body['name']; return undefined; };
  const r = await run(srv, 'VSKILLGROUP', { op: 'update_category', category_id: '301', name: 'Renamed', skill_group_ids: ['501', '999'] });
  assert.deepEqual(verdict(r.out), { kind: 'applied' });
  assert.deepEqual(writesOf(r.deps)[0]!.body['vSkillGroupIds'], [501, '999']);
  // an ID in neither list is still stale
  const unknownScope = await run(new FakeServer(team()), 'VSKILLGROUP', { op: 'update_category', category_id: '301', name: 'Renamed', skill_group_ids: ['501', '777'] });
  assert.deepEqual(verdict(unknownScope.out), { kind: 'rejected', reason: 'stale' });
  assert.equal(writesOf(unknownScope.deps).length, 0);
});

test('adds, moves and script sorts target root groups only (what the editor offers)', async () => {
  const withSub = (): FakeServer => {
    const srv = new FakeServer(personal());
    cat(srv.cats, '101')['subCategories'] = [{ id: 150, code: 'sub', name: 'Sub', ownerType: 1, customerScripts: [{ id: 250, content: 's1', sortNo: 0 }, { id: 251, content: 's2', sortNo: 1 }] }];
    return srv;
  };
  for (const edit of [
    { op: 'add_script', category_id: '150', content: 'x' },
    { op: 'move_script', script_id: '201', target_category_id: '150' },
    { op: 'sort_scripts', category_id: '150', script_ids: ['251', '250'] },
  ] as QuickReplyEdit[]) {
    const r = await run(withSub(), 'VAGENT', edit);
    assert.deepEqual(verdict(r.out), { kind: 'rejected', reason: 'stale' }, edit.op);
    assert.equal(writesOf(r.deps).length, 0, edit.op);
  }
});

test('script_total counts every server row a delete removes, blank and over-budget rows included', async () => {
  const big = Array.from({ length: 1001 }, (_, i) => ({ id: 10000 + i, content: `r${i}`, sortNo: i }));
  const srv = new FakeServer([
    { id: 101, code: 'cat-a', name: 'Big', ownerType: 1, customerScripts: big },
    { id: 102, code: 'cat-b', name: 'Later', ownerType: 1, customerScripts: [{ id: 501, content: 'x1', sortNo: 0 }, { id: 502, content: '   ', sortNo: 1 }], subCategories: [{ id: 103, code: 'cat-c', name: 'Sub', customerScripts: [{ id: 503, content: 'x3', sortNo: 0 }] }] },
  ]);
  const { rpc } = rpcSetup(srv);
  const list = dataOf(await rpc.handle({ req_id: 'r', op: 'im.quick_reply_categories', args: { type: 'VAGENT' } }))['categories'] as Rec[];
  const later = list.find((c) => c['id'] === '102')!;
  // the display budget (1000) is spent by "Big" and the blank row is dropped, yet the totals are exact
  assert.equal((later['scripts'] as Rec[]).length, 0);
  assert.equal(later['script_total'], 3);
  assert.equal(list.find((c) => c['id'] === '101')!['script_total'], 1001);
});
