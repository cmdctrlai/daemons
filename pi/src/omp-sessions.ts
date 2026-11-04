/**
 * Read-only access to omp's session files.
 *
 * omp lays sessions out as pi does – `<root>/<encoded-cwd>/<timestamp>_<id>.jsonl`,
 * a header then `message` entries with `toolCall` blocks – but every current file
 * starts with a fixed-width `type: "title"` slot ahead of the header. pi's
 * SessionManager treats a file whose first line is not the header as corrupt, and
 * on open truncates it to a fresh empty session, so an omp file must never reach
 * it. omp's rpc docs name this reader as the supported way in: a permissive client
 * that consumes the common subset, `id`/`parentId` plus message entries.
 */

import { open, readdir, readFile, stat } from 'fs/promises';
import { dirname, join } from 'path';
import type { StoredEntry, StoredSession } from './session-source';

interface ParsedSession {
  id: string;
  cwd: string;
  timestamp?: string;
  title?: string;
  continuationOf?: string;
  entries: StoredEntry[];
}

/** Parse one session file's contents. Returns null if it has no session header. */
export function parseOmpSession(content: string): ParsedSession | null {
  let header: { id: string; cwd?: unknown; timestamp?: unknown; title?: unknown; continuationOf?: unknown } | undefined;
  let slotTitle: string | undefined;
  const entries: StoredEntry[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; } // a line omp is still appending
    if (!entry || typeof entry !== 'object') continue;

    if (entry.type === 'title') {
      slotTitle = typeof entry.title === 'string' ? entry.title.trim() : undefined;
    } else if (entry.type === 'session') {
      if (!header && typeof entry.id === 'string') header = entry;
    } else if (typeof entry.id === 'string') {
      entries.push(entry);
    }
  }

  if (!header) return null;
  const headerTitle = typeof header.title === 'string' ? header.title.trim() : '';
  return {
    id: header.id,
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    timestamp: typeof header.timestamp === 'string' ? header.timestamp : undefined,
    title: slotTitle || headerTitle || undefined,
    continuationOf: typeof header.continuationOf === 'string' ? header.continuationOf : undefined,
    entries,
  };
}

/** Entries of one session file, in file order. Throws if it is not a session. */
export async function readOmpEntries(path: string): Promise<StoredEntry[]> {
  const parsed = parseOmpSession(await readFile(path, 'utf-8'));
  if (!parsed) throw new Error(`${path} has no omp session header`);
  return parsed.entries;
}

/**
 * Every session under `root` as CmdCtrl shows it, newest first (see
 * `foldContinuations`). A missing root is an empty list.
 */
