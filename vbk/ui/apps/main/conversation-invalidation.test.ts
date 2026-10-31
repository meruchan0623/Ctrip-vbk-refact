import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createStore } from '../../packages/ui-kit/src/store.ts';
import { Events } from '../../packages/ipc/src/commands.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import type { UiConversation, UiAttachment } from '../../packages/ipc/src/client.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import { isUiConversation, isUiAgentStatus, isUiNetStatus } from '../_shared/guards.ts';
import { sameAccount } from './viewmodel.ts';
import { isRegisteredMediaAttachment } from './sendComposer.ts';
import { toDisplayConversation } from '../../packages/web-adapter/src/display.ts';
import { createPageSession } from '../../packages/web-adapter/src/session.ts';
import { FakePageSdk, OK_STATUS, jsonResponse, makeDeps, sampleRow } from '../../packages/web-adapter/src/testing.ts';

const source = readFileSync(process.env['VBK_INVALIDATION_MAIN_SOURCE'] ?? new URL('./main.ts', import.meta.url), 'utf8');
const EVENT = 'im://conversations-invalidated';
const owner: AccountContext = { account_id: 'synthetic-invalidation', environment: 'synthetic', session_generation: 1 };
function row(gid: string): UiConversation { return { ...toDisplayConversation(sampleRow(gid), false)!, account: owner, draft: '', is_top: false, waiting_since_ms: null, waiting_confirmed: false }; }
function deferred() { let resolve!: (value: unknown) => void; return { promise: new Promise(r => { resolve = r; }), resolve }; }
function fixture(initial: UiConversation[] = [row('100001'), row('100002')]) {
  let account = owner, cache = initial;
  let nextRead: unknown = null;
  const calls: { command: string; payload: any }[] = [], pending: Promise<unknown>[] = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  const store = createStore<Record<string, any>>({ conversations: initial, activeGid: null, attachment: null, noticeCat: null, noticeCats: [], agent: null, net: null, view: 'messages' });
  const env: Record<string, any> = { store, S: () => store.get(), activeAccount: () => ({ context: account }), sameAccount, stillActive: (candidate: AccountContext) => sameAccount(account, candidate) && account.session_generation === candidate.session_generation,
    Events, UiCommands, isUiConversation, isUiAgentStatus, isUiNetStatus, isRegisteredMediaAttachment, document: { visibilityState: 'hidden' }, loadNotices: async () => undefined,
    invokeQuiet: async (command: string, payload: unknown) => { calls.push({ command, payload }); return command === UiCommands.IM_CONVERSATIONS ? await (nextRead ?? cache) : command === UiCommands.NOTICE_CATEGORIES ? [] : null; },
    ipc: { listen: (event: string, callback: (payload: unknown) => void) => listeners.set(event, callback) } };
  function actual(name: string, endMarker: string) { const a = source.search(new RegExp('(?:async )?function ' + name + '\\(')), b = source.indexOf('\n' + endMarker, a); assert.ok(a >= 0 && b > a, name); return new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn ' + name)(...Object.values(env)); }
  env['releaseAttachment'] = actual('releaseAttachment', 'async function attach(');
  const a = source.indexOf('let accountLoadTicket'), b = source.indexOf('\nasync function loadNotices(', a);
  const load = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn loadForActiveAccount;')(...Object.values(env));
  env['loadForActiveAccount'] = () => { const task = load(); pending.push(task); return task; };
  env['upsertConversation'] = actual('upsertConversation', 'async function sendText(');
  if (source.includes('function receiveConversationInvalidation(')) {
    env['receiveConversationInvalidation'] = actual('receiveConversationInvalidation', 'function receiveMainMessage(');
    const registration = source.split('\n').find(line => line.startsWith('ipc.listen') && line.includes('Events.IM_CONVERSATIONS_INVALIDATED'));
    assert.ok(registration); new Function(...Object.keys(env), stripTypeScriptTypes(registration))(...Object.values(env));
  }
  return { store, calls, pending, setOwner: (next: AccountContext) => { account = next; }, setCache: (next: UiConversation[]) => { cache = next; }, setRead: (next: unknown) => { nextRead = next; }, send: (payload: unknown) => listeners.get(EVENT)?.(payload), flush: () => Promise.all(pending), upsert: env['upsertConversation'] as (c: UiConversation) => void };
}

test('actual full removal payload refreshes main from the current cache and an empty full snapshot clears all rows', async () => {
  const f = fixture(); let phase = 0;
  // Exercise the real adapter producer. Cache application/emission is a host
  // seam fixture, not execution of the Rust/Tauri dispatcher.
  const deps = makeDeps(call => call.url.includes('getConversationList') ? jsonResponse({ ResponseStatus: OK_STATUS, conversationList: phase === 0 ? [sampleRow('100001'), sampleRow('100002', { status: 4 })] : [sampleRow('100001', { groupTitle: 'SYNTHETIC UPDATED' })], lastUpdateTime: 1700000000600 + phase * 1000, haveRest: false }) : call.url.includes('getRecentMessages') ? jsonResponse({ ResponseStatus: OK_STATUS, messages: [], lastMessageTimestamp: 1700000000000 }) : jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, members: [], remarkList: [], conversationInfoList: [] }));
  const cache = new Map<string, UiConversation>(); let removed = 0;
  const sdk = new FakePageSdk();
  const session = createPageSession({ ...deps, sdk }, { account: owner, selfUid: 'me', beginMsgTime: 1700000000000, initialEpoch: 1, sdk, pushDisplay: async payload => {
    if (payload.kind !== 'conversations') return null;
    for (const gid of payload.removed_gids) cache.delete(gid);
    for (const display of payload.items) { const c = { ...display, account: owner, draft: '', is_top: false, waiting_since_ms: null, waiting_confirmed: false }; cache.set(c.gid, c); f.upsert(c); }
    f.setCache([...cache.values()]);
    if (payload.removed_gids.length) { removed += payload.removed_gids.length; f.send(owner); }
    return null;
  } });
  session.start(); await deps.clock.advance(50); session.stop(); phase = 1; session.start();
  try { await deps.clock.advance(50); await f.flush(); assert.equal(removed, 1); assert.deepEqual(f.store.get().conversations.map((c: UiConversation) => c.gid), ['100001']); assert.equal(f.store.get().conversations[0].title, 'SYNTHETIC UPDATED'); }
  finally { session.stop(); }
  f.setCache([]); f.send(owner); await f.flush(); assert.deepEqual(f.store.get().conversations, []);
  assert.equal((Events as Record<string, string>)['IM_CONVERSATIONS_INVALIDATED'], EVENT);
});

