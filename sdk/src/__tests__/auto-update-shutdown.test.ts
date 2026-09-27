import { EventEmitter } from 'events';

let mockWsInstance: any;
let nextConnectOutcome: 'open' | { unexpectedResponse: number; body?: string; headers?: Record<string, string> } | 'hang' = 'open';
let onOpenGreeting: Record<string, unknown> | null = null;
let connectAttemptCount = 0;
let wsInstances: any[] = [];
/** Model daemon_hub.go: one live connection per device, a new one kicks the old. */
let oneConnPerDevice = false;

jest.mock('ws', () => {
  const { EventEmitter: EE } = require('events');

  class MockWS extends EE {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    sentMessages: any[] = [];

    constructor(_url: string, _opts?: any) {
      super();
      mockWsInstance = this;
      wsInstances.push(this);
      connectAttemptCount++;
      const outcome = nextConnectOutcome;
      if (outcome === 'hang') return;
      setTimeout(() => {
        if (outcome === 'open') {
          if (oneConnPerDevice) {
            for (const w of wsInstances) {
              if (w !== this && w.readyState === 1) {
                w.readyState = 3;
                w.emit('close', 1006, Buffer.from('replaced'));
              }
            }
          }
          this.emit('open');
          if (onOpenGreeting) {
            const greeting = onOpenGreeting;
            setTimeout(() => this.emit('message', JSON.stringify(greeting)), 0);
          }
        } else {
          this.readyState = 0;
          const res = new EE();
          (res as any).statusCode = outcome.unexpectedResponse;
          (res as any).headers = outcome.headers ?? {};
          this.emit('unexpected-response', { destroy: () => {} }, res);
          setTimeout(() => {
            if (outcome.body !== undefined) res.emit('data', outcome.body);
            res.emit('end');
          }, 0);
        }
      }, 0);
    }

    send(data: string) { this.sentMessages.push(JSON.parse(data)); }
    ping() {}
    // Real ws starts a closing handshake and delivers 'close' on a later tick.
    // A synchronous emit hides every ordering bug between a self-initiated
    // close and whatever the client does next.
    close() {
      if (this.readyState !== 1) return;
      this.readyState = 2;
      setTimeout(() => { this.readyState = 3; this.emit('close', 1000, Buffer.from('bye')); }, 5);
    }
    terminate() { this.readyState = 3; }
  }

  return { __esModule: true, default: MockWS };
});

import { DaemonClient } from '../client';
import * as updateModule from '../update';

function createClient(overrides: Record<string, any> = {}): DaemonClient {
  return new DaemonClient({
    serverUrl: 'https://app.cmd-ctrl.ai',
    deviceId: 'dev-1',
    agentType: 'test_agent',
    token: 'rt-test',
    version: '1.0.0',
    ...overrides,
  });
}

function simulateMessage(msg: Record<string, unknown>) {
  mockWsInstance.emit('message', JSON.stringify(msg));
}

function silence() {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
}

const AVAILABLE = {
  type: 'version_status',
  status: 'update_available',
  your_version: '1.0.0',
  latest_version: '2.0.0',
};

const REQUIRED = {
  type: 'version_status',
  status: 'update_required',
  your_version: '1.0.0',
  latest_version: '2.0.0',
  min_version: '2.0.0',
};

