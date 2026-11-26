/**
 * Reading opencode's stored messages: what the app shows for a session, and
 * whether its turn is still running. Pure functions over `GET /session/{id}/message`.
 */
import type { DiffFile, DiffTurn, MessageEntry } from '@cmdctrl/daemon-sdk';

export interface OpenCodePart {
  id?: string;
  type: string;
  text?: string;
  /**
   * opencode's own flag for text it generated to keep a turn moving – the
   * "Summarize the task tool output above and continue with your task." nudge
   * after a subtask, for instance. The user never typed it, so it is machinery
   * rather than conversation and is dropped rather than shown as their message.
   */
  synthetic?: boolean;
  tool?: string;
  callID?: string;
  state?: {
    status: string;
    input?: Record<string, unknown>;
    title?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface OpenCodeError {
  name?: string;
  data?: { message?: string };
}

export interface OpenCodeMessage {
  info: {
    id: string;
    role: string;
    time: { created: number; completed?: number };
    /** Why the assistant stopped; `tool-calls` means the turn goes on. */
    finish?: string;
    error?: OpenCodeError;
    providerID?: string;
    modelID?: string;
    model?: { providerID: string; modelID: string };
    /** On a user message: the files its turn changed, as opencode recorded them. */
    summary?: { diffs?: Array<Partial<DiffFile> & { file: string }> };
  };
  parts: OpenCodePart[];
}

export interface QuestionInfo {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiple?: boolean;
}

/** A message's `question` field: the shape the app renders as tappable options. */
export interface QuestionCard {
  question: string;
  header?: string;
  multi_select?: boolean;
  options: Array<{ label: string; description?: string }>;
}

/** An app message, which may carry a question for the app to render as options. */
export type Entry = MessageEntry & { question?: QuestionCard };

/** How long a turn the transcript shows as unfinished still counts as running. */
const STALE_TURN_MS = 10 * 60 * 1000;
/** A prompt with no reply yet counts as running for this long. */
const UNANSWERED_PROMPT_MS = 2 * 60 * 1000;
/**
 * opencode starts a turn's next step within milliseconds of the last one ending.
 * A step that ended on tool calls with nothing after it for this long ended the
 * turn – the user denied the tool, or rejected the question.
 */
const NEXT_STEP_MS = 2000;
const PREVIEW_CHARS = 200;
/** A prompt as the heading of its turn's changes. */
const DIFF_PROMPT_CHARS = 200;
/** Beyond this a patch is cut; nobody reads a 50 KB diff on a phone. */
const MAX_PATCH_CHARS = 50_000;
/** What the app shows for a turn the user stopped. */
export const STOPPED = 'Stopped';

/** The message's text, without reasoning, tool output or opencode's synthetic nudges. */
export function extractText(message: OpenCodeMessage): string {
  return message.parts
    .filter((p) => p.type === 'text' && p.text && !p.synthetic)
    .map((p) => p.text!)
    .join('\n');
}

/** The assistant was cut off by an abort – the user's stop, from the app or the terminal. */
export function isAborted(message: OpenCodeMessage): boolean {
  return message.info.error?.name === 'MessageAbortedError';
}

/** The error an assistant message ended on, as the user should read it. */
export function errorText(error?: OpenCodeError): string | undefined {
  if (!error) return undefined;
  return error.data?.message || error.name || 'opencode reported an error';
}

/**
 * A question's entry id: the same for the live card and, once answered, for the
 * transcript's record of it, so the app's cursor stays valid across the answer.
 */
export function questionId(callId: string, index: number): string {
  return `${callId}:${index}:q`;
}

export function toCard(q: QuestionInfo): QuestionCard {
  return {
    question: q.question,
    ...(q.header ? { header: q.header } : {}),
    ...(q.multiple ? { multi_select: true } : {}),
    options: q.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
  };
}

/**
 * The conversation as the app shows it.
 *
 * A user message holding a compaction part is the user's `/compact`, so it reads as
 * that command. A question opencode asked and the user answered is in the
 * transcript as a `question` tool call; it reads as the question with its options,
 * then the user's answer. `collapse` turns an expanded command template back into
 * the command the user typed.
 */
export function toEntries(
  messages: OpenCodeMessage[],
  collapse: (text: string) => string | null,
): Entry[] {
  const entries: Entry[] = [];
  for (const m of messages) {
    const timestamp = new Date(m.info.time.created).toISOString();
    if (m.info.role === 'user') {
      const compacted = m.parts.some((p) => p.type === 'compaction');
      const text = compacted ? '/compact' : extractText(m);
      const content = collapse(text) || text;
      if (content) entries.push({ uuid: m.info.id, role: 'USER', content, timestamp });
      continue;
    }

    const text = extractText(m);
    if (text) entries.push({ uuid: m.info.id, role: 'AGENT', content: text, timestamp });
    if (isAborted(m)) entries.push({ uuid: `${m.info.id}:stopped`, role: 'AGENT', content: STOPPED, timestamp });
    for (const part of m.parts) {
      if (part.type !== 'tool' || part.tool !== 'question' || part.state?.status !== 'completed') continue;
      const questions = (part.state.input?.questions ?? []) as QuestionInfo[];
      const answers = (part.state.metadata?.answers ?? []) as string[][];
      questions.forEach((q, i) => {
        entries.push({ uuid: questionId(part.callID ?? '', i), role: 'AGENT', content: q.question, timestamp, question: toCard(q) });
        const answer = (answers[i] ?? []).join(', ');
        if (answer) entries.push({ uuid: `${part.callID}:${i}:a`, role: 'USER', content: answer, timestamp });
      });
    }
  }
  return entries;
}

/**
 * One page of entries, for the app's initial load and its Load More. `before`
 * pages backwards from an entry the app already has; `after` forwards.
 *
 * An `after` the transcript doesn't hold is answered from `afterTime` when given:
 * the app's newest entry can be a card the daemon showed for something opencode
 * asked, which the transcript never records as such.
 */
export function page(
  entries: Entry[],
  limit: number,
  before?: string,
  after?: string,
  afterTime?: number,
): { messages: Entry[]; hasMore: boolean } {
  if (before) {
    const end = entries.findIndex((e) => e.uuid === before);
    if (end === -1) return { messages: [], hasMore: false };
    const start = Math.max(0, end - limit);
    return { messages: entries.slice(start, end), hasMore: start > 0 };
  }
  if (after) {
    let from = entries.findIndex((e) => e.uuid === after) + 1;
    if (from === 0) {
      if (afterTime === undefined) return { messages: [], hasMore: false };
      from = entries.findIndex((e) => Date.parse(e.timestamp) > afterTime);
      if (from === -1) return { messages: [], hasMore: false };
    }
    const end = from + limit;
    return { messages: entries.slice(from, end), hasMore: end < entries.length };
  }
  return { messages: entries.slice(-limit), hasMore: entries.length > limit };
}

export interface TurnState {
  /** The newest turn ended – on a final answer or an error, not between tool steps. */
  finished: boolean;
  /** It ended because the user stopped it, which is nothing to notify anyone about. */
  stopped?: boolean;
  /** Something is still being produced, as far as the transcript can tell. */
  running: boolean;
  /** The assistant message that finished the turn, when it has. */
  finalId?: string;
  /** Why the turn failed, when it ended on an error. */
  error?: string;
  /** The newest text in the conversation, for the session list. */
  preview: string;
}

/**
 * Where a session's newest turn stands, from the transcript alone. A turn may be
 * running in another opencode process – the user's own terminal – where this
 * daemon sees no events, so this is the only view that covers every session.
 * `updatedAt` is when opencode last touched the session.
 */
export function turnState(messages: OpenCodeMessage[], updatedAt: number, now = Date.now()): TurnState {
  let preview = '';
  for (let i = messages.length - 1; i >= 0 && !preview; i--) preview = extractText(messages[i]);
  preview = preview.slice(0, PREVIEW_CHARS);

  const last = messages[messages.length - 1];
  if (!last) return { finished: false, running: false, preview };
  if (last.info.role === 'user') {
    return { finished: false, running: now - last.info.time.created < UNANSWERED_PROMPT_MS, preview };
  }
  const completed = last.info.time.completed;
  const done = !!completed && (!!last.info.error || last.info.finish !== 'tool-calls');
  if (done) {
    const stopped = isAborted(last);
    return { finished: true, stopped, running: false, finalId: last.info.id, error: stopped ? undefined : errorText(last.info.error), preview };
  }
  if (completed && now - completed >= NEXT_STEP_MS) return { finished: false, running: false, preview };
  return { finished: false, running: now - updatedAt < STALE_TURN_MS, preview };
}

/**
 * What the agent changed, turn by turn, newest first: each turn's files under the
 * prompt that started it. opencode records a turn's changes on its user message,
 * so the transcript alone holds every diff.
 */
export function diffTurns(messages: OpenCodeMessage[], collapse: (text: string) => string | null): DiffTurn[] {
  const turns: DiffTurn[] = [];
  for (const m of messages) {
    const diffs = m.info.role === 'user' ? m.info.summary?.diffs ?? [] : [];
    if (!diffs.length) continue;
    const text = extractText(m);
    turns.push({
      prompt: (collapse(text) || text).slice(0, DIFF_PROMPT_CHARS),
      timestamp: new Date(m.info.time.created).toISOString(),
      files: diffs.map((d) => ({
        file: d.file,
        status: d.status ?? 'modified',
        additions: d.additions ?? 0,
        deletions: d.deletions ?? 0,
        patch: clipPatch(d.patch ?? ''),
      })),
    });
  }
  return turns.reverse();
}

export function clipPatch(patch: string): string {
  if (patch.length <= MAX_PATCH_CHARS) return patch;
  const cut = patch.lastIndexOf('\n', MAX_PATCH_CHARS);
  return `${patch.slice(0, cut > 0 ? cut : MAX_PATCH_CHARS)}\n… (diff cut short)`;
}
