import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInboundTranslation, type InboundTranslationScope } from './inbound-translation.ts';
import type { UiMessage, UiMessageTranslations } from '../../packages/ipc/src/client.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';

const account = { account_id: 'a', environment: 'prod', session_generation: 1 } as AccountContext;
const scope = (gid = 'g'): InboundTranslationScope => ({ key: `k-${gid}`, account, gid });
const message = (id: string, extra: Partial<UiMessage> = {}) => ({ gid: 'g', message_id: id, local_id: null, create_time_ms: 1, sender_role: 'customer', kind: 'text', text: `text-${id}`, translation: null, original: null, ...extra }) as UiMessage;
type Answer = UiMessageTranslations | Error;
const translated = (id: string, text = `译-${id}`) => ({ message_id: id, status: 'translated', translation: text, source_kind: 'text' }) as const;
const answer = (status: 'not_needed' | 'missing' | 'unsupported', id: string) => ({ message_id: id, status, translation: null, source_kind: null });
// Rows default to create_time_ms 1, i.e. old history; `fresh` is a just-delivered row.
const NOW = 1_000_000_000;
const fresh = (id: string, extra: Partial<UiMessage> = {}) => message(id, { create_time_ms: NOW, text: 'Здравствуйте, интернет не работает', ...extra });

function fixture(reply: (ids: readonly string[], call: number) => Answer | Promise<Answer>) {
  let now = NOW, seq = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const calls: string[][] = [], applied: [string, string, string][] = [], changed: number[] = [];
  const controller = createInboundTranslation({
    invoke: async (_command, payload) => {
      const ids = (payload as { message_ids: string[] }).message_ids;
      calls.push([...ids]);
      const value = await reply(ids, calls.length);
      if (value instanceof Error) throw value;
      return value;
    },
    now: () => now,
    setTimeout: (run, ms) => { const id = ++seq; timers.set(id, { at: now + ms, run }); return id; },
    clearTimeout: (handle) => { timers.delete(handle as number); },
    apply: (owner, id, text) => { applied.push([owner.gid, id, text]); },
    changed: () => { changed.push(now); },
    describeError: (e) => (e as Error).message,
  });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].run();
      await flush();
    }
    now = end;
    await flush();
  };
  return { controller, calls, applied, changed, flush, advance };
}

test('on-screen rows are translated newest-first in batches of 20, and each ID is asked once', async () => {
  const list = Array.from({ length: 45 }, (_, i) => message(`m${i}`));
  const f = fixture(ids => ({ supplier: '携程', items: ids.map(id => translated(id)) }));
  f.controller.sync(scope(), list);
  await f.flush();
  assert.deepEqual(f.calls.map(c => c.length), [20, 20, 5]);
  assert.equal(f.calls[0]![0], 'm44', 'newest row goes first');
  assert.equal(f.applied.length, 45);
  assert.equal(f.controller.supplier(list[0]!), '携程');
  // The real `apply` writes the translation into the list before the next sync sees it.
  f.controller.sync(scope(), list.map(row => ({ ...row, translation: '译' })));
  await f.flush();
  assert.equal(f.calls.length, 3, 'answered rows are not re-requested on a new list');
});

test('only translatable rows go out: no pending server id, media, blank or already translated', async () => {
  const f = fixture(ids => ({ supplier: null, items: ids.map(id => translated(id)) }));
  f.controller.sync(scope(), [
    message('ok'), message('sys', { kind: 'system', sender_role: 'system' }), message('img', { kind: 'image' }), message('blank', { text: '  ' }),
    message('done', { translation: '已有' }), message('robot', { sender_role: 'robot' as UiMessage['sender_role'] }), { ...message('x'), message_id: null },
  ]);
  await f.flush();
  assert.deepEqual(f.calls, [['sys', 'ok']]);
});

test('a just-delivered message without a row is retried on a bounded schedule and then offers a retry', async () => {
  const f = fixture(ids => ({ supplier: null, items: [answer('missing', ids[0]!)] }));
  const row = message('late');
  f.controller.sync(scope(), [row]);
  await f.flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.controller.view(row), null, 'automatic attempts draw nothing');
  await f.advance(1000); assert.equal(f.calls.length, 2);
  await f.advance(3000); assert.equal(f.calls.length, 3);
  await f.advance(8000); assert.equal(f.calls.length, 4);
  assert.deepEqual(f.controller.view(row), { status: 'missing' });
  await f.advance(60_000);
  assert.equal(f.calls.length, 4, 'never polls forever');
});

