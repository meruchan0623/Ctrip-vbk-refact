/**
 * Voice message bubble: play/pause, progress, duration or remaining time and the
 * transcript. The renderer calls it for every row build, so everything visible
 * derives from the message and the player; while a clip plays, progress paints
 * straight onto the live nodes and never re-renders the message list.
 */

import type { UiMessage } from '../../packages/ipc/src/client.ts';
import type { h as realH, icon as realIcon } from '../../packages/ui-kit/src/h.ts';
import { featureText } from './features/strings.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import { isPlayableVoiceUrl, type VoicePlayer, type VoiceProgress } from './features/voice-player.ts';

const PLAY_ICON = 'M8 5v14l11-7z';
const PAUSE_ICON = 'M9 5v14M15 5v14';

export interface VoiceBubbleOptions {
  /** Offered once the clip failed: the host checks the URL against its external-open policy. */
  readonly onOpenExternal?: (url: string) => void;
}

/** Nodes of the bubble that owns the current clip; `ref` hands over the ones that survived a morph. */
interface LiveView {
  readonly url: string;
  readonly key: string;
  readonly fallback_s: number | null;
  bar: HTMLElement | null;
  fill: HTMLElement | null;
  time: HTMLElement | null;
}

const slots = new WeakMap<VoicePlayer, { view: LiveView | null }>();

function slotOf(player: VoicePlayer): { view: LiveView | null } {
  let slot = slots.get(player);
  if (!slot) {
    const created: { view: LiveView | null } = { view: null };
    player.onProgress((_url, progress, key) => {
      if (created.view?.key === key) paint(created.view, progress);
    });
    slots.set(player, created);
    slot = created;
  }
  return slot;
}

/** `m:ss`; a partial second counts as a whole one so the label reaches 0:00 only at the end. */
export function formatVoiceTime(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function percent(current: number, duration: number): number {
  return Math.min(100, Math.max(0, (current / duration) * 100));
}

function paint(view: LiveView, progress: VoiceProgress): void {
  const duration = progress.duration_s ?? view.fallback_s;
  if (view.bar) view.bar.hidden = duration === null;
  if (view.time) view.time.hidden = duration === null;
  if (duration === null) return;
  const pct = percent(progress.current_s, duration);
  view.fill?.style.setProperty('width', `${pct}%`);
  view.bar?.setAttribute('aria-valuenow', String(Math.round(pct)));
  if (view.time) view.time.textContent = formatVoiceTime(duration - progress.current_s);
}

function fallbackDuration(m: UiMessage): number | null {
  const value = m.voice_duration_s;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function voiceBubble(m: UiMessage, player: VoicePlayer, h: typeof realH, icon: typeof realIcon, options: VoiceBubbleOptions = {}): HTMLElement {
  const transcript = m.text ? h('div', { class: 'voice-text' }, m.text) : null;
  const url = isPlayableVoiceUrl(m.media_url) ? m.media_url : null;
  if (url === null) {
    return h('div', { class: 'bubble voice-bubble voice-unavailable' }, transcript, h('div', { class: 'voice-note' }, featureText('voice.unavailable')));
  }

  // One target per message, not per URL: two rows may share a clip.
  const key = `${m.gid}|${m.message_id ?? m.local_id ?? url}`;
  const state = player.state(url, key);
  const active = state === 'playing' || state === 'paused';
  const progress = player.progress(url, key);
  const fallback_s = fallbackDuration(m);
  const duration = progress?.duration_s ?? fallback_s;
  const current = progress?.current_s ?? 0;
  const pct = duration === null ? 0 : percent(current, duration);
  const label = featureText(state === 'playing' ? 'voice.pause' : 'voice.play');

  const view: LiveView = { url, key, fallback_s, bar: null, fill: null, time: null };
  const slot = slotOf(player);
  // A rebuilt row takes over the live slot; otherwise the click below claims it.
  if (active) slot.view = view;

  return h(
    'div',
    { class: ['bubble', 'voice-bubble', state === 'error' ? 'voice-failed' : null], dataset: { voiceState: state } },
    transcript,
    h(
      'div',
      { class: 'voice-controls' },
      h('button', { type: 'button', class: 'voice-toggle', 'aria-label': label, title: label, onclick: () => { slot.view = view; void player.toggle(url, key); } }, icon(state === 'playing' ? PAUSE_ICON : PLAY_ICON, 14)),
      h('div', { class: 'voice-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': label, hidden: duration === null, ref: (e: Element) => { view.bar = e as HTMLElement; } },
        h('div', { class: 'voice-fill', style: { width: `${pct}%` }, ref: (e: Element) => { view.fill = e as HTMLElement; } })),
      h('span', { class: 'voice-time', hidden: duration === null, ref: (e: Element) => { view.time = e as HTMLElement; } }, duration === null ? '' : formatVoiceTime(active ? duration - current : duration)),
    ),
    state === 'error'
      ? h('div', { class: 'voice-note', role: 'status' }, featureText('voice.failed'),
          options.onOpenExternal ? h('button', { type: 'button', class: 'voice-external', onclick: () => options.onOpenExternal?.(url) }, t('orderMisc.voice.openExternal')) : null)
      : null,
  );
}
