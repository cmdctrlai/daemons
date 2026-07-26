/**
 * Rewrites entrypoint:"sdk-cli" → entrypoint:"cli" in a Claude Code
 * session's JSONL.
 *
 * Background: Claude Code v2.1.x's `claude -p` print mode (which this
 * daemon uses to drive sessions on behalf of mobile/web clients) ignores
 * the CLAUDE_CODE_ENTRYPOINT env var and tags every JSONL entry with
 * entrypoint:"sdk-cli". When the user later runs `claude --resume <id>`
 * from a real terminal, Claude Code's resume picker filters out
 * sdk-cli-tagged entries and sessions, so mobile-driven turns disappear
 * from the CLI view.
 *
 * This rewriter runs after each daemon-spawned Claude process exits,
 * walks the affected session's JSONL, and rewrites the entrypoint marker
 * so CLI resume continuity works again.
 *
 * The function is best-effort: errors are logged but never thrown – a
 * rewrite failure must not break the daemon's task lifecycle.
 */

import * as fs from 'fs';
import * as path from 'path';
import { findSessionFile } from '../message-reader';

const SDK_CLI_MARKER = '"entrypoint":"sdk-cli"';
const CLI_MARKER = '"entrypoint":"cli"';

/**
 * Rewrite the entrypoint marker in a specific JSONL file. Returns the
 * number of substitutions made (0 if nothing to do). Throws on I/O
 * errors – callers that want best-effort behavior should wrap in try.
 */
export function rewriteEntrypointInFile(filePath: string): number {
  const original = fs.readFileSync(filePath, 'utf-8');
  if (!original.includes(SDK_CLI_MARKER)) return 0;

  const parts = original.split(SDK_CLI_MARKER);
  const count = parts.length - 1;
  const rewritten = parts.join(CLI_MARKER);

  // Atomic write: tmp file + rename. Keeps the file consistent if
  // another process reads mid-rewrite.
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, rewritten, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  return count;
}

/**
 * Locate a session's JSONL by sessionId and rewrite its entrypoint
 * markers. Best-effort: errors are logged but never thrown, so a rewrite
 * failure can't break the daemon's task lifecycle.
 */
export function rewriteSdkCliEntrypoint(sessionId: string): void {
  try {
    if (!sessionId) return;
    const filePath = findSessionFile(sessionId);
    if (!filePath) return;

    const count = rewriteEntrypointInFile(filePath);
    if (count > 0) {
      console.log(`[entrypoint-rewrite] sdk-cli → cli on ${count} line(s) in ${path.basename(filePath)}`);
    }
  } catch (err) {
    console.error(`[entrypoint-rewrite] failed for session ${sessionId}:`, err);
  }
}
