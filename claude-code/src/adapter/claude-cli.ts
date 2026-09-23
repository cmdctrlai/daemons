import * as fs from 'fs';
import * as os from 'os';
import {
  StreamEvent,
  AskUserInput,
  QuestionOption,
  extractProgressFromToolUse,
  firstQuestion
} from './events';
import { findSessionFile } from '../message-reader';
import { rewriteSdkCliEntrypoint } from './entrypoint-rewrite';
import { KeyedMutex } from './keyed-mutex';
import { deliverToBgSession } from './claude-daemon';
import { AgentSession } from './agent-session';

const DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes
/** An unanswered question holds a turn open no longer than this. */
const QUESTION_TIMEOUT = 60 * 60 * 1000; // 1 hour

/**
 * Read the last user message UUID from a session JSONL file
 * Used for associating verbose output with the triggering user message
 */
function getLastUserMessageUuid(sessionId: string): string | undefined {
  const filePath = findSessionFile(sessionId);
  if (!filePath) {
    console.log(`[getLastUserMessageUuid] File not found for session ${sessionId}`);
    return undefined;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    let lastUserUuid: string | undefined;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === 'user' && typeof entry.uuid === 'string') {
          lastUserUuid = entry.uuid;
        }
      } catch {
        continue;
      }
    }
    return lastUserUuid;
  } catch (err) {
    console.error(`[getLastUserMessageUuid] Failed to read ${filePath}:`, err);
    return undefined;
  }
}

/** Per-turn state accumulated from the agent's stream. */
interface TurnState {
  question: string;
  options: QuestionOption[];
  context: string;
  timeoutHandle: NodeJS.Timeout | null;
  userMessageUuid?: string;
  planContent?: string;
}

type EventCallback = (
  taskId: string,
  eventType: string,
  data: Record<string, unknown>
) => void;

/**
 * Called with the slash commands the CLI advertised for a run's working
 * directory. Not an agent event – it describes the environment, not the task.
 */
type SlashCommandsCallback = (project: string, commands: string[]) => void;

/** Resolve the project path, falling back to home when it no longer exists. */
function resolveCwd(taskId: string, projectPath: string | undefined, onEvent?: EventCallback): string | undefined {
  if (!projectPath) return undefined;
  if (fs.existsSync(projectPath)) return projectPath;

  console.log(`[${taskId}] Warning: project path does not exist: ${projectPath}, using home dir`);
  onEvent?.(taskId, 'WARNING', {
    warning: `Project path "${projectPath}" does not exist. Running in home directory instead.`
  });
  return os.homedir();
}

export class ClaudeAdapter {
  /** One live agent per session id, once the agent has reported one. */
  private sessions: Map<string, AgentSession> = new Map();
  /** Every live agent, including one that has not reported its id yet. */
  private live: Set<AgentSession> = new Set();
  /** Turn state, keyed by task id. */
  private turns: Map<string, TurnState> = new Map();
  private onEvent: EventCallback;
  private onSlashCommands?: SlashCommandsCallback;
  /**
   * Serializes session creation per session id. Two agents on one transcript
   * fork it and silently orphan a turn.
   */
  private createLock = new KeyedMutex();

  constructor(onEvent: EventCallback, onSlashCommands?: SlashCommandsCallback) {
    this.onEvent = onEvent;
    this.onSlashCommands = onSlashCommands;
  }

  /**
   * Start a new task
   */
  async startTask(
    taskId: string,
    instruction: string,
    projectPath?: string,
    images?: string[]
  ): Promise<void> {
    console.log(`[${taskId}] Starting task: ${instruction.substring(0, 50)}...`);

    const cwd = resolveCwd(taskId, projectPath, this.onEvent);
    const session = this.createSession(taskId, cwd);

    this.beginTurn(taskId);
    session.send(taskId, instruction, images);
  }

