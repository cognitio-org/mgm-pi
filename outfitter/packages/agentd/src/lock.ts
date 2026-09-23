/**
 * One-at-a-time async gate. Not reentrant: a callback that calls the same lock again deadlocks.
 * The next caller waits until the previous callback's promise settles, including rejection.
 */
export type AsyncLock = <T>(fn: () => Promise<T>) => Promise<T>;

export function createAsyncLock(): AsyncLock {
  let chain: Promise<void> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}
