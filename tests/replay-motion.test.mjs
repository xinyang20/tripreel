import test from 'node:test';
import assert from 'node:assert/strict';
import { lineIndex } from '../dist/core.js';
import { easeTravel, tripPosition } from '../dist/replay.js';
const line = [
  [116, 32],
  [116.5, 32],
  [117, 32],
];
const station = (name, coord, times = {}) => ({
  name,
  coord,
  routeCoord: coord,
  routeMatched: true,
  ...times,
});
const train = (stops) => ({
  id: 'motion',
  mode: 'train',
  number: 'G9002',
  departure: '2027-01-01T10:00',
  arrival: '2027-01-01T11:00',
  from: { name: '甲', coord: line[0] },
  to: { name: '丙', coord: line[2] },
  routeCoordinates: line,
  routeTiming: 'continuous',
  stops,
  legs: [],
  routeRevision: 1,
});
const at = (trip, minutes) => tripPosition(trip, minutes / 60);
test('加减速曲线单调、对称且端点准确', () => {
  let previous = -1;
  for (let i = 0; i <= 100; i++) {
    const value = easeTravel(i / 100);
    assert.ok(value >= previous);
    previous = value;
  }
  assert.equal(easeTravel(0), 0);
  assert.equal(easeTravel(0.5), 0.5);
  assert.equal(easeTravel(1), 1);
  assert.ok(easeTravel(0.1) < 0.1);
  assert.ok(Math.abs(easeTravel(0.3) + easeTravel(0.7) - 1) < 1e-12);
});
test('连续线路在有时刻的经停站停留，进出站减速和加速', () => {
  const trip = train([
    station('甲', line[0], { departure: '2027-01-01T10:00' }),
    station('乙', line[1], {
      arrival: '2027-01-01T10:25',
      departure: '2027-01-01T10:35',
    }),
    station('丙', line[2], { arrival: '2027-01-01T11:00' }),
  ]);
  const half = lineIndex(line).length / 2;
  for (const minutes of [25, 30, 35]) {
    const position = at(trip, minutes);
    assert.ok(Math.abs(position.track.along - half) < 1e-9);
    assert.ok(Math.abs(position.coord[0] - 116.5) < 1e-9);
  }
  assert.ok(at(trip, 2.5).track.along < half * 0.1);
  assert.ok(at(trip, 22.5).track.along > half * 0.9);
  assert.ok(at(trip, 40).track.along > half);
  assert.equal(at(trip, 60).track.along, lineIndex(line).length);
});
test('未匹配、缺时刻或时序错乱的经停站不产生停留', () => {
  const plain = at(train([]), 30).track.along;
  for (const stop of [
    station('乙', line[1], {
      arrival: '2027-01-01T10:25',
      departure: '2027-01-01T10:35',
      routeMatched: false,
    }),
    station('乙', line[1]),
    station('乙', line[1], {
      arrival: '2027-01-01T10:40',
      departure: '2027-01-01T10:30',
    }),
    station('乙', [120, 40], {
      arrival: '2027-01-01T10:25',
      departure: '2027-01-01T10:35',
    }),
  ])
    assert.equal(at(train([stop]), 30).track.along, plain);
});
test('飞机起飞加速、降落减速，弧线位置与时刻保持对应', () => {
  const flight = { ...train([]), mode: 'flight', number: 'CA9002' },
    early = tripPosition(flight, 0.05),
    late = tripPosition(flight, 0.95);
  assert.ok(early.arc.fraction < 0.05);
  assert.ok(late.arc.fraction > 0.95);
  assert.equal(
    late.stamp - early.stamp,
    0.9 *
      (Date.parse('2027-01-01T11:00+08:00') -
        Date.parse('2027-01-01T10:00+08:00')),
  );
});
