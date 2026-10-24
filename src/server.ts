import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import path from 'node:path';

import { loadConfig } from './config.js';
import { sendFile, Transfers } from './files.js';
import { Monitor, type StageReport } from './monitor.js';
import * as probe from './probe.js';
import { Store } from './store.js';

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_VIEWERS = 200;
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PAGES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/probe': { file: 'probe.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/probe.js': { file: 'probe.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

const config = await loadConfig();
const webDir = path.join(config.root, 'dist', 'web');
const store = new Store(config.dataDir);
// The open status pages: each is a response kept open for server-sent events.
const viewers = new Set<ServerResponse>();
// Set on every change; the next tick sends the state to the viewers.
let stateChanged = true;
let lastBroadcast = 0;

const transfers = new Transfers(() => {
  stateChanged = true;
});
const monitor = new Monitor(config.devices, config.heartbeatTimeoutMs, {
  onStatus(device, from) {
    console.log(`${device.id}: ${from} -> ${device.status}`);
  },
  onOutageEnd(device, outage) {
    const seconds = ((outage.end ?? outage.start) - outage.start) / 1000;
    console.log(`${device.id}: back after ${seconds.toFixed(1)} s${outage.rebooted ? ', rebooted' : ''}`);
    store.appendOutage(device.id, outage);
  },
});
monitor.restore(await store.load());

function changed(): void {
  stateChanged = true;
  store.save(monitor.devices);
}

// What /api/state and the status page get: the devices with their last 10
// outages, and the downloads.
function snapshot(now: number) {
  return {
    now,
    timeoutMs: config.heartbeatTimeoutMs,
    devices: monitor.devices.map(({ id, name, status, lastSeen, outage, history }) => ({
      id,
      name,
      status,
      lastSeen,
      outage,
      history: history.slice(0, 10),
    })),
    transfers: transfers.list(),
  };
}

function broadcast(now: number): void {
  stateChanged = false;
  lastBroadcast = now;
  const frame = `event: state\ndata: ${JSON.stringify(snapshot(now))}\n\n`;
  for (const viewer of viewers) viewer.write(frame);
}

// Four times a second: find devices that went silent, and send the state to the
// viewers when it changed, or every second while a file downloads.
setInterval(() => {
  const now = Date.now();
  if (monitor.tick(now)) changed();
  const downloading = transfers.active.size > 0;
  if (stateChanged || (downloading && now - lastBroadcast >= 1000)) broadcast(now);
}, 250);

// Proxies drop connections that stay silent for too long.
setInterval(() => {
  for (const viewer of viewers) viewer.write(': keepalive\n\n');
}, 15_000);

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(data);
}

// The token identifies the device; the server keeps only SHA-256 digests of tokens.
// timingSafeEqual takes the same time however many bytes match.
function authenticate(req: IncomingMessage): string {
  const token = /^Bearer ([\w-]{16,128})$/.exec(req.headers.authorization ?? '')?.[1];
  if (token !== undefined) {
    const digest = createHash('sha256').update(token).digest();
    const device = config.devices.find((d) => timingSafeEqual(digest, d.tokenHash));
    if (device) return device.id;
  }
  throw new HttpError(401, 'unknown device token');
}

async function readJson(req: IncomingMessage, limit = 4096): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function parseStage(body: Record<string, unknown>): StageReport {
  const { stage, percent, message } = body;
  if (typeof stage !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(stage)) {
    throw new HttpError(400, 'stage must match [a-z0-9][a-z0-9_-]{0,31}');
  }
  let pct: number | null = null;
  if (percent !== undefined && percent !== null) {
    if (typeof percent !== 'number' || !(percent >= 0 && percent <= 100)) {
      throw new HttpError(400, 'percent must be a number from 0 to 100');
    }
    pct = Math.round(percent * 10) / 10; // one decimal
  }
  let text: string | null = null;
  if (message !== undefined && message !== null) {
    if (typeof message !== 'string') throw new HttpError(400, 'message must be a string');
    text = message.trim().slice(0, 200) || null;
  }
  return { name: stage, percent: pct, message: text };
}

async function heartbeat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const id = authenticate(req);
  const { boot } = await readJson(req);
  monitor.heartbeat(id, Date.now(), typeof boot === 'string' && /^[\w-]{1,64}$/.test(boot) ? boot : null);
  changed();
  res.writeHead(204).end();
}

async function progress(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const id = authenticate(req);
  monitor.progress(id, Date.now(), parseStage(await readJson(req)));
  changed();
  res.writeHead(204).end();
}

// Server-sent events: the response stays open, and each "event: state" frame
// carries the whole state. "retry: 2000" makes the browser reconnect after 2 s.
function events(res: ServerResponse): void {
  if (viewers.size >= MAX_VIEWERS) throw new HttpError(503, 'too many viewers');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(snapshot(Date.now()))}\n\n`);
  viewers.add(res);
  res.on('close', () => viewers.delete(res));
}

async function sendPage(req: IncomingMessage, res: ServerResponse, page: { file: string; type: string }): Promise<void> {
  const body = await readFile(path.join(webDir, page.file));
  const headers: OutgoingHttpHeaders = { 'Content-Type': page.type, 'Cache-Control': 'no-cache' };
  if (page.type.startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
  res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : body);
}

function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'bad path');
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'POST') {
    if (pathname === '/api/heartbeat') return heartbeat(req, res);
    if (pathname === '/api/progress') return progress(req, res);
    if (pathname === '/api/probe/post') return probe.post(req, res);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok\n');
    return;
  }
  if (pathname === '/api/state') return json(res, 200, snapshot(Date.now()));
  if (pathname === '/api/events') return events(res);
  if (pathname === '/api/probe/whoami') return probe.whoami(req, res);
  if (pathname.startsWith('/api/probe/')) {
    // Test files for the speed check; any other name ends in 404 below.
    const sent = await probe.testFile(res, pathname.slice('/api/probe/'.length));
    if (sent) return;
  }
  if (pathname.startsWith('/files/')) {
    return sendFile(req, res, config.filesDir, decodePath(pathname.slice('/files/'.length)), transfers);
  }
  const page = PAGES[pathname];
  if (page) return sendPage(req, res, page);
  throw new HttpError(404, 'not found');
}

const server = createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  route(req, res).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) res.destroy();
    else json(res, status, { error: err instanceof HttpError ? err.message : 'internal error' });
  });
});
// Clients that send their request too slowly are cut off.
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.listen(config.port, config.host, () => {
  console.log(`listening on http://${config.host}:${config.port}, devices: ${config.devices.map((d) => d.id).join(', ')}`);
});

// On Ctrl-C or `systemctl stop`, save the state before exiting.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    store.flush(monitor.devices);
    process.exit(0);
  });
}
