/**
 * Client for the Claude Code background-session supervisor.
 *
 * Claude Code hosts every background agent (`claude --bg`, and sessions
 * backgrounded into agent view) in a per-user supervisor process. The supervisor
 * exposes a Unix domain socket that agent view uses to peek and reply to running
 * sessions. We reuse the same transport to deliver an app message into a session
 * that is running as a background agent, which `claude --resume` refuses to touch.
 *
 * The socket speaks newline-delimited JSON. Requests are a discriminated union on
 * `op`; we use `list` (enumerate jobs, no auth) and `reply` (deliver a user turn,
 * auth required). See internal-docs/planning/bg-session-delivery.md for the full
 * protocol and how it was validated.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

// peerProtocol version spoken by the supervisor control socket.
const PROTO = 1;
// Socket requests are one line each; cap accumulated response bytes to match the
// supervisor's own 1 MiB frame limit so a misbehaving peer can't grow unbounded.
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

export interface BgJob {
  short: string;
  sessionId?: string;
  state?: string;
}

interface ControlResponse {
  ok: boolean;
  op?: string;
  code?: string;
  error?: string;
  jobs?: BgJob[];
}

export type DeliveryOutcome =
  | { delivered: true }
  | { delivered: false; reason: 'not-bg' | 'no-key' | 'unreachable' | 'rejected'; code?: string };

/** Absolute Claude Code config directory ($CLAUDE_CONFIG_DIR or ~/.claude). */
function configDir(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.resolve(dir);
}

/**
 * Base tmp directory the supervisor uses for its socket dir. Mirrors the CLI,
 * which hardcodes `/tmp` on every platform except Termux (`$PREFIX/tmp`) – it
 * does NOT use os.tmpdir(), which on macOS resolves to /var/folders/… instead.
 */
function tmpBase(): string {
  if (process.env.TERMUX_VERSION && process.env.PREFIX) {
    return path.join(process.env.PREFIX, 'tmp');
  }
  return '/tmp';
}

/**
 * Derive the supervisor control socket path. Exported for testing.
 *
 * Mirrors the CLI: `<tmp>/cc-daemon-<uid>/<sha256(resolve(configDir))[:8]>/control.sock`.
 */
export function deriveControlSocketPath(
  dir: string,
  uid: number,
  tmp: string
): string {
  const hash = crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 8);
  return path.join(tmp, `cc-daemon-${uid}`, hash, 'control.sock');
}

function controlSocketPath(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return deriveControlSocketPath(configDir(), uid, tmpBase());
}

/** Read the supervisor control key, or null if it isn't present. */
function readControlKey(): string | null {
  try {
    const key = fs.readFileSync(path.join(configDir(), 'daemon', 'control.key'), 'utf-8').trim();
    return key || null;
  } catch {
    return null;
  }
}

/**
 * Find the background job whose full session id matches. Exported for testing.
 */
export function matchJobBySessionId(jobs: BgJob[], sessionId: string): BgJob | null {
  for (const job of jobs) {
    if (job.sessionId === sessionId) {
      return job;
    }
  }
  return null;
}

/**
 * Classify a `reply` response into whether the message was delivered. Exported
 * for testing. `EAUTH`/`ENOJOB`/`ENOREPLY` and any other failure mean we should
 * fall back to the normal `--resume` spawn path.
 */
export function classifyReplyResult(resp: ControlResponse): DeliveryOutcome {
  if (resp.ok) {
    return { delivered: true };
  }
  return { delivered: false, reason: 'rejected', code: resp.code };
}

/**
 * Send one request to a control socket and resolve the first response line.
 * Rejects on socket error or timeout so callers can fall back to spawning.
 * Exported for testing against a fake server.
 */
export function sendControlRequestTo(
  socketPath: string,
  req: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath);
    let buffer = '';
    let settled = false;

    const done = (err: Error | null, resp?: ControlResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      if (err) reject(err);
      else resolve(resp!);
    };

    const timer = setTimeout(() => done(new Error('control socket timeout')), timeoutMs);

    conn.on('connect', () => {
      conn.write(JSON.stringify(req) + '\n');
    });

    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        try {
          done(null, JSON.parse(line) as ControlResponse);
        } catch {
          done(new Error('malformed control socket response'));
        }
        return;
      }
      if (buffer.length > MAX_RESPONSE_BYTES) {
        done(new Error('control socket response exceeded size cap'));
      }
    });

    conn.on('error', (err) => done(err));
    conn.on('end', () => done(new Error('control socket closed without response')));
  });
}

/**
 * List background jobs the supervisor is hosting. Returns an empty array if the
 * supervisor isn't running or the socket is unreachable.
 */
export async function listBgJobs(): Promise<BgJob[]> {
  try {
    const resp = await sendControlRequestTo(controlSocketPath(), { proto: PROTO, op: 'list' });
    return Array.isArray(resp.jobs) ? resp.jobs : [];
  } catch {
    return [];
  }
}

/**
 * Deliver a user message to a session that is running as a background agent.
 *
 * Returns `{delivered: true}` only when the supervisor accepted the reply. Any
 * other outcome (session isn't a bg job, no control key, socket unreachable, or
 * the reply was rejected) returns `delivered: false` with a reason so the caller
 * falls back to the normal `--resume` spawn path.
 */
export async function deliverToBgSession(
  sessionId: string,
  text: string
): Promise<DeliveryOutcome> {
  let jobs: BgJob[];
  try {
    jobs = await listBgJobs();
  } catch {
    return { delivered: false, reason: 'unreachable' };
  }

  const job = matchJobBySessionId(jobs, sessionId);
  if (!job) {
    return { delivered: false, reason: 'not-bg' };
  }

  const auth = readControlKey();
  if (!auth) {
    return { delivered: false, reason: 'no-key' };
  }

  try {
    const resp = await sendControlRequestTo(controlSocketPath(), {
      proto: PROTO,
      op: 'reply',
      short: job.short,
      text,
      auth,
    });
    return classifyReplyResult(resp);
  } catch {
    return { delivered: false, reason: 'unreachable' };
  }
}
