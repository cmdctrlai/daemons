import { agentId, buildStartArgs, buildResumeArgs, extractReply } from './openclaw-cli';

describe('openclaw-cli', () => {
  const savedEnv = process.env.OPENCLAW_AGENT_ID;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.OPENCLAW_AGENT_ID;
    } else {
      process.env.OPENCLAW_AGENT_ID = savedEnv;
    }
  });

  describe('agentId', () => {
    const cases = [
      { name: 'defaults to "main" when env var is unset', envVal: undefined, expected: 'main' },
      { name: 'defaults to "main" when env var is empty', envVal: '', expected: 'main' },
      { name: 'uses env var when set', envVal: 'custom-agent', expected: 'custom-agent' },
    ];

    test.each(cases)('$name', ({ envVal, expected }) => {
      if (envVal === undefined) {
        delete process.env.OPENCLAW_AGENT_ID;
      } else {
        process.env.OPENCLAW_AGENT_ID = envVal;
      }
      expect(agentId()).toBe(expected);
    });
  });

  describe('buildStartArgs', () => {
    const cases = [
      {
        name: 'builds args with default agent',
        envVal: undefined,
        instruction: 'fix the bug',
        expected: ['agent', '--agent', 'main', '--message', 'fix the bug', '--json'],
      },
      {
        name: 'builds args with custom agent from env',
        envVal: 'helper',
        instruction: 'write tests',
        expected: ['agent', '--agent', 'helper', '--message', 'write tests', '--json'],
      },
    ];

    test.each(cases)('$name', ({ envVal, instruction, expected }) => {
      if (envVal === undefined) {
        delete process.env.OPENCLAW_AGENT_ID;
      } else {
        process.env.OPENCLAW_AGENT_ID = envVal;
      }
      expect(buildStartArgs(instruction)).toEqual(expected);
    });
  });

  describe('buildResumeArgs', () => {
    const cases = [
      {
        name: 'builds resume args with default agent',
        envVal: undefined,
        sessionId: 'sess-123',
        message: 'continue',
        expected: ['agent', '--agent', 'main', '--message', 'continue', '--session-id', 'sess-123', '--json'],
      },
      {
        name: 'builds resume args with custom agent from env',
        envVal: 'research',
        sessionId: 'sess-456',
        message: 'summarize',
        expected: ['agent', '--agent', 'research', '--message', 'summarize', '--session-id', 'sess-456', '--json'],
      },
    ];

    test.each(cases)('$name', ({ envVal, sessionId, message, expected }) => {
      if (envVal === undefined) {
        delete process.env.OPENCLAW_AGENT_ID;
      } else {
        process.env.OPENCLAW_AGENT_ID = envVal;
      }
      expect(buildResumeArgs(sessionId, message)).toEqual(expected);
    });
  });

  describe('extractReply', () => {
    const cases = [
      {
        name: 'parses OpenClaw payloads + sessionId from stderr JSON',
        input: JSON.stringify({
          payloads: [{ text: '4', mediaUrl: null }],
          meta: { agentMeta: { sessionId: 'abc-123' } },
        }),
        expected: { text: '4', sessionId: 'abc-123' },
      },
      {
        name: 'concatenates multiple payloads',
        input: JSON.stringify({
          payloads: [{ text: 'Hello' }, { text: 'World' }],
          meta: { agentMeta: { sessionId: 'multi-1' } },
        }),
        expected: { text: 'Hello\nWorld', sessionId: 'multi-1' },
      },
      {
        name: 'extracts JSON after log lines on stderr (compact)',
        input: 'gateway connect failed: some error\nfalling back to embedded\n' + JSON.stringify({
          payloads: [{ text: 'the answer' }],
          meta: { agentMeta: { sessionId: 'after-logs' } },
        }),
        expected: { text: 'the answer', sessionId: 'after-logs' },
      },
      {
        name: 'extracts pretty-printed JSON after log lines on stderr',
        input: 'gateway connect failed: GatewayClientRequestError: pairing required\n\n'
          + 'Gateway agent failed; falling back to embedded: Error: gateway closed\n\n'
          + JSON.stringify({
              payloads: [{ text: '20', mediaUrl: null }],
              meta: { agentMeta: { sessionId: '8046b49f-27d5-4b90-92bb-07ed77e02aa5' } },
            }, null, 2),
        expected: { text: '20', sessionId: '8046b49f-27d5-4b90-92bb-07ed77e02aa5' },
      },
      {
        name: 'handles empty payloads array by falling back to raw JSON',
        input: JSON.stringify({
          payloads: [],
          meta: { agentMeta: { sessionId: 'empty-payload' } },
        }),
        expected: {
          text: JSON.stringify({ payloads: [], meta: { agentMeta: { sessionId: 'empty-payload' } } }),
          sessionId: 'empty-payload',
        },
      },
      {
        name: 'falls back to generic field names',
        input: JSON.stringify({ reply: 'generic reply', session_id: 'gen-1' }),
        expected: { text: 'generic reply', sessionId: 'gen-1' },
      },
      {
        name: 'returns raw text for non-JSON output',
        input: 'just plain text',
        expected: { text: 'just plain text', sessionId: undefined },
      },
      {
        name: 'returns empty text for empty input',
        input: '',
        expected: { text: '', sessionId: undefined },
      },
      {
        name: 'returns empty text for whitespace-only input',
        input: '   \n  ',
        expected: { text: '', sessionId: undefined },
      },
    ];

    test.each(cases)('$name', ({ input, expected }) => {
      const result = extractReply(input);
      expect(result.text).toBe(expected.text);
      expect(result.sessionId).toBe(expected.sessionId);
    });
  });
});
