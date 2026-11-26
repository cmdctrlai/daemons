/**
 * Reading opencode v2's stored messages: what the app shows for a session, and
 * where its turn stands. v2 keeps a session as flat, typed messages – a turn is a
 * user message, one assistant message per step, and an `idle` message that ends
 * it – so these are pure functions over `GET /api/session/{id}/message`.
 */
import type { DiffFile, DiffTurn } from '@cmdctrl/daemon-sdk';
import { clipPatch, questionId, STOPPED, toCard, type Entry, type QuestionInfo, type TurnState } from '../adapter/transcript';

export interface V2Error {
  type?: string;
  message?: string;
}

export interface V2Content {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  state?: {
    status: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  };
}

export interface V2Message {
  id: string;
  type: string;
  time: { created: number; completed?: number };
  /** user, synthetic, system, skill */
  text?: string;
  /** user: the skills the prompt ran, as `/name` in the app */
  skills?: Array<{ id: string }>;
  /** assistant */
  content?: V2Content[];
  finish?: string;
  error?: V2Error;
  snapshot?: { start?: string; end?: string; files?: string[] };
  /** idle */
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  /** compaction: running, completed, failed; shell: running, exited, timeout, killed */
  status?: string;
  reason?: 'auto' | 'manual';
  summary?: string;
  /** shell: a command the user ran with `!` */
  command?: string;
  output?: { output?: string };
}

/** How long a turn the transcript shows as unfinished still counts as running. */
const STALE_TURN_MS = 10 * 60 * 1000;
/** A prompt with no reply yet counts as running for this long. */
const UNANSWERED_PROMPT_MS = 2 * 60 * 1000;
const PREVIEW_CHARS = 200;
const DIFF_PROMPT_CHARS = 200;
/** Messages that are bookkeeping, not part of a turn: a model or agent switch. */
const BOOKKEEPING = new Set(['agent-switched', 'model-switched', 'location-switched']);