describe('auto-update shutdown and deferred-update paths', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    nextConnectOutcome = 'open';
    onOpenGreeting = null;
    connectAttemptCount = 0;
    wsInstances = [];
    oneConnPerDevice = false;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  // ---------------------------------------------------------------
  // R1: disconnect() during onBeforeUpdate -- the install has not started
  //     yet, so the shutdown should stop it. Req 7.
  // ---------------------------------------------------------------
  test('disconnect() while onBeforeUpdate is running cancels the install', async () => {
    const selfUpdate = jest.spyOn(updateModule, 'selfUpdate').mockResolvedValue({
      status: 'updated', fromVersion: '1.0.0', toVersion: '2.0.0',
    } as never);
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    silence();
    onOpenGreeting = AVAILABLE;

    // A realistic adapter shutdown: takes 5s, well inside the 30s budget.
    const client = createClient({
      autoUpdate: true,
      autoUpdateConfig: {
        packageName: '@cmdctrl/test',
        binName: 'cmdctrl-test',
        onBeforeUpdate: () => new Promise<void>((r) => setTimeout(r, 5_000)),
      },
    });
    const p = client.connect();
    await jest.advanceTimersByTimeAsync(0);
    await p;
    await jest.advanceTimersByTimeAsync(1);
    expect(selfUpdate).not.toHaveBeenCalled(); // still inside the hook

    // The user hits Ctrl-C one second in. Nothing has been installed yet.
    await client.disconnect();

    await jest.advanceTimersByTimeAsync(60_000);

    // eslint-disable-next-line no-console
    console.info('R1:', JSON.stringify({
      installs: selfUpdate.mock.calls.length,
      processExits: exit.mock.calls.length,
    }));
    expect({ installs: selfUpdate.mock.calls.length, processExits: exit.mock.calls.length })
      .toEqual({ installs: 0, processExits: 0 });
  });

  // ---------------------------------------------------------------
  // R2: the same, but the hook hangs and the 30s timeout releases it.
  // ---------------------------------------------------------------
  test('disconnect() while onBeforeUpdate is hung cancels the install the timeout would have started', async () => {
    const selfUpdate = jest.spyOn(updateModule, 'selfUpdate').mockResolvedValue({
      status: 'failed', fromVersion: '1.0.0', toVersion: '2.0.0', error: 'EACCES',
    } as never);
    silence();
    onOpenGreeting = AVAILABLE;

    const client = createClient({
      autoUpdate: true,
      autoUpdateConfig: {
        packageName: '@cmdctrl/test',
        binName: 'cmdctrl-test',
        onBeforeUpdate: () => new Promise<void>(() => {}),
      },
    });
    const p = client.connect();
    await jest.advanceTimersByTimeAsync(0);
    await p;
    await jest.advanceTimersByTimeAsync(1);
    await client.disconnect();

    await jest.advanceTimersByTimeAsync(60_000);

    // eslint-disable-next-line no-console
    console.info('R2:', JSON.stringify({ installs: selfUpdate.mock.calls.length }));
    expect(selfUpdate).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------
  // R3: disconnect() mid-install, and the install turns out to be a no-op.
  //     The 'up-to-date' branch never consults updateMayResume(). Req 7.
  // ---------------------------------------------------------------
  test('disconnect() mid-install wins even when the install turns out to be a no-op', async () => {
    let release: (r: any) => void = () => {};
    const selfUpdate = jest.spyOn(updateModule, 'selfUpdate').mockImplementation(
      () => new Promise((res) => { release = res; })
    );
    silence();
    onOpenGreeting = AVAILABLE;

    const client = createClient({
      autoUpdate: true,
      autoUpdateConfig: { packageName: '@cmdctrl/test', binName: 'cmdctrl-test' },
    });
    const p = client.connect();
    await jest.advanceTimersByTimeAsync(0);
    await p;
    await jest.advanceTimersByTimeAsync(1);
    expect(selfUpdate).toHaveBeenCalledTimes(1);

    // The user hits Ctrl-C. The install is still running.
    await client.disconnect();
    connectAttemptCount = 0;

    // npm had nothing newer: the server's target is not published yet.
    release({ status: 'up-to-date', fromVersion: '1.0.0', toVersion: '1.0.0' });
    await jest.advanceTimersByTimeAsync(120_000);

    // eslint-disable-next-line no-console
    console.info('R3:', JSON.stringify({
      reconnectsAfterShutdown: connectAttemptCount,
      timers: jest.getTimerCount(),
    }));
    expect(connectAttemptCount).toBe(0);
  });

  // ---------------------------------------------------------------
  // R4: a deferred update outlives the cap on its own target.
  //     maybeRunPendingAutoUpdate() never checks mayAttemptAutoUpdate().
  //     Req 2 (at most 4 attempts per target).
  // ---------------------------------------------------------------
  test('a task finishing after the cap does not buy a 5th install of a dead target', async () => {
    const at: number[] = [];
    jest.spyOn(updateModule, 'selfUpdate').mockImplementation(async () => {
      at.push(Date.now());
      return { status: 'failed', fromVersion: '1.0.0', toVersion: '2.0.0', error: 'EACCES' } as never;
    });
    silence();

    let handle: any = null;
    const client = createClient({
      autoUpdate: true,
      autoUpdateConfig: { packageName: '@cmdctrl/test', binName: 'cmdctrl-test' },
    });
    client.onTaskStart(async (h: any) => {
      handle = h;
      await new Promise<void>(() => {}); // the task runs until we complete it
    });

    try {
      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      // A task is running.
      simulateMessage({ type: 'task_start', task_id: 't1', instruction: 'go', project_path: '/tmp' });
      await jest.advanceTimersByTimeAsync(0);
      expect(handle).not.toBeNull();

      // Server advertises 2.0.0: deferred behind the task.
      simulateMessage(AVAILABLE);
      await jest.advanceTimersByTimeAsync(0);
      expect(at.length).toBe(0);

      // Server then makes 2.0.0 mandatory: that installs immediately, running
      // task or not, and burns all four attempts on a broken host.
      simulateMessage(REQUIRED);
      await jest.advanceTimersByTimeAsync(3_600_000);
      expect(at.length).toBe(4); // cap reached, target is dead
      // update_required + cap means "stay down and let a person install it".
      connectAttemptCount = 0;

      // The task finally finishes.
      handle.complete('done');
      await jest.advanceTimersByTimeAsync(3_600_000);

      // eslint-disable-next-line no-console
      console.info('R4:', JSON.stringify({
        installs: at.length, reconnectsAfterGivingUp: connectAttemptCount,
      }));
      expect({ installs: at.length, reconnectsAfterGivingUp: connectAttemptCount })
        .toEqual({ installs: 4, reconnectsAfterGivingUp: 0 });
    } finally {
      await client.disconnect();
    }
  });

  // ---------------------------------------------------------------
  // R5 (control): an onBeforeUpdate that rejects AFTER the 30s timeout.
  //     Does the late rejection escape as an unhandled rejection?
  // ---------------------------------------------------------------
  test('a hook that rejects after the timeout does not throw unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    jest.spyOn(updateModule, 'selfUpdate').mockResolvedValue({
      status: 'failed', fromVersion: '1.0.0', toVersion: '2.0.0', error: 'EACCES',
    } as never);
    silence();
    onOpenGreeting = AVAILABLE;

    const client = createClient({
      autoUpdate: true,
      autoUpdateConfig: {
        packageName: '@cmdctrl/test',
        binName: 'cmdctrl-test',
        // settles 60s in -- 30s after the timeout already fired
        onBeforeUpdate: () => new Promise<void>((_, rej) => setTimeout(() => rej(new Error('late')), 60_000)),
      },
    });
    try {
      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;
      await jest.advanceTimersByTimeAsync(120_000);
      await Promise.resolve();
      // eslint-disable-next-line no-console
      console.info('R5:', JSON.stringify({ unhandled: unhandled.length, timers: jest.getTimerCount() }));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await client.disconnect();
    }
  });

  // ---------------------------------------------------------------
  // R6 (control): shutdown mid-install, caller reconnects, server then
  //     advertises a NEW target. The stale abandoned flag must not veto it.
  // ---------------------------------------------------------------
  test('a new target after a shutdown-abandoned install is still installed', async () => {
    let release: (r: any) => void = () => {};
    const targets: any[] = [];
    jest.spyOn(updateModule, 'selfUpdate').mockImplementation((o: any) => {
      targets.push(o.latestVersion);
      return new Promise((res) => { release = res; });
    });
    silence();
    onOpenGreeting = AVAILABLE;

    const client = createClient({
      autoUpdate: true,
      autoUpdateConfig: { packageName: '@cmdctrl/test', binName: 'cmdctrl-test' },
    });
    const p = client.connect();
    await jest.advanceTimersByTimeAsync(0);
    await p;
    await jest.advanceTimersByTimeAsync(1);
    expect(targets).toEqual(['2.0.0']);

    await client.disconnect();            // shutdown mid-install
    onOpenGreeting = { ...AVAILABLE, latest_version: '3.0.0' };
    const p2 = client.connect();          // supervisor brings it back
    await jest.advanceTimersByTimeAsync(0);
    await p2;
    release({ status: 'failed', fromVersion: '1.0.0', toVersion: '2.0.0', error: 'EACCES' });
    await jest.advanceTimersByTimeAsync(10);

    // Server advertises a brand new target on the live socket.
    simulateMessage({ ...AVAILABLE, latest_version: '3.0.0' });
    await jest.advanceTimersByTimeAsync(10);

    // eslint-disable-next-line no-console
    console.info('R6:', JSON.stringify({ targets }));
    expect(targets).toContain('3.0.0');
    await client.disconnect();
  });

  // ---------------------------------------------------------------
  // R7: caller does disconnect() then connect(). shouldReconnect is never
  //     restored, so the next dropped socket is a silent permanent outage.
  //     Req 6.
  // ---------------------------------------------------------------
  test('connect() after disconnect() restores the reconnect loop', async () => {
    silence();
    const client = createClient({});
    const p = client.connect();
    await jest.advanceTimersByTimeAsync(0);
    await p;

    await client.disconnect();
    const p2 = client.connect();
    await jest.advanceTimersByTimeAsync(0);
    await p2.catch(() => {});

    connectAttemptCount = 0;
    mockWsInstance.emit('close', 1006, Buffer.from('server went away'));
    await jest.advanceTimersByTimeAsync(3_600_000);

    // eslint-disable-next-line no-console
    console.info('R7:', JSON.stringify({
      reconnects: connectAttemptCount, timers: jest.getTimerCount(),
    }));
    expect(connectAttemptCount).toBeGreaterThan(0);
    await client.disconnect();
  });
});

