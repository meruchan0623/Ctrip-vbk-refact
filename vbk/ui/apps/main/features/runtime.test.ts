import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_COMMANDS, createFeatureRuntime, isFeatureFact } from './runtime.ts';
import type { FeatureContext, FeatureModule } from './context.ts';
import { FEATURE_CONTEXT_VERSION } from './context.ts';
import { ACCOUNT, GID, makeHost, ownMessage, settle } from './testing.ts';
import { FEATURES, createMainFeatureRuntime } from './registry.ts';
import { featureText } from './strings.ts';

function probe(id: string, commands: string[], onMount?: (c: FeatureContext) => void): FeatureModule & { disposed: number; facts: unknown[] } {
  const m = {
    id,
    commands,
    disposed: 0,
    facts: [] as unknown[],
    mount(c: FeatureContext) {
      onMount?.(c);
    },
    onFact(f: unknown) {
      m.facts.push(f);
    },
    dispose() {
      m.disposed++;
    },
  };
  return m;
}

test('registry: ids are unique, commands are declared, and the real modules mount', () => {
  const ids = FEATURES.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ['typing-indicator', 'recall', 'voice-player', 'queue-banner']);
  const rt = createMainFeatureRuntime(makeHost());
  rt.start();
  assert.deepEqual([...rt.mounted], ids);
  assert.equal(rt.failures.size, 0);
  rt.stop();
  assert.equal(rt.mounted.length, 0);
});

test('invoke is limited to declared commands and always carries the active account', async () => {
  const host = makeHost();
  host.invokeReply = () => Promise.resolve('ok');
  let ctx!: FeatureContext;
  const m = probe('a', ['im_send_input_state'], (c) => { ctx = c; });
  const rt = createFeatureRuntime([m], host);
  rt.start();
  assert.equal(ctx.version, FEATURE_CONTEXT_VERSION);
  assert.equal(await ctx.invoke('im_send_input_state', { gid: GID, account: { account_id: 'attacker' } }), 'ok');
  assert.deepEqual(host.invokes[0]!.payload['account'], ACCOUNT, 'a module cannot aim a command at another account');
  await assert.rejects(ctx.invoke('account_forget'), /may not call/);
  await assert.rejects(ctx.invoke('shell_open_external'), /may not call/);
  host.active = null;
  await assert.rejects(ctx.invoke('im_send_input_state'), /no active account/);
  assert.equal(host.invokes.length, 1);
});

test('a module that throws on mount is isolated; the others keep working', () => {
  const bad = probe('bad', [], () => { throw new Error('boom'); });
  const good = probe('good', []);
  const rt = createFeatureRuntime([bad, good], makeHost());
  rt.start();
  assert.deepEqual([...rt.mounted], ['good']);
  assert.equal(rt.failures.get('bad'), 'boom');
  assert.equal(bad.disposed, 1);
  rt.onFact({ kind: 'queue_notice', account: ACCOUNT, gid: GID });
  assert.equal(good.facts.length, 1);
  assert.equal(bad.facts.length, 0);
});

test('invalid or duplicate ids / command names are rejected up front', () => {
  assert.throws(() => createFeatureRuntime([probe('A b', [])], makeHost()), /invalid feature id/);
  assert.throws(() => createFeatureRuntime([probe('a', []), probe('a', [])], makeHost()), /duplicate feature id/);
  assert.throws(() => createFeatureRuntime([probe('a', ['Bad-Name'])], makeHost()), /invalid command/);
  // a well-formed name outside the four feature commands is refused up front, even though
  // the main window itself may call it
  for (const c of ['account_forget', 'shell_open_external', 'im_send_text', 'media_pick']) {
    assert.throws(() => createFeatureRuntime([probe('a', [c])], makeHost()), /not a feature command/, c);
  }
  assert.deepEqual([...FEATURE_COMMANDS].sort(), ['im_queue_drop_out', 'im_queue_status', 'im_recall_message', 'im_send_input_state']);
  for (const m of FEATURES) for (const c of m.commands) assert.ok(FEATURE_COMMANDS.has(c), `${m.id}:${c}`);
});

