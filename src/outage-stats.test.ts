import assert from 'node:assert/strict';
import { test } from 'node:test';

import { median, parseRuns, phases } from './outage-stats.js';

const csv = [
  'device,start,end,downtime_s,rebooted,stages',
  'laptop,2026-10-23T03:25:36.000Z,2026-10-23T03:27:10.700Z,94.7,false,recovery@0.0 partition@0.1 download@0.8 verify@43.3 write@48.1 bootloader@56.2 reboot@56.4',
  'laptop,2026-10-23T11:45:05.000Z,2026-10-23T11:45:10.300Z,5.3,false,',
  'laptop,2026-10-23T15:53:47.000Z,2026-10-23T15:56:32.700Z,165.7,true,wipe@0.3 netboot@0.5 recovery@68.2 partition@68.4 download@69.0 verify@110.7 write@115.5 bootloader@123.8 reboot@124.1',
  '',
].join('\n');

test('parseRuns keeps only outages with the recovery environment', () => {
  const runs = parseRuns(csv);
  assert.equal(runs.length, 2);
  assert.equal(runs[1]?.stages.get('netboot'), 0.5);
  assert.equal(parseRuns(csv, 'vm').length, 0);
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
