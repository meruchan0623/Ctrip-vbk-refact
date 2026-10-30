import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageSdk } from './sdkGlue.ts';
import { createMediaSendIntent, createSendIntent, submitIntent, type MediaRef } from './send.ts';
import { makeDeps, OK_STATUS, flush } from './testing.ts';

type Callback = (raw: unknown) => void;

test('SDK callback facade receives text schema and bare gid, and confirms through createPageSdk → submitIntent', async () => {
  const deps = makeDeps();
  let calls = 0;
  const sdk = createPageSdk({ IMClient: { sendMessageInSocket: (message: Record<string, unknown>, success: Callback, failure: Callback) => {
    calls++;
    assert.equal(message['messageType'], 0);
    assert.equal(message['content'], 'synthetic text');
    assert.equal(message['toJid'], '900719925474099312345');
    assert.equal(message['threadId'], '');
    assert.equal(message['citemsgid'], '900719925474099312346');
    assert.equal(typeof success, 'function'); assert.equal(typeof failure, 'function');
    success({ msgId: '9223372036854775806', msgCreateTime: 1700000000123, localId: message['localId'] });
  } } }, deps);
  sdk.rememberPartnerJid('900719925474099312345', '900719925474099312345@muc.example');
  const intent = createSendIntent(deps, '900719925474099312345', 'synthetic text', { serviceType: '1513', threadId: '' }, { citemsgid: '900719925474099312346' });
  const pending = submitIntent(deps, sdk, intent, 100);
  await deps.clock.advance(100);
  assert.deepEqual((await pending).disposition, { kind: 'confirmed', server_message_id: '9223372036854775806', server_time_ms: 1700000000123 });
  assert.equal(calls, 1); assert.equal(deps.fakeFetch.calls.length, 0);
  sdk.dispose();
});

test('SDK callback failure preserves explicit rejection, while missing/malformed ack stays unknown without retry', async () => {
  for (const response of [{ error: 7, errmsg: 'explicit rejection' }, { error: 7, localId: 'other' }, {}, { error: 0 }, { error: 0, msgId: 9007199254740992 }, { error: 'not-a-code' }]) {
    const deps = makeDeps(); let calls = 0;
    const sdk = createPageSdk({ IMClient: { sendMessageInSocket: (_message: unknown, _success: Callback, failure: Callback) => { calls++; failure(response); } } }, deps);
    sdk.rememberPartnerJid('g1', 'g1@muc.example');
    const intent = createSendIntent(deps, 'g1', 'synthetic', { serviceType: '1513', threadId: '' });
    const pending = submitIntent(deps, sdk, intent, 100);
    await deps.clock.advance(100);
    const disposition = (await pending).disposition;
    if (response.error === 7 && !('localId' in response)) assert.deepEqual(disposition, { kind: 'rejected', code: '7', reason: 'explicit rejection' });
    else assert.deepEqual(disposition, { kind: 'unknown' });
    assert.equal(calls, 1); sdk.dispose();
  }
});

test('SDK callback success validates exact IDs, explicit errors, and local correlation', async () => {
  for (const response of [{ msgId: '9223372036854775806' }, { msgId: 9007199254740992 }, { msgId: '' }, { msgId: 'valid', localId: 'other' }, { msgId: 'valid', error: 9 }, null]) {
    const deps = makeDeps();
    const sdk = createPageSdk({ IMClient: { sendMessageInSocket: (_message: unknown, success: Callback) => { success(response); } } }, deps);
    sdk.rememberPartnerJid('g1', 'g1@muc.example');
    const pending = submitIntent(deps, sdk, createSendIntent(deps, 'g1', 'synthetic', { serviceType: '1513', threadId: '' }), 100);
    await deps.clock.advance(100);
    const disposition = (await pending).disposition;
    if (response?.msgId === '9223372036854775806') assert.equal(disposition.kind, 'confirmed');
    else if (response?.error === 9) assert.equal(disposition.kind, 'rejected');
    else assert.deepEqual(disposition, { kind: 'unknown' });
    sdk.dispose();
  }
});

