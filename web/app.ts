type Status = 'unknown' | 'online' | 'offline' | 'recovering';

interface Stage {
  name: string;
  at: number;
  updated: number;
  percent: number | null;
  message: string | null;
}

interface Outage {
  start: number;
  end: number | null;
  rebooted: boolean;
  stages: Stage[];
}

interface Device {
  id: string;
  name: string;
  status: Status;
  lastSeen: number | null;
  outage: Outage | null;
  history: Outage[];
}

interface Transfer {
  id: number;
  file: string;
  offset: number;
  size: number;
  sent: number;
  start: number;
  end: number | null;
  ok: boolean | null;
}

interface Snapshot {
  now: number;
  timeoutMs: number;
  devices: Device[];
  transfers: Transfer[];
}

const STATUS: Record<Status, string> = {
  unknown: 'No data',
  online: 'Online',
  offline: 'Down',
  recovering: 'Recovering',
};

// Stage names sent by the recovery scripts. Unknown names are shown as they are.
const STAGES: Record<string, string> = {
  wipe: 'Wiping the system',
  netboot: 'Booting over the network',
  recovery: 'Recovery environment is up',
  partition: 'Finding the test partitions',
  download: 'Downloading the system image',
  verify: 'Checking the SHA-256 sums',
  write: 'Writing the image to disk',
  bootloader: 'Restoring the boot entry',
  reboot: 'Rebooting into the restored system',
};

let clockOffset = 0; // server clock minus the clock of this device
const beats = new Map<string, number>();
const openHistory = new Set<string>();

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} is missing`);
  return node;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function duration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(Math.floor(s % 60)).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

function clock(ts: number, withDate = false): string {
  const date = new Date(ts);
  const time = date.toLocaleTimeString('en-GB');
  return withDate ? `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${time}` : time;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1 << 20 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1 << 20)).toFixed(1)} MB`;
}

// Speed means little for a transfer that took a fraction of a second.
function speed(bytes: number, ms: number): string {
  return ms >= 500 ? ` · ${(bytes / (1 << 20) / (ms / 1000)).toFixed(1)} MB/s` : '';
}

// Time since a server timestamp; tick() keeps it current between updates.
function since(ts: number, suffix = ''): HTMLElement {
  const node = el('span');
  node.dataset.since = String(ts);
  node.dataset.suffix = suffix;
  return node;
}

function tick(): void {
  const now = Date.now() + clockOffset;
  for (const node of document.querySelectorAll<HTMLElement>('[data-since]')) {
    node.textContent = duration(now - Number(node.dataset.since)) + (node.dataset.suffix ?? '');
  }
}

function stageTitle(stage: Stage): string {
  return STAGES[stage.name] ?? stage.name;
}

function renderStages(outage: Outage): HTMLElement[] {
  const current = outage.stages.at(-1);
  if (!current) return [el('p', 'muted', 'No reports from the recovery environment yet.')];

  const box = el('div', 'current');
  box.append(el('div', 'stage-title', stageTitle(current) + (current.percent === null ? '' : ` · ${current.percent}%`)));
  if (current.percent !== null) {
    const bar = el('progress');
    bar.max = 100;
    bar.value = current.percent;
    box.append(bar);
  }
  if (current.message) box.append(el('div', 'muted', current.message));
  const updated = el('div', 'muted');
  updated.append('Updated ', since(current.updated, ' ago'));
  box.append(updated);

  const timeline = el('ol', 'timeline');
  for (const stage of outage.stages) {
    const item = el('li');
    item.append(el('span', 'offset', `+${duration(stage.at - outage.start)}`), el('span', '', stageTitle(stage)));
    timeline.append(item);
  }
  return [box, timeline];
}

