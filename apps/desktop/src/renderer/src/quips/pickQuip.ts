/**
 * Canned Clippy quips: which tag fits a message, and a random line for that tag.
 * Pure (inject `rng`/time), so it is unit-tested.
 */
import type { Message } from '@clippy/shared/schemas';
import quipsJson from './quips.json';

export type QuipTag = 'build' | 'error' | 'reminder' | 'ask' | 'lateNight' | 'generic' | 'advice';
export type QuipBook = Readonly<Record<QuipTag, readonly string[]>>;

export const QUIPS: QuipBook = quipsJson;

/** "0 failed", "no errors" and friends are good news, not errors. */
const HARMLESS_ERROR_WORDS = /\b(?:0|no|zero|without)\s+(?:errors?|failures?|failed|failing|warnings?|crash(?:es)?)\b/gi;
const ERROR_WORDS =
  /\b(?:errors?|fail(?:s|ed|ing|ure|ures)?|exceptions?|crash(?:ed|es|ing)?|broken|broke|panic(?:ked)?|traceback|denied|timed out|timeout|rolled back|rollback|regression)\b/i;
const BUILD_WORDS =
  /\b(?:builds?|built|compil(?:e|ed|es|ing)|deploy(?:ed|s|ment)?|tests? pass(?:ed|es|ing)?|passing|green|merged|shipped|released?|finished|done|complete[sd]?)\b/i;

/** Is `hour` (0–23, local) in the small hours? */
export function isLateNight(hour: number): boolean {
  return hour >= 23 || hour < 5;
}

/** Pick the quip tag for a new message from its kind, its text and the time of day. */
export function quipTagFor(msg: Pick<Message, 'kind' | 'body' | 'title'>, now: Date): QuipTag {
  if (msg.kind === 'reminder') return 'reminder';
  if (msg.kind === 'ask') return 'ask';
  const text = `${msg.title ?? ''}\n${msg.body}`.replace(HARMLESS_ERROR_WORDS, ' ');
  if (ERROR_WORDS.test(text)) return 'error';
  if (BUILD_WORDS.test(text)) return 'build';
  if (isLateNight(now.getHours())) return 'lateNight';
  return 'generic';
}

/** A random quip for `tag`, avoiding `avoid` (the last one shown) when there is a choice. */
export function pickQuip(tag: QuipTag, rng: () => number = Math.random, avoid?: string, book: QuipBook = QUIPS): string {
  const all = book[tag].length > 0 ? book[tag] : book.generic;
  const pool = all.length > 1 && avoid !== undefined ? all.filter((q) => q !== avoid) : all;
  const index = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
  return pool[index] ?? '';
}

/** The quip shown for a newly arrived message. */
export function quipForMessage(msg: Pick<Message, 'kind' | 'body' | 'title'>, now: Date, rng?: () => number, avoid?: string): string {
  return pickQuip(quipTagFor(msg, now), rng, avoid);
}

export const ADVICE_MIN_MS = 30 * 60_000;
export const ADVICE_MAX_MS = 90 * 60_000;

/** Delay until the next piece of unsolicited advice: uniformly 30–90 minutes. */
export function nextAdviceDelay(rng: () => number = Math.random): number {
  return ADVICE_MIN_MS + Math.floor(rng() * (ADVICE_MAX_MS - ADVICE_MIN_MS));
}