test('read-receipt callback must arrive with documented success; a void return never acknowledges', async () => {
  const deps = makeDeps(); let success!: Callback; let captured: Record<string, unknown> = {};
  const sdk = createPageSdk({ IMClient: { putAdviceOfReadByMsgId: (request: Record<string, unknown>, done: Callback) => {
    captured = request; success = done;
  } } }, { ...deps, readReceiptTimeoutMs: 100 });
  let settled = false;
  const pending = sdk.putAdviceOfReadByMsgId({ partnerJid: '900719925474099312345@muc.example', msgId: '9223372036854775806', conversationType: 'groupchat' }).then(value => { settled = true; return value; });
  await flush(); assert.equal(settled, false);
  assert.equal(captured['partnerJid'], '900719925474099312345');
  assert.equal(captured['msgId'], '9223372036854775806');
  success({ ResponseStatus: OK_STATUS });
  assert.deepEqual(await pending, { kind: 'success', raw: null });
  sdk.dispose();
});

test('read receipt timeout, malformed success, and callback failure cannot acknowledge or trigger HTTP fallback', async () => {
  for (const mode of ['timeout', 'malformed', 'malformed_errors', 'failure'] as const) {
    const deps = makeDeps(); let fallback = 0, calls = 0;
    const sdk = createPageSdk({ IMClient: { putAdviceOfReadByMsgId: (_request: unknown, success: Callback, failure: Callback) => {
      calls++;
      if (mode === 'malformed') success({});
      if (mode === 'malformed_errors') success({ ResponseStatus: { Ack: 'Success', Errors: 'invalid' } });
      if (mode === 'failure') failure({ error: 3, errmsg: 'denied' });
    } } }, { ...deps, readReceiptTimeoutMs: 100, httpReadReceipt: async () => { fallback++; return { kind: 'success', raw: null }; } });
    const pending = sdk.putAdviceOfReadByMsgId({ partnerJid: 'g1@muc.example', msgId: 'm1', conversationType: 'groupchat' });
    const observed = pending.then(v => v, () => ({ kind: 'unknown' }));
    await deps.clock.advance(100);
    assert.notEqual((await observed).kind, 'success');
    assert.equal(calls, 1); assert.equal(fallback, 0); sdk.dispose();
  }
});

test('late callbacks after disposal or facade replacement cannot confirm old sends or read receipts', async () => {
  for (const mode of ['dispose', 'replace'] as const) {
    const deps = makeDeps(); let sendSuccess!: Callback, readSuccess!: Callback;
    const facade = { sendMessageInSocket: (_message: unknown, success: Callback) => { sendSuccess = success; }, putAdviceOfReadByMsgId: (_request: unknown, success: Callback) => { readSuccess = success; } };
    const win: Record<string, unknown> = { IMClient: facade };
    const sdk = createPageSdk(win, { ...deps, readReceiptTimeoutMs: 100 });
    sdk.rememberPartnerJid('g1', 'g1@muc.example');
    const send = submitIntent(deps, sdk, createSendIntent(deps, 'g1', 'synthetic', { serviceType: '1513', threadId: '' }), 100);
    const read = sdk.putAdviceOfReadByMsgId({ partnerJid: 'g1@muc.example', msgId: 'm1', conversationType: 'groupchat' }).then(value => value, () => ({ kind: 'unknown' }));
    if (mode === 'dispose') sdk.dispose();
    else win['IMClient'] = { ...facade };
    sendSuccess({ msgId: 'old-binding-message' });
    readSuccess({ ResponseStatus: OK_STATUS });
    await deps.clock.advance(100);
    assert.deepEqual((await send).disposition, { kind: 'unknown' });
    assert.notEqual((await read).kind, 'success');
    sdk.dispose(); assert.equal(deps.clock.pendingCount(), 0);
  }
});

