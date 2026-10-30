/** The committed app icons (made by scripts/make-icons.mjs from build/icon.svg) are what electron-builder needs. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const build = join(import.meta.dirname, '..', 'build');
const PNG_SIGNATURE = '89504e470d0a1a0a';

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('app icons', () => {
  it('icon.png is 512 × 512', () => {
    expect(pngSize(readFileSync(join(build, 'icon.png')))).toEqual({ width: 512, height: 512 });
  });

  it('icon.ico holds PNG images from 16 to 256 px', () => {
    const ico = readFileSync(join(build, 'icon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      const image = pngSize(ico.subarray(offset, offset + length));
      const declared = ico.readUInt8(entry) || 256;
      expect(image).toEqual({ width: declared, height: declared });
      sizes.push(declared);
    }
    expect(sizes).toEqual(expect.arrayContaining([16, 24, 32, 48, 64, 128, 256]));
  });
});
