import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTime,
  localDateTime,
  timetableTimes,
  parseBatch,
  validateTrip,
  coordinate,
  flightArc,
  along,
} from '../dist/core.js';
test('北京时间不依赖浏览器或服务器时区', () => {
  assert.equal(
    parseTime('2026-09-21T06:30'),
    Date.parse('2026-09-20T22:30:00Z'),
  );
  assert.equal(
    localDateTime(parseTime('2026-09-21T06:30')),
    '2026-09-21T06:30',
  );
});
test('列车跨午夜到达和跨午夜停靠', () => {
  const rows = timetableTimes(
    [
      { arrive_time: '----', start_time: '23:00' },
      { arrive_time: '23:58', start_time: '00:02' },
      { arrive_time: '01:40', start_time: '----' },
    ],
    '2026-09-21',
  );
  assert.equal(rows[1].arrival, '2026-09-21T23:58');
  assert.equal(rows[1].departure, '2026-09-22T00:02');
  assert.equal(rows[2].arrival, '2026-09-22T01:40');
});
test('非法列车时刻留空且不改变跨日游标，正常占位保留兼容', () => {
  const warnings = [];
  const rows = timetableTimes(
    [
      { arrive_time: '----', start_time: '25:99' },
      { arrive_time: '08:00', start_time: '12:60' },
      { arrive_time: '09:00', start_time: '09:05' },
      { arrive_time: '23:58', start_time: '24:10' },
      { arrive_time: '00:02', start_time: '--:--' },
    ],
    '2026-09-21',
    { onInvalidTime: (item) => warnings.push(item) },
  );
  assert.equal(rows[0].arrival, undefined);
  assert.equal(rows[0].departure, undefined);
  assert.equal(rows[1].arrival, '2026-09-21T08:00');
  assert.equal(rows[1].departure, undefined);
  assert.equal(rows[2].arrival, '2026-09-21T09:00');
  assert.equal(rows[3].departure, undefined);
  assert.equal(rows[4].arrival, '2026-09-22T00:02');
  assert.equal(rows[4].departure, rows[4].arrival);
  assert.deepEqual(warnings, [
    { stopIndex: 0, field: 'departure' },
    { stopIndex: 1, field: 'departure' },
    { stopIndex: 3, field: 'departure' },
  ]);
});
test('非法格式与缺时刻不会复用来源中的派生时刻字段', () => {
  const warnings = [];
  const rows = timetableTimes(
    [
      { arrive_time: 'bad', start_time: '09:00', arrival: 'stale' },
      { arrive_time: 1000, start_time: '9:05', departure: 'stale' },
      { arrive_time: null, start_time: '' },
    ],
    '2026-09-21',
    { onInvalidTime: (item) => warnings.push(item) },
  );
  assert.equal(rows[0].arrival, undefined);
  assert.equal(rows[0].departure, '2026-09-21T09:00');
  assert.equal(rows[1].arrival, undefined);
  assert.equal(rows[1].departure, undefined);
  assert.equal(rows[2].arrival, undefined);
  assert.equal(rows[2].departure, undefined);
  assert.equal(warnings.length, 3);
});
test('批量解析交通类型以及显式跨日', () => {
  const rows = parseBatch(
    '2026-09-21 G2\n2026-09-22 CA1831 PEK XMN 23:10 +1 01:20',
  );
  assert.equal(rows[0].mode, 'train');
  assert.equal(rows[1].mode, 'flight');
  assert.equal(rows[1].arrival, '2026-09-23T01:20');
  assert.throws(() => parseBatch('hello'));
});
const base = {
  id: 'a',
  mode: 'flight',
  number: 'CA1831',
  from: { name: '北京首都', coord: [116.6, 40.1] },
  to: { name: '厦门高崎', coord: [118.1, 24.5] },
  departure: '2026-09-21T06:30',
  arrival: '2026-09-21T09:25',
};
test('阻止倒序、重叠和相同起止地点', () => {
  assert.throws(() => validateTrip({ ...base, arrival: '2026-09-21T05:00' }));
  assert.throws(() => validateTrip({ ...base, id: 'b' }, [base]));
  assert.throws(() => validateTrip({ ...base, to: base.from }));
  assert.doesNotThrow(() =>
    validateTrip(
      {
        ...base,
        departure: '2026-09-21T09:25',
        arrival: '2026-09-21T11:00',
        id: 'b',
      },
      [base],
    ),
  );
});
test('轨迹端点和拱形高度', () => {
  const a = [116.6, 40.1],
    b = [118.1, 24.5],
    c = flightArc(a, b);
  assert.ok(Math.abs(c[0][0] - a[0]) < 1e-9);
  assert.ok(Math.abs(c.at(-1)[1] - b[1]) < 1e-9);
  assert.equal(c[0][2], 0);
  assert.equal(c.at(-1)[2], 0);
  assert.ok(c[50][2] > c[25][2]);
  assert.deepEqual(along([a, b], 1), b);
});
test('拒绝错误坐标与区域外坐标', () => {
  assert.throws(() => coordinate('NaN,30'));
  assert.throws(() => coordinate('39,116'));
  assert.deepEqual(coordinate('116.6,40.1'), [116.6, 40.1]);
});
test('不能将不存在的日期自动滚到下个月', () => {
  assert.ok(Number.isNaN(parseTime('2026-02-31T10:00')));
  assert.ok(Number.isNaN(parseTime('2026-09-21T24:10')));
  assert.throws(() => parseBatch('2026-02-31 G1 北京南 上海虹桥 10:00 12:00'));
});
