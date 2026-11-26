/**
 * Runs prompt turns on the ACP agent and relays them to the app.
 *
 * A turn is one `session/prompt`. While it runs the agent streams
 * `session/update` notifications: text, which reaches the app a message at a
 * time as each one completes; tool calls, which become progress lines; and it may
 * stop to ask permission, which becomes a question card through the SDK's
 * wait-for-user. The user's reply arrives as the next message to the session and
 * is routed back to the agent as the answer, while the same prompt carries on.
 */
import { createHash, randomUUID } from 'crypto';
import type {
  ContentBlock,
  PermissionOption,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionNotification,
  SessionUpdate,
  StopReason,
  ToolCallFields,
} from './acp/types';
import { chooseOption, describeTool, permissionCard, rejectOption } from './present';
import type { Entry, QuestionCard, TranscriptStore } from './transcript';

/** What a turn reports to: the SDK's task or resume handle. */
export interface TurnHandle {
  taskId: string;
  progress(action: string, target: string): void;
  complete(result: string): void;
  waitForUser(prompt: string, result: string, options?: Array<{ label: string }>): void;
  error(message: string): void;
}

/** The agent, as far as turns need it. */
export interface TurnAgent {
  readonly name: string;
  readonly canReplay: boolean;
  readonly acceptsImages: boolean;
  isLive(sessionId: string): boolean;
  open(sessionId: string, cwd: string, onReplay?: (update: SessionUpdate) => void): Promise<void>;
  prompt(sessionId: string, prompt: ContentBlock[]): Promise<{ stopReason: StopReason }>;
  cancel(sessionId: string): void;
}

export interface TurnSink {
  /** A finished piece of assistant text, for the app to show now. */
  agentText(sessionId: string, entry: Entry): void;
  /** A tool call started; a line for the app's verbose pane. */
  tool(taskId: string, callId: string, line: string, tool: string, target: string): void;
  /** A turn ended with an answer – the app's cue to notify. */
  finished(sessionId: string, lastMessage: string, messageCount: number): void;
  /**
   * A queued message has started after the previous reply landed. An app clears
   * its working state, and its Stop button, when a reply lands; this restores it.
   */
  working?(taskId: string, sessionId: string): void;
}

/** What the app is told about a message still waiting when the daemon stops. */
export const NOT_SENT = 'Not sent: the daemon stopped';

/** How many not-yet-started stopped tasks to remember. */
const STOPPED_REMEMBERED = 100;

/** How long Stop waits for the agent to end a cancelled prompt before ending it here. */
export const STOP_GRACE_MS = 10_000;

const LIMIT_NOTES: Partial<Record<StopReason, string>> = {
  max_tokens: '_The agent stopped: it reached its output limit._',
  max_turn_requests: '_The agent stopped: it reached its limit of steps for one turn._',
};

interface Ask {
  requestId: number | string;
  uuid: string;
  card: QuestionCard;
  options: PermissionOption[];
  resolve: (outcome: RequestPermissionOutcome) => void;
}

interface Turn {
  sessionId: string;
  cwd: string;
  /** Where the turn reports now; unset while it waits on the user. */
  handle?: TurnHandle;
  /** The handle the turn last reported to, kept so a stop or late end can still close it. */
  lastHandle: TurnHandle;
  stopped: boolean;
  /** Assistant text still arriving: one message, reported when the next thing starts. */
  text: { content: string; messageId?: string } | null;
  thinking: boolean;
  tools: Map<string, ToolCallFields & { announced?: boolean; shown?: string }>;
  lastText: string;
  asks: Ask[];
  /** A reply that answered a permission card with words rather than a choice: the next prompt. */
  followUp?: string;
  ended: boolean;
  done: Promise<void>;
  end: () => void;
}

export class TurnManager {
  private turns = new Map<string, Turn>();
  /** Each session's queue: one prompt at a time, in the order they arrived. */
  private tails = new Map<string, Promise<void>>();
  /** The choices on each session's last card that stopped waiting; a tap on one now is not a prompt. */
  private settled = new Map<string, Set<string>>();
  /** Messages waiting for the session's turn to end. While any wait, the session is still working. */
  private queued = new Map<string, TurnHandle[]>();
  /** Tasks a queued message took over, ended with the last one so the server sees one run. */
  private superseded = new Map<string, TurnHandle[]>();
  /** Bumped by Stop: a message queued before it was stopped with the turn and never runs. */
  private stops = new Map<string, number>();
  /** New sessions' tasks stopped while the session was still being created, before any turn. */
  private stoppedBeforeStart = new Set<string>();
  /** Read-backs from the agent in flight; a prompt for the session waits for its one. */
  private reading = new Map<string, Promise<void>>();
  /** The daemon is stopping: nothing more runs. */
  private closing = false;

