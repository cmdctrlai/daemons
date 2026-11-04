import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CommandCollapser } from './command-collapse';
import type { PiCommand } from './pi-commands';

/**
 * omp 18.15.0's `get_available_commands` for a project holding
 * `.claude/commands/fixbuild.md` and `.omp/commands/runtests.md` (live: each lists as
 * `{ name, description, source: 'file' }` with no path).
 */
const FAKE_OMP = `#!/usr/bin/env node
const commands = [
  { name: 'fixbuild', description: 'Fix the build', source: 'file' },
  { name: 'runtests', description: 'Run tests', source: 'file' },
];
process.stdout.write(JSON.stringify({ type: 'ready', protocolVersion: 1 }) + '\\n');
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: req.id, type: 'response', command: req.type, success: true, data: { commands } }) + '\\n');
});
`;

const TEMPLATE = '---\ndescription: Fix the build\n---\nFix the failing build in this project and explain each change you make.\n';
const NO_PLACEHOLDER = '---\ndescription: Run tests\n---\nRun the whole test suite and report failures in a table.\n';

describe('omp prompt commands read back as typed', () => {
  let home: string;
  let project: string;
  const saved = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, PI_BIN: process.env.PI_BIN };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'refute-r6-'));
    project = join(home, 'proj');
    mkdirSync(join(project, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(project, '.claude', 'commands', 'fixbuild.md'), TEMPLATE);
    mkdirSync(join(project, '.omp', 'commands'), { recursive: true });
    writeFileSync(join(project, '.omp', 'commands', 'runtests.md'), NO_PLACEHOLDER);
    writeFileSync(join(home, 'omp'), FAKE_OMP);
    chmodSync(join(home, 'omp'), 0o755);
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  async function collapser(): Promise<CommandCollapser> {
    process.env.HOME = home;
    delete process.env.XDG_DATA_HOME;
    process.env.PI_BIN = join(home, 'omp');
    let mod!: typeof import('./pi-commands');
    jest.isolateModules(() => { mod = require('./pi-commands'); });
    const commands: PiCommand[] = await mod.listCommands(project, 'omp');
    expect(commands.map(c => c.name)).toEqual(['fixbuild', 'runtests']);
    const c = new CommandCollapser();
    c.setCommands(commands);
    return c;
  }

  it('/fixbuild from .claude/commands, picked from the menu, is shown as /fixbuild', async () => {
    // What omp stored as the user's message for `/fixbuild` sent from the app (live, omp 18.15.0).
    expect((await collapser()).collapse('Fix the failing build in this project and explain each change you make.')).toBe('/fixbuild');
  });

  it('/runtests quickly please, on a template with no placeholder, is shown as typed', async () => {
    // omp appends the arguments to a template with no placeholder (`appendInlineArgsFallback`);
    // this is what it stored for `/runtests quickly please` (live, omp 18.15.0).
    expect((await collapser()).collapse('Run the whole test suite and report failures in a table.\n\nquickly please')).toBe('/runtests quickly please');
  });
});
