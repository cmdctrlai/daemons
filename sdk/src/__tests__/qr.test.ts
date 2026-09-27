import jsQR from 'jsqr';
import { renderQrForTerminal, renderQrAscii } from '../qr';

/** Parse the '##'/'  ' ASCII grid back into a boolean module matrix. */
function parseAscii(ascii: string): boolean[][] {
  return ascii.split('\n').map((line) => {
    const cells: boolean[] = [];
    for (let i = 0; i < line.length; i += 2) {
      cells.push(line.slice(i, i + 2) === '##');
    }
    return cells;
  });
}

/** Rasterize a module matrix to an RGBA buffer jsQR can decode. */
function toImageData(matrix: boolean[][], pixelsPerModule = 4): { data: Uint8ClampedArray; width: number; height: number } {
  const size = matrix.length;
  const width = size * pixelsPerModule;
  const height = width;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const dark = matrix[row][col];
      const value = dark ? 0 : 255;
      for (let py = 0; py < pixelsPerModule; py++) {
        for (let px = 0; px < pixelsPerModule; px++) {
          const x = col * pixelsPerModule + px;
          const y = row * pixelsPerModule + py;
          const idx = (y * width + x) * 4;
          data[idx] = value;
          data[idx + 1] = value;
          data[idx + 2] = value;
          data[idx + 3] = 255;
        }
      }
    }
  }
  return { data, width, height };
}

/** Unpack a half-block block into modules, rasterized as a terminal draws it: a cell is twice as tall as wide. */
function decodeHalfBlock(block: string): string | null {
  const rows = block.split('\n');
  const size = [...rows[0]].length;
  const matrix: boolean[][] = [];
  rows.forEach((line) => {
    const glyphs = [...line];
    matrix.push(glyphs.map((ch) => ch === '█' || ch === '▀'));
    matrix.push(glyphs.map((ch) => ch === '█' || ch === '▄'));
  });
  const cellWidth = 4;
  const cellHeight = 8;
  const width = size * cellWidth;
  const height = rows.length * cellHeight;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = matrix[Math.floor(y / (cellHeight / 2))][Math.floor(x / cellWidth)] ? 0 : 255;
      const idx = (y * width + x) * 4;
      data[idx] = value;
      data[idx + 1] = value;
      data[idx + 2] = value;
      data[idx + 3] = 255;
    }
  }
  return jsQR(data, width, height)?.data ?? null;
}

function decode(url: string): string | null {
  const matrix = parseAscii(renderQrAscii(url));
  const { data, width, height } = toImageData(matrix);
  const result = jsQR(data, width, height);
  return result?.data ?? null;
}

describe('renderQrForTerminal', () => {
  test('round-trips a verification URL through an actual QR decoder', () => {
    const url = 'https://app.cmd-ctrl.ai/verify?code=ABCD-1234';
    expect(decode(url)).toBe(url);
  });

  test('round-trips a longer URL with query params', () => {
    const url = 'https://api.cmd-ctrl.ai/verify?code=WXYZ-9876&device=work-laptop-01';
    expect(decode(url)).toBe(url);
  });

  test.each([
    ['production URL', 'https://cmd-ctrl.ai/devices/verify?code=ABCD-EFGH'],
    ['long dev tunnel URL', 'https://example-long-tunnel-host01.ngrok-free.dev/devices/verify?code=ABCD-EFGH'],
  ])('the terminal block itself decodes: %s', (_name, url) => {
    const { block } = renderQrForTerminal(url, 80);
    expect(decodeHalfBlock(block!)).toBe(url);
  });

  test('draws square modules: one column wide, half a line tall', () => {
    const { block, size } = renderQrForTerminal('https://cmd-ctrl.ai/devices/verify?code=ABCD-EFGH', 80);
    const lines = block!.split('\n');
    // Version 3 at EC level L: 29 modules plus a 2-module quiet zone each side.
    expect(size).toBe(33);
    expect(lines).toHaveLength(Math.ceil(33 / 2));
    expect(lines.every((line) => [...line].length === size)).toBe(true);
  });

  test('returns null when the terminal is too narrow', () => {
    const { block, size } = renderQrForTerminal('https://app.cmd-ctrl.ai/verify?code=ABCD-1234', 10);
    expect(block).toBeNull();
    expect(size).toBeGreaterThan(10);
  });

  test('fits a plausible narrow-but-usable terminal width (40 columns)', () => {
    const { block } = renderQrForTerminal('https://app.cmd-ctrl.ai/verify?code=ABCD-1234', 40);
    expect(block).not.toBeNull();
  });
});
