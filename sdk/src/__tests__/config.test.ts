import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { ConfigManager, DaemonConfig, DaemonCredentials, spawnDetached } from '../config';

const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

function makeTmpManager(): { manager: ConfigManager; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-config-test-'));
  const manager = new ConfigManager('test-daemon');
  // Override configDir to point at our temp directory
  (manager as any).configDir = tmpDir;
  (manager as any).configFile = path.join(tmpDir, 'config.json');
  (manager as any).credentialsFile = path.join(tmpDir, 'credentials');
  (manager as any).pidFile = path.join(tmpDir, 'daemon.pid');
  return {
    manager,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

describe('ConfigManager', () => {
  describe('config read/write', () => {
    const cases = [
      {
        name: 'round-trips config data',
        config: { serverUrl: 'https://app.cmd-ctrl.ai', deviceId: 'dev-1', deviceName: 'Test' } as DaemonConfig,
      },
      {
        name: 'handles special characters in device name',
        config: { serverUrl: 'http://localhost:4000', deviceId: 'dev-2', deviceName: "Mike's \"Laptop\" (work)" } as DaemonConfig,
      },
    ];

    test.each(cases)('$name', ({ config }) => {
      const { manager, cleanup } = makeTmpManager();
      try {
        manager.writeConfig(config);
        expect(manager.readConfig()).toEqual(config);
      } finally {
        cleanup();
      }
    });

    test('readConfig returns null when file missing', () => {
      const { manager, cleanup } = makeTmpManager();
      try {
        expect(manager.readConfig()).toBeNull();
      } finally {
        cleanup();
      }
    });
  });

  describe('credentials read/write', () => {
    const cases = [
      {
        name: 'round-trips credentials',
        creds: { refreshToken: 'rt-abc123' } as DaemonCredentials,
      },
      {
        name: 'round-trips credentials with optional fields',
        creds: { refreshToken: 'rt-abc', accessToken: 'at-xyz', expiresAt: 1700000000 } as DaemonCredentials,
      },
    ];

    test.each(cases)('$name', ({ creds }) => {
      const { manager, cleanup } = makeTmpManager();
      try {
        manager.writeCredentials(creds);
        expect(manager.readCredentials()).toEqual(creds);
      } finally {
        cleanup();
      }
    });

    test('readCredentials returns null when file missing', () => {
      const { manager, cleanup } = makeTmpManager();
      try {
        expect(manager.readCredentials()).toBeNull();
      } finally {
        cleanup();
      }
    });
  });

  describe('isRegistered', () => {
    const cases = [
      {
        name: 'returns true when both config and credentials exist',
        hasConfig: true,
        hasCreds: true,
        emptyDeviceId: false,
        expected: true,
      },
      {
        name: 'returns false when config missing',
        hasConfig: false,
        hasCreds: true,
        emptyDeviceId: false,
        expected: false,
      },
      {
        name: 'returns false when credentials missing',
        hasConfig: true,
        hasCreds: false,
        emptyDeviceId: false,
        expected: false,
      },
      {
        name: 'returns false when deviceId is empty',
        hasConfig: true,
        hasCreds: true,
        emptyDeviceId: true,
        expected: false,
      },
    ];

    test.each(cases)('$name', ({ hasConfig, hasCreds, emptyDeviceId, expected }) => {
      const { manager, cleanup } = makeTmpManager();
      try {
        if (hasConfig) {
          manager.writeConfig({
            serverUrl: 'https://app.cmd-ctrl.ai',
            deviceId: emptyDeviceId ? '' : 'dev-1',
            deviceName: 'Test',
          });
        }
        if (hasCreds) {
          manager.writeCredentials({ refreshToken: 'rt-abc' });
        }
        expect(manager.isRegistered()).toBe(expected);
      } finally {
        cleanup();
      }
    });
  });

  describe('clearRegistration', () => {
    test('removes config and credentials files', () => {
      const { manager, cleanup } = makeTmpManager();
      try {
        manager.writeConfig({ serverUrl: 'https://x', deviceId: 'd', deviceName: 'n' });
        manager.writeCredentials({ refreshToken: 'rt' });
        expect(manager.isRegistered()).toBe(true);

        manager.clearRegistration();
        expect(manager.readConfig()).toBeNull();
        expect(manager.readCredentials()).toBeNull();
        expect(manager.isRegistered()).toBe(false);
      } finally {
        cleanup();
      }
    });

    test('does not throw when files do not exist', () => {
      const { manager, cleanup } = makeTmpManager();
      try {
        expect(() => manager.clearRegistration()).not.toThrow();
      } finally {
        cleanup();
      }
    });
  });

  describe('PID file', () => {
    test('write, read, and delete PID file', () => {
      const { manager, cleanup } = makeTmpManager();
      try {
        manager.writePidFile(12345);
        expect(manager.readPidFile()).toBe(12345);
        manager.deletePidFile();
        expect(manager.readPidFile()).toBeNull();
      } finally {
        cleanup();
      }
    });

    test('readPidFile returns null when missing', () => {
      const { manager, cleanup } = makeTmpManager();
      try {
        expect(manager.readPidFile()).toBeNull();
      } finally {
        cleanup();
      }
    });
  });

  describe('isDaemonRunning', () => {
    test('returns true for another live PID', () => {
      // Use the parent process – guaranteed to exist and guaranteed not to
      // be `process.pid`, which is special-cased (see below).
      const { manager, cleanup } = makeTmpManager();
      try {
        manager.writePidFile(process.ppid);
        expect(manager.isDaemonRunning()).toBe(true);
      } finally {
        cleanup();
      }
    });

    test('returns false and cleans up stale PID', () => {
      const { manager, cleanup } = makeTmpManager();
      try {
        // Use an extremely high PID that almost certainly doesn't exist
        manager.writePidFile(999999999);
        expect(manager.isDaemonRunning()).toBe(false);
        // Stale PID file should be cleaned up
        expect(manager.readPidFile()).toBeNull();
      } finally {
        cleanup();
      }
    });

    test('returns false when no PID file', () => {
      const { manager, cleanup } = makeTmpManager();
      try {
        expect(manager.isDaemonRunning()).toBe(false);
      } finally {
        cleanup();
      }
    });

    test('returns false when the pidfile names the calling process itself', () => {
      // A detached child sees its own pid in the pidfile (the parent wrote
      // it before exiting) – that must read as "not already running", or
      // the child locks itself out on startup.
      const { manager, cleanup } = makeTmpManager();
      try {
        manager.writePidFile(process.pid);
        expect(manager.isDaemonRunning()).toBe(false);
        // Unlike a stale pid, this is not cleaned up – it's a live pid,
        // just the caller's own.
        expect(manager.readPidFile()).toBe(process.pid);
      } finally {
        cleanup();
      }
    });
  });

  describe('spawnDetached', () => {
    function makeTmpDir(): { dir: string; cleanup: () => void } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-detach-test-'));
      return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    }

    function fakeChild(pid: number) {
      const child = new EventEmitter() as EventEmitter & { pid: number; unref: jest.Mock };
      child.pid = pid;
      child.unref = jest.fn();
      return child;
    }

    const argvCases = [
      { name: 'strips -d', argv: ['node', 'index.js', 'start', '-d'], expectedArgs: ['start'] },
      { name: 'strips --detach', argv: ['node', 'index.js', 'start', '--detach'], expectedArgs: ['start'] },
      {
        name: 'preserves other flags around the detach flag',
        argv: ['node', 'index.js', 'start', '-d', '--foreground'],
        expectedArgs: ['start', '--foreground'],
      },
      { name: 'no-op when detach flag absent', argv: ['node', 'index.js', 'start'], expectedArgs: ['start'] },
    ];

    test.each(argvCases)('$name', ({ argv, expectedArgs }) => {
      const { dir, cleanup } = makeTmpDir();
      const origArgv = process.argv;
      try {
        process.argv = argv;
        mockSpawn.mockReturnValueOnce(fakeChild(42));

        const pidFile = path.join(dir, 'daemon.pid');
        const result = spawnDetached(dir, pidFile);

        expect(mockSpawn).toHaveBeenCalledWith(
          argv[0],
          [argv[1], ...expectedArgs],
          expect.objectContaining({ detached: true }),
        );
        expect(result.pid).toBe(42);
        expect(result.logFile).toBe(path.join(dir, 'daemon.log'));
      } finally {
        process.argv = origArgv;
        cleanup();
      }
    });

    test('writes the child pid – not the parent – to the pidfile', () => {
      const { dir, cleanup } = makeTmpDir();
      const origArgv = process.argv;
      try {
        process.argv = ['node', 'index.js', 'start', '-d'];
        mockSpawn.mockReturnValueOnce(fakeChild(999));

        const pidFile = path.join(dir, 'daemon.pid');
        spawnDetached(dir, pidFile);

        expect(fs.readFileSync(pidFile, 'utf-8')).toBe('999');
        expect(fs.readFileSync(pidFile, 'utf-8')).not.toBe(String(process.pid));
      } finally {
        process.argv = origArgv;
        cleanup();
      }
    });

    test('unrefs the child so the parent can exit', () => {
      const { dir, cleanup } = makeTmpDir();
      const origArgv = process.argv;
      try {
        process.argv = ['node', 'index.js', 'start', '-d'];
        const child = fakeChild(1);
        mockSpawn.mockReturnValueOnce(child);

        spawnDetached(dir, path.join(dir, 'daemon.pid'));

        expect(child.unref).toHaveBeenCalled();
      } finally {
        process.argv = origArgv;
        cleanup();
      }
    });

    test('creates configDir if missing', () => {
      const { dir, cleanup } = makeTmpDir();
      const origArgv = process.argv;
      try {
        process.argv = ['node', 'index.js', 'start', '-d'];
        mockSpawn.mockReturnValueOnce(fakeChild(1));
        const nested = path.join(dir, 'nested', 'config-dir');

        spawnDetached(nested, path.join(nested, 'daemon.pid'));

        expect(fs.existsSync(nested)).toBe(true);
      } finally {
        process.argv = origArgv;
        cleanup();
      }
    });
  });

  describe('ConfigManager.spawnDetached', () => {
    test('delegates to spawnDetached with its own configDir/pidFile', () => {
      const { manager, cleanup } = makeTmpManager();
      const origArgv = process.argv;
      try {
        process.argv = ['node', 'index.js', 'start', '-d'];
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: jest.Mock };
        child.pid = 7;
        child.unref = jest.fn();
        mockSpawn.mockReturnValueOnce(child);

        const result = manager.spawnDetached();

        expect(result.pid).toBe(7);
        expect(manager.readPidFile()).toBe(7);
      } finally {
        process.argv = origArgv;
        cleanup();
      }
    });
  });
});
