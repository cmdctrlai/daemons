import { EventEmitter } from 'events';

// Track what mock HTTP should return
let mockStatus = 200;
let mockBody: object = {};
let mockShouldError = false;

jest.mock('http', () => {
  const { EventEmitter: EE } = require('events');
  return {
    request: jest.fn((_opts: any, cb?: any) => {
      const req = new EE();
      (req as any).write = jest.fn();
      (req as any).end = jest.fn(() => {
        if (mockShouldError) {
          process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
          return;
        }
        if (cb) {
          const res = new EE();
          (res as any).statusCode = mockStatus;
          cb(res);
          process.nextTick(() => {
            const body = JSON.stringify(mockBody);
            if (body) res.emit('data', body);
            res.emit('end');
          });
        }
      });
      return req;
    }),
  };
});

jest.mock('https', () => {
  const { EventEmitter: EE } = require('events');
  return {
    request: jest.fn((_opts: any, cb?: any) => {
      const req = new EE();
      (req as any).write = jest.fn();
      (req as any).end = jest.fn(() => {
        if (mockShouldError) {
          process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
          return;
        }
        if (cb) {
          const res = new EE();
          (res as any).statusCode = mockStatus;
          cb(res);
          // Use process.nextTick so it fires even with fake timers
          process.nextTick(() => {
            const body = JSON.stringify(mockBody);
            if (body) res.emit('data', body);
            res.emit('end');
          });
        }
      });
      return req;
    }),
  };
});

import { requestDeviceCode, pollForToken, unregisterDevice } from '../register';

function setMockResponse(status: number, body: object, shouldError = false) {
  mockStatus = status;
  mockBody = body;
  mockShouldError = shouldError;
}

describe('requestDeviceCode', () => {
  beforeEach(() => {
    mockShouldError = false;
  });

  test('returns device code response on success', async () => {
    const responseData = {
      deviceCode: 'dc-123',
      userCode: 'ABCD-1234',
      verificationUrl: 'https://app.cmd-ctrl.ai/verify',
      expiresIn: 900,
      interval: 5,
    };
    setMockResponse(200, responseData);

    const result = await requestDeviceCode(
      'https://app.cmd-ctrl.ai', 'Work Laptop', 'hostname', 'claude_code'
    );
    expect(result).toEqual(responseData);
  });

  test('throws on non-200 response', async () => {
    setMockResponse(500, { error: 'internal' });

    await expect(
      requestDeviceCode('https://app.cmd-ctrl.ai', 'Laptop', 'host', 'agent')
    ).rejects.toThrow('Failed to get device code');
  });
});

describe('pollForToken', () => {
  test('returns registration result on immediate success', async () => {
    const tokenResponse = {
      deviceId: 'dev-1',
      refreshToken: 'rt-abc',
      accessToken: 'at-xyz',
      expiresIn: 3600,
    };
    setMockResponse(200, tokenResponse);

    jest.useFakeTimers();
    const pollPromise = pollForToken('https://app.cmd-ctrl.ai', 'dc-123', 1, 60);
    await jest.advanceTimersByTimeAsync(1000);
    const result = await pollPromise;
    jest.useRealTimers();

    expect(result).toEqual(tokenResponse);
  });

  test('returns null when expired', async () => {
    setMockResponse(400, { error: 'authorization_pending' });

    jest.useFakeTimers();
    const pollPromise = pollForToken('https://app.cmd-ctrl.ai', 'dc-123', 1, 1);
    await jest.advanceTimersByTimeAsync(2000);
    const result = await pollPromise;
    jest.useRealTimers();

    expect(result).toBeNull();
  });
});

describe('unregisterDevice', () => {
  beforeEach(() => {
    mockShouldError = false;
  });

  const cases = [
    { name: 'returns true on 204', status: 204, expected: true },
    { name: 'returns true on 200', status: 200, expected: true },
    { name: 'returns true on 404 (already gone)', status: 404, expected: true },
    { name: 'returns false on 500', status: 500, expected: false },
  ];

  test.each(cases)('$name', async ({ status, expected }) => {
    setMockResponse(status, {});
    const result = await unregisterDevice('https://app.cmd-ctrl.ai', 'dev-1', 'rt-abc');
    expect(result).toBe(expected);
  });

  test('returns false on network error', async () => {
    setMockResponse(200, {}, true);
    const result = await unregisterDevice('https://app.cmd-ctrl.ai', 'dev-1', 'rt-abc');
    expect(result).toBe(false);
  });
});
