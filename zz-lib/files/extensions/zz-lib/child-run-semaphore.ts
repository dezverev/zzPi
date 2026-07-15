export {};

interface ChildRunWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal | undefined;
  readonly onAbort?: (() => void) | undefined;
}

export class ChildRunSemaphore {
  private active = 0;
  private readonly maximum: number;
  private readonly queue: ChildRunWaiter[] = [];

  constructor(maximum: number) {
    if (!Number.isInteger(maximum) || maximum <= 0) {
      throw new Error("Child agent concurrency must be a positive integer");
    }
    this.maximum = maximum;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("Child agent run aborted while waiting for a concurrency slot"));
    return new Promise((resolve, reject) => {
      const waiter: ChildRunWaiter = {
        resolve,
        reject,
        signal,
        onAbort: signal
          ? () => {
              const index = this.queue.indexOf(waiter);
              if (index >= 0) this.queue.splice(index, 1);
              reject(new Error("Child agent run aborted while waiting for a concurrency slot"));
            }
          : undefined,
      };
      if (waiter.onAbort) signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.maximum && this.queue.length > 0) {
      const waiter = this.queue.shift();
      if (!waiter) return;
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(new Error("Child agent run aborted while waiting for a concurrency slot"));
        continue;
      }
      this.active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        this.drain();
      });
    }
  }
}
