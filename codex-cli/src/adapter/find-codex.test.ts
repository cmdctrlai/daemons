import { codexCandidates, selectCodexBinary } from './app-server-client';

/**
 * Picking a codex binary is the difference between a working daemon and one that
 * dies on spawn, and the failure that prompted these tests looked fine on disk:
 * an npm install had left a `codex` symlink whose vendored binary was missing.
 */
describe('selectCodexBinary', () => {
  const npmCodex = '/home/u/.npm-global/bin/codex';
  const appCodex = '/Applications/ChatGPT.app/Contents/Resources/codex';
  const candidates = [npmCodex, '/usr/local/bin/codex', appCodex];

  function select(present: string[], working: string[]): string | null {
    return selectCodexBinary(
      candidates,
      (p) => present.includes(p),
      (p) => working.includes(p),
    );
  }

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('the first working candidate wins', () => {
    expect(select([npmCodex, appCodex], [npmCodex, appCodex])).toBe(npmCodex);
  });

  test('a present but broken binary is skipped for a working one further down', () => {
    // The real failure: the npm symlink exists, but its vendored binary is gone.
    expect(select([npmCodex, appCodex], [appCodex])).toBe(appCodex);
  });

  test('absent candidates are passed over without being run', () => {
    const works = jest.fn(() => true);
    const chosen = selectCodexBinary(candidates, (p) => p === appCodex, works);
    expect(chosen).toBe(appCodex);
    expect(works).toHaveBeenCalledTimes(1);
    expect(works).toHaveBeenCalledWith(appCodex);
  });

  test('null when every candidate is missing', () => {
    expect(select([], [])).toBeNull();
  });

  test('null when every candidate is present but none runs', () => {
    expect(select(candidates, [])).toBeNull();
  });

  test('a broken candidate is reported rather than failing silently', () => {
    select([npmCodex, appCodex], [appCodex]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(npmCodex));
  });
});

describe('codexCandidates', () => {
  const paths = codexCandidates('/home/u');

  test('covers where codex ships today, not only npm and PATH dirs', () => {
    expect(paths).toEqual(
      expect.arrayContaining([
        '/home/u/.local/bin/codex',
        '/home/u/.npm-global/bin/codex',
        '/usr/local/bin/codex',
        '/opt/homebrew/bin/codex',
        // Neither of these is on a PATH the npm install controls, and a user who
        // installed codex with the ChatGPT app has only these.
        '/home/u/.codex/plugins/.plugin-appserver/codex',
        '/Applications/ChatGPT.app/Contents/Resources/codex',
      ]),
    );
  });

  test('is free of duplicates, so no binary is probed twice', () => {
    expect(new Set(paths).size).toBe(paths.length);
  });
});
