// The status page: what each device is doing right now, stage by stage, and
// the files the server hands out for the recovery.

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

type Lang = 'ru' | 'en';
type StepId = 'wipe' | 'netboot' | 'uki' | 'start' | 'download' | 'verify' | 'write' | 'reboot';
type StepState = 'done' | 'now' | 'failed' | 'todo' | 'skip';
// What a device card shows: 'active' is a recovery under way, 'offline' an
// outage without any stage reports.
type Mode = 'online' | 'active' | 'failed' | 'offline' | 'unknown';

// The recovery in eight stages, with their usual length in seconds
// (run 4 of 23.10, README table 2).
const STEPS: { id: StepId; typical: number }[] = [
  { id: 'wipe', typical: 1 },
  { id: 'netboot', typical: 24 },
  { id: 'uki', typical: 15 },
  { id: 'start', typical: 29 },
  { id: 'download', typical: 42 },
  { id: 'verify', typical: 5 },
  { id: 'write', typical: 9 },
  { id: 'reboot', typical: 42 },
];

// Stage names sent by the scripts and the stage of the page they belong to.
// "uki" has no report: the server sees it as the download of UKI_FILE.
const STAGE_STEP: Record<string, StepId> = {
  wipe: 'wipe',
  netboot: 'netboot',
  recovery: 'start',
  partition: 'start',
  download: 'download',
  verify: 'verify',
  write: 'write',
  bootloader: 'write',
  reboot: 'reboot',
};

const BOOT_SCRIPT = 'boot.ipxe';
const UKI_FILE = 'osreboot-recovery.efi';
// The files in files/ on the server, in the order the machine downloads them.
const FILES = [
  { name: BOOT_SCRIPT, step: 'netboot' },
  { name: UKI_FILE, step: 'uki' },
  { name: 'SHA256SUMS', step: 'download' },
  { name: 'osreboot-test.esp.raw.zst', step: 'download' },
  { name: 'osreboot-test.root-x86-64.raw.zst', step: 'download' },
] as const;

