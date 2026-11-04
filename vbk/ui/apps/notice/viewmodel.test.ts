import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CARDS, addNotice, expire, extendDeadlines, leave, noticeKey, refreshNotice, settled, slotY, stackHeight, type NoticeEvent } from './viewmodel.ts';

const account = { account_id: 'a', environment: 'test', session_generation: 1 };
const event = (gid: string, count = 1): NoticeEvent => ({ account, gid, title: `name-${gid}`, preview: `text-${gid}`, count, stay_ms: 6000 });

test('a merge without a confirmed preview keeps the text already on the card', () => {
  const cards = addNotice(addNotice([], event('1'), 0), { ...event('1', 2), title: '', preview: null }, 10);
  assert.deepEqual([cards[0]?.event.title, cards[0]?.event.preview, cards[0]?.event.count], ['name-1', 'text-1', 2]);
});

test('a refresh fills a card in place without touching its timer, count or slot', () => {
  const cards = addNotice(addNotice([], { ...event('1', 3), title: '', preview: null }, 0), event('2'), 0);
  const next = refreshNotice(cards, { account, gid: '1', title: '张三', preview: '明天入住' });
  assert.deepEqual(next.map((c) => c.event.gid), ['1', '2']);
  assert.deepEqual([next[0]?.event.title, next[0]?.event.preview, next[0]?.event.count, next[0]?.deadline], ['张三', '明天入住', 3, cards[0]?.deadline]);
});

test('a refresh without a preview never blanks one, and an absent or leaving card is untouched', () => {
  const cards = addNotice([], event('1'), 0);
  assert.equal(refreshNotice(cards, { account, gid: '1', title: '张三', preview: null })[0]?.event.preview, 'text-1');
  assert.equal(refreshNotice(cards, { account, gid: '2', title: 'x', preview: 'x' }), cards);
  const other = { ...account, session_generation: 2 };
  assert.equal(refreshNotice(cards, { account: other, gid: '1', title: 'x', preview: 'x' }), cards);
  const gone = leave(cards, noticeKey(event('1')));
  assert.equal(refreshNotice(gone, { account, gid: '1', title: 'x', preview: 'x' }), gone);
});

test('new conversations join at the bottom and later ones never reorder earlier ones', () => {
  let cards = addNotice([], event('1'), 0);
  cards = addNotice(cards, event('2'), 10);
  assert.deepEqual(cards.map((c) => c.event.gid), ['1', '2']);
});

test('the same conversation merges in place: new count, fresh timer, same slot', () => {
  let cards = addNotice([], event('1'), 0);
  cards = addNotice(cards, event('2'), 10);
  cards = addNotice(cards, event('1', 3), 2000);
  assert.deepEqual(cards.map((c) => [c.event.gid, c.event.count]), [['1', 3], ['2', 1]]);
  assert.equal(cards[0]?.deadline, 8000);
});

test('generations and accounts are separate cards', () => {
  const next = { ...event('1'), account: { ...account, session_generation: 2 } };
  assert.notEqual(noticeKey(event('1')), noticeKey(next));
});

test('a leaving card frees its slot so the cards below move up', () => {
  let cards = addNotice(addNotice(addNotice([], event('1'), 0), event('2'), 0), event('3'), 0);
  cards = leave(cards, noticeKey(event('2')));
  assert.deepEqual(settled(cards).map((c) => c.event.gid), ['1', '3']);
  assert.equal(cards.length, 3, 'stays in the DOM while it fades');
});

test('a message during fade-out brings the conversation back as a new bottom card', () => {
  let cards = addNotice(addNotice([], event('1'), 0), event('2'), 0);
  cards = leave(cards, noticeKey(event('1')));
  cards = addNotice(cards, event('1', 2), 100);
  assert.deepEqual(settled(cards).map((c) => [c.event.gid, c.event.count]), [['2', 1], ['1', 2]]);
});

test('overflow retires the oldest card instead of growing past the limit', () => {
  let cards: ReturnType<typeof addNotice> = [];
  for (let i = 0; i <= MAX_CARDS; i++) cards = addNotice(cards, event(String(i)), i);
  assert.equal(settled(cards).length, MAX_CARDS);
  assert.equal(settled(cards)[0]?.event.gid, '1');
});

test('cards expire at their deadline, and a hover pause pushes the deadline back', () => {
  const cards = addNotice([], event('1'), 0);
  assert.equal(expire(cards, 5999), cards, 'unchanged identity avoids a needless render');
  assert.equal(settled(expire(cards, 6000)).length, 0);
  assert.equal(settled(expire(extendDeadlines(cards, 3000), 6000)).length, 1);
});

test('the window fits exactly the stack and hides when empty', () => {
  assert.equal(stackHeight(0), 0);
  assert.equal(stackHeight(1), slotY(0) + 76 + 14);
  assert.equal(stackHeight(2) - stackHeight(1), 86);
});
