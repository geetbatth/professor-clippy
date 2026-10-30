/**
 * Coarse alpha masks for click-through (pure). The window lets clicks through wherever Clippy
 * is transparent, so a click between his arm and his canister reaches the desktop below.
 */

export interface AlphaMask {
  cols: number;
  rows: number;
  /** 1 where the cell (or a neighbour, see `buildMask`) holds an opaque pixel; row-major. */
  cells: Uint8Array;
}

/** Alpha (0–255) above which a pixel counts as part of him. */
export const ALPHA_THRESHOLD = 48;

/**
 * Build a mask from RGBA pixels (`width` × `height`), one cell per `cell` × `cell` pixels.
 * Opaque cells are grown by one cell in every direction, so the edges are easy to grab.
 */
export function buildMask(rgba: ArrayLike<number>, width: number, height: number, cell: number): AlphaMask {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const raw = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / cell) * cols;
    for (let x = 0; x < width; x++) {
      if ((rgba[(y * width + x) * 4 + 3] ?? 0) > ALPHA_THRESHOLD) raw[row + Math.floor(x / cell)] = 1;
    }
  }
  const cells = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!raw[r * cols + c]) continue;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) cells[rr * cols + cc] = 1;
        }
      }
    }
  }
  return { cols, rows, cells };
}

/** Is the point at (`fx`, `fy`) (fractions of the image, 0–1) opaque? Outside the image is not. */
export function maskHit(mask: AlphaMask, fx: number, fy: number): boolean {
  if (!(fx >= 0 && fx < 1 && fy >= 0 && fy < 1)) return false;
  return mask.cells[Math.floor(fy * mask.rows) * mask.cols + Math.floor(fx * mask.cols)] === 1;
}
