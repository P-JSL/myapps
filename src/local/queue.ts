interface Task { id: string; controller: AbortController; work: (signal: AbortSignal) => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void; }
/** Serializes heavy preparations without rejecting a second download as busy. */
export class PreparationQueue {
  private pending: Task[] = [];
  private running: Task | undefined;
  readonly maximum: number;
  constructor(maximum = 8) { this.maximum = maximum; }
  run<T>(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.running?.id === id || this.pending.some(task => task.id === id)) return Promise.reject(new Error('같은 파일을 이미 준비하고 있습니다.'));
    if (this.pending.length + Number(!!this.running) >= this.maximum) return Promise.reject(new Error('다운로드 준비 대기열은 최대 8개입니다.'));
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ id, controller: new AbortController(), work, resolve: value => resolve(value as T), reject });
      this.advance();
    });
  }
  cancel(id: string) {
    if (this.running?.id === id) { this.running.controller.abort(); return; }
    const index = this.pending.findIndex(task => task.id === id); if (index < 0) return;
    const task = this.pending.splice(index, 1)[0]!; task.controller.abort(); task.reject(new DOMException('작업을 취소했습니다.', 'AbortError'));
  }
  private advance() {
    if (this.running) return;
    const task = this.pending.shift(); if (!task) return;
    this.running = task;
    void (async () => {
      try { task.resolve(await task.work(task.controller.signal)); } catch (error) { task.reject(error); }
      finally { this.running = undefined; this.advance(); }
    })();
  }
}
