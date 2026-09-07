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

import { requestDeviceCode, pollForToken, unregisterDevice, displayVerification } from '../register';

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

describe('displayVerification', () => {
  function fakeStream(isTTY: boolean, columns?: number) {
    const write = jest.fn();
    return { write, isTTY, columns } as unknown as NodeJS.WriteStream & { write: jest.Mock };
  }

  const url = 'https://app.cmd-ctrl.ai/verify?code=ABCD-1234';

  test('always prints the URL and user code as plain text', () => {
    const stream = fakeStream(false);
    displayVerification(url, 'ABCD-1234', stream);
    const output = stream.write.mock.calls[0][0] as string;
    expect(output).toContain(url);
    expect(output).toContain('Code: ABCD-1234');
    expect(output).toContain('Waiting for verification...');
  });

  test('skips the QR block when stdout is not a TTY (piped output)', () => {
    const stream = fakeStream(false);
    displayVerification(url, 'ABCD-1234', stream);
    const output = stream.write.mock.calls[0][0] as string;
    expect(output).not.toMatch(/[█▀▄]/);
  });

  test('renders the QR block on a wide TTY', () => {
    const stream = fakeStream(true, 80);
    displayVerification(url, 'ABCD-1234', stream);
    const output = stream.write.mock.calls[0][0] as string;
    expect(output).toMatch(/[█▀▄]/);
  });

  test('falls back to a note when the TTY is too narrow for the QR', () => {
    const stream = fakeStream(true, 10);
    displayVerification(url, 'ABCD-1234', stream);
    const output = stream.write.mock.calls[0][0] as string;
    expect(output).not.toMatch(/[█▀▄]/);
    expect(output).toContain('terminal too narrow');
    expect(output).toContain(url); // still usable without the QR
  });

  test('falls back to 80 columns when the TTY reports no width', () => {
    const stream = fakeStream(true, undefined);
    displayVerification(url, 'ABCD-1234', stream);
    const output = stream.write.mock.calls[0][0] as string;
    expect(output).toMatch(/[█▀▄]/);
  });
});
