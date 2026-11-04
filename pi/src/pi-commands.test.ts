import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentFlavor } from './agent-flavor';
import type { PiCommand, PiCommandSource } from './pi-commands';

/**
 * Stand-ins for the two rpc dialects, as measured: pi answers `get_commands`;
 * omp rejects `--offline`, greets with `ready`, pushes `available_commands_update`
 * unasked, and answers only `get_available_commands`.
 */
const FAKE_PI = `#!/usr/bin/env node
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.type !== 'get_commands') return;
  process.stdout.write(JSON.stringify({ id: req.id, type: 'response', command: 'get_commands', success: true, data: { commands: [
    { name: 'greet', description: 'Say hi', source: 'prompt', sourceInfo: { path: '/nowhere/greet.md' } },
    { name: 'mcp', description: 'Manage MCP', source: 'extension', sourceInfo: { path: 'builtin:mcp' } },
  ] } }) + '\\n');
});
`;

const FAKE_OMP = `#!/usr/bin/env node
if (process.argv.includes('--offline')) {
  process.stderr.write('Error: unknown flag: --offline\\n');
  process.exit(2);
}
const commands = [
  { name: 'model', description: 'Show current model selection', source: 'builtin' },
  { name: 'greet', description: 'Say hi', source: 'file' },
  { name: 'skill:notes', description: 'Notes skill', source: 'skill' },
  { name: 'green', description: 'Fix CI', source: 'custom' },
  { name: 'autoresearch', description: 'Toggle', source: 'extension' },
  { name: 'mystery', source: 'mcp-something-new' },
];
process.stdout.write(JSON.stringify({ type: 'ready', protocolVersion: 1 }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'available_commands_update', commands }) + '\\n');
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  const ok = req.type === 'get_available_commands';
  process.stdout.write(JSON.stringify(ok
    ? { id: req.id, type: 'response', command: req.type, success: true, data: { commands } }
    : { id: req.id, type: 'response', command: req.type, success: false, error: 'Unknown command: ' + req.type }) + '\\n');
});
`;

describe('listCommands', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-commands-'));
    for (const [name, body] of [['pi', FAKE_PI], ['omp', FAKE_OMP]]) {
      writeFileSync(join(dir, name), body);
      chmodSync(join(dir, name), 0o755);
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function listWith(bin: string, flavor: AgentFlavor): Promise<PiCommand[]> {
    let mod!: typeof import('./pi-commands');
    const saved = process.env.PI_BIN;
    process.env.PI_BIN = join(dir, bin);
    jest.isolateModules(() => { mod = require('./pi-commands'); });
    process.env.PI_BIN = saved;
    return mod.listCommands(dir, flavor);
  }

  const cases: Array<{ name: string; bin: string; flavor: AgentFlavor; want: Array<[string, PiCommandSource]> }> = [
    {
      name: 'pi: takes get_commands as pi gives it',
      bin: 'pi', flavor: 'pi',
      want: [['greet', 'prompt'], ['mcp', 'extension']],
    },
    {
      name: 'omp: asks in its dialect and maps its sources, dropping built-ins, skills and unknowns',
      bin: 'omp', flavor: 'omp',
      want: [['greet', 'prompt'], ['green', 'extension'], ['autoresearch', 'extension']],
    },
  ];

  test.each(cases)('$name', async ({ bin, flavor, want }) => {
    const got = await listWith(bin, flavor);
    expect(got.map(c => [c.name, c.source])).toEqual(want);
  });

  it('omp: rejects the pi dialect, which is why it needs its own', async () => {
    await expect(listWith('omp', 'pi')).rejects.toThrow('unknown flag: --offline');
  });
});