  /**
   * Resume a task with user's reply.
   *
   * A session we already hold takes the message directly – mid-turn if one is
   * running, or as the answer to an open question. Otherwise we adopt the
   * session by resuming it.
   */
  async resumeTask(
    taskId: string,
    sessionId: string,
    message: string,
    projectPath?: string,
    images?: string[]
  ): Promise<void> {
    console.log(`[${taskId}] ===== RESUME TASK START =====`);
    console.log(`[${taskId}] Session: ${sessionId.slice(-8)}, Message: "${message.slice(0, 50)}..."`);

    const live = this.sessions.get(sessionId);
    if (live && !live.isClosed) {
      // The turn this session was already serving hands its watchdog over to the
      // new task. Left running it would fire on a task nothing is serving any
      // more and report a bogus execution timeout on a healthy session.
      if (live.taskId && live.taskId !== taskId) {
        this.endTurn(live.taskId);
      }

      // An open question consumes the reply as its answer, so the agent
      // resumes inside the tool call instead of being told again afterwards.
      // Anything that is not an answer releases the question instead, so the
      // turn unparks and the message is delivered as the user meant it.
      if (live.hasOpenQuestion()) {
        if (live.isAnswer(message, images)) {
          live.answerQuestion(taskId, message);
          console.log(`[${taskId}] Answered open question on session ${sessionId.slice(-8)}`);
          this.beginTurn(taskId);
          return;
        }
        live.cancelQuestion('The user sent a new message instead of answering.');
        console.log(`[${taskId}] Released open question on session ${sessionId.slice(-8)}`);
      }
      console.log(`[${taskId}] Delivered to live session ${sessionId.slice(-8)}`);
      this.beginTurn(taskId);
      live.send(taskId, message, images);
      return;
    }

    // Sessions held by a supervised background agent are not ours to resume –
    // the control socket is the only way in.
    const outcome = await deliverToBgSession(sessionId, message);
    if (outcome.delivered) {
      console.log(`[${taskId}] Delivered to live background agent via control socket`);
      this.onEvent(taskId, 'SESSION_STARTED', { session_id: sessionId });
      return;
    }
    if (outcome.reason !== 'not-bg') {
      console.log(`[${taskId}] Background delivery unavailable (${outcome.reason}${outcome.code ? `: ${outcome.code}` : ''}), resuming directly`);
    }

    const releaseLock = await this.createLock.acquire(sessionId);
    try {
      const existing = this.sessions.get(sessionId);
      if (existing && !existing.isClosed) {
        this.beginTurn(taskId);
        existing.send(taskId, message, images);
        return;
      }

      const cwd = resolveCwd(taskId, projectPath, this.onEvent);
      const session = this.createSession(taskId, cwd, sessionId);
      this.beginTurn(taskId);
      session.send(taskId, message, images);
    } finally {
      releaseLock();
    }
  }

  /**
   * Cancel a running task
   */
  async cancelTask(taskId: string): Promise<void> {
    const turn = this.turns.get(taskId);
    if (!turn) {
      console.log(`[${taskId}] Task not found for cancellation`);
      return;
    }

    this.endTurn(taskId);

    const session = this.sessionForTask(taskId);
    if (session) {
      await session.interrupt();
    }
    console.log(`[${taskId}] Task cancelled`);
  }

  /**
   * Stop all running tasks
   */
  async stopAll(): Promise<void> {
    for (const taskId of Array.from(this.turns.keys())) {
      console.log(`[${taskId}] Stopping task`);
      this.endTurn(taskId);
    }
    for (const session of this.live) {
      session.close();
    }
    this.live.clear();
    this.sessions.clear();
    this.turns.clear();
  }

  /**
   * Get list of running task IDs
   */
  getRunningTasks(): string[] {
    return Array.from(this.turns.keys());
  }

