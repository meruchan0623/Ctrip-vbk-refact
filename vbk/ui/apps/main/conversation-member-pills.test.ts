import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memberPills, memberScanGids } from './member-pills.ts';
import { createMemberPreload } from './member-preload.ts';
import { createPeripheralPanel } from './peripheralPanel.ts';
import { UiCommands, type UiConversation, type UiMembers } from '../../packages/ipc/src/client.ts';

const account = { account_id: 'a', environment: 'prod', session_generation: 1 } as never;
const row = (uid: string, role: string) => ({ uid, nickname: uid, status: '1', roles: [], can_transfer: false, role });
const members = (selfIsMaster?: boolean, uids = ['me', 'customer', 'agent']): UiMembers => ({
  members: uids.map(uid => row(uid, 'agent')),
  fetched_at_ms: 1,
  selection_token: 'token',
  expires_at_ms: 2,
  ...(selfIsMaster === undefined ? {} : { self_is_master: selfIsMaster }),
}) as unknown as UiMembers;
const conv = (gid: string, patch: Partial<UiConversation> = {}) => ({ gid, status: 'active', conversation_type: 'B2C', is_top: false, last_message_time_ms: 1, ...patch }) as unknown as UiConversation;

test('no pills until the member cache is ready, never a guessed zero', () => {
  assert.deepEqual(memberPills(false, null), { count: null, isMaster: false });
  assert.deepEqual(memberPills(false, members(true, [])), { count: null, isMaster: true });
});

test('a finished conversation shows neither pill even with a master cache', () => {
  assert.deepEqual(memberPills(true, members(true)), { count: null, isMaster: false });
});

test('only an explicit self_is_master true makes a master', () => {
  assert.equal(memberPills(false, members()).isMaster, false);
  assert.equal(memberPills(false, members(false)).isMaster, false);
  assert.equal(memberPills(false, members(true)).isMaster, true);
});

test('the pill count survives the preload cache and excludes members who left the group', () => {
  const preload = createMemberPreload({ invoke: async () => { throw new Error('offline'); }, now: () => 1, isVisible: () => false, schedule: () => () => {} });
  const scope = { account, gid: 'room' };
  preload.sync({ account, gids: ['room'], activeGid: 'room', paused: true });
  const base = members(false, ['me', 'customer', 'robot', 'left']);
  const data = { ...base, members: base.members.map(member => ({ ...member, present: member.uid !== 'left' })) } as UiMembers;
  preload.observeMembers(scope, data);
  assert.equal(memberPills(false, preload.getMembers(scope)).count, 3);
});

test('a list of only departed members shows no count rather than zero', () => {
  const base = members(false, ['left']);
  assert.equal(memberPills(false, { ...base, members: base.members.map(member => ({ ...member, present: false })) }).count, null);
});

test('a confirmed member write updates the pill cache together with the panel', async () => {
  let removed = false;
  let remembered: UiMembers | null = null;
  const removable = (uids: string[]) => { const value = members(true, uids); return { ...value, members: value.members.map(member => ({ ...member, can_remove: true })) }; };
  const panel = createPeripheralPanel({
    current: () => ({ account, gid: 'room' }),
    invoke: async (command: string) => {
      if (command === UiCommands.IM_MEMBERS) return removable(removed ? ['me', 'customer'] : ['me', 'customer', 'agent']);
      if (command === UiCommands.IM_REMOVE) { removed = true; return { kind: 'confirmed', confirmed: true }; }
      throw new Error(`unexpected ${command}`);
    },
    now: () => 1,
    publish: () => {},
    refreshConversation: async () => {},
    rememberMembers: (_scope: unknown, value: UiMembers) => { remembered = value; },
    schedule: () => () => {},
  } as never);
  await panel.open('members');
  assert.equal((remembered as UiMembers | null)?.members.length, 3);
  panel.select('agent');
  panel.confirmRemove();
  await panel.submit('remove');
  assert.equal(removed, true);
  assert.equal((remembered as UiMembers | null)?.members.length, 2);
  panel.close();
});

test('scan candidates are open customer conversations in list order', () => {
  const list = [
    conv('old', { last_message_time_ms: 1 }),
    conv('done', { status: 'finished', last_message_time_ms: 9 }),
    conv('moved', { status: 'transferred_out', last_message_time_ms: 8 }),
    conv('new', { last_message_time_ms: 5 }),
    conv('pinned', { is_top: true, last_message_time_ms: 0 }),
    conv('enterprise', { conversation_type: 'B2B', last_message_time_ms: 7 }),
  ];
  assert.deepEqual(memberScanGids(list, null), ['pinned', 'new', 'old']);
  assert.deepEqual(memberScanGids(list, 'enterprise'), ['pinned', 'new', 'old', 'enterprise']);
  assert.deepEqual(memberScanGids(list, 'done'), ['pinned', 'new', 'old']);
});

test('main window wiring: deps, placement, shared class, cache-driven repaint', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.match(source, /const deps = \[[^\n]*\bmaster\];/, 'list row deps must include the master state');
  assert.match(source, /h\('span', \{ class: cx\('ctime', \{ 'ctime-master': master \}\)/, 'a master row marks its time field');
  assert.doesNotMatch(source, /c\.title\), master \? masterPill\(\)/, 'the list no longer shows a separate master pill');
  assert.match(source, /peekMembers\(\{ account: acc\.context, gid: conv\.gid \}\)/);
  assert.match(source, /const master = memberPillsFor\(acc, c\)\.isMaster;/);
  assert.match(source, /conv\.title\), pills\.count !== null \? h\('span', \{ class: 'chip chip-members'[^\n]*pills\.isMaster \? masterPill\(\) : null, customerLanguage\(/);
  assert.equal(source.match(/chip-master/g)?.length, 1, 'both places must share one master pill');
  assert.match(source, /publish: \(\) => store\.patch\(\{ memberCacheRevision: S\(\)\.memberCacheRevision \+ 1 \}\)/);
  const trigger = source.slice(source.indexOf('function syncMemberPreload'), source.indexOf("document.addEventListener('visibilitychange', syncMemberPreload)"));
  assert.ok(!trigger.includes('memberCacheRevision'), 'a cache publish must not re-trigger sync');
  assert.match(trigger, /gids: memberScanGids\(s\.conversations, s\.activeGid\)/);
});

test('pill colours differ from each other and from the language and muted chips', () => {
  const css = readFileSync(new URL('../../packages/ui-kit/src/base.css', import.meta.url), 'utf8');
  const background = (name: string) => new RegExp(`\\.${name}\\b[^{]*\\{ background: (var\\(--[\\w-]+\\))`).exec(css)?.[1];
  const colours = ['chip-members', 'chip-master', 'chip-lang', 'chip-muted'].map(background);
  assert.ok(colours.every(Boolean));
  assert.equal(new Set(colours).size, 4);
  const list = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(list, new RegExp(`\\.ctime-master:not\\(:empty\\) \\{[^}]*background: var\\(--c-warn-soft\\)[^}]*color: var\\(--c-warn-text\\)`), 'list time pill uses the master colour');
});
