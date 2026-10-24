import { readFile } from 'node:fs/promises';

// Sums up outages.csv: a row per recovery with the time between its stages, then
// the min, median and max of each column over the complete runs.
//   node dist/outage-stats.js [data/outages.csv] [device]

export interface Run {
  device: string;
  start: string; // the last heartbeat before the outage, ISO time
  downtime: number; // seconds
  stages: Map<string, number>; // stage name -> seconds since the start
}

export type Column = 'netboot' | 'recovery' | 'download' | 'verify' | 'write' | 'restart' | 'total';

// Each column runs from one stage to another; 'start' and 'end' are the outage's.
// Only a run started by osreboot-wipe has a whole outage.
const COLUMNS: readonly [Column, string, string][] = [
  ['netboot', 'wipe', 'recovery'],
  ['recovery', 'recovery', 'reboot'],
  ['download', 'download', 'verify'],
  ['verify', 'verify', 'write'],
  ['write', 'write', 'bootloader'],
  ['restart', 'reboot', 'end'],
  ['total', 'start', 'end'],
];

// A run is complete when the recovery environment got as far as the reboot.
export function complete(run: Run): boolean {
  return run.stages.has('reboot');
}

function outcome(run: Run): string {
  return complete(run) ? 'ok' : `stopped at ${[...run.stages.keys()].at(-1) ?? 'start'}`;
}

// Reads the lines of outages.csv (see csvLine in store.ts). Outages without the
// recovery environment (network gaps, plain reboots) are left out.
export function parseRuns(csv: string, device?: string): Run[] {
  const runs: Run[] = [];
  for (const line of csv.split('\n').slice(1)) {
    const [id, start, _end, downtime, _rebooted, stages = ''] = line.split(',');
    if (!id || !start || !downtime || (device !== undefined && id !== device)) continue;
    // "download@69.1" is the stage download, 69.1 s after the start. If a stage
    // comes twice, as in a recovery retried within one outage, the first one counts.
    const times = new Map<string, number>();
    for (const item of stages.split(' ')) {
      const at = item.lastIndexOf('@');
      const name = item.slice(0, at);
      if (at > 0 && !times.has(name)) times.set(name, Number(item.slice(at + 1)));
    }
    if (times.has('recovery')) runs.push({ device: id, start, downtime: Number(downtime), stages: times });
  }
  return runs;
}

export function phases(run: Run): Record<Column, number | null> {
  const at = (stage: string): number | undefined => {
    if (stage === 'start') return run.stages.has('wipe') ? 0 : undefined;
    if (stage === 'end') return run.downtime;
    return run.stages.get(stage);
  };
  const result = {} as Record<Column, number | null>;
  for (const [column, from, to] of COLUMNS) {
    const a = at(from);
    const b = at(to);
    result[column] = a === undefined || b === undefined ? null : Math.round((b - a) * 10) / 10;
  }
  return result;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] ?? NaN) : ((sorted[mid - 1] ?? NaN) + (sorted[mid] ?? NaN)) / 2;
}

// Every run gets a row; min, median and max cover only the complete runs,
// because the outage of an incomplete one says nothing about the recovery.
export function table(runs: readonly Run[]): string {
  const columns = COLUMNS.map(([column]) => column);
  const cell = (v: number | null) => (v === null ? '—' : v.toFixed(1));
  const rows = runs.map((run) => {
    const p = phases(run);
    return `| ${run.start.replace('T', ' ').slice(0, 19)}Z | ${run.device} | ${columns.map((c) => cell(p[c])).join(' | ')} | ${outcome(run)} |`;
  });
  const done = runs.filter(complete);
  const summary = (['min', 'median', 'max'] as const).map((stat) => {
    const cells = columns.map((c) => {
      const values = done.map((run) => phases(run)[c]).filter((v): v is number => v !== null);
      if (values.length === 0) return '—';
      const value = stat === 'min' ? Math.min(...values) : stat === 'max' ? Math.max(...values) : median(values);
      return value.toFixed(1);
    });
    return `| ${stat} | | ${cells.join(' | ')} | |`;
  });
  return [
    `| start (UTC) | device | ${columns.join(' | ')} | result |`,
    `|---|---|${columns.map(() => '---:').join('|')}|---|`,
    ...rows,
    ...summary,
    '',
    `${runs.length} runs with the recovery environment, ${done.length} of them complete;`,
    'min, median and max cover the complete ones. Times in seconds.',
  ].join('\n');
}

// Only when run as a command, not when the tests import this file.
if (import.meta.main) {
  const [file = 'data/outages.csv', device] = process.argv.slice(2);
  console.log(table(parseRuns(await readFile(file, 'utf8'), device)));
}
