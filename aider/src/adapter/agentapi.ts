import * as pty from 'node-pty';
import { IPty } from 'node-pty';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventSource, ErrorEvent } from 'eventsource';

const DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const AGENTAPI_PORT = 3284;
const AGENTAPI_STARTUP_TIMEOUT = 60000; // 60 seconds to wait for agentapi to start (Aider needs time for repo map)

// Find agentapi binary
function findAgentApi(): string {
  if (process.env.AGENTAPI_PATH) {
    return process.env.AGENTAPI_PATH;
  }

  const home = os.homedir();
  const commonPaths = [
    path.join(home, '.local', 'bin', 'agentapi'),
    '/usr/local/bin/agentapi',
    '/opt/homebrew/bin/agentapi',
    'agentapi' // Fall back to PATH
  ];

  for (const p of commonPaths) {
    if (p === 'agentapi') return p;
    try {
      if (fs.existsSync(p)) {
        return p;
      }
    } catch {
      continue;
    }
  }

  return 'agentapi';
}

// Find aider binary
function findAider(): string {
  if (process.env.AIDER_PATH) {
    return process.env.AIDER_PATH;
  }

  const home = os.homedir();
  const commonPaths = [
    path.join(home, '.local', 'bin', 'aider'),
    '/usr/local/bin/aider',
    '/opt/homebrew/bin/aider',
    'aider' // Fall back to PATH
  ];

  for (const p of commonPaths) {
    if (p === 'aider') return p;
    try {
      if (fs.existsSync(p)) {
        return p;
      }
    } catch {
      continue;
    }
  }

  return 'aider';
}

const AGENTAPI_PATH = findAgentApi();
const AIDER_PATH = findAider();

console.log(`[AiderAdapter] Using agentapi path: ${AGENTAPI_PATH}`);
console.log(`[AiderAdapter] Using aider path: ${AIDER_PATH}`);

interface RunningTask {
  taskId: string;
  sessionId: string;  // For aider, we generate a session ID
  context: string;
  agentApiProcess: IPty | null;
  eventSource: EventSource | null;
  timeoutHandle: NodeJS.Timeout | null;
  port: number;
  lastStatus: 'stable' | 'running';
  firstSpinnerEmitted: boolean;  // Track if we've shown the first spinner message
  lastCompletedMessageId: number; // Highest message ID included in last TASK_COMPLETE (tracks per-exchange boundary)
  messageOffset: number;  // Cumulative message ID offset across process restarts
  maxMessageId: number;   // Highest AgentAPI message ID seen in this run
}

export interface QuestionOption {
  label: string;
  description?: string;
}

type EventCallback = (
  taskId: string,
  eventType: string,
  data: Record<string, unknown>
) => void;

export class AiderAdapter {
  private running: Map<string, RunningTask> = new Map();
  private sessionIdToTaskId: Map<string, string> = new Map();  // Reverse mapping: sessionId -> taskId
  private sessionMessageOffset: Map<string, number> = new Map();  // Persists across process restarts
  private onEvent: EventCallback;
  private nextPort = AGENTAPI_PORT;

  constructor(onEvent: EventCallback) {
    this.onEvent = onEvent;
  }

  /**
   * Get next available port for AgentAPI
   */
  private getNextPort(): number {
    // Simple port allocation - in production you'd want to check if port is free
    const port = this.nextPort;
    this.nextPort++;
    if (this.nextPort > AGENTAPI_PORT + 100) {
      this.nextPort = AGENTAPI_PORT; // Wrap around
    }
    return port;
  }

