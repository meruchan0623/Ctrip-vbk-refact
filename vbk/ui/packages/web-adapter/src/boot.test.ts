import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, hostArgs, isOfficialImPage, resolveHostBridge, type BootWindow } from './boot.ts';
import { OK_STATUS, sampleRow } from './testing.ts';

const IM = { protocol: 'https:', hostname: 'vbooking.ctrip.com', port: '', pathname: '/vbk/im/main' };

test('boot guard: only the official vbooking IM page (exact origin/path)', () => {
  assert.equal(isOfficialImPage(IM), true);
  assert.equal(isOfficialImPage({ ...IM, pathname: '/vbk/im/main/' }), true);
  for (const bad of [
    { ...IM, pathname: '/ivbk/accountV2/login' },
    { ...IM, pathname: '/vbk/im/main2' },
    { ...IM, pathname: '/vbk/im' },
    { ...IM, protocol: 'http:' },
    { ...IM, hostname: 'vbooking.ctrip.com.evil.com' },
    { ...IM, hostname: 'imvendor.ctrip.com', pathname: '/main' },
    { ...IM, port: '8443' },
    { protocol: 'about:', hostname: '', port: '', pathname: 'blank' },
  ]) {
    assert.equal(isOfficialImPage(bad), false, JSON.stringify(bad));
  }
  assert.equal(isOfficialImPage(null), false);
});

test('boot guard: the login page is left untouched (no hooks, no host calls, no globals)', async () => {
  const calls: string[] = [];
  const fetch = () => Promise.reject(new Error('no'));
  const win: BootWindow = {
    location: { protocol: 'https:', hostname: 'vbooking.ctrip.com', port: '', pathname: '/ivbk/accountV2/login', href: 'https://vbooking.ctrip.com/ivbk/accountV2/login', search: '' },
    fetch,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    __TAURI_INTERNALS__: { invoke: (cmd: string) => (calls.push(cmd), Promise.resolve(null)), transformCallback: () => 1 },
  };
  const before = Object.keys(win).sort();
  assert.deepEqual(await boot(win), { kind: 'skipped', reason: 'not_im_page' });
  assert.equal(win.fetch, fetch);
  assert.deepEqual(Object.keys(win).sort(), before);
  assert.deepEqual(calls, []);
});

test('host bridge: __TAURI__ api, internals-only fallback, none', async () => {
  assert.equal(resolveHostBridge({}), null);
  assert.equal(resolveHostBridge({ __TAURI_INTERNALS__: { invoke: () => Promise.resolve(1) } }), null, 'invoke without any listen path is not enough');
  const seen: unknown[] = [];
  let handler: ((ev: unknown) => void) | null = null;
  const b = resolveHostBridge({
    __TAURI_INTERNALS__: {
      invoke: (cmd: string, args: unknown) => (seen.push([cmd, args]), Promise.resolve(42)),
      transformCallback: (cb: (ev: unknown) => void) => ((handler = cb), 7),
    },
  });
  assert.ok(b);
  const got: unknown[] = [];
  const unlisten = await b.listen('adapter://request', (p) => got.push(p));
  assert.deepEqual(seen[0], ['plugin:event|listen', { event: 'adapter://request', target: { kind: 'Any' }, handler: 7 }]);
  (handler as unknown as (ev: unknown) => void)({ event: 'adapter://request', id: 1, payload: { req_id: 'x' } });
  assert.deepEqual(got, [{ req_id: 'x' }]);
  unlisten();
  assert.deepEqual(seen[1], ['plugin:event|unlisten', { event: 'adapter://request', eventId: 42 }]);
  const api = resolveHostBridge({ __TAURI__: { core: { invoke: () => Promise.resolve('ok') }, event: { listen: (_e: string, h: (ev: { payload: unknown }) => void) => (h({ payload: 'p' }), Promise.resolve(() => undefined)) } } });
  assert.ok(api);
  const got2: unknown[] = [];
  await api.listen('e', (p) => got2.push(p));
  assert.deepEqual(got2, ['p']);
  assert.deepEqual(hostArgs('adapter_push_fact', 1), { envelope: 1 });
  assert.deepEqual(hostArgs('adapter_ready', 1), { payload: 1 });
});

test('boot: IM page without any Tauri global logs one error and stops', async () => {
  const errors: string[] = [];
  const win: BootWindow = { location: { ...IM, href: 'https://vbooking.ctrip.com/vbk/im/main', search: '' }, fetch: () => Promise.reject(new Error('x')), setTimeout: () => 0, clearTimeout: () => undefined };
  const r = await boot(win, { logger: { info: () => undefined, error: (m) => errors.push(m) } });
  assert.deepEqual(r, { kind: 'no_host' });
  assert.equal(errors.length, 1);
});

function respond(body: unknown) {
  return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
}

