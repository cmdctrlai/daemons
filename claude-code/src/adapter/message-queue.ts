/**
 * A queue you can push into and iterate as an AsyncIterable.
 *
 * The Agent SDK takes streaming input as `AsyncIterable<SDKUserMessage>` and
 * keeps one subprocess alive for the whole conversation. Pushing here is how a
 * later message reaches a turn that is already in flight.
 */
export class MessageQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  /** Hand an item to the consumer, or buffer it until one arrives. */
  push(item: T): void {
    if (this.closed) {
      throw new Error('push after close');
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  /** End the stream once buffered items are drained. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Anything still waiting will never be fed – end it now.
    for (const waiter of this.waiters) {
      waiter({ value: undefined, done: true });
    }
    this.waiters = [];
  }

  get size(): number {
    return this.items.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.items.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
