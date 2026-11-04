import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
function fn(path: string, name: string) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0);
  return stripTypeScriptTypes(source.slice(start, source.indexOf('\n}', start) + 2));
}
const queue: (unknown[] | Promise<unknown[]>)[] = [];
function mainHarness() {
  let state: any = { navigationOperation: {}, activeGid: null, view: 'messages' };
  const opened: string[] = [];
  const ipc = { invoke: async () => queue.shift() ?? [] };
  const api = new Function('S', 'ipc', 'UiCommands', 'isLocatePayload', 'stillActive', 'locateConversation',
    `let takingDeepLink = false; let deepLinkIntent = S(); let deepLinkSerial=0;\n${fn('./main.ts', 'takeDeepLinks')}\nreturn {take:takeDeepLinks,receive(){deepLinkSerial++;deepLinkIntent=S();}};`)(
    () => state, ipc, { DEEP_LINK_TAKE: 'take' }, (x: any) => !!x.account && typeof x.gid === 'string', () => true,
    async (_: unknown, gid: string) => { opened.push(gid); state = { ...state, activeGid: 'manual-after-await', navigationOperation: {} }; });
  return { api, opened, navigate: () => { state = { ...state, activeGid: 'manual', navigationOperation: {} }; } };
}
test('native queue applies only newest conversation and does not replay old links after an await', async () => {
  const h = mainHarness(); queue.push([{ action: 'conversation', account: {}, gid: 'old' }, { action: 'conversation', account: {}, gid: 'new' }]);
  await h.api.take(); assert.deepEqual(h.opened, ['new']);
});
test('native conversation waiting for hydration cannot override manual navigation between polls', async () => {
  const h = mainHarness(); queue.push([]); await h.api.take(); h.navigate();
  queue.push([{ action: 'conversation', account: {}, gid: 'late-hydration' }]); await h.api.take(); assert.deepEqual(h.opened, []);
  h.api.receive(); queue.push([{ action: 'conversation', account: {}, gid: 'new-native-intent' }]); await h.api.take(); assert.deepEqual(h.opened, ['new-native-intent']);
});
test('settings native intent rejects manual ABA across polls, then accepts a newly received link', async () => {
  let section = 'notify', answer: unknown = null;
  const api = new Function('store', 'ipc', 'UiCommands', 'isSectionId', 'selectSection',
    `let settingsNavigationVersion=0; let takingDeepLinkSection=false; let deepLinkSectionIntent=0; let deepLinkSectionSerial=0;\n${fn('../setting/main.ts', 'takeDeepLinkSection')}\nreturn {take:takeDeepLinkSection,navigate(){settingsNavigationVersion++;},receive(){deepLinkSectionSerial++;deepLinkSectionIntent=settingsNavigationVersion;}};`)(
    { patch: (v: any) => { section = v.section; } }, { invoke: async () => answer }, { DEEP_LINK_SETTING_TAKE: 'take' }, (x: string) => ['notify', 'keys', 'general'].includes(x), (id: string) => { section = id; });
  await api.take(); api.navigate(); section = 'general'; api.navigate(); section = 'notify'; answer = 'keys';
  await api.take(); assert.equal(section, 'notify'); api.receive(); await api.take(); assert.equal(section, 'keys');
});

test('a newer native event during an IPC read supersedes the old result and is drained next', async () => {
  const h = mainHarness(); let finish!: (rows: unknown[]) => void;
  queue.push(new Promise<unknown[]>(resolve => { finish = resolve; }));
  const old = h.api.take(); h.api.receive();
  queue.push([{ action: 'conversation', account: {}, gid: 'NEW' }]);
  finish([{ action: 'conversation', account: {}, gid: 'OLD' }]);
  await old; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.opened, ['NEW']);
});