const RU = {
  title: 'OSreboot — восстановление системы',
  connecting: 'Подключение…',
  live: 'Обновляется в реальном времени',
  lost: 'Нет связи с сервером, переподключаюсь…',
  status: { online: 'Работает', active: 'Восстанавливается', failed: 'Остановлено', offline: 'Нет связи', unknown: 'Нет данных' },
  onlineTitle: 'Система работает',
  heartbeat: 'Последний сигнал {0} назад',
  onlineText: 'Раз в секунду система сообщает серверу, что она жива (heartbeat). Если её стереть, ноутбук восстановит её сам, а этапы появятся здесь.',
  downtime: 'Простой',
  stageOf: 'Этап {0} из {1}',
  stoppedAt: 'Остановлено на этапе {0} из {1}',
  running: 'идёт {0}',
  typical: 'обычно около {0} с',
  slow: 'дольше обычного',
  lastTime: 'В прошлый раз всё восстановление заняло {0}.',
  failedText: 'Восстановление остановилось, и на диск больше ничего не пишется. Через 20 минут машина сама перезагрузится в свою основную систему.',
  ukiBroken: 'Скачивание оборвалось. iPXE покажет ошибку и через минуту перезагрузит машину в её основную систему.',
  reason: 'Причина',
  bootScriptSeen: 'iPXE нашёл сервер и скачал boot.ipxe',
  offlineTitle: 'Сигналы не приходят',
  offlineText: 'Ноутбук выключен, перезагружается или остался без сети. Если начнётся восстановление, здесь появятся его этапы.',
  lastSignal: 'Последний сигнал: {0}',
  unknownTitle: 'Ждём сигнал',
  neverSeen: 'Устройство ещё ни разу не выходило на связь.',
  stepsNow: 'Этапы восстановления',
  stepsLast: 'Последнее восстановление',
  steps: {
    wipe: {
      title: 'Стирание системы',
      text: 'Команда osreboot-wipe затирает начало обоих тестовых разделов. На диске больше нет ни загрузчика, ни файловой системы: система уничтожена.',
    },
    netboot: {
      title: 'Перезагрузка и сетевой загрузчик',
      text: 'Машина перезагружается, и вместо стёртой системы запускается iPXE — сетевой загрузчик с раздела, который затирание не трогает. iPXE получает адрес в сети и находит сервер.',
    },
    uki: {
      title: 'Скачивание среды восстановления',
      text: 'iPXE скачивает по HTTPS среду восстановления — целый Linux в одном файле. Он доверяет только сертификатам Let’s Encrypt, поэтому чужой сервер не примет.',
    },
    start: {
      title: 'Запуск среды восстановления',
      text: 'Linux стартует целиком в оперативной памяти, на диск пока ничего не пишется. Затем он находит тестовые разделы по меткам: писать можно только в них.',
    },
    download: {
      title: 'Скачивание образов системы',
      text: 'Скачиваются сжатые копии двух тестовых разделов. Обычно это самый долгий этап: всё упирается в скорость сети.',
    },
    verify: {
      title: 'Проверка контрольных сумм',
      text: 'SHA-256 каждого образа сверяется с файлом SHA256SUMS. Если не совпадёт хоть один байт, на диск ничего не запишется.',
    },
    write: {
      title: 'Запись на диск',
      text: 'Образы записываются в тестовые разделы, читаются обратно и сверяются ещё раз. Потом прошивке указывается, что загрузить в следующий раз (BootNext).',
    },
    reboot: {
      title: 'Перезагрузка в восстановленную систему',
      text: 'Машина перезагружается уже в восстановленную систему. Её первый сигнал серверу закончит простой.',
    },
  },
  back: {
    title: 'Система снова на связи',
    text: 'Восстановленная система прислала первый сигнал. Сервер записал, сколько длился простой и каждый этап.',
  },
  history: 'Прошлые простои ({0})',
  columns: ['Закончился', 'Длился', 'Что было'],
  kind: {
    full: 'Восстановление после стирания',
    manual: 'Восстановление без стирания',
    failed: 'Восстановление остановлено',
    cut: 'Прервано на этапе «{0}»',
    reboot: 'Перезагрузка',
    pause: 'Перерыв в сигналах',
  },
  filesTitle: 'Файлы на сервере',
  filesLead: 'Всё, что ноутбук скачивает для восстановления, в порядке скачивания. Секретов в этих файлах нет, поэтому их можно раздавать открыто.',
  files: {
    'boot.ipxe': 'Короткий сценарий для iPXE. iPXE скачивает его первым, и он запускает среду восстановления.',
    'osreboot-recovery.efi': 'Среда восстановления: Linux в одном файле (UKI). Работает из оперативной памяти.',
    SHA256SUMS: 'Контрольные суммы образов: по ним проверяется, что образы скачались без ошибок.',
    'osreboot-test.esp.raw.zst': 'Сжатый образ загрузочного раздела (EFI) тестовой системы.',
    'osreboot-test.root-x86-64.raw.zst': 'Сжатый образ корневого раздела — сама тестовая система, Arch Linux.',
  },
  stepTag: 'этап {0}',
  missing: 'нет на сервере',
  modified: 'Изменён {0}',
  downloading: 'Скачивается: {0}{1}',
  downloaded: 'Скачан в {0}{1}',
  took: ' · {0} за {1}',
  broken: 'Прервано в {0}: {1}',
  resumed: ' (докачка с {0})',
  of: '{0} из {1}',
  percent: '{0} %',
  source: 'Исходный код',
  probe: 'Проверка доступа к серверу',
  units: { s: 'с', min: 'мин', h: 'ч', b: 'Б', kb: 'КБ', mb: 'МБ', mbps: 'МБ/с' },
};

type Texts = typeof RU;