test('delayed indexing that resolves during the budget applies with no visible failure', async () => {
  const f = fixture((ids, call) => ({ supplier: null, items: call === 1 ? [answer('missing', ids[0]!)] : [translated(ids[0]!, '您好')] }));
  const row = message('late');
  f.controller.sync(scope(), [row]);
  await f.flush();
  await f.advance(1000);
  assert.deepEqual(f.applied, [['g', 'late', '您好']]);
  assert.equal(f.controller.view(row), null);
  assert.equal(f.changed.length, 0, 'a silent success needs no state redraw');
});

test('not_needed, unsupported and an identical translation are terminal and silent', async () => {
  const f = fixture(ids => ({ supplier: null, items: ids.map(id => id === 'same' ? translated(id, '您好') : answer(id === 'zh' ? 'not_needed' : 'unsupported', id)) }));
  const rows = [message('zh', { text: '您好，流量用完了' }), message('no'), message('same', { text: '您好' })];
  f.controller.sync(scope(), rows);
  await f.flush();
  await f.advance(60_000);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.applied, []);
  assert.ok(rows.every(row => f.controller.view(row) === null));
});

test('a new foreign row answered not_needed keeps asking and shows the translation once it exists', async () => {
  const f = fixture((ids, call) => ({ supplier: null, items: call < 3 ? [answer('not_needed', ids[0]!)] : [translated(ids[0]!, '您好')] }));
  const row = fresh('first');
  f.controller.sync(scope(), [row]);
  await f.flush();
  assert.equal(f.controller.view(row), null, 'waiting stays silent');
  await f.advance(4000);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.applied, [['g', 'first', '您好']]);
});

test('a new foreign row echoed back untranslated keeps asking too', async () => {
  const text = 'Здравствуйте, интернет не работает';
  const f = fixture((ids, call) => ({ supplier: null, items: [translated(ids[0]!, call === 1 ? text : '您好')] }));
  f.controller.sync(scope(), [fresh('first', { text })]);
  await f.flush();
  await f.advance(1000);
  assert.deepEqual(f.applied, [['g', 'first', '您好']]);
});

test('a new row in the display language, and a manual request, take not_needed at once', async () => {
  const f = fixture(ids => ({ supplier: null, items: ids.map(id => answer('not_needed', id)) }));
  f.controller.sync(scope(), [fresh('zh', { text: '您好，请问流量用完了吗' })]);
  await f.flush();
  await f.advance(120_000);
  assert.equal(f.calls.length, 1);
  const manual = fixture(ids => ({ supplier: null, items: ids.map(id => answer('not_needed', id)) }));
  const row = fresh('ru');
  manual.controller.sync(scope(), [row]);
  assert.equal(await manual.controller.retry(row), 'not_needed');
});

test('a new row gets a longer bounded budget, then stops', async () => {
  const f = fixture(ids => ({ supplier: null, items: [answer('missing', ids[0]!)] }));
  const row = fresh('late');
  f.controller.sync(scope(), [row]);
  await f.flush();
  await f.advance(12_000);
  assert.equal(f.calls.length, 4);
  assert.equal(f.controller.view(row), null, 'still inside the budget');
  await f.advance(45_000);
  assert.equal(f.calls.length, 6);
  assert.equal(f.controller.view(row), null, 'a lagging session keeps its quiet retries');
  await f.advance(180_000);
  assert.equal(f.calls.length, 8);
  assert.deepEqual(f.controller.view(row), { status: 'missing' });
  await f.advance(300_000);
  assert.equal(f.calls.length, 8, 'never polls forever');
});

test('a later message asks again about a recent row that ended without a result', async () => {
  for (const status of ['missing', 'not_needed', 'unsupported'] as const) {
    let ready = false;
    const f = fixture(ids => ({ supplier: null, items: ids.map(id => ready ? translated(id, `译-${id}`) : answer(status, id)) }));
    const first = fresh('first');
    f.controller.sync(scope(), [first]);
    await f.flush();
    await f.advance(240_000);
    assert.equal(f.calls.length, 8);
    ready = true;
    f.changed.length = 0;
    f.controller.sync(scope(), [first, fresh('second')]);
    await f.flush();
    assert.deepEqual(f.calls.at(-1), ['second', 'first'], 'newest first, in one batch');
    assert.deepEqual(f.applied, [['g', 'second', '译-second'], ['g', 'first', '译-first']]);
    assert.equal(f.controller.view(first), null, 'the failure marker is gone');
    assert.equal(f.changed.length, status === 'unsupported' ? 0 : 1, 'only a drawn marker needs a redraw');
  }
});

