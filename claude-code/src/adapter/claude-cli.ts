import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  StreamEvent,
  AskUserInput,
  QuestionOption,
  extractProgressFromToolUse
} from './events';
import { findSessionFile } from '../message-reader';

const DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes

// Find claude CLI in common locations
function findClaudeCli(): string {
  if (process.env.CLAUDE_CODE_CLI_PATH) {
    return process.env.CLAUDE_CODE_CLI_PATH;
  }

  const home = os.homedir();
  const commonPaths = [
    path.join(home, '.local', 'bin', 'claude'),        // New standalone installer
    path.join(home, '.npm-global', 'bin', 'claude'),    // Legacy npm global
    path.join(home, '.nvm', 'versions', 'node', 'v20.18.0', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    'claude' // Fall back to PATH
  ];

  for (const p of commonPaths) {
    if (p === 'claude') return p; // PATH fallback
    try {
      if (fs.existsSync(p)) {
        return p;
      }
    } catch {
      continue;
    }
  }

  return 'claude'; // Fall back to PATH
}

// Resolve on each use so path changes (reinstalls) are picked up without daemon restart
function getClaudeCli(): string {
  const p = findClaudeCli();
  return p;
}

// Build a clean environment for spawned Claude CLI processes.
// Strips CLAUDECODE to avoid the "nested session" guard that was
// added in recent Claude Code versions.
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

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

    // Count user messages for debugging
    let userMessageCount = 0;
    let lastUserUuid: string | undefined;
    let lastUserContent: string | undefined;

    // Find the last user message UUID (iterate backwards)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'user' && entry.uuid) {
          userMessageCount++;
          if (!lastUserUuid) {
            lastUserUuid = entry.uuid;
            // Get first 50 chars of message content for debugging
            if (entry.message?.content) {
              const msgContent = typeof entry.message.content === 'string'
                ? entry.message.content
                : JSON.stringify(entry.message.content);
              lastUserContent = msgContent.substring(0, 50);
            }
          }
        }
      } catch {
        continue;
      }
    }

    console.log(`[getLastUserMessageUuid] Found ${userMessageCount} user messages, last UUID: ${lastUserUuid}, content: "${lastUserContent}"`);
    return lastUserUuid;
  } catch (err) {
    console.log(`[getLastUserMessageUuid] File read error:`, err);
  }

  return undefined;
}

// Allowed tools for Claude CLI
const ALLOWED_TOOLS = [
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
  'AskUserQuestion'  // Required for pause/resume workflow
].join(',');

interface RunningTask {
  taskId: string;
  sessionId: string;
  question: string;
  options: QuestionOption[];
  context: string;
  process: ChildProcess | null;
  timeoutHandle: NodeJS.Timeout | null;
  userMessageUuid?: string; // UUID of the triggering user message (for verbose output positioning)
  planContent?: string; // Stored plan content from ExitPlanMode for WAIT_FOR_USER emission
}

type EventCallback = (
  taskId: string,
  eventType: string,
  data: Record<string, unknown>
) => void;

export class ClaudeAdapter {
  private running: Map<string, RunningTask> = new Map();
  private onEvent: EventCallback;

  constructor(onEvent: EventCallback) {
    this.onEvent = onEvent;
  }

