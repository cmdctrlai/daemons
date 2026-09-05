import { releaseLocalState, LocalState } from './lifecycle';

/**
 * The auto-update path is the one that matters here. It replaces the daemon
 * without a signal ever reaching it, so if it skips stopAll() the outgoing
 * process leaves every in-flight thread's writer lock held by an app-server
 * that is about to be orphaned – the "locked out of my own terminal" bug,
 * recreated on every release.
 */

interface Spy extends LocalState {
  calls: string[];
}

function spyState(fail?: Partial<Record<keyof LocalState, Error>>): Spy {
  const calls: string[] = [];
  return {
    calls,
    unwatchAll() {
      calls.push('unwatchAll');
      if (fail?.unwatchAll) throw fail.unwatchAll;
    },
    async stopAll() {
      calls.push('stopAll');
      if (fail?.stopAll) throw fail.stopAll;
    },
    deletePidFile() {
      calls.push('deletePidFile');
      if (fail?.deletePidFile) throw fail.deletePidFile;
    },
  };
}

describe('releaseLocalState', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('hands back the threads, in dependency order', async () => {
    const s = spyState();
    await releaseLocalState(s);
    expect(s.calls).toEqual(['unwatchAll', 'stopAll', 'deletePidFile']);
  });

  test('awaits stopAll rather than firing and forgetting', async () => {
    const calls: string[] = [];
    let released = false;
    await releaseLocalState({
      unwatchAll: () => calls.push('unwatchAll'),
      stopAll: async () => {
        await new Promise((r) => setTimeout(r, 10));
        released = true;
        calls.push('stopAll');
      },
      deletePidFile: () => {
        // Reaching here before stopAll settled would mean the process could
        // exit with app-servers still holding locks.
        expect(released).toBe(true);
        calls.push('deletePidFile');
      },
    });
    expect(calls).toEqual(['unwatchAll', 'stopAll', 'deletePidFile']);
  });

  const failureCases: {
    name: string;
    fail: Partial<Record<keyof LocalState, Error>>;
    stillRuns: string[];
  }[] = [
    {
      name: 'a failed unwatch still releases the threads',
      fail: { unwatchAll: new Error('watcher already gone') },
      stillRuns: ['stopAll', 'deletePidFile'],
    },
    {
      name: 'a failed stopAll still drops the pid file',
      fail: { stopAll: new Error('app-server would not die') },
      stillRuns: ['unwatchAll', 'deletePidFile'],
    },
    {
      name: 'a failed pid delete does not undo the release',
      fail: { deletePidFile: new Error('EACCES') },
      stillRuns: ['unwatchAll', 'stopAll'],
    },
  ];

  test.each(failureCases)('$name', async ({ fail, stillRuns }) => {
    const s = spyState(fail);
    await expect(releaseLocalState(s)).resolves.toBeUndefined();
    for (const step of stillRuns) expect(s.calls).toContain(step);
  });

  test('every step runs even when all three throw', async () => {
    const s = spyState({
      unwatchAll: new Error('a'),
      stopAll: new Error('b'),
      deletePidFile: new Error('c'),
    });
    await expect(releaseLocalState(s)).resolves.toBeUndefined();
    expect(s.calls).toEqual(['unwatchAll', 'stopAll', 'deletePidFile']);
  });
});

/**
 * Guards the wiring, not just the helper: onBeforeUpdate has to be the thing
 * that releases, and it has to be awaited by the SDK. Both were missing before.
 */
describe('the auto-update hook releases the threads', () => {
  test('onBeforeUpdate stops the app-servers and returns a promise the SDK can await', async () => {
    const s = spyState();
    // Mirrors how start.ts wires autoUpdateConfig.onBeforeUpdate.
    const onBeforeUpdate: () => Promise<void> | void = () =>
      releaseLocalState(s);

    const returned = onBeforeUpdate();
    expect(returned).toBeInstanceOf(Promise);
    await returned;

    expect(s.calls).toContain('stopAll');
    expect(s.calls).toEqual(['unwatchAll', 'stopAll', 'deletePidFile']);
  });
});
