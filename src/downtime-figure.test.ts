import assert from 'node:assert/strict';
import { test } from 'node:test';

import { figure, steps, totals, type Transfer } from './downtime-figure.js';
import { parseRuns } from './outage-stats.js';

// Run 4 of README.md: its line of outages.csv and its transfers from
// results/state-2026-10-23.json, a saved /api/state.
const csv = [
  'device,start,end,downtime_s,rebooted,stages',
  'laptop,2026-10-23T15:53:47.335Z,2026-10-23T15:56:33.005Z,165.7,true,wipe@0.3 netboot@0.5 recovery@68.2 partition@68.4 download@69.0 verify@110.7 write@115.5 bootloader@123.8 reboot@124.1',
  '',
].join('\n');
const t0 = Date.parse('2026-10-23T15:53:47.335Z');
const transfer = (file: string, start: number, seconds: number, size: number): Transfer => ({
  file,
  start: t0 + start * 1000,
  end: t0 + (start + seconds) * 1000,
  size,
  ok: true,
});
const transfers = [
  transfer('osreboot-recovery.efi', -300, 15, 138697216), // an earlier run
  transfer('boot.ipxe', 24.4, 0.003, 359),
  transfer('osreboot-recovery.efi', 24.4, 15.268, 138697216),
  transfer('SHA256SUMS', 68.6, 0.001, 184),
  transfer('osreboot-test.esp.raw.zst', 69.1, 6.804, 88790457),
  transfer('osreboot-test.root-x86-64.raw.zst', 79.2, 29.047, 335720446),
];

test('steps split the outage at the stages and at the transfers of the network boot', () => {
  const [run] = parseRuns(csv);
  assert.ok(run);
  const list = steps(run, transfers);
  assert.deepEqual(
    list.map((s) => s.to),
    [24.4, 39.7, 68.2, 69, 110.7, 115.5, 123.8, 124.1, 165.7],
  );
  assert.equal(list[4]?.label, 'Скачивание образов, 404,8 MiB');
  assert.deepEqual([...totals(list)], [
    ['boot', 94.5],
    ['net', 57],
    ['disk', 13.1],
    ['other', 1.1],
  ]);
});

test('a run without the transfers of the network boot cannot be drawn', () => {
  const [run] = parseRuns(csv);
  assert.ok(run);
  assert.throws(() => steps(run, transfers.slice(3)), /no transfers of boot.ipxe/);
});

test('the figure labels every step with its duration', () => {
  const [run] = parseRuns(csv);
  assert.ok(run);
  const svg = figure(run, steps(run, transfers));
  assert.match(svg, /Из чего сложились 165,7 с простоя/);
  assert.match(svg, />41,7 с</);
  assert.match(svg, /Загрузки машины · 94,5 с, 57 %/);
});
