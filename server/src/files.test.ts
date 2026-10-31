import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRange } from './files.js';

test('parseRange handles the forms curl, iPXE and browsers send', () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 });
});

test('parseRange rejects ranges past the end of the file', () => {
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
});

test('parseRange ignores headers it does not support', () => {
  assert.equal(parseRange('bytes=5-3', 1000), null);
  assert.equal(parseRange('bytes=0-1,5-6', 1000), null);
  assert.equal(parseRange('bytes=-', 1000), null);
  assert.equal(parseRange('items=0-1', 1000), null);
});