export async function listOmpSessions(root: string): Promise<StoredSession[]> {
  let buckets: string[];
  try {
    buckets = (await readdir(root, { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => join(root, d.name));
  } catch {
    return [];
  }

  const files = (await Promise.all(buckets.map(async dir => {
    try {
      return (await readdir(dir)).filter(f => f.endsWith('.jsonl')).map(f => join(dir, f));
    } catch {
      return [];
    }
  }))).flat().sort();

  const scanned = await Promise.all(files.map(summarise));
  return foldContinuations(scanned.filter((f): f is OmpSessionFile => f !== null));
}

/** One session file as `foldContinuations` sees it. */
export interface OmpSessionFile {
  session: StoredSession;
  continuationOf?: string;
  /** Every entry id the file holds. */
  entryIds: Set<string>;
  /** User turns with text, in order: what a copy that went its own way is previewed by. */
  userTurns: Array<{ id: string; text: string }>;
  /** omp's newest turn: the last conversation entry, and when it was written. */
  newestTurn?: string;
  activity: number;
  /** Bytes read, so a reader can tell whether the file has grown since. */
  size: number;
}

/** The entries that move a conversation, as omp counts them; anything else can land long after. */
const TURN_TYPES = new Set(['message', 'custom_message', 'branch_summary', 'reset_boundary']);
const EVAL_STATE_CONTEXT_TYPE = 'eval-state-context';

async function summarise(path: string): Promise<OmpSessionFile | null> {
  let parsed: ParsedSession | null;
  let mtime: Date;
  let size: number;
  try {
    const content = await readFile(path, 'utf-8');
    size = Buffer.byteLength(content);
    parsed = parseOmpSession(content);
    mtime = (await stat(path)).mtime;
  } catch {
    return null;
  }
  if (!parsed) return null;

  // Same rules as pi's own listing: every message counts, the preview is the
  // first user text, and activity is the last user or assistant message.
  let messageCount = 0;
  let firstMessage = '';
  let lastActivity = 0;
  const headerTime = parsed.timestamp ? Date.parse(parsed.timestamp) : NaN;
  let newestTurn: string | undefined;
  let activity = Number.isNaN(headerTime) ? Number.NEGATIVE_INFINITY : headerTime;
  const userTurns: Array<{ id: string; text: string }> = [];
  for (const entry of parsed.entries) {
    const raw: any = entry;
    const customType = entry.type === 'custom_message' ? raw.customType : raw.message?.customType;
    const at = Date.parse(entry.timestamp);
    if (TURN_TYPES.has(entry.type) && customType !== EVAL_STATE_CONTEXT_TYPE && Number.isFinite(at)) {
      newestTurn = entry.id;
      activity = at;
    }

    if (entry.type !== 'message') continue;
    messageCount++;
    const msg: any = entry.message;
    if (msg?.role !== 'user' && msg?.role !== 'assistant') continue;
    const text = textOf(msg.content);
    if (!text) continue;
    if (msg.role === 'user') userTurns.push({ id: entry.id, text });
    if (!firstMessage && msg.role === 'user') firstMessage = text;
    const sent = typeof msg.timestamp === 'number' ? msg.timestamp : at;
    if (!Number.isNaN(sent)) lastActivity = Math.max(lastActivity, sent);
  }

  const modified = lastActivity > 0 ? new Date(lastActivity)
    : !Number.isNaN(headerTime) ? new Date(headerTime) : mtime;

  return {
    session: {
      id: parsed.id,
      path,
      cwd: parsed.cwd,
      name: parsed.title,
      firstMessage: firstMessage || '(no messages)',
      modified,
      messageCount,
    },
    continuationOf: parsed.continuationOf,
    entryIds: new Set(parsed.entries.map(e => e.id)),
    userTurns,
    newestTurn,
    activity,
    size,
  };
}

/**
 * When another omp process holds a session open for writing – a terminal left
 * open on it – omp writes the next turn to a sibling whose header says
 * `continuationOf: <id>`, copying the transcript over. Each session id is shown
 * at the copy omp itself resumes for it (omp's `findSessionContinuation`): a link
 * is followed only while the copy holds the newest turn of the copy it continues,
 * and of the copies reached the one with the newest turn wins, ties to the one
 * asked for. When the original went on after the move (its terminal kept
 * writing), the two have diverged: the original stays under its own id and the
 * continuation is shown as a session of its own, so no turn is hidden.
 */
export function foldContinuations(files: OmpSessionFile[]): StoredSession[] {
  const index = continuationIndex(files);
  const byId = new Map(files.map(f => [f.session.id, f]));
  const holdsAllOf = (target: OmpSessionFile, copy: OmpSessionFile) =>
    copy.newestTurn === undefined || target.entryIds.has(copy.newestTurn);

  const shown: StoredSession[] = [];
  const done = new Set<OmpSessionFile>();
  const queue = files.filter(f => {
    const from = f.continuationOf ? byId.get(f.continuationOf) : undefined;
    return !from || !index.follows(f, from);
  });
  while (queue.length) {
    const start = queue.shift()!;
    if (done.has(start)) continue;
    done.add(start);
    const { target, copies } = resumeCopies(start, index);

    // A copy the resumed one does not contain went its own way: it gets its own entry.
    for (const copy of copies.slice(1)) {
      if (holdsAllOf(target, copy)) done.add(copy);
      else queue.push(copy);
    }
    // A continuation on its own reads by its own first turn, or it would read
    // exactly like the session it left – omp carries that session's title over.
    const from = start.continuationOf ? byId.get(start.continuationOf) : undefined;
    const firstOwnTurn = from && start.userTurns.find(t => !from.entryIds.has(t.id));
    const name = target.session.name ?? start.session.name;
    const carried = from !== undefined && name !== undefined && name === from.session.name;
    shown.push({
      ...start.session,
      path: target.session.path,
      name: carried ? undefined : name,
      firstMessage: firstOwnTurn?.text ?? start.session.firstMessage,
      modified: target.session.modified,
      messageCount: target.session.messageCount,
    });
  }
  return shown.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

interface ContinuationIndex {
  children: Map<string, OmpSessionFile[]>;
  /** omp follows a link only within one directory, and only while the copy holds the newest turn it continues. */
  follows(copy: OmpSessionFile, from: OmpSessionFile): boolean;
}

function continuationIndex(files: OmpSessionFile[]): ContinuationIndex {
  const children = new Map<string, OmpSessionFile[]>();
  for (const f of files) {
    if (!f.continuationOf) continue;
    children.set(f.continuationOf, [...(children.get(f.continuationOf) ?? []), f]);
  }
  return {
    children,
    follows: (copy, from) =>
      dirname(copy.session.path) === dirname(from.session.path) &&
      (from.newestTurn === undefined || copy.entryIds.has(from.newestTurn)),
  };
}

/** The copies omp follows from `start`, and the one it resumes: the newest turn, ties to `start`. */
function resumeCopies(start: OmpSessionFile, index: ContinuationIndex): { target: OmpSessionFile; copies: OmpSessionFile[] } {
  const copies = [start];
  for (let i = 0; i < copies.length; i++) {
    for (const copy of index.children.get(copies[i].session.id) ?? []) {
      if (!copies.includes(copy) && index.follows(copy, copies[i])) copies.push(copy);
    }
  }
  let target = start;
  for (const copy of copies) if (copy.activity > target.activity) target = copy;
  return { target, copies };
}

/** How far into a file to look for its header: the 256-byte title slot, then the header line. */
const HEADER_BYTES = 64 * 1024;

async function readHeader(path: string): Promise<{ id: string; continuationOf?: string } | null> {
  let head: string;
  try {
    const handle = await open(path, 'r');
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEADER_BYTES), 0, HEADER_BYTES, 0);
      head = buffer.subarray(0, bytesRead).toString('utf-8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  for (const line of head.split('\n')) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'session' || typeof entry.id !== 'string') continue;
    return { id: entry.id, continuationOf: typeof entry.continuationOf === 'string' ? entry.continuationOf : undefined };
  }
  return null;
}

/**
 * Where session `id` in `dir` currently reads from – the copy omp resumes, by the
 * same rule as the listing – and its copies with the sizes they were read at, so
 * any growth since can be noticed. Reads every header in the directory but only
 * the session's own copies in full, so a busy project directory stays cheap.
 */
export async function locateOmpSession(
  id: string,
  dir: string,
): Promise<{ path: string; copies: Array<{ path: string; size: number }> } | undefined> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter(f => f.endsWith('.jsonl')).sort();
  } catch {
    return undefined;
  }
  const headers = (await Promise.all(names.map(async name => {
    const path = join(dir, name);
    const header = await readHeader(path);
    return header && { ...header, path };
  }))).filter((h): h is { id: string; continuationOf?: string; path: string } => h !== null);

  const related = headers.filter(h => h.id === id);
  for (let i = 0; i < related.length; i++) {
    for (const h of headers) {
      if (h.continuationOf === related[i].id && !related.includes(h)) related.push(h);
    }
  }
  const files = (await Promise.all(related.map(h => summarise(h.path)))).filter((f): f is OmpSessionFile => f !== null);
  const start = files.find(f => f.session.id === id);
  if (!start) return undefined;
  const { target, copies } = resumeCopies(start, continuationIndex(files));
  return { path: target.session.path, copies: copies.map(c => ({ path: c.session.path, size: c.size })) };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join(' ');
}
