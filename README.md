# Cmd+Ctrl Daemons

Official daemon adapters and SDK for [Cmd+Ctrl](https://cmd-ctrl.ai) – an orchestration layer that lets you manage AI coding agent sessions from your phone, browser, or Apple Watch.

Each daemon is a lightweight background process that connects your AI coding agent to Cmd+Ctrl. Install one (or several), register with your Cmd+Ctrl account, and control your agents from anywhere.

## Official daemons

| Package | Agent | Install |
|---------|-------|---------|
| `@cmdctrl/claude-code` | Claude Code | `npm install -g @cmdctrl/claude-code` |
| `@cmdctrl/aider` | Aider | `npm install -g @cmdctrl/aider` |
| `@cmdctrl/cursor-cli` | Cursor (CLI) | `npm install -g @cmdctrl/cursor-cli` |
| `@cmdctrl/cursor-ide` | Cursor (IDE) | `npm install -g @cmdctrl/cursor-ide` |
| `@cmdctrl/vscode-copilot` | GitHub Copilot (VS Code) | `npm install -g @cmdctrl/vscode-copilot` |
| `@cmdctrl/copilot-cli` | GitHub Copilot (CLI) | `npm install -g @cmdctrl/copilot-cli` |
| `@cmdctrl/gemini-cli` | Gemini CLI | `npm install -g @cmdctrl/gemini-cli` |
| `@cmdctrl/codex-cli` | OpenAI Codex CLI | `npm install -g @cmdctrl/codex-cli` |
| `@cmdctrl/opencode` | OpenCode | `npm install -g @cmdctrl/opencode` |

## Quick start

```bash
# Install the daemons you want
npm install -g @cmdctrl/claude-code @cmdctrl/aider

# Register each one with your Cmd+Ctrl server
cmdctrl-claude-code register
cmdctrl-aider register

# Start them
cmdctrl-claude-code start
cmdctrl-aider start
```

Or use the hosted install script to set everything up interactively:

```bash
curl -fsSL https://docs.cmd-ctrl.ai/install.sh | bash
```

## Documentation

Full docs are at **[docs.cmd-ctrl.ai](https://docs.cmd-ctrl.ai)**:

- **[Installation](https://docs.cmd-ctrl.ai/installation)** – install and register a daemon on your machine
- **[Building a daemon](https://docs.cmd-ctrl.ai/building-a-daemon)** – step-by-step guide for adapting a new agent
- **[Daemon protocol](https://docs.cmd-ctrl.ai/daemon-protocol)** – WebSocket protocol reference
- **[SDK reference](https://docs.cmd-ctrl.ai/reference)** – `@cmdctrl/daemon-sdk` API

## SDK

The `@cmdctrl/daemon-sdk` package provides the WebSocket client and protocol types used by all official daemons. Use it to build a daemon for any agent.

```bash
npm install @cmdctrl/daemon-sdk
```

See [`sdk/`](./sdk/) for the source and [`DAEMON-PROTOCOL.md`](./DAEMON-PROTOCOL.md) for the full protocol reference.

## Building a custom daemon

See [`DAEMON-PROTOCOL.md`](./DAEMON-PROTOCOL.md) for the protocol spec and [`example/`](./example/) for a minimal working implementation.

The [`example/`](./example/) daemon is a fully working reference – clone it, swap in your agent logic, and you're done.

## Contributing

Bug reports, fixes, and new official daemons are welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Issues

File bugs and feature requests at [cmdctrlai/daemons](https://github.com/cmdctrlai/daemons/issues). For issues with the Cmd+Ctrl app itself, use [cmdctrlai/cmdctrl](https://github.com/cmdctrlai/cmdctrl/issues).

## License

MIT
