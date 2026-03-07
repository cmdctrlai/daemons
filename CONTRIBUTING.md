# Contributing to Cmd+Ctrl Daemons

## Bug reports

File issues at [cmdctrlai/daemons](https://github.com/cmdctrlai/daemons/issues). Please include:

- Which daemon and version (`cmdctrl-<agent> --version`)
- Which agent and version (e.g. `aider --version`)
- OS and Node.js version
- What you expected vs what happened
- Relevant log output from `/tmp/cmdctrl-daemon-<agent>.log`

## Fixing a daemon

1. Fork the repo and clone it
2. Make your change in the relevant `<daemon>/src/` directory
3. Build: `cd <daemon> && npm install && npm run build`
4. Test manually by registering and running the daemon against a local or production Cmd+Ctrl server
5. Open a PR with a clear description of what broke and what you changed

## Adding a new daemon

New daemons are welcome if they integrate a real AI coding agent. Start from the [`example/`](./example/) daemon – it's a minimal working implementation you can fork.

**Requirements for an official daemon:**

1. **Package name:** `@cmdctrl/<agent>` (e.g. `@cmdctrl/my-agent`)
2. **Binary name:** `cmdctrl-<agent>` (e.g. `cmdctrl-my-agent`)
3. **Required commands:** `start`, `stop`, `register`, `unregister`, `status`, `update`
4. **Uses `@cmdctrl/daemon-sdk`** – do not implement the WebSocket protocol directly
5. **Implements all required handlers:** `onTaskStart`, `onTaskResume`, `onGetMessages`
6. **Session discovery:** implement `setSessionsProvider` so native sessions appear in the dashboard
7. **Graceful shutdown:** stop the agent process and disconnect the client on SIGINT/SIGTERM

Open an issue first to discuss if you're building something new – avoids duplicate effort.

## SDK changes

Changes to `@cmdctrl/daemon-sdk` that break existing daemons require a major version bump. The SDK follows semver strictly. If you're adding a new handler type or message, it's a minor bump; breaking interface changes are major.

## Code style

- TypeScript, no `any`
- No external dependencies beyond what's already used in the daemon you're modifying
- Keep daemon packages thin – logic belongs in the adapter, not the SDK