test('a new foreign row that never gets a translation ends with the visible retry offer', async () => {
  const f = fixture(ids => ({ supplier: null, items: ids.map(id => answer('not_needed', id)) }));
  const row = fresh('first'), short = fresh('short', { text: '123' });
  f.controller.sync(scope(), [row, short]);
  await f.flush();
  assert.equal(f.controller.view(row), null);
  await f.advance(240_000);
  assert.deepEqual(f.controller.view(row), { status: 'missing' });
  assert.equal(f.controller.view(short), null, 'no language evidence stays silent');
});

test('a flagged body is shown for a foreign row and hidden for a Chinese one', async () => {
  const flagged = (id: string, text: string) => ({ ...translated(id, text), reason: 'flagged' }) as const;
  const f = fixture(ids => ({ supplier: null, items: ids.map(id => flagged(id, id === 'ru' ? '您好' : '您好吗')) }));
  f.controller.sync(scope(), [message('ru', { text: 'Check my sim. No internet' }), message('zh', { text: '您好嗎' })]);
  await f.flush();
  assert.deepEqual(f.applied, [['g', 'ru', '您好']]);
});

test('an answer for a row that has left the list is forgotten, and its return asks again', async () => {
  let release!: (value: Answer) => void;
  const f = fixture((ids, call) => call === 1 ? new Promise<Answer>(resolve => { release = resolve; }) : { supplier: null, items: ids.map(id => translated(id)) });
  const row = message('m');
  f.controller.sync(scope(), [row]);
  await f.flush();
  f.controller.sync(scope(), []);
  release({ supplier: null, items: [translated('m')] });
  await f.flush();
  assert.deepEqual(f.applied, []);
  f.controller.sync(scope(), [row]);
  await f.flush();
  assert.deepEqual(f.applied, [['g', 'm', '译-m']]);
});

test('an unrelated list change does not ask again, and an old row is not reopened by a new one', async () => {
  const f = fixture(ids => ({ supplier: null, items: ids.map(id => id === 'new' ? translated(id) : answer('missing', id)) }));
  const old = message('old');
  f.controller.sync(scope(), [old]);
  await f.flush();
  await f.advance(12_000);
  assert.equal(f.calls.length, 4);
  f.controller.sync(scope(), [{ ...old }]);
  await f.flush();
  assert.equal(f.calls.length, 4, 'no new row, no new request');
  f.controller.sync(scope(), [old, fresh('new')]);
  await f.flush();
  assert.deepEqual(f.calls.at(-1), ['new']);
});

test('a system-title result never decorates a plain text row', async () => {
  const f = fixture(ids => ({ supplier: null, items: ids.map(id => ({ message_id: id, status: 'translated', translation: '通知', source_kind: 'system' }) as const) }));
  f.controller.sync(scope(), [message('text'), message('notice', { kind: 'system', sender_role: 'system' })]);
  await f.flush();
  assert.deepEqual(f.applied, [['g', 'notice', '通知']]);
});

test('request failures retry, then show the reason; a manual retry shows progress and recovers', async () => {
  let healthy = false;
  const f = fixture(ids => healthy ? { supplier: null, items: ids.map(id => translated(id)) } : new Error('网络超时'));
  const row = message('m');
  f.controller.sync(scope(), [row]);
  await f.flush();
  await f.advance(12_000);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.controller.view(row), { status: 'failed', error: '网络超时' });
  assert.equal(f.changed.length, 1);
  healthy = true;
  const outcome = f.controller.retry(row);
  assert.deepEqual(f.controller.view(row), { status: 'pending' }, 'click shows 正在翻译 right away');
  assert.equal(await outcome, 'translated');
  assert.deepEqual(f.applied, [['g', 'm', '译-m']]);
  assert.equal(f.controller.view(row), null);
});

test('a hung request cannot leave a row spinning', async () => {
  const f = fixture(() => new Promise<Answer>(() => undefined));
  const row = message('m');
  f.controller.sync(scope(), [row]);
  const outcome = f.controller.retry(row);
  await f.flush();
  assert.deepEqual(f.controller.view(row), { status: 'pending' });
  await f.advance(30_000 * 4 + 12_000);
  assert.equal(await outcome, 'failed');
  assert.deepEqual(f.controller.view(row), { status: 'failed', error: '翻译请求超时' });
});

test('a late answer from a previous conversation or account is discarded', async () => {
  let release!: (value: Answer) => void;
  const f = fixture((ids, call) => call === 1 ? new Promise<Answer>(resolve => { release = resolve; }) : { supplier: null, items: ids.map(id => translated(id)) });
  f.controller.sync(scope('g'), [message('old')]);
  await f.flush();
  f.controller.sync(scope('other'), [message('new', { gid: 'other' })]);
  await f.flush();
  release({ supplier: null, items: [translated('old')] });
  await f.flush();
  assert.deepEqual(f.applied, [['other', 'new', '译-new']]);
});

