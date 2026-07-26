import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigManager, DaemonConfig, DaemonCredentials } from '../config';

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
    test('returns true for current process PID', () => {
      const { manager, cleanup } = makeTmpManager();
      try {
        manager.writePidFile(process.pid);
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
  });
});
