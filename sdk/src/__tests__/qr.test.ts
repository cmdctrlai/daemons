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

  test('renders a half-block terminal image when the terminal is wide enough', () => {
    const { block, size } = renderQrForTerminal('https://app.cmd-ctrl.ai/verify?code=ABCD-1234', 80);
    expect(block).not.toBeNull();
    // Half-block rendering packs two module rows per text line.
    expect(block!.split('\n')).toHaveLength(Math.ceil(size / 2));
    expect(block!.split('\n')[0].length).toBe(size);
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
