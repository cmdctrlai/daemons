/**
 * @cmdctrl/daemon-sdk
 *
 * SDK for building CmdCtrl daemons. Provides:
 * - DaemonClient: WebSocket client with protocol handling
 * - ConfigManager: Config/credential file management
 * - Registration utilities: Device authorization flow
 * - Message types: TypeScript interfaces for all protocol messages
 *
 * @example
 * ```typescript
 * import { DaemonClient, ConfigManager, registerDevice } from '@cmdctrl/daemon-sdk';
 * ```
 */

// Client
export { DaemonClient } from './client';
export type {
  DaemonClientOptions,
  TaskHandle,
  ResumeHandle,
  GetMessagesRequest,
  GetMessagesResponse,
  ContextRequest,
  ContextResponse,
} from './client';

// Config
export { ConfigManager } from './config';
export type { DaemonConfig, DaemonCredentials } from './config';

// Registration
export { registerDevice, unregisterDevice, requestDeviceCode, pollForToken } from './register';
export type { RegistrationResult } from './register';

// Message types
export type {
  // Server → Daemon
  ServerMessage,
  PingMessage,
  TaskStartMessage,
  TaskResumeMessage,
  TaskCancelMessage,
  GetMessagesMessage,
  WatchSessionMessage,
  UnwatchSessionMessage,
  ContextRequestMessage,
  VersionStatusMessage,
  // Daemon → Server
  DaemonMessage,
  PongMessage,
  StatusMessage,
  EventMessage,
  SessionInfo,
  ReportSessionsMessage,
  MessageEntry,
  MessagesResponseMessage,
  SessionActivityMessage,
  ContextResponseMessage,
  // Enums
  SessionStatus,
  EventType,
} from './messages';
