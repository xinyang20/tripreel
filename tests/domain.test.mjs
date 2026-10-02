import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTrip,
  validateRecord,
  canRenderRoute,
  canReplay,
  tripIssues,
  tripSummary,
  prepareReadOnlyTrip,
  routeLabel,
} from '../dist/domain.js';
const base = {
  id: 'a',
  mode: 'train',
  number: 'G1',
  travelDate: '2026-09-26',
  from: { name: '甲', coord: [118, 32] },
  to: { name: '乙', coord: [119, 32] },
  departure: '2026-09-26T08:00',
  arrival: '2026-09-26T10:00',
  routeCoordinates: [
    [118, 32],
    [119, 32],
  ],
  stops: [],
  legs: [],
  quality: 'latest',
};
test('正式待补全记录允许缺时刻和坐标，但不伪造距离或可回放状态', () => {
  const trip = normalizeTrip({
    ...base,
    departure: undefined,
    arrival: undefined,
    from: { name: '甲' },
    to: { name: '乙' },
    routeCoordinates: [],
  });
  validateRecord(trip);
  assert.equal(trip.routeState, 'pending');
  assert.equal(trip.distance, null);
  assert.equal(canRenderRoute(trip), false);
  assert.equal(canReplay(trip), false);
  assert.ok(tripIssues(trip).some((i) => i.code === 'missing-time'));
});
test('兼容旧完整记录；明确pending和未确认示意不进入地图或回放', () => {
  assert.equal(canReplay(base), true);
  assert.equal(canRenderRoute({ ...base, mode: 'flight' }), true);
  assert.equal(
    canRenderRoute(
      normalizeTrip({ ...base, mode: 'flight', routeState: 'pending' }),
    ),
    false,
  );
  const trip = normalizeTrip({
    ...base,
    quality: 'station-schematic',
    requiresConfirmation: true,
  });
  assert.equal(trip.routeState, 'ready');
  assert.equal(trip.routeConfirmed, false);
  assert.equal(canRenderRoute(trip), false);
  assert.ok(trip.issues.some((i) => i.code === 'route-unconfirmed'));
  assert.equal(canReplay({ ...trip, routeConfirmed: true }), true);
  assert.equal(canReplay({ ...base, referenceAccepted: false }), false);
});
test('坏坐标、距离、历史几何和矛盾时刻不会被normalize静默吞掉', () => {
  for (const patch of [
    { distance: -1 },
    { distance: Infinity },
    { distance: '12' },
    { from: { name: '甲', coord: [999, 32] } },
    { arrival: '2026-09-26T07:00' },
    {
      routeCoordinates: [
        [118, 32],
        [999, 32],
      ],
    },
    {
      routeHistory: [
        {
          id: 'bad',
          routeCoordinates: [
            [118, 32],
            [999, 32],
          ],
        },
      ],
    },
  ])
    assert.throws(() => validateRecord({ ...base, ...patch }));
});
test('统一问题保留来源warning、routeNote和参考日，不仅计算缺失字段', () => {
  const issues = tripIssues({
    ...base,
    isReference: true,
    referenceDate: '2026-09-20',
    referenceAccepted: false,
    routeNote: '来源备注',
    warnings: ['停站发生变化'],
    warningDetails: [
      { code: 'SOURCE_CHANGED', message: '线路源变化', scope: 'route' },
    ],
  });
  for (const message of ['来源备注', '停站发生变化', '线路源变化'])
    assert.ok(issues.some((i) => i.message === message));
  assert.ok(issues.some((i) => i.code === 'reference-unconfirmed'));
});
test('不同分组仍需校验时间冲突，缺时刻记录不虚构重叠', () => {
  assert.throws(
    () => validateRecord(base, [{ ...base, id: 'b', groupId: 'other' }]),
    /重叠/,
  );
  assert.doesNotThrow(() =>
    validateRecord({ ...base, arrival: undefined }, [{ ...base, id: 'b' }]),
  );
});
test('只为完整冻结的读取记录缓存派生信息，可编辑输入修改后重新验证', () => {
  const fixed = prepareReadOnlyTrip(normalizeTrip(base));
  assert.equal(tripSummary(fixed), tripSummary(fixed));
  assert.equal(tripIssues(fixed), tripIssues(fixed));
  assert.throws(() => {
    fixed.routeCoordinates[0][0] = 999;
  }, TypeError);
  const editable = structuredClone(fixed);
  assert.equal(canReplay(editable), true);
  editable.routeCoordinates[0][0] = 999;
  assert.equal(canReplay(editable), false);
  assert.equal(tripSummary(editable).renderable, false);
  assert.ok(
    tripIssues(editable).some((issue) => issue.code === 'missing-route'),
  );
});
test('OSM来源和其他需要确认的线路只能在确认后绘制回放，并保留来源元数据', () => {
  const trip = normalizeTrip({
    ...base,
    quality: 'corridor',
    routeProvider: 'osm-local',
    routeSource: 'OpenStreetMap · 合成参考区间',
    routeDataVersion: '2026-10',
    routeEvidence: { kind: 'route-relation' },
    requiresConfirmation: true,
  });
  assert.equal(trip.routeState, 'ready');
  assert.equal(canRenderRoute(trip), false);
  assert.equal(canReplay(trip), false);
  const confirmed = { ...trip, routeConfirmed: true };
  assert.equal(canReplay(confirmed), true);
  assert.equal(routeLabel(confirmed), 'OSM 线路参考');
  assert.ok(
    tripIssues(confirmed).some((issue) => issue.message.includes('OSM')),
  );
  assert.equal(canRenderRoute({ ...base, requiresConfirmation: true }), false);
  assert.doesNotThrow(() =>
    validateRecord({
      ...base,
      routeProvider: undefined,
      routeDataVersion: null,
      routeEvidence: null,
    }),
  );
});
test('查询来源不改变实际几何标签，只有 OSM 区间参考使用 OSM 标签', () => {
  const trip = { ...base, routeProvider: 'osm-local', routeConfirmed: true };
  for (const [quality, routeSource, expected] of [
    ['station-schematic', '12306 停站', '停站连线示意'],
    ['manual-schematic', '用户填写', '手动途经点示意'],
    ['latest', 'RailGo', '最新车次线路'],
    ['corridor', 'RailGo', '同线区间参考'],
    ['corridor', undefined, '同线区间参考'],
    ['latest', 'OpenStreetMap · 合成参考区间', '最新车次线路'],
    ['corridor', 'OpenStreetMap · 合成参考区间', 'OSM 线路参考'],
  ]) {
    const record = { ...trip, quality, routeSource };
    assert.equal(routeLabel(record), expected);
    assert.equal(
      tripIssues(record).some((issue) => issue.message.includes('OSM')),
      expected === 'OSM 线路参考',
    );
  }
});
