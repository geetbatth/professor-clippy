/** Small file helpers for the core's data files. */
import { rename, rm, writeFile } from 'node:fs/promises';

/**
 * Write `contents` to `file` atomically: write a temp file next to it, then
 * rename over the target, so readers never see a partial file.
 */
export async function writeAtomic(file: string, contents: string, mode?: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, contents, { encoding: 'utf8', ...(mode !== undefined && { mode }) });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
