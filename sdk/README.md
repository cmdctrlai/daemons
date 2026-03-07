# @cmdctrl/daemon-sdk

SDK for building CmdCtrl daemons. A daemon connects any AI agent to CmdCtrl, allowing users to interact with it through the CmdCtrl web, iOS, and Android apps.

## Installation

```bash
npm install @cmdctrl/daemon-sdk
```

## Quick Start

```typescript
import { DaemonClient, ConfigManager, registerDevice } from '@cmdctrl/daemon-sdk';
import { randomUUID } from 'crypto';
import * as os from 'os';

// --- Registration (run once) ---

const config = new ConfigManager('my-agent');

if (!config.isRegistered()) {
  const result = await registerDevice(
    'https://app.cmd-ctrl.ai',
    os.hostname(),
    os.hostname(),
    'my_agent',
    (url) => console.log(`Open in browser: ${url}`)
  );

  if (result) {
    config.writeConfig({
      serverUrl: 'https://app.cmd-ctrl.ai',
      deviceId: result.deviceId,
      deviceName: os.hostname(),
    });
    config.writeCredentials({ refreshToken: result.refreshToken });
  }
}

// --- Daemon ---

const cfg = config.readConfig()!;
const creds = config.readCredentials()!;

const client = new DaemonClient({
  serverUrl: cfg.serverUrl,
  deviceId: cfg.deviceId,
  agentType: 'my_agent',
  token: creds.refreshToken,
  version: '1.0.0',
});

// Message storage (you provide this)
const sessions = new Map<string, Array<{uuid: string; role: string; content: string; timestamp: string}>>();

client.onTaskStart(async (task) => {
  const sessionId = randomUUID();
  task.sessionStarted(sessionId);

  // Store user message
  const msgs = [{ uuid: randomUUID(), role: 'USER', content: task.instruction, timestamp: new Date().toISOString() }];
  sessions.set(sessionId, msgs);

  // Run your agent
  task.progress('Thinking', '');
  const result = await myAgent.run(task.instruction);

  // Store agent response
  msgs.push({ uuid: randomUUID(), role: 'AGENT', content: result, timestamp: new Date().toISOString() });

  task.complete(result);
});

client.onTaskResume(async (task) => {
  const msgs = sessions.get(task.sessionId) || [];
  msgs.push({ uuid: randomUUID(), role: 'USER', content: task.message, timestamp: new Date().toISOString() });

  const result = await myAgent.resume(task.sessionId, task.message);
  msgs.push({ uuid: randomUUID(), role: 'AGENT', content: result, timestamp: new Date().toISOString() });

  task.complete(result);
});

client.onGetMessages((req) => {
  const msgs = sessions.get(req.sessionId) || [];
  return {
    messages: msgs.slice(-req.limit) as any,
    hasMore: msgs.length > req.limit,
    oldestUuid: msgs[0]?.uuid,
    newestUuid: msgs[msgs.length - 1]?.uuid,
  };
});

await client.connect();
console.log('Daemon connected!');
```

## API

### `DaemonClient`

The main client class. Handles WebSocket connection, protocol, and message routing.

**Constructor options:**
- `serverUrl` — CmdCtrl server URL
- `deviceId` — Device ID from registration
- `agentType` — Your agent type (snake_case)
- `token` — Refresh token from registration
- `version` — Your daemon version

**Handler registration:**
- `onTaskStart(handler)` — New task from user (required)
- `onTaskResume(handler)` — Follow-up message (required)
- `onGetMessages(handler)` — Message history request (required)
- `onTaskCancel(handler)` — Task cancellation
- `onWatchSession(handler)` — Watch session for external changes
- `onUnwatchSession(handler)` — Stop watching session
- `onContextRequest(handler)` — Dashboard context request
- `onVersionStatus(handler)` — Version update notification

**Task handles** (passed to handlers):
- `task.sessionStarted(id)` — Report native session ID (must call first in onTaskStart)
- `task.progress(action, target)` — Report progress
- `task.output(text)` — Send verbose output
- `task.complete(result)` — Complete the task
- `task.waitForUser(prompt, result, options?)` — Ask the user a question
- `task.error(message)` — Report an error

### `ConfigManager`

Manages config files in `~/.cmdctrl-<name>/`.

### `registerDevice()`

Runs the device authorization flow (similar to GitHub CLI).

## Documentation

- [Building a Custom Daemon](../../docs/building-a-daemon.md) — Step-by-step tutorial
- [Daemon Protocol Specification](../../docs/daemon-protocol.md) — Complete WebSocket protocol reference
- [`daemons/example/`](../example/) — Minimal reference implementation
