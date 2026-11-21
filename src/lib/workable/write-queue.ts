type WriteTask = () => Promise<void>;

/**
 * Most Workable writes a single bulk request may perform. Callers process the
 * first slice and hand the rest back so the client can send it as a new request.
 */
export const MAX_BULK_WORKABLE_WRITES = 25;

/**
 * Most writes allowed to wait in this instance's queue. Workable's rate limit is
 * shared with the applicant sync, so once this many are pending new writes are
 * refused instead of stacking up behind them.
 */
export const MAX_PENDING_WORKABLE_WRITES = 25;

export class WorkableQueueFullError extends Error {
  constructor() {
    super("Workable write queue is full");
    this.name = "WorkableQueueFullError";
  }
}

export function splitBulkBatch<T>(ids: readonly T[]): { batch: T[]; remaining: T[] } {
  return {
    batch: ids.slice(0, MAX_BULK_WORKABLE_WRITES),
    remaining: ids.slice(MAX_BULK_WORKABLE_WRITES),
  };
}

class WorkableWriteQueue {
  private queue: Array<{ task: WriteTask; resolve: () => void; reject: (e: unknown) => void }> = [];
  private draining = false;
  private readonly windowMs = 10_000;
  private readonly maxPerWindow = 10;
  private timestamps: number[] = [];

  enqueue(task: WriteTask): Promise<void> {
    if (this.queue.length >= MAX_PENDING_WORKABLE_WRITES) {
      return Promise.reject(new WorkableQueueFullError());
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      void this.drain();
    });
  }

  private async waitForSlot() {
    while (true) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
      if (this.timestamps.length < this.maxPerWindow) {
        this.timestamps.push(now);
        return;
      }
      const oldest = this.timestamps[0]!;
      await new Promise((resolve) =>
        setTimeout(resolve, this.windowMs - (now - oldest) + 50),
      );
    }
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) continue;
      await this.waitForSlot();
      try {
        await item.task();
        item.resolve();
      } catch (error) {
        console.error("Workable write failed", error);
        item.reject(error);
      }
    }
    this.draining = false;
  }
}

export const workableWriteQueue = new WorkableWriteQueue();

export function enqueueWorkableWrite(task: WriteTask): Promise<void> {
  return workableWriteQueue.enqueue(task);
}
