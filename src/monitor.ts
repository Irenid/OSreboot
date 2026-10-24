export type Status = 'unknown' | 'online' | 'offline' | 'recovering';

export interface Stage {
  name: string;
  at: number; // first report of the stage
  updated: number; // latest report of it
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
  lastSeen: number | null; // latest heartbeat
  boot: string | null; // boot ID from the latest heartbeat
  outage: Outage | null; // the outage going on now
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

function openOutage(start: number): Outage {
  return { start, end: null, rebooted: false, stages: [] };
}

// Tracks the devices by their heartbeats. An outage runs from the last heartbeat
// before a gap to the first one after it, by the server's clock.
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
    for (const old of saved) {
      const device = this.#devices.get(old.id);
      if (!device) continue; // no longer in devices.json
      device.status = old.status === 'online' ? 'unknown' : old.status;
      device.lastSeen = old.lastSeen;
      device.boot = old.boot;
      device.outage = old.outage;
      device.history = old.history.slice(0, HISTORY_SIZE);
    }
  }

  heartbeat(id: string, now: number, boot: string | null): void {
    const device = this.#device(id);
    // A new boot ID means the machine has restarted since its last heartbeat.
    const rebooted = boot !== null && device.boot !== null && boot !== device.boot;
    if (!device.outage && rebooted && device.lastSeen !== null) {
      // Restarted faster than the timeout: no outage is open yet, but it was one.
      device.outage = openOutage(device.lastSeen);
    }
    // The first heartbeat after an outage closes it.
    if (device.outage) {
      const outage = device.outage;
      outage.end = now;
      if (rebooted) outage.rebooted = true;
      device.outage = null;
      device.history = [outage, ...device.history].slice(0, HISTORY_SIZE);
      this.#hooks.onOutageEnd?.(device, outage);
    }
    device.lastSeen = now;
    if (boot !== null) device.boot = boot;
    this.#setStatus(device, 'online');
  }

  // A stage report opens an outage if there is none yet: the wipe script reports
  // before the system goes down, the recovery environment reports after.
  progress(id: string, now: number, report: StageReport): void {
    const device = this.#device(id);
    if (!device.outage) device.outage = openOutage(device.lastSeen ?? now);
    const stages = device.outage.stages;
    const last = stages.at(-1);
    if (last?.name === report.name) {
      // The same stage again, such as "download 60" after "download 40": update it.
      last.updated = now;
      last.percent = report.percent;
      if (report.message !== null) last.message = report.message;
    } else {
      stages.push({ name: report.name, at: now, updated: now, percent: report.percent, message: report.message });
      if (stages.length > MAX_STAGES) stages.shift(); // drop the oldest
    }
    this.#setStatus(device, 'recovering');
  }

  // Opens an outage for each device silent for longer than the timeout, from its
  // last heartbeat on. Returns true if any status changed.
  tick(now: number): boolean {
    let changed = false;
    for (const device of this.#devices.values()) {
      if (device.status === 'online' && device.lastSeen !== null && now - device.lastSeen > this.#timeoutMs) {
        device.outage = openOutage(device.lastSeen);
        this.#setStatus(device, 'offline');
        changed = true;
      }
    }
    return changed;
  }

  #device(id: string): DeviceState {
    const device = this.#devices.get(id);
    if (!device) throw new Error(`unknown device ${id}`);
    return device;
  }

  #setStatus(device: DeviceState, status: Status): void {
    if (device.status === status) return;
    const from = device.status;
    device.status = status;
    this.#hooks.onStatus?.(device, from);
  }
}
