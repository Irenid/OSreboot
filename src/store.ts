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

  // Heartbeats come every second, so writes are coalesced to one per second.
  save(devices: DeviceState[]): void {
    this.#devices = devices;
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      this.#enqueue(() => this.#write());
    }, 1000);
  }

  // Synchronous write for shutdown.
  flush(devices: DeviceState[]): void {
    clearTimeout(this.#timer);
    const tmp = `${this.#stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ devices }));
    renameSync(tmp, this.#stateFile);
  }

  appendOutage(device: string, outage: Outage): void {
    this.#enqueue(async () => {
      const exists = await stat(this.#csvFile).then(() => true, () => false);
      await appendFile(this.#csvFile, (exists ? '' : CSV_HEADER) + csvLine(device, outage));
    });
  }

  #enqueue(job: () => Promise<void>): void {
    this.#queue = this.#queue.then(job).catch((err: unknown) => console.error('store:', err));
  }

  async #write(): Promise<void> {
    const tmp = `${this.#stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ devices: this.#devices }));
    await rename(tmp, this.#stateFile);
  }
}

// Stages are written as name@seconds since the start of the outage.
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
