/**
 * Tests for KeyedMutex – the per-session resume serializer.
 */

import { KeyedMutex } from './keyed-mutex';

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('KeyedMutex', () => {
  it('serializes overlapping work on the same key (no interleaving)', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];

    const work = async (label: string) => {
      const release = await mutex.acquire('s1');
      log.push(`${label}:enter`);
      await tick();
      await tick();
      log.push(`${label}:exit`);
      release();
    };

    // Start three contenders for the same key in order.
    await Promise.all([work('A'), work('B'), work('C')]);

    // Each must fully finish before the next enters – strict FIFO, no overlap.
    expect(log).toEqual([
      'A:enter', 'A:exit',
      'B:enter', 'B:exit',
      'C:enter', 'C:exit',
    ]);
  });

  it('lets different keys run concurrently', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const releaseA = await mutex.acquire('a');
    // 'b' must not be blocked by 'a' being held.
    const releaseB = await mutex.acquire('b');
    order.push('both-acquired');
    releaseA();
    releaseB();

    expect(order).toEqual(['both-acquired']);
  });

  it('blocks a second acquire of a held key until release', async () => {
    const mutex = new KeyedMutex();
    const release1 = await mutex.acquire('k');

    let secondAcquired = false;
    const second = mutex.acquire('k').then((r) => {
      secondAcquired = true;
      return r;
    });

    await tick();
    expect(secondAcquired).toBe(false); // still blocked

    release1();
    const release2 = await second;
    expect(secondAcquired).toBe(true);
    release2();
  });

  it('treats repeated release as a no-op (does not double-unlock)', async () => {
    const mutex = new KeyedMutex();
    const release1 = await mutex.acquire('k');
    release1();
    release1(); // extra release must not let two holders run at once

    const order: string[] = [];
    const a = mutex.acquire('k').then(async (r) => {
      order.push('a:enter');
      await tick();
      order.push('a:exit');
      r();
    });
    const b = mutex.acquire('k').then(async (r) => {
      order.push('b:enter');
      r();
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a:enter', 'a:exit', 'b:enter']);
  });

  it('garbage-collects keys once fully drained', async () => {
    const mutex = new KeyedMutex();
    const r1 = await mutex.acquire('x');
    const r2 = await mutex.acquire('y');
    expect(mutex.size()).toBe(2);
    r1();
    r2();
    // After the last holder of each key releases, the key is dropped.
    expect(mutex.size()).toBe(0);
  });

  it('keeps the key alive while a waiter is still queued', async () => {
    const mutex = new KeyedMutex();
    const r1 = await mutex.acquire('x');
    const waiting = mutex.acquire('x'); // queued behind r1
    r1();
    expect(mutex.size()).toBe(1); // key retained for the waiter
    const r2 = await waiting;
    r2();
    expect(mutex.size()).toBe(0);
  });
});