test('callback success followed by duplicate callback/promise result confirms once without replay', async () => {
  const deps = makeDeps(); let calls = 0;
  const sdk = createPageSdk({ IMClient: { sendMessageInSocket: (_message: unknown, success: Callback, failure: Callback) => {
    calls++; success({ msgId: 'first' }); failure({ error: 7 }); return Promise.resolve({ msgId: 'second' });
  } } }, deps);
  sdk.rememberPartnerJid('g1', 'g1@muc.example');
  const result = await submitIntent(deps, sdk, createSendIntent(deps, 'g1', 'synthetic', { serviceType: '1513', threadId: '' }), 100);
  await flush();
  assert.equal(result.disposition.kind, 'confirmed');
  if (result.disposition.kind === 'confirmed') assert.equal(result.disposition.server_message_id, 'first');
  assert.equal(calls, 1); sdk.dispose(); assert.equal(deps.clock.pendingCount(), 0);
});

test('HTTP read-receipt fallback receives the same bare group identity only when no facade method exists', async () => {
  const deps = makeDeps(); let captured: unknown = null;
  const sdk = createPageSdk({}, { ...deps, httpReadReceipt: async request => { captured = request; return { kind: 'success', raw: null }; } });
  assert.deepEqual(await sdk.putAdviceOfReadByMsgId({ partnerJid: '900719925474099312345@muc.example', msgId: 'm1', conversationType: 'groupchat' }), { kind: 'success', raw: null });
  assert.deepEqual(captured, { partnerJid: '900719925474099312345', msgId: 'm1', conversationType: 'groupchat' });
  sdk.dispose(); assert.equal(sdk.canSend, false);
});

test('missing send callback remains unknown after timeout and never adds a retry', async () => {
  const deps = makeDeps(); let calls = 0;
  const sdk = createPageSdk({ IMClient: { sendMessageInSocket: () => { calls++; } } }, deps);
  sdk.rememberPartnerJid('g1', 'g1@muc.example');
  const pending = submitIntent(deps, sdk, createSendIntent(deps, 'g1', 'synthetic', { serviceType: '1513', threadId: '' }), 100);
  await deps.clock.advance(1000);
  assert.deepEqual((await pending).disposition, { kind: 'unknown' });
  assert.equal(calls, 1); assert.equal(deps.fakeFetch.calls.length, 0);
  sdk.dispose(); assert.equal(deps.clock.pendingCount(), 0);
});


test('media intents are explicitly unsupported before any facade invocation until public models are implemented', async () => {
  const media: MediaRef[] = [
    { kind: 'image', url: 'https://example.com/image', thumbUrl: 'https://example.com/thumb', width: 10, height: 20, scene: 'test', channel: 'im_business' },
    { kind: 'video', filename: 'video.mp4', cover: 'https://example.com/cover', url: 'https://example.com/video', duration: 1, size: 100, width: 10, height: 20 },
    { kind: 'file', filename: 'file.pdf', url: 'https://example.com/file', size: 100 },
  ];
  for (const item of media) {
    const deps = makeDeps(); let calls = 0;
    const sdk = createPageSdk({ IMClient: { sendMessageInSocket: () => { calls++; } } }, deps);
    sdk.rememberPartnerJid('g1', 'g1@muc.example');
    const intent = createMediaSendIntent(deps, 'g1', item, { serviceType: '1513', threadId: '' });
    assert.throws(() => sdk.sendMessage({ gid: 'g1', body: intent.body }), /media facade unsupported.*nothing sent/);
    const result = await submitIntent(deps, sdk, intent, 100);
    assert.deepEqual(result.disposition, { kind: 'unknown' });
    assert.equal(calls, 0); assert.equal(deps.fakeFetch.calls.length, 0);
    sdk.dispose(); assert.equal(deps.clock.pendingCount(), 0);
  }
});

