import { CodexAdapter, AdapterLimits, defaultLimits } from './codex-cli';
import {
  AppServerClient,
  AppServerClientOptions,
  AppServerError,
} from './app-server-client';

/**
 * Codex binds a thread's writer lock to the app-server process that resumed it
 * and offers no way to hand it back, so stopping that process is the release.
 * A path that ends a task without stopping its client leaves the user unable to
 * run `codex resume` on their own thread until the daemon restarts – which is
 * exactly the defect these tests exist to keep out.
 */

interface FakeClient {
  stopped: number;
  started: boolean;
  options: AppServerClientOptions;
  requests: { method: string; params: unknown }[];
  /** method -> canned result, or an Error to throw. */
  responses: Map<string, unknown>;
  /** Makes start() reject, standing in for a codex that will not spawn. */
  failStart?: Error;
  emit(event: string, params: unknown): void;
  asClient(): AppServerClient;
}

function makeFakeClient(options: AppServerClientOptions): FakeClient {
  const handlers = new Map<string, ((p: unknown) => void)[]>();
  const fake: FakeClient = {
    stopped: 0,
    started: false,
    options,
    requests: [],
    responses: new Map(),
    emit(event, params) {
      for (const h of handlers.get(event) ?? []) h(params);
    },
    asClient() {
      return this as unknown as AppServerClient;
    },
  };
  Object.assign(fake, {
    on(event: string, handler: (p: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return fake;
    },
    async start() {
      if (fake.failStart) throw fake.failStart;
      fake.started = true;
      return {};
    },
    async stop() {
      fake.stopped += 1;
    },
    async request(method: string, params: unknown) {
      fake.requests.push({ method, params });
      const canned = fake.responses.get(method);
      if (canned instanceof Error) throw canned;
      if (canned !== undefined) return canned;
      if (method === 'thread/start') {
        return { thread: { id: 'thread-new' }, cwd: '/tmp' };
      }
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      return {};
    },
  });
  return fake;
}

interface Harness {
  adapter: CodexAdapter;
  clients: FakeClient[];
  events: { taskId: string; type: string; data: Record<string, unknown> }[];
  last(): FakeClient;
  types(): string[];
}

/** `arm` runs on each client the adapter builds, to plant canned failures. */
function harness(
  arm?: (c: FakeClient, index: number) => void,
  limits?: Partial<AdapterLimits>
): Harness {
  const clients: FakeClient[] = [];
  const events: Harness['events'] = [];
  const adapter = new CodexAdapter(
    (taskId, type, data) => events.push({ taskId, type, data }),
    '1.2.3',
    (options) => {
      const c = makeFakeClient(options);
      arm?.(c, clients.length);
      clients.push(c);
      return c.asClient();
    },
    { ...defaultLimits(), ...limits }
  );
  return {
    adapter,
    clients,
    events,
    last: () => clients[clients.length - 1],
    types: () => events.map((e) => e.type),
  };
}

const turn = (status: string, error: unknown = null) => ({
  threadId: 'thread-1',
  turn: { id: 'turn-1', status, error },
});

const writerBusy = new AppServerError(
  'thread/resume',
  -32600,
  'thread thread-1 already has an active writer'
);

describe('the thread is released on every exit path', () => {
  const cases: {
    name: string;
    arm?: (c: FakeClient, index: number) => void;
    run: (h: Harness) => Promise<void>;
    expectEvent?: string;
    /** A task refused before its client spawned has no client to stop. */
    expectClient?: boolean;
  }[] = [
    {
      name: 'the turn completes',
      run: async (h) => {
        await h.adapter.resumeTask('t1', 'thread-1', 'hi');
        h.last().emit('turn/completed', turn('completed'));
      },
      expectEvent: 'TASK_COMPLETE',
    },
    {
      name: 'the turn is interrupted',
      run: async (h) => {
        await h.adapter.resumeTask('t1', 'thread-1', 'hi');
        h.last().emit('turn/completed', turn('interrupted'));
      },
      expectEvent: 'ERROR',
    },
    {
      name: 'the turn fails',
      run: async (h) => {
        await h.adapter.resumeTask('t1', 'thread-1', 'hi');
        h.last().emit('turn/completed', turn('failed', { message: 'boom' }));
      },
      expectEvent: 'ERROR',
    },
    {
      name: 'the task is cancelled',
      run: async (h) => {
        await h.adapter.resumeTask('t1', 'thread-1', 'hi');
        await h.adapter.cancelTask('t1');
      },
    },
    {
      name: 'the daemon shuts down',
      run: async (h) => {
        await h.adapter.resumeTask('t1', 'thread-1', 'hi');
        await h.adapter.stopAll();
      },
    },
    {
      name: 'thread/resume is refused',
      arm: (c) => c.responses.set('thread/resume', writerBusy),
      run: async (h) => {
        await h.adapter.resumeTask('t1', 'thread-1', 'hi');
      },
      expectEvent: 'ERROR',
    },
    {
      name: 'turn/start is refused',
      arm: (c) => c.responses.set('turn/start', writerBusy),
      run: async (h) => {
        await h.adapter.resumeTask('t1', 'thread-1', 'hi');
      },
      expectEvent: 'ERROR',
    },
    {
      name: 'thread/start is refused on a fresh session',
      arm: (c) =>
        c.responses.set(
          'thread/start',
          new AppServerError('thread/start', -32602, 'cwd must be absolute')
        ),
      run: async (h) => {
        await h.adapter.startTask('t1', 'hi');
      },
      expectEvent: 'ERROR',
    },
    {
      name: 'the app-server exits underneath us',
      run: async (h) => {
        await h.adapter.resumeTask('t1', 'thread-1', 'hi');
        h.last().options.onExit?.(new Error('codex app-server exited code=1'));
      },
      expectEvent: 'ERROR',
    },
    {
      name: 'the app-server never spawns',
      arm: (c) => {
        c.failStart = new Error('spawn codex ENOENT');
      },
      run: async (h) => {
        await h.adapter.resumeTask('t1', 'thread-1', 'hi');
      },
      expectEvent: 'ERROR',
    },
    {
      name: 'a terminal error notification arrives',
      run: async (h) => {
        await h.adapter.resumeTask('t1', 'thread-1', 'hi');
        h.last().emit('error', {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: false,
          error: { message: 'stream closed' },
        });
      },
      expectEvent: 'ERROR',
    },
    {
      name: 'the task is refused over the concurrency cap',
      run: async (h) => {
        await h.adapter.resumeTask('t1', 'thread-1', 'hi');
        await h.adapter.resumeTask('t2', 'thread-2', 'hi');
        // Only the refused task matters here; drain the one holding the slot.
        h.clients[0].emit('turn/completed', turn('completed'));
      },
      expectEvent: 'ERROR',
      expectClient: false,
    },
  ];

  test.each(cases)(
    '$name leaves no app-server holding the lock',
    async ({ arm, run, expectEvent, expectClient }) => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(console, 'log').mockImplementation(() => {});
      const h = harness(arm, { maxConcurrentTasks: 1 });

      await run(h);

      expect(h.adapter.getRunningTasks()).toEqual([]);
      if (expectClient !== false) {
        expect(h.last().stopped).toBeGreaterThan(0);
      }
      // Whatever else happened, no client the adapter built is still running.
      for (const c of h.clients) expect(c.stopped).toBeGreaterThan(0);
      if (expectEvent) expect(h.types()).toContain(expectEvent);
      jest.restoreAllMocks();
    }
  );
});

