/** Short, friendly relative time for note cards ("just now", "5 min ago", "yesterday 14:05"). */
export function timeAgo(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 12) return `${hours} h ago`;
  const then = new Date(ts);
  const hhmm = then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (then.toDateString() === today.toDateString()) return `today ${hhmm}`;
  if (then.toDateString() === yesterday.toDateString()) return `yesterday ${hhmm}`;
  return `${then.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${hhmm}`;
}