function callbackFacadeHarness() {
  const deps = makeDeps(); const handlers = new Map<string, (value: unknown) => void>();
  let success!: Callback, failure!: Callback, calls = 0;
  const sdk = createPageSdk({
    xmppClient: { status: 'online', on: (name: string, handler: (value: unknown) => void) => { handlers.set(name, handler); }, removeListener: (name: string) => handlers.delete(name) },
    IMClient: { sendMessageInSocket: (_message: unknown, done: Callback, fail: Callback) => { calls++; success = done; failure = fail; } },
  }, { ...deps, facadeSendTimeoutMs: 100 });
  sdk.rememberPartnerJid('g1', 'g1@muc.example');
  const intent = createSendIntent(deps, 'g1', 'synthetic', { serviceType: '1513', threadId: '' });
  const rawAck = (error: unknown, localid = intent.localId) => handlers.get('stanza')?.({ name: 'message', attrs: { type: 'send_result', id: localid }, getChildText: () => JSON.stringify({ error, localid, tid: 'raw-message', create_time: 1700000000123 }) });
  const savedStanza = handlers.get('stanza')!;
  const queuedRawAck = (error: unknown) => savedStanza({ name: 'message', attrs: { type: 'send_result', id: intent.localId }, getChildText: () => JSON.stringify({ error, localid: intent.localId, tid: 'queued-message' }) });
  return { deps, sdk, intent, rawAck, queuedRawAck, done: (value: unknown) => success(value), fail: (value: unknown) => failure(value), calls: () => calls };
}

test('facade-managed raw -2 is intermediate: HTTP fallback callback decides the send outcome', async () => {
  const h = callbackFacadeHarness(); let settled = false;
  const pending = submitIntent(h.deps, h.sdk, h.intent, 100).then(result => { settled = true; return result; });
  h.rawAck(-2); await flush(); assert.equal(settled, false);
  h.done({ msgId: 'fallback-success', localId: h.intent.localId });
  assert.equal((await pending).disposition.kind, 'confirmed');
  assert.equal(h.calls(), 1); h.sdk.dispose(); assert.equal(h.deps.clock.pendingCount(), 0);
});

test('facade-managed raw success/other error cannot outrun the final callback', async () => {
  for (const code of [0, 7, 'invalid']) {
    const h = callbackFacadeHarness(); let settled = false;
    const pending = submitIntent(h.deps, h.sdk, h.intent, 100).then(result => { settled = true; return result; });
    h.rawAck(code); await flush(); assert.equal(settled, false);
    h.fail({ error: 9, errmsg: 'final rejection' });
    assert.deepEqual((await pending).disposition, { kind: 'rejected', code: '9', reason: 'final rejection' });
    assert.equal(h.calls(), 1); h.sdk.dispose(); assert.equal(h.deps.clock.pendingCount(), 0);
  }
});

test('facade-managed timeout stays unknown; late callback is ignored and tracking timers are cleared', async () => {
  const h = callbackFacadeHarness(); const events: unknown[] = [];
  h.sdk.on('send_result', event => events.push(event));
  const pending = submitIntent(h.deps, h.sdk, h.intent, 100);
  h.rawAck(-2); await h.deps.clock.advance(100);
  assert.deepEqual((await pending).disposition, { kind: 'unknown' });
  const count = events.length;
  h.done({ msgId: 'late-success', localId: h.intent.localId }); await flush();
  assert.equal(events.length, count); assert.equal(h.calls(), 1);
  // Only the recurring global probe remains, not a per-send timer.
  assert.equal(h.deps.clock.pendingCount(), 1);
  h.sdk.dispose(); assert.equal(h.deps.clock.pendingCount(), 0);
});

test('unmanaged raw protocol acknowledgements retain their original codes', async () => {
  const h = callbackFacadeHarness(); const events: { error?: unknown }[] = [];
  h.sdk.on('send_result', event => events.push(event));
  h.rawAck(-2, 'unmanaged-history-id'); h.rawAck(0, 'unmanaged-success'); h.rawAck(7, 'unmanaged-error');
  assert.deepEqual(events.map(e => e.error), [-2, 0, 7]);
  h.sdk.dispose(); assert.equal(h.deps.clock.pendingCount(), 0);
});

