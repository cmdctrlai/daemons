/**
 * KeyedMutex serializes async work that shares a key. acquire(key) resolves
 * once the previous holder of that key releases; it returns a release
 * function. Different keys never block each other.
 *
 * Used to serialize `claude --resume <sessionId>` per session so two
 * overlapping resumes can't fork the session JSONL. A resume holds its
 * session's lock from spawn until the child process exits, so the next resume
 * of the same session starts from the committed conversation tip instead of
 * branching off a stale one.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  /**
   * Wait for the lock on `key`, then return a release function. The next
   * acquirer of the same key waits until that function is called. Calling
   * release more than once is a no-op.
   */
  async acquire(key: string): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve();

    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, next);

    await prev;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Drop the key only if no later acquirer has chained onto us, so the
      // map doesn't grow unbounded across many distinct sessions.
      if (this.tails.get(key) === next) {
        this.tails.delete(key);
      }
      release();
    };
  }

  /** Number of keys currently tracked. Exposed for tests/observability. */
  size(): number {
    return this.tails.size;
  }
}
