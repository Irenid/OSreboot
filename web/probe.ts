// Checks how the server is reachable from the current network: response time,
// download speed and POST requests like the ones heartbeats use.

type State = 'run' | 'ok' | 'warn' | 'bad';

interface Downloaded {
  bytes: number;
  ms: number; // from the response headers to the last byte
}

interface Failed {
  bytes: number; // what arrived before the failure
  error: string;
  stalled: boolean; // no new data for STALL_MS
}

interface WhoAmI {
  ip: string;
  msec: number;
  proto: string;
}

const BASE = new URL('.', location.href).href; // directory of the page, e.g. https://example.org/osreboot/
const IMAGE_MB = 500; // rough image size, for the download time estimate
const STALL_MS = 8000; // no new data for this long means the connection has stalled
const ICON: Record<State, string> = { run: '…', ok: '✓', warn: '!', bad: '✗' };

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} is missing`);
  return node;
}

const num = (x: number, digits = 1) => x.toLocaleString('en-US', { maximumFractionDigits: digits });
const kb = (b: number) => `${num(b / 1024, 0)} KB`;
const mb = (b: number) => `${num(b / 1048576)} MB`;
const ms = (t: number) => (t < 1000 ? `${Math.round(t)} ms` : `${num(t / 1000)} s`);
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
const fresh = (path: string) => `${BASE}${path}?t=${Date.now()}`; // a new URL every time, past any cache

function dur(seconds: number): string {
  const s = Math.round(seconds);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.name === 'AbortError' ? `no response in ${ms(STALL_MS)}` : e.message;
  return String(e);
}

// Aborts after `limit` ms; arm() starts the countdown again.
function watchdog(limit: number) {
  const controller = new AbortController();
  let handle: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(handle);
    handle = setTimeout(() => controller.abort(), limit);
  };
  arm();
  return { signal: controller.signal, arm, stop: () => clearTimeout(handle) };
}

// Downloads a file as a stream. Gives up after STALL_MS without new data and reports how much arrived.
async function download(path: string, progress?: (bytes: number, total: number) => void): Promise<Downloaded | Failed> {
  const timer = watchdog(STALL_MS);
  let bytes = 0;
  try {
    const res = await fetch(fresh(path), { cache: 'no-store', signal: timer.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const bodyStart = performance.now(); // the speed leaves out the time to connect
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      timer.arm();
      progress?.(bytes, total);
    }
    return { bytes, ms: performance.now() - bodyStart };
  } catch (e) {
    return { bytes, error: e instanceof Error ? e.message : String(e), stalled: timer.signal.aborted };
  } finally {
    timer.stop();
  }
}

function failureText(result: Failed): string {
  if (!result.stalled) return result.error === 'HTTP 404' ? 'the file is not on the server (HTTP 404)' : result.error;
  return result.bytes ? `stalled after ${kb(result.bytes)}` : `no response in ${ms(STALL_MS)}`;
}

const checks = byId('checks');
let report: string[] = [];

// One line of the list: set() changes the icon, text and progress bar; done() also adds the result to the report.
function row(title: string) {
  const item = el('li');
  const icon = el('span', 'icon');
  const body = el('div');
  const detail = el('span', 'detail');
  body.append(el('b', '', title), detail);
  item.append(icon, body);
  checks.append(item);

  let bar: HTMLProgressElement | null = null;
  const set = (state: State, text: string, fraction: number | null = null) => {
    item.className = state;
    icon.textContent = ICON[state];
    detail.textContent = text;
    if (fraction === null) {
      bar?.remove();
      bar = null;
      return;
    }
    if (!bar) body.append((bar = el('progress')));
    bar.value = fraction;
  };
  set('run', 'checking…');
  return {
    set,
    done(state: State, text: string) {
      set(state, text);
      report.push(`${ICON[state]} ${title}: ${text}`);
    },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// Five requests: the round-trip time, the public address the server sees,
// and how far the clock of this device is off.
async function checkServer(): Promise<void> {
  const check = row('Server response');
  const times: number[] = [];
  let info: WhoAmI | null = null;
  let skew = 0;
  try {
    for (let i = 0; i < 5; i++) {
      const timer = watchdog(STALL_MS);
      const sent = Date.now();
      const started = performance.now();
      const res = await fetch(fresh('api/probe/whoami'), { cache: 'no-store', signal: timer.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      info = (await res.json()) as WhoAmI;
      timer.stop();
      const rtt = performance.now() - started;
      times.push(rtt);
      skew = info.msec * 1000 - (sent + rtt / 2); // > 0: the server clock is ahead of this device
    }
  } catch (e) {
    check.done('bad', errorText(e));
    return;
  }
  if (!info) return;
  let text = `${ms(median(times))} (median of 5) · public IP ${info.ip} · ${info.proto}`;
  if (Math.abs(skew) > 2000) text += ` · this device's clock is ${num(Math.abs(skew) / 1000)} s ${skew > 0 ? 'behind' : 'ahead'}`;
  check.done('ok', text);
}