test('slots render per scope, a throwing renderer shows nothing, no scope renders nothing', () => {
  const host = makeHost();
  const ok = probe('ok', [], (c) => c.registerSlot('conversation-banner', (s) => `banner:${s.gid}`));
  const boom = probe('boom', [], (c) => c.registerSlot('conversation-banner', () => { throw new Error('x'); }));
  const hidden = probe('hidden', [], (c) => c.registerSlot('composer-hint', () => null));
  const rt = createFeatureRuntime([ok, boom, hidden], host);
  rt.start();
  assert.deepEqual(rt.renderSlot('conversation-banner'), [`banner:${GID}`]);
  assert.deepEqual(rt.renderSlot('composer-hint'), []);
  host.active = null;
  assert.deepEqual(rt.renderSlot('conversation-banner'), []);
});

test('message actions respect visibility predicates and survive a throwing predicate', () => {
  const host = makeHost();
  const m = probe('act', [], (c) => {
    c.registerMessageAction({ id: 'one', label: () => 'One', visible: (msg) => msg.kind === 'text', run: () => undefined });
    c.registerMessageAction({ id: 'one', label: () => 'dup', visible: () => true, run: () => undefined });
    c.registerMessageAction({ id: 'two', label: () => 'Two', visible: () => { throw new Error('x'); }, run: () => undefined });
  });
  const rt = createFeatureRuntime([m], host);
  rt.start();
  assert.deepEqual(rt.messageActions(ownMessage()).map((a) => a.id), ['one']);
  assert.deepEqual(rt.messageActions(ownMessage({ kind: 'image' })).map((a) => a.id), []);
});

test('stop() releases subscriptions and pending timers; callbacks never fire afterwards', async () => {
  const host = makeHost();
  let fired = 0;
  const m = probe('t', [], (c) => {
    c.subscribe(() => { fired++; });
    c.setTimer(() => { fired += 10; }, 1000);
  });
  const rt = createFeatureRuntime([m], host);
  rt.start();
  host.changed();
  assert.equal(fired, 1);
  rt.stop();
  assert.equal(host.listeners.size, 0);
  assert.equal(host.timers.length, 0);
  host.changed();
  await host.advance(5000);
  assert.equal(fired, 1);
  assert.equal(m.disposed, 1);
  const before = host.renders;
  rt.start();
  assert.ok(host.renders >= before);
});

test('ctx.t prefers feature strings, then the window table, else echoes the key', () => {
  const host = makeHost();
  host.t = (k) => (k === 'nav.messages' ? '消息' : null);
  let ctx!: FeatureContext;
  createFeatureRuntime([probe('a', [], (c) => { ctx = c; })], host).start();
  assert.equal(ctx.t('typing.indicator'), featureText('typing.indicator'));
  assert.equal(ctx.t('nav.messages'), '消息');
  assert.equal(ctx.t('no.such.key'), 'no.such.key');
  assert.equal(ctx.t('recall.rejected', { msg: 'X' }), '服务器拒绝撤回：X');
});

test('facts are validated before any module sees them', () => {
  const m = probe('f', []);
  const rt = createFeatureRuntime([m], makeHost());
  rt.start();
  const base = { account: ACCOUNT, gid: GID };
  rt.onFact({ ...base, kind: 'typing', from: 'c', until_ms: 5 });
  rt.onFact({ ...base, kind: 'recalled', message_id: '1' });
  rt.onFact({ ...base, kind: 'typing', from: 1, until_ms: 5 });
  rt.onFact({ ...base, kind: 'unknown_kind' });
  rt.onFact({ kind: 'typing', gid: GID, from: 'c', until_ms: 5 });
  rt.onFact('junk');
  rt.onFact(null);
  assert.equal(m.facts.length, 2);
  assert.equal(isFeatureFact({ ...base, kind: 'typing', from: 'c', until_ms: Infinity }), false);
});

test('requestRender is a no-op before start and after stop', async () => {
  const host = makeHost();
  let ctx!: FeatureContext;
  const rt = createFeatureRuntime([probe('a', [], (c) => { ctx = c; })], host);
  rt.start();
  ctx.requestRender();
  assert.equal(host.renders, 1);
  rt.stop();
  ctx.requestRender();
  await settle();
  assert.equal(host.renders, 1);
});