  constructor(
    private readonly agent: TurnAgent,
    private readonly transcript: TranscriptStore,
    private readonly sink: TurnSink,
    private readonly log: (line: string) => void = (line) => console.log(line),
  ) {
    // No turn outlives the process that ran it, so no card left from one can still be answered.
    transcript.closeUnansweredCards();
  }

  isBusy(sessionId: string): boolean {
    return this.turns.has(sessionId) || this.waiting(sessionId) > 0;
  }

  /** The user's message: the answer to a permission card, or the session's next prompt. */
  send(sessionId: string, cwd: string, handle: TurnHandle, text: string, images?: string[]): Promise<void> {
    if (this.stoppedBeforeStart.delete(handle.taskId)) {
      this.keepUnsent(sessionId, cwd, handle, text);
      return Promise.resolve();
    }
    const current = this.turns.get(sessionId);
    if (current && !current.stopped && current.asks.length) {
      this.answer(current, handle, text);
      return Promise.resolve();
    }
    const closed = this.transcript.closedChoices(sessionId);
    const settled = this.settled.get(sessionId) ?? (closed && choices(closed));
    if (settled?.has(text.trim().toLowerCase())) {
      this.absorb(sessionId, handle);
      return Promise.resolve();
    }
    this.settled.delete(sessionId);
    this.transcript.forgetClosedChoices(sessionId);
    return this.enqueue(sessionId, cwd, handle, text, images, true);
  }

  /**
   * A tap on a card that is no longer waiting – answered already, perhaps from
   * another device, withdrawn by the agent, or stopped. It is not a prompt. The
   * server started a task for it, under the session's id like every other, so a
   * running turn takes it over; otherwise it ends at once.
   */
  private absorb(sessionId: string, handle: TurnHandle): void {
    const current = this.turns.get(sessionId);
    if (current && !current.stopped) {
      current.handle = handle;
      current.lastHandle = handle;
      return;
    }
    handle.complete('');
  }