test('HTTP receipt fallback shares timeout and disposal fences, and late success never acknowledges', async () => {
  for (const mode of ['timeout', 'dispose'] as const) {
    const deps = makeDeps(); let release!: (value: { kind: 'success'; raw: null }) => void; let calls = 0;
    const sdk = createPageSdk({}, { ...deps, readReceiptTimeoutMs: 100, httpReadReceipt: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
    const result = sdk.putAdviceOfReadByMsgId({ partnerJid: 'g1@muc.example', msgId: 'm1', conversationType: 'groupchat' }).then(value => value, () => ({ kind: 'unknown' }));
    if (mode === 'dispose') sdk.dispose();
    else await deps.clock.advance(100);
    assert.deepEqual(await result, { kind: 'unknown' });
    release({ kind: 'success', raw: null }); await flush();
    assert.deepEqual(await result, { kind: 'unknown' }); assert.equal(calls, 1);
    sdk.dispose(); assert.equal(deps.clock.pendingCount(), 0);
  }
});

test('already-queued raw success/rejection after disposal cannot complete a pending send', async () => {
  for (const error of [0, 7]) {
    const h = callbackFacadeHarness(); let settled = false;
    const pending = submitIntent(h.deps, h.sdk, h.intent, 1000).then(result => { settled = true; return result; });
    h.sdk.dispose(); h.queuedRawAck(error); await flush();
    assert.equal(settled, false);
    await h.deps.clock.advance(1000);
    assert.deepEqual((await pending).disposition, { kind: 'unknown' });
    assert.equal(h.deps.clock.pendingCount(), 0);
  }
});

test('queued events from a replaced xmpp binding cannot publish results, messages, or transport status', async () => {
  const deps = makeDeps();
  const emitter = () => { const callbacks = new Map<string, (value: unknown) => void>(); return { callbacks, status: 'online', on: (event: string, callback: (value: unknown) => void) => callbacks.set(event, callback), removeListener: (event: string) => callbacks.delete(event) }; };
  const old = emitter(), next = emitter();
  const win: Record<string, unknown> = { xmppClient: old };
  const sdk = createPageSdk(win, deps);
  const oldStanza = old.callbacks.get('stanza')!, oldStatus = old.callbacks.get('status')!;
  const results: unknown[] = [], messages: unknown[] = [], statuses: unknown[] = [];
  sdk.on('send_result', value => results.push(value)); sdk.on('message', value => messages.push(value)); sdk.on('socket_status', value => statuses.push(value));
  win['xmppClient'] = next; await deps.clock.advance(1000);
  const priorStatuses = statuses.length;
  oldStanza({ name: 'message', attrs: { type: 'send_result', id: 'unmanaged' }, getChildText: () => JSON.stringify({ error: 0, tid: 'old' }) });
  oldStanza({ name: 'message', attrs: { type: 'groupchat', from: 'g1@muc.example/customer' }, getChildText: () => 'synthetic old message' });
  oldStatus('offline');
  assert.equal(results.length, 0); assert.equal(messages.length, 0); assert.equal(statuses.length, priorStatuses);
  next.callbacks.get('stanza')!({ name: 'message', attrs: { type: 'send_result', id: 'current-unmanaged' }, getChildText: () => JSON.stringify({ error: 7 }) });
  assert.equal(results.length, 1);
  sdk.dispose(); assert.equal(deps.clock.pendingCount(), 0);
});

// One lifecycle matrix exercises the real glue boundary. Expectations derive
// from channel guarantees: only a final facade callback/valid Promise receipt
// may finish sends; a transport Promise rejection is not a server rejection.
for (const channel of ['callback', 'promise', 'raw', 'http_receipt'] as const) {
  for (const lifecycle of ['active', 'disposed', 'rebound', 'timeout'] as const) {
    for (const outcome of ['success', 'rejected', 'malformed'] as const) {
      test(`lifecycle matrix: ${channel} × ${lifecycle} × ${outcome}`, async () => {
        const deps = makeDeps();
        const emitter = () => { const handlers = new Map<string, (value: unknown) => void>(); return { handlers, status: 'online', on: (name: string, handler: (value: unknown) => void) => handlers.set(name, handler), removeListener: (name: string) => handlers.delete(name) }; };
        const xmpp = emitter(); let done: Callback = () => undefined, fail: Callback = () => undefined;
        let resolvePromise!: (raw: unknown) => void, rejectPromise!: (raw: unknown) => void;
        let calls = 0;
        const facade = { sendMessageInSocket: (_message: unknown, success: Callback, failure: Callback) => {
          calls++; done = success; fail = failure;
          if (channel === 'promise') return new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
        } };
        const win: Record<string, unknown> = { xmppClient: xmpp, ...(channel === 'http_receipt' ? {} : { IMClient: facade }) };
        const sdk = createPageSdk(win, { ...deps, facadeSendTimeoutMs: 100, readReceiptTimeoutMs: 100, probeIntervalMs: 10,
          ...(channel === 'http_receipt' ? { httpReadReceipt: () => { calls++; return new Promise<import('./deps.ts').SdkCallOutcome>(resolve => { resolvePromise = raw => resolve(raw as import('./deps.ts').SdkCallOutcome); }); } } : {}),
        });
        sdk.rememberPartnerJid('g1', 'g1@muc.example');
        const intent = createSendIntent(deps, 'g1', 'synthetic', { serviceType: '1513', threadId: '' });
        const savedStanza = xmpp.handlers.get('stanza')!;
        let settled = false;
        const pending = channel === 'http_receipt'
          ? sdk.putAdviceOfReadByMsgId({ partnerJid: 'g1@muc.example', msgId: 'm1', conversationType: 'groupchat' }).then(value => { settled = true; return value.kind; }, () => { settled = true; return 'unknown'; })
          : submitIntent(deps, sdk, intent, 1000).then(value => { settled = true; return value.disposition.kind; });
        if (lifecycle === 'disposed') sdk.dispose();
        if (lifecycle === 'rebound') { win['IMClient'] = { sendMessageInSocket: () => undefined }; win['xmppClient'] = emitter(); await deps.clock.advance(10); }
        if (lifecycle === 'timeout') await deps.clock.advance(100);
        if (channel === 'callback') {
          if (outcome === 'success') done({ msgId: 'server-result', localId: intent.localId });
          else if (outcome === 'rejected') fail({ error: 7, errmsg: 'explicit rejection' });
          else done({});
        } else if (channel === 'promise') {
          if (outcome === 'rejected') rejectPromise({ error: 7 });
          else resolvePromise(outcome === 'success' ? { msgId: 'server-result', localId: intent.localId } : {});
        } else if (channel === 'raw') {
          savedStanza({ name: 'message', attrs: { type: 'send_result', id: intent.localId }, getChildText: () => outcome === 'malformed' ? 'invalid JSON' : JSON.stringify({ localid: intent.localId, tid: 'server-result', error: outcome === 'success' ? 0 : 7 }) });
        } else resolvePromise(outcome === 'success' ? { kind: 'success', raw: null } : outcome === 'rejected' ? { kind: 'failure', raw: 'explicit rejection' } : { malformed: true });
        await flush();
        if (channel === 'raw' && lifecycle === 'active') assert.equal(settled, false);
        await deps.clock.advance(1000);
        const expected = lifecycle !== 'active' || channel === 'raw' || outcome === 'malformed' || (channel === 'promise' && outcome === 'rejected') ? 'unknown'
          : channel === 'http_receipt' ? outcome === 'success' ? 'success' : 'failure'
          : outcome === 'success' ? 'confirmed' : 'rejected';
        assert.equal(await pending, expected);
        assert.equal(calls, 1);
        sdk.dispose(); assert.equal(deps.clock.pendingCount(), 0);
      });
    }
  }
}
