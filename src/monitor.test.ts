import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Monitor, type Outage } from './monitor.js';

const devices = [{ id: 'laptop', name: 'Laptop' }];

function laptop(m: Monitor) {
  const d = m.devices[0];
  assert.ok(d);
  return d;
}

test('a device is unknown until its first heartbeat', () => {
  const m = new Monitor(devices, 3000);
  assert.equal(laptop(m).status, 'unknown');
  assert.equal(m.tick(100_000), false);
  m.heartbeat('laptop', 1000, 'a');
  assert.equal(laptop(m).status, 'online');
});

test('missed heartbeats open an outage at the last heartbeat', () => {
  const m = new Monitor(devices, 3000);
  m.heartbeat('laptop', 1000, 'a');
  assert.equal(m.tick(4000), false);
  assert.equal(m.tick(4001), true);
  assert.equal(laptop(m).status, 'offline');
  assert.equal(laptop(m).outage?.start, 1000);
});

test('the next heartbeat closes the outage and measures it', () => {
  const ended: Outage[] = [];
  const m = new Monitor(devices, 3000, { onOutageEnd: (_d, o) => ended.push(o) });
  m.heartbeat('laptop', 1000, 'a');
  m.tick(5000);
  m.heartbeat('laptop', 65_000, 'b');
  assert.equal(ended.length, 1);
  assert.deepEqual(ended[0], { start: 1000, end: 65_000, rebooted: true, stages: [] });
  assert.equal(laptop(m).status, 'online');
  assert.equal(laptop(m).outage, null);
  assert.equal(laptop(m).history[0], ended[0]);
});

test('a network gap without a reboot is not marked as rebooted', () => {
  const m = new Monitor(devices, 3000);
  m.heartbeat('laptop', 1000, 'a');
  m.tick(5000);
  m.heartbeat('laptop', 9000, 'a');
  assert.equal(laptop(m).history[0]?.rebooted, false);
});

test('stage reports switch the device to recovering and update the current stage', () => {
  const m = new Monitor(devices, 3000);
  m.heartbeat('laptop', 1000, 'a');
  m.tick(5000);
  m.progress('laptop', 20_000, { name: 'netboot', percent: null, message: null });
  m.progress('laptop', 30_000, { name: 'download', percent: 10, message: 'image.raw.zst' });
  m.progress('laptop', 40_000, { name: 'download', percent: 60, message: null });
  const d = laptop(m);
  assert.equal(d.status, 'recovering');
  assert.equal(d.outage?.start, 1000);
  assert.deepEqual(d.outage?.stages, [
    { name: 'netboot', at: 20_000, updated: 20_000, percent: null, message: null },
    { name: 'download', at: 30_000, updated: 40_000, percent: 60, message: 'image.raw.zst' },
  ]);
  assert.equal(m.tick(100_000), false);
});

test('a stage reported while online starts the outage at the last heartbeat', () => {
  const m = new Monitor(devices, 3000);
  m.heartbeat('laptop', 1000, 'a');
  m.progress('laptop', 1500, { name: 'wipe', percent: null, message: null });
  assert.equal(laptop(m).status, 'recovering');
  assert.equal(laptop(m).outage?.start, 1000);
});

test('a reboot faster than the timeout is still an outage', () => {
  const m = new Monitor(devices, 3000);
  m.heartbeat('laptop', 1000, 'a');
  m.heartbeat('laptop', 2500, 'b');
  assert.deepEqual(laptop(m).history[0], { start: 1000, end: 2500, rebooted: true, stages: [] });
});

test('restore keeps open outages and makes online devices prove themselves again', () => {
  const m = new Monitor(
    [
      { id: 'laptop', name: 'Laptop' },
      { id: 'vm', name: 'Test VM' },
    ],
    3000,
  );
  const outage = { start: 1000, end: null, rebooted: false, stages: [] };
  m.restore([
    { id: 'laptop', name: 'Old', status: 'recovering', lastSeen: 1000, boot: 'a', outage, history: [] },
    { id: 'vm', name: 'Old', status: 'online', lastSeen: 2000, boot: 'c', outage: null, history: [] },
    { id: 'gone', name: 'Gone', status: 'online', lastSeen: 2000, boot: null, outage: null, history: [] },
  ]);
  const [a, b] = m.devices;
  assert.equal(m.devices.length, 2);
  assert.equal(a?.status, 'recovering');
  assert.equal(a?.name, 'Laptop');
  assert.equal(a?.outage, outage);
  assert.equal(b?.status, 'unknown');
  assert.equal(m.tick(100_000), false);
  m.heartbeat('vm', 100_000, 'c');
  assert.equal(b?.status, 'online');
  assert.equal(b?.history.length, 0);
});