test('leaving a thread forgets failures so reopening asks again, but keeps terminal answers', async () => {
  let call = 0;
  const f = fixture(ids => { call++; return call <= 4 ? new Error('offline') : { supplier: null, items: ids.map(id => answer('not_needed', id)) }; });
  const row = message('m', { text: '您好，流量用完了' });
  f.controller.sync(scope(), [row]);
  await f.flush();
  await f.advance(12_000);
  assert.equal(f.controller.view(row)?.status, 'failed');
  f.controller.sync(null, null);
  f.controller.sync(scope(), [row]);
  await f.flush();
  assert.equal(call, 5);
  f.controller.sync(null, null);
  f.controller.sync(scope(), [row]);
  await f.flush();
  assert.equal(call, 5, 'a not_needed row is not requested again');
});

const foreignOld = (id: string, extra: Partial<UiMessage> = {}) => message(id, { text: 'Здравствуйте, у меня не работает eSIM', ...extra });

test('history: an old foreign row answered not_needed is asked again before it is believed, then ends silent', async () => {
  const f = fixture((ids, call) => ({ supplier: null, items: [call < 3 ? answer('not_needed', ids[0]!) : translated(ids[0]!, '您好')] }));
  f.controller.sync(scope(), [foreignOld('old')]);
  await f.flush();
  await f.advance(12_000);
  assert.deepEqual(f.applied, [['g', 'old', '您好']]);
  const never = fixture(ids => ({ supplier: null, items: ids.map(id => answer('not_needed', id)) }));
  const row = foreignOld('old');
  never.controller.sync(scope(), [row]);
  await never.flush();
  await never.advance(60_000);
  assert.equal(never.calls.length, 4, 'bounded');
  assert.equal(never.controller.view(row), null, 'old rows do not get a failure marker');
});

test('history: an old Chinese row or one without language evidence is believed at once', async () => {
  const f = fixture(ids => ({ supplier: null, items: ids.map(id => answer('not_needed', id)) }));
  f.controller.sync(scope(), [message('zh', { text: '您好，流量用完了' }), message('num', { text: '12' })]);
  await f.flush();
  await f.advance(60_000);
  assert.equal(f.calls.length, 1);
});

test('reopening a thread asks again about foreign rows that ended without a result', async () => {
  let ready = false;
  const f = fixture(ids => ({ supplier: null, items: ids.map(id => ready ? translated(id) : answer('not_needed', id)) }));
  const row = foreignOld('old');
  f.controller.sync(scope(), [row]);
  await f.flush();
  await f.advance(12_000);
  assert.equal(f.calls.length, 4);
  f.controller.sync(null, null);
  ready = true;
  f.controller.sync(scope(), [row]);
  await f.flush();
  assert.deepEqual(f.applied, [['g', 'old', '译-old']]);
});

test('a new row reopens an old ended row only after the cooldown', async () => {
  let ready = false;
  const f = fixture(ids => ({ supplier: null, items: ids.map(id => ready ? translated(id) : answer('missing', id)) }));
  const old = foreignOld('old');
  f.controller.sync(scope(), [old]);
  await f.flush();
  await f.advance(12_000);
  assert.equal(f.calls.length, 4);
  ready = true;
  f.controller.sync(scope(), [old, foreignOld('n1')]);
  await f.flush();
  assert.deepEqual(f.calls.at(-1), ['n1'], 'inside the cooldown only the new row goes out');
  await f.advance(31_000);
  f.controller.sync(scope(), [old, foreignOld('n1', { translation: '译' }), foreignOld('n2')]);
  await f.flush();
  assert.ok(f.applied.some(a => a[1] === 'old'), 'the old row is asked again after the cooldown');
});

test('recheck (window back in view) reopens ended rows after the cooldown, never inside it', async () => {
  let ready = false;
  const f = fixture(ids => ({ supplier: null, items: ids.map(id => ready ? translated(id) : answer('missing', id)) }));
  f.controller.sync(scope(), [foreignOld('old')]);
  await f.flush();
  await f.advance(12_000);
  assert.equal(f.calls.length, 4);
  ready = true;
  f.controller.recheck();
  await f.flush();
  assert.equal(f.calls.length, 4, 'cooldown');
  await f.advance(31_000);
  f.controller.recheck();
  await f.flush();
  assert.deepEqual(f.applied, [['g', 'old', '译-old']]);
});
