import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { header, message, titleSlot, writeSession } from './omp-session.fixture';

/**
 * The message must reach the agent as the prompt, whatever it starts with. The fake
 * agent parses argv the way pi 1.4.0 and omp 18.15.0 do: a word starting with `-` is a
 * flag (unknown -> exit 2), `@path` is a file to attach (missing -> exit 1), and with
 * no positional prompt it reads the prompt from stdin.
 */
describe('a message that starts with - or @ reaches the agent', () => {
  let root: string;
  let agent: typeof import('./agent');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-argv-'));
    writeSession(root, '--w--', 's1', [titleSlot(), header('s1', root), message('u1', 'user', 'hi')]);
    const bin = join(root, 'fake-cli.js');
    writeFileSync(bin, [
      '#!/usr/bin/env node',
      'const argv = process.argv.slice(2); const words = []; let session = "snew"; let rest = false;',
      'for (let i = 0; i < argv.length; i++) {',
      '  const a = argv[i];',
      '  if (!rest && a === "--") { rest = true; continue; }',
      '  if (!rest && a === "-p") continue;',
      '  if (!rest && (a === "--mode" || a === "--session")) { if (a === "--session") session = require("path").basename(argv[i + 1], ".jsonl"); i++; continue; }',
      '  if (!rest && a.startsWith("-")) { console.error("Error: unknown flag: " + a); process.exit(2); }',
      '  if (a.startsWith("@")) { console.error("Error: File not found: " + a.slice(1)); process.exit(1); }',
      '  words.push(a);',
      '}',
      'const prompt = words.length ? words.join(" ") : require("fs").readFileSync(0, "utf-8");',
      'console.log(JSON.stringify({ type: "session", id: session }));',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "heard: " + prompt }] } }));',
    ].join('\n'));
    chmodSync(bin, 0o755);
    process.env.PI_BIN = bin;
    jest.isolateModules(() => {
      agent = require('./agent');
      const source: typeof import('./session-source') = require('./session-source');
      source.useSessionSource(source.ompSessions(root));
    });
    delete process.env.PI_BIN;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const noop = () => {};
  const cases: Array<{ name: string; msg: string; run: (msg: string) => Promise<{ result: string }> }> = [
    { name: 'plain follow-up', msg: 'fix the bug', run: m => agent.resumeTask('s1', m, root, noop) },
    { name: 'follow-up written as a bullet list', msg: '- fix the bug\n- add a test', run: m => agent.resumeTask('s1', m, root, noop) },
    { name: 'follow-up that @-mentions a file', msg: '@hello.txt what is in this file', run: m => agent.resumeTask('s1', m, root, noop) },
    { name: 'follow-up that starts with --', msg: '--verbose output please', run: m => agent.resumeTask('s1', m, root, noop) },
    { name: 'new session that @-mentions a file', msg: '@README.md summarise this', run: m => agent.startTask(m, root, noop, noop) },
  ];

  test.each(cases)('$name', async ({ msg, run }) => {
    const res = await run(msg);
    expect(res.result).toBe(`heard: ${msg}`);
  });
});
