# @cmdctrl/pi

Cmd+Ctrl daemon for the [pi coding agent](https://shittycodingagent.ai/).

## Prerequisites

`pi` installed and authenticated:

```bash
npm install -g @mariozechner/pi-coding-agent
pi          # run once and /login, or set a provider env var
```

## Install

```bash
npm install -g @cmdctrl/pi
cmdctrl-pi register -s https://api.cmd-ctrl.ai
cmdctrl-pi start
```

## Interoperability

Sessions are stored in pi's own directory (`~/.pi/agent/sessions/`), so a session started through Cmd+Ctrl can be resumed from your terminal with `pi --resume`, and vice versa. History survives daemon restarts.

## Version alignment

The bundled pi SDK is pinned to match the file format written by the `pi` CLI. If you upgrade the CLI and session reads break, upgrade `@cmdctrl/pi` to match.

## Docs

Full setup and troubleshooting: <https://docs.cmd-ctrl.ai/installation/pi>