/** An assistant message's text, without reasoning or tool output. */
export function assistantText(message: V2Message): string {
  return (message.content ?? [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!)
    .join('\n');
}

/** The error a turn or step ended on, as the user should read it. */
export function errorMessage(error?: V2Error): string | undefined {
  if (!error) return undefined;
  return error.message || error.type || 'opencode reported an error';
}

/**
 * The conversation as the app shows it. `commandFor` names the command a user
 * message was expanded from – v2 stores only the expansion – when it is known.
 */
export function toEntries(messages: V2Message[], commandFor: (id: string) => string | undefined = () => undefined): Entry[] {
  const entries: Entry[] = [];
  for (const m of messages) {
    const timestamp = new Date(m.time.created).toISOString();
    switch (m.type) {
      case 'user': {
        const content = commandFor(m.id) ?? withSkill(m);
        if (content) entries.push({ uuid: m.id, role: 'USER', content, timestamp });
        break;
      }
      case 'shell':
        entries.push({ uuid: m.id, role: 'USER', content: `!${m.command ?? ''}`, timestamp });
        if (m.output?.output) entries.push({ uuid: `${m.id}:output`, role: 'AGENT', content: m.output.output, timestamp });
        break;
      case 'compaction':
        if (m.reason === 'manual') entries.push({ uuid: m.id, role: 'USER', content: '/compact', timestamp });
        if (m.status === 'completed' && m.summary) {
          entries.push({ uuid: `${m.id}:summary`, role: 'AGENT', content: m.summary, timestamp });
        }
        break;
      case 'assistant':
        pushAssistant(entries, m, timestamp);
        break;
    }
  }
  return entries;
}

/** A prompt that ran a skill reads as the `/skill args` the user typed. */
function withSkill(m: V2Message): string {
  const skill = m.skills?.[0]?.id;
  if (!skill) return m.text ?? '';
  return m.text ? `/${skill} ${m.text}` : `/${skill}`;
}

function pushAssistant(entries: Entry[], m: V2Message, timestamp: string): void {
  const text = assistantText(m);
  if (text) entries.push({ uuid: m.id, role: 'AGENT', content: text, timestamp });
  if (m.error?.type === 'aborted') entries.push({ uuid: `${m.id}:stopped`, role: 'AGENT', content: STOPPED, timestamp });
  // An answered question reads as the question with its options, then the answer.
  for (const c of m.content ?? []) {
    if (c.type !== 'tool' || c.name !== 'question' || c.state?.status !== 'completed') continue;
    const questions = ((c.state.input as { questions?: QuestionInfo[] } | undefined)?.questions ?? []);
    const answers = (c.state.metadata?.answers ?? []) as string[][];
    questions.forEach((q, i) => {
      entries.push({ uuid: questionId(c.id ?? '', i), role: 'AGENT', content: q.question, timestamp, question: toCard(q) });
      const answer = (answers[i] ?? []).join(', ');
      if (answer) entries.push({ uuid: `${c.id}:${i}:a`, role: 'USER', content: answer, timestamp });
    });
  }
}

/**
 * Where a session's newest turn stands, from the transcript alone – a turn may
 * run in another opencode process, the user's own terminal, whose events this
 * daemon never sees. Every turn v2 runs ends with an `idle` message.
 * `updatedAt` is when opencode last touched the session.
 */
export function turnState(messages: V2Message[], updatedAt: number, now = Date.now()): TurnState {
  const entries = toEntries(messages);
  let preview = '';
  for (let i = entries.length - 1; i >= 0 && !preview; i--) {
    if (!entries[i].question) preview = entries[i].content;
  }
  preview = preview.slice(0, PREVIEW_CHARS);

  // A `!` command belongs to no turn – v2 files one mid-turn too – so it decides where
  // the session stands only when no turn is open.
  let last: V2Message | undefined;
  let shell: V2Message | undefined;
  for (const m of messages) {
    if (BOOKKEEPING.has(m.type)) continue;
    if (m.type === 'shell') shell = m;
    else [last, shell] = [m, undefined];
  }
  if (shell && (!last || last.type === 'idle' || abortedStep(last))) {
    return shell.status === 'running'
      ? { finished: false, running: now - updatedAt < STALE_TURN_MS, preview }
      : { finished: true, stopped: false, running: false, finalId: shell.id, preview };
  }
  if (!last) return { finished: false, running: false, preview };
  if (last.type === 'idle') {
    const stopped = last.outcome === 'interrupted';
    const error = last.outcome === 'failed' ? errorMessage(last.error) ?? 'opencode reported an error' : undefined;
    return { finished: true, stopped, running: false, finalId: last.id, error, preview };
  }
  if (last.type === 'user') {
    return { finished: false, running: now - last.time.created < UNANSWERED_PROMPT_MS, preview };
  }
  return { finished: false, running: now - updatedAt < STALE_TURN_MS, preview };
}

/**
 * A step cut off and closed. Its turn is over even with no `idle` after it – v2 files
 * none when a shutdown interrupts the turn.
 */
function abortedStep(m: V2Message): boolean {
  return m.type === 'assistant' && m.error?.type === 'aborted' && !!m.time.completed;
}

/** The final text of the newest turn, or the error it ended on. Messages oldest first. */
export function turnResult(messages: V2Message[]): { text: string; error?: string } {
  let error: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === 'idle') {
      if (i !== messages.length - 1) break;
      if (m.outcome === 'failed') error = errorMessage(m.error) ?? 'opencode reported an error';
      continue;
    }
    if (m.type === 'assistant') return { text: assistantText(m), error };
    if (m.type === 'compaction' && m.status === 'failed') return { text: '', error: errorMessage(m.error) };
    if (m.type === 'user' || m.type === 'compaction') break;
  }
  return { text: '', error };
}

/**
 * The turns that changed files, newest first: each user message whose steps
 * recorded a change. v2 diffs a turn on request, by its user message.
 */
export function changedTurns(
  messages: V2Message[],
  commandFor: (id: string) => string | undefined = () => undefined,
): Array<{ id: string; prompt: string; timestamp: string }> {
  const turns: Array<{ id: string; prompt: string; timestamp: string; changed: boolean }> = [];
  for (const m of messages) {
    if (m.type === 'user') {
      const prompt = (commandFor(m.id) ?? withSkill(m)).slice(0, DIFF_PROMPT_CHARS);
      turns.push({ id: m.id, prompt, timestamp: new Date(m.time.created).toISOString(), changed: false });
    } else if (m.type === 'assistant' && turns.length) {
      const s = m.snapshot;
      if (s?.files?.length || (s?.start && s.end && s.start !== s.end)) turns[turns.length - 1].changed = true;
    }
  }
  return turns.filter((t) => t.changed).reverse().map(({ id, prompt, timestamp }) => ({ id, prompt, timestamp }));
}

/** A turn's changes as the app shows them. */
export function diffTurn(
  turn: { prompt: string; timestamp: string },
  files: Array<Partial<DiffFile> & { file: string }>,
): DiffTurn {
  return {
    prompt: turn.prompt,
    timestamp: turn.timestamp,
    files: files.map((f) => ({
      file: f.file,
      status: f.status ?? 'modified',
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      patch: clipPatch(f.patch ?? ''),
    })),
  };
}
