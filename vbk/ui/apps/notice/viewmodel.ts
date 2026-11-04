/**
 * Stack rules of the new-message notice window. A conversation keeps one card
 * whose count and timer update in place; a new conversation joins at the
 * bottom, and when a card leaves everything below it moves up.
 */

import type { AccountContext } from '../../packages/ipc/src/contracts.ts';

export const CARD_HEIGHT = 76;
export const CARD_GAP = 10;
/** Room around the stack for the card shadow. */
export const STACK_PADDING = 14;
export const MAX_CARDS = 5;
/** Matches the CSS transition of a leaving card. */
export const LEAVE_MS = 260;

export interface NoticeUpdate {
  readonly account: AccountContext;
  readonly gid: string;
  /** Empty until the conversation row is known. */
  readonly title: string;
  /** Null until the row has caught up with the message. */
  readonly preview: string | null;
}

export interface NoticeEvent extends NoticeUpdate {
  readonly count: number;
  readonly stay_ms: number;
  /** Set on a notice-center card: a click opens this category, not a conversation. */
  readonly category_id?: string;
}

export interface NoticeCard {
  readonly key: string;
  readonly event: NoticeEvent;
  readonly deadline: number;
  readonly leaving: boolean;
}

export function noticeKey(e: Pick<NoticeEvent, 'account' | 'gid'>): string {
  return JSON.stringify([e.account.environment, e.account.account_id, e.account.session_generation, e.gid]);
}

/** Text not yet confirmed by the host never blanks what the card already shows. */
function mergeContent(current: NoticeEvent, next: NoticeUpdate): Pick<NoticeEvent, 'title' | 'preview'> {
  return { title: next.title || current.title, preview: next.preview ?? current.preview };
}

/** Fill in a card on screen; its timer, count and slot stay as they are. */
export function refreshNotice(cards: readonly NoticeCard[], update: NoticeUpdate): readonly NoticeCard[] {
  const key = noticeKey(update);
  if (!cards.some((c) => c.key === key && !c.leaving)) return cards;
  return cards.map((c) => (c.key === key && !c.leaving ? { ...c, event: { ...c.event, ...mergeContent(c.event, update) } } : c));
}

/** Cards that still take a slot in the stack. */
export function settled(cards: readonly NoticeCard[]): readonly NoticeCard[] {
  return cards.filter((c) => !c.leaving);
}

export function addNotice(cards: readonly NoticeCard[], event: NoticeEvent, now: number): readonly NoticeCard[] {
  const key = noticeKey(event);
  const deadline = now + event.stay_ms;
  if (cards.some((c) => c.key === key && !c.leaving)) {
    return cards.map((c) => (c.key === key && !c.leaving ? { ...c, event: { ...event, ...mergeContent(c.event, event) }, deadline } : c));
  }
  // A card still fading out under this key is replaced: the DOM is keyed.
  const next = [...cards.filter((c) => c.key !== key), { key, event, deadline, leaving: false }];
  const overflow = settled(next).length - MAX_CARDS;
  if (overflow <= 0) return next;
  const oldest = new Set(settled(next).slice(0, overflow).map((c) => c.key));
  return next.map((c) => (oldest.has(c.key) ? { ...c, leaving: true } : c));
}

export function leave(cards: readonly NoticeCard[], key: string): readonly NoticeCard[] {
  return cards.map((c) => (c.key === key ? { ...c, leaving: true } : c));
}

export function expire(cards: readonly NoticeCard[], now: number): readonly NoticeCard[] {
  return cards.some((c) => !c.leaving && c.deadline <= now)
    ? cards.map((c) => (!c.leaving && c.deadline <= now ? { ...c, leaving: true } : c))
    : cards;
}

/** Hovering holds every timer: time spent there does not count. */
export function extendDeadlines(cards: readonly NoticeCard[], pausedMs: number): readonly NoticeCard[] {
  return cards.map((c) => ({ ...c, deadline: c.deadline + pausedMs }));
}

export function slotY(slot: number): number {
  return STACK_PADDING + slot * (CARD_HEIGHT + CARD_GAP);
}

/** Window height for `count` cards; 0 hides the window. */
export function stackHeight(count: number): number {
  return count <= 0 ? 0 : slotY(count - 1) + CARD_HEIGHT + STACK_PADDING;
}
