/**
 * Tests for the entrypoint-rewrite utility (BUG-074).
 *
 * Covers the per-file rewrite logic. The session-id lookup wrapper
 * (rewriteSdkCliEntrypoint) is a thin shim over findSessionFile +
 * rewriteEntrypointInFile, exercised manually during daemon dev runs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { rewriteEntrypointInFile } from './entrypoint-rewrite';

describe('rewriteEntrypointInFile', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-rewrite-test-'));
    tempFile = path.join(tempDir, 'session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rewrites a single sdk-cli marker to cli', () => {
    fs.writeFileSync(tempFile, '{"uuid":"a","entrypoint":"sdk-cli","type":"user"}\n');
    const n = rewriteEntrypointInFile(tempFile);
    expect(n).toBe(1);
    expect(fs.readFileSync(tempFile, 'utf-8')).toBe('{"uuid":"a","entrypoint":"cli","type":"user"}\n');
  });

  it('rewrites multiple sdk-cli markers across multiple lines', () => {
    fs.writeFileSync(tempFile,
      '{"uuid":"a","entrypoint":"sdk-cli"}\n' +
      '{"uuid":"b","entrypoint":"sdk-cli"}\n' +
      '{"uuid":"c","entrypoint":"sdk-cli"}\n'
    );
    const n = rewriteEntrypointInFile(tempFile);
    expect(n).toBe(3);
    const out = fs.readFileSync(tempFile, 'utf-8');
    expect(out.includes('"entrypoint":"sdk-cli"')).toBe(false);
    expect((out.match(/"entrypoint":"cli"/g) || []).length).toBe(3);
  });

  it('leaves existing cli markers untouched', () => {
    fs.writeFileSync(tempFile,
      '{"uuid":"a","entrypoint":"cli"}\n' +
      '{"uuid":"b","entrypoint":"sdk-cli"}\n'
    );
    const n = rewriteEntrypointInFile(tempFile);
    expect(n).toBe(1);
    const out = fs.readFileSync(tempFile, 'utf-8');
    expect((out.match(/"entrypoint":"cli"/g) || []).length).toBe(2);
  });

  it('is a no-op when no sdk-cli markers exist', () => {
    const original = '{"uuid":"a","entrypoint":"cli"}\n';
    fs.writeFileSync(tempFile, original);
    const mtimeBefore = fs.statSync(tempFile).mtimeMs;
    const n = rewriteEntrypointInFile(tempFile);
    expect(n).toBe(0);
    // Untouched file: same mtime (atomic-write should not have run).
    expect(fs.statSync(tempFile).mtimeMs).toBe(mtimeBefore);
  });

  it('preserves trailing newline and intermediate empty lines', () => {
    const original =
      '{"uuid":"a","entrypoint":"sdk-cli"}\n' +
      '\n' +
      '{"uuid":"b","entrypoint":"sdk-cli"}\n';
    fs.writeFileSync(tempFile, original);
    rewriteEntrypointInFile(tempFile);
    const out = fs.readFileSync(tempFile, 'utf-8');
    expect(out).toBe(
      '{"uuid":"a","entrypoint":"cli"}\n' +
      '\n' +
      '{"uuid":"b","entrypoint":"cli"}\n'
    );
  });

  it('only matches the exact entrypoint field – does not clobber lookalikes', () => {
    fs.writeFileSync(tempFile,
      '{"uuid":"a","entrypoint":"sdk-cli","note":"the value sdk-cli appears elsewhere"}\n'
    );
    rewriteEntrypointInFile(tempFile);
    const out = fs.readFileSync(tempFile, 'utf-8');
    // The entrypoint field rewrites, but the unrelated note string is unchanged.
    expect(out).toContain('"entrypoint":"cli"');
    expect(out).toContain('"note":"the value sdk-cli appears elsewhere"');
  });

  it('is idempotent – second call is a no-op', () => {
    fs.writeFileSync(tempFile, '{"uuid":"a","entrypoint":"sdk-cli"}\n');
    const first = rewriteEntrypointInFile(tempFile);
    const second = rewriteEntrypointInFile(tempFile);
    expect(first).toBe(1);
    expect(second).toBe(0);
  });
});
