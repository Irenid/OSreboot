import { renameSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DeviceState, Outage } from './monitor.js';

const CSV_HEADER = 'device,start,end,downtime_s,rebooted,stages\n';

// state.json survives restarts; outages.csv keeps every closed outage for later analysis.
export class Store {
  readonly #dir: string;
  readonly #stateFile: string;
  readonly #csvFile: string;
  // File writes run one after another: each job waits for the one before it.
  #queue: Promise<void> = Promise.resolve();
  #devices: DeviceState[] = [];
  #timer: NodeJS.Timeout | undefined;

  constructor(dir: string) {
    this.#dir = dir;
    this.#stateFile = path.join(dir, 'state.json');
    this.#csvFile = path.join(dir, 'outages.csv');
  }

  async load(): Promise<DeviceState[]> {
    await mkdir(this.#dir, { recursive: true });
    let text: string;
    try {
      text = await readFile(this.#stateFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    try {
      return (JSON.parse(text) as { devices: DeviceState[] }).devices;
    } catch {
      console.warn(`${this.#stateFile} is damaged, starting with an empty state`);
      return [];
    }
  }

  // Heartbeats come every second, so writes are coalesced to one per second:
  // the first change starts a 1 s timer, and the write saves the latest state.
  save(devices: DeviceState[]): void {
    this.#devices = devices;
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#enqueue(() => this.#write());
    }, 1000);
  }

  // Synchronous write for shutdown: the process exits right after it.
  flush(devices: DeviceState[]): void {
    clearTimeout(this.#timer);
    const tmp = `${this.#stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ devices }));
    renameSync(tmp, this.#stateFile);
  }

  // Adds a line to outages.csv; a new file gets the header first.
  appendOutage(device: string, outage: Outage): void {
    this.#enqueue(async () => {
      const exists = await stat(this.#csvFile).then(() => true, () => false);
      await appendFile(this.#csvFile, (exists ? '' : CSV_HEADER) + csvLine(device, outage));
    });
  }

  // Runs the job after the ones queued before it. A failed job is logged and
  // does not stop the next ones.
  #enqueue(job: () => Promise<void>): void {
    this.#queue = this.#queue.then(job).catch((err: unknown) => console.error('store:', err));
  }

  // Writes a temporary file, then renames it to state.json. A rename replaces
  // the file in one step, so state.json is never left half-written.
  async #write(): Promise<void> {
    const tmp = `${this.#stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ devices: this.#devices }));
    await rename(tmp, this.#stateFile);
  }
}

// Stages are written as name@seconds since the start of the outage, e.g.
// laptop,2026-10-23T15:53:47.335Z,2026-10-23T15:56:33.005Z,165.7,true,wipe@0.3 netboot@0.5 recovery@68.2 …
export function csvLine(device: string, outage: Outage): string {
  const end = outage.end ?? outage.start;
  const stages = outage.stages.map((s) => `${s.name}@${((s.at - outage.start) / 1000).toFixed(1)}`).join(' ');
  const fields = [
    device,
    new Date(outage.start).toISOString(),
    new Date(end).toISOString(),
    ((end - outage.start) / 1000).toFixed(1),
    String(outage.rebooted),
    stages,
  ];
  return `${fields.join(',')}\n`;
}
