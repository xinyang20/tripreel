import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { referenceGeometry, latestJourney } from '../scripts/rail-geometry.mjs';
import {
  sharedCorridorPlan,
  sharedCorridorReference,
  stationCurveReference,
} from '../scripts/rail-fallback.mjs';
const read = async (name) =>
  JSON.parse(
    await readFile(
      new URL(`./fixtures/${name}-railgo.json`, import.meta.url),
      'utf8',
    ),
  );

test('G813 空线路可由已核对京沪区间生成连续轨迹，但不能延伸到南京南以南', async () => {
  const plan = sharedCorridorPlan('G813', '天津南', '南京南');
  const reference = sharedCorridorReference(
    plan,
    await read('g813'),
    referenceGeometry(await read('g1')),
    await read('g813-main'),
  );
  const result = latestJourney(reference, reference.stations, null);
  assert.ok(result.distance > 900 && result.distance < 905);
  assert.ok(result.routeCoordinates.length > 580);
  assert.ok(result.stops.every((s) => s.routeMatched));
  assert.ok(result.legs.every((s) => s.coordinates.length > 2));
  assert.equal(reference.provenance.quality, 'corridor');
  assert.match(reference.provenance.routeNote, /共线区间参考/);
  assert.equal(sharedCorridorPlan('G813', '天津南', '福州'), null);
  assert.equal(sharedCorridorPlan('G813', '南京南', '天津南'), null);
  assert.equal(sharedCorridorPlan('G466', '西安北', '南京南'), null);
});
test('共线回退必须核对最新停站与每个途经站，变化后不能盲目套线', async () => {
  const plan = sharedCorridorPlan('G813', '天津南', '南京南'),
    target = await read('g813'),
    donor = referenceGeometry(await read('g1')),
    main = await read('g813-main');
  const changed = structuredClone(main);
  changed.data.timetable.find((s) => s.station === '济南西').station = '济南';
  assert.throws(
    () => sharedCorridorReference(plan, target, donor, changed),
    /最新停站已变化/,
  );
  const shifted = structuredClone(target);
  shifted.data.stations.find((s) => s.徐州东).徐州东 = [110, 35];
  assert.throws(
    () => sharedCorridorReference(plan, shifted, donor, main),
    /轨道或站点发生变化/,
  );
});

test('G466 按最新停站画连续示意曲线，经过合肥且明确不是实际铁轨', async () => {
  const reference = stationCurveReference(await read('g466'));
  const a = reference.stations.findIndex((s) => s.name === '西安北'),
    b = reference.stations.findIndex((s) => s.name === '南京南');
  const stops = reference.stations.slice(a, b + 1),
    result = latestJourney(reference, stops, null);
  assert.deepEqual(
    stops.map((s) => s.name),
    [
      '西安北',
      '华山北',
      '洛阳龙门',
      '郑州东',
      '商丘',
      '亳州南',
      '阜阳西',
      '合肥',
      '南京南',
    ],
  );
  assert.ok(result.routeCoordinates.length > 200);
  assert.ok(result.legs.every((l) => l.coordinates?.length >= 12));
  assert.ok(result.stops.every((s) => s.routeMatched));
  assert.equal(reference.provenance.quality, 'station-schematic');
  assert.match(
    reference.provenance.routeNote,
    /停站连线示意.*尚无真实轨道数据/,
  );
  for (const s of stops)
    assert.ok(
      result.routeCoordinates.some(
        (p) =>
          Math.abs(p[0] - s.coord[0]) < 1e-8 &&
          Math.abs(p[1] - s.coord[1]) < 1e-8,
      ),
    );
});

test('通用示意直接采用 WGS84 坐标，循环站名按站次选择，缺坐标不丢站', async () => {
  const { stationSchematicJourney, selectStopInterval } =
    await import('../scripts/rail-fallback.mjs');
  const stops = [
    { name: '甲', coord: [110, 30] },
    { name: '乙', coord: [111, 31] },
    { name: '甲', coord: [110, 30] },
    { name: '丙', coord: [112, 32] },
  ];
  assert.throws(() => selectStopInterval(stops, '甲', '丙'), {
    code: 'STOP_AMBIGUOUS',
  });
  const selected = selectStopInterval(stops, '甲', '丙', {
    fromStopIndex: 2,
    toStopIndex: 3,
  });
  const journey = stationSchematicJourney(selected.stops, {
    routeSource: '12306 · 今日参考',
  });
  assert.deepEqual(journey.routeCoordinates[0], [110, 30]);
  assert.deepEqual(journey.routeCoordinates.at(-1), [112, 32]);
  assert.equal(journey.requiresConfirmation, true);
  assert.equal(journey.resolution.state, 'needs-confirmation');
  assert.throws(
    () =>
      stationSchematicJourney([
        stops[0],
        { name: '乙', coord: null },
        stops[3],
      ]),
    /乙.*缺少/,
  );
  assert.throws(
    () => stationSchematicJourney([stops[0], { name: '乙', coord: [999, 31] }]),
    /WGS84/,
  );
  assert.throws(() => selectStopInterval(stops, '丙', '乙'), {
    code: 'STOP_MISMATCH',
  });
});

test('同名折返站的真实线路按指定 referenceStopIndex 截取', () => {
  const coordinates = [
    [110, 30],
    [111, 31],
    [110, 30],
    [112, 32],
  ];
  const stations = coordinates.map((coord, i) => ({
    name: ['甲', '乙', '甲', '丙'][i],
    coord,
  }));
  const selected = stations
    .slice(2)
    .map((stop, i) => ({ ...stop, referenceStopIndex: i + 2 }));
  const route = latestJourney(
    { stations, coordinates, gaps: [] },
    selected,
    null,
  );
  assert.deepEqual(route.routeCoordinates, [
    [110, 30],
    [112, 32],
  ]);
  assert.ok(route.stops.every((stop) => stop.routeMatched));
});
