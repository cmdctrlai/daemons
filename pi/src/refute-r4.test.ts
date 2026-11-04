import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CommandCollapser } from './command-collapse';
import type { PiCommand } from './pi-commands';

/**
 * omp 18.15.0's `get_available_commands`, verbatim for a markdown command in
 * `~/.omp/agent/commands/`: no `sourceInfo`, no path – only name, description, source.
 */
const FAKE_OMP = `#!/usr/bin/env node
const commands = [{ name: 'summarise', description: 'Summarise this repo', source: 'file' }];
process.stdout.write(JSON.stringify({ type: 'ready', protocolVersion: 1 }) + '\\n');
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: req.id, type: 'response', command: req.type, success: true, data: { commands } }) + '\\n');
});
`;

const TEMPLATE = '---\ndescription: Summarise this repo\n---\nSummarise the files here in one paragraph about $ARGUMENTS.\n';

describe('omp prompt command reads back as the command the user typed', () => {
  let home: string;
  const saved = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, PI_BIN: process.env.PI_BIN };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'refute-r4-'));
    mkdirSync(join(home, '.omp', 'agent', 'commands'), { recursive: true });
    writeFileSync(join(home, '.omp', 'agent', 'commands', 'summarise.md'), TEMPLATE);
    writeFileSync(join(home, 'omp'), FAKE_OMP);
    chmodSync(join(home, 'omp'), 0o755);
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('/summarise the tests, sent from the app, is shown as /summarise the tests', async () => {
    process.env.HOME = home;
    delete process.env.XDG_DATA_HOME;
    process.env.PI_BIN = join(home, 'omp');
    let mod!: typeof import('./pi-commands');
    jest.isolateModules(() => { mod = require('./pi-commands'); });

    const commands: PiCommand[] = await mod.listCommands(home, 'omp');
    const collapser = new CommandCollapser();
    collapser.setCommands(commands);

    // What omp stores as the user's message for `/summarise the tests` (live, omp 18.15.0).
    expect(collapser.collapse('Summarise the files here in one paragraph about the tests.')).toBe('/summarise the tests');
  });
});