describe('sockets the client has moved on from', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    nextConnectOutcome = 'open';
    onOpenGreeting = null;
    connectAttemptCount = 0;
    wsInstances = [];
    oneConnPerDevice = false;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  // An update disconnects, blocks the loop in npm, and reconnects before the
  // old socket's 'close' has been delivered. A close handler that is not
  // scoped to its own socket then tears down the live connection's heartbeat
  // and arms a reconnect against it -- a flap that outlives the install.
  test('a close delivered after the client reconnected does not touch the live socket', async () => {
    jest.spyOn(updateModule, 'selfUpdate').mockResolvedValue({
      status: 'failed',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      error: 'EACCES',
    } as never);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    onOpenGreeting = {
      type: 'version_status',
      status: 'update_available',
      your_version: '1.0.0',
      latest_version: '2.0.0',
    };

    oneConnPerDevice = true;
    const client = createClient({
      autoUpdate: true,
      autoUpdateConfig: { packageName: '@cmdctrl/test', binName: 'cmdctrl-test' },
    });
    try {
      const connected = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await connected;

      // Past the install, the reconnect, and the stale close it left behind.
      await jest.advanceTimersByTimeAsync(30000);
      const settled = connectAttemptCount;
      await jest.advanceTimersByTimeAsync(30000);

      const live = wsInstances.filter((w) => w.readyState === 1);
      // One failed install must not leave the daemon opening sockets forever,
      // and exactly one connection survives it.
      expect(connectAttemptCount - settled).toBe(0);
      expect(live.length).toBe(1);
    } finally {
      await client.disconnect();
      jest.restoreAllMocks();
    }
  });
});
