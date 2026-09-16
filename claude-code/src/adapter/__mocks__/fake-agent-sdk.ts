/**
 * A stand-in for the Agent SDK's query(). Every call registers a FakeAgent the
 * test can drive: emit stream events, end or fail the stream, and read back the
 * messages the adapter pushed into the streaming input.
 */

interface QueryArgs {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}

export interface FakeAgent {
  options: Record<string, unknown>;
  /** Text of every message pushed into the streaming input, in order. */
  sent: string[];
  /** The same messages whole, for tests that care about image blocks. */
  raw: unknown[];
  emit: (event: Record<string, unknown>) => void;
  end: () => void;
  fail: (err: Error) => void;
  interruptCalls: number;
}

export const fakeAgents: FakeAgent[] = [];

export function resetFakeAgents(): void {
  fakeAgents.length = 0;
}

/** Wait for the adapter's pushes and the fake's own drain to settle. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

function textOf(message: unknown): string {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const block = content.find((b) => (b as { type?: string }).type === 'text');
    return (block as { text?: string } | undefined)?.text ?? '';
  }
  return '';
}

export function query(args: QueryArgs) {
  const events: Record<string, unknown>[] = [];
  let waiter: (() => void) | null = null;
  let failure: Error | null = null;
  let done = false;

  const wake = () => {
    const w = waiter;
    waiter = null;
    w?.();
  };

  const agent: FakeAgent = {
    options: args.options,
    sent: [],
    raw: [],
    emit: (event) => { events.push(event); wake(); },
    end: () => { done = true; wake(); },
    fail: (err) => { failure = err; wake(); },
    interruptCalls: 0,
  };
  fakeAgents.push(agent);

  // The real SDK consumes the streaming input for the life of the session.
  void (async () => {
    for await (const message of args.prompt) {
      agent.sent.push(textOf(message));
      agent.raw.push(message);
    }
  })();

  // Aborting kills the child, which ends the output stream.
  const abort = args.options.abortController as AbortController | undefined;
  abort?.signal.addEventListener('abort', () => agent.end());

  const iterator = {
    [Symbol.asyncIterator]() { return this; },
    async next(): Promise<IteratorResult<Record<string, unknown>>> {
      for (;;) {
        if (events.length > 0) return { value: events.shift()!, done: false };
        if (failure) throw failure;
        if (done) return { value: undefined as never, done: true };
        await new Promise<void>((resolve) => { waiter = resolve; });
      }
    },
  };

  return Object.assign(iterator, {
    interrupt: () => { agent.interruptCalls++; return Promise.resolve(); },
  });
}
