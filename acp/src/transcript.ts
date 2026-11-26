/**
 * What the app shows for each session: the conversation as this daemon saw it.
 *
 * ACP has no call that reads a session's history back except `session/load`,
 * which replays it – and only some agents offer that. For the rest, the stream
 * the daemon relayed while the session ran is the only record it can serve, so it
 * keeps one per session on disk to survive restarts. When the agent can replay a
 * session, the replay replaces the record: the agent's own history wins.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MessageEntry } from '@cmdctrl/daemon-sdk';

/** A message's `question` field: the shape the app renders as tappable options. */
export interface QuestionCard {
  question: string;
  header?: string;
  multi_select?: boolean;
  options: Array<{ label: string; description?: string }>;
}

/** An app message, which may carry a question card. */
export type Entry = MessageEntry & { question?: QuestionCard };

/** What a closed card says under its question. */
export const CLOSED_NOTE = '_No longer waiting for an answer._';

export interface SessionRecord {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt: string;
  entries: Entry[];
  /**
   * The choices on the last card that stopped waiting unanswered. A tap on one is
   * late, from a screen that still shows the card, and is not a prompt. Kept here
   * rather than on the card, which a read-back from the agent drops.
   */
  lateChoices?: string[];
}

export interface Page {
  messages: Entry[];
  hasMore: boolean;
  oldestUuid?: string;
  newestUuid?: string;
}

/** The first prompt, shortened, stands in for a title an agent never sent. */
const TITLE_CHARS = 80;

export class TranscriptStore {
  private records: Map<string, SessionRecord> | null = null;

  constructor(private readonly dir: string) {}

  get(sessionId: string): SessionRecord | undefined {
    return this.all().get(sessionId);
  }

  /** The session's record, created empty if this is the first the daemon has seen of it. */
  ensure(sessionId: string, cwd: string): SessionRecord {
    const records = this.all();
    let record = records.get(sessionId);
    if (!record) {
      record = { sessionId, cwd, updatedAt: new Date().toISOString(), entries: [] };
      records.set(sessionId, record);
    }
    return record;
  }

  append(sessionId: string, cwd: string, entry: Entry): void {
    const record = this.ensure(sessionId, cwd);
    record.entries.push(entry);
    record.updatedAt = entry.timestamp;
    this.save(record);
  }

  /**
   * The agent's replay of a session becomes its history, exactly: the agent is
   * the system of record. A message the daemon already showed keeps the id and
   * time it had, so an app with it on screen sees the same message, not a copy.
   */
  applyReplay(sessionId: string, cwd: string, entries: Entry[]): void {
    const record = this.ensure(sessionId, cwd);
    record.entries = withKnownIds(record.entries, entries);
    if (record.entries.length) record.updatedAt = record.entries[record.entries.length - 1].timestamp;
    this.save(record);
  }

  setTitle(sessionId: string, cwd: string, title: string): void {
    const record = this.ensure(sessionId, cwd);
    if (record.title === title) return;
    record.title = title;
    this.save(record);
  }

  /** Close a card nobody will answer now. */
  closeCard(sessionId: string, uuid: string): void {
    const record = this.get(sessionId);
    const entry = record?.entries.find((e) => e.uuid === uuid);
    if (!record || !entry?.question) return;
    close(record, entry);
    this.save(record);
  }

  /** Close every card no reply followed. Run before any turn starts. */
  closeUnansweredCards(): void {
    for (const record of this.list()) {
      let changed = false;
      record.entries.forEach((entry, i) => {
        if (entry.question && !record.entries.slice(i + 1).some((e) => e.role === 'USER')) {
          close(record, entry);
          changed = true;
        }
      });
      if (changed) this.save(record);
    }
  }

  /** The choices of the last card that stopped waiting unanswered, until the user sends something else. */
  closedChoices(sessionId: string): string[] | undefined {
    return this.get(sessionId)?.lateChoices;
  }

  /** The user has moved on from the last closed card. */
  forgetClosedChoices(sessionId: string): void {
    const record = this.get(sessionId);
    if (!record?.lateChoices) return;
    delete record.lateChoices;
    this.save(record);
  }

  list(): SessionRecord[] {
    return [...this.all().values()];
  }

  /**
   * One page of a session, oldest first. Without a cursor it is the newest
   * `limit` entries; `beforeUuid` pages back from an entry, `afterUuid` returns
   * what came after one. A cursor the record doesn't hold is ignored.
   */
  page(sessionId: string, limit: number, beforeUuid?: string, afterUuid?: string): Page {
    let entries = this.get(sessionId)?.entries ?? [];
    if (beforeUuid) {
      const idx = entries.findIndex((e) => e.uuid === beforeUuid);
      if (idx >= 0) entries = entries.slice(0, idx);
    }
    if (afterUuid) {
      const idx = entries.findIndex((e) => e.uuid === afterUuid);
      if (idx >= 0) entries = entries.slice(idx + 1);
    }
    const count = Math.max(0, limit);
    const messages = count ? entries.slice(-count) : [];
    return {
      messages,
      hasMore: entries.length > messages.length,
      oldestUuid: messages[0]?.uuid,
      newestUuid: messages[messages.length - 1]?.uuid,
    };
  }

