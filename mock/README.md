# Mock Daemon

A mock daemon for E2E testing that simulates AI agent behavior without making real API calls.

## Use Cases

- E2E testing of the full message flow
- UI development without API costs
- Demo/showcase scenarios

## Installation

```bash
cd daemons/mock
npm install
npm run build
```

## Registration

Register with a CmdCtrl server before starting:

```bash
cmdctrl-mock register -s http://localhost:4000
cmdctrl-mock register -s https://your-server.ngrok-free.dev
```

## Running

```bash
cmdctrl-mock start      # Start daemon
cmdctrl-mock status     # Check status
cmdctrl-mock stop       # Stop daemon
```

## Behavior

By default, the mock daemon:
- Echoes back user prompts prefixed with `**MOCK:**`
- Generates realistic verbose output and progress events
- Creates JSONL session files in `~/.cmdctrl-mock/sessions/`

## Message Commands

Control daemon behavior dynamically by prefixing messages with commands:

| Command | Effect |
|---------|--------|
| `/sleep <ms>` or `/delay <ms>` | Wait specified milliseconds before responding |
| `/tools` or `/progress` | Show 5-8 progress events (Reading, Searching, etc.) |
| `/error` | Simulate an error response |
| `/ask` or `/question` | Trigger WAIT_FOR_USER with a question |

### Examples

| Message | Result |
|---------|--------|
| `Hello world` | Normal echo: "**MOCK:** Hello world" |
| `/sleep 3000 Hello world` | 3 second delay, then echo |
| `/tools Fix the bug` | Shows progress events, then echo |
| `/error Something broke` | Returns ERROR event with message |
| `/ask Which file?` | Returns WAIT_FOR_USER with question options |

Commands are parsed left-to-right, so you can combine them:
```
/sleep 2000 /tools Do something
```
This waits 2 seconds, shows progress events, then echoes "Do something".

## CLI Options

Customize default behavior via command line:

```bash
cmdctrl-mock start --delay-min 500 --delay-max 2000  # Custom response timing
cmdctrl-mock start --ask-probability 0.5             # 50% chance of asking questions
cmdctrl-mock start --error-rate 0.3                  # 30% chance of errors
```

## Configuration

Config files are stored in `~/.cmdctrl-mock/`:
- `config.json` - Server URL, device ID, device name
- `credentials` - Authentication tokens (chmod 600)
- `sessions/` - JSONL session files

## Development

Run directly without building:
```bash
npm run dev -- start
npm run dev -- status
```
