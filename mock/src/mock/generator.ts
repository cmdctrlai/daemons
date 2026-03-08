import { MockConfig, DEFAULT_MOCK_CONFIG } from '../config/config';
import { EventType } from '../client/messages';

export interface MockEvent {
  eventType: EventType;
  data: Record<string, unknown>;
}

export interface QuestionOption {
  label: string;
  value: string;
}

/**
 * Get a random number between min and max (inclusive)
 */
function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Sleep for a random duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate a unique session ID for mock sessions
 */
export function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `mock-${timestamp}-${random}`;
}

/**
 * Generate a UUID for messages
 */
export function generateUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Message commands parsed from user input
 */
interface MessageCommands {
  sleepMs?: number;
  showTools?: boolean;
  simulateError?: boolean;
  askQuestion?: boolean;
  cleanedInstruction: string;
}

/**
 * Parse message commands from instruction
 * Commands: /sleep <ms>, /delay <ms>, /tools, /progress, /error, /ask, /question
 */
function parseMessageCommands(instruction: string): MessageCommands {
  let cleanedInstruction = instruction;
  let sleepMs: number | undefined;
  let showTools = false;
  let simulateError = false;
  let askQuestion = false;

  // Parse /sleep or /delay
  const sleepMatch = cleanedInstruction.match(/^\/(sleep|delay)\s+(\d+)\s*/i);
  if (sleepMatch) {
    sleepMs = parseInt(sleepMatch[2], 10);
    cleanedInstruction = cleanedInstruction.slice(sleepMatch[0].length);
  }

  // Parse /tools or /progress
  if (/^\/(tools|progress)\s*/i.test(cleanedInstruction)) {
    showTools = true;
    cleanedInstruction = cleanedInstruction.replace(/^\/(tools|progress)\s*/i, '');
  }

  // Parse /error
  if (/^\/error\s*/i.test(cleanedInstruction)) {
    simulateError = true;
    cleanedInstruction = cleanedInstruction.replace(/^\/error\s*/i, '');
  }

  // Parse /ask or /question
  if (/^\/(ask|question)\s*/i.test(cleanedInstruction)) {
    askQuestion = true;
    cleanedInstruction = cleanedInstruction.replace(/^\/(ask|question)\s*/i, '');
  }

  return {
    sleepMs,
    showTools,
    simulateError,
    askQuestion,
    cleanedInstruction: cleanedInstruction.trim()
  };
}

/**
 * Mock event generator for simulating AI agent behavior
 */
export class MockGenerator {
  private config: MockConfig;
  private runningTasks: Map<string, { cancelled: boolean; sessionId: string }> = new Map();

