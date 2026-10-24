import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface Device {
  id: string;
  name: string;
  tokenHash: Buffer;
}

export interface Config {
  host: string;
  port: number;
  root: string;
  dataDir: string;
  filesDir: string;
  heartbeatTimeoutMs: number;
  devices: Device[];
}

// The project root: the parent of both src/ and dist/.
const root = path.resolve(import.meta.dirname, '..');

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = env(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

export async function loadConfig(): Promise<Config> {
  const devicesFile = path.resolve(root, env('DEVICES_FILE', 'config/devices.json'));
  return {
    host: env('HOST', '127.0.0.1'),
    port: positiveInt('PORT', 8090),
    root,
    dataDir: path.resolve(root, env('DATA_DIR', 'data')),
    filesDir: path.resolve(root, env('FILES_DIR', 'files')),
    heartbeatTimeoutMs: positiveInt('HEARTBEAT_TIMEOUT_MS', 3000),
    devices: parseDevices(JSON.parse(await readFile(devicesFile, 'utf8')), devicesFile),
  };
}

// devices.json: {"devices": [{"id": "laptop", "name": "Laptop", "tokenSha256": "<64 hex digits>"}]}
export function parseDevices(raw: unknown, source: string): Device[] {
  const list = (raw as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${source}: "devices" must be a non-empty array`);
  const ids = new Set<string>();
  return list.map((item: unknown, i) => {
    const { id, name, tokenSha256 } = (item ?? {}) as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(id)) {
      throw new Error(`${source}: devices[${i}].id must match [a-z0-9-]{1,32}`);
    }
    if (ids.has(id)) throw new Error(`${source}: device id "${id}" is used twice`);
    ids.add(id);
    if (typeof tokenSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(tokenSha256)) {
      throw new Error(`${source}: devices[${i}].tokenSha256 must be a SHA-256 hex digest`);
    }
    return { id, name: typeof name === 'string' && name !== '' ? name : id, tokenHash: Buffer.from(tokenSha256, 'hex') };
  });
}
