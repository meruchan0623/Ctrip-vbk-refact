import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoleBook } from './stores.ts';
import { httpMessageToUi, sdkMessageToUi } from './display.ts';
import { createPageSession } from './session.ts';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
import { FakePageSdk, makeDeps, jsonResponse, OK_STATUS, flush, sampleRow } from './testing.ts';

test('SDK and HTTP message projections use each sender UID, never their equal nickname', () => {
  const roles = new RoleBook('self');
  const ids = ['self', 'colleague', 'customer', 'platform-agent', 'robot'];
  roles.addMembers(ids.map(uid => ({ uid, nick: 'Same Display Name', avatar: `https://example.invalid/${uid}.png` })));
  for (const uid of ids) {
    const sdk = sdkMessageToUi({ id: `sdk-${uid}`, type: 'groupchat', msgtype: '0', create_time: '1700000000100', from: `room@muc.example/${uid}`, to: 'self@im.example', body: 'synthetic' }, roles);
    const http = httpMessageToUi({ msgId: `http-${uid}`, fromJid: `${uid}@im.example`, toJid: 'room@muc.example', createTime: 1700000000100, msgtype: 0, messageBody: 'synthetic' }, roles, 'room');
    for (const item of [sdk, http]) {
      assert.equal(item?.sender_id, uid);
      assert.equal(item?.sender_name, 'Same Display Name');
      assert.equal(item?.sender_avatar, `https://example.invalid/${uid}.png`);
    }
  }
});

for (const lifecycle of ['current', 'stop', 'restart']) {
  test(`session publishes delayed member avatar only while its run is current (${lifecycle})`, async () => {
    let reply!: (value: ReturnType<typeof jsonResponse>) => void;
    const base = makeDeps(call => call.url.includes('checkMemberStatus')
      ? new Promise(resolve => { reply = resolve; })
      : jsonResponse({ ResponseStatus: OK_STATUS }));
    const sdk = new FakePageSdk();
    const displays: AdapterDisplayPayload[] = [];
    const session = createPageSession({ ...base, sdk }, { account: { account_id: 'synthetic', environment: 'production', session_generation: 1 }, selfUid: 'self', beginMsgTime: base.now(), initialEpoch: 1, sdk, pushDisplay: async item => { displays.push(item); } });
    session.start();
    session.store.update([{ gid: 'room', uid: 'customer' }]);
    sdk.emit('message', { id: 'synthetic-id', type: 'groupchat', msgtype: '0', create_time: '1700000000100', from: 'room@muc.example/customer', to: 'self@im.example', body: 'synthetic' });
    await flush();
    assert.equal(typeof reply, 'function');
    const before = displays.filter(x => x.kind === 'messages').length;
    if (lifecycle !== 'current') session.stop();
    if (lifecycle === 'restart') session.start();
    reply(jsonResponse({ ResponseStatus: OK_STATUS, members: [{ uid: 'customer', nick: 'Customer', avatar: 'https://example.invalid/customer.png' }] }));
    await flush();
    const messages = displays.filter(x => x.kind === 'messages');
    assert.equal(messages.length, before, 'enrichment never replays a full stale message');
    const profiles = displays.filter(x => x.kind === 'message_profiles');
    if (lifecycle !== 'current') assert.equal(profiles.length, 0, 'stopped run must not publish late profile');
    else assert.equal(profiles.at(-1)?.items[0]?.sender_avatar, 'https://example.invalid/customer.png');
    session.stop();
  });
}

test('a delayed self avatar after a confirmed RPC sends only a profile patch, never an old disposition', async () => {
  let reply!: (value: ReturnType<typeof jsonResponse>) => void;
  const base = makeDeps(call => call.url.includes('checkMemberStatus')
    ? new Promise(resolve => { reply = resolve; }) : jsonResponse({ ResponseStatus: OK_STATUS }));
  const sdk = new FakePageSdk();
  const displays: AdapterDisplayPayload[] = [];
  const session = createPageSession({ ...base, sdk }, { account: { account_id: 'synthetic', environment: 'production', session_generation: 1 }, selfUid: 'self', beginMsgTime: base.now(), initialEpoch: 1, sdk, pushDisplay: async item => { displays.push(item); } });
  session.start();
  session.store.update([sampleRow('123456')]);
  sdk.rememberPartnerJid('123456', '123456@muc.example');
  sdk.emit('message', { id: 'synthetic-server', localid: 'synthetic-local', type: 'groupchat', msgtype: '0', create_time: '1700000000100', from: '123456@muc.example/self', to: 'self@im.example', body: 'SYNTHETIC' });
  await flush();
  const request = session.rpc.handle({ req_id: 'synthetic-request', op: 'im.send_text', args: { gid: '123456', local_id: 'synthetic-local', text: 'SYNTHETIC', original: 'ORIGINAL', quote_id: 'synthetic-quote' } });
  await flush();
  assert.equal(sdk.sent.length, 1);
  sdk.emit('send_result', { error: 0, localid: 'synthetic-local', tid: 'synthetic-server', create_time: '1700000000100' });
  const response = await request;
  assert.equal(response?.ok, true);
  const confirmed = displays.filter(x => x.kind === 'messages').at(-1)?.items[0];
  assert.equal(confirmed?.disposition?.kind, 'confirmed');
  assert.equal(confirmed?.original, 'ORIGINAL');
  assert.equal(confirmed?.quote, 'synthetic-quote');
  const before = displays.filter(x => x.kind === 'messages').length;
  reply(jsonResponse({ ResponseStatus: OK_STATUS, members: [{ uid: 'self', nick: 'Self', avatar: 'https://example.invalid/self.png' }] }));
  await flush();
  assert.equal(displays.filter(x => x.kind === 'messages').length, before);
  const patch = displays.filter(x => x.kind === 'message_profiles').at(-1)?.items[0];
  assert.deepEqual(patch, { message_id: 'synthetic-server', local_id: 'synthetic-local', sender_id: 'self', sender_name: 'Self', sender_avatar: 'https://example.invalid/self.png' });
  assert.equal(sdk.sent.length, 1);
  session.stop();
});
