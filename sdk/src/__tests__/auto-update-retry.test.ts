import { EventEmitter } from 'events';

let mockWsInstance: any;
let nextConnectOutcome: 'open' | { unexpectedResponse: number; body?: string; headers?: Record<string, string> } | 'hang' = 'open';
let onOpenGreeting: Record<string, unknown> | null = null;
let connectAttemptCount = 0;

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
      connectAttemptCount++;
      const outcome = nextConnectOutcome;
      if (outcome === 'hang') return;
      setTimeout(() => {
        if (outcome === 'open') {
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
    close() { this.readyState = 3; this.emit('close'); }
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

describe('auto-update retry state machine', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    nextConnectOutcome = 'open';
    onOpenGreeting = null;
    connectAttemptCount = 0;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  // ---------------------------------------------------------------
  // A: how many installs, and at what wall-clock offsets?
  // ---------------------------------------------------------------
  test('caps a failing target at 4 installs, at 0/60/180/420s', async () => {
    const at: number[] = [];
    jest.spyOn(updateModule, 'selfUpdate').mockImplementation(async () => {
      at.push(Date.now());
      return { status: 'failed', fromVersion: '1.0.0', toVersion: '2.0.0', error: 'EACCES' } as never;
    });
    silence();
    onOpenGreeting = AVAILABLE;

    const client = createClient({
      autoUpdate: true,
      autoUpdateConfig: { packageName: '@cmdctrl/test', binName: 'cmdctrl-test' },
    });
    try {
      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;
      const t0 = Date.now();
      await jest.advanceTimersByTimeAsync(3_600_000);

      expect(at.map((t) => Math.round((t - t0) / 1000))).toEqual([0, 60, 180, 420]);
    } finally {
      await client.disconnect();
    }
  });

  test('reconnect greetings never reset the failure count', async () => {
    const calls: number[] = [];
    jest.spyOn(updateModule, 'selfUpdate').mockImplementation(async () => {
      calls.push(Date.now());
      return { status: 'failed', fromVersion: '1.0.0', toVersion: '2.0.0', error: 'EACCES' } as never;
    });
    silence();
    onOpenGreeting = AVAILABLE;

    const client = createClient({
      autoUpdate: true,
      autoUpdateConfig: { packageName: '@cmdctrl/test', binName: 'cmdctrl-test' },
    });
    try {
      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;
      // Churn the socket every 10s for an hour: each reconnect is greeted.
      for (let i = 0; i < 360; i++) {
        await jest.advanceTimersByTimeAsync(10_000);
        if (mockWsInstance && mockWsInstance.readyState === 1) {
          mockWsInstance.emit('close', 1006, Buffer.from('churn'));
        }
      }
      expect(calls.length).toBe(4);
    } finally {
      await client.disconnect();
    }
  });

  // ---------------------------------------------------------------
  // B: selfUpdate rejecting instead of resolving
  // ---------------------------------------------------------------
  test('a throw out of selfUpdate is a failed install, not a permanent outage', async () => {
    const selfUpdate = jest.spyOn(updateModule, 'selfUpdate')
      .mockRejectedValue(new Error('boom'));
    silence();
    onOpenGreeting = AVAILABLE;

    const client = createClient({
      autoUpdate: true,
      autoUpdateConfig: { packageName: '@cmdctrl/test', binName: 'cmdctrl-test' },
    });
    try {
      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;
      await jest.advanceTimersByTimeAsync(10);
      connectAttemptCount = 0;
      await jest.advanceTimersByTimeAsync(3_600_000);

      // Correct: either it comes back on the old version, or it retries.
      // Doing neither is a silent permanent outage.
      const state = { reconnects: connectAttemptCount, installs: selfUpdate.mock.calls.length };
      expect(state.reconnects + (state.installs - 1)).toBeGreaterThan(0);
    } finally {
      await client.disconnect();
    }
  });

  // ---------------------------------------------------------------
  // C: a real shutdown while an install is in flight
  // ---------------------------------------------------------------
  test('disconnect() mid-install stays down instead of coming back', async () => {
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

    release({ status: 'failed', fromVersion: '1.0.0', toVersion: '2.0.0', error: 'EACCES' });
    await jest.advanceTimersByTimeAsync(1);

    const reconnectedAfterShutdown = connectAttemptCount;
    const timersAfterShutdown = jest.getTimerCount();
    await jest.advanceTimersByTimeAsync(120_000);
    const installsAfterShutdown = selfUpdate.mock.calls.length;

    // eslint-disable-next-line no-console
    console.info('C after shutdown:', JSON.stringify({
      reconnectedAfterShutdown, timersAfterShutdown, installsAfterShutdown,
    }));
    expect({ reconnectedAfterShutdown, installsAfterShutdown, timersAfterShutdown })
      .toEqual({ reconnectedAfterShutdown: 0, installsAfterShutdown: 1, timersAfterShutdown: 0 });
  });

  // ---------------------------------------------------------------
  // E: a new advertised target while a retry is pending
  // ---------------------------------------------------------------
  test('a new target cancels the pending retry for the old one', async () => {
    const targets: (string | undefined)[] = [];
    jest.spyOn(updateModule, 'selfUpdate').mockImplementation(async (o: any) => {
      targets.push(o.latestVersion);
      return { status: 'failed', fromVersion: '1.0.0', toVersion: o.latestVersion, error: 'EACCES' } as never;
    });
    silence();
    onOpenGreeting = AVAILABLE;

    const client = createClient({
      autoUpdate: true,
      autoUpdateConfig: { packageName: '@cmdctrl/test', binName: 'cmdctrl-test' },
    });
    try {
      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;
      await jest.advanceTimersByTimeAsync(10); // attempt 1 on 2.0.0 fails, retry armed
      expect(targets).toEqual(['2.0.0']);

      // Server publishes a new target 10s in.
      onOpenGreeting = { ...AVAILABLE, latest_version: '3.0.0' };
      await jest.advanceTimersByTimeAsync(10_000);
      simulateMessage({ ...AVAILABLE, latest_version: '3.0.0' });
      await jest.advanceTimersByTimeAsync(10);

      // 2.0.0 must never be attempted again: its retry was cancelled.
      await jest.advanceTimersByTimeAsync(3_600_000);
      expect(targets.filter((t) => t === '2.0.0').length).toBe(1);
    } finally {
      await client.disconnect();
    }
  });

  // ---------------------------------------------------------------
  // F: lastVersionStatus poisoned by a 'current' greeting
  // ---------------------------------------------------------------
  test('a "current" greeting never becomes something a retry installs', async () => {
    const targets: any[] = [];
    jest.spyOn(updateModule, 'selfUpdate').mockImplementation(async (o: any) => {
      targets.push(o.latestVersion);
      return { status: 'failed', fromVersion: '1.0.0', toVersion: '2.0.0', error: 'EACCES' } as never;
    });
    silence();
    onOpenGreeting = AVAILABLE;

    const client = createClient({
      autoUpdate: true,
      autoUpdateConfig: { packageName: '@cmdctrl/test', binName: 'cmdctrl-test' },
    });
    try {
      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;
      await jest.advanceTimersByTimeAsync(10); // attempt 1 fails, retry armed for 60s
      expect(targets.length).toBe(1);

      // Server rolls its policy back: we are current after all.
      simulateMessage({ type: 'version_status', status: 'current', your_version: '1.0.0', latest_version: '1.0.0' });
      await jest.advanceTimersByTimeAsync(10);

      // 60s later the retry fires against the 'current' message. The cap for
      // 2.0.0 should still bind: at most 4 installs of 2.0.0, ever.
      await jest.advanceTimersByTimeAsync(3_600_000);
      // eslint-disable-next-line no-console
      console.info('F installs in 1h:', targets.length, 'targets:', JSON.stringify(targets.slice(0, 12)));
      expect(targets.filter((t) => t === '2.0.0').length).toBeLessThanOrEqual(4);
    } finally {
      await client.disconnect();
    }
  });

  // ---------------------------------------------------------------
  // I: onBeforeUpdate that never settles (adapter.stopAll() wedged)
  // ---------------------------------------------------------------
  test('a hung onBeforeUpdate does not take the daemon permanently offline', async () => {
    const selfUpdate = jest.spyOn(updateModule, 'selfUpdate');
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
    try {
      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;
      await jest.advanceTimersByTimeAsync(10);
      // Server drops us while onBeforeUpdate is hung.
      mockWsInstance.emit('close', 1006, Buffer.from('gone'));
      connectAttemptCount = 0;
      await jest.advanceTimersByTimeAsync(3_600_000);

      // eslint-disable-next-line no-console
      console.info('I after 1h:', JSON.stringify({
        reconnects: connectAttemptCount, installs: selfUpdate.mock.calls.length,
      }));
      // Pre-b39e5f5d the daemon kept reconnecting on the old version here.
      expect(connectAttemptCount).toBeGreaterThan(0);
    } finally {
      await client.disconnect();
    }
  });

  // ---------------------------------------------------------------
  // G: unsupported platform stops forever
  // ---------------------------------------------------------------
  test('an unsupported platform never retries', async () => {
    jest.spyOn(updateModule, 'isAutoUpdateSupported').mockReturnValue(false);
    const selfUpdate = jest.spyOn(updateModule, 'selfUpdate');
    silence();
    onOpenGreeting = AVAILABLE;

    const client = createClient({
      autoUpdate: true,
      autoUpdateConfig: { packageName: '@cmdctrl/test', binName: 'cmdctrl-test' },
    });
    try {
      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;
      await jest.advanceTimersByTimeAsync(3_600_000);
      expect(selfUpdate).not.toHaveBeenCalled();
    } finally {
      await client.disconnect();
    }
  });

  // ---------------------------------------------------------------
  // H: deferred (pending) update bypasses the cap?
  // ---------------------------------------------------------------
  test('a deferred update queued behind a task respects the cap', async () => {
    const at: number[] = [];
    jest.spyOn(updateModule, 'selfUpdate').mockImplementation(async () => {
      at.push(Date.now());
      return { status: 'failed', fromVersion: '1.0.0', toVersion: '2.0.0', error: 'EACCES' } as never;
    });
    silence();

    let busy = true;
    const client = createClient({
      autoUpdate: true,
      autoUpdateConfig: { packageName: '@cmdctrl/test', binName: 'cmdctrl-test' },
    });
    client.setRunningTasksProvider(() => (busy ? ['t1'] : []));
    onOpenGreeting = AVAILABLE;
    try {
      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;
      await jest.advanceTimersByTimeAsync(10);
      expect(at.length).toBe(0); // deferred

      busy = false;
      await jest.advanceTimersByTimeAsync(3_600_000);
      expect(at.length).toBe(4);
    } finally {
      await client.disconnect();
    }
  });
});
