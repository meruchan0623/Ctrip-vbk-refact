/** Pure formatting helpers (no DOM). */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `16秒`, `1分42秒`, `1小时02分` — matches the prototype's `fmtWait`. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${pad2(s % 60)}秒`;
  const hh = Math.floor(m / 60);
  return `${hh}小时${pad2(m % 60)}分`;
}

/** Unread badge: `''` for 0, `1`–`99`, `99+` beyond. */
export function badgeText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n > 99) return '99+';
  return String(Math.floor(n));
}

export function formatClock(ms: number, withSeconds = false): string {
  const d = new Date(ms);
  const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad2(d.getSeconds())}` : base;
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Conversation-list style relative time: `HH:MM` today, `昨天`, else `MM-DD`. */
export function formatRelativeTime(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const now = new Date(nowMs);
  if (sameDay(d, now)) return formatClock(ms);
  const y = new Date(nowMs - 86_400_000);
  if (sameDay(d, y)) return '昨天';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Mask the middle of an order number for display: `0000****0001`. */
export function maskMiddle(s: string, keep = 4): string {
  if (s.length <= keep * 2) return s;
  return `${s.slice(0, keep)}****${s.slice(-keep)}`;
}

export function initialOf(name: string): string {
  const t = name.trim();
  if (!t) return '?';
  const first = Array.from(t)[0] ?? '?';
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}