  /** Stand up an agent and wire its output back to the daemon's events. */
  private createSession(taskId: string, cwd?: string, resume?: string): AgentSession {
    console.log(`[${taskId}] Starting agent${resume ? ` (resume ${resume.slice(-8)})` : ''} with cwd: ${cwd || 'default'}`);

    const session = new AgentSession({
      taskId,
      cwd,
      resume,
      questionTimeoutMs: QUESTION_TIMEOUT,
      onStreamEvent: (tid, event) => this.handleStreamEvent(tid, event, session),
      onQuestion: (tid, sessionId, input) => this.emitQuestion(tid, sessionId, input),
      onError: (tid, err) => {
        console.error(`[${tid}] Agent error:`, err);
        this.endTurn(tid);
        this.onEvent(tid, 'ERROR', { error: err.message });
      },
      onClosed: (sessionId) => {
        this.live.delete(session);
        if (this.sessions.get(sessionId) === session) {
          this.sessions.delete(sessionId);
        }
        // Sessions the SDK wrote are stamped entrypoint:"sdk-cli"; rewrite so
        // they appear in the user's own `claude --resume` picker.
        if (sessionId) rewriteSdkCliEntrypoint(sessionId);
      },
    });

    this.live.add(session);
    if (resume) {
      this.sessions.set(resume, session);
    }
    return session;
  }

  /** Find the session currently serving a task. */
  private sessionForTask(taskId: string): AgentSession | undefined {
    for (const session of this.live) {
      if (session.taskId === taskId) return session;
    }
    return undefined;
  }

  /** Start the clock on a turn. */
  private beginTurn(taskId: string): void {
    this.endTurn(taskId);

    const turn: TurnState = {
      question: '',
      options: [],
      context: '',
      timeoutHandle: null,
      userMessageUuid: undefined,
    };

    this.armTurnTimer(taskId, turn, DEFAULT_TIMEOUT);
    this.turns.set(taskId, turn);
  }

  /** (Re)start a turn's watchdog. Replaces any timer already on the turn. */
  private armTurnTimer(taskId: string, turn: TurnState, timeoutMs: number): void {
    if (turn.timeoutHandle) clearTimeout(turn.timeoutHandle);
    turn.timeoutHandle = setTimeout(() => {
      console.log(`[${taskId}] Task timed out`);
      const session = this.sessionForTask(taskId);
      void session?.interrupt();
      this.turns.delete(taskId);
      this.onEvent(taskId, 'ERROR', { error: 'execution timeout' });
    }, timeoutMs);
  }

  /** Clear a turn's timer and forget it. */
  private endTurn(taskId: string): void {
    const turn = this.turns.get(taskId);
    if (!turn) return;
    if (turn.timeoutHandle) clearTimeout(turn.timeoutHandle);
    this.turns.delete(taskId);
  }

  /**
   * Surface an AskUserQuestion to the app. The tool call stays open until the
   * answer comes back, so this is a prompt rather than a completed turn.
   */
  private emitQuestion(taskId: string, sessionId: string, input: AskUserInput): void {
    const q = firstQuestion(input);
    if (!q) return;

    const turn = this.turns.get(taskId);
    if (turn) {
      turn.question = q.question;
      turn.options = q.options;
      // A parked question emits nothing until the user answers, so the ordinary
      // turn watchdog would interrupt the session and deny the tool call while
      // the question is still sitting on someone's phone. Hand the turn the
      // question's own budget instead; answering starts a fresh normal turn.
      this.armTurnTimer(taskId, turn, QUESTION_TIMEOUT);
    }
    console.log(`[${taskId}] Question detected: ${q.question}`);

    this.onEvent(taskId, 'WAIT_FOR_USER', {
      session_id: sessionId,
      prompt: q.question,
      options: q.options,
      context: turn?.context ?? '',
      user_message_uuid: turn?.userMessageUuid,
      permission_tool: 'AskUserQuestion',
    });
  }

