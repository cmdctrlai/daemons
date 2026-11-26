/**
 * Runs the turns this daemon starts, on opencode's event stream.
 *
 * A turn is sent with `prompt_async` and followed by its events rather than held
 * open on one long request: the stream says when it ends, why it failed, which
 * tools it is running, and – crucially – when opencode stops to ask the user
 * something. A permission or question request is handed to the app as a question
 * card through the SDK's wait-for-user, and the user's reply comes back as the next
 * message to the session, which this routes to opencode as the answer.
 */
import type { PermissionRequest } from './adapter/opencode';
import { errorText, questionId, toCard, type Entry, type QuestionCard, type QuestionInfo } from './adapter/transcript';
import type { OpenCodeEvent } from './events';
import type { OpenCodeServer } from './opencode-server';

export const APPROVE = 'Approve once';
export const DENY = 'Deny';
/** Typed replies that mean yes to a permission card. */
const APPROVALS = new Set([APPROVE.toLowerCase(), 'approve', 'allow', 'yes', 'y', 'ok']);
const TARGET_CHARS = 80;
/** How many card ids to remember for paging after them. */
const REMEMBERED_CARDS = 200;
/** How many sessions' parents to remember; a subagent's asks come from its own child session. */
const REMEMBERED_PARENTS = 500;
/** Subagents nest; past this many levels an ask is not traced further. */
const MAX_SUBAGENT_DEPTH = 5;
/** The events that raise or settle something opencode waits on the user for. */
const ASK_EVENTS = new Set(['permission.asked', 'question.asked', 'permission.replied', 'question.replied', 'question.rejected']);

/** What a turn reports to: the SDK's task or resume handle. */
export interface TurnHandle {
  taskId: string;
  progress(action: string, target: string): void;
  complete(result: string): void;
  waitForUser(prompt: string, result: string, options?: Array<{ label: string }>): void;
  error(message: string): void;
}

export interface TurnListener {
  /** A tool call started; a line for the app's verbose pane. */
  tool(taskId: string, callId: string, line: string, tool: string, target: string): void;
  /** A turn this daemon ran finished with an answer. */
  finished(sessionId: string): void;
}

type Ask =
  | { kind: 'permission'; id: string; directory: string; prompt: string; at: number }
  | {
    kind: 'question'; id: string; directory: string; questions: QuestionInfo[]; answers: string[][]; at: number;
    /** The question tool call, whose id the transcript files the answered question under. */
    callId?: string;
  };

interface Turn {
  handle?: TurnHandle;
  /** The handle the turn last reported to, kept while it waits on the user so a stop can still end it. */
  lastHandle?: TurnHandle;
  /** The user stopped it; ending it is not a completion. */
  stopped?: boolean;
  /** The project the session runs in; unknown for the moment before it is looked up. */
  directory?: string;
  /** opencode has reported the session busy since this turn began; an idle before that ends an earlier turn. */
  started: boolean;
  error?: string;
  tools: Set<string>;
  /** What opencode is waiting on the user for, oldest first; the app sees the first. */
  asks: Ask[];
}

export class TurnManager {
  private turns = new Map<string, Turn>();
  /** When each card the app was shown was raised, by its entry id. */
  private cards = new Map<string, number>();
  /** Each session's parent as opencode reported it; null for a session nothing started. */
  private parents = new Map<string, string | null>();

  constructor(
    private readonly adapter: OpenCodeServer,
    private readonly listener: TurnListener,
  ) {}

  /** Whether a turn may be running in this project. One whose project isn't known yet counts. */
  busyIn(directory: string): boolean {
    for (const turn of this.turns.values()) {
      if (turn.directory === undefined || turn.directory === directory) return true;
    }
    return false;
  }

  isBusy(sessionId: string): boolean {
    return this.turns.has(sessionId);
  }

  /** The user's message: the answer to what opencode is waiting on, or a new turn. */
  async send(sessionId: string, handle: TurnHandle, text: string, images?: string[]): Promise<void> {
    // A message sent while a stop is in flight starts a new turn; the stopped one ends unseen.
    const current = this.turns.get(sessionId);
    const turn: Turn = current && !current.stopped ? current : { started: false, tools: new Set<string>(), asks: [] };
    turn.handle = handle;
    turn.lastHandle = handle;
    this.turns.set(sessionId, turn);
    if (turn.asks.length) return this.answer(turn, text);
    try {
      turn.directory ??= await this.adapter.sessionDirectory(sessionId);
      await this.adapter.send(sessionId, text, images, (err) => this.fail(sessionId, err));
    } catch (err) {
      // A turn that never started must not hold its project, or every project, busy.
      this.fail(sessionId, err as Error);
    }
  }

