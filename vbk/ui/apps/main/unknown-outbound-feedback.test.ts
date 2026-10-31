import { test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { createUnknownOutbound, type UnknownOutboundView } from './unknown-outbound.ts';
import { createPageSession } from '../../packages/web-adapter/src/session.ts';
import { FakePageSdk, OK_STATUS, jsonResponse, makeDeps, sampleRow, flush } from '../../packages/web-adapter/src/testing.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';

test('actual unknown controller, PageSession and main conversation projection produce zero implicit read receipts', async () => {
const gid = '123456', account = { account_id: 'synthetic', environment: 'production', session_generation: 1 };
const source = fs.readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
let session: ReturnType<typeof createPageSession>; let forward = false; let view: UnknownOutboundView | null = null;
const reads: string[] = [], state = { activeGid: gid, view: 'messages', conversations: [] };
const a = source.indexOf('function upsertConversation('), b = source.indexOf('\nasync function sendText(', a);
const upsert = new Function('S', 'store', 'document', 'invokeQuiet', 'UiCommands', stripTypeScriptTypes(source.slice(a, b)) + ';return upsertConversation;')(
  () => state, { patch: (p: object) => Object.assign(state, p) }, { visibilityState: 'visible' },
  (cmd: string, p: { gid: string }) => { reads.push(cmd); return session.rpc.handle({ req_id: 'implicit-read', op: 'im.mark_read', args: { gid: p.gid } }); }, UiCommands);
const base = makeDeps(c => jsonResponse(c.url.includes('getConversationList')
  ? { ResponseStatus: OK_STATUS, conversationList: [sampleRow(gid)], haveRest: false }
  : c.url.includes('getMessageList')
    ? { ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [{ msgId: 'server', localId: 'local', fromJid: gid + '@muc.synthetic/me', toJid: 'me@synthetic', createTime: 1700000000100, msgtype: 0, messageBody: 'synthetic' }] } }
    : { ResponseStatus: OK_STATUS, members: [] }));
const sdk = new FakePageSdk();
session = createPageSession({ ...base, sdk }, { sdk, account, selfUid: 'me', initialEpoch: 1, beginMsgTime: 1700000000000,
  pushDisplay: async p => { if (forward && p.kind === 'conversations') for (const item of p.items) upsert({ ...item, account }); } });
session.start(); await base.clock.advance(50); session.unread.set(gid, 3); forward = true;
const panel = createUnknownOutbound({ current: () => account, publish: v => { view = v; }, invoke: async (cmd, p) => {
  if (cmd === UiCommands.IM_UNKNOWN_OUTBOUND) return [{ ...account, local_id: 'local', gid, creation_generation: 1, created_at_ms: 1700000000000, write_started: true, phase: 'unknown' }];
  const op = cmd === 'im_message_page' ? 'im.message_page' : cmd === 'im_outbound_lookup' ? 'im.outbound_lookup' : null;
  assert.ok(op, 'only the real registered read operation may be invoked');
  const reply = await session.rpc.handle({ req_id: 'verify-page', op, args: { gid: p.gid, local_id: undefined } });
  assert.ok(reply?.ok, 'the production RPC must handle the selected read');
  return reply.data;
} });
await panel.open(); panel.select(gid, 'local'); await panel.verify(); await flush(); session.stop();

assert.equal((view as UnknownOutboundView | null)?.result?.kind, 'found', 'the actual lookup must retain its positive result');
assert.equal(reads.length, 0, 'read-only verification must not indirectly mark the active thread read');
assert.equal(sdk.readReceipts.length, 0);

});
