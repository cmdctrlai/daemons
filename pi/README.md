# CmdCtrl Pi Daemon

CmdCtrl daemon for the [pi coding agent](https://shittycodingagent.ai/) (`@mariozechner/pi-coding-agent`).

Sessions started through CmdCtrl live in pi's own session directory (`~/.pi/agent/sessions/<cwd-slug>/<ts>_<id>.jsonl`) and are fully interoperable with the pi CLI – you can `pi --resume` a session that was created by CmdCtrl, and vice versa. Message history is read directly from pi's files via its published `SessionManager` API, so nothing is lost across daemon restarts.

## Prerequisites

```bash
npm install -g @mariozechner/pi-coding-agent
```

Then configure a model/provider for pi (e.g. run `pi` once interactively and `/login`, or set an API key env var – see `pi`'s `docs/providers.md`).

Override the pi binary location with `PI_BIN=/path/to/pi` if needed.

## Quick Start

```bash
npm install
npm run build

# Register with your CmdCtrl server
node dist/index.js register -s http://localhost:4000

# Start the daemon
node dist/index.js start

# Later, to remove this device from the server:
node dist/index.js unregister
```

## How It Works

- **First turn:** spawns `pi --mode json -p <prompt>` (no `--session`) in the project's `cwd`. Pi creates the session file at its default location and emits a `{"type":"session","id":...}` event; we capture that id and report it to CmdCtrl as the native session id.
- **Follow-up turns:** the daemon resolves the session's on-disk path via `SessionManager.list(cwd)` and passes `--session <info.path>` to pi. Same file, same id – reusable by both CmdCtrl and `pi --resume`.
- **Message history:** served via pi's `SessionManager.open(path).getEntries()`. User prompts and assistant text are mapped to CmdCtrl messages; tool calls and tool results surface as live progress events instead.
- **Live watching:** when the server asks us to observe a session, the watcher polls the file every 500ms and emits `AGENT_RESPONSE` / `VERBOSE` / `session_activity` via the CmdCtrl daemon SDK.
- **Progress:** `tool_execution_start` events become CmdCtrl progress updates (Reading/Editing/Running/etc.).
- **Cancel:** `task_cancel` sends SIGTERM (then SIGKILL after 2s) to the pi child process.

## Version alignment

`@mariozechner/pi-coding-agent` is bundled as a narrowly-pinned dependency so our file reader matches the file format the globally-installed `pi` CLI writes. On startup the daemon compares `pi --version` with the bundled SDK version and warns on drift. When pi bumps its `CURRENT_SESSION_VERSION`, publish a matching `@cmdctrl/pi` release.

## Files

```
src/
├── index.ts            # CLI entry (register, start, status, stop, unregister)
├── context.ts          # daemon constants (AGENT_TYPE, PI_BIN, config)
├── agent.ts            # pi subprocess + JSON event stream parser
├── session-reader.ts   # SessionManager-backed message/session reads
├── session-watcher.ts  # polling watcher for live updates
├── pi-sdk.ts           # lazy dynamic import of the ESM-only pi SDK
└── commands/           # SDK-backed CLI commands (register, start, unregister, ...)
```