  /**
   * Halt what a session is running, found by its session id or, while the app
   * still holds a PENDING id, by the task that started it. Returns false when
   * nothing was running, so the caller can still clear the server's state.
   */
  async stop(sessionId: string, taskId: string): Promise<boolean> {
    let id = sessionId && this.turns.has(sessionId) ? sessionId : undefined;
    for (const [candidate, turn] of this.turns) {
      if (!id && turn.lastHandle?.taskId === taskId) id = candidate;
    }
    const turn = id ? this.turns.get(id) : undefined;
    if (!id || !turn) return false;
    turn.stopped = true;
    turn.asks = [];
    try {
      await this.adapter.abort(id, turn.directory);
      // Clients read the transcript when the task ends; it must already say Stopped.
      await this.adapter.awaitTurnEnd(id);
    } finally {
      turn.started = true;
      await this.finish(id, turn);
    }
    return true;
  }

  /** The card for what the session is waiting on, to end the app's message list with. */
  askEntry(sessionId: string): Entry | undefined {
    const ask = this.turns.get(sessionId)?.asks[0];
    if (!ask) return undefined;
    const card = askCard(ask);
    const uuid = this.cardId(ask);
    return { uuid, role: 'AGENT', content: card.question, timestamp: new Date(ask.at).toISOString(), question: card };
  }

  /**
   * When the card with this entry id was raised. The app pages on from its newest
   * entry, which can be a card the transcript has no record of under that id.
   */
  cardTime(uuid: string | undefined): number | undefined {
    return uuid ? this.cards.get(uuid) : undefined;
  }

  private cardId(ask: Ask): string {
    const uuid = ask.kind === 'question' && ask.callId ? questionId(ask.callId, ask.answers.length) : `${ask.id}:${ask.kind === 'question' ? ask.answers.length : 0}`;
    if (!this.cards.has(uuid)) {
      this.cards.set(uuid, ask.at);
      if (this.cards.size > REMEMBERED_CARDS) this.cards.delete(this.cards.keys().next().value!);
    }
    return uuid;
  }

  handleEvent(event: OpenCodeEvent): void {
    const p = event.properties ?? {};
    const sessionId: string | undefined = p.sessionID;
    if (!sessionId) return;
    const turn = this.turns.get(sessionId);
    if (!turn && ASK_EVENTS.has(event.type)) {
      // A subagent asks from its own child session; the card belongs to the turn that started it.
      void this.ownerOf(sessionId, event.directory).then((owner) => owner && this.handleAsk(owner, event));
      return;
    }
    // opencode goes idle before it records the abort; stop() ends a stopped turn after that.
    if (!turn || turn.stopped) return;
    if (ASK_EVENTS.has(event.type)) {
      this.handleAsk(turn, event);
      return;
    }

    switch (event.type) {
      case 'session.status':
        if (p.status?.type === 'idle') {
          void this.finish(sessionId, turn);
        } else {
          turn.started = true;
          if (p.status?.type === 'retry') turn.handle?.progress('Retrying', p.status.message ?? '');
        }
        break;
      case 'session.idle':
        void this.finish(sessionId, turn);
        break;
      case 'session.error':
        // opencode repeats the error after the turn ends, with a stack trace; keep the first.
        if (turn.started && !turn.error) turn.error = errorText(p.error);
        break;
      case 'message.part.updated':
        this.toolStarted(turn, p.part);
        break;
    }
  }

  private handleAsk(turn: Turn, event: OpenCodeEvent): void {
    if (turn.stopped) return;
    const p = event.properties ?? {};
    switch (event.type) {
      case 'permission.asked':
        this.queue(turn, {
          kind: 'permission', id: p.id, directory: event.directory ?? '', prompt: permissionPrompt(p as PermissionRequest), at: Date.now(),
        });
        break;
      case 'question.asked':
        this.queue(turn, {
          kind: 'question', id: p.id, directory: event.directory ?? '', questions: p.questions ?? [], answers: [],
          at: Date.now(), callId: p.tool?.callID,
        });
        break;
      default:
        turn.asks = turn.asks.filter((a) => a.id !== p.requestID);
    }
  }

