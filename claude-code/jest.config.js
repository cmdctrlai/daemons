/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
  testTimeout: 10000, // 10 seconds for file watcher tests
  // The Agent SDK is ESM only and jest runs CJS.
  moduleNameMapper: {
    '^@anthropic-ai/claude-agent-sdk$': '<rootDir>/src/adapter/__mocks__/agent-sdk-stub.ts',
  },
};
