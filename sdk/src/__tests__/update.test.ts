import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { selfUpdate } from '../update';

jest.mock('child_process', () => ({ execSync: jest.fn() }));
jest.mock('fs', () => ({ readFileSync: jest.fn() }));

const mockExec = execSync as jest.MockedFunction<typeof execSync>;
const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>;

describe('selfUpdate readback', () => {
  const base = {
    packageName: '@cmdctrl/test',
    binName: 'cmdctrl-test',
    currentVersion: '1.0.0',
    latestVersion: '2.0.0',
    restartAfter: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockExec.mockReturnValue(Buffer.from('/usr/lib/node_modules'));
  });

  // The install command succeeding says nothing about what landed on disk.
  // Only the version read back afterwards does, and when that read fails the
  // honest answer is "failed" -- reporting success exits the daemon for a
  // restart that comes back on the old version and tries again forever.
  const cases: Array<{
    name: string;
    readback: () => string;
    expected: 'updated' | 'failed' | 'up-to-date';
  }> = [
    {
      name: 'install landed',
      readback: () => JSON.stringify({ version: '2.0.0' }),
      expected: 'updated',
    },
    {
      name: 'npm root unreadable',
      readback: () => { throw new Error('EACCES'); },
      expected: 'failed',
    },
    {
      name: 'package.json missing',
      readback: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      expected: 'failed',
    },
    {
      name: 'package.json has no version field',
      readback: () => JSON.stringify({ name: '@cmdctrl/test' }),
      expected: 'failed',
    },
    {
      name: 'npm installed the version we already had',
      readback: () => JSON.stringify({ version: '1.0.0' }),
      expected: 'up-to-date',
    },
  ];

  test.each(cases)('$name -> $expected', async ({ readback, expected }) => {
    mockRead.mockImplementation(readback as never);
    const result = await selfUpdate(base);
    expect(result.status).toBe(expected);
  });

  test('an unreadable install never reports a version it cannot prove', async () => {
    mockRead.mockImplementation(() => { throw new Error('EACCES'); });
    const result = await selfUpdate(base);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/could not be read back/);
  });
});
