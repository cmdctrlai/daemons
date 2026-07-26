import { CmdCtrlConfig, Credentials } from '../config/config';

// Must be declared before jest.mock since the factory is hoisted
let mockWsInstance: any;
// Governs how each newly constructed MockWS behaves on the next tick, so
// tests can simulate a connect failure before the client's 'open' handler
// would otherwise fire. Reset between tests.
let nextConnectOutcome: 'open' | { unexpectedResponse: number } = 'open';
// Counts every MockWS construction, i.e. every connection attempt made by
// the client (initial + every reconnect). Reset between tests.
let connectAttemptCount = 0;

jest.mock('ws', () => {
  const { EventEmitter: EE } = require('events');

  class MockWS extends EE {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1; // OPEN

    constructor(_url: string, _opts?: any) {
      super();
      mockWsInstance = this;
      connectAttemptCount++;
      const outcome = nextConnectOutcome;
      setTimeout(() => {
        if (outcome === 'open') {
          this.emit('open');
        } else {
          this.readyState = 0; // CONNECTING – matches real ws behavior on a rejected upgrade
          this.emit('unexpected-response', { destroy: () => {} }, { statusCode: outcome.unexpectedResponse });
        }
      }, 0);
    }

    send() {}
    ping() {}
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.readyState = 3; }
  }

  return { __esModule: true, default: MockWS };
});

import { DaemonClient } from './websocket';

function createClient(): DaemonClient {
  const config: CmdCtrlConfig = {
    serverUrl: 'https://app.cmd-ctrl.ai',
    deviceId: 'dev-1',
    deviceName: 'test-device',
  };
  const credentials: Credentials = {
    accessToken: 'at-test',
    refreshToken: 'rt-test',
    expiresAt: Date.now() + 3600_000,
  };
  return new DaemonClient(config, credentials);
}

// The mock WS schedules its own 0ms timer to emit its outcome, and the
// fake-timer runtime schedules its own housekeeping timers too – filter
// both out and keep only the real reconnect-scheduling delay.
function lastReconnectDelay(spy: jest.SpyInstance): number {
  const real = spy.mock.calls.filter((call) => (call[1] as number) > 0);
  return real[real.length - 1][1] as number;
}

describe('DaemonClient reconnect behavior', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    nextConnectOutcome = 'open';
    connectAttemptCount = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('reconnect backoff', () => {
    test.each([
      { failures: 1, expectedDelay: 500 },    // 0.5 * min(60000, 1000 * 2^0)
      { failures: 2, expectedDelay: 1000 },   // 0.5 * 2000
      { failures: 3, expectedDelay: 2000 },   // 0.5 * 4000
      { failures: 5, expectedDelay: 8000 },   // 0.5 * 16000
      { failures: 7, expectedDelay: 30000 },  // 0.5 * min(60000, 64000)
      { failures: 8, expectedDelay: 30000 },  // stays capped past the cap tier
    ])('delay after $failures consecutive failures is capped exponential with jitter ($expectedDelay ms)', async ({ failures, expectedDelay }) => {
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

      nextConnectOutcome = { unexpectedResponse: 500 };
      const client = createClient();
      client.connect().catch(() => {});

      let lastDelay = 0;
      for (let i = 0; i < failures; i++) {
        setTimeoutSpy.mockClear();
        await jest.advanceTimersByTimeAsync(lastDelay);
        // The reconnect timer firing creates a new MockWS, which schedules
        // its own 0ms timer to emit its outcome – give that a tick to run.
        await jest.advanceTimersByTimeAsync(1);
        lastDelay = lastReconnectDelay(setTimeoutSpy);
      }

      expect(lastDelay).toBe(expectedDelay);
      await client.disconnect();
    });

    test('retries are unbounded – no cap on the number of reconnect attempts', async () => {
      nextConnectOutcome = { unexpectedResponse: 500 };
      const client = createClient();
      client.connect().catch(() => {});

      for (let i = 0; i < 20; i++) {
        await jest.advanceTimersByTimeAsync(60000);
      }

      expect(connectAttemptCount).toBeGreaterThan(15);
      await client.disconnect();
    });

    test('a successful connection resets the backoff sequence', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

      nextConnectOutcome = { unexpectedResponse: 500 };
      const client = createClient();
      client.connect().catch(() => {});

      let lastDelay = 0;
      for (let i = 0; i < 3; i++) {
        setTimeoutSpy.mockClear();
        await jest.advanceTimersByTimeAsync(lastDelay);
        await jest.advanceTimersByTimeAsync(1);
        lastDelay = lastReconnectDelay(setTimeoutSpy);
      }
      expect(lastDelay).toBeGreaterThan(500);

      nextConnectOutcome = 'open';
      await jest.advanceTimersByTimeAsync(lastDelay);
      await jest.advanceTimersByTimeAsync(0);

      setTimeoutSpy.mockClear();
      nextConnectOutcome = { unexpectedResponse: 500 };
      mockWsInstance.emit('close');
      const resetDelay = lastReconnectDelay(setTimeoutSpy);

      expect(resetDelay).toBe(500); // back to attempt-0 tier: 0.5 * 1000
      await client.disconnect();
    });
  });

  describe('auth failure handling (401)', () => {
    test('never gives up on repeated 401s – keeps retrying past the old give-up threshold', async () => {
      nextConnectOutcome = { unexpectedResponse: 401 };
      const client = createClient();

      client.connect().catch(() => {});
      for (let i = 0; i < 10; i++) {
        await jest.advanceTimersByTimeAsync(60000);
      }

      // The daemon used to call process.exit(1) after 5 consecutive 401s;
      // it must now keep making connection attempts indefinitely instead.
      expect(connectAttemptCount).toBeGreaterThan(9);
      await client.disconnect();
    });
  });
});
