# CmdCtrl Example Daemon

Minimal reference implementation of a CmdCtrl daemon. Use this as a starting point for integrating your own AI agent with CmdCtrl.

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Register with your CmdCtrl server
node dist/index.js register -s http://localhost:4000

# Start the daemon
node dist/index.js start

# ...later, to remove this device from the server:
node dist/index.js unregister
```

## How to Customize

The only file you need to modify is **`src/agent.ts`**. It contains three functions:

- `startTask()` — Called when a user sends their first message in a new session
- `resumeTask()` — Called when a user sends a follow-up message
- `cancelTask()` — Called when a user cancels a running task

Replace the placeholder echo logic with your agent integration (LLM API call, CLI tool, etc.).

## Project Structure

```
src/
├── index.ts          # CLI entry point (register, start, status, stop, unregister)
├── agent.ts          # YOUR AGENT LOGIC GOES HERE
├── message-store.ts  # In-memory message storage
├── context.ts        # Agent type, version, and config paths
└── commands/
    ├── register.ts   # Device registration flow
    ├── start.ts      # Start daemon (wires agent to @cmdctrl/daemon-sdk)
    ├── status.ts     # Check status
    ├── stop.ts       # Stop daemon
    └── unregister.ts # Unregister device and clear local config
```

WebSocket protocol handling, reconnection, and config/credential management are provided by [`@cmdctrl/daemon-sdk`](../sdk/README.md).

## Documentation

- [Building a Custom Daemon](../../docs/building-a-daemon.md) — Step-by-step tutorial
- [Daemon Protocol Specification](../../docs/daemon-protocol.md) — Complete WebSocket protocol reference
