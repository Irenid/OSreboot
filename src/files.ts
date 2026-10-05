import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export interface Transfer {
  id: number;
  file: string;
  offset: number; // first byte sent, not 0 when a download is resumed
  size: number; // bytes in this response
  sent: number;
  start: number;
  end: number | null;
  ok: boolean | null;
}

const RECENT = 10;

export class Transfers {
  readonly active = new Map<number, Transfer>();
  #recent: Transfer[] = [];
  #next = 1;
  readonly #onChange: () => void;

  constructor(onChange: () => void = () => {}) {
    this.#onChange = onChange;
  }

  begin(file: string, offset: number, size: number, now: number): Transfer {
    const t: Transfer = { id: this.#next++, file, offset, size, sent: 0, start: now, end: null, ok: null };
    this.active.set(t.id, t);
    this.#onChange();
    return t;
  }

  finish(t: Transfer, ok: boolean, now: number): void {
    t.end = now;
    t.ok = ok;
    this.active.delete(t.id);
    this.#recent = [t, ...this.#recent].slice(0, RECENT);
    this.#onChange();
  }

  list(): Transfer[] {
    return [...this.active.values(), ...this.#recent];
  }
}

export interface ByteRange {
  start: number;
  end: number;
}

// One byte range as in RFC 9110. Malformed and multi-range headers are ignored,
// so the whole file is sent; a range that starts past the end is unsatisfiable.
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, from = '', to = ''] = match;
  if (from === '' && to === '') return null;
  if (from === '') {
    const suffix = Number(to);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  if (to !== '' && Number(to) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: to === '' ? size - 1 : Math.min(Number(to), size - 1) };
}

// UEFI HTTP Boot picks the image type from Content-Type first, then from the extension.
const TYPES: Record<string, string> = {
  '.efi': 'application/efi',
  '.iso': 'application/vnd.efi-iso',
  '.img': 'application/vnd.efi-img',
  '.ipxe': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.sha256': 'text/plain; charset=utf-8',
  '.minisig': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

// Path segments must not start with a dot: no "..", no hidden files.
const SAFE_PATH = /^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*$/;

export async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  dir: string,
  name: string,
  transfers: Transfers,
): Promise<void> {
  const file = name.length <= 200 && SAFE_PATH.test(name) ? path.join(dir, name) : null;
  const info = file === null ? null : await stat(file).catch(() => null);
  if (file === null || !info?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found\n');
    return;
  }

  const range = parseRange(req.headers.range, info.size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  const length = end - start + 1;
  const headers: OutgoingHttpHeaders = {
    'Content-Type': TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': length,
    'Accept-Ranges': 'bytes',
    'Last-Modified': info.mtime.toUTCString(),
    'Cache-Control': 'no-cache',
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return;
  }

  const transfer = transfers.begin(name, start, length, Date.now());
  const stream = createReadStream(file, { start, end });
  stream.on('data', (chunk) => {
    transfer.sent += chunk.length;
  });
  try {
    await pipeline(stream, res);
    transfers.finish(transfer, true, Date.now());
  } catch {
    transfers.finish(transfer, false, Date.now());
  }
}