  /**
   * The turn a session's request belongs to: its own, or for a subagent's child
   * session the turn of the session that started it. With no parent on record,
   * the one turn running in the project is the only candidate.
   */
  private async ownerOf(sessionId: string, directory?: string): Promise<Turn | undefined> {
    let id: string | null | undefined = sessionId;
    for (let depth = 0; id && depth <= MAX_SUBAGENT_DEPTH; depth++) {
      const turn = this.turns.get(id);
      if (turn) return turn;
      id = await this.parentOf(id);
    }
    const here = [...this.turns.values()].filter((t) => t.directory === directory);
    return here.length === 1 ? here[0] : undefined;
  }

  /** A session's parent, remembered once known; undefined when it can't be read now. */
  private async parentOf(sessionId: string): Promise<string | null | undefined> {
    if (this.parents.has(sessionId)) return this.parents.get(sessionId);
    try {
      const parent = await this.adapter.parentSession(sessionId);
      this.parents.set(sessionId, parent);
      if (this.parents.size > REMEMBERED_PARENTS) this.parents.delete(this.parents.keys().next().value!);
      return parent;
    } catch {
      return undefined;
    }
  }

  /**
   * Catch up after the event stream reconnects: a turn that ended, or started
   * waiting on the user, while it was down would otherwise wait forever.
   */
  async resync(): Promise<void> {
    const directories = new Set<string>();
    for (const [sessionId, turn] of this.turns) {
      try {
        if (turn.started && (await this.adapter.activity(sessionId)).state.finished) {
          await this.finish(sessionId, turn);
          continue;
        }
        turn.directory ??= await this.adapter.sessionDirectory(sessionId);
        directories.add(turn.directory);
      } catch {
        // The next reconnect or event tries again.
      }
    }
    // A project's requests include its subagents', raised from their own child sessions.
    for (const directory of directories) {
      try {
        const pending = await this.adapter.pendingRequests(directory);
        for (const r of pending.permissions) {
          const turn = await this.ownerOf(r.sessionID, directory);
          if (turn && !turn.stopped) {
            this.queue(turn, { kind: 'permission', id: r.id, directory, prompt: permissionPrompt(r), at: Date.now() });
          }
        }
        for (const r of pending.questions) {
          const turn = await this.ownerOf(r.sessionID, directory);
          if (turn && !turn.stopped) {
            this.queue(turn, {
              kind: 'question', id: r.id, directory, questions: r.questions, answers: [], at: Date.now(), callId: r.tool?.callID,
            });
          }
        }
      } catch {
        // The next reconnect or event tries again.
      }
    }
  }

  private queue(turn: Turn, ask: Ask): void {
    if (turn.asks.some((a) => a.id === ask.id)) return;
    this.cardId(ask);
    turn.asks.push(ask);
    if (turn.asks.length === 1) this.present(turn);
  }

  /** Hand the first ask to the app. The SDK treats waiting on the user as the task's end. */
  private present(turn: Turn): void {
    const handle = turn.handle;
    const ask = turn.asks[0];
    if (!handle || !ask) return;
    turn.handle = undefined;
    const card = askCard(ask);
    handle.waitForUser(card.question, '', card.options.map((o) => ({ label: o.label })));
  }

  private async answer(turn: Turn, text: string): Promise<void> {
    const ask = turn.asks[0];
    try {
      if (ask.kind === 'permission') {
        const reply = text.trim();
        const approve = APPROVALS.has(reply.toLowerCase());
        // Anything but a plain yes or no is feedback for the model on why not.
        const feedback = approve || reply === DENY ? undefined : reply;
        await this.adapter.replyPermission(ask.id, ask.directory, approve ? 'once' : 'reject', feedback);
      } else {
        ask.answers.push(parseAnswer(ask.questions[ask.answers.length], text));
        if (ask.answers.length < ask.questions.length) {
          this.cardId(ask);
          this.present(turn);
          return;
        }
        await this.adapter.replyQuestion(ask.id, ask.directory, ask.answers);
      }
      // By identity: opencode's own replied event may already have removed it.
      turn.asks = turn.asks.filter((a) => a !== ask);
      turn.started = true;
      this.present(turn);
    } catch (err) {
      turn.asks = turn.asks.filter((a) => a !== ask);
      const handle = turn.handle;
      turn.handle = undefined;
      handle?.error(`Could not answer opencode: ${(err as Error).message}`);
    }
  }

