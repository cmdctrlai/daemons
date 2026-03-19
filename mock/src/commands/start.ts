import {
  readConfig,
  readCredentials,
  isRegistered,
  writePidFile,
  isDaemonRunning,
  MockConfig,
  DEFAULT_MOCK_CONFIG
} from '../config/config';
import { MockDaemonClient } from '../client/websocket';

interface StartOptions {
  foreground?: boolean;
  delayMin?: string;
  delayMax?: string;
  outputLines?: string;
  askProbability?: string;
  errorRate?: string;
}

/**
 * Parse CLI options into MockConfig
 */
function parseMockConfig(options: StartOptions): Partial<MockConfig> {
  const config: Partial<MockConfig> = {};

  if (options.delayMin || options.delayMax) {
    config.responseDelayMs = {
      min: options.delayMin ? parseInt(options.delayMin, 10) : DEFAULT_MOCK_CONFIG.responseDelayMs.min,
      max: options.delayMax ? parseInt(options.delayMax, 10) : DEFAULT_MOCK_CONFIG.responseDelayMs.max
    };
  }

  if (options.outputLines) {
    const count = parseInt(options.outputLines, 10);
    config.outputLineCount = { min: count, max: count };
  }

  if (options.askProbability) {
    config.askQuestionProbability = parseFloat(options.askProbability);
  }

  if (options.errorRate) {
    config.errorProbability = parseFloat(options.errorRate);
  }

  return config;
}

/**
 * Start command
 */
export async function start(options: StartOptions): Promise<void> {
  if (!isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-mock register" first.');
    process.exit(1);
  }

  if (isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-mock stop" first.');
    process.exit(1);
  }

  const config = readConfig()!;
  const credentials = readCredentials()!;
  const mockConfig = parseMockConfig(options);

  console.log('Mock Daemon Configuration:');
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Device: ${config.deviceName} (${config.deviceId})`);
  if (mockConfig.responseDelayMs) {
    console.log(`  Response delay: ${mockConfig.responseDelayMs.min}-${mockConfig.responseDelayMs.max}ms`);
  }
  if (mockConfig.askQuestionProbability !== undefined) {
    console.log(`  Ask question probability: ${(mockConfig.askQuestionProbability * 100).toFixed(0)}%`);
  }
  if (mockConfig.errorProbability !== undefined) {
    console.log(`  Error probability: ${(mockConfig.errorProbability * 100).toFixed(0)}%`);
  }
  console.log('');

  // Always run in foreground for now (daemonization is complex)
  writePidFile(process.pid);

  const client = new MockDaemonClient(config, credentials, mockConfig);

  // Handle shutdown signals
  const shutdown = async () => {
    console.log('\nShutting down...');
    await client.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  client.connect().catch(() => {
    console.warn('Initial connection failed, will retry...');
  });

  console.log('Mock daemon running. Press Ctrl+C to stop.\n');

  // Keep process alive
  await new Promise(() => {});
}