  /**
   * Start a new task by launching AgentAPI with Aider
   */
  async startTask(
    taskId: string,
    instruction: string,
    projectPath?: string,
    existingSessionId?: string
  ): Promise<void> {
    console.log(`[${taskId}] Starting Aider task: ${instruction.substring(0, 50)}...`);

    const port = this.getNextPort();
    // Reuse existing session ID if provided (e.g. resuming after process exit),
    // otherwise generate a new one to resolve PENDING placeholder in database
    const sessionId = existingSessionId ?? `aider-${crypto.randomUUID()}`;

    // Restore message offset from previous runs so IDs don't collide across restarts
    const messageOffset = this.sessionMessageOffset.get(sessionId) ?? 0;

    const rt: RunningTask = {
      taskId,
      sessionId,
      context: '',
      agentApiProcess: null,
      eventSource: null,
      timeoutHandle: null,
      port,
      lastStatus: 'stable',
      firstSpinnerEmitted: false,
      lastCompletedMessageId: 0,  // id=0 is always the aider startup banner – skip it
      messageOffset,
      maxMessageId: -1
    };

    this.running.set(taskId, rt);
    this.sessionIdToTaskId.set(sessionId, taskId);  // Register reverse mapping

    // Determine working directory
    let cwd = os.homedir();
    if (projectPath && fs.existsSync(projectPath)) {
      cwd = projectPath;
    } else if (projectPath) {
      console.log(`[${taskId}] Warning: project path does not exist: ${projectPath}`);
      this.onEvent(taskId, 'WARNING', {
        warning: `Project path "${projectPath}" does not exist. Running in home directory.`
      });
    }

    // Build AgentAPI command
    // agentapi server --port <port> -- aider [aider options]
    const args = [
      'server',
      '--port', port.toString(),
      '--type', 'aider',
      '--',
      AIDER_PATH,
      '--yes-always'  // Auto-accept changes for automation
    ];

    // Add model if specified in environment
    if (process.env.AIDER_MODEL) {
      args.push('--model', process.env.AIDER_MODEL);
    }

    console.log(`[${taskId}] Spawning: ${AGENTAPI_PATH} ${args.join(' ')} in ${cwd}`);

    try {
      // Use node-pty to spawn agentapi with a proper PTY
      // This is required because agentapi uses terminal emulation internally
      const proc = pty.spawn(AGENTAPI_PATH, args, {
        name: 'xterm-color',
        cols: 120,
        rows: 40,
        cwd,
        env: process.env as { [key: string]: string }
      });

      rt.agentApiProcess = proc;

      // Log output for debugging (PTY combines stdout/stderr)
      proc.onData((data) => {
        console.log(`[${taskId}] agentapi output: ${data.substring(0, 200)}`);
      });

      proc.onExit(({ exitCode }) => {
        console.log(`[${taskId}] AgentAPI process exited with code ${exitCode}`);
        this.cleanup(taskId);
      });

      // Wait for AgentAPI to be ready
      await this.waitForAgentApi(taskId, port);

      // Set up SSE event stream
      this.connectEventStream(taskId, port, rt);

      // Set timeout
      rt.timeoutHandle = setTimeout(() => {
        console.log(`[${taskId}] Task timed out`);
        this.onEvent(taskId, 'ERROR', { error: 'execution timeout' });
        this.cancelTask(taskId);
      }, DEFAULT_TIMEOUT);

      // Send the initial instruction
      await this.sendMessage(taskId, port, instruction);

    } catch (err) {
      console.error(`[${taskId}] Failed to start AgentAPI:`, err);
      this.onEvent(taskId, 'ERROR', { error: (err as Error).message });
      this.cleanup(taskId);
    }
  }

  /**
   * Resume a task - for Aider, this just sends another message
   */
  async resumeTask(
    taskId: string,
    sessionId: string,
    message: string,
    projectPath?: string
  ): Promise<void> {
    console.log(`[${taskId}] Resuming Aider task with message`);

    let rt = this.running.get(taskId);

    // If not found by the new task ID, look for the original process still running
    // under a different key (e.g. PENDING resolved to a real session ID)
    if (!rt) {
      const originalTaskId = this.sessionIdToTaskId.get(sessionId);
      if (originalTaskId && originalTaskId !== taskId) {
        rt = this.running.get(originalTaskId);
        if (rt) {
          console.log(`[${taskId}] Found original process under ${originalTaskId}, reusing`);
          // Register the new task ID so future lookups work
          this.running.set(taskId, rt);
          this.sessionIdToTaskId.set(sessionId, taskId);
          this.running.delete(originalTaskId);
        }
      }
    }

    if (!rt) {
      // Task not running (process exited), restart with same session ID
      console.log(`[${taskId}] Task not found, restarting with existing session ID`);
      return this.startTask(taskId, message, projectPath, sessionId);
    }

    try {
      await this.sendMessage(taskId, rt.port, message);
    } catch (err) {
      console.error(`[${taskId}] Failed to send message:`, err);
      this.onEvent(taskId, 'ERROR', { error: (err as Error).message });
    }
  }

  /**
   * Cancel a running task
   */
  async cancelTask(taskId: string): Promise<void> {
    console.log(`[${taskId}] Cancelling task`);
    this.cleanup(taskId);
  }