const EN: Texts = {
  title: 'OSreboot: system recovery',
  connecting: 'Connecting…',
  live: 'Live',
  lost: 'No connection to the server, reconnecting…',
  status: { online: 'Up', active: 'Recovering', failed: 'Stopped', offline: 'No signal', unknown: 'No data' },
  onlineTitle: 'The system is up',
  heartbeat: 'Last heartbeat {0} ago',
  onlineText: 'Every second the system tells the server it is alive (a heartbeat). If it is wiped, the laptop restores it on its own, and the stages show up here.',
  downtime: 'Downtime',
  stageOf: 'Stage {0} of {1}',
  stoppedAt: 'Stopped at stage {0} of {1}',
  running: 'running for {0}',
  typical: 'usually about {0} s',
  slow: 'slower than usual',
  lastTime: 'Last time the whole recovery took {0}.',
  failedText: 'The recovery has stopped, and nothing more is written to the disk. In 20 minutes the machine restarts into its own system.',
  ukiBroken: 'The download broke off. iPXE shows an error and restarts the machine into its own system in a minute.',
  reason: 'Reason',
  bootScriptSeen: 'iPXE found the server and fetched boot.ipxe',
  offlineTitle: 'No heartbeats',
  offlineText: 'The laptop is off, restarting or offline. If a recovery starts, its stages show up here.',
  lastSignal: 'Last heartbeat: {0}',
  unknownTitle: 'Waiting for a heartbeat',
  neverSeen: 'This device has not been online yet.',
  stepsNow: 'Recovery stages',
  stepsLast: 'Last recovery',
  steps: {
    wipe: {
      title: 'Wiping the system',
      text: 'osreboot-wipe overwrites the start of both test partitions. The disk no longer has a boot loader or a file system: the system is gone.',
    },
    netboot: {
      title: 'Restart and network boot loader',
      text: 'The machine restarts, and instead of the wiped system it starts iPXE, a network boot loader on a partition the wipe does not touch. iPXE gets a network address and finds the server.',
    },
    uki: {
      title: 'Downloading the recovery environment',
      text: 'iPXE downloads the recovery environment over HTTPS: a whole Linux in a single file. It trusts only Let’s Encrypt certificates, so it will not accept another server.',
    },
    start: {
      title: 'Starting the recovery environment',
      text: 'Linux starts entirely in memory; nothing is written to the disk yet. Then it finds the test partitions by their labels: only they may be written.',
    },
    download: {
      title: 'Downloading the system images',
      text: 'Compressed copies of both test partitions are downloaded. This is usually the longest stage: it depends on the network speed.',
    },
    verify: {
      title: 'Checking the checksums',
      text: 'The SHA-256 of each image is compared with the SHA256SUMS file. If even one byte differs, nothing is written.',
    },
    write: {
      title: 'Writing to the disk',
      text: 'The images are written to the test partitions, read back and checked again. Then the firmware is told what to boot next (BootNext).',
    },
    reboot: {
      title: 'Restart into the restored system',
      text: 'The machine restarts into the restored system. Its first heartbeat to the server ends the downtime.',
    },
  },
  back: {
    title: 'Back online',
    text: 'The restored system sent its first heartbeat. The server recorded how long the downtime and each stage took.',
  },
  history: 'Past outages ({0})',
  columns: ['Ended', 'Lasted', 'What happened'],
  kind: {
    full: 'Recovery after a wipe',
    manual: 'Recovery without a wipe',
    failed: 'Recovery stopped',
    cut: 'Cut off at “{0}”',
    reboot: 'Restart',
    pause: 'Heartbeats paused',
  },
  filesTitle: 'Files on the server',
  filesLead: 'Everything the laptop downloads for the recovery, in the order it downloads them. There are no secrets in these files, so they can be public.',
  files: {
    'boot.ipxe': 'A short script for iPXE. iPXE fetches it first, and it starts the recovery environment.',
    'osreboot-recovery.efi': 'The recovery environment: Linux in a single file (UKI). It runs from memory.',
    SHA256SUMS: 'Checksums of the images, to check that they arrived without errors.',
    'osreboot-test.esp.raw.zst': 'Compressed image of the test system’s boot partition (EFI).',
    'osreboot-test.root-x86-64.raw.zst': 'Compressed image of the root partition: the test system itself, Arch Linux.',
  },
  stepTag: 'stage {0}',
  missing: 'not on the server',
  modified: 'Changed {0}',
  downloading: 'Downloading: {0}{1}',
  downloaded: 'Downloaded at {0}{1}',
  took: ' · {0} in {1}',
  broken: 'Broke off at {0}: {1}',
  resumed: ' (resumed from {0})',
  of: '{0} of {1}',
  percent: '{0}%',
  source: 'Source code',
  probe: 'Server access check',
  units: { s: 's', min: 'min', h: 'h', b: 'B', kb: 'KB', mb: 'MB', mbps: 'MB/s' },
};

const TEXTS: Record<Lang, Texts> = { ru: RU, en: EN };
const LANG_KEY = 'osreboot-lang';
const MIB = 1024 * 1024;

let lang = savedLang();
let t = TEXTS[lang];
let snapshot: Snapshot | null = null;
let link: 'connecting' | 'live' | 'lost' = 'connecting';
let clockOffset = 0; // server clock minus the clock of this device
// Sizes from HEAD requests: these do not show up in the server's download list.
const fileInfo = new Map<string, { size: number; modified: number } | 'missing'>();
// The pulse flashes only on a heartbeat it has not shown yet.
const lastShownBeat = new Map<string, number>();
// Open <details> stay open when the page is drawn again.
const openDetails = new Set<string>();

