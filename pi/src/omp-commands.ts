/**
 * Where omp reads a markdown slash command's template, in omp's own order.
 *
 * omp's command catalog names a command but gives no path, so the daemon looks
 * where omp 18's filesystem providers do (`src/discovery/*.ts`), by provider
 * priority – the first match wins, as in omp's capability registry:
 *
 * | Provider | Priority | Where |
 * |---|---|---|
 * | native | 100 | `<cwd>/.omp/commands/<name>.md` (not when cwd is home), then `<agent dir>/commands/<name>.md` |
 * | claude | 80 | `$CLAUDE_CONFIG_DIR/commands` when set (that opts the user dir in), then `<cwd>/.claude/commands`; both recursive, a nested file answering to its basename and to `dir:name` |
 * | agents | 70 | `.agent/commands` and `.agents/commands` at each ancestor from cwd up to the git root (home skipped), then in home |
 * | codex | 70 | `<cwd>/.codex/commands`, where frontmatter `name` renames a file |
 * | opencode | 55 | `<cwd>/.opencode/commands`, likewise |
 *
 * Not covered, so such a command keeps reading back as its expansion: omp plugin
 * and Claude marketplace commands, and the user-level claude/codex/opencode
 * directories omp reads only when its own settings opt them in.
 */

import { readdir, readFile } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import { ompAgentDir } from './agent-flavor';

interface Frontmatter {
  name?: string;
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function parse(contents: string): Frontmatter {
  const block = FRONTMATTER.exec(contents);
  if (!block) return { body: contents };
  const name = /^name:[ \t]*["']?(.*?)["']?[ \t]*$/m.exec(block[1])?.[1];
  return { ...(name ? { name } : {}), body: contents.slice(block[0].length) };
}

async function read(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
}

/** Visible entries, in a stable order. */
async function list(dir: string): Promise<Array<{ name: string; dir: boolean }>> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(e => !e.name.startsWith('.'))
      .map(e => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** A command named after its file. */
async function byFileName(dir: string, name: string): Promise<string | undefined> {
  const contents = await read(join(dir, `${name}.md`));
  return contents === undefined ? undefined : parse(contents).body;
}

/** Claude's layout: recursive, a nested file answering to its basename and to `dir:name`. */
async function claude(dir: string, name: string): Promise<string | undefined> {
  if (name.includes(':')) {
    const segments = name.split(':');
    if (segments.some(s => !s || s === '.' || s === '..')) return undefined;
    return byFileName(join(dir, ...segments.slice(0, -1)), segments[segments.length - 1]);
  }
  const root = await byFileName(dir, name);
  if (root !== undefined) return root;
  const nested = async (current: string): Promise<string | undefined> => {
    for (const entry of await list(current)) {
      if (!entry.dir) continue;
      const found = (await byFileName(join(current, entry.name), name)) ?? (await nested(join(current, entry.name)));
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return nested(dir);
}

/** codex and opencode: frontmatter `name` overrides the file name. */
async function byDeclaredName(dir: string, name: string): Promise<string | undefined> {
  for (const entry of await list(dir)) {
    if (entry.dir || !entry.name.endsWith('.md')) continue;
    const contents = await read(join(dir, entry.name));
    if (contents === undefined) continue;
    const { name: declared, body } = parse(contents);
    if ((declared || basename(entry.name, '.md')) === name) return body;
  }
  return undefined;
}

/** omp's project walk-up: cwd to the nearest ancestor holding `.git`, else to home. */
async function agentsDirs(cwd: string, home: string): Promise<string[]> {
  let stop = home;
  for (let dir = cwd; ; dir = dirname(dir)) {
    try {
      if ((await readdir(dir)).includes('.git')) { stop = dir; break; }
    } catch { /* unreadable; keep walking */ }
    if (dirname(dir) === dir) break;
  }
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (dir !== home) dirs.push(join(dir, '.agent', 'commands'), join(dir, '.agents', 'commands'));
    if (dir === stop || dirname(dir) === dir) break;
  }
  dirs.push(join(home, '.agent', 'commands'), join(home, '.agents', 'commands'));
  return dirs;
}

/** The template omp expands for `/name` run in `cwd`, without its frontmatter. */
export async function findOmpTemplate(
  cwd: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME || homedir(),
): Promise<string | undefined> {
  if (!name || /[\\/]/.test(name) || name === '.' || name === '..') return undefined;
  const fileName = name.includes(':') ? undefined : name;

  const lookups: Array<() => Promise<string | undefined>> = [
    async () => (fileName && cwd !== home ? byFileName(join(cwd, '.omp', 'commands'), fileName) : undefined),
    async () => (fileName ? byFileName(join(ompAgentDir(env, home), 'commands'), fileName) : undefined),
    async () => (env.CLAUDE_CONFIG_DIR ? claude(join(env.CLAUDE_CONFIG_DIR, 'commands'), name) : undefined),
    () => claude(join(cwd, '.claude', 'commands'), name),
    async () => {
      if (!fileName) return undefined;
      for (const dir of await agentsDirs(cwd, home)) {
        const found = await byFileName(dir, fileName);
        if (found !== undefined) return found;
      }
      return undefined;
    },
    () => byDeclaredName(join(cwd, '.codex', 'commands'), name),
    () => byDeclaredName(join(cwd, '.opencode', 'commands'), name),
  ];
  for (const lookup of lookups) {
    const found = await lookup();
    if (found !== undefined) return found;
  }
  return undefined;
}
