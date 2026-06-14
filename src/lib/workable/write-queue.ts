type WriteTask = () => Promise<void>;

class WorkableWriteQueue {
  private queue: Array<{ task: WriteTask; resolve: () => void; reject: (e: unknown) => void }> = [];
  private draining = false;
  private readonly windowMs = 10_000;
  private readonly maxPerWindow = 10;
  private timestamps: number[] = [];

  enqueue(task: WriteTask): Promise<void> {
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
