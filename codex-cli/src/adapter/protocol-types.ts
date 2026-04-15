/**
 * Minimal subset of the codex app-server protocol types used by the adapter.
 *
 * Sourced from `codex app-server generate-ts` (codex-cli 0.118.0). Kept as a
 * small local copy so we do not take a build-time dependency on the generator.
 * Only the request/notification/item variants the adapter actually reads are
 * included; extend as needed.
 *
 * Protocol reference:
 *   https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
 */

export type RequestId = number | string;

// --- initialize -----------------------------------------------------------

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: {
    experimentalApi: boolean;
    optOutNotificationMethods?: string[] | null;
  } | null;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

// --- thread/turn shared types --------------------------------------------

export type AskForApproval = 'untrusted' | 'on-failure' | 'on-request' | 'never';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface Thread {
  id: string;
  preview: string;
  cwd: string;
  cliVersion: string;
}

// --- thread/start --------------------------------------------------------

export interface ThreadStartParams {
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  experimentalRawEvents: boolean;
  persistExtendedHistory: boolean;
}

export interface ThreadStartResponse {
  thread: Thread;
  cwd: string;
}

// --- thread/resume -------------------------------------------------------

export interface ThreadResumeParams {
  threadId: string;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  persistExtendedHistory: boolean;
}

export interface ThreadResumeResponse {
  thread: Thread;
  cwd: string;
}

// --- turn/start ----------------------------------------------------------

export type UserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'image'; url: string };

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandboxPolicy?: { mode: SandboxMode } | null;
}

export interface TurnStartResponse {
  turn: { id: string; status: TurnStatus };
}

// --- turn/interrupt ------------------------------------------------------

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

// --- thread items -------------------------------------------------------

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export type ThreadItem =
  | { type: 'userMessage'; id: string; content: UserInput[] }
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'plan'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | { type: 'fileChange'; id: string }
  | { type: 'webSearch'; id: string; query: string }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string }
  | { type: string; id: string; [k: string]: unknown };

// --- notifications -------------------------------------------------------

export interface ThreadStartedNotification {
  thread: Thread;
}

export interface TurnStartedNotification {
  threadId: string;
  turn: { id: string; status: TurnStatus };
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: { id: string; status: TurnStatus; error: unknown | null };
}

export interface ItemStartedNotification {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}

export interface ItemCompletedNotification {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}

export interface ErrorNotification {
  threadId: string;
  turnId: string;
  willRetry: boolean;
  error: { message?: string; [k: string]: unknown };
}

// --- JSON-RPC envelopes --------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: RequestId;
  method: string;
  params: unknown;
}

export interface JsonRpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc?: '2.0';
  id: RequestId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc?: '2.0';
  id: RequestId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export function isResponse(
  msg: JsonRpcResponse | JsonRpcNotification
): msg is JsonRpcResponse {
  return (msg as JsonRpcResponse).id !== undefined;
}

export function isError(msg: JsonRpcResponse): msg is JsonRpcErrorResponse {
  return (msg as JsonRpcErrorResponse).error !== undefined;
}
