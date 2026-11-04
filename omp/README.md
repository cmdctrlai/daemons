# @cmdctrl/omp

Cmd+Ctrl daemon for [oh-my-pi](https://omp.sh) (`omp`), the fork of the [pi coding agent](https://pi.dev). It runs the [`@cmdctrl/pi`](https://www.npmjs.com/package/@cmdctrl/pi) daemon as its own device, so one machine can run pi and omp through Cmd+Ctrl side by side.

## Prerequisites

`omp` installed and authenticated.

## Install

```bash
npm install -g @cmdctrl/omp
cmdctrl-omp register -s https://api.cmd-ctrl.ai
cmdctrl-omp start
```

Set `OMP_BIN=/path/to/omp` if `omp` is not on your PATH. It ignores `PI_BIN`, which only the pi daemon reads.

## Interoperability

Sessions are read from omp's own directory (`~/.omp/agent/sessions/`, or `$PI_CODING_AGENT_DIR/sessions`), so a session started through Cmd+Ctrl can be resumed from your terminal with `omp --resume`, and vice versa. The composer menu offers your markdown commands (`~/.omp/agent/commands/`, `.omp/commands/`).

## Docs

Full setup and troubleshooting: <https://docs.cmd-ctrl.ai/installation/omp>
