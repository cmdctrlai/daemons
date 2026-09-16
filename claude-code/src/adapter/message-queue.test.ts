/**
 * Tests for MessageQueue – the streaming-input pump feeding the Agent SDK.
 */

import { MessageQueue } from './message-queue';

const drain = async <T>(q: MessageQueue<T>, count: number): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of q) {
    out.push(item);
    if (out.length === count) break;
  }
  return out;
};

describe('MessageQueue', () => {
  describe('delivery order and buffering', () => {
    const cases: Array<{ name: string; pushed: number[]; take: number; want: number[] }> = [
      { name: 'single item', pushed: [1], take: 1, want: [1] },
      { name: 'preserves FIFO order', pushed: [1, 2, 3], take: 3, want: [1, 2, 3] },
      { name: 'partial take leaves the rest buffered', pushed: [1, 2, 3], take: 2, want: [1, 2] },
    ];

    it.each(cases)('$name', async ({ pushed, take, want }) => {
      const q = new MessageQueue<number>();
      pushed.forEach((n) => q.push(n));
      expect(await drain(q, take)).toEqual(want);
    });
  });

  it('delivers to a consumer that is already waiting', async () => {
    const q = new MessageQueue<string>();
    const iterator = q[Symbol.asyncIterator]();

    // Ask before anything is pushed – this parks.
    const pending = iterator.next();
    q.push('late');

    expect(await pending).toEqual({ value: 'late', done: false });
  });

  it('ends a parked consumer when closed', async () => {
    const q = new MessageQueue<string>();
    const iterator = q[Symbol.asyncIterator]();
    const pending = iterator.next();

    q.close();

    expect(await pending).toEqual({ value: undefined, done: true });
  });

  it('drains buffered items before reporting done', async () => {
    const q = new MessageQueue<number>();
    q.push(1);
    q.push(2);
    q.close();

    const seen: number[] = [];
    for await (const n of q) seen.push(n);

    expect(seen).toEqual([1, 2]);
  });

  it('rejects a push after close', () => {
    const q = new MessageQueue<number>();
    q.close();
    expect(() => q.push(1)).toThrow('push after close');
  });

  it('is idempotent on close', () => {
    const q = new MessageQueue<number>();
    q.close();
    expect(() => q.close()).not.toThrow();
    expect(q.isClosed).toBe(true);
  });

  it('reports buffered size', () => {
    const q = new MessageQueue<number>();
    expect(q.size).toBe(0);
    q.push(1);
    q.push(2);
    expect(q.size).toBe(2);
  });

  it('closes when the consumer breaks out of the loop', async () => {
    const q = new MessageQueue<number>();
    q.push(1);
    q.push(2);

    for await (const _ of q) break;

    expect(q.isClosed).toBe(true);
  });
});