  /**
   * Stop all running tasks
   */
  async stopAll(): Promise<void> {
    for (const taskId of this.running.keys()) {
      await this.cancelTask(taskId);
    }
  }

  /**
   * Get list of running task IDs
   */
  getRunningTasks(): string[] {
    return Array.from(this.running.keys());
  }

  /**
   * Get messages for a session from AgentAPI
   * Returns messages if the session's AgentAPI is running, null otherwise
   * @param id - Either the canonical taskId or the generated sessionId
   */
  async getMessages(id: string): Promise<{ id: number; role: string; content: string; time: string }[] | null> {
    // First try as taskId (canonical ID)
    let rt = this.running.get(id);

    // If not found, try as sessionId using reverse mapping
    if (!rt) {
      const taskId = this.sessionIdToTaskId.get(id);
      if (taskId) {
        rt = this.running.get(taskId);
      }
    }

    if (!rt) {
      console.log(`[${id}] Cannot get messages - task not running (checked both taskId and sessionId)`);
      return null;
    }

    try {
      const response = await fetch(`http://localhost:${rt.port}/messages`);
      if (!response.ok) {
        console.log(`[${id}] Failed to fetch messages: ${response.status}`);
        return null;
      }

      const data = await response.json() as { messages: { id: number; role: string; content: string; time: string }[] };
      // Apply message offset so IDs are globally unique across process restarts
      return (data.messages || []).map(m => ({ ...m, id: m.id + rt.messageOffset }));
    } catch (err) {
      console.error(`[${id}] Error fetching messages:`, (err as Error).message);
      return null;
    }
  }

  /**
   * Get the port for a running task's AgentAPI
   */
  getTaskPort(taskId: string): number | null {
    const rt = this.running.get(taskId);
    return rt ? rt.port : null;
  }

  /**
   * Get the original task ID that owns the agentapi process for a given session.
   * Used by the event router to alias old task IDs to new resume task IDs.
   */
  getOriginalTaskId(sessionId: string): string | null {
    const taskId = this.sessionIdToTaskId.get(sessionId);
    return taskId ?? null;
  }

