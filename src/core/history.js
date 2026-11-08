// Bounded undo/redo history of immutable JSON-serialisable snapshots.

export class History {
  /**
   * @param {{limit?: number, maxBytes?: number}} [opts]
   */
  constructor(opts = {}) {
    this.limit = opts.limit ?? 80;
    this.maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
    this.past = [];
    this.future = [];
    this.bytes = 0;
  }

  static size(snapshot) {
    try { return JSON.stringify(snapshot).length * 2; } catch { return 1024; }
  }

  /** Record the state BEFORE a change. */
  push(snapshot) {
    const size = History.size(snapshot);
    this.past.push({ snapshot, size });
    this.bytes += size;
    this.future = [];
    while (this.past.length > this.limit || (this.bytes > this.maxBytes && this.past.length > 1)) {
      const dropped = this.past.shift();
      this.bytes -= dropped.size;
    }
  }

  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }

  /** @param current state now; returns the state to restore or null */
  undo(current) {
    const entry = this.past.pop();
    if (!entry) return null;
    this.bytes -= entry.size;
    this.future.push({ snapshot: current, size: History.size(current) });
    return entry.snapshot;
  }

  redo(current) {
    const entry = this.future.pop();
    if (!entry) return null;
    const size = History.size(current);
    this.past.push({ snapshot: current, size });
    this.bytes += size;
    return entry.snapshot;
  }

  clear() { this.past = []; this.future = []; this.bytes = 0; }
}
