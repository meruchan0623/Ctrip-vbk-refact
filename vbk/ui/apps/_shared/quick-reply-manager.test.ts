import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDom, fakeDocument, type FakeElement } from '../../tests/fake-dom.ts';
import { mountQuickReplyManager, moveItem, QUICK_REPLY_CONTENT_MAX, QUICK_REPLY_NAME_MAX, type QuickReplyChange } from './quick-reply-manager.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import { UiCommands, type UiQuickReplyCategory, type UiQuickReplyEdit, type UiQuickReplyManageInfo, type UiQuickReplySkillGroup, type UiQuickReplyType } from '../../packages/ipc/src/client.ts';
import { ErrorCodes, type AccountContext } from '../../packages/ipc/src/contracts.ts';

const ACCOUNT: AccountContext = { account_id: 'acc-1', environment: 'production', session_generation: 3 };
const GROUPS: UiQuickReplySkillGroup[] = [{ id: '7001', name: 'Pre-sale' }, { id: '7002', name: 'After-sale' }];
function cat(id: string, name: string, scripts: [string, string][], skill_groups?: UiQuickReplySkillGroup[]): UiQuickReplyCategory {
  return { id, name, scripts: scripts.map(([sid, content]) => ({ id: sid, content, short_cut: '', type: 'text' })), sub_categories: [], ...(skill_groups ? { skill_groups } : {}) };
}
const LIST: UiQuickReplyCategory[] = [cat('1', 'Alpha', [['11', 'one'], ['12', 'two'], ['13', 'three']]), cat('2', 'Beta', [['21', 'four']]), cat('3', 'Gamma', [])];

function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

interface FixtureOptions { categories?: UiQuickReplyCategory[]; info?: UiQuickReplyManageInfo; type?: UiQuickReplyType; edit?: (edit: UiQuickReplyEdit) => unknown }
async function fixture(options: FixtureOptions = {}) {
  const { root } = installFakeDom();
  const calls: { command: string; payload: { account: AccountContext; type: UiQuickReplyType; edit?: UiQuickReplyEdit } }[] = [];
  const changes: QuickReplyChange[] = [], types: UiQuickReplyType[] = [], busyLog: boolean[] = [];
  const io = {
    list: options.categories ?? LIST,
    info: options.info ?? { can_edit: true, skill_groups: [] } as UiQuickReplyManageInfo,
    read: null as null | (() => Promise<unknown>),
    edit: options.edit ?? ((): unknown => ({ kind: 'applied', categories: io.list })),
  };
  const invoke = async (command: string, payload?: unknown): Promise<unknown> => {
    calls.push({ command, payload: payload as (typeof calls)[number]['payload'] });
    if (command === UiCommands.IM_QUICK_REPLY_CATEGORIES) return io.read ? io.read() : { categories: io.list };
    if (command === UiCommands.IM_QUICK_REPLY_MANAGE_INFO) return io.info;
    if (command === UiCommands.IM_QUICK_REPLY_EDIT) return io.edit((payload as { edit: UiQuickReplyEdit }).edit);
    throw new Error(`unexpected ${command}`);
  };
  const manager = mountQuickReplyManager(root as unknown as HTMLElement, {
    invoke, account: ACCOUNT, ...(options.type ? { type: options.type } : {}),
    onChanged: change => changes.push(change), onTypeChange: type => types.push(type), onBusyChange: busy => busyLog.push(busy),
  });
  await flush();
  const q = (selector: string) => root.querySelector(selector);
  const must = (selector: string) => { const el = q(selector); assert.ok(el, `missing ${selector}`); return el; };
  return {
    root, manager, calls, changes, types, busyLog, io, q, must,
    all: (selector: string) => root.querySelectorAll(selector),
    edits: () => calls.filter(c => c.command === UiCommands.IM_QUICK_REPLY_EDIT).map(c => c.payload.edit),
    reads: () => calls.filter(c => c.command === UiCommands.IM_QUICK_REPLY_CATEGORIES),
    groups: () => root.querySelectorAll('[data-qr="group"]').map(el => el.getAttribute('data-id')),
    scripts: () => root.querySelectorAll('[data-qr="script"]').map(el => el.getAttribute('data-id')),
    group: (id: string) => must(`[data-qr="group"][data-id="${id}"]`),
    script: (id: string) => must(`[data-qr="script"][data-id="${id}"]`),
    within: (el: FakeElement, selector: string) => { const found = el.querySelector(selector); assert.ok(found, `missing ${selector}`); return found; },
    notice: () => q('[data-qr="notice"]')?.textContent ?? null,
  };
}
/** Fires an event carrying `preventDefault` (fake-dom's own `dispatch` does not). */
function fire(el: FakeElement, type: string, extra: Record<string, unknown> = {}) {
  const event = { type, target: el, currentTarget: el, defaultPrevented: false, dataTransfer: null, preventDefault() { event.defaultPrevented = true; }, ...extra };
  for (const fn of [...(el.listeners.get(type) ?? [])]) fn.call(el, event as never);
  return event;
}
function typeInto(el: FakeElement, text: string) { el.value = text; fire(el, 'input'); }
function drag(from: FakeElement, to: FakeElement) {
  fire(from, 'dragstart');
  const over = fire(to, 'dragover');
  assert.equal(over.defaultPrevented, true, 'a sortable row accepts the drop');
  fire(to, 'drop');
  fire(from, 'dragend');
}

