interface Ticket {
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  abort: () => void;
}

/** FIFO within each root task; roots take turns when physical capacity becomes available. */
export class ExecutionPool {
  private active = 0;
  private readonly groups = new Map<string, Ticket[]>();
  constructor(readonly capacity = 16) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid execution capacity');
  }
  acquire(rootId: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('Execution cancelled'));
    return new Promise((resolve, reject) => {
      const ticket: Ticket = {
        signal,
        resolve,
        reject,
        abort: () => {
          const queue = this.groups.get(rootId);
          if (queue) {
            const index = queue.indexOf(ticket);
            if (index >= 0) queue.splice(index, 1);
            if (!queue.length) this.groups.delete(rootId);
          }
          signal?.removeEventListener('abort', ticket.abort);
          reject(new Error('Execution cancelled'));
        },
      };
      const queue = this.groups.get(rootId) ?? [];
      queue.push(ticket);
      this.groups.set(rootId, queue);
      signal?.addEventListener('abort', ticket.abort, { once: true });
      this.drain();
    });
  }
  private drain(): void {
    while (this.active < this.capacity && this.groups.size) {
      const [group, queue] = this.groups.entries().next().value!;
      const ticket = queue.shift()!;
      this.groups.delete(group);
      if (queue.length) this.groups.set(group, queue);
      ticket.signal?.removeEventListener('abort', ticket.abort);
      if (ticket.signal?.aborted) {
        ticket.reject(new Error('Execution cancelled'));
        continue;
      }
      this.active++;
      let released = false;
      ticket.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.drain();
      });
    }
  }
  get occupied(): number {
    return this.active;
  }
  get queued(): number {
    return [...this.groups.values()].reduce((total, queue) => total + queue.length, 0);
  }
}
