import { readFile } from 'node:fs/promises';

import { complete, parseRuns, type Run } from './outage-stats.js';

// Draws where the downtime of one wiped run went, as an SVG timeline in Russian.
// STATE_JSON is /api/state saved after the run (run-series.sh does it); START is
// the run's start in UTC, e.g. 2026-10-23T15:53, by default the last run.
//   node dist/downtime-figure.js OUTAGES_CSV STATE_JSON [START] [--dark] >figure.svg

export interface Transfer {
  file: string;
  start: number; // ms
  end: number | null;
  size: number;
  ok: boolean | null;
}

export type Kind = 'boot' | 'net' | 'disk' | 'other';

export interface Step {
  label: string;
  kind: Kind;
  from: number; // seconds since the last heartbeat before the outage
  to: number;
}

const KINDS: readonly [Kind, string][] = [
  ['boot', 'Загрузки машины'],
  ['net', 'Скачивание'],
  ['disk', 'Проверка и запись'],
  ['other', 'Прочее'],
];

const MIB = 1024 * 1024;

const num = (v: number, digits = 1) => v.toFixed(digits).replace('.', ',');

export function steps(run: Run, transfers: readonly Transfer[]): Step[] {
  const t0 = Date.parse(run.start);
  const at = (stage: string): number => {
    const value = run.stages.get(stage);
    if (value === undefined) throw new Error(`the run of ${run.start} has no stage ${stage}`);
    return value;
  };
  const sec = (ms: number) => Math.round((ms - t0) / 100) / 10;
  const recovery = at('recovery');
  const download = at('download');
  const verify = at('verify');
  // iPXE fetches boot.ipxe and then the recovery environment before it reports.
  const during = (from: number, to: number) =>
    transfers.filter((t) => t.ok === true && t.end !== null && sec(t.start) >= from && sec(t.start) < to);
  const script = during(0, recovery).find((t) => t.file === 'boot.ipxe');
  const uki = during(0, recovery).find((t) => t.file === 'osreboot-recovery.efi');
  if (!script || !uki?.end) {
    throw new Error(`no transfers of boot.ipxe and the recovery environment in the run of ${run.start} (the server keeps only its last 10)`);
  }
  const images = during(download, verify).filter((t) => t.file.endsWith('.zst'));
  const imageSize = images.reduce((sum, t) => sum + t.size, 0);
  return [
    { label: 'Сброс, прошивка, systemd-boot, iPXE', kind: 'boot', from: 0, to: sec(script.start) },
    { label: `Скачивание UKI, ${num(uki.size / MIB)} MiB`, kind: 'net', from: sec(script.start), to: sec(uki.end) },
    { label: 'Старт среды восстановления в памяти', kind: 'boot', from: sec(uki.end), to: recovery },
    { label: 'Поиск разделов, SHA256SUMS', kind: 'other', from: recovery, to: download },
    { label: `Скачивание образов, ${num(imageSize / MIB)} MiB`, kind: 'net', from: download, to: verify },
    { label: 'Проверка SHA-256', kind: 'disk', from: verify, to: at('write') },
    { label: 'Запись, сверка, e2fsck, resize2fs', kind: 'disk', from: at('write'), to: at('bootloader') },
    { label: 'BootNext, сохранение журнала', kind: 'other', from: at('bootloader'), to: at('reboot') },
    { label: 'Перезагрузка до первого heartbeat', kind: 'boot', from: at('reboot'), to: run.downtime },
  ];
}

const duration = (step: Step) => Math.round((step.to - step.from) * 10) / 10;

// Seconds per kind, in the order of KINDS.
export function totals(list: readonly Step[]): Map<Kind, number> {
  const sums = new Map<Kind, number>(KINDS.map(([kind]) => [kind, 0]));
  for (const step of list) sums.set(step.kind, Math.round(((sums.get(step.kind) ?? 0) + duration(step)) * 10) / 10);
  return sums;
}

