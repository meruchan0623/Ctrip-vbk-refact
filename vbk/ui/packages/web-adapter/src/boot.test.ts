import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, hostArgs, isOfficialImPage, resolveHostBridge, type BootWindow } from './boot.ts';
import { OK_STATUS, sampleRow } from './testing.ts';

for (const useApi of [false, true]) {
  test(`host bridge: status commands only reach their account (global API=${useApi})`, async () => {
    type Target = { kind: string; label?: string };
    const listeners: { target: Target; callback: (ev: { payload: unknown }) => void }[] = [];
    const received: unknown[][] = [[], []];
    for (const [i, label] of ['account-a', 'account-b'].entries()) {
      let callback: (ev: { payload: unknown }) => void = () => {};
      const bridge = resolveHostBridge({
        __TAURI_INTERNALS__: {
          metadata: { currentWebview: { label } },
          transformCallback: (cb: typeof callback) => { callback = cb; return 1; },
          invoke: async (cmd: string, args: { target: Target }) => {
            if (cmd === 'plugin:event|listen') listeners.push({ target: args.target, callback });
            return 1;
          },
        },
        ...(useApi ? { __TAURI__: { event: { listen: async (_event: string, cb: typeof callback, options?: { target: Target }) => {
          listeners.push({ target: options?.target ?? { kind: 'Any' }, callback: cb });
          return () => {};
        } } } } : {}),
      });
      assert.ok(bridge);
      await bridge.listen('adapter://request', payload => received[i]!.push(payload));
    }
    // Tauri's match_any_or_filter delivers targeted emits to Any listeners too.
    const emitTo = (label: string, payload: unknown) => {
      for (const listener of listeners) {
        if (listener.target.kind === 'Any' || listener.target.label === label) listener.callback({ payload });
      }
    };
    const a = { req_id: 'a', op: 'agent.set_status', args: { status: 'hangup' } };
    const b = { req_id: 'b', op: 'agent.set_status', args: { status: 'getoff' } };
    emitTo('account-a', a);
    assert.deepEqual(received, [[a], []]);
    emitTo('account-b', b);
    assert.deepEqual(received, [[a], [b]]);
  });
}

test('host bridge: missing webview identity refuses global listening', async () => {
  for (const label of [undefined, '', 7]) {
    let calls = 0;
    const bridge = resolveHostBridge({ __TAURI_INTERNALS__: {
      metadata: { currentWebview: { label } },
      invoke: async () => { calls++; }, transformCallback: () => { calls++; return 1; },
    } });
    assert.ok(bridge);
    await assert.rejects(bridge.listen('adapter://request', () => {}), /current webview label unavailable/);
    assert.equal(calls, 0);
  }
});

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
      metadata: { currentWebview: { label: 'account-a' } },
      invoke: (cmd: string, args: unknown) => (seen.push([cmd, args]), Promise.resolve(42)),
      transformCallback: (cb: (ev: unknown) => void) => ((handler = cb), 7),
    },
  });
  assert.ok(b);
  const got: unknown[] = [];
  const unlisten = await b.listen('adapter://request', (p) => got.push(p));
  assert.deepEqual(seen[0], ['plugin:event|listen', { event: 'adapter://request', target: { kind: 'Webview', label: 'account-a' }, handler: 7 }]);
  (handler as unknown as (ev: unknown) => void)({ event: 'adapter://request', id: 1, payload: { req_id: 'x' } });
  assert.deepEqual(got, [{ req_id: 'x' }]);
  unlisten();
  assert.deepEqual(seen[1], ['plugin:event|unlisten', { event: 'adapter://request', eventId: 42 }]);
  const api = resolveHostBridge({ __TAURI_INTERNALS__: { metadata: { currentWebview: { label: 'account-a' } } }, __TAURI__: { core: { invoke: () => Promise.resolve('ok') }, event: { listen: (_e: string, h: (ev: { payload: unknown }) => void) => (h({ payload: 'p' }), Promise.resolve(() => undefined)) } } });
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
      metadata: { currentWebview: { label: 'account-a' } },
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
  assert.deepEqual(identity?.args, { payload: { buid: 'B-1', uid: 'me-1', agent_id: '77', nick: '昵称', party: '供应商', environment: 'production', self_profile: { uid: 'me-1', name: 'n', avatar: 'https://example.invalid/agent-self.png' } } });
  const ready = invoked.find((i) => i.cmd === 'adapter_ready');
  assert.deepEqual(ready?.args, { payload: { url: 'https://vbooking.ctrip.com/vbk/im/main', sdk_version: null } });
  assert.ok(fetchCalls.some((u) => u.includes('_fxpcqlniredt=T-1') && u.includes('getConversationList')));
  // I-06: the adapter's own requests are counted as `adapter` traffic for the bound account; the page's own call was not counted
  assert.ok(r.traffic.rows().some((row) => row.path === 'conversation_list' && row.initiator === 'adapter' && row.account === 'acc-1'));
  assert.equal(r.traffic.rows().some((row) => row.initiator === 'official'), false, 'getVenAgentByUid is outside the pacing contract');
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

