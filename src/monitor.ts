export type Status = 'unknown' | 'online' | 'offline' | 'recovering';

export interface Stage {
  name: string;
  at: number;
  updated: number;
  percent: number | null;
  message: string | null;
}

export interface Outage {
  start: number; // last heartbeat before the outage
  end: number | null; // first heartbeat after it
  rebooted: boolean;
  stages: Stage[];
}

export interface DeviceState {
  id: string;
  name: string;
  status: Status;
  lastSeen: number | null;
  boot: string | null;
  outage: Outage | null;
  history: Outage[]; // closed outages, newest first
}

export interface StageReport {
  name: string;
  percent: number | null;
  message: string | null;
}

export interface MonitorHooks {
  onStatus?: (device: DeviceState, from: Status) => void;
  onOutageEnd?: (device: DeviceState, outage: Outage) => void;
}

const HISTORY_SIZE = 20;
const MAX_STAGES = 50;

export class Monitor {
  readonly #devices = new Map<string, DeviceState>();
  readonly #timeoutMs: number;
  readonly #hooks: MonitorHooks;

  constructor(devices: readonly { id: string; name: string }[], timeoutMs: number, hooks: MonitorHooks = {}) {
    this.#timeoutMs = timeoutMs;
    this.#hooks = hooks;
    for (const { id, name } of devices) {
      this.#devices.set(id, { id, name, status: 'unknown', lastSeen: null, boot: null, outage: null, history: [] });
    }
  }

  get devices(): DeviceState[] {
    return [...this.#devices.values()];
  }

  // Takes over the state saved before a restart. Nobody watched the heartbeats
  // while the server was down, so a device that was online has to show up again.
  restore(saved: readonly DeviceState[]): void {
    for (const s of saved) {
      const d = this.#devices.get(s.id);
      if (!d) continue;
      d.status = s.status === 'online' ? 'unknown' : s.status;
      d.lastSeen = s.lastSeen;
      d.boot = s.boot;
      d.outage = s.outage;
      d.history = s.history.slice(0, HISTORY_SIZE);
    }
  }

  heartbeat(id: string, now: number, boot: string | null): void {
    const d = this.#device(id);
    const rebooted = boot !== null && d.boot !== null && boot !== d.boot;
    if (!d.outage && rebooted && d.lastSeen !== null) {
      // Rebooted faster than the timeout: still an outage.
      d.outage = { start: d.lastSeen, end: null, rebooted: false, stages: [] };
    }
    if (d.outage) {
      const outage = d.outage;
      outage.end = now;
      outage.rebooted ||= rebooted;
      d.outage = null;
      d.history = [outage, ...d.history].slice(0, HISTORY_SIZE);
      this.#hooks.onOutageEnd?.(d, outage);
    }
    d.lastSeen = now;
    if (boot !== null) d.boot = boot;
    this.#setStatus(d, 'online');
  }

  // A stage report opens an outage if there is none yet: the wipe script reports
  // before the system goes down, the recovery environment reports after.
  progress(id: string, now: number, report: StageReport): void {
    const d = this.#device(id);
    d.outage ??= { start: d.lastSeen ?? now, end: null, rebooted: false, stages: [] };
    const stages = d.outage.stages;
    const last = stages.at(-1);
    if (last?.name === report.name) {
      last.updated = now;
      last.percent = report.percent;
      if (report.message !== null) last.message = report.message;
    } else {
      stages.push({ name: report.name, at: now, updated: now, percent: report.percent, message: report.message });
      if (stages.length > MAX_STAGES) stages.shift();
    }
    this.#setStatus(d, 'recovering');
  }

  // Marks devices whose heartbeats stopped. Returns true if any status changed.
  tick(now: number): boolean {
    let changed = false;
    for (const d of this.#devices.values()) {
      if (d.status === 'online' && d.lastSeen !== null && now - d.lastSeen > this.#timeoutMs) {
        d.outage = { start: d.lastSeen, end: null, rebooted: false, stages: [] };
        this.#setStatus(d, 'offline');
        changed = true;
      }
    }
    return changed;
  }

  #device(id: string): DeviceState {
    const d = this.#devices.get(id);
    if (!d) throw new Error(`unknown device ${id}`);
    return d;
  }

  #setStatus(d: DeviceState, status: Status): void {
    if (d.status === status) return;
    const from = d.status;
    d.status = status;
    this.#hooks.onStatus?.(d, from);
  }
}
