# @cmdctrl/acp

Cmd+Ctrl daemon for any coding agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) – DeepSeek Harness, Qwen Code and the others that ship an ACP mode.

## Install

```bash
npm install -g @cmdctrl/acp
cmdctrl-acp register --agent "dsh acp" -s https://api.cmd-ctrl.ai
cmdctrl-acp start
```

`--agent` is the command that starts your agent in ACP mode – `dsh acp` for DeepSeek Harness, `qwen --acp` for Qwen Code. A second agent on the same machine is a second instance: add `--instance <name>` to every command.

## What you get

Sessions in the project you pick, replies as the agent finishes each message, tool activity while it works, its permission requests as tappable cards, and Stop. Sessions you start in the agent itself appear in the app when the agent can list them.

Built against ACP protocol version 1 (schema v1.28.0).

## Docs

Full setup and troubleshooting: <https://docs.cmd-ctrl.ai/installation/acp>