  private enqueue(sessionId: string, cwd: string, handle: TurnHandle, text: string, images: string[] | undefined, record: boolean): Promise<void> {
    const generation = this.stops.get(sessionId) ?? 0;
    this.queued.set(sessionId, [...(this.queued.get(sessionId) ?? []), handle]);
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const mine = previous.then(() => this.run(sessionId, cwd, handle, text, images, record, generation));
    const tail = mine.catch(() => undefined);
    this.tails.set(sessionId, tail);
    void tail.then(() => { if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId); });
    return mine;
  }

  /**
   * Halt what a session is running, found by its session id or, while the app
   * still holds a PENDING id, by the task that started it. Returns false when
   * nothing was running, so the caller can still clear the server's state.
   */
  async stop(sessionId: string, taskId: string): Promise<boolean> {
    let turn = sessionId ? this.turns.get(sessionId) : undefined;
    if (!turn) turn = [...this.turns.values()].find((t) => t.lastHandle.taskId === taskId);
    const session = turn?.sessionId ?? sessionId;
    // Stop means everything sent so far: messages still waiting go with the turn.
    if (session) this.dropQueued(session);
    if (!turn) {
      // A new session's first message waits on session/new before it has a turn. Its
      // PENDING id is its own, so the stop can wait for it without catching later work.
      if (taskId.includes(':PENDING-')) {
        this.stoppedBeforeStart.add(taskId);
        if (this.stoppedBeforeStart.size > STOPPED_REMEMBERED) {
          this.stoppedBeforeStart.delete(this.stoppedBeforeStart.values().next().value!);
        }
      }
      return false;
    }
    turn.stopped = true;
    // ACP: answer every open permission request as cancelled before the prompt can end.
    this.abandonAsks(turn);
    this.agent.cancel(turn.sessionId);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([turn.done, new Promise<void>((r) => { timer = setTimeout(r, STOP_GRACE_MS); })]);
    clearTimeout(timer);
    if (!turn.ended) {
      this.log(`${this.agent.name} did not end the cancelled turn on ${turn.sessionId} within ${STOP_GRACE_MS / 1000}s; ending it here`);
      this.finish(turn, 'cancelled');
    }
    return true;
  }

  /** The agent streamed something for a session. */
  handleUpdate({ sessionId, update }: SessionNotification): void {
    const turn = this.turns.get(sessionId);
    if (update.sessionUpdate === 'session_info_update' && typeof (update as any).title === 'string') {
      const record = this.transcript.get(sessionId);
      if (record || turn) this.transcript.setTitle(sessionId, turn?.cwd ?? record!.cwd, (update as any).title);
    }
    if (!turn) return;
    // After a stop the agent may flush what it had said before answering the prompt;
    // that text is kept, as the agent keeps it. Nothing else is news any more.
    if (turn.stopped && update.sessionUpdate !== 'agent_message_chunk') return;

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const { content, messageId } = update as { content: ContentBlock; messageId?: string | null };
        if (content?.type !== 'text' || typeof content.text !== 'string') return;
        // An empty chunk breaks the stream – Qwen Code sends one around each model
        // request – so a status line before it isn't run into the reply after.
        if (!content.text) {
          this.flushText(turn);
          return;
        }
        if (turn.text && messageId && turn.text.messageId && messageId !== turn.text.messageId) this.flushText(turn);
        if (!turn.text) turn.text = { content: '', messageId: messageId ?? undefined };
        turn.text.content += content.text;
        turn.thinking = false;
        break;
      }
      case 'agent_thought_chunk':
        if (!turn.thinking) {
          turn.thinking = true;
          turn.handle?.progress('Thinking', '');
        }
        break;
      case 'tool_call':
      case 'tool_call_update':
        this.flushText(turn);
        this.toolUpdate(turn, update as ToolCallFields);
        break;
      case 'plan': {
        const entries = (update as { entries?: Array<{ content: string; status?: string }> }).entries ?? [];
        const current = entries.find((e) => e.status === 'in_progress') ?? entries.find((e) => e.status !== 'completed');
        if (current?.content) turn.handle?.progress('Planning', current.content.slice(0, 80));
        break;
      }
    }
  }

  /** The agent asks before running a tool. Resolves once the user answers or the turn stops. */
  permission(request: RequestPermissionRequest, requestId: number | string): Promise<RequestPermissionOutcome> {
    const turn = this.turns.get(request.sessionId);
    if (!turn || turn.stopped) return Promise.resolve({ outcome: 'cancelled' });
    this.flushText(turn);
    const toolCallId = request.toolCall?.toolCallId ?? '';
    const tool = { ...turn.tools.get(toolCallId), ...definedFields(request.toolCall ?? { toolCallId }), toolCallId };
    const options = request.options ?? [];
    return new Promise((resolve) => {
      turn.asks.push({ requestId, uuid: randomUUID(), card: permissionCard(tool, options), options, resolve });
      if (turn.asks.length === 1) this.present(turn);
    });
  }

  /** The agent took back a request – the ask it raised is no longer the user's to answer. */
  withdraw(requestId: number | string): void {
    for (const turn of this.turns.values()) {
      const index = turn.asks.findIndex((a) => a.requestId === requestId);
      if (index < 0) continue;
      const [ask] = turn.asks.splice(index, 1);
      ask.resolve({ outcome: 'cancelled' });
      if (index === 0) {
        this.settle(turn.sessionId, ask);
        this.transcript.closeCard(turn.sessionId, ask.uuid);
        turn.handle = turn.lastHandle;
        if (turn.asks.length) this.present(turn);
      }
      return;
    }
  }

  /** The agent process ended; every turn it was running ends with it. */
  agentExited(reason: Error): void {
    for (const turn of [...this.turns.values()]) this.fail(turn, reason);
  }

  /**
   * Read a session back from the agent before it is shown, when no turn is
   * running there: the agent is the system of record, and its replay becomes the
   * history. The daemon's own record only serves a turn while it runs. An agent
   * that can't replay keeps the daemon's record.
   */
  async refresh(sessionId: string, cwd: string): Promise<void> {
    if (!this.agent.canReplay || this.isBusy(sessionId)) return;
    await this.readBack(sessionId, cwd);
  }

  /** The daemon is stopping: every waiting message is reported as not sent, and none runs. */
  shutdown(): void {
    this.closing = true;
    for (const handles of this.queued.values()) {
      for (const handle of handles) handle.error(NOT_SENT);
    }
    this.queued.clear();
  }

  private readBack(sessionId: string, cwd: string): Promise<void> {
    const inFlight = this.reading.get(sessionId);
    if (inFlight) return inFlight;
    const reading = (async () => {
      const replay = new Replay(sessionId);
      await this.agent.open(sessionId, cwd, (update) => replay.add(update));
      this.transcript.applyReplay(sessionId, cwd, replay.entries());
    })().finally(() => this.reading.delete(sessionId));
    this.reading.set(sessionId, reading);
    return reading;
  }

  /** Make the session ready for a prompt: wait for a read-back in flight, else open it if the agent doesn't hold it. */
  private async reopen(sessionId: string, cwd: string): Promise<void> {
    await this.reading.get(sessionId)?.catch(() => undefined);
    if (this.agent.isLive(sessionId)) return;
    if (this.agent.canReplay) await this.readBack(sessionId, cwd);
    else await this.agent.open(sessionId, cwd);
  }

  private waiting(sessionId: string): number {
    return this.queued.get(sessionId)?.length ?? 0;
  }

  /** Run one prompt. Resolves when the turn ends – which a stop can force before the agent answers. */
  private async run(
    sessionId: string, cwd: string, handle: TurnHandle, text: string, images: string[] | undefined, record: boolean, generation: number,
  ): Promise<void> {
    const waiting = (this.queued.get(sessionId) ?? []).filter((h) => h !== handle);
    if (waiting.length) this.queued.set(sessionId, waiting);
    else this.queued.delete(sessionId);
    // The daemon is stopping: this message was already reported as not sent.
    if (this.closing) return;
    if ((this.stops.get(sessionId) ?? 0) !== generation) {
      // Stopped while it waited: it never reaches the agent, and its task ends here.
      if (record) this.keepUnsent(sessionId, cwd, handle, text);
      else handle.complete('');
      return;
    }
    let end!: () => void;
    const done = new Promise<void>((r) => { end = r; });
    const turn: Turn = {
      sessionId, cwd, handle, lastHandle: handle, stopped: false, text: null, thinking: false,
      tools: new Map(), lastText: '', asks: [], ended: false, done, end,
    };
    this.turns.set(sessionId, turn);
    try {
      await this.reopen(sessionId, cwd);
      if (turn.stopped) {
        this.finish(turn, 'cancelled');
        return;
      }
      if (record) this.transcript.append(sessionId, cwd, { uuid: randomUUID(), role: 'USER', content: text, timestamp: now() });
      if (this.superseded.has(sessionId)) this.sink.working?.(handle.taskId, sessionId);
      handle.progress('Thinking', '');
      this.agent.prompt(sessionId, this.promptBlocks(text, images)).then(
        ({ stopReason }) => this.finish(turn, stopReason),
        (err) => this.fail(turn, err as Error),
      );
    } catch (err) {
      this.fail(turn, err as Error);
    }
    await done;
  }

  private promptBlocks(text: string, images?: string[]): ContentBlock[] {
    const blocks: ContentBlock[] = [{ type: 'text', text }];
    if (!images?.length) return blocks;
    if (!this.agent.acceptsImages) {
      this.log(`${this.agent.name} does not accept images; sending the text of the message only`);
      return blocks;
    }
    for (const url of images) {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      if (match) blocks.push({ type: 'image', mimeType: match[1], data: match[2] });
    }
    return blocks;
  }

  private toolUpdate(turn: Turn, update: ToolCallFields): void {
    if (!update.toolCallId) return;
    const tool = { ...turn.tools.get(update.toolCallId), ...definedFields(update), toolCallId: update.toolCallId };
    turn.tools.set(update.toolCallId, tool);
    const { action, target } = describeTool(tool);
    const line = `${action} ${target}`.trim();
    const active = tool.status === 'pending' || tool.status === 'in_progress' || !tool.status;
    if (active && tool.shown !== line && turn.handle) {
      tool.shown = line;
      turn.handle.progress(action, target);
    }
    // Once per call, when it has actually started: by then the agent has said what it runs.
    if (!tool.announced && tool.status && tool.status !== 'pending') {
      tool.announced = true;
      const name = (tool.title ?? '').split(/[\s:]/)[0] || 'tool';
      this.sink.tool(turn.lastHandle.taskId, update.toolCallId, line, name, target);
    }
  }

  /** Hand the first ask to the app. The SDK treats waiting on the user as the task's end. */
  private present(turn: Turn): void {
    const ask = turn.asks[0];
    if (!ask) return;
    const entry: Entry = { uuid: ask.uuid, role: 'AGENT', content: ask.card.question, timestamp: now(), question: ask.card };
    this.transcript.append(turn.sessionId, turn.cwd, entry);
    const handle = turn.handle ?? turn.lastHandle;
    turn.handle = undefined;
    handle.waitForUser(ask.card.question, '', ask.card.options.map((o) => ({ label: o.label })));
  }

  private answer(turn: Turn, handle: TurnHandle, text: string): void {
    const ask = turn.asks.shift()!;
    this.settle(turn.sessionId, ask);
    turn.handle = handle;
    turn.lastHandle = handle;
    const reply = text.trim();
    this.transcript.append(turn.sessionId, turn.cwd, { uuid: randomUUID(), role: 'USER', content: reply, timestamp: now() });
    const choice = chooseOption(ask.options, reply);
    if (choice) {
      ask.resolve({ outcome: 'selected', optionId: choice.optionId });
    } else {
      // Words instead of a choice: decline, and give the agent the words once this turn ends.
      const reject = rejectOption(ask.options);
      ask.resolve(reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' });
      turn.followUp = turn.followUp ? `${turn.followUp}\n\n${reply}` : reply;
    }
    if (turn.asks.length) this.present(turn);
    else handle.progress('Continuing', '');
  }

  private settle(sessionId: string, ask: Ask): void {
    this.settled.set(sessionId, choices(ask.options.map((o) => o.name)));
  }

  /** The turn is ending with requests unanswered: they are cancelled, and their cards closed. */
  private abandonAsks(turn: Turn): void {
    if (turn.asks[0]) this.settle(turn.sessionId, turn.asks[0]);
    for (const ask of turn.asks.splice(0)) {
      this.transcript.closeCard(turn.sessionId, ask.uuid);
      ask.resolve({ outcome: 'cancelled' });
    }
  }

  private flushText(turn: Turn): void {
    const text = turn.text;
    turn.text = null;
    if (!text || !text.content.trim()) return;
    const entry: Entry = { uuid: randomUUID(), role: 'AGENT', content: text.content, timestamp: now() };
    this.transcript.append(turn.sessionId, turn.cwd, entry);
    turn.lastText = text.content;
    this.sink.agentText(turn.sessionId, entry);
  }

  private finish(turn: Turn, stopReason: StopReason): void {
    if (turn.ended) return;
    turn.ended = true;
    // A stopped turn keeps what it had said; only what arrives after the stop is dropped.
    this.flushText(turn);
    this.abandonAsks(turn);
    if (this.turns.get(turn.sessionId) === turn) this.turns.delete(turn.sessionId);
    turn.end();
    const handle = turn.handle ?? turn.lastHandle;
    const sessionId = turn.sessionId;

    if (turn.stopped) {
      this.endRun(sessionId, handle, (h) => h.complete(''));
      return;
    }
    if (turn.followUp) {
      // The reply that turned down a permission is what the user wants instead,
      // however the agent ended the turn it declined. It is already recorded.
      void this.enqueue(sessionId, turn.cwd, handle, turn.followUp, undefined, false);
      return;
    }
    const waiting = this.waiting(sessionId) > 0;
    if (stopReason === 'refusal') {
      const message = `${this.agent.name} declined to continue with this request.`;
      if (!waiting) {
        this.endRun(sessionId, handle, (h) => h.error(message));
        return;
      }
      this.note(turn, `_${message}_`);
    }
    const limit = LIMIT_NOTES[stopReason];
    if (limit) this.note(turn, limit);
    if (waiting) {
      // The next message carries the session on; ending this task would tell every
      // app the session is idle while that one runs.
      const earlier = this.superseded.get(sessionId) ?? [];
      if (!earlier.includes(handle)) earlier.push(handle);
      this.superseded.set(sessionId, earlier);
      return;
    }
    if (stopReason === 'cancelled') {
      this.endRun(sessionId, handle, (h) => h.complete(''));
      return;
    }
    this.endRun(sessionId, handle, (h) => h.complete(turn.lastText));
    const count = this.transcript.get(sessionId)?.entries.length ?? 0;
    this.sink.finished(sessionId, turn.lastText, count);
  }

  /**
   * End the session's run: the last task, and any a queued message took over that
   * the server knows by another id – a first turn still under its PENDING id – so
   * no task is left open. Tasks under the same id are already ended by the last.
   */
  private endRun(sessionId: string, last: TurnHandle, end: (handle: TurnHandle) => void): void {
    const seen = new Set([last.taskId]);
    for (const handle of this.superseded.get(sessionId) ?? []) {
      if (seen.has(handle.taskId)) continue;
      seen.add(handle.taskId);
      handle.complete('');
    }
    this.superseded.delete(sessionId);
    end(last);
  }

  /**
   * A message Stop kept from running. The user's words stay in the history, where
   * the app already shows them; the agent never sees them, and the task ends.
   */
  private keepUnsent(sessionId: string, cwd: string, handle: TurnHandle, text: string): void {
    this.transcript.append(sessionId, cwd, { uuid: randomUUID(), role: 'USER', content: text, timestamp: now() });
    handle.complete('');
  }

  /** Messages waiting behind the session's turn will not run. */
  private dropQueued(sessionId: string): void {
    if (this.waiting(sessionId) > 0) this.stops.set(sessionId, (this.stops.get(sessionId) ?? 0) + 1);
  }

  private note(turn: Turn, content: string): void {
    const entry: Entry = { uuid: randomUUID(), role: 'AGENT', content, timestamp: now() };
    this.transcript.append(turn.sessionId, turn.cwd, entry);
    this.sink.agentText(turn.sessionId, entry);
    turn.lastText = content;
  }

  private fail(turn: Turn, err: Error): void {
    if (turn.ended) return;
    if (turn.stopped) {
      this.finish(turn, 'cancelled');
      return;
    }
    turn.ended = true;
    this.flushText(turn);
    this.abandonAsks(turn);
    if (this.turns.get(turn.sessionId) === turn) this.turns.delete(turn.sessionId);
    // A failure ends the run: messages waiting behind it are not sent into a broken session.
    this.dropQueued(turn.sessionId);
    turn.end();
    this.endRun(turn.sessionId, turn.handle ?? turn.lastHandle, (h) => h.error(err.message || 'The agent failed'));
  }
}

