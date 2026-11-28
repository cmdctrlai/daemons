import { isDifferentAgent } from './commands/register';

// `register --agent` on a registered device keeps its deviceName (`<host>-<bin>`), which the
// server stores as the hostname the app shows. A change is safe only when it is the same agent.
describe('refute: isDifferentAgent', () => {
  const cases: Array<{ name: string; existing: { agentType?: string; agentCommand: string }; command: string; want: boolean }> = [
    // Device "mac-my-agent" would run other-agent and still be shown as "ACP Agent on mac-my-agent".
    { name: 'unknown agent to a different unknown agent', existing: { agentType: 'acp', agentCommand: 'my-agent --acp' }, command: 'other-agent --acp', want: true },
    // Config written by the previous release: same agent, only a flag changes, yet it is refused
    // with "is a different agent".
    { name: 'older config, same known agent, new flags', existing: { agentCommand: 'qwen --acp' }, command: 'qwen --acp -m qwen3-coder', want: false },
  ];
  it.each(cases)('$name', ({ existing, command, want }) => {
    expect(isDifferentAgent(existing as never, command)).toBe(want);
  });
});
