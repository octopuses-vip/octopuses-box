export interface WriteStatus { pending: number; saving: boolean; error: string | null }

/** Acknowledge only the revision actually written; failed deletions remain pending. */
export class WriteQueue<T> {
  private pending = new Map<string, { revision: number; value: T | null }>();
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private failures = 0;
  private error: string | null = null;
  constructor(private write: (id: string, value: T | null, isCurrent: () => boolean) => Promise<void>, private changed: (status: WriteStatus) => void, private delay = 800) {}
  private notify() { this.changed({ pending: this.pending.size, saving: !!this.running, error: this.error }); }
  put(id: string, value: T | null) {
    this.pending.set(id, { revision: ++this.revision, value }); this.notify(); this.schedule(this.delay);
  }
  private schedule(delay: number) {
    if (this.timer !== undefined || this.failures >= 3) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}); }, delay);
  }
  retry() { this.failures = 0; return this.flush(); }
  async flush(): Promise<void> {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.running) { await this.running; return this.flush(); }
    if (!this.pending.size) return;
    const batch = [...this.pending];
    this.running = Promise.resolve().then(async () => {
      let failure: unknown;
      for (const [id, item] of batch) {
        if (this.pending.get(id) !== item) continue;
        try {
          await this.write(id, item.value, () => this.pending.get(id) === item);
          if (this.pending.get(id) === item) this.pending.delete(id);
        } catch (error) { if (this.pending.get(id) === item) failure = error; }
      }
      if (failure !== undefined) throw failure;
    });
    this.notify();
    try { await this.running; this.error = null; this.failures = 0; }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); this.failures++; throw error; }
    finally {
      this.running = null; this.notify();
      if (this.pending.size) this.schedule(this.error ? 1000 * 2 ** this.failures : this.delay);
    }
  }
}
