// Memoizes an async build, but forgets a rejection so the next call retries -- the same rule as
// GkeProvider.kube() (review finding M1 there): a transient failure (a dynamic-import hiccup, a
// metadata-server blip) must not stick for the rest of the process's life. Concurrent callers of
// one in-flight build share it; a factory that throws synchronously counts as a rejection.

export function memoizeRetrying<T>(build: () => Promise<T>): () => Promise<T> {
  let memo: Promise<T> | undefined;
  return () => {
    if (!memo) {
      const building = Promise.resolve().then(build);
      memo = building;
      building.catch(() => {
        if (memo === building) memo = undefined;
      });
    }
    return memo;
  };
}
