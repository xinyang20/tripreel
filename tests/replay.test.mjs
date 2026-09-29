import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, replayFrame, tripPosition } from '../dist/replay.js';
const a = { name: '甲站', coord: [116, 32], departure: '2026-09-21T10:00' },
  b = {
    name: '乙站',
    coord: [116.5, 32],
    arrival: '2026-09-21T10:20',
    departure: '2026-09-21T10:40',
  },
  c = { name: '丙站', coord: [117, 32], arrival: '2026-09-21T11:00' };
const trip = {
  id: 'a',
  mode: 'train',
  number: 'G813',
  departure: a.departure,
  arrival: c.arrival,
  from: a,
  to: c,
  stops: [a, b, c],
  legs: [
    { coordinates: [a.coord, b.coord], km: 50 },
    { coordinates: [b.coord, c.coord], km: 50 },
  ],
};
test('火车行驶、停靠和到达时移动标签始终是车次号', () => {
  for (const fraction of [0, 0.25, 0.5, 0.9, 1])
    assert.equal(tripPosition(trip, fraction).label, 'G813');
  assert.deepEqual(tripPosition(trip, 0.5).coord, b.coord);
});
test('每个播放片段仅提供自己的起终点，首末进度正确落在首末行程', () => {
  const next = {
      ...trip,
      id: 'b',
      number: 'G466',
      from: c,
      to: a,
      stops: [c, a],
      legs: [{ coordinates: [c.coord, a.coord], km: 100 }],
    },
    timeline = buildTimeline([trip, next]);
  assert.equal(timeline.duration, 46);
  assert.equal(replayFrame(timeline, 0).trip.id, 'a');
  assert.equal(replayFrame(timeline, 1).trip.id, 'b');
  assert.deepEqual(
    replayFrame(timeline, 0.1).places.map((p) => p.name),
    [a.name, c.name],
  );
  assert.deepEqual(
    replayFrame(timeline, 0.9).places.map((p) => p.name),
    [c.name, a.name],
  );
  assert.equal(replayFrame(timeline, 0.5).item.type, 'gap');
  assert.equal(replayFrame(buildTimeline([]), 0), null);
});