for (const useApi of [false, true]) {
  for (const navigateDuringListen of [false, true]) {
    test(`host bridge cleanup keeps original document (api=${useApi}, duringListen=${navigateDuringListen})`, async () => {
      const calls: string[] = [];
      let complete: (value: unknown) => void = () => {};
      const pending = new Promise<unknown>(resolve => { complete = resolve; });
      const oldInternals = {
        metadata: { currentWebview: { label: 'old' } },
        transformCallback: () => 7,
        invoke: async (command: string) => {
          calls.push(`old:${command}`);
          return command === 'plugin:event|listen' ? pending : null;
        },
      };
      const oldPage: Record<string, unknown> = {
        __TAURI_INTERNALS__: oldInternals,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => calls.push('old:local-unregister') },
        ...(useApi ? { __TAURI__: { event: { listen: async () => {
          await pending;
          return () => calls.push('api:dynamic-cleanup');
        } } } } : {}),
      };
      let current = oldPage;
      const proxy = new Proxy({}, { get: (_target, key) => current[String(key)] });
      const bridge = resolveHostBridge(proxy);
      assert.ok(bridge);
      const listening = bridge.listen('adapter://request', () => {});
      const nextPage = {
        __TAURI_INTERNALS__: { ...oldInternals, metadata: { currentWebview: { label: 'new' } } },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => calls.push('new:local-unregister') },
      };
      if (navigateDuringListen) current = nextPage;
      complete(7);
      const cleanup = await listening;
      if (!navigateDuringListen) current = nextPage;
      calls.length = 0;
      cleanup();
      await Promise.resolve();
      assert.deepEqual(calls, []);
    });
  }
}

test('host bridge captures local unregister function before awaiting registration', async () => {
  const seen: string[] = [];
  const page = {
    __TAURI_INTERNALS__: {
      metadata: { currentWebview: { label: 'same' } },
      transformCallback: () => 7,
      invoke: async () => 7,
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => { seen.push('original'); } },
  };
  const bridge = resolveHostBridge(page);
  assert.ok(bridge);
  const listening = bridge.listen('adapter://request', () => {});
  page.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => { seen.push('replacement'); } };
  const cleanup = await listening;
  cleanup();
  assert.deepEqual(seen, ['original']);
});

test('host bridge handles synchronous and asynchronous global cleanup failures', async () => {
  for (const asynchronous of [false, true]) {
    let calls = 0;
    const cleanup = () => {
      calls++;
      if (asynchronous) return Promise.reject(new Error('host closed'));
      throw new Error('host closed');
    };
    const bridge = resolveHostBridge({
      __TAURI_INTERNALS__: { metadata: { currentWebview: { label: 'main' } } },
      __TAURI__: {
        core: { invoke: async () => null },
        event: { listen: async () => cleanup },
      },
    });
    assert.ok(bridge);
    const dispose = await bridge.listen('adapter://request', () => {});
    assert.doesNotThrow(dispose);
    // Let rejected cleanup promises settle; an unhandled rejection fails the test.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
  }
});