// Light and dark are separate steps of the same hues: categorical slots 1–3
// of the dataviz palette, and its muted gray for the small service steps.
const THEMES = {
  light: {
    surface: '#fcfcfb',
    border: 'rgba(11,11,11,0.10)',
    primary: '#0b0b0b',
    secondary: '#52514e',
    muted: '#898781',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    kinds: { boot: '#2a78d6', net: '#eb6834', disk: '#1baf7a', other: '#898781' },
  },
  dark: {
    surface: '#1a1a19',
    border: 'rgba(255,255,255,0.10)',
    primary: '#f0efec',
    secondary: '#c3c2b7',
    muted: '#898781',
    grid: '#2c2c2a',
    axis: '#383835',
    kinds: { boot: '#3987e5', net: '#d95926', disk: '#199e70', other: '#898781' },
  },
} as const;

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function figure(run: Run, list: readonly Step[], dark = false): string {
  const theme = dark ? THEMES.dark : THEMES.light;
  const W = 960;
  const pad = 24;
  const labelWidth = 300;
  const x0 = pad + labelWidth + 16;
  const x1 = W - pad - 56;
  const end = Math.ceil(run.downtime / 30) * 30;
  const x = (s: number) => x0 + ((x1 - x0) * s) / end;
  const rowHeight = 30;
  const barHeight = 14;

  const when = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(run.start));
  const out: string[] = [];
  const text = (tx: number, ty: number, content: string, attrs: string) =>
    out.push(`<text x="${tx}" y="${ty}" ${attrs}>${escape(content)}</text>`);

  text(pad, 40, `Из чего сложились ${num(run.downtime)} с простоя`, `font-size="17" font-weight="600" fill="${theme.primary}"`);
  text(
    pad,
    64,
    `${when.replace(',', '')} МСК: от последнего heartbeat перед затиранием до первого после восстановления`,
    `font-size="13" fill="${theme.secondary}"`,
  );

  // The legend carries the totals, in two columns: under the step labels and
  // under the start of the plot.
  const sums = totals(list);
  KINDS.forEach(([kind, name], i) => {
    const seconds = sums.get(kind) ?? 0;
    const lx = i % 2 ? x0 : pad;
    const ly = 94 + Math.floor(i / 2) * 22;
    out.push(`<rect x="${lx}" y="${ly - 10}" width="12" height="12" rx="3" fill="${theme.kinds[kind]}"/>`);
    text(lx + 20, ly, `${name} · ${num(seconds)} с, ${Math.round((seconds / run.downtime) * 100)} %`, `font-size="13" fill="${theme.primary}"`);
  });

  const top = 94 + Math.ceil(KINDS.length / 2) * 22 + 4;
  const bottom = top + list.length * rowHeight;
  for (let s = 0; s <= end; s += 30) {
    const gx = x(s);
    out.push(`<line x1="${gx}" y1="${top}" x2="${gx}" y2="${bottom}" stroke="${s === 0 ? theme.axis : theme.grid}" stroke-width="1"/>`);
    text(gx, bottom + 18, s === 0 ? '0 с' : String(s), `font-size="12" fill="${theme.muted}" text-anchor="middle"`);
  }
  list.forEach((step, i) => {
    const cy = top + i * rowHeight + rowHeight / 2;
    text(pad, cy + 4.5, step.label, `font-size="13" fill="${theme.secondary}"`);
    const bx = x(step.from);
    const width = Math.max(x(step.to) - bx, 2);
    out.push(
      `<rect x="${bx.toFixed(1)}" y="${cy - barHeight / 2}" width="${width.toFixed(1)}" height="${barHeight}" rx="${Math.min(4, width / 2)}" fill="${theme.kinds[step.kind]}"/>`,
    );
    text(+(bx + width + 6).toFixed(1), cy + 4.5, `${num(duration(step))} с`, `font-size="12.5" fill="${theme.primary}"`);
  });
  text(
    pad,
    bottom + 46,
    'Границы внутри сетевой загрузки взяты из журнала раздачи файлов: запрос boot.ipxe и конец передачи UKI.',
    `font-size="12" fill="${theme.muted}"`,
  );

  const H = bottom + 66;
  const description = list.map((step) => `${step.label}: ${num(step.from)}–${num(step.to)} с (${num(duration(step))} с)`).join('; ');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="title desc">`,
    `<title id="title">Из чего сложились ${num(run.downtime)} с простоя</title>`,
    `<desc id="desc">${escape(description)}</desc>`,
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${theme.surface}" stroke="${theme.border}"/>`,
    `<g font-family="'Adwaita Sans', Inter, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'DejaVu Sans', sans-serif" style="font-variant-numeric: tabular-nums">`,
    ...out,
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}

// Only when run as a command, not when the tests import this file.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const dark = args.includes('--dark');
  const [csvFile, stateFile, start] = args.filter((a) => a !== '--dark');
  if (!csvFile || !stateFile) throw new Error('usage: downtime-figure.js OUTAGES_CSV STATE_JSON [START] [--dark]');
  // A run that started over mixes two attempts on one time line: left out.
  const runs = parseRuns(await readFile(csvFile, 'utf8')).filter(
    (run) => complete(run) && !run.retried && run.stages.has('wipe'),
  );
  const run = start ? runs.find((r) => r.start.startsWith(start)) : runs.at(-1);
  if (!run) throw new Error('no run of osreboot-wipe that went through in one go matches');
  const state = JSON.parse(await readFile(stateFile, 'utf8')) as { transfers?: Transfer[] };
  if (!state.transfers) throw new Error(`${stateFile} has no transfers: give /api/state saved after the run, not the server's state.json`);
  process.stdout.write(figure(run, steps(run, state.transfers), dark));
}