describe('release bookkeeping', () => {
  test('a completed task is released exactly once, not once per notification', async () => {
    const h = harness();
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');
    h.last().emit('turn/completed', turn('completed'));
    h.last().emit('turn/completed', turn('completed'));
    expect(h.last().stopped).toBe(1);
    expect(h.events.filter((e) => e.type === 'TASK_COMPLETE')).toHaveLength(1);
  });

  test('a late app-server exit after completion reports no second error', async () => {
    const h = harness();
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');
    h.last().emit('turn/completed', turn('completed'));
    h.last().options.onExit?.(new Error('codex app-server exited code=0'));
    expect(h.events.filter((e) => e.type === 'ERROR')).toHaveLength(0);
    expect(h.last().stopped).toBe(1);
  });

  test('each task gets its own app-server, so one release cannot free another', async () => {
    const h = harness();
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');
    await h.adapter.resumeTask('t2', 'thread-2', 'hi');
    expect(h.clients).toHaveLength(2);
    expect(h.clients[0]).not.toBe(h.clients[1]);

    h.clients[0].emit('turn/completed', turn('completed'));
    expect(h.clients[0].stopped).toBe(1);
    expect(h.clients[1].stopped).toBe(0);
    expect(h.adapter.getRunningTasks()).toEqual(['t2']);
  });

  test('cancel interrupts the turn before dropping the process', async () => {
    const h = harness();
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');
    await h.adapter.cancelTask('t1');
    expect(h.last().requests.map((r) => r.method)).toContain('turn/interrupt');
    expect(h.last().stopped).toBe(1);
  });

  test('an interrupt that fails still releases the thread', async () => {
    const h = harness();
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');
    h.last().responses.set('turn/interrupt', new Error('timed out'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await h.adapter.cancelTask('t1');
    expect(h.last().stopped).toBe(1);
    expect(h.adapter.getRunningTasks()).toEqual([]);
    jest.restoreAllMocks();
  });

  test('cancelling an unknown task is a no-op', async () => {
    const h = harness();
    await expect(h.adapter.cancelTask('nope')).resolves.toBeUndefined();
    expect(h.clients).toHaveLength(0);
  });

  test('a retryable error keeps the turn alive rather than dropping the lock', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');
    h.last().emit('error', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: true,
      error: { message: 'rate limited, retrying' },
    });
    expect(h.last().stopped).toBe(0);
    expect(h.adapter.getRunningTasks()).toEqual(['t1']);
    jest.restoreAllMocks();
  });
});

