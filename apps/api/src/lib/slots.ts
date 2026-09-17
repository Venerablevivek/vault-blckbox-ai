/**
 * A tiny counting semaphore that never waits.
 *
 * Used to cap how many uploads are buffered in memory at once. Each accepted upload can hold
 * up to MAX_UPLOAD_BYTES, so without a cap memory use grows with however many uploads arrive
 * together. A request that finds no free slot is told to retry (503 + Retry-After) rather
 * than queued, because queueing would hold its connection and body open anyway.
 */
export function createSlots(capacity: number) {
  let inUse = 0;
  return {
    /** Returns a release function, or null when every slot is taken. */
    tryAcquire(): (() => void) | null {
      if (inUse >= capacity) return null;
      inUse += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inUse -= 1;
      };
    },
    get inUse() {
      return inUse;
    },
  };
}