test('moveItem moves one entry, clamps the target and never mutates the input', () => {
  const list = ['a', 'b', 'c', 'd'] as const;
  assert.deepEqual(moveItem(list, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(list, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveItem(list, 1, 99), ['a', 'c', 'd', 'b']);
  assert.deepEqual(moveItem(list, 2, -5), ['c', 'a', 'b', 'd']);
  for (const [from, to] of [[4, 0], [-1, 0], [1.5, 0], [1, 1], [0, Number.NaN]] as const) {
    const out = moveItem(list, from, to);
    assert.deepEqual(out, list); assert.notEqual(out, list);
  }
  assert.deepEqual(list, ['a', 'b', 'c', 'd']);
  assert.deepEqual(moveItem([], 0, 0), []);
});

test('lists groups with counts and scripts of the selected group; reads carry the bound account and type', async () => {
  const f = await fixture();
  assert.deepEqual(f.groups(), ['1', '2', '3']);
  assert.deepEqual(f.scripts(), ['11', '12', '13']);
  assert.equal(f.within(f.group('1'), '[data-qr="select-cat"]').textContent, `Alpha${t('qrManage.groupCount', { count: 3 })}`);
  assert.equal(f.within(f.group('1'), '[data-qr="select-cat"]').getAttribute('aria-current'), 'true');
  assert.deepEqual(f.calls.map(c => [c.command, c.payload]), [
    [UiCommands.IM_QUICK_REPLY_CATEGORIES, { account: ACCOUNT, type: 'VAGENT' }],
    [UiCommands.IM_QUICK_REPLY_MANAGE_INFO, { account: ACCOUNT, type: 'VAGENT' }],
  ]);
  f.within(f.group('3'), '[data-qr="select-cat"]').dispatch('click');
  assert.deepEqual(f.scripts(), []);
  assert.equal(f.must('[data-qr="scripts-empty"]').textContent, t('qrManage.scriptsEmpty'));
  assert.equal(f.group('1').getAttribute('draggable'), 'true');
  assert.equal(f.group('1').getAttribute('title'), t('qrManage.dragHint'));
});

test('deletes go through the in-component confirm bar; cancel sends nothing and controls lock while the write is out', async () => {
  const pending = deferred<unknown>();
  const f = await fixture();
  fire(f.within(f.script('12'), '[data-qr="delete-script"]'), 'click');
  assert.equal(f.must('[data-qr="confirm"]').querySelector('span')?.textContent, t('qrManage.confirm.script'));
  f.must('[data-qr="confirm-cancel"]').dispatch('click');
  assert.equal(f.q('[data-qr="confirm"]'), null);
  assert.deepEqual(f.edits(), []);

  fire(f.within(f.group('1'), '[data-qr="delete-cat"]'), 'click');
  assert.equal(f.must('[data-qr="confirm"]').querySelector('span')?.textContent, t('qrManage.confirm.group', { name: 'Alpha', count: 3 }));
  f.io.edit = () => pending.promise;
  f.must('[data-qr="confirm-ok"]').dispatch('click');
  await flush();
  assert.deepEqual(f.edits(), [{ op: 'delete_category', category_id: '1' }]);
  // fake-dom does not reflect `disabled` into attributes, so morph cannot carry it: check behaviour instead.
  assert.equal(f.must('[data-qr="root"]').getAttribute('aria-busy'), 'true');
  assert.equal(f.group('2').hasAttribute('draggable'), false, 'no drag while a write is out');
  f.must('[data-qr="confirm-ok"]').dispatch('click');
  f.must('[data-qr="create-cat"]').dispatch('click');
  fire(f.within(f.group('2'), '[data-qr="delete-cat"]'), 'click');
  f.must('[data-qr-tab="VSKILLGROUP"]').dispatch('click');
  assert.equal(f.edits().length, 1, 'one write at a time');
  assert.equal(f.q('[data-qr="create-form"]'), null);
  assert.equal(f.must('[data-qr="confirm"]').querySelector('span')?.textContent, t('qrManage.confirm.group', { name: 'Alpha', count: 3 }));
  assert.deepEqual(f.types, []);

  const after = LIST.slice(1);
  pending.resolve({ kind: 'applied', categories: after });
  await flush();
  assert.equal(f.q('[data-qr="confirm"]'), null);
  assert.deepEqual(f.groups(), ['2', '3']);
  assert.deepEqual(f.scripts(), ['21'], 'selection falls back to the first remaining group');
  assert.equal(f.must('[data-qr="root"]').hasAttribute('aria-busy'), false);
  assert.deepEqual(f.changes, [{ account: ACCOUNT, type: 'VAGENT', categories: after }]);
  assert.equal(f.notice(), null);
  assert.equal(readFileSync(new URL('./quick-reply-manager.ts', import.meta.url), 'utf8').includes('window.confirm'), false);
});

test('unknown results are never resent: the read-back list is adopted, or the list is re-read, and no retry control is offered', async () => {
  const f = await fixture();
  const moved = [cat('1', 'Alpha', [['11', 'one'], ['12', 'two'], ['13', 'three'], ['90', 'new line']]), LIST[1]!, LIST[2]!];
  f.io.edit = () => ({ kind: 'unknown', reason: 'unverified', categories: moved });
  f.must('[data-qr="add-script"]').dispatch('click');
  typeInto(f.must('[data-qr="content"]'), '  new line ');
  f.must('[data-qr="save"]').dispatch('click');
  await flush();
  assert.deepEqual(f.edits(), [{ op: 'add_script', category_id: '1', content: 'new line' }]);
  assert.equal(f.notice(), t('qrManage.result.unknown'));
  assert.equal(f.must('[data-qr="notice"]').querySelector('button'), null, 'no retry button');
  assert.equal(f.q('[data-qr="reload"]'), null);
  assert.equal(f.q('[data-qr="add-form"]'), null, 'the form closes so the same write cannot be resubmitted');
  assert.deepEqual(f.scripts(), ['11', '12', '13', '90']);
  assert.deepEqual(f.changes.at(-1), { account: ACCOUNT, type: 'VAGENT', categories: moved });

  // No list in the answer: re-read.
  const readsBefore = f.reads().length;
  f.io.list = moved;
  f.io.edit = () => ({ kind: 'unknown', reason: 'write_unknown' });
  fire(f.within(f.script('90'), '[data-qr="delete-script"]'), 'click');
  f.must('[data-qr="confirm-ok"]').dispatch('click');
  await flush();
  assert.equal(f.reads().length, readsBefore + 1);
  assert.equal(f.notice(), t('qrManage.result.unknown'));
  assert.equal(f.q('[data-qr="confirm"]'), null);
  assert.equal(f.edits().length, 2);

  // A malformed answer or a throw without the host's error shape is just as unknown.
  for (const answer of [{ kind: 'maybe' }, { kind: 'applied', categories: [{ id: 1 }] }, new Error('bridge dropped')]) {
    f.io.edit = () => { if (answer instanceof Error) throw answer; return answer; };
    fire(f.within(f.script('11'), '[data-qr="delete-script"]'), 'click');
    f.must('[data-qr="confirm-ok"]').dispatch('click');
    await flush();
    assert.equal(f.notice(), t('qrManage.result.unknown'));
    assert.deepEqual(f.scripts(), ['11', '12', '13', '90']);
  }
  assert.equal(f.edits().length, 5);
});

test('an account or generation change discards in-flight writes and reads, then re-reads for the new binding', async () => {
  const write = deferred<unknown>();
  const f = await fixture();
  f.io.edit = () => write.promise;
  fire(f.within(f.script('11'), '[data-qr="delete-script"]'), 'click');
  f.must('[data-qr="confirm-ok"]').dispatch('click');
  await flush();
  const next: AccountContext = { ...ACCOUNT, session_generation: 4 };
  const fresh = [cat('5', 'Fresh', [['51', 'fresh one']])];
  f.io.list = fresh;
  f.manager.setAccount(next);
  assert.equal(f.q('[data-qr="confirm"]'), null, 'the confirm bar of the old binding is gone');
  await flush();
  assert.deepEqual(f.reads().at(-1)?.payload, { account: next, type: 'VAGENT' });
  assert.deepEqual(f.groups(), ['5']);
  write.resolve({ kind: 'applied', categories: [cat('9', 'Late', [])] });
  await flush();
  assert.deepEqual(f.groups(), ['5'], 'the old generation result is ignored');
  assert.equal(f.notice(), null);
  assert.deepEqual(f.changes, []);
  f.must('[data-qr="create-cat"]').dispatch('click');
  assert.ok(f.q('[data-qr="create-form"]'), 'the old write no longer holds the lock');

  // A read still out for the old generation cannot overwrite the new one.
  const slow = deferred<unknown>();
  f.io.read = () => slow.promise;
  void f.manager.refresh();
  f.io.read = null;
  const other: AccountContext = { account_id: 'acc-2', environment: 'production', session_generation: 1 };
  f.manager.setAccount(other);
  await flush();
  slow.resolve({ categories: [cat('8', 'Stale read', [])] });
  await flush();
  assert.deepEqual(f.groups(), ['5']);
  assert.deepEqual(f.reads().at(-1)?.payload, { account: other, type: 'VAGENT' });

  const count = f.calls.length;
  f.manager.setAccount({ ...other });
  await flush();
  assert.equal(f.calls.length, count, 'the same context is a no-op');
  f.manager.setAccount(null);
  assert.equal(f.must('[data-qr="no-account"]').textContent, t('qrManage.noAccount'));
  f.manager.destroy();
  assert.equal(f.root.childNodes.length, 0);
});

test('a team list for a non-leader is read-only; a not_leader refusal switches a leader view to read-only', async () => {
  const team = [cat('2001', 'Team', [['2101', 'team one'], ['2102', 'team two']], [GROUPS[0]!]), cat('2002', 'Policy', [], GROUPS)];
  const f = await fixture({ type: 'VSKILLGROUP', categories: team, info: { can_edit: false, skill_groups: GROUPS } });
  assert.equal(f.must('[data-qr="readonly"]').textContent, t('qrManage.readonlyTeam'));
  for (const control of ['create-cat', 'rename-cat', 'delete-cat', 'add-script', 'edit-script', 'delete-script', 'move-script']) assert.equal(f.q(`[data-qr="${control}"]`), null, control);
  assert.equal(f.group('2001').hasAttribute('draggable'), false);
  assert.equal(f.script('2101').hasAttribute('draggable'), false);
  assert.equal(f.must('[data-qr="scope"]').textContent, t('qrManage.scopeList', { names: 'Pre-sale' }));
  assert.equal(f.must('[data-qr-tab="VSKILLGROUP"]').getAttribute('aria-selected'), 'true');
  f.must('[data-qr-tab="VAGENT"]').dispatch('click');
  await flush();
  assert.deepEqual(f.types, ['VAGENT']);
  assert.deepEqual(f.reads().at(-1)?.payload, { account: ACCOUNT, type: 'VAGENT' });
  assert.equal(f.q('[data-qr="readonly"]'), null);

  const g = await fixture({ type: 'VSKILLGROUP', categories: team, info: { can_edit: true, skill_groups: GROUPS } });
  assert.equal(g.q('[data-qr="readonly"]'), null);
  g.io.edit = () => ({ kind: 'rejected', reason: 'not_leader', categories: team });
  fire(g.within(g.script('2101'), '[data-qr="delete-script"]'), 'click');
  g.must('[data-qr="confirm-ok"]').dispatch('click');
  await flush();
  assert.equal(g.notice(), t('qrManage.readonlyTeam'));
  assert.ok(g.q('[data-qr="readonly"]'));
  assert.equal(g.q('[data-qr="delete-script"]'), null);
  assert.deepEqual(g.changes, []);
});

test('a rejected reorder rolls back the optimistic order; refusals and pre-send errors are explained', async () => {
  const write = deferred<unknown>();
  const f = await fixture();
  f.io.edit = () => write.promise;
  drag(f.script('11'), f.script('13'));
  await flush();
  assert.deepEqual(f.edits(), [{ op: 'sort_scripts', category_id: '1', script_ids: ['12', '13', '11'] }]);
  assert.deepEqual(f.scripts(), ['12', '13', '11'], 'optimistic order while the write is out');
  assert.equal(f.script('12').hasAttribute('data-drop'), false);
  write.resolve({ kind: 'rejected', reason: 'busy' });
  await flush();
  assert.deepEqual(f.scripts(), ['11', '12', '13']);
  assert.equal(f.notice(), t('qrManage.result.busy'));

  f.io.edit = () => ({ kind: 'rejected', reason: 'stale', categories: LIST });
  drag(f.group('3'), f.group('1'));
  await flush();
  assert.deepEqual(f.edits().at(-1), { op: 'sort_categories', category_ids: ['3', '1', '2'] });
  assert.deepEqual(f.groups(), ['1', '2', '3']);
  assert.equal(f.notice(), t('qrManage.result.stale'));

  const reordered = [LIST[1]!, LIST[0]!, LIST[2]!];
  f.io.edit = () => ({ kind: 'applied', categories: reordered });
  drag(f.group('2'), f.group('1'));
  await flush();
  assert.deepEqual(f.groups(), ['2', '1', '3']);
  assert.equal(f.notice(), null);

  // Dropping a row on itself, or a script on a group, sends nothing.
  const sent = f.edits().length;
  drag(f.group('2'), f.group('2'));
  fire(f.script('11'), 'dragstart');
  assert.equal(fire(f.group('2'), 'dragover').defaultPrevented, false);
  fire(f.group('2'), 'drop');
  assert.equal(f.edits().length, sent);

  const cases: [unknown, string][] = [
    [{ kind: 'rejected', reason: 'business', detail: 'ERR_42' }, t('qrManage.result.businessCode', { code: 'ERR_42' })],
    [{ kind: 'rejected', reason: 'business', detail: 'free text <b>' }, t('qrManage.result.business')],
    [{ kind: 'rejected', reason: 'auth' }, t('qrManage.result.auth')],
    [{ kind: 'rejected', reason: 'invalid' }, t('qrManage.result.invalid')],
    [{ kind: 'rejected', reason: 'not_submitted' }, t('qrManage.result.notSubmitted')],
    [{ code: ErrorCodes.ADAPTER_NOT_READY, message: 'not ready', retryable: true }, t('qrManage.result.notSubmitted')],
    [{ code: ErrorCodes.ACCOUNT_TICKET_EXPIRED, message: 'expired', retryable: false }, t('qrManage.result.auth')],
  ];
  for (const [answer, text] of cases) {
    f.io.edit = () => { if ('code' in (answer as object)) throw answer; return answer; };
    drag(f.script('11'), f.script('12'));
    await flush();
    assert.deepEqual(f.scripts(), ['11', '12', '13'], text);
    assert.equal(f.notice(), text);
  }
  assert.deepEqual(f.changes.length, 1);
});

test('forms validate locally before any write; a created group is selected; unchanged edits send nothing', async () => {
  const f = await fixture();
  f.must('[data-qr="create-cat"]').dispatch('click');
  const name = f.must('[data-qr="name"]');
  assert.equal(fakeDocument.activeElement, name, 'the new form takes focus');
  assert.equal(name.getAttribute('maxlength'), String(QUICK_REPLY_NAME_MAX));
  f.must('[data-qr="save"]').dispatch('click');
  assert.equal(f.must('[data-qr="form-error"]').textContent, t('qrManage.validate.nameRequired'));
  typeInto(f.must('[data-qr="name"]'), 'x'.repeat(QUICK_REPLY_NAME_MAX + 1));
  f.must('[data-qr="save"]').dispatch('click');
  assert.equal(f.must('[data-qr="form-error"]').textContent, t('qrManage.validate.nameTooLong', { max: QUICK_REPLY_NAME_MAX }));
  assert.deepEqual(f.edits(), []);
  const created = [...LIST, cat('4', 'Delta', [])];
  f.io.edit = () => ({ kind: 'applied', categories: created });
  typeInto(f.must('[data-qr="name"]'), ' Delta ');
  fire(f.must('[data-qr="name"]'), 'keydown', { key: 'Enter' });
  await flush();
  assert.deepEqual(f.edits(), [{ op: 'create_category', name: 'Delta', skill_group_ids: [] }]);
  assert.equal(f.within(f.group('4'), '[data-qr="select-cat"]').getAttribute('aria-current'), 'true');
  assert.equal(f.q('[data-qr="create-form"]'), null);

  fire(f.within(f.group('1'), '[data-qr="rename-cat"]'), 'click');
  assert.equal(f.must('[data-qr="name"]').value, 'Alpha');
  f.must('[data-qr="save"]').dispatch('click');
  assert.equal(f.q('[data-qr="rename-form"]'), null);
  f.within(f.group('1'), '[data-qr="select-cat"]').dispatch('click');
  fire(f.within(f.script('11'), '[data-qr="edit-script"]'), 'click');
  typeInto(f.must('[data-qr="content"]'), ' one ');
  f.must('[data-qr="save"]').dispatch('click');
  assert.equal(f.q('[data-qr="edit-form"]'), null);
  f.must('[data-qr="add-script"]').dispatch('click');
  typeInto(f.must('[data-qr="content"]'), '   ');
  f.must('[data-qr="save"]').dispatch('click');
  assert.equal(f.must('[data-qr="form-error"]').textContent, t('qrManage.validate.contentRequired'));
  typeInto(f.must('[data-qr="content"]'), 'y'.repeat(QUICK_REPLY_CONTENT_MAX + 1));
  f.must('[data-qr="save"]').dispatch('click');
  assert.equal(f.must('[data-qr="form-error"]').textContent, t('qrManage.validate.contentTooLong', { max: QUICK_REPLY_CONTENT_MAX }));
  assert.equal(f.edits().length, 1);

  const move = f.within(f.script('12'), '[data-qr="move-script"]');
  assert.deepEqual(move.querySelectorAll('option').map(o => o.value), ['', '2', '3', '4']);
  f.io.edit = () => ({ kind: 'applied', categories: LIST });
  move.value = '2';
  fire(move, 'change');
  await flush();
  assert.deepEqual(f.edits().at(-1), { op: 'move_script', script_id: '12', target_category_id: '2' });
});

test('team groups need a scope picked from the offered skill groups; no skill groups blocks creation', async () => {
  const team = [cat('2001', 'Team', [], [GROUPS[0]!])];
  const f = await fixture({ type: 'VSKILLGROUP', categories: team, info: { can_edit: true, skill_groups: GROUPS } });
  f.must('[data-qr="create-cat"]').dispatch('click');
  typeInto(f.must('[data-qr="name"]'), 'Night');
  f.must('[data-qr="save"]').dispatch('click');
  assert.equal(f.must('[data-qr="form-error"]').textContent, t('qrManage.validate.scopeRequired'));
  const option = f.must('[data-qr="group-option"][data-id="7002"]');
  option.checked = true;
  fire(option, 'change');
  f.must('[data-qr="save"]').dispatch('click');
  await flush();
  assert.deepEqual(f.edits(), [{ op: 'create_category', name: 'Night', skill_group_ids: ['7002'] }]);

  const g = await fixture({ type: 'VSKILLGROUP', categories: team, info: { can_edit: true, skill_groups: [] } });
  assert.equal(g.must('[data-qr="create-cat"]').disabled, true);
  assert.equal(g.must('[data-qr="no-skill-groups"]').textContent, t('qrManage.noSkillGroups'));
});

test('a failed or malformed read offers a reload, not a write retry', async () => {
  const f = await fixture();
  f.io.read = async () => ({ categories: 'nope' });
  f.manager.setType('VSKILLGROUP');
  await flush();
  assert.equal(f.must('[data-qr="load-error"]').querySelector('span')?.textContent, t('qrManage.loadFailed'));
  f.io.read = null;
  f.must('[data-qr="reload"]').dispatch('click');
  await flush();
  assert.equal(f.q('[data-qr="load-error"]'), null);
  assert.deepEqual(f.groups(), ['1', '2', '3']);
  assert.deepEqual(f.edits(), []);
  assert.deepEqual(f.types, [], 'setType from the host window does not echo onTypeChange');
});

test('a group delete names the server-row total when the adapter reports one, never fewer than the listed rows', async () => {
  const list: UiQuickReplyCategory[] = [
    { ...cat('1', 'Alpha', [['11', 'one'], ['12', 'two']]), script_total: 1005 },
    { ...cat('2', 'Beta', [['21', 'four'], ['22', 'five']]), script_total: 1 },
    { ...cat('3', 'Gamma', [['31', 'six']]), script_total: 2.5 },
  ];
  const f = await fixture({ categories: list });
  for (const [id, name, count] of [['1', 'Alpha', 1005], ['2', 'Beta', 2], ['3', 'Gamma', 1]] as const) {
    fire(f.within(f.group(id), '[data-qr="delete-cat"]'), 'click');
    assert.equal(f.must('[data-qr="confirm"]').querySelector('span')?.textContent, t('qrManage.confirm.group', { name, count }), name);
    f.must('[data-qr="confirm-cancel"]').dispatch('click');
  }
  assert.deepEqual(f.edits(), []);
});

test('a write settled without a list hides the pre-write list until a re-read lands; a failed re-read says the result is unconfirmed', async () => {
  const f = await fixture();
  const read = deferred<unknown>();
  f.io.read = () => read.promise;
  f.io.edit = () => ({ kind: 'unknown', reason: 'write_unknown' });
  f.must('[data-qr="add-script"]').dispatch('click');
  typeInto(f.must('[data-qr="content"]'), 'maybe sent');
  f.must('[data-qr="save"]').dispatch('click');
  await flush();
  assert.ok(f.q('[data-qr="loading"]'), 'the pre-write list is not shown again');
  assert.deepEqual(f.groups(), []); assert.deepEqual(f.scripts(), []);
  assert.equal(f.q('[data-qr="add-script"]'), null, 'nothing is editable until the re-read lands');
  assert.equal(f.q('[data-qr="create-cat"]'), null);
  assert.equal(f.notice(), t('qrManage.result.unknown'));

  read.reject(new Error('offline'));
  await flush();
  assert.equal(f.notice(), t('qrManage.result.unknownUnread'));
  assert.ok(f.q('[data-qr="reload"]'));
  assert.deepEqual(f.groups(), []);
  assert.equal(f.edits().length, 1, 'never resent');

  const landed = [cat('1', 'Alpha', [['11', 'one'], ['12', 'two'], ['13', 'three'], ['90', 'maybe sent']]), LIST[1]!, LIST[2]!];
  f.io.read = null; f.io.list = landed;
  f.must('[data-qr="reload"]').dispatch('click');
  await flush();
  assert.deepEqual(f.scripts(), ['11', '12', '13', '90']);
  assert.equal(f.notice(), t('qrManage.result.unknown'), 'still to be checked, now against the server list');
  assert.equal(f.edits().length, 1);
});

test('an applied write without a read-back re-reads before anything is editable and selects the created group', async () => {
  const f = await fixture();
  const read = deferred<unknown>();
  f.io.edit = () => ({ kind: 'applied' });
  f.io.read = () => read.promise;
  f.must('[data-qr="create-cat"]').dispatch('click');
  typeInto(f.must('[data-qr="name"]'), 'Delta');
  f.must('[data-qr="save"]').dispatch('click');
  await flush();
  assert.ok(f.q('[data-qr="loading"]'));
  assert.equal(f.q('[data-qr="create-cat"]'), null);
  assert.equal(f.notice(), null);
  read.resolve({ categories: [...LIST, cat('4', 'Delta', [])] });
  await flush();
  assert.deepEqual(f.groups(), ['1', '2', '3', '4']);
  assert.equal(f.within(f.group('4'), '[data-qr="select-cat"]').getAttribute('aria-current'), 'true');
  assert.equal(f.notice(), null);
  assert.deepEqual(f.edits(), [{ op: 'create_category', name: 'Delta', skill_group_ids: [] }]);
});

test('an open group-delete confirm shows the count of the list on screen, and closes when the group is gone', async () => {
  const f = await fixture();
  fire(f.within(f.group('1'), '[data-qr="delete-cat"]'), 'click');
  const text = () => f.must('[data-qr="confirm"]').querySelector('span')?.textContent;
  assert.equal(text(), t('qrManage.confirm.group', { name: 'Alpha', count: 3 }));
  f.io.list = [cat('1', 'Alpha', [['11', 'one'], ['12', 'two'], ['13', 'three'], ['14', 'added elsewhere']]), LIST[1]!, LIST[2]!];
  await f.manager.refresh();
  assert.equal(text(), t('qrManage.confirm.group', { name: 'Alpha', count: 4 }));
  f.io.list = [LIST[1]!, LIST[2]!];
  await f.manager.refresh();
  assert.equal(f.q('[data-qr="confirm"]'), null);
  assert.deepEqual(f.edits(), []);
});

test('a group with rows the list leaves out cannot be drag-sorted, and says so', async () => {
  const f = await fixture({ categories: [{ ...cat('1', 'Alpha', [['11', 'one'], ['12', 'two']]), script_total: 5 }, { ...cat('2', 'Beta', [['21', 'four'], ['22', 'five']]), script_total: 2 }] });
  assert.equal(f.must('[data-qr="sort-unavailable"]').textContent, t('qrManage.sortUnavailable'));
  assert.equal(f.script('11').getAttribute('draggable'), null);
  fire(f.script('11'), 'dragstart');
  assert.equal(fire(f.script('12'), 'dragover').defaultPrevented, false);
  fire(f.script('12'), 'drop');
  assert.deepEqual(f.edits(), []);
  assert.deepEqual(f.scripts(), ['11', '12']);

  fire(f.within(f.group('2'), '[data-qr="select-cat"]'), 'click');
  assert.equal(f.q('[data-qr="sort-unavailable"]'), null, 'every row listed: sorting works');
  drag(f.script('22'), f.script('21'));
  await flush();
  assert.deepEqual(f.edits(), [{ op: 'sort_scripts', category_id: '2', script_ids: ['22', '21'] }]);
});

test('busy() and onBusyChange follow a write out and back; a binding change ends it and a late result stays quiet', async () => {
  const f = await fixture();
  const first = deferred<unknown>();
  f.io.edit = () => first.promise;
  assert.equal(f.manager.busy(), false); assert.deepEqual(f.busyLog, []);
  drag(f.script('11'), f.script('13'));
  await flush();
  assert.equal(f.manager.busy(), true); assert.deepEqual(f.busyLog, [true]);
  first.resolve({ kind: 'applied', categories: LIST });
  await flush();
  assert.equal(f.manager.busy(), false); assert.deepEqual(f.busyLog, [true, false]);

  const second = deferred<unknown>();
  f.io.edit = () => second.promise;
  drag(f.script('11'), f.script('13'));
  await flush();
  assert.deepEqual(f.busyLog, [true, false, true]);
  f.manager.setAccount({ ...ACCOUNT, session_generation: ACCOUNT.session_generation + 1 });
  assert.equal(f.manager.busy(), false); assert.deepEqual(f.busyLog, [true, false, true, false]);
  second.resolve({ kind: 'applied', categories: LIST });
  await flush();
  assert.deepEqual(f.busyLog, [true, false, true, false], 'a discarded write does not report again');
});
