import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';

// Endpoints for the access check page (web/probe.ts).

const MIB = 1024 * 1024;
// Files for the download speed test: name and size.
const TEST_FILES = new Map([
  ['10m.bin', 10 * MIB],
  ['100m.bin', 100 * MIB],
]);
// Every test uses up to 100 MiB of the VPS traffic: at most two at a time.
const MAX_PARALLEL = 2;
const noise = randomBytes(MIB);
let running = 0;

export function whoami(req: IncomingMessage, res: ServerResponse): void {
  // Behind the reverse proxy the client address and protocol come in headers set by nginx.
  const realIp = req.headers['x-real-ip'];
  const proto = req.headers['x-client-proto'];
  const body = JSON.stringify({
    ip: typeof realIp === 'string' ? realIp : (req.socket.remoteAddress ?? ''),
    msec: Date.now() / 1000,
    proto: typeof proto === 'string' ? proto : `HTTP/${req.httpVersion}`,
  });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(body);
}

// Reads the request body and drops it, as the server does with a heartbeat.
export async function post(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 16 * 1024) {
      res.writeHead(413).end();
      return;
    }
  }
  res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
}

// Sends the test file `name`: random bytes, so that nothing on the way can
// compress them. Returns false if there is no test file of that name.
export async function testFile(res: ServerResponse, name: string): Promise<boolean> {
  const size = TEST_FILES.get(name);
  if (size === undefined) return false;
  if (running >= MAX_PARALLEL) {
    res.writeHead(503, { 'Retry-After': '10' }).end();
    return true;
  }
  running++;
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-store' });
  try {
    await pipeline(chunks(size), res);
  } catch {
    // the client went away
  } finally {
    running--;
  }
  return true;
}

// The same 1 MiB of random bytes over and over, `size` bytes in all.
function* chunks(size: number): Generator<Buffer> {
  for (let left = size; left > 0; left -= noise.length) {
    yield noise.subarray(0, Math.min(left, noise.length));
  }
}
