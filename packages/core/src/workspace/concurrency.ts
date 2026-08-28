/** Runs at most `limit` tasks concurrently, queueing the rest in call order. */
export interface Limiter {
  <T>(task: () => Promise<T>): Promise<T>;
}

export function createLimiter(limit: number): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];

  const acquire = (): Promise<void> => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      waiting.push(() => {
        active += 1;
        resolve();
      });
    });
  };

  const release = (): void => {
    active -= 1;
    waiting.shift()?.();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}
