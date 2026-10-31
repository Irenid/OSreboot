import assert from 'node:assert/strict';
import { test } from 'node:test';

import { csvLine } from './store.js';

test('csvLine writes downtime and stage offsets in seconds', () => {
  const start = Date.UTC(2026, 9, 30, 10, 0, 0);
  const line = csvLine('laptop', {
    start,
    end: start + 222_400,
    rebooted: true,
    stages: [
      { name: 'wipe', at: start + 300, updated: start + 300, percent: null, message: null },
      { name: 'download', at: start + 61_000, updated: start + 90_000, percent: 100, message: null },
    ],
  });
  assert.equal(line, 'laptop,2026-10-30T10:00:00.000Z,2026-10-30T10:03:42.400Z,222.4,true,wipe@0.3 download@61.0\n');
});