  private toolStarted(turn: Turn, part: any): void {
    if (part?.type !== 'tool' || part.state?.status !== 'running' || part.tool === 'question') return;
    // While the turn waits on the user nobody is listening; the call's next update reports it.
    if (!turn.handle || turn.tools.has(part.callID)) return;
    turn.tools.add(part.callID);
    const { action, target } = describeTool(part.tool, part.state.input ?? {});
    turn.handle.progress(action, target);
    this.listener.tool(turn.handle.taskId, part.callID, `${action} ${target}`.trim(), part.tool, target);
  }

  /**
   * End a turn that is still the session's. One a newer turn replaced – a message
   * sent while it was being stopped – reports nothing: the tasks share the
   * session's task id, so its completion would end the newer one's on the server.
   */
  private async finish(sessionId: string, turn: Turn): Promise<void> {
    if (!turn.started || this.turns.get(sessionId) !== turn) return;
    this.turns.delete(sessionId);
    if (turn.stopped) {
      // The transcript records the stop; the app reads it from there. No push.
      (turn.handle ?? turn.lastHandle)?.complete('');
      return;
    }
    let text = '';
    let error = turn.error;
    try {
      const result = await this.adapter.turnResult(sessionId);
      text = result.text;
      error = result.error ?? error;
    } catch (err) {
      error ??= (err as Error).message;
    }
    if (error) {
      turn.handle?.error(error);
      return;
    }
    turn.handle?.complete(text);
    this.listener.finished(sessionId);
  }

  private fail(sessionId: string, err: Error): void {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    this.turns.delete(sessionId);
    turn.handle?.error(err.message);
  }
}

/**
 * The session a task_start really continues, if any. The server starts a task for
 * a session it already created when the user replies within seconds of creating
 * it – as an answer to opencode's first question can – so a start naming a session
 * this daemon made is a reply to that session.
 */
export function continuedSession(taskId: string, created: Set<string>): string | undefined {
  const native = taskId.split(':').pop() ?? '';
  return created.has(native) ? native : undefined;
}

export function permissionPrompt(request: PermissionRequest): string {
  const patterns = (request.patterns ?? []).join(', ');
  return `Allow ${request.permission}${patterns ? `: ${clip(patterns)}` : ''}?`;
}

function askCard(ask: Ask): QuestionCard {
  if (ask.kind === 'permission') {
    return { question: ask.prompt, header: 'Permission', options: [{ label: APPROVE }, { label: DENY }] };
  }
  return toCard(ask.questions[ask.answers.length]);
}

/**
 * The user's reply as opencode's answer: the labels they picked, or their own
 * words when they typed something the question did not offer. The app joins a
 * multi-select's labels with ", ".
 */
export function parseAnswer(question: QuestionInfo, text: string): string[] {
  const reply = text.trim();
  if (question.multiple) {
    const picked = reply.split(', ');
    const labels = question.options.map((o) => o.label).filter((l) => picked.includes(l));
    if (labels.length) return labels;
  }
  return [reply];
}

const VERBS: Record<string, string> = {
  bash: 'Running',
  shell: 'Running',
  read: 'Reading',
  write: 'Writing',
  edit: 'Editing',
  multiedit: 'Editing',
  patch: 'Editing',
  glob: 'Searching',
  grep: 'Searching',
  list: 'Listing',
  webfetch: 'Fetching',
  websearch: 'Searching',
  task: 'Delegating',
  subagent: 'Delegating',
  todowrite: 'Updating todos',
};

/** A tool call as the app's progress line: "Running npm test", "Reading src/a.ts". */
export function describeTool(tool: string, input: Record<string, unknown>): { action: string; target: string } {
  const arg = [input.command, input.filePath, input.path, input.pattern, input.url, input.query, input.description]
    .find((v) => typeof v === 'string' && v) as string | undefined;
  return { action: VERBS[tool] ?? `Using ${tool}`, target: clip(arg ?? '') };
}

function clip(text: string): string {
  return text.length > TARGET_CHARS ? `${text.slice(0, TARGET_CHARS - 1)}…` : text;
}
