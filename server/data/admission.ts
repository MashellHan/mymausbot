import { DataFailure } from "./types.ts";

export class DataAdmission {
  private held: Promise<void> | null = null;
  private active = 0;
  private idle: (() => void) | null = null;
  private barriers: Promise<void> = Promise.resolve();

  async enter<T>(work: () => Promise<T>): Promise<T> {
    while (this.held) await this.held;
    this.active++;
    try { return await work(); }
    finally {
      this.active--;
      if (this.active === 0) { this.idle?.(); this.idle = null; }
    }
  }

  private async wait(promise: Promise<void>, deadline: number): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DataFailure({ code: "timeout", message: "Data did not drain before its safety barrier." });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([promise, new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DataFailure({ code: "timeout", message: "Data did not drain before its safety barrier." })), remaining);
      })]);
    } finally { clearTimeout(timer); }
  }

  async barrier<T>(work: () => Promise<T>, maxWaitMs = 30_000): Promise<T> {
    const previous = this.barriers;
    let finish!: () => void;
    const ticket = new Promise<void>((resolve) => { finish = resolve; });
    this.barriers = previous.then(() => ticket);
    const deadline = Date.now() + maxWaitMs;
    const hold: { release?: () => void } = {};
    let onIdle: (() => void) | null = null;
    try {
      await this.wait(previous, deadline);
      this.held = new Promise<void>((resolve) => { hold.release = resolve; });
      if (this.active > 0) await this.wait(new Promise<void>((resolve) => { onIdle = resolve; this.idle = resolve; }), deadline);
      return await work();
    } finally {
      if (onIdle && this.idle === onIdle) this.idle = null;
      if (hold.release) { this.held = null; hold.release(); }
      finish();
    }
  }
}

export class DataStoreLane {
  private readonly queue: Array<{ readOnly: boolean; start: () => void }> = [];
  private readers = 0;
  private writer = false;

  run<T>(readOnly: boolean, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ readOnly, start: () => {
        if (readOnly) this.readers++;
        else this.writer = true;
        void Promise.resolve().then(work).then(resolve, reject).finally(() => {
          if (readOnly) this.readers--;
          else this.writer = false;
          this.pump();
        });
      } });
      this.pump();
    });
  }

  private pump(): void {
    if (this.writer) return;
    while (this.queue[0]?.readOnly) this.queue.shift()!.start();
    if (this.readers === 0 && this.queue[0] && !this.queue[0].readOnly) this.queue.shift()!.start();
  }
}
