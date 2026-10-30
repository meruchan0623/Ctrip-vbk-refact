import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoaClient } from './soa.ts';
import { fetchHistoryPage, messageListBody } from './history.ts';
import { UNKNOWN_ROLES } from './facts.ts';
import { OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

const msg = (id: string, t: number, msgtype = 0) => ({ msgId: id, messageBody: '{{body}}', fromJid: '{{uid}}@x', toJid: '{{gid}}@x', threadId: '', createTime: t, bizType: '1513', status: 2, msgtype, isread: false });

test('history body: base, prev+endTime, next+beginTime, 13-digit cursors only', () => {
  const deps = makeDeps();
  const base = messageListBody(deps, { gid: '{{gid}}', conversationType: 'B2C', pageSize: 20 });
  assert.deepEqual(Object.keys(base as object), ['head', 'showTargetIsRead', 'groupId', 'conversationType', 'pageSize']);
  assert.equal(base?.showTargetIsRead, true);
  const prev = messageListBody(deps, { gid: 'g', conversationType: 'B2C', pageSize: 2, cursor: { direction: 'prev', endTime: 1700000000000 } });
  assert.equal(prev?.endTime, 1700000000000);
  assert.equal(prev?.direction, 'prev');
  assert.equal('beginTime' in (prev as object), false);
  const next = messageListBody(deps, { gid: 'g', conversationType: 'B2C', pageSize: 2, cursor: { direction: 'next', beginTime: 1700000000000 } });
  assert.equal(next?.beginTime, 1700000000000);
  assert.equal(next?.direction, 'next');
  assert.equal(messageListBody(deps, { gid: 'g', conversationType: 'B2C', pageSize: 2, cursor: { direction: 'prev', endTime: 1700000000 } }), null);
  assert.equal(messageListBody(deps, { gid: 'g', conversationType: 'B2C', pageSize: 2, cursor: { direction: 'next', beginTime: 1.5e12 + 0.5 } }), null);
});

test('history pager reads rangeMessage and never claims completeness without isDone', async () => {
  const deps = makeDeps((call) => {
    const b = call.bodyJson as { direction?: string };
    if (b.direction === undefined) return jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: false, lastMessageTime: 1700000000200, messages: [msg('a', 1700000000100), msg('b', 1700000000200, 1009)] } });
    if (b.direction === 'prev') return jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, lastMessageTime: 1700000000050, messages: [msg('z', 1700000000050)] }, messages: [msg('TOP', 1)] });
    return jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, lastMessageTime: 1700000000300, messages: [msg('c', 1700000000300)] } });
  });
  const soa = new SoaClient(deps);
  const base = await fetchHistoryPage(deps, soa, { gid: '{{gid}}', conversationType: 'B2C', pageSize: 2 }, UNKNOWN_ROLES);
  assert.equal(base.kind, 'page');
  if (base.kind !== 'page') return;
  assert.equal(base.page.isDone, false);
  assert.equal(base.page.lastMessageTime, 1700000000200);
  assert.deepEqual(
    base.page.facts.map((f) => [f.message_id, f.kind, f.source, f.gid]),
    [
      ['a', 'business', 'history', '{{gid}}'],
      ['b', 'recall', 'history', '{{gid}}'],
    ],
  );

  const prev = await fetchHistoryPage(deps, soa, { gid: '{{gid}}', conversationType: 'B2C', pageSize: 2, cursor: { direction: 'prev', endTime: 1700000000100 } }, UNKNOWN_ROLES);
  assert.equal(prev.kind, 'page');
  if (prev.kind !== 'page') return;
  assert.equal(prev.page.isDone, true);
  assert.deepEqual(prev.page.facts.map((f) => f.message_id), ['z']); // top-level `messages` is ignored

  const next = await fetchHistoryPage(deps, soa, { gid: '{{gid}}', conversationType: 'B2C', pageSize: 2, cursor: { direction: 'next', beginTime: 1700000000200 } }, UNKNOWN_ROLES);
  assert.equal(next.kind, 'page');
  if (next.kind === 'page') assert.deepEqual(next.page.facts.map((f) => f.message_id), ['c']);

  const bad = await fetchHistoryPage(deps, soa, { gid: 'g', conversationType: 'B2C', pageSize: 2, cursor: { direction: 'next', beginTime: 12 } }, UNKNOWN_ROLES);
  assert.deepEqual(bad, { kind: 'invalid_cursor' });
});

test('history pager surfaces failures', async () => {
  const deps = makeDeps(() => jsonResponse('', 500));
  const r = await fetchHistoryPage(deps, new SoaClient(deps), { gid: 'g', conversationType: 'B2C', pageSize: 2 }, UNKNOWN_ROLES);
  assert.equal(r.kind, 'failed');
});