test('actual invalidation readback removing the selected room releases its exact attachment without opening or reading', async () => {
  const f = fixture(); const attachment: UiAttachment = { attachment_id: 'synthetic-local', name: 'SYNTHETIC.png', kind: 'image', mime: 'image/png', size: 1, content_sha256: 'a'.repeat(64), supported: true, owner: { account: owner, gid: '100002' } };
  f.store.patch({ activeGid: '100002', attachment }); f.setCache([]); f.send(owner); await f.flush();
  assert.equal(f.store.get().activeGid, null); assert.equal(f.store.get().attachment, null);
  assert.deepEqual(f.store.get().conversations, []);
  assert.deepEqual(f.calls.find(c => c.command === UiCommands.MEDIA_RELEASE)?.payload, { account: owner, gid: '100002', attachment_id: attachment.attachment_id });
  assert.ok(f.calls.every(c => [UiCommands.IM_CONVERSATIONS, UiCommands.ACCOUNT_AGENT_STATUS, UiCommands.NET_STATUS, UiCommands.NOTICE_CATEGORIES, UiCommands.MEDIA_RELEASE].includes(c.command as never)));
});

test('background, old generation/environment and malformed invalidations perform no IPC', async () => {
  const f = fixture();
  for (const payload of [null, [], 1, {}, { ...owner, account_id: 'background' }, { ...owner, environment: 'other' }, { ...owner, session_generation: 0 }, { ...owner, session_generation: '1' }, { ...owner, session_generation: 1.5 }, { ...owner, session_generation: Number.NaN }]) f.send(payload);
  await f.flush(); assert.deepEqual(f.calls, []);
});

test('late same-scope invalidation reads new cache and superseded reads cannot delete a new gid', async () => {
  const f = fixture(), old = deferred(); f.setRead(old.promise); f.send(owner);
  const fresh = row('100003'); f.setRead(null); f.setCache([fresh]); f.send(owner); await f.pending[1];
  old.resolve([]); await f.flush(); assert.deepEqual(f.store.get().conversations, [fresh]);
  f.send(owner); await f.flush(); assert.deepEqual(f.store.get().conversations, [fresh]);
  f.setOwner({ ...owner, session_generation: 2 }); const before = f.calls.length; f.send(owner); await f.flush(); assert.equal(f.calls.length, before);
});