/**
 * A session's history as `session/load` replays it: chunks of user and agent
 * text, gathered into messages. Ids are derived from the session and position so
 * that replaying the same history twice yields the same ids.
 */
export class Replay {
  private list: Entry[] = [];
  private open: { role: 'USER' | 'AGENT'; messageId?: string } | null = null;
  private base = Date.now();

  constructor(private readonly sessionId: string) {}

  add(update: SessionUpdate): void {
    const kind = update.sessionUpdate;
    if (kind === 'user_message_chunk' || kind === 'agent_message_chunk') {
      const { content, messageId } = update as { content: ContentBlock; messageId?: string | null };
      if (content?.type !== 'text' || typeof content.text !== 'string') return;
      const role = kind === 'user_message_chunk' ? 'USER' : 'AGENT';
      // An agent's reply streams in chunks, so chunks without ids join the reply.
      // A user's message replays whole: Qwen Code sends each prompt as one chunk and
      // stores back-to-back prompts as separate messages, so without ids each
      // user chunk is its own message, never glued to the one before.
      const sameMessage = this.open && this.open.role === role && (messageId
        ? messageId === this.open.messageId
        : role === 'AGENT' && !this.open.messageId);
      if (!sameMessage) {
        this.open = { role, messageId: messageId ?? undefined };
        this.list.push({ uuid: this.idFor(this.list.length), role, content: '', timestamp: '' });
      }
      this.list[this.list.length - 1].content += content.text;
    } else if (kind === 'tool_call') {
      this.open = null;
    }
  }

  entries(): Entry[] {
    const kept = this.list.filter((e) => e.content.trim());
    // A replay carries no times; spacing them a millisecond apart keeps them in order.
    return kept.map((e, i) => ({ ...e, timestamp: new Date(this.base - (kept.length - i)).toISOString() }));
  }

  private idFor(index: number): string {
    return createHash('sha1').update(`${this.sessionId}:${index}`).digest('hex').slice(0, 32);
  }
}

function choices(labels: string[]): Set<string> {
  return new Set(labels.map((l) => l.trim().toLowerCase()));
}

function definedFields(fields: ToolCallFields): Partial<ToolCallFields> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out as Partial<ToolCallFields>;
}

function now(): string {
  return new Date().toISOString();
}
