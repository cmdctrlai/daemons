import * as sdk from '../index';

describe('SDK exports', () => {
  test('exports DaemonClient class', () => {
    expect(sdk.DaemonClient).toBeDefined();
    expect(typeof sdk.DaemonClient).toBe('function');
  });

  test('exports ConfigManager class', () => {
    expect(sdk.ConfigManager).toBeDefined();
    expect(typeof sdk.ConfigManager).toBe('function');
  });

  test('exports registration functions', () => {
    expect(typeof sdk.registerDevice).toBe('function');
    expect(typeof sdk.unregisterDevice).toBe('function');
    expect(typeof sdk.requestDeviceCode).toBe('function');
    expect(typeof sdk.pollForToken).toBe('function');
  });
});
