/**
 * Terminal QR rendering for the device verification URL.
 *
 * Renders using half-block Unicode glyphs (2 modules per character row), which
 * halves the vertical footprint versus one-module-per-character rendering and
 * is what every terminal QR tool (gh, wrangler, doctl) converged on. No ANSI
 * color is used, so NO_COLOR is a non-issue by construction.
 */

import qrcodegen from 'qrcode-generator';

const QUIET_ZONE = 2; // modules of blank border on each side

/** Build the boolean module matrix for `data` at a given error-correction level. */
function buildMatrix(data: string, ecLevel: 'L' | 'M' | 'Q' | 'H' = 'M'): boolean[][] {
  const qr = qrcodegen(0, ecLevel); // 0 = auto-select the smallest version that fits
  qr.addData(data);
  qr.make();
  const count = qr.getModuleCount();
  const matrix: boolean[][] = [];
  for (let row = 0; row < count; row++) {
    const line: boolean[] = [];
    for (let col = 0; col < count; col++) {
      line.push(qr.isDark(row, col));
    }
    matrix.push(line);
  }
  return matrix;
}

function withQuietZone(matrix: boolean[][]): boolean[][] {
  const size = matrix.length + QUIET_ZONE * 2;
  const padded: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  for (let row = 0; row < matrix.length; row++) {
    for (let col = 0; col < matrix.length; col++) {
      padded[row + QUIET_ZONE][col + QUIET_ZONE] = matrix[row][col];
    }
  }
  return padded;
}

/**
 * Render a module matrix as half-block Unicode text: each character cell
 * covers two module rows (top via foreground, bottom via background), so a
 * QR that is N modules tall prints in roughly N/2 terminal lines.
 */
function renderHalfBlock(matrix: boolean[][]): string {
  const lines: string[] = [];
  for (let row = 0; row < matrix.length; row += 2) {
    let line = '';
    for (let col = 0; col < matrix.length; col++) {
      const top = matrix[row][col];
      const bottom = row + 1 < matrix.length ? matrix[row + 1][col] : false;
      if (top && bottom) line += '█';
      else if (top && !bottom) line += '▀';
      else if (!top && bottom) line += '▄';
      else line += ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * Render a module matrix as plain ASCII, two characters per module so the
 * result stays roughly square. Used for the round-trip decode test and as a
 * fallback for output that a photo-based scanner (rather than a human eye)
 * needs to be unambiguous, e.g. copy-pasted into another tool.
 */
function renderAscii(matrix: boolean[][]): string {
  return matrix
    .map((row) => row.map((dark) => (dark ? '##' : '  ')).join(''))
    .join('\n');
}

export interface QrRenderResult {
  /** Half-block terminal rendering, or null if it wouldn't fit / isn't appropriate. */
  block: string | null;
  /** Module count per side, including the quiet zone. Useful for width checks. */
  size: number;
}

/**
 * Render `data` as a terminal QR block, sized to fit within `columns`.
 *
 * Returns `block: null` when the QR would not fit the available width – the
 * caller should still show the URL and code as plain text, which is why this
 * never throws.
 */
export function renderQrForTerminal(data: string, columns: number): QrRenderResult {
  const matrix = withQuietZone(buildMatrix(data));
  const size = matrix.length;
  if (columns < size) {
    return { block: null, size };
  }
  return { block: renderHalfBlock(matrix), size };
}

/** Render `data` as a plain-ASCII QR block (two chars/module), for programmatic decoding. */
export function renderQrAscii(data: string): string {
  return renderAscii(withQuietZone(buildMatrix(data)));
}
