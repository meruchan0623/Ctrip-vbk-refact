/**
 * New-message notices (strong-alert §2 L2): cards fade in at the top-right of
 * the desktop with the chime, stack downward, and move up as others leave.
 * Content comes only from the host events: customer name, message preview and
 * a count. Cards are keyed DOM nodes moved with CSS transforms, so a render
 * never restarts a running transition.
 */

import { applyPlatform } from '../_shared/platform.ts';
applyPlatform();

import { Events, NoticeCommands } from '../../packages/ipc/src/commands.ts';
import { h } from '../../packages/ui-kit/src/h.ts';
import { exposeForTests, selectIpc } from '../_shared/ipc.ts';
import { guarded, isNoticeEvent, isNoticeUpdate, isSoundName } from '../_shared/guards.ts';
import { playSound } from '../main/sound.ts';
import { NOTICE_STRINGS as S } from './strings.ts';
import { LEAVE_MS, addNotice, expire, extendDeadlines, leave, refreshNotice, settled, slotY, stackHeight, type NoticeCard, type NoticeEvent, type NoticeUpdate } from './viewmodel.ts';

const sel = selectIpc();
const ipc = sel.ipc;
const rootNode = document.getElementById('app');
if (!rootNode) throw new Error('#app missing');
const root: HTMLElement = rootNode;

const MAX_HOVER_MS = 60_000;

let cards: readonly NoticeCard[] = [];
const nodes = new Map<string, HTMLElement>();
let hoveredSince: number | null = null;
let reportedHeight = 0;
let shrinkTimer: ReturnType<typeof setTimeout> | null = null;

function reportHeight(height: number): void {
  if (height === reportedHeight) return;
  reportedHeight = height;
  void ipc.invoke(NoticeCommands.RESIZE, { height }).catch(() => undefined);
}

/** Grow before a card enters; shrink only once the leaving one is gone. */
function syncHeight(): void {
  const height = stackHeight(settled(cards).length);
  if (shrinkTimer) clearTimeout(shrinkTimer);
  shrinkTimer = null;
  if (height >= reportedHeight) reportHeight(height);
  else shrinkTimer = setTimeout(() => reportHeight(stackHeight(settled(cards).length)), LEAVE_MS);
}

function nameText(e: NoticeEvent): string {
  return e.title || S.customerFallback;
}

function previewText(e: NoticeEvent): string {
  return e.preview ?? (e.category_id ? S.categoryPreview : S.messagePreview);
}

/** One message needs no number: the card itself says it. */
function countText(e: NoticeEvent): string {
  if (e.count < 2) return '';
  return e.count > 99 ? '99+' : String(e.count);
}

function writeContent(node: HTMLElement, e: NoticeEvent): void {
  const name = node.querySelector<HTMLElement>('[data-notice-name]');
  const preview = node.querySelector<HTMLElement>('[data-notice-preview]');
  const count = node.querySelector<HTMLElement>('[data-notice-count]');
  if (name) name.textContent = nameText(e);
  if (preview) preview.textContent = previewText(e);
  if (count) {
    count.textContent = countText(e);
    count.hidden = e.count < 2;
  }
}

function createNode(card: NoticeCard): HTMLElement {
  const node = h('div', {
    class: 'ncard',
    role: 'button',
    tabindex: 0,
    dataset: { noticeGid: card.event.gid },
    onclick: () => open(card.key),
  },
    h('div', { class: 'ncard-main' },
      h('div', { class: 'ncard-head' },
        h('span', { class: 'ncard-name', dataset: { noticeName: '' } }),
        h('span', { class: 'ncard-count', dataset: { noticeCount: '' } }),
      ),
      h('div', { class: 'ncard-preview', dataset: { noticePreview: '' } }),
    ),
    h('button', {
      class: 'ncard-close',
      type: 'button',
      'aria-label': S.closeLabel,
      onclick: (e: Event) => { e.stopPropagation(); dismiss(card.key); },
    }, '×'),
  );
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') open(card.key);
  });
  return node;
}

function render(): void {
  const slots = new Map(settled(cards).map((c, i) => [c.key, i]));
  for (const card of cards) {
    let node = nodes.get(card.key);
    const slot = slots.get(card.key);
    if (!node) {
      if (slot === undefined) continue;
      const created = createNode(card);
      created.style.setProperty('--y', `${slotY(slot)}px`);
      nodes.set(card.key, created);
      root.append(created);
      // One frame in the start state, so the fade-in actually transitions.
      requestAnimationFrame(() => requestAnimationFrame(() => created.classList.add('in')));
      node = created;
    }
    writeContent(node, card.event);
    if (slot !== undefined) node.style.setProperty('--y', `${slotY(slot)}px`);
    node.classList.toggle('leaving', card.leaving);
  }
}

function retireLeaving(): void {
  const gone = cards.filter((c) => c.leaving);
  if (gone.length === 0) return;
  setTimeout(() => {
    for (const card of gone) {
      if (cards.includes(card)) {
        nodes.get(card.key)?.remove();
        nodes.delete(card.key);
      }
    }
    cards = cards.filter((c) => !gone.includes(c));
    // The last card can vanish under the cursor without a mouseleave.
    if (cards.length === 0) hoveredSince = null;
    syncTicker();
    syncHeight();
  }, LEAVE_MS);
}

function update(next: readonly NoticeCard[]): void {
  if (next === cards) return;
  cards = next;
  syncTicker();
  syncHeight();
  render();
  retireLeaving();
}

function dismiss(key: string): void {
  update(leave(cards, key));
}

function open(key: string): void {
  const card = cards.find((c) => c.key === key);
  if (!card) return;
  dismiss(key);
  const { account, gid, category_id } = card.event;
  const opened = category_id ? ipc.invoke(NoticeCommands.OPEN_CATEGORY, { account, category_id }) : ipc.invoke(NoticeCommands.OPEN, { account, gid });
  void opened.catch(() => undefined);
}

function onNotice(event: NoticeEvent): void {
  update(addNotice(cards, event, hoveredSince ?? Date.now()));
}

function onNoticeUpdate(next: NoticeUpdate): void {
  update(refreshNotice(cards, next));
}

root.addEventListener('mouseenter', () => { hoveredSince = Date.now(); });
function endHover(): void {
  if (hoveredSince === null) return;
  const paused = Date.now() - hoveredSince;
  hoveredSince = null;
  update(extendDeadlines(cards, paused));
}
root.addEventListener('mouseleave', endHover);
// The window stays alive hidden between notices: the expiry tick only runs while cards exist.
let ticker: ReturnType<typeof setInterval> | null = null;
function syncTicker(): void {
  if (cards.length === 0) {
    if (ticker !== null) { clearInterval(ticker); ticker = null; }
    return;
  }
  ticker ??= setInterval(() => {
    // A shrinking window may not report the cursor leaving; never hold forever.
    if (hoveredSince !== null && Date.now() - hoveredSince > MAX_HOVER_MS) endHover();
    if (hoveredSince === null) update(expire(cards, Date.now()));
  }, 200);
}

ipc.listen<unknown>(Events.NOTICE, guarded(Events.NOTICE, isNoticeEvent, onNotice));
ipc.listen<unknown>(Events.NOTICE_UPDATE, guarded(Events.NOTICE_UPDATE, isNoticeUpdate, onNoticeUpdate));
ipc.listen<unknown>(Events.PLAY_SOUND, guarded(Events.PLAY_SOUND, isSoundName, (name) => { playSound(name); }));

exposeForTests(sel);
