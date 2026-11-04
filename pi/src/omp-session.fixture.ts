/** Builders for omp session files in the layout omp 18.x writes. Test-only. */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/** omp's fixed-width title slot: the whole line, newline included, is 256 bytes. */
export function titleSlot(title = ''): string {
  const base = JSON.stringify({ type: 'title', v: 1, title, updatedAt: '2026-11-01T17:40:06.437Z', pad: '' });
  return base.replace('"pad":""', `"pad":"${' '.repeat(255 - base.length)}"`);
}

export function header(id: string, cwd = '/work/proj', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-11-01T17:40:06.437Z', cwd, ...extra });
}

export function message(id: string, role: string, text: string, at = '2026-11-01T17:40:07.000Z'): string {
  const content = role === 'toolCall'
    ? [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }]
    : [{ type: 'text', text }];
  return JSON.stringify({
    type: 'message', id, parentId: null, timestamp: at,
    message: { role: role === 'toolCall' ? 'assistant' : role, content },
  });
}

export function custom(id: string): string {
  return JSON.stringify({ type: 'custom', customType: 'session_exit', id, parentId: null, timestamp: '2026-11-01T17:40:08.000Z', data: {} });
}

/** Write `<root>/<bucket>/<name>.jsonl` and return its path. */
export function writeSession(root: string, bucket: string, name: string, lines: string[]): string {
  const dir = join(root, bucket);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}
