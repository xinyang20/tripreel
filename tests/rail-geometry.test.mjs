import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertBoardingStops,
  referenceLeg,
  latestJourney,
  referenceGeometry,
} from '../scripts/rail-geometry.mjs';
import { readFile } from 'node:fs/promises';

test('沿线经过的站不能被当作该车次停靠站', () => {
  const schedule = {
    number: 'G1',
    stops: ['北京南', '南京南', '上海虹桥'].map((name) => ({ name })),
  };
  assert.throws(
    () => assertBoardingStops(schedule, '济南西', '上海虹桥'),
    /不停靠/,
  );
  assert.throws(
    () => assertBoardingStops(schedule, '上海虹桥', '南京南'),
    /方向/,
  );
  assert.doesNotThrow(() =>
    assertBoardingStops(schedule, '南京南', '上海虹桥'),
  );
});
const route = {
  coordinates: [
    [116, 32],
    [116.1, 32],
    [116.2, 32],
    [116.3, 32],
  ],
  stations: [
    { name: '甲', coord: [116, 32] },
    { name: '乙', coord: [116.15, 32] },
    { name: '丙', coord: [116.3, 32] },
  ],
};
test('上游只返回停靠站时准确提示缺少轨道坐标', () => {
  assert.throws(
    () =>
      referenceGeometry({
        success: true,
        data: { stations: [{ 甲: [116, 32] }, { 乙: [116.1, 32] }], train: {} },
      }),
    /仅返回停靠站.*轨道坐标/,
  );
});
test('停站表和时刻不符仍保留最新整条线路', () => {
  const schedule = {
    stops: [
      { name: '甲', departure: '2026-09-21T10:00' },
      { name: '丙', arrival: '2026-09-21T10:01' },
    ],
  };
  const result = latestJourney(route, route.stations, schedule);
  assert.equal(result.stopsMatched, false);
  assert.equal(result.quality, 'latest');
  assert.ok(result.routeCoordinates.length > 2);
  assert.ok(result.legs.every((l) => l.coordinates?.length > 1));
  assert.ok(result.warnings.length);
});
test('参考行程无指定日期时刻也沿完整最新曲线行进', () => {
  const result = latestJourney(route, route.stations, null);
  assert.equal(result.quality, 'latest');
  assert.equal(result.routeTiming, 'stops');
  assert.ok(result.routeCoordinates.length > 2);
});
test('个别途经站偏离或缺少坐标不能打断主线路', () => {
  const result = latestJourney(
    route,
    [
      route.stations[0],
      { name: '偏离站', coord: [116.1, 32.04] },
      { name: '未定位站', coord: null },
      route.stations[2],
    ],
    null,
  );
  assert.ok(result.routeCoordinates.length > 2);
  assert.equal(result.routeTiming, 'continuous');
  assert.equal(result.stops[1].routeMatched, false);
  assert.equal(result.stops[2].routeMatched, false);
  assert.equal(result.quality, 'latest');
});
test('采信车次专用曲线的实际绕行，不按直线距离删线', () => {
  const winding = [
    [116, 32],
    [116, 33],
    [117, 33],
    [117, 32],
    [116.1, 32],
  ];
  const result = referenceLeg(winding[0], winding.at(-1), winding);
  assert.ok(result.km > 300);
  assert.deepEqual(result.coordinates, winding);
});
test('折返线路按停站顺序定位，不能截到第一次经过的同一坐标', () => {
  const a = { name: '甲', coord: [116, 32] },
    b = { name: '乙', coord: [116.1, 32] },
    c = { name: '丙', coord: [116.2, 32] },
    d = { name: '丁', coord: [116.1, 32.1] };
  const reference = {
    stations: [a, c, b, d],
    coordinates: [a.coord, b.coord, c.coord, b.coord, d.coord],
  };
  const result = latestJourney(reference, [a, c, b], null);
  assert.deepEqual(result.routeCoordinates, [
    a.coord,
    b.coord,
    c.coord,
    b.coord,
  ]);
  assert.ok(result.distance > 28);
  assert.equal(result.routeTiming, 'stops');
  assert.deepEqual(result.legs[1].coordinates, [c.coord, b.coord]);
});
test('中途乘坐只截取所在区间，拒绝逆向和偏离线路的站点', () => {
  const line = [
    [116, 32],
    [116.1, 32],
    [116.2, 32],
    [116.3, 32],
  ];
  const leg = referenceLeg([116.05, 32], [116.25, 32], line);
  assert.ok(Math.abs(leg.coordinates[0][0] - 116.05) < 1e-9);
  assert.ok(Math.abs(leg.coordinates.at(-1)[0] - 116.25) < 1e-9);
  assert.ok(leg.coordinates.every((p) => p[0] >= 116.05 && p[0] <= 116.25));
  assert.throws(() => referenceLeg([116.25, 32], [116.05, 32], line));
  assert.throws(() => referenceLeg([116, 33], [116.25, 32], line));
});
test('G1802 西安北之后的接缝不能影响南京南至西安北', async () => {
  const data = JSON.parse(
    await readFile(
      new URL('./fixtures/g1802-railgo.json', import.meta.url),
      'utf8',
    ),
  );
  const reference = referenceGeometry(data);
  const first = reference.stations.findIndex((s) => s.name === '南京南'),
    last = reference.stations.findIndex((s) => s.name === '西安北');
  const result = latestJourney(
    reference,
    reference.stations.slice(first, last + 1),
    null,
  );
  assert.equal(reference.gaps.length, 1);
  assert.ok(reference.gaps[0].km > 0.25);
  assert.equal(result.routeCoordinates.length, 663);
  assert.ok(result.distance > 1160 && result.distance < 1180);
  assert.equal(result.legs.length, 12);
  assert.ok(result.legs.every((l) => l.coordinates?.length > 1));
  assert.deepEqual(result.warnings, []);
});
test('缺口外的两侧区间可用，经过缺口才报错，全线反向仍保持正确', () => {
  const stations = [
    { 甲: [116, 32] },
    { 乙: [116.1, 32] },
    { 丙: [116.2, 32] },
    { 丁: [116.3, 32] },
  ];
  const train = {
    one: {
      index: 1,
      line: [
        [116, 32],
        [116.1, 32],
      ],
    },
    two: {
      index: 2,
      line: [
        [116.2, 32],
        [116.3, 32],
      ],
    },
  };
  for (const reversed of [false, true]) {
    const reference = referenceGeometry({
      success: true,
      data: { stations: reversed ? [...stations].reverse() : stations, train },
    });
    assert.equal(reference.gaps[0].start, 1);
    assert.equal(reference.gaps[0].end, 2);
    assert.doesNotThrow(() =>
      latestJourney(reference, reference.stations.slice(0, 2), null),
    );
    assert.doesNotThrow(() =>
      latestJourney(reference, reference.stations.slice(2, 4), null),
    );
    assert.throws(
      () => latestJourney(reference, reference.stations, null),
      /乘坐区间内.*缺口/,
    );
  }
});
