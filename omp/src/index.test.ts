const runDaemon = jest.fn();
jest.mock('@cmdctrl/pi', () => ({ runDaemon }));

test('cmdctrl-omp runs the pi daemon as omp, at its own version', () => {
  require('./index');
  expect(runDaemon).toHaveBeenCalledTimes(1);
  expect(runDaemon).toHaveBeenCalledWith({
    daemonName: 'omp',
    agentType: 'omp',
    bin: 'omp',
    version: require('../package.json').version,
  });
});
