import assert from 'node:assert/strict';
import { test } from 'node:test';

import { complete, median, parseRuns, phases, table } from './outage-stats.js';

const csv = [
  'device,start,end,downtime_s,rebooted,stages',
  'laptop,2026-10-23T03:25:36.000Z,2026-10-23T03:27:10.700Z,94.7,false,recovery@0.0 partition@0.1 download@0.8 verify@43.3 write@48.1 bootloader@56.2 reboot@56.4',
  'laptop,2026-10-23T11:45:05.000Z,2026-10-23T11:45:10.300Z,5.3,false,',
  'laptop,2026-10-23T15:53:47.000Z,2026-10-23T15:56:32.700Z,165.7,true,wipe@0.3 netboot@0.5 recovery@68.2 partition@68.4 download@69.0 verify@110.7 write@115.5 bootloader@123.8 reboot@124.1',
  '',
].join('\n');

// A wiped run whose download broke off: the outage lasted until someone
// booted the test system again, an hour later.
const cutOff =
  'laptop,2026-10-23T16:10:00.000Z,2026-10-23T17:10:00.000Z,3600.0,true,wipe@0.3 netboot@0.5 recovery@70.0 partition@70.2 download@70.9';

test('parseRuns keeps only outages with the recovery environment', () => {
  const runs = parseRuns(csv);
  assert.equal(runs.length, 2);
  assert.equal(runs[1]?.stages.get('netboot'), 0.5);
  assert.equal(parseRuns(csv, 'vm').length, 0);
});

test('a run is complete only when the recovery environment reached the reboot', () => {
  const runs = parseRuns(csv + cutOff);
  assert.deepEqual(runs.map(complete), [true, true, false]);
  const [, , cut] = runs;
  assert.ok(cut);
  assert.equal(phases(cut).recovery, null);
  assert.equal(phases(cut).total, 3600);
});

test('the summary leaves out incomplete runs but the table still shows them', () => {
  const lines = table(parseRuns(csv + cutOff)).split('\n');
  assert.equal(lines[4], '| 2026-10-23 16:10:00Z | laptop | 69.7 | — | — | — | — | — | 3600.0 | stopped at download |');
  // With the cut-off run the medians of netboot and total would be 68.8 and 1882.9.
  assert.match(lines[6] ?? '', /^\| median \| \| 67\.9 \| .* \| 165\.7 \| \|$/);
  assert.equal(lines.at(-2), '3 runs with the recovery environment, 2 of them complete;');
});

test('phases measure from stage to stage and to the first heartbeat', () => {
  const [fromMain, wiped] = parseRuns(csv);
  assert.ok(fromMain && wiped);
  assert.deepEqual(phases(wiped), {
    netboot: 67.9,
    recovery: 55.9,
    download: 41.7,
    verify: 4.8,
    write: 8.3,
    restart: 41.6,
    total: 165.7,
  });
  // Started from the main system: no wipe, so no network boot and no whole outage.
  assert.equal(phases(fromMain).netboot, null);
  assert.equal(phases(fromMain).total, null);
  assert.equal(phases(fromMain).restart, 38.3);
});

test('median of an even count is the mean of the middle two', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});