describe('commandsFromLine', () => {
  // Loaded once; PI_BIN is irrelevant to parsing.
  const { commandsFromLine } = require('./pi-commands') as typeof import('./pi-commands');
  const resp = (command: string, extra: object) => JSON.stringify({ type: 'response', command, ...extra });

  const cases: Array<{ name: string; line: string; request: string; want: unknown }> = [
    { name: 'blank line', line: '  ', request: 'get_commands', want: null },
    { name: 'not json', line: 'warming up…', request: 'get_commands', want: null },
    { name: 'an unsolicited update is not the answer', line: JSON.stringify({ type: 'available_commands_update', commands: [{ name: 'x' }] }), request: 'get_available_commands', want: null },
    { name: 'answer to a different request', line: resp('get_state', { success: true, data: {} }), request: 'get_commands', want: null },
    { name: 'pi answer', line: resp('get_commands', { success: true, data: { commands: [{ name: 'a' }] } }), request: 'get_commands', want: [{ name: 'a' }] },
    { name: 'omp answer', line: resp('get_available_commands', { success: true, data: { commands: [{ name: 'b' }] } }), request: 'get_available_commands', want: [{ name: 'b' }] },
    { name: 'a refusal is an empty menu', line: resp('get_commands', { success: false, error: 'Unknown command' }), request: 'get_commands', want: [] },
    { name: 'malformed data is an empty menu', line: resp('get_commands', { success: true, data: {} }), request: 'get_commands', want: [] },
  ];

  test.each(cases)('$name', ({ line, request, want }) => {
    expect(commandsFromLine(line, request)).toEqual(want);
  });
});

describe('omp prompt templates, found where omp reads them', () => {
  let home: string;
  let project: string;
  const saved = { HOME: process.env.HOME, OMP_PROFILE: process.env.OMP_PROFILE, PI_BIN: process.env.PI_BIN };
  const body = (who: string) => `---\ndescription: ${who}\n---\nTemplate from ${who} about $ARGUMENTS.\n`;
  const FAKE = `#!/usr/bin/env node
const commands = ['both', 'useronly', 'projectonly', 'init', 'nested/../../x'].map(name => ({ name, source: 'file' }));
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: req.id, type: 'response', command: req.type, success: true, data: { commands } }) + '\\n');
});
`;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'omp-templates-'));
    project = join(home, 'proj');
    for (const [dir, files] of [
      [join(home, '.omp', 'agent', 'commands'), { both: 'user', useronly: 'user' }],
      [join(home, '.omp', 'profiles', 'work', 'agent', 'commands'), { both: 'work profile', useronly: 'work profile' }],
      [join(project, '.omp', 'commands'), { both: 'project', projectonly: 'project' }],
    ] as const) {
      mkdirSync(dir, { recursive: true });
      for (const [name, who] of Object.entries(files)) writeFileSync(join(dir, `${name}.md`), body(who));
    }
    writeFileSync(join(home, 'x.md'), body('outside'));
    writeFileSync(join(home, 'omp'), FAKE);
    chmodSync(join(home, 'omp'), 0o755);
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  const cases: Array<{ name: string; profile?: string; want: Record<string, string | undefined> }> = [
    {
      name: 'project commands win over user ones; a command with no file has no template',
      want: { both: 'project', useronly: 'user', projectonly: 'project', init: undefined, 'nested/../../x': undefined },
    },
    {
      name: 'a named profile reads its own user commands',
      profile: 'work',
      want: { both: 'project', useronly: 'work profile', projectonly: 'project', init: undefined, 'nested/../../x': undefined },
    },
  ];

  test.each(cases)('$name', async ({ profile, want }) => {
    process.env.HOME = home;
    if (profile) process.env.OMP_PROFILE = profile; else delete process.env.OMP_PROFILE;
    process.env.PI_BIN = join(home, 'omp');
    let mod!: typeof import('./pi-commands');
    jest.isolateModules(() => { mod = require('./pi-commands'); });
    const got = await mod.listCommands(project, 'omp');
    const from = (t?: string) => t && /Template from (.+) about/.exec(t)?.[1];
    expect(Object.fromEntries(got.map(c => [c.name, from(c.template)]))).toEqual(want);
  });
});
