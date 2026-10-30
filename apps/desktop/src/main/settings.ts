/**
 * User settings persisted as `settings.json` in the app data dir (also read by the hook
 * and the MCP server, so it is written atomically).
 *
 * Loading is forgiving: each field is validated on its own, so one bad value (say a
 * hand-edited `workerUrl`) falls back to its default instead of discarding every setting.
 */
import { readFile } from 'node:fs/promises';
import { applySettingsPatch, DEFAULT_SETTINGS, Settings, SettingsPatch } from '@clippy/shared';
import { writeAtomic } from './core/files';

export type SettingsListener = (next: Settings, prev: Settings) => void;

/** Parse raw JSON into Settings, dropping (to the default) any field that doesn't validate. */
export function parseSettingsLenient(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_SETTINGS };
  const clean: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(Settings.shape)) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const parsed = schema.safeParse(value);
    if (parsed.success && parsed.data !== undefined) clean[key] = parsed.data;
  }
  return Settings.parse(clean);
}

export class SettingsStore {
  readonly #file: string;
  #current: Settings;
  #writes: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<SettingsListener>();

  private constructor(file: string, initial: Settings) {
    this.#file = file;
    this.#current = initial;
  }

  /** Read `file` (missing or corrupt → defaults). Nothing is written until the first update. */
  static async load(file: string): Promise<SettingsStore> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[clippy] ${file} unreadable, using defaults:`, err);
    }
    return new SettingsStore(file, parseSettingsLenient(raw));
  }

  get(): Settings {
    return this.#current;
  }

  /**
   * Validate and apply a patch (`null` clears an optional key), persist it, then notify
   * listeners. Throws (and changes nothing) if the patch is invalid. Writes are serialised.
   */
  async update(patch: SettingsPatch): Promise<Settings> {
    const prev = this.#current;
    const next = applySettingsPatch(prev, SettingsPatch.parse(patch));
    this.#current = next;
    const write = this.#writes.then(() => writeAtomic(this.#file, `${JSON.stringify(next, null, 2)}\n`));
    this.#writes = write.catch(() => {});
    try {
      await write;
    } catch (err) {
      if (this.#current === next) this.#current = prev; // not persisted: don't pretend it was
      throw err;
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(next, prev);
      } catch (err) {
        console.error('[clippy] settings listener failed:', err);
      }
    }
    return next;
  }

  /** Subscribe to changes; returns an unsubscribe function. */
  onChange(listener: SettingsListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
