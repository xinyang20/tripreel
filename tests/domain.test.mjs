import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTrip,
  validateRecord,
  canRenderRoute,
  canReplay,
  tripIssues,
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
