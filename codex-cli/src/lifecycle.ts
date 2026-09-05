/**
 * What has to happen before this daemon process makes way for another one.
 *
 * Both exits run the same list. Shutdown is the obvious one; the auto-update
 * path is the dangerous one, because it restarts the daemon without a signal
 * ever reaching it. Codex ties a thread's writer lock to the app-server process
 * holding it, so an update that skipped stopAll() would hand every in-flight
 * thread to a process that is about to be replaced – recreating the "locked out
 * of my own terminal" bug on every release.
 */
export interface LocalState {
  unwatchAll(): void;
  stopAll(): Promise<void>;
  deletePidFile(): void;
}

/**
 * Release everything this process owns, in dependency order: stop watching
 * files, hand back the threads, then drop the pid file that claims the daemon
 * is alive. Each step runs even if an earlier one throws, because a failure to
 * unwatch must not be the reason a writer lock leaks.
 */
export async function releaseLocalState(state: LocalState): Promise<void> {
  const failures: unknown[] = [];

  try {
    state.unwatchAll();
  } catch (err) {
    failures.push(err);
  }

  try {
    await state.stopAll();
  } catch (err) {
    failures.push(err);
  }

  try {
    state.deletePidFile();
  } catch (err) {
    failures.push(err);
  }

  for (const err of failures) {
    console.error('[lifecycle] Cleanup step failed:', err);
  }
}
