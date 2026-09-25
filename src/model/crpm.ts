/**
 * CRPM — coordinated requests per minute.
 *
 * Six doctors working at once will trip rate limits the moment they act like
 * six independent clients. CRPM makes them behave like one system with six
 * hands: every call is booked through a scheduler that knows each credential's
 * budget, spaces requests inside a lane, and never lets one lane's cooldown
 * stall the others.
 *
 * Three rules, and they are the whole design:
 *
 *  1. **One lane per credential.** A lane is a key, not a model. Two doctors
 *     sharing a key share a lane and are serialised; six keys mean six lanes
 *     running truly in parallel.
 *  2. **Spacing, not bursting.** Each lane holds calls to a minimum interval
 *     derived from its budget, so a burst is smoothed instead of rejected.
 *  3. **A 429 is a lane event, not a team event.** The lane that hit the limit
 *     backs off and resumes; the other five keep working. Work is never lost —
 *     a paused task is still queued, and the queue survives the cooldown.
 *
 * Splitting a task into subtasks is part of the same discipline: a doctor that
 * divides its share into small calls stays under its own ceiling instead of
 * asking for one enormous completion that is more likely to be throttled.
 */

export interface LaneBudget {
  /** Requests per minute this credential may make. */
  rpm: number;
  /** How many calls may be in flight on this lane at once. */
  concurrency: number;
}

export interface LaneState {
  id: string;
  inFlight: number;
  queued: number;
  /** Epoch ms until which the lane is cooling down, 0 when free. */
  cooldownUntil: number;
  completed: number;
  throttled: number;
}

interface Job<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const DEFAULT_BUDGET: LaneBudget = { rpm: 40, concurrency: 2 };

class Lane {
  private queue: Job<any>[] = [];
  private inFlight = 0;
  private lastStart = 0;
  private cooldownUntil = 0;
  private completed = 0;
  private throttled = 0;

  readonly id: string;
  private readonly budget: LaneBudget;
  private readonly onChange: () => void;

  constructor(id: string, budget: LaneBudget, onChange: () => void) {
    this.id = id;
    this.budget = budget;
    this.onChange = onChange;
  }

  /** Minimum gap between two starts on this lane. */
  private get spacing(): number {
    return Math.ceil(60_000 / Math.max(1, this.budget.rpm));
  }

  get state(): LaneState {
    return {
      id: this.id,
      inFlight: this.inFlight,
      queued: this.queue.length,
      cooldownUntil: this.cooldownUntil,
      completed: this.completed,
      throttled: this.throttled,
    };
  }

  submit<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run, resolve, reject });
      this.onChange();
      this.pump();
    });
  }

  /** Report a rate limit so the lane — and only this lane — backs off. */
  cool(seconds: number): void {
    this.throttled += 1;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + seconds * 1000);
    this.onChange();
    setTimeout(() => this.pump(), Math.max(0, this.cooldownUntil - Date.now()) + 50);
  }

  private pump(): void {
    if (!this.queue.length) return;
    if (this.inFlight >= this.budget.concurrency) return;

    const now = Date.now();
    const waitForCooldown = this.cooldownUntil - now;
    const waitForSpacing = this.lastStart + this.spacing - now;
    const wait = Math.max(waitForCooldown, waitForSpacing, 0);
    if (wait > 0) {
      setTimeout(() => this.pump(), wait + 10);
      return;
    }

    const job = this.queue.shift();
    if (!job) return;
    this.inFlight += 1;
    this.lastStart = Date.now();
    this.onChange();

    void job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        this.inFlight -= 1;
        this.completed += 1;
        this.onChange();
        this.pump();
      });
  }
}

export class CrpmScheduler {
  private readonly lanes = new Map<string, Lane>();
  private readonly listeners = new Set<(lanes: LaneState[]) => void>();

  private readonly budgets: Record<string, LaneBudget>;

  constructor(budgets: Record<string, LaneBudget> = {}) {
    this.budgets = budgets;
  }

  /** Book a call on a lane. Resolves when the lane has room for it. */
  run<T>(laneId: string, task: () => Promise<T>): Promise<T> {
    return this.lane(laneId).submit(task);
  }

  /** Tell a lane it was rate limited, so the rest of the team keeps going. */
  throttle(laneId: string, seconds: number): void {
    this.lane(laneId).cool(seconds);
  }

  get lanesState(): LaneState[] {
    return [...this.lanes.values()].map((lane) => lane.state);
  }

  /** True while any lane still has work. */
  get busy(): boolean {
    return this.lanesState.some((lane) => lane.inFlight > 0 || lane.queued > 0);
  }

  subscribe(listener: (lanes: LaneState[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.lanesState);
    return () => this.listeners.delete(listener);
  }

  private lane(id: string): Lane {
    let lane = this.lanes.get(id);
    if (!lane) {
      lane = new Lane(id, this.budgets[id] ?? DEFAULT_BUDGET, () => this.notify());
      this.lanes.set(id, lane);
    }
    return lane;
  }

  private notify(): void {
    const snapshot = this.lanesState;
    for (const listener of this.listeners) listener(snapshot);
  }
}

/**
 * Split one doctor's share into calls it can actually complete.
 *
 * A doctor given "repair these 14 files" should not ask for one giant
 * completion: it is slower, more likely to be truncated, and more likely to be
 * throttled. Chunking keeps each call inside the model's comfortable output
 * size and lets the lane interleave them.
 */
export function splitWork<T>(items: T[], perCall: number): T[][] {
  if (perCall <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += perCall) {
    chunks.push(items.slice(i, i + perCall));
  }
  return chunks.length ? chunks : [[]];
}