/**
 * taskId is the session's canonical id and stays the same for every turn, so a
 * user sending a second message before the first turn finishes arrives with a
 * taskId already in the map. Overwriting it would strand the first app-server
 * holding the writer lock with no handle left to stop it – the original defect,
 * re-armed by a one-click action.
 */
describe('a second message on a live session cannot strand the first app-server', () => {
  const cases: {
    name: string;
    second: (h: Harness) => Promise<void>;
  }[] = [
    {
      name: 'a second resume on the same session',
      second: (h) => h.adapter.resumeTask('t1', 'thread-1', 'again'),
    },
    {
      name: 'a start reusing a live taskId',
      second: (h) => h.adapter.startTask('t1', 'again'),
    },
  ];

  test.each(cases)('$name is refused, not swallowed', async ({ second }) => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness();
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');
    expect(h.clients).toHaveLength(1);

    await second(h);

    // No second app-server, and the first is still tracked and still stoppable.
    expect(h.clients).toHaveLength(1);
    expect(h.clients[0].stopped).toBe(0);
    expect(h.adapter.getRunningTasks()).toEqual(['t1']);

    const err = h.events.find((e) => e.type === 'ERROR');
    expect(String(err?.data.error)).toMatch(/already working on something/);
    expect(String(err?.data.error)).not.toMatch(/-32\d{3}/);
    jest.restoreAllMocks();
  });

  test('the first turn still completes and still releases its thread', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness();
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');
    await h.adapter.resumeTask('t1', 'thread-1', 'again');

    h.clients[0].emit('turn/completed', turn('completed'));

    expect(h.clients[0].stopped).toBe(1);
    expect(h.adapter.getRunningTasks()).toEqual([]);
    expect(h.types()).toContain('TASK_COMPLETE');
    jest.restoreAllMocks();
  });

  test('the session is usable again once the first turn ends', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness();
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');
    await h.adapter.resumeTask('t1', 'thread-1', 'refused');
    h.clients[0].emit('turn/completed', turn('completed'));

    await h.adapter.resumeTask('t1', 'thread-1', 'now allowed');

    expect(h.clients).toHaveLength(2);
    expect(h.adapter.getRunningTasks()).toEqual(['t1']);
    jest.restoreAllMocks();
  });
});

/**
 * Handlers hold their task by reference. If a stale one ever acts, it must not
 * be able to stop a later task's app-server or report on its behalf.
 */
describe('a stale task object cannot act on the session that replaced it', () => {
  async function staleAndCurrent() {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    await h.adapter.resumeTask('t1', 'thread-1', 'first');
    const stale = h.clients[0];
    // End the first task properly, then start a new one under the same id.
    stale.emit('turn/completed', turn('completed'));
    await h.adapter.resumeTask('t1', 'thread-1', 'second');
    const current = h.clients[1];
    expect(current).not.toBe(stale);
    return { h, stale, current };
  }

  test('a late turn/completed from the old app-server is ignored', async () => {
    const { h, stale, current } = await staleAndCurrent();
    const before = h.events.filter((e) => e.type === 'TASK_COMPLETE').length;

    stale.emit('turn/completed', turn('completed'));

    expect(current.stopped).toBe(0);
    expect(h.adapter.getRunningTasks()).toEqual(['t1']);
    expect(h.events.filter((e) => e.type === 'TASK_COMPLETE')).toHaveLength(before);
    jest.restoreAllMocks();
  });

  test('a late exit from the old app-server does not fail the new turn', async () => {
    const { h, stale, current } = await staleAndCurrent();

    stale.options.onExit?.(new Error('codex app-server exited code=1'));

    expect(current.stopped).toBe(0);
    expect(h.adapter.getRunningTasks()).toEqual(['t1']);
    expect(h.types()).not.toContain('ERROR');
    jest.restoreAllMocks();
  });
});