  /**
   * Wait for AgentAPI server to be ready and agent to be stable
   *
   * AgentAPI requires the agent status to be "stable" before accepting messages.
   * When first started, Aider may be "running" while it builds the repo map.
   */
  private async waitForAgentApi(taskId: string, port: number): Promise<void> {
    const startTime = Date.now();
    const url = `http://localhost:${port}/status`;

    // First, wait for the server to be up
    let serverUp = false;
    while (Date.now() - startTime < AGENTAPI_STARTUP_TIMEOUT) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          serverUp = true;
          break;
        }
      } catch {
        // Not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (!serverUp) {
      throw new Error(`AgentAPI failed to start within ${AGENTAPI_STARTUP_TIMEOUT}ms`);
    }

    console.log(`[${taskId}] AgentAPI server up on port ${port}, waiting for stable status...`);

    // Now wait for the agent to be stable (not running/initializing)
    while (Date.now() - startTime < AGENTAPI_STARTUP_TIMEOUT) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json() as { status: string };
          if (data.status === 'stable') {
            console.log(`[${taskId}] AgentAPI ready and stable on port ${port}`);
            return;
          }
          console.log(`[${taskId}] AgentAPI status: ${data.status}, waiting for stable...`);
        }
      } catch (err) {
        console.log(`[${taskId}] Error checking status:`, (err as Error).message);
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error(`Agent failed to reach stable status within ${AGENTAPI_STARTUP_TIMEOUT}ms`);
  }

  /**
   * Connect to AgentAPI SSE event stream
   *
   * AgentAPI sends named events: 'message_update' and 'status_change'
   * We need to listen for these specifically (onmessage only handles unnamed events)
   */
  private connectEventStream(taskId: string, port: number, rt: RunningTask): void {
    const url = `http://localhost:${port}/events`;
    console.log(`[${taskId}] Connecting to SSE stream: ${url}`);

    const es = new EventSource(url);
    rt.eventSource = es;

    // Handle message_update events (agent messages)
    es.addEventListener('message_update', (event) => {
      try {
        const data = JSON.parse(event.data as string);
        console.log(`[${taskId}] SSE message_update:`, JSON.stringify(data).substring(0, 100));
        this.handleMessageUpdate(taskId, data, rt);
      } catch (err) {
        console.error(`[${taskId}] Failed to parse message_update:`, err);
      }
    });

    // Handle status_change events
    es.addEventListener('status_change', (event) => {
      try {
        const data = JSON.parse(event.data as string);
        console.log(`[${taskId}] SSE status_change:`, data.status);
        this.handleStatusChange(taskId, data, rt);
      } catch (err) {
        console.error(`[${taskId}] Failed to parse status_change:`, err);
      }
    });

    // Fallback for any unnamed events
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        console.log(`[${taskId}] SSE unnamed event:`, JSON.stringify(data).substring(0, 100));
        this.handleAgentApiEvent(taskId, data, rt);
      } catch (err) {
        console.error(`[${taskId}] Failed to parse SSE event:`, err);
      }
    };

    es.onerror = (err) => {
      const errorEvent = err as ErrorEvent;
      console.error(`[${taskId}] SSE error:`, errorEvent.message || 'unknown error');
      // Don't cleanup here - AgentAPI might still be running
    };
  }

  /**
   * Check if a message is a spinner/progress line that should be filtered
   * These lines use \r to overwrite in terminal but create noise in our UI
   */
  private isSpinnerLine(message: string): boolean {
    // Spinner characters
    if (message.includes('░') || message.includes('█')) {
      return true;
    }
    // Common progress patterns (partial lines without timestamps)
    if (message.includes('Waiting for anthropic/') || message.includes('Updating repo map:')) {
      return true;
    }
    return false;
  }

  /**
   * Handle message_update SSE event
   */
  private handleMessageUpdate(
    taskId: string,
    event: { id: number; role: string; message: string; time: string },
    rt: RunningTask
  ): void {
    // Track highest message ID to compute offset for next process restart
    if (event.id > rt.maxMessageId) {
      rt.maxMessageId = event.id;
    }

    if (event.role === 'agent') {
      if (!event.message.trim()) return;

      // Emit one spinner OUTPUT bubble for progress indication; skip subsequent ones.
      // The final answer is fetched clean from /messages when status goes stable.
      if (this.isSpinnerLine(event.message)) {
        if (!rt.firstSpinnerEmitted) {
          rt.firstSpinnerEmitted = true;
          const cleanMessage = event.message.replace(/[░█]+/g, '').trim();
          if (cleanMessage) {
            this.onEvent(taskId, 'OUTPUT', { output: cleanMessage, session_id: rt.sessionId });
          }
        }
        return;
      }

      // Non-spinner streaming content (e.g. thinking/reasoning lines) – emit for live display
      this.onEvent(taskId, 'OUTPUT', { output: event.message, session_id: rt.sessionId });
    }
  }

  /**
   * Handle status_change SSE event
   */
  private handleStatusChange(
    taskId: string,
    event: { status: string; agent_type: string },
    rt: RunningTask
  ): void {
    const newStatus = event.status as 'stable' | 'running';

    // Detect transition from running -> stable (task completed)
    if (rt.lastStatus === 'running' && newStatus === 'stable') {
      console.log(`[${taskId}] Task completed (running -> stable)`);
      if (rt.maxMessageId >= 0) {
        this.sessionMessageOffset.set(rt.sessionId, rt.messageOffset + rt.maxMessageId + 1);
      }
      // Fetch clean final messages from agentapi – the streaming message_update events
      // contain spinner animation noise; /messages has the final clean content.
      this.fetchAndComplete(taskId, rt);
    }

    rt.lastStatus = newStatus;
  }

  /**
   * Fetch final messages from agentapi /messages and emit TASK_COMPLETE.
   * Uses lastCompletedMessageId to find only messages from this exchange.
   */
  private async fetchAndComplete(taskId: string, rt: RunningTask): Promise<void> {
    let result = '';
    try {
      const response = await fetch(`http://localhost:${rt.port}/messages`);
      if (response.ok) {
        const data = await response.json() as { messages: { id: number; role: string; content: string }[] };
        const msgs = data.messages ?? [];
        const newAgentMsgs = msgs.filter(m => m.role === 'agent' && m.id > rt.lastCompletedMessageId);
        result = newAgentMsgs.map(m => m.content).join('\n\n').trim();
        if (msgs.length > 0) {
          rt.lastCompletedMessageId = Math.max(...msgs.map(m => m.id));
        }
        console.log(`[${taskId}] Completion result (${result.length} chars): ${result.substring(0, 100)}`);
      }
    } catch (err) {
      console.error(`[${taskId}] Failed to fetch messages for completion:`, err);
    }
    // Reset spinner state for the next exchange
    rt.firstSpinnerEmitted = false;
    rt.context = '';
    this.onEvent(taskId, 'TASK_COMPLETE', { session_id: rt.sessionId, result });
  }

  /**
   * Handle an event from AgentAPI
   */
  private handleAgentApiEvent(
    taskId: string,
    event: { type: string; [key: string]: unknown },
    rt: RunningTask
  ): void {
    console.log(`[${taskId}] AgentAPI event:`, JSON.stringify(event).substring(0, 200));

    if (event.type === 'status') {
      const newStatus = event.status as 'stable' | 'running';

      // Detect transition from running -> stable (task completed)
      if (rt.lastStatus === 'running' && newStatus === 'stable') {
        console.log(`[${taskId}] Task completed (running -> stable)`);
        this.onEvent(taskId, 'TASK_COMPLETE', {
          session_id: rt.sessionId,
          result: rt.context
        });
      }

      rt.lastStatus = newStatus;
    } else if (event.type === 'message') {
      // Message from the agent
      const content = event.content as string || '';
      const role = event.role as string || 'assistant';

      if (role === 'assistant') {
        // Skip spinner/progress lines
        if (this.isSpinnerLine(content)) {
          return;
        }

        // Accumulate context
        if (rt.context) {
          rt.context += '\n\n';
        }
        rt.context += content;

        // Emit output for streaming display (include session_id to resolve PENDING)
        this.onEvent(taskId, 'OUTPUT', { output: content, session_id: rt.sessionId });

        // Check if aider is asking for input
        // Aider typically asks questions ending with ? or prompts for y/n
        if (this.looksLikeQuestion(content)) {
          console.log(`[${taskId}] Detected question from Aider`);
          this.onEvent(taskId, 'WAIT_FOR_USER', {
            session_id: rt.sessionId,
            prompt: this.extractQuestion(content),
            options: [],
            context: rt.context
          });
        }
      }
    }
  }

  /**
   * Check if content looks like a question/prompt
   */
  private looksLikeQuestion(content: string): boolean {
    const lower = content.toLowerCase().trim();

    // Common Aider prompts
    const questionPatterns = [
      /\?\s*$/,  // Ends with question mark
      /\(y\/n\)/i,  // Yes/no prompt
      /\[y\/n\]/i,
      /proceed\?/i,
      /continue\?/i,
      /confirm/i,
      /would you like/i,
      /do you want/i,
      /should i/i
    ];

    return questionPatterns.some(pattern => pattern.test(lower));
  }

  /**
   * Extract the question from content
   */
  private extractQuestion(content: string): string {
    // Take the last few lines which typically contain the question
    const lines = content.trim().split('\n');
    const lastLines = lines.slice(-3).join('\n');
    return lastLines.length > 200 ? lastLines.substring(0, 200) + '...' : lastLines;
  }

  /**
   * Send a message to AgentAPI
   */
  private async sendMessage(taskId: string, port: number, content: string): Promise<void> {
    const url = `http://localhost:${port}/message`;
    console.log(`[${taskId}] Sending message to AgentAPI`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content,
        type: 'user'
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.status} ${response.statusText}`);
    }

    console.log(`[${taskId}] Message sent successfully`);
  }

  /**
   * Clean up a task
   */
  private cleanup(taskId: string): void {
    const rt = this.running.get(taskId);
    if (!rt) return;

    if (rt.timeoutHandle) {
      clearTimeout(rt.timeoutHandle);
    }

    if (rt.eventSource) {
      rt.eventSource.close();
    }

    if (rt.agentApiProcess) {
      rt.agentApiProcess.kill();
    }

    // Persist message offset so the next process restart continues from where this left off
    if (rt.sessionId && rt.maxMessageId >= 0) {
      this.sessionMessageOffset.set(rt.sessionId, rt.messageOffset + rt.maxMessageId + 1);
    }

    // Clean up reverse mapping
    if (rt.sessionId) {
      this.sessionIdToTaskId.delete(rt.sessionId);
    }

    this.running.delete(taskId);
    console.log(`[${taskId}] Task cleaned up`);
  }
}