  constructor(config: Partial<MockConfig> = {}) {
    this.config = { ...DEFAULT_MOCK_CONFIG, ...config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<MockConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Check if a task is running
   */
  isRunning(taskId: string): boolean {
    return this.runningTasks.has(taskId);
  }

  /**
   * Get all running task IDs
   */
  getRunningTasks(): string[] {
    return Array.from(this.runningTasks.keys());
  }

  /**
   * Get session ID for a task
   */
  getSessionId(taskId: string): string | undefined {
    return this.runningTasks.get(taskId)?.sessionId;
  }

  /**
   * Cancel a task
   */
  cancelTask(taskId: string): void {
    const task = this.runningTasks.get(taskId);
    if (task) {
      task.cancelled = true;
    }
  }

  /**
   * Stop all tasks
   */
  stopAll(): void {
    for (const [, task] of this.runningTasks) {
      task.cancelled = true;
    }
    this.runningTasks.clear();
  }

  /**
   * Generate verbose output lines based on the instruction
   */
  private generateOutputLines(instruction: string, projectPath?: string): string[] {
    const lines: string[] = [];
    const count = randomBetween(
      this.config.outputLineCount.min,
      this.config.outputLineCount.max
    );

    // Extract keywords from instruction for realistic output
    const keywords = instruction.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const targetFile = projectPath
      ? `${projectPath}/src/main.ts`
      : '/project/src/main.ts';

    const templates = [
      `Analyzing your request about: "${instruction.substring(0, 50)}${instruction.length > 50 ? '...' : ''}"`,
      `Reading ${targetFile} to understand the codebase...`,
      `Searching for patterns related to: ${keywords.slice(0, 3).join(', ')}`,
      `Found relevant code sections to examine`,
      `Analyzing dependencies and imports...`,
      `Checking for existing implementations...`,
      `Reviewing code structure and patterns...`,
      `Preparing response based on analysis...`,
      `Considering best practices for this change...`,
      `Validating approach against project conventions...`,
    ];

    for (let i = 0; i < count && i < templates.length; i++) {
      lines.push(templates[i]);
    }

    return lines;
  }

  /**
   * Generate progress events
   */
  private generateProgressEvents(instruction: string, projectPath?: string, overrideCount?: number): Array<{ action: string; target: string }> {
    const events: Array<{ action: string; target: string }> = [];
    const count = overrideCount ?? randomBetween(
      this.config.progressEventCount.min,
      this.config.progressEventCount.max
    );

    const basePath = projectPath || '/project';
    const actions = [
      { action: 'Reading', target: `${basePath}/src/index.ts` },
      { action: 'Searching', target: instruction.split(' ').slice(0, 3).join(' ') },
      { action: 'Reading', target: `${basePath}/package.json` },
      { action: 'Analyzing', target: `${basePath}/src/` },
      { action: 'Reading', target: `${basePath}/README.md` },
      { action: 'Writing', target: `${basePath}/src/output.ts` },
      { action: 'Running', target: 'npm test' },
      { action: 'Editing', target: `${basePath}/src/main.ts` },
    ];

    for (let i = 0; i < count && i < actions.length; i++) {
      events.push(actions[i]);
    }

    return events;
  }

  /**
   * Generate a mock question for WAIT_FOR_USER
   */
  private generateQuestion(instruction: string): { prompt: string; options: QuestionOption[]; context: string } {
    const questions = [
      {
        prompt: 'How would you like me to proceed with this task?',
        options: [
          { label: 'Continue with default approach', value: 'default' },
          { label: 'Show me the plan first', value: 'plan' },
          { label: 'Cancel', value: 'cancel' }
        ],
        context: `I've analyzed your request: "${instruction.substring(0, 100)}"`
      },
      {
        prompt: 'Should I make changes to the files I found?',
        options: [
          { label: 'Yes, make changes', value: 'yes' },
          { label: 'No, just show what you would change', value: 'preview' },
          { label: 'Cancel', value: 'cancel' }
        ],
        context: 'I found some files that may need modification.'
      },
      {
        prompt: 'Which approach would you prefer?',
        options: [
          { label: 'Simple and quick', value: 'simple' },
          { label: 'More thorough', value: 'thorough' }
        ],
        context: 'There are multiple ways to accomplish this.'
      }
    ];

    return questions[Math.floor(Math.random() * questions.length)];
  }

  /**
   * Generate the final result message
   */
  private generateResult(instruction: string): string {
    return `${this.config.echoPrefix}${instruction}`;
  }

  /**
   * Run a mock task (new session)
   */
  async *runTask(
    taskId: string,
    instruction: string,
    projectPath?: string
  ): AsyncGenerator<MockEvent> {
    const sessionId = generateSessionId();
    const userMessageUuid = generateUuid();

    // Parse message commands
    const commands = parseMessageCommands(instruction);

    this.runningTasks.set(taskId, { cancelled: false, sessionId });

    try {
      // Emit SESSION_STARTED
      yield {
        eventType: 'SESSION_STARTED',
        data: { session_id: sessionId }
      };

      // Apply custom sleep if specified
      if (commands.sleepMs) {
        await sleep(commands.sleepMs);
      } else {
        // Default initial delay
        await sleep(randomBetween(
          this.config.responseDelayMs.min,
          this.config.responseDelayMs.max
        ));
      }

      if (this.runningTasks.get(taskId)?.cancelled) return;

      // Generate and emit OUTPUT events
      const outputLines = this.generateOutputLines(commands.cleanedInstruction, projectPath);
      for (const output of outputLines) {
        if (this.runningTasks.get(taskId)?.cancelled) return;

        yield {
          eventType: 'OUTPUT',
          data: { output, user_message_uuid: userMessageUuid }
        };

        await sleep(randomBetween(
          this.config.outputIntervalMs.min,
          this.config.outputIntervalMs.max
        ));
      }

      // Generate and emit PROGRESS events (more if /tools requested)
      const progressCount = commands.showTools ? randomBetween(5, 8) : undefined;
      const progressEvents = this.generateProgressEvents(commands.cleanedInstruction, projectPath, progressCount);
      for (const progress of progressEvents) {
        if (this.runningTasks.get(taskId)?.cancelled) return;

        yield {
          eventType: 'PROGRESS',
          data: { action: progress.action, target: progress.target }
        };

        await sleep(randomBetween(
          this.config.thinkingTimeMs.min,
          this.config.thinkingTimeMs.max
        ));
      }

      if (this.runningTasks.get(taskId)?.cancelled) return;

      // Check for error (forced by /error or random)
      if (commands.simulateError || Math.random() < this.config.errorProbability) {
        yield {
          eventType: 'ERROR',
          data: { error: commands.simulateError ? `Error: ${commands.cleanedInstruction}` : 'Simulated error for testing purposes' }
        };
        return;
      }

      // Check for question (forced by /ask or random)
      if (commands.askQuestion || Math.random() < this.config.askQuestionProbability) {
        const question = this.generateQuestion(commands.cleanedInstruction);
        yield {
          eventType: 'WAIT_FOR_USER',
          data: {
            session_id: sessionId,
            prompt: commands.askQuestion ? commands.cleanedInstruction || question.prompt : question.prompt,
            options: question.options,
            context: question.context,
            user_message_uuid: userMessageUuid
          }
        };
        return; // Wait for resume
      }

      // Complete the task
      yield {
        eventType: 'TASK_COMPLETE',
        data: {
          session_id: sessionId,
          result: this.generateResult(commands.cleanedInstruction),
          user_message_uuid: userMessageUuid
        }
      };

    } finally {
      this.runningTasks.delete(taskId);
    }
  }

  /**
   * Resume a task after user response
   */
  async *resumeTask(
    taskId: string,
    sessionId: string,
    message: string,
    projectPath?: string
  ): AsyncGenerator<MockEvent> {
    const userMessageUuid = generateUuid();

    // Parse message commands
    const commands = parseMessageCommands(message);

    this.runningTasks.set(taskId, { cancelled: false, sessionId });

    try {
      // Apply custom sleep if specified
      if (commands.sleepMs) {
        await sleep(commands.sleepMs);
      } else {
        // Default initial delay
        await sleep(randomBetween(
          this.config.responseDelayMs.min,
          this.config.responseDelayMs.max
        ));
      }

      if (this.runningTasks.get(taskId)?.cancelled) return;

      // Emit some output about processing the response
      yield {
        eventType: 'OUTPUT',
        data: {
          output: `Processing your response: "${commands.cleanedInstruction.substring(0, 50)}${commands.cleanedInstruction.length > 50 ? '...' : ''}"`,
          user_message_uuid: userMessageUuid
        }
      };

      await sleep(randomBetween(
        this.config.outputIntervalMs.min,
        this.config.outputIntervalMs.max
      ));

      if (this.runningTasks.get(taskId)?.cancelled) return;

      // Generate progress events if /tools requested
      if (commands.showTools) {
        const progressCount = randomBetween(5, 8);
        const progressEvents = this.generateProgressEvents(commands.cleanedInstruction, projectPath, progressCount);
        for (const progress of progressEvents) {
          if (this.runningTasks.get(taskId)?.cancelled) return;

          yield {
            eventType: 'PROGRESS',
            data: { action: progress.action, target: progress.target }
          };

          await sleep(randomBetween(
            this.config.thinkingTimeMs.min,
            this.config.thinkingTimeMs.max
          ));
        }
      }

      if (this.runningTasks.get(taskId)?.cancelled) return;

      // Check for error
      if (commands.simulateError) {
        yield {
          eventType: 'ERROR',
          data: { error: `Error: ${commands.cleanedInstruction}` }
        };
        return;
      }

      // Check for question
      if (commands.askQuestion) {
        const question = this.generateQuestion(commands.cleanedInstruction);
        yield {
          eventType: 'WAIT_FOR_USER',
          data: {
            session_id: sessionId,
            prompt: commands.cleanedInstruction || question.prompt,
            options: question.options,
            context: question.context,
            user_message_uuid: userMessageUuid
          }
        };
        return;
      }

      // Complete the resumed task
      yield {
        eventType: 'TASK_COMPLETE',
        data: {
          session_id: sessionId,
          result: this.generateResult(commands.cleanedInstruction),
          user_message_uuid: userMessageUuid
        }
      };

    } finally {
      this.runningTasks.delete(taskId);
    }
  }
}