describe('the concurrency cap bounds how many app-servers can exist', () => {
  const cases: {
    name: string;
    cap: number;
    tasks: number;
    expectSpawned: number;
  }[] = [
    { name: 'a cap of one admits one', cap: 1, tasks: 3, expectSpawned: 1 },
    { name: 'a cap of two admits two', cap: 2, tasks: 5, expectSpawned: 2 },
    { name: 'work under the cap is untouched', cap: 6, tasks: 4, expectSpawned: 4 },
  ];

  test.each(cases)('$name', async ({ cap, tasks, expectSpawned }) => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness(undefined, { maxConcurrentTasks: cap });
    for (let i = 0; i < tasks; i++) {
      await h.adapter.resumeTask(`t${i}`, `thread-${i}`, 'hi');
    }
    expect(h.clients).toHaveLength(expectSpawned);
    expect(h.adapter.getRunningTasks()).toHaveLength(expectSpawned);
    jest.restoreAllMocks();
  });

  test('a refused task is told to wait, and never silently dropped', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness(undefined, { maxConcurrentTasks: 1 });
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');
    await h.adapter.resumeTask('t2', 'thread-2', 'hi');

    const refused = h.events.find((e) => e.taskId === 't2');
    expect(refused?.type).toBe('ERROR');
    expect(String(refused?.data.error)).toMatch(/Wait for one to finish/);
    expect(String(refused?.data.error)).not.toMatch(/-32\d{3}/);
    jest.restoreAllMocks();
  });

  test('a finished task frees its slot for the next one', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness(undefined, { maxConcurrentTasks: 1 });
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');
    h.clients[0].emit('turn/completed', turn('completed'));
    await h.adapter.resumeTask('t2', 'thread-2', 'hi');
    expect(h.clients).toHaveLength(2);
    expect(h.adapter.getRunningTasks()).toEqual(['t2']);
    jest.restoreAllMocks();
  });
});

describe('a wedged app-server is reaped rather than left holding the lock', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('silence past the idle timeout releases the thread', async () => {
    const h = harness(undefined, { idleTimeoutMs: 1000 });
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');
    expect(h.last().stopped).toBe(0);

    jest.advanceTimersByTime(1001);

    expect(h.last().stopped).toBe(1);
    expect(h.adapter.getRunningTasks()).toEqual([]);
    expect(h.types()).toContain('ERROR');
  });

  test('activity postpones the reaper, so a long turn is not cut short', async () => {
    const h = harness(undefined, { idleTimeoutMs: 1000 });
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');

    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(900);
      h.last().emit('item/started', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'reasoning', id: `r${i}`, summary: [], content: [] },
      });
    }

    expect(h.last().stopped).toBe(0);
    expect(h.adapter.getRunningTasks()).toEqual(['t1']);

    jest.advanceTimersByTime(1001);
    expect(h.last().stopped).toBe(1);
  });

  test('a released task leaves no timer behind to fire later', async () => {
    const h = harness(undefined, { idleTimeoutMs: 1000 });
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');
    h.last().emit('turn/completed', turn('completed'));

    jest.advanceTimersByTime(5000);

    expect(h.last().stopped).toBe(1);
    expect(h.events.filter((e) => e.type === 'ERROR')).toHaveLength(0);
  });
});