  /** A title for the session list: the agent's own, else the first prompt. */
  static titleOf(record: SessionRecord): string {
    if (record.title) return record.title;
    const first = record.entries.find((e) => e.role === 'USER')?.content.trim() ?? '';
    const line = first.split('\n')[0];
    return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
  }

  private all(): Map<string, SessionRecord> {
    if (this.records) return this.records;
    this.records = new Map();
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return this.records;
    }
    for (const file of files) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf-8')) as SessionRecord;
        if (record?.sessionId && Array.isArray(record.entries)) this.records.set(record.sessionId, record);
      } catch {
        // A torn or foreign file is skipped rather than taking the session list down.
      }
    }
    return this.records;
  }

  private save(record: SessionRecord): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, `${encodeURIComponent(record.sessionId)}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

function close(record: SessionRecord, entry: Entry): void {
  record.lateChoices = entry.question!.options.map((o) => o.label);
  entry.content = `${entry.content}\n\n${CLOSED_NOTE}`;
  delete entry.question;
}

/**
 * The replay as the agent gave it, each message the daemon showed taking the id
 * and time it was shown with. Prompts pair by their words. A turn is what follows
 * a paired prompt; in it a reply pairs by its words, or else by its place among
 * the replies left: an agent may save less than it streamed, such as a status
 * line run into the reply. Nothing else of the record carries over.
 */
function withKnownIds(recorded: Entry[], replay: Entry[]): Entry[] {
  const out = replay.slice();
  const keep = (theirs: number, mine: Entry) => {
    out[theirs] = { ...replay[theirs], uuid: mine.uuid, timestamp: mine.timestamp };
  };
  // Each turn's opening prompt, as [replay index, record index]; the first turn opens before any.
  const opens: Array<[number, number]> = [[-1, -1]];
  let next = 0;
  replay.forEach((entry, t) => {
    if (entry.role !== 'USER') return;
    const m = recorded.findIndex((e, i) => i >= next && sameWords(e, entry));
    if (m < 0) return;
    keep(t, recorded[m]);
    opens.push([t, m]);
    next = m + 1;
  });
  const firstPrompt = recorded.findIndex((e) => e.role === 'USER');
  opens.forEach(([t, m], k) => {
    // The record's turn runs to its next paired prompt, past card answers the agent
    // never saw as prompts; the replay's ends at any prompt, which another reply answers.
    // What comes before every prompt is a turn of its own on both sides.
    const end = k === 0 && firstPrompt >= 0 ? firstPrompt : opens[k + 1]?.[1] ?? recorded.length;
    const mine = recorded.slice(m + 1, end).filter((e) => e.role === 'AGENT' && !isCard(e));
    const theirs: number[] = [];
    for (let i = t + 1; i < replay.length && replay[i].role === 'AGENT'; i++) theirs.push(i);
    const replies = theirs.map((at) => replay[at]);
    for (const [reply, shown] of pairReplies(mine, replies)) keep(theirs[reply], mine[shown]);
  });
  return out;
}

/**
 * Replies of one turn paired, as [their index, my index]: by words first, in
 * order, then each left over by its place between the pairs found.
 */
export function pairReplies(mine: Entry[], theirs: Entry[]): Array<[number, number]> {
  const byWords = new Map<number, number>();
  let next = 0;
  theirs.forEach((entry, t) => {
    const m = mine.findIndex((e, i) => i >= next && sameWords(e, entry));
    if (m < 0) return;
    byWords.set(t, m);
    next = m + 1;
  });
  // The first of mine past each of theirs paired by words: the place a leftover may not reach.
  const bound: number[] = [];
  let limit = mine.length;
  for (let t = theirs.length - 1; t >= 0; t--) {
    limit = byWords.get(t) ?? limit;
    bound[t] = limit;
  }
  const pairs: Array<[number, number]> = [];
  let m = 0;
  theirs.forEach((_, t) => {
    const paired = byWords.get(t);
    if (paired !== undefined) {
      pairs.push([t, paired]);
      m = paired + 1;
    } else if (m < bound[t]) {
      pairs.push([t, m++]);
    }
  });
  return pairs;
}

function sameWords(a: Entry, b: Entry): boolean {
  return a.role === b.role && a.content.trim() === b.content.trim();
}

/** A permission card, open or closed: the daemon's own, never in an agent's replay. */
function isCard(entry: Entry): boolean {
  return !!entry.question || entry.content.endsWith(CLOSED_NOTE);
}