  /**
   * Start a new task
   */
  async startTask(
    taskId: string,
    instruction: string,
    projectPath?: string
  ): Promise<void> {
    console.log(`[${taskId}] Starting task: ${instruction.substring(0, 50)}...`);

    const rt: RunningTask = {
      taskId,
      sessionId: '',
      question: '',
      options: [],
      context: '',
      process: null,
      timeoutHandle: null
    };

    this.running.set(taskId, rt);

    // Validate cwd exists
    let cwd: string | undefined = undefined;
    if (projectPath && fs.existsSync(projectPath)) {
      cwd = projectPath;
    } else if (projectPath) {
      console.log(`[${taskId}] Warning: project path does not exist: ${projectPath}, using home dir`);
      cwd = os.homedir();
      // Notify user that the path doesn't exist
      this.onEvent(taskId, 'WARNING', {
        warning: `Project path "${projectPath}" does not exist. Running in home directory instead.`
      });
    }

    // Build command arguments
    const args = [
      '-p', instruction,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', ALLOWED_TOOLS
    ];

    console.log(`[${taskId}] Spawning: ${getClaudeCli()} with cwd: ${cwd || 'default'}`);

    // Spawn Claude CLI (no shell - direct execution preserves arguments correctly)
    const proc = spawn(getClaudeCli(), args, {
      cwd,
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    rt.process = proc;

    // Set timeout
    rt.timeoutHandle = setTimeout(() => {
      console.log(`[${taskId}] Task timed out`);
      proc.kill('SIGKILL');
      this.onEvent(taskId, 'ERROR', { error: 'execution timeout' });
    }, DEFAULT_TIMEOUT);

    // Handle process events
    this.handleProcessOutput(taskId, proc, rt);
  }

  /**
   * Resume a task with user's reply
   * Falls back to startTask if session doesn't exist
   */
  async resumeTask(
    taskId: string,
    sessionId: string,
    message: string,
    projectPath?: string
  ): Promise<void> {
    console.log(`[${taskId}] ===== RESUME TASK START =====`);
    console.log(`[${taskId}] Session: ${sessionId.slice(-8)}, Message: "${message.slice(0, 50)}..."`);

    const rt: RunningTask = {
      taskId,
      sessionId,
      question: '',
      options: [],
      context: '',
      process: null,
      timeoutHandle: null,
      userMessageUuid: undefined
    };

    // Note: userMessageUuid starts as undefined - will be read from JSONL on first assistant event
    console.log(`[${taskId}] Initial state: sessionId=${sessionId.slice(-8)}, userMessageUuid=none`);

    this.running.set(taskId, rt);

    // Validate cwd exists (same logic as startTask)
    let cwd: string | undefined = undefined;
    if (projectPath && fs.existsSync(projectPath)) {
      cwd = projectPath;
    } else if (projectPath) {
      console.log(`[${taskId}] Warning: project path does not exist: ${projectPath}, using home dir`);
      cwd = os.homedir();
    }

    // Build command arguments with --resume
    const args = [
      '-p', message,
      '--resume', sessionId,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', ALLOWED_TOOLS
    ];

    console.log(`[${taskId}] Spawning resume: ${getClaudeCli()} --resume ${sessionId} with cwd: ${cwd || 'default'}`);

    // Spawn Claude CLI with same cwd as original task (no shell - direct execution)
    const proc = spawn(getClaudeCli(), args, {
      cwd,
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    rt.process = proc;

    // Track if we've seen the "no conversation found" error
    let sessionNotFound = false;
    let stderrBuffer = '';

    // Check stderr for session not found error
    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      stderrBuffer += text;
      console.log(`[${taskId}] stderr: ${text}`);
      if (text.includes('No conversation found')) {
        sessionNotFound = true;
      }
    });

    // Handle quick exit with session not found - fall back to new session
    proc.on('close', (code) => {
      if (code !== 0 && sessionNotFound) {
        console.log(`[${taskId}] Session ${sessionId} not found, falling back to new session`);
        // Clean up this attempt
        if (rt.timeoutHandle) {
          clearTimeout(rt.timeoutHandle);
        }
        this.running.delete(taskId);
        // Start fresh instead
        this.startTask(taskId, message, projectPath);
        return;
      }
      // Normal exit handling
      console.log(`[${taskId}] Process exited with code ${code}`);
      if (rt.timeoutHandle) {
        clearTimeout(rt.timeoutHandle);
      }
      this.running.delete(taskId);
    });

    // Set timeout
    rt.timeoutHandle = setTimeout(() => {
      console.log(`[${taskId}] Task timed out`);
      proc.kill('SIGKILL');
      this.onEvent(taskId, 'ERROR', { error: 'execution timeout' });
    }, DEFAULT_TIMEOUT);

    // Handle process events (but skip the close handler since we handle it above)
    this.handleProcessOutputWithoutClose(taskId, proc, rt);
  }

  /**
   * Cancel a running task
   */
  async cancelTask(taskId: string): Promise<void> {
    const rt = this.running.get(taskId);
    if (!rt) {
      console.log(`[${taskId}] Task not found for cancellation`);
      return;
    }

    if (rt.process) {
      rt.process.kill('SIGTERM');
    }
    if (rt.timeoutHandle) {
      clearTimeout(rt.timeoutHandle);
    }

    this.running.delete(taskId);
    console.log(`[${taskId}] Task cancelled`);
  }

  /**
   * Stop all running tasks
   */
  async stopAll(): Promise<void> {
    for (const [taskId, rt] of this.running) {
      console.log(`[${taskId}] Stopping task`);
      if (rt.process) {
        rt.process.kill('SIGTERM');
      }
      if (rt.timeoutHandle) {
        clearTimeout(rt.timeoutHandle);
      }
    }
    this.running.clear();
  }

  /**
   * Get list of running task IDs
   */
  getRunningTasks(): string[] {
    return Array.from(this.running.keys());
  }

  /**
   * Handle process stdout/stderr and emit events
   */
  private handleProcessOutput(
    taskId: string,
    proc: ChildProcess,
    rt: RunningTask
  ): void {
    // Create readline interface for NDJSON parsing
    const rl = readline.createInterface({
      input: proc.stdout!,
      crlfDelay: Infinity
    });

    // Parse each line as JSON to track state (userMessageUuid)
    // NOTE: Verbose output is now handled by SessionWatcher via JSONL-based VERBOSE events
    // We still parse stream events here to track userMessageUuid for TASK_COMPLETE
    rl.on('line', (line) => {
      try {
        const event = JSON.parse(line) as StreamEvent;
        this.handleStreamEvent(taskId, event, rt);
      } catch {
        // Not valid JSON, skip
      }
    });

    // Log stderr
    proc.stderr?.on('data', (data) => {
      console.log(`[${taskId}] stderr: ${data.toString()}`);
    });

    // Handle process exit
    proc.on('close', (code) => {
      console.log(`[${taskId}] Process exited with code ${code}`);

      if (rt.timeoutHandle) {
        clearTimeout(rt.timeoutHandle);
      }
      this.running.delete(taskId);
    });

    proc.on('error', (err) => {
      console.error(`[${taskId}] Process error:`, err);
      this.onEvent(taskId, 'ERROR', { error: err.message });

      if (rt.timeoutHandle) {
        clearTimeout(rt.timeoutHandle);
      }
      this.running.delete(taskId);
    });
  }

  /**
   * Handle process stdout and emit events (without close handler - for resumeTask fallback)
   */
  private handleProcessOutputWithoutClose(
    taskId: string,
    proc: ChildProcess,
    rt: RunningTask
  ): void {
    // Create readline interface for NDJSON parsing
    const rl = readline.createInterface({
      input: proc.stdout!,
      crlfDelay: Infinity
    });

    // Parse each line as JSON to track state (userMessageUuid)
    // NOTE: Verbose output is now handled by SessionWatcher via JSONL-based VERBOSE events
    // We still parse stream events here to track userMessageUuid for TASK_COMPLETE
    rl.on('line', (line) => {
      try {
        const event = JSON.parse(line) as StreamEvent;
        this.handleStreamEvent(taskId, event, rt);
      } catch {
        // Not valid JSON, skip
      }
    });

    // Note: stderr is handled by resumeTask caller
    // Note: close is handled by resumeTask caller

    proc.on('error', (err) => {
      console.error(`[${taskId}] Process error:`, err);
      this.onEvent(taskId, 'ERROR', { error: err.message });

      if (rt.timeoutHandle) {
        clearTimeout(rt.timeoutHandle);
      }
      this.running.delete(taskId);
    });
  }

  /**
   * Handle a parsed stream event from Claude CLI
   */
  private handleStreamEvent(
    taskId: string,
    event: StreamEvent,
    rt: RunningTask
  ): void {
    // Debug logging for all events
    console.log(`[${taskId}] Event: type=${event.type}, subtype=${event.subtype || 'none'}`);
    if (event.permission_denials?.length) {
      console.log(`[${taskId}] Permission denials:`, JSON.stringify(event.permission_denials));
    }

    switch (event.type) {
      case 'system':
        if (event.subtype === 'init' && event.session_id) {
          rt.sessionId = event.session_id;
          console.log(`[${taskId}] Session initialized: ${event.session_id}`);
          // DON'T read UUID here - Claude CLI hasn't written the new user message yet
          // The frontend has the correct UUID from when the user sent the message
          // By not setting UUID here, frontend will use its verboseOutputUserUuid fallback
          // Emit SESSION_STARTED to trigger file watching for unified notifications
          this.onEvent(taskId, 'SESSION_STARTED', {
            session_id: event.session_id
          });
        }
        break;

      case 'assistant':
        // DON'T read UUID here - Claude may not have written the new user message to JSONL yet
        // Reading now would get the PREVIOUS message's UUID, causing wrong positioning
        // The frontend has the correct UUID from when the user sent the message
        // We only read UUID at TASK_COMPLETE where we need it for the final message
        console.log(`[${taskId}] assistant event: currentUuid=${rt.userMessageUuid?.slice(-8) || 'none'}, sessionId=${rt.sessionId?.slice(-8) || 'none'}`);
        if (event.message?.content) {
          for (const block of event.message.content) {
            // Skip thinking blocks if they come as separate type
            if (block.type === 'thinking') {
              continue;
            }

            // Accumulate text for context
            if (block.type === 'text' && block.text) {
              // Strip <thinking>...</thinking> tags (may be embedded in text)
              const text = block.text.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trim();
              if (text) {
                if (rt.context) {
                  rt.context += '\n\n';
                }
                rt.context += text;
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

              // Check for AskUserQuestion
              if (block.name === 'AskUserQuestion' && block.input) {
                const input = block.input as AskUserInput;
                if (input.questions?.length > 0) {
                  const q = input.questions[0];
                  rt.question = q.question;
                  rt.options = q.options || [];
                  console.log(`[${taskId}] Question detected: ${q.question}`);
                }
              }

              // Check for ExitPlanMode — store plan content for WAIT_FOR_USER emission
              if (block.name === 'ExitPlanMode' && block.input) {
                const planInput = block.input as Record<string, unknown>;
                rt.planContent = (planInput.plan as string) || (planInput.content as string) || '';
                console.log(`[${taskId}] Plan mode detected, plan content length: ${rt.planContent.length}`);
              }
            }
          }
        }
        break;

      case 'result':
        // Check for permission denials (user input needed)
        if (event.permission_denials?.length) {
          // Any permission denial means the task is waiting for user input
          const denials = event.permission_denials;
          const firstDenial = denials[0];

          // Build a descriptive prompt based on the denied tool
          let prompt = rt.question; // Use AskUserQuestion prompt if available
          let options = rt.options;

          if (!prompt) {
            // Construct prompt from permission denial info
            const toolName = firstDenial.tool_name;
            if (toolName === 'AskUserQuestion') {
              prompt = 'Agent is asking a question';
            } else if (toolName === 'ExitPlanMode') {
              prompt = 'Plan ready for approval';
            } else {
              // Permission request for file/bash operations
              prompt = `Permission required for: ${toolName}`;
              if (denials.length > 1) {
                prompt += ` (and ${denials.length - 1} more)`;
              }
            }
          }

          // Use plan content as context if available (from ExitPlanMode detection)
          if (rt.planContent && firstDenial.tool_name === 'ExitPlanMode') {
            rt.context = rt.planContent;
          }

          console.log(`[${taskId}] Task waiting for user input - tool: ${firstDenial.tool_name}, prompt: ${prompt}`);

          this.onEvent(taskId, 'WAIT_FOR_USER', {
            session_id: rt.sessionId,
            prompt: prompt,
            options: options,
            context: rt.context,
            user_message_uuid: rt.userMessageUuid,
            permission_tool: firstDenial.tool_name
          });
          return;
        }

        // Task completed - re-read the UUID to ensure we have the correct one
        // (the first assistant event may arrive before the JSONL is fully written)
        console.log(`[${taskId}] TASK_COMPLETE: checking UUID. Current=${rt.userMessageUuid?.slice(-8) || 'none'}`);
        if (rt.sessionId) {
          console.log(`[${taskId}] Re-reading UUID from JSONL at completion...`);
          const freshUuid = getLastUserMessageUuid(rt.sessionId);
          console.log(`[${taskId}] Fresh UUID from JSONL: ${freshUuid?.slice(-8) || 'none'}`);
          if (freshUuid && freshUuid !== rt.userMessageUuid) {
            console.log(`[${taskId}] UUID UPDATED at completion: ${rt.userMessageUuid?.slice(-8) || 'none'} -> ${freshUuid.slice(-8)}`);
            rt.userMessageUuid = freshUuid;
          } else if (freshUuid === rt.userMessageUuid) {
            console.log(`[${taskId}] UUID unchanged at completion: ${freshUuid?.slice(-8) || 'none'}`);
          }
        }
        console.log(`[${taskId}] EMITTING TASK_COMPLETE with uuid=${rt.userMessageUuid?.slice(-8) || 'none'}`);
        // Use accumulated context as result, fall back to event.result
        const finalResult = rt.context || event.result || '';
        this.onEvent(taskId, 'TASK_COMPLETE', {
          session_id: rt.sessionId,
          result: finalResult,
          user_message_uuid: rt.userMessageUuid
        });
        break;
    }
  }
}