describe('a missing thread falls back to a new session without stranding a lock', () => {
  test('the refused client is stopped and a fresh one starts the session', async () => {
    const h = harness((c, index) => {
      if (index === 0) {
        c.responses.set(
          'thread/resume',
          new AppServerError(
            'thread/resume',
            -32600,
            'no rollout found for thread id thread-1'
          )
        );
      }
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');
    jest.restoreAllMocks();

    expect(h.clients).toHaveLength(2);
    // The client that failed to resume must not keep a lock it may have taken.
    expect(h.clients[0].stopped).toBe(1);
    expect(h.clients[1].requests.map((r) => r.method)).toEqual([
      'thread/start',
      'turn/start',
    ]);
    expect(h.types()).toContain('SESSION_STARTED');
    expect(h.types()).not.toContain('ERROR');
  });

  test('the fallback does not consume two slots at once', async () => {
    const h = harness(
      (c, index) => {
        if (index === 0) {
          c.responses.set(
            'thread/resume',
            new AppServerError('thread/resume', -32600, 'thread not found')
          );
        }
      },
      { maxConcurrentTasks: 1 }
    );
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');
    jest.restoreAllMocks();

    expect(h.clients).toHaveLength(2);
    expect(h.adapter.getRunningTasks()).toEqual(['t1']);
    expect(h.types()).not.toContain('ERROR');
  });
});

describe('the writer conflict reaches the user as advice, not a code', () => {
  test('a locked thread produces the friendly message', async () => {
    const h = harness((c) => c.responses.set('thread/resume', writerBusy));
    await h.adapter.resumeTask('t1', 'thread-1', 'hi');

    const error = h.events.find((e) => e.type === 'ERROR');
    expect(error?.data.error).toBe(
      'It appears that this session is open in your terminal. Cmd+Ctrl cannot interact with it as long as it is open there.'
    );
    expect(String(error?.data.error)).not.toContain('-32600');
  });
});

describe('defaultLimits', () => {
  const cases: {
    name: string;
    env: Record<string, string | undefined>;
    expected: Partial<AdapterLimits>;
  }[] = [
    {
      name: 'falls back to the built-in bounds',
      env: {},
      expected: { maxConcurrentTasks: 6, idleTimeoutMs: 30 * 60 * 1000 },
    },
    {
      name: 'an operator can raise the cap',
      env: { CODEX_MAX_CONCURRENT_TASKS: '12' },
      expected: { maxConcurrentTasks: 12 },
    },
    {
      name: 'an operator can shorten the reaper',
      env: { CODEX_TASK_IDLE_TIMEOUT_MS: '60000' },
      expected: { idleTimeoutMs: 60000 },
    },
    {
      name: 'a non-numeric value is ignored rather than disabling the cap',
      env: { CODEX_MAX_CONCURRENT_TASKS: 'lots' },
      expected: { maxConcurrentTasks: 6 },
    },
    {
      name: 'zero is ignored, since it would refuse every task',
      env: { CODEX_MAX_CONCURRENT_TASKS: '0' },
      expected: { maxConcurrentTasks: 6 },
    },
    {
      name: 'a negative timeout is ignored rather than reaping instantly',
      env: { CODEX_TASK_IDLE_TIMEOUT_MS: '-1' },
      expected: { idleTimeoutMs: 30 * 60 * 1000 },
    },
  ];

  test.each(cases)('$name', ({ env, expected }) => {
    const saved: Record<string, string | undefined> = {};
    for (const k of ['CODEX_MAX_CONCURRENT_TASKS', 'CODEX_TASK_IDLE_TIMEOUT_MS']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) process.env[k] = v;
    }

    expect(defaultLimits()).toMatchObject(expected);

    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
});

describe('force quit never targets a session this daemon is running', () => {
  // Identifying our own app-server by pid cannot work: codex's npm install is a
  // node wrapper that spawns the Rust binary as a grandchild, and it is the
  // grandchild that takes the writer lock. Session identity is what we know.
  const cases: {
    name: string;
    setup: (h: Harness) => Promise<void>;
    wantRunning: boolean;
  }[] = [
    {
      name: 'while a turn is in flight',
      setup: async (h) => {
        await h.adapter.startTask('s1', 'hello');
      },
      wantRunning: true,
    },
    {
      name: 'while the app-server is still shutting down',
      setup: async (h) => {
        await h.adapter.startTask('s1', 'hello');
        h.last().emit('turn/completed', turn('completed'));
      },
      wantRunning: true,
    },
    {
      name: 'for a session this daemon has never run',
      setup: async () => {},
      wantRunning: false,
    },
  ];

  cases.forEach(({ name, setup, wantRunning }) => {
    it(`${wantRunning ? 'refuses' : 'allows'} a force quit ${name}`, async () => {
      const h = harness();
      await setup(h);
      expect(h.adapter.isRunning('s1')).toBe(wantRunning);
    });
  });
});
