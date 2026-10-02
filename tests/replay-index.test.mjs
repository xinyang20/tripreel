import test from 'node:test';
import assert from 'node:assert/strict';
import { along, lineIndex, alongIndex } from '../dist/core.js';
import { buildTimeline, tripPosition, replayFrame } from '../dist/replay.js';
const route = [
  [118, 32],
  [118, 32],
  [119, 34],
  [118.5, 31.5],
  [120, 33],
  [120, 33],
];
const trip = {
  id: 'one',
  mode: 'train',
  number: 'G9001',
  travelDate: '2027-01-01',
  departure: '2027-01-01T23:00',
  arrival: '2027-01-02T01:00',
  from: { name: '合成甲', coord: route[0] },
  to: { name: '合成乙', coord: route.at(-1) },
  routeCoordinates: route,
  routeTiming: 'continuous',
  stops: [],
  legs: [],
  routeRevision: 1,
};
test('距离索引与完整路线的距离插值一致，包括重复点、折返、反向和零长度', () => {
  for (const coordinates of [
    [],
    [[118, 32]],
    route,
    [...route].reverse(),
    Array.from({ length: 5 }, () => [118, 32]),
  ]) {
    const index = lineIndex(coordinates);
    for (const fraction of [-1, 0, 0.001, 0.2, 0.5, 0.8, 0.999, 1, 2])
      assert.deepEqual(
        alongIndex(index, fraction),
        along(coordinates, fraction),
      );
  }
});
test('修改时间复用路线，替换几何和递增路线版本都不会读到旧位置', () => {
  const local = structuredClone(trip),
    first = tripPosition(local, 0.5);
  local.departure = '2027-01-02T00:00';
  local.arrival = '2027-01-02T02:00';
  const timed = tripPosition(local, 0.5);
  assert.deepEqual(timed.coord, first.coord);
  assert.equal(timed.stamp - first.stamp, 3600000);
  local.routeCoordinates = [
    [118, 32],
    [118.1, 32.1],
    [120, 33],
  ];
  assert.deepEqual(
    tripPosition(local, 0.5).coord,
    along(local.routeCoordinates, 0.5),
  );
  local.routeCoordinates[1] = [116, 35];
  local.routeRevision++;
  assert.deepEqual(
    tripPosition(local, 0.5).coord,
    along(local.routeCoordinates, 0.5),
  );
});
test('二分时间线保持片段边界、停留和首尾选择规则', () => {
  const timeline = buildTimeline(
    Array.from({ length: 500 }, (_, i) => ({ ...trip, id: String(i) })),
  );
  for (const elapsed of [
    0,
    22,
    22.0001,
    24,
    24.0001,
    11974,
    timeline.duration,
  ]) {
    const expected =
        timeline.items.find((item) => elapsed <= item.to) ||
        timeline.items.at(-1),
      actual = replayFrame(timeline, elapsed / timeline.duration);
    assert.strictEqual(actual.item, expected);
  }
});
test('飞机重用预计算弧线后，端点和弧顶依旧一致', () => {
  const flight = { ...trip, mode: 'flight', number: 'CA9001' };
  const first = tripPosition(flight, 0),
    middle = tripPosition(flight, 0.5),
    last = tripPosition(flight, 1);
  assert.ok(
    Math.hypot(
      first.coord[0] - flight.from.coord[0],
      first.coord[1] - flight.from.coord[1],
    ) < 1e-10,
  );
  assert.ok(middle.altitude > 0);
  assert.ok(
    Math.hypot(
      last.coord[0] - flight.to.coord[0],
      last.coord[1] - flight.to.coord[1],
    ) < 1e-10,
  );
});
