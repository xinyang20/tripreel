import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, replayFrame } from '../dist/replay.js';
import { vehiclePose, VEHICLE_PIXELS } from '../dist/vehicles.js';
const line = [
  [116, 32],
  [117, 32],
  [118, 31],
];
const trip = (mode) => ({
  id: mode,
  mode,
  number: mode === 'train' ? 'G9003' : 'CA9003',
  departure: '2027-01-01T10:00',
  arrival: '2027-01-01T12:00',
  from: { name: '甲', coord: line[0] },
  to: { name: '丙', coord: line[2] },
  routeCoordinates: line,
  routeTiming: 'continuous',
  routeState: 'ready',
  routeConfirmed: true,
  quality: mode === 'train' ? 'latest' : 'schematic',
  distance: 250,
  stops: [],
  legs: [],
  routeRevision: 1,
});
const frameAt = (t, progress) => replayFrame(buildTimeline([t]), progress);
test('列车由六节车厢组成，沿线路排列并朝前进方向', () => {
  const pose = vehiclePose(frameAt(trip('train'), 0.25), 7);
  assert.equal(pose.kind, 'train');
  assert.equal(pose.parts.length, 6);
  assert.deepEqual(
    pose.parts.map((p) => p.role),
    ['head', 'middle', 'middle', 'middle', 'middle', 'tail'],
  );
  for (const part of pose.parts) assert.ok(Math.abs(part.heading) < 0.05);
  for (let i = 1; i < pose.parts.length; i++)
    assert.ok(pose.parts[i].offset[0] < pose.parts[i - 1].offset[0]);
  assert.ok(pose.girth > 1);
});
test('转弯后的车厢跟随线路方向，靠近起点时整列车仍在线路上', () => {
  const late = vehiclePose(frameAt(trip('train'), 0.95), 7);
  assert.ok(late.parts[0].heading > 0.5);
  const start = vehiclePose(frameAt(trip('train'), 0), 7);
  assert.ok(start.parts.every((p) => Math.abs(p.heading) < 0.05));
});
test('放大地图后车厢回到接近真实比例', () => {
  const far = vehiclePose(frameAt(trip('train'), 0.25), 5),
    near = vehiclePose(frameAt(trip('train'), 0.25), 18);
  assert.ok(near.scale < far.scale);
  assert.equal(near.girth, 1);
  assert.ok(VEHICLE_PIXELS.car > 0);
});
test('飞机爬升时抬头、下降时低头，影子位于下方地面', () => {
  const climb = vehiclePose(frameAt(trip('flight'), 0.2), 6),
    descend = vehiclePose(frameAt(trip('flight'), 0.8), 6);
  assert.equal(climb.kind, 'flight');
  assert.ok(climb.parts[0].pitch > 0);
  assert.ok(descend.parts[0].pitch < 0);
  assert.ok(climb.shadow < 0);
});
test('换乘停留和总览时不显示载具', () => {
  const timeline = buildTimeline([
    trip('train'),
    {
      ...trip('flight'),
      departure: '2027-01-01T13:00',
      arrival: '2027-01-01T15:00',
    },
  ]);
  assert.equal(replayFrame(timeline, 0.5).item.type, 'gap');
  assert.equal(vehiclePose(replayFrame(timeline, 0.5), 7), null);
  assert.equal(vehiclePose(null, 7), null);
});