function renderHistory(device: Device): HTMLElement {
  const box = el('details');
  box.open = openHistory.has(device.id);
  box.addEventListener('toggle', () => {
    if (box.open) openHistory.add(device.id);
    else openHistory.delete(device.id);
  });
  box.append(el('summary', '', `Previous outages (${device.history.length})`));

  const table = el('table');
  const head = table.createTHead().insertRow();
  for (const title of ['Back at', 'Downtime', 'Reboot', 'Stages']) head.append(el('th', '', title));
  const body = table.createTBody();
  for (const outage of device.history) {
    const row = body.insertRow();
    row.append(
      el('td', '', outage.end === null ? '' : clock(outage.end, true)),
      el('td', '', outage.end === null ? '' : duration(outage.end - outage.start)),
      el('td', '', outage.rebooted ? 'yes' : 'no'),
      el('td', 'stage-names', outage.stages.map((s) => s.name).join(' → ') || '—'),
    );
  }
  box.append(table);
  return box;
}

function renderDevice(device: Device): HTMLElement {
  const card = el('article', `device ${device.status}`);
  const head = el('header');
  head.append(el('h2', '', device.name), el('span', 'badge', STATUS[device.status]));
  card.append(head);

  if (device.outage) {
    card.append(el('p', 'muted', device.status === 'recovering' ? 'Down for' : 'No heartbeat for'));
    const counter = el('p', 'big');
    counter.append(since(device.outage.start));
    card.append(counter, el('p', 'muted', `Last heartbeat at ${clock(device.outage.start)}`), ...renderStages(device.outage));
  } else if (device.status === 'online' && device.lastSeen !== null) {
    const line = el('p', 'heartbeat');
    const pulse = el('span', 'pulse');
    if (beats.get(device.id) !== device.lastSeen) pulse.classList.add('beat');
    beats.set(device.id, device.lastSeen);
    line.append(pulse, 'Heartbeat ', since(device.lastSeen, ' ago'));
    card.append(line);
    const last = device.history[0];
    if (last && last.end !== null) {
      const reboot = last.rebooted ? ' with a reboot' : '';
      card.append(el('p', 'muted', `Last outage: ${duration(last.end - last.start)}${reboot}, back at ${clock(last.end)}`));
    }
  } else {
    const seen = device.lastSeen === null ? 'Waiting for the first heartbeat.' : `Waiting for a heartbeat. The last one came at ${clock(device.lastSeen, true)}.`;
    card.append(el('p', 'muted', seen));
  }

  if (device.history.length > 0) card.append(renderHistory(device));
  return card;
}

function renderTransfers(list: Transfer[], now: number): HTMLElement[] {
  if (list.length === 0) return [el('p', 'muted', 'Nothing has been downloaded yet.')];
  return list.map((t) => {
    const row = el('div', 'transfer');
    row.append(el('div', 'file', t.offset > 0 ? `${t.file} (from ${size(t.offset)})` : t.file));
    if (t.end === null) {
      const bar = el('progress');
      bar.max = t.size;
      bar.value = t.sent;
      row.append(bar, el('div', 'muted', `${size(t.sent)} of ${size(t.size)}${speed(t.sent, now - t.start)}`));
    } else {
      const result = t.ok ? 'Done' : 'Interrupted';
      const took = t.end - t.start;
      row.append(el('div', 'muted', `${result} at ${clock(t.end)} · ${size(t.sent)} in ${duration(took)}${speed(t.sent, took)}`));
    }
    return row;
  });
}

function render(snapshot: Snapshot): void {
  byId('devices').replaceChildren(...snapshot.devices.map(renderDevice));
  byId('transfers').replaceChildren(...renderTransfers(snapshot.transfers, snapshot.now));
  tick();
}

function setLink(state: 'live' | 'lost', text: string): void {
  const link = byId('link');
  link.className = `link ${state}`;
  link.textContent = text;
  document.body.classList.toggle('stale', state === 'lost');
}

const events = new EventSource('api/events');
events.addEventListener('state', (event) => {
  const snapshot = JSON.parse((event as MessageEvent<string>).data) as Snapshot;
  clockOffset = snapshot.now - Date.now();
  setLink('live', 'Live');
  render(snapshot);
});
events.addEventListener('error', () => setLink('lost', 'Connection lost, reconnecting…'));
setInterval(tick, 200);
