# Cmd+Ctrl Example Daemon

Minimal reference implementation of a Cmd+Ctrl daemon. Use this as a starting point for integrating your own AI agent with Cmd+Ctrl.

## Quick start

```bash
npm install
npm run build
node dist/index.js register -s https://app.cmd-ctrl.ai
node dist/index.js start
```

## How to customize

The only file you need to modify is **`src/agent.ts`**. It contains three functions:

- `startTask()` — Called when a user sends their first message in a new session
- `resumeTask()` — Called when a user sends a follow-up message
- `cancelTask()` — Called when a user cancels a running task

Replace the placeholder echo logic with your agent integration (LLM API call, CLI tool, etc.).

## Project structure

```
src/
├── index.ts          # CLI entry point (register, start, status, stop)
├── agent.ts          # YOUR AGENT LOGIC GOES HERE
├── daemon-client.ts  # WebSocket client (protocol handling)
├── messages.ts       # Protocol message type definitions
├── message-store.ts  # In-memory message storage
├── config.ts         # Config and credential management
└── commands/
    ├── register.ts   # Device registration flow
    ├── start.ts      # Start daemon
    ├── status.ts     # Check status
    └── stop.ts       # Stop daemon
```

## Documentation

- [Daemon Protocol Specification](../DAEMON-PROTOCOL.md) — Full protocol reference
- [Contributing](../CONTRIBUTING.md) — How to submit a new official daemon
