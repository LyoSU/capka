/**
 * Phase-aware stream stall detector.
 *
 * A provider that accepts a request but then never streams a token (or freezes
 * mid-stream) would otherwise hang the whole turn until the hard task deadline
 * (~10 min) — the user sees nothing the entire time, then a generic timeout. The
 * watchdog catches that fast: it fires `onStall` when no stream activity has
 * arrived for `idleMs` WHILE we're waiting on the model.
 *
 * The one subtlety that makes a naive idle-timer wrong here: a local tool can run
 * for minutes (a sandbox command) and during that window the model stream
 * produces no events — identical, on the wire, to a hung provider. So the
 * watchdog is PAUSED between a tool starting and finishing (`enterTool`/
 * `exitTool`), and only armed while we're genuinely waiting for the model to
 * speak. Parallel tools are reference-counted; it re-arms only once the last one
 * resolves.
 */
export class StallWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = 0;
  private stopped = true;

  constructor(
    private readonly idleMs: number,
    private readonly onStall: () => void,
  ) {}

  /** Begin (or restart, for a retry) watching the current attempt. */
  start(): void {
    this.stopped = false;
    this.inFlight = 0;
    this.rearm();
  }

  /** A stream event arrived — the provider is alive, so reset the idle timer. */
  activity(): void {
    if (this.stopped || this.inFlight > 0) return;
    this.rearm();
  }

  /** A local tool began executing — pause until it returns (the quiet is us). */
  enterTool(): void {
    if (this.stopped) return;
    this.inFlight += 1;
    this.clear();
  }

  /** A local tool finished — re-arm once nothing is left running. */
  exitTool(): void {
    if (this.stopped) return;
    if (this.inFlight > 0) this.inFlight -= 1;
    if (this.inFlight === 0) this.rearm();
  }

  /** Tear down — no further firing until `start()` is called again. */
  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private rearm(): void {
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped || this.inFlight > 0) return;
      this.stopped = true; // fire at most once per armed period
      this.onStall();
    }, this.idleMs);
  }

  private clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
