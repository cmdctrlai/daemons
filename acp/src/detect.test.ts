import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentTypeFor, detectAgents, GENERIC_AGENT_TYPE, isEditorLauncher, KNOWN_AGENTS, pinShadowedBin, resolveBin } from './detect';
import { chooseAgent, isDifferentAgent } from './commands/register';

const byBin = (bin: string) => KNOWN_AGENTS.find((a) => a.bin === bin)!;

describe('detectAgents', () => {
  const cases: Array<{ name: string; path: string | undefined; present: string[]; want: string[] }> = [
    { name: 'none on PATH', path: '/a:/b', present: [], want: [] },
    { name: 'one', path: '/a:/b', present: ['/b/qwen'], want: ['qwen'] },
    { name: 'several, in list order', path: '/a:/b', present: ['/b/goose', '/a/dsh', '/a/kimi'], want: ['dsh', 'kimi', 'goose'] },
    { name: 'same bin in two dirs counted once', path: '/a:/b', present: ['/a/qwen', '/b/qwen'], want: ['qwen'] },
    { name: 'unknown binaries ignored', path: '/a', present: ['/a/claude', '/a/qwen-code'], want: [] },
    { name: 'empty PATH entries ignored', path: ':/a::', present: ['/a/dsh', 'dsh'], want: ['dsh'] },
    { name: 'undefined PATH', path: undefined, present: ['/a/dsh'], want: [] },
  ];
  it.each(cases)('$name', ({ path: pathEnv, present, want }) => {
    const found = detectAgents(pathEnv, (file) => present.includes(file));
    expect(found.map((a) => a.bin)).toEqual(want);
  });

  const shadowCases: Array<{ name: string; path: string; present: string[]; launchers: string[]; want: string[] }> = [
    { name: 'CLI only, by full path', path: '/a', present: ['/a/agy'], launchers: [], want: ['/a/agy acp'] },
    { name: 'IDE launcher earlier on PATH is skipped', path: '/ide:/cli', present: ['/ide/agy', '/cli/agy'], launchers: ['/ide/agy'], want: ['/cli/agy acp'] },
    { name: 'IDE launcher only', path: '/ide', present: ['/ide/agy'], launchers: ['/ide/agy'], want: [] },
    { name: 'path with a space is quoted', path: '/My Tools', present: ['/My Tools/agy'], launchers: [], want: ['"/My Tools/agy" acp'] },
    { name: 'unshadowed agent keeps its bare command', path: '/a', present: ['/a/qwen'], launchers: [], want: ['qwen --acp'] },
    { name: 'launcher named like an unshadowed agent is skipped', path: '/a', present: ['/a/goose'], launchers: ['/a/goose'], want: [] },
  ];
  it.each(shadowCases)('$name', ({ path: pathEnv, present, launchers, want }) => {
    const found = detectAgents(pathEnv, (f) => present.includes(f), (f) => launchers.includes(f));
    expect(found.map((a) => a.command)).toEqual(want);
  });

  it('finds a real executable and skips a non-executable file and a directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-detect-'));
    fs.writeFileSync(path.join(dir, 'qwen'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'dsh'), '', { mode: 0o644 });
    fs.mkdirSync(path.join(dir, 'goose'));
    try {
      expect(detectAgents(dir).map((a) => a.bin)).toEqual(['qwen']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isEditorLauncher', () => {
  const cases: Array<{ name: string; content: string | null; want: boolean }> = [
    { name: 'VS Code launcher script', content: '#!/usr/bin/env bash\nif [ -n "$VSCODE_IPC_HOOK_CLI" ]; then\n', want: true },
    { name: 'native binary', content: '\xcf\xfa\xed\xfe binary', want: false },
    { name: 'other shell script', content: '#!/bin/sh\nexec node agent.js "$@"\n', want: false },
    { name: 'missing file', content: null, want: false },
  ];
  it.each(cases)('$name', ({ content, want }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-launcher-'));
    const file = path.join(dir, 'agy');
    if (content !== null) fs.writeFileSync(file, content, 'latin1');
    try {
      expect(isEditorLauncher(file)).toBe(want);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pinShadowedBin', () => {
  const cases: Array<{ name: string; command: string; path: string; present: string[]; want: string }> = [
    { name: 'bare agy pinned to where it resolves', command: 'agy acp', path: '/cli:/ide', present: ['/cli/agy', '/ide/agy'], want: '/cli/agy acp' },
    { name: 'path with a space is quoted', command: 'agy acp --x', path: '/My Tools', present: ['/My Tools/agy'], want: '"/My Tools/agy" acp --x' },
    { name: 'already a full path', command: '/cli/agy acp', path: '/ide', present: ['/ide/agy'], want: '/cli/agy acp' },
    { name: 'unshadowed agent untouched', command: 'qwen --acp', path: '/a', present: ['/a/qwen'], want: 'qwen --acp' },
    { name: 'agy not on PATH', command: 'agy acp', path: '/a', present: [], want: 'agy acp' },
  ];
  it.each(cases)('$name', ({ command, path: pathEnv, present, want }) => {
    expect(pinShadowedBin(command, pathEnv, (f) => present.includes(f))).toBe(want);
  });
});

describe('resolveBin', () => {
  const cases: Array<{ name: string; bin: string; path: string | undefined; present: string[]; want: string | undefined }> = [
    { name: 'first match on PATH', bin: 'agy', path: '/ide:/cli', present: ['/ide/agy', '/cli/agy'], want: '/ide/agy' },
    { name: 'not on PATH', bin: 'agy', path: '/a', present: [], want: undefined },
    { name: 'a path is returned as is', bin: '/cli/agy', path: '/ide', present: [], want: '/cli/agy' },
    { name: 'undefined PATH', bin: 'agy', path: undefined, present: ['/a/agy'], want: undefined },
  ];
  it.each(cases)('$name', ({ bin, path: pathEnv, present, want }) => {
    expect(resolveBin(bin, pathEnv, (f) => present.includes(f))).toBe(want);
  });
});

describe('chooseAgent', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  const two = [byBin('dsh'), byBin('qwen')];
  const cases: Array<{ name: string; found: typeof two; answer?: string; noTty?: boolean; want: string | undefined }> = [
    { name: 'none found', found: [], want: undefined },
    { name: 'one found, no question asked', found: [byBin('qwen')], want: 'qwen --acp' },
    { name: 'pick the second', found: two, answer: '2', want: 'qwen --acp' },
    { name: 'answer with whitespace', found: two, answer: ' 1 \n', want: 'dsh acp' },
    { name: 'out of range', found: two, answer: '3', want: undefined },
    { name: 'zero', found: two, answer: '0', want: undefined },
    { name: 'not a number', found: two, answer: 'qwen', want: undefined },
    { name: 'blank', found: two, answer: '', want: undefined },
    { name: 'several, no terminal', found: two, noTty: true, want: undefined },
  ];
  it.each(cases)('$name', async ({ found, answer, noTty, want }) => {
    const ask = jest.fn(async () => answer ?? '');
    expect(await chooseAgent(found, noTty ? undefined : ask)).toBe(want);
    if (found.length < 2) expect(ask).not.toHaveBeenCalled();
  });
});

describe('agentTypeFor', () => {
  const cases: Array<{ name: string; command: string; want: string }> = [
    { name: 'known command', command: 'qwen --acp', want: 'qwen_code' },
    { name: 'known bin by full path', command: '/opt/bin/dsh acp', want: 'deepseek_harness' },
    { name: 'quoted path with a space', command: '"/My Tools/droid" exec --output-format acp', want: 'factory_droid' },
    { name: 'extra flags', command: 'qwen --acp -m qwen/qwen3-coder', want: 'qwen_code' },
    { name: 'unknown agent', command: 'my-agent --acp', want: GENERIC_AGENT_TYPE },
    { name: 'prefix of a known bin', command: 'qwen-code --acp', want: GENERIC_AGENT_TYPE },
    { name: 'empty', command: '', want: GENERIC_AGENT_TYPE },
    { name: 'unterminated quote', command: '"qwen --acp', want: GENERIC_AGENT_TYPE },
    { name: 'Antigravity CLI by full path', command: '/Users/me/.local/bin/agy acp', want: 'antigravity' },
  ];
  it.each(cases)('$name', ({ command, want }) => {
    expect(agentTypeFor(command)).toBe(want);
  });

  it('gives every known agent its own type', () => {
    const types = KNOWN_AGENTS.map((a) => a.agentType);
    expect(new Set(types).size).toBe(KNOWN_AGENTS.length);
    expect(types).not.toContain(GENERIC_AGENT_TYPE);
    for (const agent of KNOWN_AGENTS) expect(agentTypeFor(agent.command)).toBe(agent.agentType);
  });
});

describe('isDifferentAgent', () => {
  const cases: Array<{ name: string; existing: string; command: string; want: boolean }> = [
    { name: 'same agent, new flags', existing: 'qwen --acp', command: 'qwen --acp -m x', want: false },
    { name: 'same agent by full path', existing: 'qwen --acp', command: '/opt/bin/qwen --acp', want: false },
    { name: 'another known agent', existing: 'qwen --acp', command: 'dsh acp', want: true },
    { name: 'known to unknown', existing: 'qwen --acp', command: 'my-agent --acp', want: true },
    { name: 'unknown to another unknown', existing: 'my-agent --acp', command: 'other-agent --acp', want: true },
    { name: 'unparseable new command', existing: 'qwen --acp', command: '"qwen', want: true },
  ];
  it.each(cases)('$name', ({ existing, command, want }) => {
    expect(isDifferentAgent({ agentCommand: existing }, command)).toBe(want);
  });
});
