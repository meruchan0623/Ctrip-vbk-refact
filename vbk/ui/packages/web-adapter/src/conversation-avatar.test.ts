import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
import { createPageSession } from './session.ts';
import { FakePageSdk, OK_STATUS, flush, jsonResponse, makeDeps, sampleRow } from './testing.ts';

const gid = '123456';
const customer = '90071992547409931';
const avatar = 'https://example.invalid/customer.png';
function fixture(options: { holdMembers?: boolean; holdHistory?: boolean } = {}) {
  let uid = customer;
  let releaseMembers!: (v: ReturnType<typeof jsonResponse>) => void;
  let releaseHistory!: (v: ReturnType<typeof jsonResponse>) => void;
  const base = makeDeps(call => {
    if (call.url.includes('getConversationList')) return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [sampleRow(gid, { uid })], haveRest: false });
    if (call.url.includes('checkMemberStatus')) {
      if (options.holdMembers) return new Promise(resolve => { releaseMembers = resolve; });
      return jsonResponse({ ResponseStatus: OK_STATUS, members: [{ uid: customer, nick: 'Customer', avatar, roles: [0, 1, 1] }] });
    }
    if (call.url.includes('getMessageList')) {
      if (options.holdHistory) return new Promise(resolve => { releaseHistory = resolve; });
      return jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [] } });
    }
    return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, remarkList: [], conversationInfoList: [] });
  });
  const sdk = new FakePageSdk();
  const displays: AdapterDisplayPayload[] = [];
  const session = createPageSession({ ...base, sdk }, { account: { account_id: 'synthetic', environment: 'production', session_generation: 1 }, selfUid: 'me', selfProfile: { uid: 'me', name: 'Self', avatar: 'https://example.invalid/self.png' }, beginMsgTime: 1700000000000, initialEpoch: 1, sdk, pushDisplay: async p => { displays.push(p); return null; } });
  const last = () => displays.flatMap(d => d.kind === 'conversations' ? d.items : []).at(-1);
  return { base, session, displays, last, changeCustomer: (value: string) => { uid = value; }, releaseMembers: () => releaseMembers(jsonResponse({ ResponseStatus: OK_STATUS, members: [{ uid: customer, nick: 'Customer', avatar, roles: [0, 1, 1] }] })), releaseHistory: () => releaseHistory(jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [] } })) };
}

test('conversation avatar: real list/member/history chain resolves only the row customer uid and preserves it on incremental polling', async () => {
  const f = fixture(); f.session.start();
  try {
    await f.base.clock.advance(50);
    assert.equal(f.last()?.customer_avatar, avatar);
    assert.equal((await f.session.rpc.handle({ req_id: 'h', op: 'im.messages', args: { gid } }))?.ok, true);
    assert.equal(f.last()?.customer_avatar, avatar);
    await f.base.clock.advance(5000);
    assert.equal(f.last()?.customer_avatar, avatar);
    f.changeCustomer('different-customer');
    await f.base.clock.advance(5000);
    assert.equal(f.last()?.customer_avatar, null, 'same gid must not inherit the previous customer avatar or the self avatar');
    f.session.roles.addMembers([{ uid: 'different-customer', avatar: 'https://example.invalid/next.png' }]);
    await f.session.rpc.handle({ req_id: 'next', op: 'im.messages', args: { gid } });
    assert.equal(f.last()?.customer_avatar, 'https://example.invalid/next.png');
  } finally { f.session.stop(); }
});

test('conversation avatar: delayed member enrichment cannot publish after stop', async () => {
  const f = fixture({ holdMembers: true }); f.session.start();
  await f.base.clock.advance(50);
  const before = f.displays.length;
  f.session.stop(); f.releaseMembers(); await flush();
  assert.equal(f.displays.length, before);
});

test('conversation avatar: delayed history cannot publish an old projection after stop/restart', async () => {
  const f = fixture({ holdHistory: true }); f.session.start();
  await f.base.clock.advance(50);
  const pending = f.session.rpc.handle({ req_id: 'old', op: 'im.messages', args: { gid } });
  await flush();
  f.session.stop(); f.changeCustomer('new-run-customer'); f.session.start();
  await f.base.clock.advance(50);
  const before = f.displays.length;
  f.releaseHistory();
  const reply = await pending;
  assert.equal(reply?.ok, false);
  assert.equal(f.displays.length, before);
  f.session.stop();
});