function savedLang(): Lang {
  try {
    return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'ru';
  } catch {
    return 'ru'; // storage is blocked
  }
}

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

// fill('Этап {0} из {1}', 5, 8) -> ['Этап ', '5', ' из ', '8', '']. A value may
// be an element, such as a running timer.
function fill(template: string, ...values: (string | number | Node)[]): (string | Node)[] {
  return template.split(/\{(\d)\}/).map((part, i) => {
    if (i % 2 === 0) return part;
    const value = values[Number(part)] ?? '';
    return typeof value === 'number' ? String(value) : value;
  });
}

function fillText(template: string, ...values: (string | number)[]): string {
  return fill(template, ...values).join('');
}

const pad = (n: number) => String(n).padStart(2, '0');
const locale = () => (lang === 'ru' ? 'ru-RU' : 'en-GB');
const decimal = (x: number) => x.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function duration(ms: number): string {
  const { s, min, h } = t.units;
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${decimal(seconds)} ${s}`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} ${min} ${pad(Math.floor(seconds % 60))} ${s}`;
  return `${Math.floor(m / 60)} ${h} ${pad(m % 60)} ${min}`;
}

// The big downtime counter: 2:05, or 1:02:05 after an hour.
function stopwatch(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(total % 60)}` : `${m}:${pad(total % 60)}`;
}

function clock(ts: number, withDate = false): string {
  const date = new Date(ts);
  const time = date.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return withDate ? `${date.toLocaleDateString(locale(), { day: 'numeric', month: 'short' })}, ${time}` : time;
}

function size(bytes: number): string {
  const { b, kb, mb } = t.units;
  if (bytes < 1024) return `${bytes} ${b}`;
  return bytes < MIB ? `${Math.round(bytes / 1024)} ${kb}` : `${decimal(bytes / MIB)} ${mb}`;
}

// Speed means little for a transfer that took a fraction of a second.
function speed(bytes: number, ms: number): string {
  return ms >= 500 ? ` · ${decimal(bytes / MIB / (ms / 1000))} ${t.units.mbps}` : '';
}

// Time since a server timestamp; tick() keeps it current between updates.
function since(ts: number, format: 'duration' | 'stopwatch' = 'duration'): HTMLElement {
  const node = el('span');
  node.dataset.since = String(ts);
  node.dataset.format = format;
  return node;
}

function tick(): void {
  const now = Date.now() + clockOffset;
  for (const node of document.querySelectorAll<HTMLElement>('[data-since]')) {
    const ms = now - Number(node.dataset.since);
    node.textContent = node.dataset.format === 'stopwatch' ? stopwatch(ms) : duration(ms);
  }
  // Notes such as "slower than usual" appear once the server clock passes data-after.
  for (const node of document.querySelectorAll<HTMLElement>('[data-after]')) {
    node.hidden = now < Number(node.dataset.after);
  }
}

const stepIndex = (id: StepId) => STEPS.findIndex((step) => step.id === id);

// The stages of one recovery attempt, worked out from the stage reports and,
// for the network boot, from the downloads the server has seen.
interface Progress {
  starts: (number | null)[]; // when each stage began, by the server clock; null if unknown
  reports: (Stage | null)[]; // the latest report of each stage
  first: number; // the first stage of this attempt, -1 before any
  current: number; // the stage reached so far, -1 before any
  latest: Stage | null; // the latest report of any name
  // reason: what the "failed" report says; null if the UKI download broke off.
  failure: { at: number; reason: string | null } | null;
  bootScript: Transfer | null;
  uki: Transfer | null;
}

function emptyProgress(): Progress {
  return {
    starts: STEPS.map(() => null),
    reports: STEPS.map(() => null),
    first: -1,
    current: -1,
    latest: null,
    failure: null,
    bootScript: null,
    uki: null,
  };
}

// The first download of `file` that started between `from` and `until`.
function firstBetween(transfers: Transfer[], file: string, from: number, until: number): Transfer | null {
  let found: Transfer | null = null;
  for (const tr of transfers) {
    const inside = tr.start >= from && tr.start <= until;
    if (tr.file === file && inside && (found === null || tr.start < found.start)) found = tr;
  }
  return found;
}

function progressOf(outage: Outage, transfers: Transfer[]): Progress {
  let p = emptyProgress();
  for (const stage of outage.stages) {
    const id = STAGE_STEP[stage.name];
    if (id !== undefined) {
      const i = stepIndex(id);
      // An earlier stage again means the recovery was started over: show the new attempt.
      if (i < p.current) p = emptyProgress();
      if (p.first === -1) p.first = i;
      // The recovery environment reports only after it has started: its start
      // is the end of the UKI download below, or unknown.
      if (id !== 'start' && p.starts[i] === null) p.starts[i] = stage.at;
      p.reports[i] = stage;
      p.current = Math.max(p.current, i);
    } else if (stage.name === 'failed') {
      p.failure = { at: stage.at, reason: stage.message ?? '' };
    }
    p.latest = stage;
  }

  // Between the reboot and the first report of the recovery environment the
  // machine sends nothing, but the server sees iPXE download its files.
  // Only downloads after this device's "netboot" report count.
  const netboot = p.starts[stepIndex('netboot')];
  if (netboot === null || netboot === undefined) return p;
  const until = outage.end ?? Infinity;
  p.bootScript = firstBetween(transfers, BOOT_SCRIPT, netboot, until);
  const uki = firstBetween(transfers, UKI_FILE, netboot, until);
  if (!uki) return p;
  p.uki = uki;
  const u = stepIndex('uki');
  const s = stepIndex('start');
  p.starts[u] = uki.start;
  p.current = Math.max(p.current, u);
  if (uki.end !== null && uki.ok) {
    // Downloaded: from here on the recovery environment is starting.
    p.starts[s] = uki.end;
    p.current = Math.max(p.current, s);
  } else if (uki.end !== null && p.current === u && !p.failure) {
    p.failure = { at: uki.end, reason: null };
  }
  return p;
}

function stepState(p: Progress, i: number, closed: boolean): StepState {
  if (p.first === -1) return closed ? 'skip' : 'todo';
  if (i < p.first) return 'skip'; // e.g. no wipe: the recovery was started by hand
  if (i < p.current) return 'done';
  if (i === p.current) {
    if (p.failure) return 'failed';
    return closed ? 'done' : 'now';
  }
  return closed ? 'skip' : 'todo';
}

// How long stage i took: up to the start of the next stage, or for the last
// one up to the end of the outage. Null if either end is unknown.
function stepLength(p: Progress, i: number, outageEnd: number | null): number | null {
  const start = p.starts[i] ?? null;
  const end = i + 1 < STEPS.length ? (p.starts[i + 1] ?? null) : outageEnd;
  return start !== null && end !== null ? end - start : null;
}

// The latest outage that ran through to the restart into the restored system.
function lastRecovery(device: Device): Outage | null {
  return device.history.find((outage) => outage.stages.some((stage) => stage.name === 'reboot')) ?? null;
}

function modeOf(device: Device, p: Progress | null): Mode {
  if (device.outage && p) {
    if (p.failure) return 'failed';
    return p.latest ? 'active' : 'offline';
  }
  if (device.outage) return 'offline';
  return device.status === 'online' ? 'online' : 'unknown';
}

const TONE: Record<Mode, string> = { online: 'ok', active: 'active', failed: 'bad', offline: 'warn', unknown: 'idle' };

function bar(fraction: number): HTMLElement {
  const track = el('div', 'bar');
  const value = Math.min(100, Math.max(0, fraction * 100));
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuenow', String(Math.round(value)));
  const fillPart = el('span');
  fillPart.style.width = `${value}%`;
  track.append(fillPart);
  return track;
}

// Toggling a <details> is remembered under `key`.
function remember(box: HTMLDetailsElement, key: string): void {
  box.open = openDetails.has(key);
  box.addEventListener('toggle', () => {
    if (box.open) openDetails.add(key);
    else openDetails.delete(key);
  });
}

// The progress bar and timing of the stage going on now.
function liveDetail(i: number, p: Progress, snap: Snapshot): HTMLElement[] {
  const step = STEPS[i];
  if (!step) return [];
  const parts: HTMLElement[] = [];
  const report = p.reports[i] ?? null;
  if (step.id === 'uki' && p.uki) {
    const { sent, size: total, start } = p.uki;
    parts.push(bar(sent / total), el('p', 'bar-text', fillText(t.of, size(sent), size(total)) + speed(sent, snap.now - start)));
  } else if ((step.id === 'download' || step.id === 'write') && report && report.percent !== null) {
    let text = fillText(t.percent, Math.round(report.percent));
    const image = snap.transfers.find((tr) => tr.end === null && tr.file.endsWith('.raw.zst'));
    if (step.id === 'download' && image) text += speed(image.sent, snap.now - image.start);
    parts.push(bar(report.percent / 100), el('p', 'bar-text', text));
  }
  if (step.id === 'netboot' && p.bootScript) parts.push(el('p', 'sub', t.bootScriptSeen));

  const start = p.starts[i];
  if (start !== null && start !== undefined) {
    const meta = el('p', 'meta');
    meta.append(...fill(t.running, since(start)), ' · ', fillText(t.typical, step.typical));
    const slow = el('span', 'slow', t.slow);
    slow.hidden = true;
    slow.dataset.after = String(start + (2 * step.typical + 10) * 1000);
    meta.append(slow);
    parts.push(meta);
  }
  return parts;
}

// The latest report as the machine sent it, such as "running from memory, kernel 7.2.11".
function logLine(p: Progress): HTMLElement | null {
  const stage = p.latest;
  if (!stage) return null;
  const id = STAGE_STEP[stage.name];
  if (id === undefined) return el('p', 'log', stage.message ? `${stage.name}: ${stage.message}` : stage.name);
  // Only a report about the stage on screen: while iPXE downloads, the latest one is about the reboot.
  return stage.message && stepIndex(id) === p.current ? el('p', 'log', stage.message) : null;
}

function failureBox(failure: { reason: string | null }): HTMLElement {
  const box = el('div', 'problem');
  box.append(el('p', '', failure.reason === null ? t.ukiBroken : t.failedText));
  if (failure.reason) {
    const reason = el('p', 'reason');
    reason.append(el('b', '', `${t.reason}: `), failure.reason);
    box.append(reason);
  }
  return box;
}

function downtimeCounter(start: number): HTMLElement[] {
  const timer = el('p', 'timer');
  timer.append(since(start, 'stopwatch'));
  return [el('p', 'eyebrow', t.downtime), timer];
}

function heroParts(device: Device, mode: Mode, p: Progress | null, snap: Snapshot): HTMLElement[] {
  const outage = device.outage;
  if (outage && p && (mode === 'active' || mode === 'failed')) {
    const parts = downtimeCounter(outage.start);
    const step = STEPS[p.current];
    if (step) {
      parts.push(
        el('p', 'now-label', fillText(p.failure ? t.stoppedAt : t.stageOf, p.current + 1, STEPS.length)),
        el('h3', 'now-title', t.steps[step.id].title),
        el('p', 'now-text', t.steps[step.id].text),
      );
    }
    if (p.failure) {
      parts.push(failureBox(p.failure));
    } else {
      parts.push(...liveDetail(p.current, p, snap));
      const log = logLine(p);
      if (log) parts.push(log);
    }
    const last = lastRecovery(device);
    if (last && last.end !== null) parts.push(el('p', 'note', fillText(t.lastTime, duration(last.end - last.start))));
    return parts;
  }
  if (outage) {
    return [
      ...downtimeCounter(outage.start),
      el('h3', 'now-title', t.offlineTitle),
      el('p', 'now-text', t.offlineText),
      el('p', 'note', fillText(t.lastSignal, clock(outage.start, true))),
    ];
  }
  if (mode === 'online' && device.lastSeen !== null) {
    const line = el('p', 'beat-line');
    const pulse = el('span', 'pulse');
    if (lastShownBeat.get(device.id) !== device.lastSeen) pulse.classList.add('beat');
    lastShownBeat.set(device.id, device.lastSeen);
    line.append(pulse, ...fill(t.heartbeat, since(device.lastSeen)));
    return [el('p', 'headline', t.onlineTitle), line, el('p', 'now-text', t.onlineText)];
  }
  const seen = device.lastSeen === null ? t.neverSeen : fillText(t.lastSignal, clock(device.lastSeen, true));
  return [el('p', 'headline', t.unknownTitle), el('p', 'now-text', seen)];
}

function stepItem(key: string, label: string, state: StepState, text: { title: string; text: string }, time: string | Node): HTMLElement {
  const item = el('li', `step ${state}`);
  if (state === 'now') item.setAttribute('aria-current', 'step');
  const box = el('details');
  remember(box, key);
  // The circle: a number for the stages ahead, a check mark (drawn in CSS) for the passed ones.
  const node = el('span', 'node', state === 'todo' || state === 'skip' ? label : state === 'failed' ? '!' : '');
  // The pulse keeps its rhythm when the list is drawn again.
  if (state === 'now') node.style.setProperty('--phase', `${-(Date.now() % 1600)}ms`);
  const timeBox = el('span', 'step-time');
  timeBox.append(time);
  const summary = el('summary');
  summary.append(node, el('span', 'step-title', text.title), timeBox);
  box.append(summary, el('p', 'step-text', text.text));
  item.append(box);
  return item;
}

function stepsPanel(device: Device, outage: Outage, p: Progress): HTMLElement {
  const panel = el('section', 'steps-panel');
  const head = el('div', 'steps-head');
  const closed = outage.end !== null;
  head.append(el('h3', '', closed ? t.stepsLast : t.stepsNow));
  if (outage.end !== null) {
    head.append(el('span', 'when', `${clock(outage.end, true)} · ${duration(outage.end - outage.start)}`));
  }
  const list = el('ol', 'steps');
  STEPS.forEach((step, i) => {
    const state = stepState(p, i, closed);
    const start = p.starts[i] ?? null;
    let time: string | Node = '';
    if (state === 'now' && start !== null) time = since(start);
    else if (state === 'failed' && start !== null && p.failure) time = duration(p.failure.at - start);
    else if (state === 'done') {
      const length = stepLength(p, i, outage.end);
      if (length !== null) time = duration(length);
    }
    list.append(stepItem(`${device.id}:${step.id}`, String(i + 1), state, t.steps[step.id], time));
  });
  list.append(stepItem(`${device.id}:back`, '', closed ? 'done' : 'todo', t.back, ''));
  panel.append(head, list);
  return panel;
}

// A short description of a past outage for the history table.
function outageKind(outage: Outage): string {
  const names = outage.stages.map((stage) => stage.name);
  if (names.includes('failed')) return t.kind.failed;
  if (names.includes('reboot')) return names.includes('wipe') ? t.kind.full : t.kind.manual;
  const reached = [...names].reverse().map((name) => STAGE_STEP[name]).find((id) => id !== undefined);
  if (reached) return fillText(t.kind.cut, t.steps[reached].title);
  return outage.rebooted ? t.kind.reboot : t.kind.pause;
}

function historyBox(device: Device): HTMLElement {
  const box = el('details', 'history');
  remember(box, `${device.id}:history`);
  box.append(el('summary', '', fillText(t.history, device.history.length)));
  const table = el('table');
  const head = table.createTHead().insertRow();
  for (const title of t.columns) head.append(el('th', '', title));
  const body = table.createTBody();
  for (const outage of device.history) {
    const what = el('td', '', outageKind(outage));
    what.title = outage.stages.map((stage) => stage.name).join(' → '); // the raw stage names, on hover
    body.insertRow().append(
      el('td', '', outage.end === null ? '' : clock(outage.end, true)),
      el('td', 'num', outage.end === null ? '' : duration(outage.end - outage.start)),
      what,
    );
  }
  box.append(table);
  return box;
}

const neverSeen = (device: Device) => device.lastSeen === null && !device.outage && device.history.length === 0;

function deviceCard(device: Device, snap: Snapshot): HTMLElement {
  if (neverSeen(device)) {
    const row = el('article', 'device compact');
    row.append(el('h2', '', device.name), el('span', 'muted', t.neverSeen));
    return row;
  }
  const progress = device.outage ? progressOf(device.outage, snap.transfers) : null;
  const mode = modeOf(device, progress);
  const card = el('article', `device tone-${TONE[mode]}`);
  const head = el('header', 'device-head');
  head.append(el('h2', '', device.name), el('span', 'pill', t.status[mode]));

  const body = el('div', 'device-body');
  const hero = el('section', 'hero');
  hero.append(...heroParts(device, mode, progress, snap));
  body.append(hero);
  // The stages of the recovery under way, or else of the last one.
  const last = lastRecovery(device);
  if (device.outage && progress && mode !== 'offline') body.append(stepsPanel(device, device.outage, progress));
  else if (last) body.append(stepsPanel(device, last, progressOf(last, snap.transfers)));
  else body.classList.add('single');

  card.append(head, body);
  if (device.history.length > 0) card.append(historyBox(device));
  return card;
}

function transferLine(tr: Transfer, now: number): HTMLElement {
  const line = el('div', 'seen');
  const resumed = tr.offset > 0 ? fillText(t.resumed, size(tr.offset)) : '';
  if (tr.end === null) {
    const amount = fillText(t.of, size(tr.sent), size(tr.size));
    line.classList.add('running');
    line.append(bar(tr.sent / tr.size), el('span', '', fillText(t.downloading, amount, resumed) + speed(tr.sent, now - tr.start)));
  } else if (tr.ok) {
    const took = tr.end - tr.start;
    const details = took >= 500 ? fillText(t.took, size(tr.sent), duration(took)) + speed(tr.sent, took) : '';
    line.classList.add('ok');
    line.append(el('span', '', fillText(t.downloaded, clock(tr.end), details + resumed)));
  } else {
    line.classList.add('broken');
    line.append(el('span', '', fillText(t.broken, clock(tr.end), fillText(t.of, size(tr.sent), size(tr.size)))));
  }
  return line;
}

function renderFiles(transfers: Transfer[], now: number): void {
  byId('files').replaceChildren(
    ...FILES.map(({ name, step }) => {
      const item = el('li', 'file');
      const title = el('div', 'file-head');
      title.append(el('span', 'name', name), el('span', 'tag', fillText(t.stepTag, stepIndex(step) + 1)));
      const info = fileInfo.get(name);
      const sizeBox = el('span', 'size');
      if (info === 'missing') {
        sizeBox.textContent = t.missing;
        sizeBox.classList.add('missing');
      } else if (info) {
        sizeBox.textContent = size(info.size);
        if (info.modified) sizeBox.title = fillText(t.modified, clock(info.modified, true));
      }
      item.append(title, sizeBox, el('p', 'desc', t.files[name]));
      // The newest download of this file, if the server still lists it.
      let latest: Transfer | null = null;
      for (const tr of transfers) if (tr.file === name && (latest === null || tr.start > latest.start)) latest = tr;
      if (latest) item.append(transferLine(latest, now));
      return item;
    }),
  );
}

function render(): void {
  renderFiles(snapshot?.transfers ?? [], snapshot?.now ?? 0);
  const snap = snapshot;
  if (!snap) return;
  // Devices that have never sent anything go last, as one line each.
  const devices = [...snap.devices].sort((a, b) => Number(neverSeen(a)) - Number(neverSeen(b)));
  byId('devices').replaceChildren(...devices.map((device) => deviceCard(device, snap)));
  tick();
}

function showLink(): void {
  const node = byId('link');
  node.className = `link ${link}`;
  node.textContent = t[link];
  document.body.classList.toggle('stale', link === 'lost');
}

function applyLang(): void {
  document.documentElement.lang = lang;
  document.title = t.title;
  byId('files-title').textContent = t.filesTitle;
  byId('files-lead').textContent = t.filesLead;
  byId('source-link').textContent = t.source;
  byId('probe-link').textContent = t.probe;
  for (const button of document.querySelectorAll<HTMLElement>('[data-lang]')) {
    button.setAttribute('aria-pressed', String(button.dataset.lang === lang));
  }
  showLink();
}

for (const button of document.querySelectorAll<HTMLElement>('[data-lang]')) {
  button.addEventListener('click', () => {
    lang = button.dataset.lang === 'en' ? 'en' : 'ru';
    t = TEXTS[lang];
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      // storage is blocked: the choice lasts until the page is closed
    }
    applyLang();
    render();
  });
}

// HEAD requests: the sizes without downloading the files.
async function loadFiles(): Promise<void> {
  await Promise.all(
    FILES.map(async ({ name }) => {
      try {
        const res = await fetch(`files/${name}`, { method: 'HEAD', cache: 'no-store' });
        if (!res.ok) {
          fileInfo.set(name, 'missing');
          return;
        }
        const modified = Date.parse(res.headers.get('last-modified') ?? '');
        fileInfo.set(name, { size: Number(res.headers.get('content-length')), modified: Number.isNaN(modified) ? 0 : modified });
      } catch {
        // the server is out of reach: the size stays empty
      }
    }),
  );
  render();
}

byId('files-url').textContent = new URL('files/', location.href).href;
applyLang();
render();
void loadFiles();

// The server sends the whole state on connect and after every change;
// EventSource reconnects by itself when the connection drops.
const events = new EventSource('api/events');
events.addEventListener('state', (event) => {
  snapshot = JSON.parse((event as MessageEvent<string>).data) as Snapshot;
  clockOffset = snapshot.now - Date.now();
  link = 'live';
  showLink();
  render();
});
events.addEventListener('error', () => {
  link = 'lost';
  showLink();
});
// The timers on the page count on between updates.
setInterval(tick, 200);
