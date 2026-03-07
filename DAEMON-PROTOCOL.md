# Cmd+Ctrl Daemon Protocol

This document describes the WebSocket protocol between a Cmd+Ctrl daemon and the Cmd+Ctrl server. If you're building a daemon with the SDK, you don't need to implement this directly – the SDK handles it. This is the reference for what's happening underneath.

For a practical guide to building a daemon, see the [`example/`](./example/) daemon and its README.

## Overview

A daemon is a long-running background process that:

1. Connects to the Cmd+Ctrl server via WebSocket
2. Receives task instructions from users (via the Cmd+Ctrl web/mobile app)
3. Runs those instructions against a local AI agent
4. Streams progress and results back to the server
5. Reports existing native sessions so Cmd+Ctrl can discover them

## Connection

```
wss://<server>/ws/daemon
```

**Required headers:**

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer <refresh_token>` |
| `X-Device-ID` | Device ID from registration |
| `X-Agent-Type` | Agent identifier (snake_case, e.g. `claude_code`) |
| `X-Daemon-Version` | Daemon semantic version (e.g. `1.0.0`) |

The server closes with HTTP 401 if credentials are invalid.

## Message format

All messages are JSON objects with a `type` field. The server sends messages to the daemon; the daemon sends events back.

## Server → Daemon messages

### `ping`

Sent every 30 seconds. Daemon must reply with `pong`.

```json
{ "type": "ping" }
```

### `task_start`

A user sent a new message and there is no existing native session to resume.

```json
{
  "type": "task_start",
  "task_id": "uuid",
  "instruction": "refactor the auth module",
  "project_path": "/Users/alice/src/myapp"
}
```

**Daemon must:**
1. Start a new native agent session
2. Send `SESSION_STARTED` with the native session ID
3. Run the instruction
4. Send `TASK_COMPLETE` (or `ERROR`) when done

### `task_resume`

A user sent a follow-up message in an existing session.

```json
{
  "type": "task_resume",
  "task_id": "uuid",
  "session_id": "native-session-id",
  "message": "actually, keep the existing interface",
  "project_path": "/Users/alice/src/myapp"
}
```

### `task_cancel`

The user cancelled a running task.

```json
{ "type": "task_cancel", "task_id": "uuid" }
```

### `get_messages`

The server is requesting message history for a session (e.g. when a user opens a session in the app).

```json
{
  "type": "get_messages",
  "request_id": "uuid",
  "session_id": "native-session-id",
  "limit": 50,
  "before_uuid": "optional-uuid",
  "after_uuid": "optional-uuid"
}
```

Daemon must reply with a `messages` message.

### `watch_session`

The server wants real-time updates for a session (a user has it open). Daemon should push `session_activity` whenever the native agent produces output.

```json
{
  "type": "watch_session",
  "session_id": "native-session-id",
  "file_path": ""
}
```

### `unwatch_session`

Stop sending real-time updates for this session.

```json
{ "type": "unwatch_session", "session_id": "native-session-id" }
```

### `version_status`

Server reports whether the daemon version is current, outdated, or unsupported.

```json
{
  "type": "version_status",
  "status": "current" | "update_available" | "update_required",
  "current_version": "1.0.3",
  "latest_version": "1.0.4",
  "message": "Update available"
}
```

If `status` is `update_required`, the daemon should disconnect and refuse to reconnect until updated.

## Daemon → Server messages

### `pong`

Reply to `ping`.

```json
{ "type": "pong" }
```

### `status`

Report currently running task IDs. Send on connect and whenever the running task set changes.

```json
{ "type": "status", "running_tasks": ["task-uuid-1"] }
```

### `event`

All task lifecycle events share this envelope:

```json
{
  "type": "event",
  "task_id": "uuid",
  "event_type": "...",
  ...event-specific fields
}
```

**Event types:**

#### `SESSION_STARTED`

Call this first, before any other events. Tells the server the native session ID for this task.

```json
{ "event_type": "SESSION_STARTED", "session_id": "native-session-id" }
```

#### `PROGRESS`

Status update shown in the UI while the agent is working.

```json
{ "event_type": "PROGRESS", "action": "Editing", "target": "src/auth.ts" }
```

#### `OUTPUT`

Verbose output (tool use, intermediate steps). Shown in the expanded session view.

```json
{ "event_type": "OUTPUT", "output": "Reading 3 files...", "user_message_uuid": "optional" }
```

#### `TASK_COMPLETE`

The agent finished. `result` is the final response text shown to the user.

```json
{ "event_type": "TASK_COMPLETE", "result": "Done. Extracted auth logic into auth/service.ts.", "user_message_uuid": "optional" }
```

#### `WAIT_FOR_USER`

The agent needs input before it can continue (confirmation, clarification, etc.).

```json
{
  "event_type": "WAIT_FOR_USER",
  "prompt": "This will delete 3 files. Continue?",
  "result": "Waiting for confirmation",
  "options": [{ "label": "Yes" }, { "label": "No" }]
}
```

#### `ERROR`

The task failed.

```json
{ "event_type": "ERROR", "error": "Agent process exited unexpectedly" }
```

### `messages`

Reply to `get_messages`. Each message entry must include a stable UUID.

```json
{
  "type": "messages",
  "request_id": "uuid",
  "session_id": "native-session-id",
  "messages": [
    {
      "uuid": "stable-msg-uuid",
      "role": "USER",
      "content": "refactor the auth module",
      "timestamp": "2026-03-06T22:00:00.000Z"
    },
    {
      "uuid": "stable-msg-uuid-2",
      "role": "AGENT",
      "content": "Done. Extracted auth logic into auth/service.ts.",
      "timestamp": "2026-03-06T22:00:45.000Z"
    }
  ],
  "has_more": false,
  "oldest_uuid": "stable-msg-uuid",
  "newest_uuid": "stable-msg-uuid-2"
}
```

### `session_activity`

Push real-time update for a watched session. Send whenever the native agent produces new output.

```json
{
  "type": "session_activity",
  "session_id": "native-session-id",
  "file_path": "",
  "last_message": "Editing src/auth.ts...",
  "message_count": 4,
  "is_completion": false,
  "last_activity": "2026-03-06T22:01:00.000Z"
}
```

Set `is_completion: true` on the final message when the agent finishes.

### `report_sessions`

Tell the server about native sessions that exist outside of Cmd+Ctrl-initiated tasks (sessions the user started directly in the agent CLI/IDE). The server merges these with Cmd+Ctrl-managed sessions in the dashboard.

Sent on connect and refreshed every 30 seconds.

```json
{
  "type": "report_sessions",
  "sessions": [
    {
      "id": "native-session-id",
      "title": "Refactor auth module",
      "project_path": "/Users/alice/src/myapp",
      "message_count": 6,
      "last_activity": "2026-03-06T22:01:00.000Z",
      "has_messages": true
    }
  ]
}
```

## Registration

Daemons are registered via the Cmd+Ctrl API before first use. Registration returns a `device_id` and `refresh_token` stored in `~/.cmdctrl-<agent>/config.json`.

The registration flow is handled by the `register` command included in every official daemon. If you're building a custom daemon using the SDK, copy the `register` command from the [`example/`](./example/) daemon.

## Naming conventions

| Thing | Convention | Example |
|-------|-----------|---------|
| Package name | `@cmdctrl/<agent>` | `@cmdctrl/my-agent` |
| Binary name | `cmdctrl-<agent>` | `cmdctrl-my-agent` |
| Agent type (server) | `snake_case` | `my_agent` |
| Config dir | `~/.cmdctrl-<agent>/` | `~/.cmdctrl-my-agent/` |
| Log file | `/tmp/cmdctrl-daemon-<agent>.log` | `/tmp/cmdctrl-daemon-my-agent.log` |

## Using the SDK

The `@cmdctrl/daemon-sdk` package implements this protocol. Install it:

```bash
npm install @cmdctrl/daemon-sdk
```

Minimal example:

```typescript
import { DaemonClient } from '@cmdctrl/daemon-sdk';

const client = new DaemonClient({
  serverUrl: 'https://app.cmd-ctrl.ai',
  deviceId: config.deviceId,
  agentType: 'my_agent',
  token: config.token,
  version: '1.0.0',
});

client.onTaskStart(async (task) => {
  const sessionId = await myAgent.newSession();
  task.sessionStarted(sessionId);
  task.progress('Running', task.instruction);
  const result = await myAgent.run(sessionId, task.instruction);
  task.complete(result);
});

client.onTaskResume(async (task) => {
  const result = await myAgent.resume(task.sessionId, task.message);
  task.complete(result);
});

client.onGetMessages((req) => {
  return myAgent.getMessages(req.sessionId, req.limit);
});

await client.connect();
```

See the [`example/`](./example/) daemon for the complete implementation including registration, config management, and graceful shutdown.
