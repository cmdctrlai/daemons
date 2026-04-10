/**
 * Agent Integration
 *
 * THIS IS THE FILE YOU MODIFY to integrate your agent.
 *
 * Replace the placeholder functions below with your actual agent logic.
 * For example, you might:
 *   - Call an LLM API (OpenAI, Anthropic, local model, etc.)
 *   - Spawn a CLI tool (aider, codex, etc.)
 *   - Send requests to a running agent server
 *
 * The daemon framework handles all the CmdCtrl protocol details.
 * You just need to implement these functions.
 */

/**
 * Conversation history for maintaining context across messages.
 * Replace with your agent's native session management.
 */
const conversations = new Map<string, Array<{ role: string; content: string }>>();

/**
 * Start a new agent task.
 *
 * Called when a user creates a new session and sends their first message.
 *
 * @param instruction - The user's initial message
 * @param projectPath - Optional working directory hint from the server.
 *   SECURITY: If you use this as a `cwd` or in file operations, validate it
 *   first – resolve it with `path.resolve()`, reject paths containing `..`,
 *   and ensure it falls within an allowed directory.
 * @param onProgress - Call this to report progress (shown as status in the UI)
 * @returns The agent's response text (Markdown supported)
 */
export async function startTask(
  instruction: string,
  projectPath: string | undefined,
  onProgress: (action: string, target: string) => void
): Promise<string> {
  // --- Replace this with your agent logic ---

  onProgress('Thinking', '');

  // Example: simulate processing
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Store conversation history
  const history = [{ role: 'user', content: instruction }];

  // Your agent processes the instruction here.
  // For a real integration, you would:
  //   const response = await myLLM.chat({ messages: history });
  //   const result = response.content;
  const result = `Echo: ${instruction}`;

  history.push({ role: 'assistant', content: result });

  return result;
}

/**
 * Resume an existing agent task.
 *
 * Called when a user sends a follow-up message in an existing session.
 *
 * @param sessionId - Your native session ID (returned from startTask via the daemon)
 * @param message - The user's follow-up message
 * @param projectPath - Optional working directory hint (see startTask for security notes)
 * @param onProgress - Call this to report progress
 * @returns The agent's response text
 */
export async function resumeTask(
  sessionId: string,
  message: string,
  projectPath: string | undefined,
  onProgress: (action: string, target: string) => void
): Promise<string> {
  // --- Replace this with your agent logic ---

  onProgress('Thinking', '');

  await new Promise(resolve => setTimeout(resolve, 500));

  // Retrieve and update conversation history
  const history = conversations.get(sessionId) || [];
  history.push({ role: 'user', content: message });

  // Your agent processes the follow-up here.
  const result = `Echo: ${message}`;

  history.push({ role: 'assistant', content: result });
  conversations.set(sessionId, history);

  return result;
}

/**
 * Cancel a running task.
 *
 * Called when the user cancels a session mid-execution.
 * Clean up any resources (kill subprocesses, close connections, etc.)
 */
export function cancelTask(sessionId: string): void {
  // --- Replace this with your cleanup logic ---
  conversations.delete(sessionId);
}

/**
 * Register a new session's conversation history.
 * Called by the daemon after startTask completes to store the initial exchange.
 */
export function registerSession(
  sessionId: string,
  instruction: string,
  response: string
): void {
  conversations.set(sessionId, [
    { role: 'user', content: instruction },
    { role: 'assistant', content: response },
  ]);
}
