import * as crypto from 'crypto';
import * as path from 'path';
import * as net from 'net';
import * as fs from 'fs';
import {
  deriveControlSocketPath,
  matchJobBySessionId,
  classifyReplyResult,
  sendControlRequestTo,
  BgJob,
} from './claude-daemon';

describe('deriveControlSocketPath', () => {
  const cases: Array<{
    name: string;
    dir: string;
    uid: number;
    tmp: string;
  }> = [
    { name: 'default macOS config dir', dir: '/Users/alice/.claude', uid: 501, tmp: '/tmp' },
    { name: 'linux config dir', dir: '/home/alice/.claude', uid: 1000, tmp: '/tmp' },
    { name: 'custom CLAUDE_CONFIG_DIR', dir: '/opt/claude-config', uid: 0, tmp: '/var/tmp' },
    { name: 'trailing slash is resolved away', dir: '/home/bob/.claude/', uid: 1000, tmp: '/tmp' },
  ];

  it.each(cases)('$name', ({ dir, uid, tmp }) => {
    const expectedHash = crypto
      .createHash('sha256')
      .update(path.resolve(dir))
      .digest('hex')
      .slice(0, 8);
    const expected = path.join(tmp, `cc-daemon-${uid}`, expectedHash, 'control.sock');
    expect(deriveControlSocketPath(dir, uid, tmp)).toBe(expected);
  });

  it('matches the known-good hash for /Users/alice/.claude', () => {
    // Pins the derivation algorithm (sha256 of the resolved dir, first 8 hex
    // chars). The algorithm itself was verified against a live supervisor
    // socket dir during the original investigation.
    expect(deriveControlSocketPath('/Users/alice/.claude', 501, '/tmp')).toBe(
      '/tmp/cc-daemon-501/5ac5e874/control.sock'
    );
  });
});

describe('matchJobBySessionId', () => {
  const jobs: BgJob[] = [
    { short: 'aaaa1111', sessionId: 'aaaa1111-0000-0000-0000-000000000000', state: 'blocked' },
    { short: 'bbbb2222', sessionId: 'bbbb2222-0000-0000-0000-000000000000', state: 'working' },
    { short: 'cccc3333', state: 'done' }, // no sessionId
  ];

  const cases: Array<{ name: string; sessionId: string; expected: string | null }> = [
    { name: 'exact match returns the job', sessionId: 'bbbb2222-0000-0000-0000-000000000000', expected: 'bbbb2222' },
    { name: 'first entry match', sessionId: 'aaaa1111-0000-0000-0000-000000000000', expected: 'aaaa1111' },
    { name: 'no match returns null', sessionId: 'ffff9999-0000-0000-0000-000000000000', expected: null },
    { name: 'short id alone does not match full session id', sessionId: 'bbbb2222', expected: null },
    { name: 'empty session id returns null', sessionId: '', expected: null },
  ];

  it.each(cases)('$name', ({ sessionId, expected }) => {
    const result = matchJobBySessionId(jobs, sessionId);
    expect(result ? result.short : null).toBe(expected);
  });

  it('returns null for an empty job list', () => {
    expect(matchJobBySessionId([], 'anything')).toBeNull();
  });
});

describe('classifyReplyResult', () => {
  const cases: Array<{
    name: string;
    resp: { ok: boolean; code?: string };
    delivered: boolean;
    code?: string;
  }> = [
    { name: 'ok delivers', resp: { ok: true }, delivered: true },
    { name: 'EAUTH falls back', resp: { ok: false, code: 'EAUTH' }, delivered: false, code: 'EAUTH' },
    { name: 'ENOJOB falls back', resp: { ok: false, code: 'ENOJOB' }, delivered: false, code: 'ENOJOB' },
    { name: 'ENOREPLY falls back', resp: { ok: false, code: 'ENOREPLY' }, delivered: false, code: 'ENOREPLY' },
    { name: 'unknown failure falls back', resp: { ok: false }, delivered: false, code: undefined },
  ];

  it.each(cases)('$name', ({ resp, delivered, code }) => {
    const outcome = classifyReplyResult(resp);
    expect(outcome.delivered).toBe(delivered);
    if (!outcome.delivered && code !== undefined) {
      expect(outcome.code).toBe(code);
    }
  });
});

describe('sendControlRequestTo (transport)', () => {
  // Keep the socket path short – macOS caps Unix socket paths at ~104 bytes.
  const socketPath = path.join('/tmp', `ccd-test-${process.pid}.sock`);
  let server: net.Server;
  // Given a parsed request line, return the response line(s) to write back,
  // or null to close without responding.
  let handler: (req: Record<string, unknown>) => string | null;

  beforeAll((done) => {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // not present, fine
    }
    server = net.createServer((conn) => {
      let buffer = '';
      conn.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const reply = handler(JSON.parse(line));
        if (reply === null) {
          conn.end();
        } else {
          conn.write(reply);
        }
      });
    });
    server.listen(socketPath, done);
  });

  afterAll((done) => {
    server.close(() => {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // already gone
      }
      done();
    });
  });

  it('parses a list response and echoes what the server sent', async () => {
    handler = () =>
      JSON.stringify({ ok: true, op: 'list', jobs: [{ short: 'abcd1234', sessionId: 'abcd1234-x' }] }) + '\n';
    const resp = await sendControlRequestTo(socketPath, { proto: 1, op: 'list' });
    expect(resp.ok).toBe(true);
    expect(resp.jobs?.[0].short).toBe('abcd1234');
  });

  it('forwards the auth key and short id on a reply and returns ok', async () => {
    let seen: Record<string, unknown> | undefined;
    handler = (req) => {
      seen = req;
      return JSON.stringify({ ok: true, op: 'reply' }) + '\n';
    };
    const resp = await sendControlRequestTo(socketPath, {
      proto: 1,
      op: 'reply',
      short: 'abcd1234',
      text: 'hello',
      auth: 'secret-key',
    });
    expect(resp.ok).toBe(true);
    expect(seen).toMatchObject({ op: 'reply', short: 'abcd1234', text: 'hello', auth: 'secret-key' });
  });

  it('surfaces an error-coded reply so the caller can fall back', async () => {
    handler = () => JSON.stringify({ ok: false, code: 'EAUTH', error: 'bad key' }) + '\n';
    const resp = await sendControlRequestTo(socketPath, { proto: 1, op: 'reply' });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('EAUTH');
  });

  it('rejects on malformed JSON', async () => {
    handler = () => 'not json\n';
    await expect(sendControlRequestTo(socketPath, { proto: 1, op: 'list' })).rejects.toThrow(/malformed/);
  });

  it('rejects when the server closes without responding', async () => {
    handler = () => null;
    await expect(sendControlRequestTo(socketPath, { proto: 1, op: 'list' })).rejects.toThrow(/closed without response/);
  });

  it('rejects on timeout when the server never replies', async () => {
    handler = () => ''; // write nothing, hold the connection open
    await expect(sendControlRequestTo(socketPath, { proto: 1, op: 'list' }, 200)).rejects.toThrow(/timeout/);
  });

  it('rejects when the socket path does not exist', async () => {
    await expect(
      sendControlRequestTo(path.join('/tmp', `ccd-missing-${process.pid}.sock`), { proto: 1, op: 'list' })
    ).rejects.toThrow();
  });
});