  /**
   * Handle a parsed stream event from the agent
   */
  private handleStreamEvent(
    taskId: string,
    event: StreamEvent,
    session: AgentSession
  ): void {
    console.log(`[${taskId}] Event: type=${event.type}, subtype=${event.subtype || 'none'}`);
    if (event.permission_denials?.length) {
      console.log(`[${taskId}] Permission denials:`, JSON.stringify(event.permission_denials));
    }

    const turn = this.turns.get(taskId);

    switch (event.type) {
      case 'system':
        // The CLI enumerates the project's slash commands on every init, which is
        // the only place they can be learned without spending a turn on a probe.
        if (event.subtype === 'init' && event.cwd && event.slash_commands?.length) {
          this.onSlashCommands?.(event.cwd, event.slash_commands);
        }
        if (event.subtype === 'init' && event.session_id) {
          console.log(`[${taskId}] Session initialized: ${event.session_id}`);
          this.sessions.set(event.session_id, session);
          this.onEvent(taskId, 'SESSION_STARTED', {
            session_id: event.session_id
          });
        }
        break;

      case 'assistant':
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'thinking') {
              continue;
            }

            // Accumulate text for context
            if (block.type === 'text' && block.text) {
              // Strip <thinking>...</thinking> tags (may be embedded in text)
              const text = block.text.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trim();
              if (text && turn) {
                if (turn.context) {
                  turn.context += '\n\n';
                }
                turn.context += text;
              }
            }

            // Track tool use for progress
            if (block.type === 'tool_use' && block.name) {
              const progress = extractProgressFromToolUse(
                block.name,
                block.input
              );
              if (progress) {
                this.onEvent(taskId, 'PROGRESS', {
                  action: progress.action,
                  target: progress.target
                });
              }

              // Store plan content for the WAIT_FOR_USER emission below
              if (block.name === 'ExitPlanMode' && block.input && turn) {
                const planInput = block.input as Record<string, unknown>;
                turn.planContent = (planInput.plan as string) || (planInput.content as string) || '';
                console.log(`[${taskId}] Plan mode detected, plan content length: ${turn.planContent.length}`);
              }
            }
          }
        }
        break;

      case 'result': {
        // A denial means the agent needs approval it could not get on its own.
        // An AskUserQuestion denial is the exception: it is this adapter's own
        // doing – a question released or timed out – and the tool exists to ask
        // the user something, so there is no permission for them to grant.
        const denials = (event.permission_denials ?? []).filter(
          (denial) => denial.tool_name !== 'AskUserQuestion'
        );
        if (denials.length) {
          const firstDenial = denials[0];

          let prompt = turn?.question ?? '';
          const options = turn?.options ?? [];

          if (!prompt) {
            const toolName = firstDenial.tool_name;
            if (toolName === 'ExitPlanMode') {
              prompt = 'Plan ready for approval';
            } else {
              prompt = `Permission required for: ${toolName}`;
              if (denials.length > 1) {
                prompt += ` (and ${denials.length - 1} more)`;
              }
            }
          }

          if (turn?.planContent && firstDenial.tool_name === 'ExitPlanMode') {
            turn.context = turn.planContent;
          }

          console.log(`[${taskId}] Task waiting for user input - tool: ${firstDenial.tool_name}, prompt: ${prompt}`);

          this.onEvent(taskId, 'WAIT_FOR_USER', {
            session_id: session.sessionId,
            prompt: prompt,
            options: options,
            context: turn?.context ?? '',
            user_message_uuid: turn?.userMessageUuid,
            permission_tool: firstDenial.tool_name
          });
          return;
        }

        // Re-read the UUID at completion: the first assistant event can arrive
        // before the triggering user message is on disk.
        if (session.sessionId && turn) {
          const freshUuid = getLastUserMessageUuid(session.sessionId);
          if (freshUuid) {
            turn.userMessageUuid = freshUuid;
          }
        }
        console.log(`[${taskId}] EMITTING TASK_COMPLETE with uuid=${turn?.userMessageUuid?.slice(-8) || 'none'}`);

        const finalResult = turn?.context || event.result || '';
        const userMessageUuid = turn?.userMessageUuid;
        this.endTurn(taskId);
        this.onEvent(taskId, 'TASK_COMPLETE', {
          session_id: session.sessionId,
          result: finalResult,
          user_message_uuid: userMessageUuid
        });
        break;
      }
    }
  }
}