async function checkSpeed(label: string, path: string): Promise<void> {
  const check = row(`Download ${label}`);
  const result = await download(path, (bytes, total) =>
    check.set('run', total ? `${mb(bytes)} of ${mb(total)}` : mb(bytes), total ? bytes / total : null),
  );
  if ('error' in result) {
    check.done('bad', failureText(result));
    return;
  }
  const mbit = (result.bytes * 8) / result.ms / 1000; // bytes * 8 / ms / 1000 = Mbit/s
  check.done('ok', `${num(mbit)} Mbit/s · a ${IMAGE_MB} MB image takes about ${dur((IMAGE_MB * 8) / mbit)}`);
}

async function checkPost(): Promise<void> {
  const check = row('POST, like a heartbeat');
  const times: number[] = [];
  let lastError = '';
  for (let i = 0; i < 3; i++) {
    const timer = watchdog(STALL_MS);
    const started = performance.now();
    try {
      const res = await fetch(fresh('api/probe/post'), {
        method: 'POST',
        body: new Uint8Array(1024),
        cache: 'no-store',
        signal: timer.signal,
      });
      if (res.status === 204) times.push(performance.now() - started);
      else lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = errorText(e);
    }
    timer.stop();
  }
  const passed = times.length;
  const text = `${passed} of 3` + (passed ? ` · ${ms(median(times))}` : '') + (lastError ? ` · ${lastError}` : '');
  // All three went through: ok; some: a warning; none: failed.
  check.done(passed === 3 ? 'ok' : passed > 0 ? 'warn' : 'bad', text);
}

// Buttons stay disabled while a check runs.
async function exclusive(job: () => Promise<void>): Promise<void> {
  const buttons = document.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    await job();
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

function runAll(): Promise<void> {
  return exclusive(async () => {
    checks.replaceChildren();
    report = [];
    byId('report').hidden = true;
    row('Page loaded').done('ok', location.origin);
    await checkServer();
    await checkSpeed('10 MB', 'api/probe/10m.bin');
    await checkPost();
  });
}

// The clipboard API needs HTTPS; on plain http:// fall back to execCommand.
async function copyReport(): Promise<void> {
  const text = [`Access check · ${new Date().toLocaleString('en-GB')}`, ...report, navigator.userAgent].join('\n');
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const area = el('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      // nothing else to try, the report is shown below
    }
    area.remove();
  }
  const out = byId('report');
  out.textContent = text;
  out.hidden = false; // the report stays visible, so it can be selected by hand if copying failed
  const button = byId('copy');
  button.textContent = ok ? 'Copied ✓' : 'Could not copy, the text is below';
  setTimeout(() => (button.textContent = 'Copy report'), 2500);
}

// "https:" -> HTTPS
byId('origin').textContent = `Server: ${location.host} · ${location.protocol.slice(0, -1).toUpperCase()}`;
// The same checks with curl, for a terminal.
const serverUrl = BASE.replace(/\/$/, '');
byId('cli').textContent = [
  `B='${serverUrl}'`,
  `curl -sS "$B/api/probe/whoami"`,
  `curl -sS -o /dev/null -w '%{speed_download}' "$B/api/probe/10m.bin" | awk '{printf "10m: %.1f Mbit/s\\n", $1*8/1e6}'`,
  `curl -sS -o /dev/null -w 'POST: %{http_code}\\n' -d x "$B/api/probe/post"`,
].join('\n');
byId('again').addEventListener('click', () => void runAll());
byId('big').addEventListener('click', () => void exclusive(() => checkSpeed('100 MB', 'api/probe/100m.bin')));
byId('copy').addEventListener('click', () => void copyReport());
void runAll();