test('boot: full sequence ready → identity → bind → SDK → session, and adapter://request is answered', async () => {
  const invoked: { cmd: string; args: unknown }[] = [];
  let identityPublished = false;
  let requestCb: ((ev: unknown) => void) | null = null;
  const pagehide: (() => void)[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const account = { account_id: 'acc-1', environment: 'production', session_generation: 3 };
  const xmpp = {
    status: 'online',
    listeners: new Map<string, ((...a: unknown[]) => void)[]>(),
    on(e: string, cb: (...a: unknown[]) => void) {
      this.listeners.set(e, [...(this.listeners.get(e) ?? []), cb]);
    },
    removeListener(e: string, cb: (...a: unknown[]) => void) {
      this.listeners.set(e, (this.listeners.get(e) ?? []).filter((x) => x !== cb));
    },
  };
  const fetchCalls: string[] = [];
  const win: BootWindow = {
    location: { ...IM, href: 'https://vbooking.ctrip.com/vbk/im/main?lang=zh-CN', search: '?lang=zh-CN' },
    document: { cookie: 'GUID=G-1' },
    fetch: (url: string) => {
      fetchCalls.push(url);
      if (url.includes('getCurrentUserInfo')) return respond({ ResponseStatus: OK_STATUS, user: { buid: 'B-1', name: '昵称', partyName: '供应商' } });
      if (url.includes('GetMyInfo.json')) return respond({ ResponseStatus: OK_STATUS, jid: 'me-1@im.x', name: 'IM Self', avatar: 'https://example.invalid/im-self.png' });
      if (url.includes('getVenAgentByUid')) return respond({ ResponseStatus: OK_STATUS, venAgent: { id: 77, ctripUid: 'me-1', nickname: 'n', avatar: 'https://example.invalid/agent-self.png' } });
      if (url.includes('getConversationList')) return respond({ ResponseStatus: OK_STATUS, conversationList: [sampleRow('555')], currentStatus: 0, lastUpdateTime: 1700000000600 });
      return respond({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' } });
    },
    setTimeout: (cb: () => void, ms: number) => {
      const h = setTimeout(() => {
        timers.delete(h);
        cb();
      }, Math.min(ms, 20));
      timers.add(h);
      return h;
    },
    clearTimeout: (h: unknown) => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
      timers.delete(h as ReturnType<typeof setTimeout>);
    },
    addEventListener: (type: string, cb: () => void) => {
      if (type === 'pagehide') pagehide.push(cb);
    },
    xmppClient: xmpp,
    __TAURI_INTERNALS__: {
      transformCallback: (cb: (ev: unknown) => void) => ((requestCb = cb), 1),
      invoke: (cmd: string, args: unknown) => {
        invoked.push({ cmd, args });
        if (cmd === 'plugin:event|listen') return Promise.resolve(9);
        if (cmd === 'adapter_ready') return Promise.resolve({ account: identityPublished ? account : null, begin_msg_time: 1700000000000, initial_epoch: 4 });
        if (cmd === 'adapter_identity') {
          identityPublished = true;
          return Promise.resolve(null);
        }
        return Promise.resolve(null);
      },
    },
  };
  const p = boot(win, { logger: { info: () => undefined, error: () => undefined }, bindDelayMs: 1, contextTimeoutMs: 1000 });
  // the official page issues its own SOA request: the sniffer picks cid/sid/clientId from it
  void (win.fetch as (u: string, i: unknown) => Promise<unknown>)('https://m.ctrip.com/restapi/soa2/16037/getVenAgentByUid?_fxpcqlniredt=T-1', { body: JSON.stringify({ head: { cid: 'C-1', sid: 'S-1' } }) });
  const r = await p;
  assert.equal(r.kind, 'started');
  if (r.kind !== 'started') throw new Error('session must start');
  assert.deepEqual(r.session.roles.profileOf('me-1'), { name: 'n', avatar: 'https://example.invalid/agent-self.png' });
  const identity = invoked.find((i) => i.cmd === 'adapter_identity');
  assert.deepEqual(identity?.args, { payload: { buid: 'B-1', uid: 'me-1', agent_id: '77', nick: '昵称', party: '供应商', environment: 'production' } });
  const ready = invoked.find((i) => i.cmd === 'adapter_ready');
  assert.deepEqual(ready?.args, { payload: { url: 'https://vbooking.ctrip.com/vbk/im/main', sdk_version: null } });
  assert.ok(fetchCalls.some((u) => u.includes('_fxpcqlniredt=T-1') && u.includes('getConversationList')));
  await new Promise((res) => setTimeout(res, 60));
  const facts = invoked.filter((i) => i.cmd === 'adapter_push_fact');
  assert.ok(facts.length > 0);
  const env = (facts[0]?.args as { envelope: { account: unknown; epoch: number } }).envelope;
  assert.deepEqual(env.account, account);
  assert.equal(env.epoch, 4);
  const displays = invoked.filter((i) => i.cmd === 'adapter_push_display').map((i) => (i.args as { payload: { kind: string } }).payload);
  assert.ok(displays.some((d) => d.kind === 'conversations'));
  assert.ok(displays.some((d) => d.kind === 'transport'));
  // host → page request
  assert.ok(requestCb);
  (requestCb as unknown as (ev: unknown) => void)({ payload: { req_id: 'q1', op: 'agent.status', args: {} } });
  await new Promise((res) => setTimeout(res, 30));
  const reply = invoked.find((i) => i.cmd === 'adapter_reply');
  assert.deepEqual(reply?.args, { payload: { req_id: 'q1', ok: true, data: { status: 'online', confirmed: true } } });
  // second injection on the same document is a no-op
  assert.deepEqual(await boot(win), { kind: 'skipped', reason: 'already_booted' });
  for (const cb of pagehide) cb();
  for (const h of timers) clearTimeout(h);
});
