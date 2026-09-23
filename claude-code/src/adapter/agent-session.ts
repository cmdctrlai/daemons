import { query, type Query, type SDKUserMessage, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { MessageQueue } from './message-queue';
import { PendingQuestions } from './pending-questions';
import { buildUserMessage } from './user-message';
import { firstQuestion, type AskUserInput, type StreamEvent } from './events';

/**
 * Tools the agent may use without asking. AskUserQuestion is deliberately
 * absent: listing it here auto-approves the call before `canUseTool` is
 * consulted, which silently disables the whole ask-the-user flow.
 */
export const ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'LSP',
  'Task',
  'TodoWrite',
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
];

export interface AgentSessionOptions {
  taskId: string;
  cwd?: string;
  /** Session to continue. Omit to start a new one. */
  resume?: string;
  /** How long an unanswered question may hold the turn open. */
  questionTimeoutMs: number;
  onStreamEvent: (taskId: string, event: StreamEvent) => void;
  onQuestion: (taskId: string, sessionId: string, input: AskUserInput) => void;
  onError: (taskId: string, error: Error) => void;
  onClosed: (sessionId: string) => void;
}

/**
 * One long-lived agent conversation.
 *
 * The SDK is fed by a streaming queue rather than a fresh `-p --resume` per
 * turn, so a later message reaches a turn that is already running and an
 * AskUserQuestion can be answered after a trip to someone's phone.
 */
export class AgentSession {
  /** Empty until the agent reports it on system/init. */
  sessionId: string;
  taskId: string;

  private readonly inbox = new MessageQueue<SDKUserMessage>();
  private readonly abortController = new AbortController();
  private readonly pending = new PendingQuestions();
  private readonly opts: AgentSessionOptions;
  private readonly q: Query;
  private closed = false;

  constructor(opts: AgentSessionOptions) {
    this.opts = opts;
    this.taskId = opts.taskId;
    this.sessionId = opts.resume ?? '';

    this.q = query({
      prompt: this.inbox,
      options: {
        cwd: opts.cwd,
        resume: opts.resume,
        permissionMode: 'acceptEdits',
        allowedTools: ALLOWED_TOOLS,
        abortController: this.abortController,
        canUseTool: (toolName, input) => this.decidePermission(toolName, input),
      },
    });

    void this.consume();
  }

  /** Queue a turn. Lands mid-turn if one is already running. */
  send(taskId: string, text: string, images?: string[]): void {
    if (this.closed) throw new Error(`session ${this.sessionId} is closed`);
    this.taskId = taskId;
    this.inbox.push(buildUserMessage(text, images));
  }

  /**
   * Route a reply to an open question.
   * Returns false when none is open, so the caller sends it as a normal turn.
   */
  answerQuestion(taskId: string, reply: string): boolean {
    if (!this.pending.has(this.sessionId)) return false;
    this.taskId = taskId;
    return this.pending.answer(this.sessionId, reply);
  }

  /**
   * Release an open question unanswered, so the turn parked inside the tool
   * call ends and the agent can read the message that arrived instead.
   */
  cancelQuestion(reason: string): boolean {
    return this.pending.cancel(this.sessionId, reason);
  }

  /** Whether a message is a reply to the open question rather than a new turn. */
  isAnswer(text: string, images?: string[]): boolean {
    return this.pending.isAnswer(this.sessionId, text, images);
  }

  hasOpenQuestion(): boolean {
    return this.pending.has(this.sessionId);
  }

  /**
   * Stop the current turn but keep the session usable.
   * `interrupt()` never settles against a wedged child, so the abort is the
   * backstop rather than the first move.
   */
  async interrupt(timeoutMs = 5000): Promise<void> {
    this.pending.cancel(this.sessionId, 'The user cancelled.');
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.q.interrupt(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('interrupt timed out')), timeoutMs);
        }),
      ]);
    } catch {
      this.abortController.abort();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Tear the session down for good. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.cancelAll('The session is closing.');
    this.abortController.abort();
    if (!this.inbox.isClosed) this.inbox.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * AskUserQuestion parks until someone answers; everything else outside the
   * allowlist is denied, which surfaces to the app as a permission request.
   */
  private decidePermission(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<PermissionResult> {
    if (toolName !== 'AskUserQuestion') {
      return Promise.resolve({
        behavior: 'deny',
        message: `${toolName} requires approval.`,
      });
    }

    const askInput = input as unknown as AskUserInput;
    // Parking a question nobody can be shown hangs the tool call until the
    // question budget runs out. Deny it now so the agent can call again.
    if (!firstQuestion(askInput)) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'AskUserQuestion needs a questions array whose first question has text and labelled options.',
      });
    }
    this.opts.onQuestion(this.taskId, this.sessionId, askInput);
    return this.pending.park(this.sessionId, askInput, this.opts.questionTimeoutMs);
  }

  /** Drain the agent's output for the life of the session. */
  private async consume(): Promise<void> {
    try {
      for await (const message of this.q) {
        const event = message as unknown as StreamEvent;
        if (event.type === 'system' && event.session_id) {
          this.adoptSessionId(event.session_id);
        }
        this.opts.onStreamEvent(this.taskId, event);
      }
    } catch (err) {
      // interrupt() and abort() both end the loop by throwing. That is a
      // cancel, not a crash.
      if (!this.abortController.signal.aborted) {
        this.opts.onError(this.taskId, err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.closed = true;
      this.pending.cancelAll('The session ended.');
      this.opts.onClosed(this.sessionId);
    }
  }

  /**
   * A new session learns its id from the agent. Questions parked under the
   * placeholder have to move with it.
   */
  private adoptSessionId(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    const hadQuestion = this.pending.has(this.sessionId);
    if (hadQuestion) {
      this.pending.cancel(this.sessionId, 'The session id changed before the question was answered.');
    }
    this.sessionId = sessionId;
  }
}
