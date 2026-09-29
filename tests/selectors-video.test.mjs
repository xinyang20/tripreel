import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTrips, scopeSummary, selectedScope } from '../dist/selectors.js';
import {
  videoBudget,
  recommendedSpeed,
  videoPresentation,
  videoRouteNote,
  videoFilename,
} from '../dist/video-options.js';
import { buildTimeline } from '../dist/replay.js';
const trip = {
  id: 'a',
  mode: 'flight',
  number: 'CA1001',
  travelDate: '2027-01-01',
  departure: '2027-01-01T08:00',
  arrival: '2027-01-01T10:00',
  from: { name: '北京首都', code: 'PEK', coord: [116.6, 40.08] },
  to: { name: '厦门高崎', code: 'XMN', coord: [118.12, 24.54] },
  quality: 'schematic',
  distance: 1700,
  routeState: 'ready',
  routeConfirmed: true,
  stops: [],
  legs: [],
  groupId: 'g1',
};
const pending = {
  ...trip,
  id: 'b',
  number: 'G1001',
  mode: 'train',
  groupId: null,
  travelDate: '2027-02-02',
  departure: null,
  arrival: null,
  routeState: 'pending',
  distance: null,
};
test('筛选按交集生效，待补全可被日期搜索且未知距离不记为零', () => {
  assert.deepEqual(
    filterTrips([trip, pending], {
      group: 'g1',
      year: '2027',
      mode: 'flight',
      search: '首都',
    }).map((t) => t.id),
    ['a'],
  );
  assert.deepEqual(
    filterTrips([trip, pending], {
      group: 'ungrouped',
      from: '2027-02-01',
    }).map((t) => t.id),
    ['b'],
  );
  assert.equal(scopeSummary([trip, pending]).distance.unknown, 1);
  assert.equal(scopeSummary([trip, pending]).playable, 1);
  assert.equal(buildTimeline([pending]).duration, 0);
  assert.deepEqual(
    selectedScope([trip, pending], new Set(['b', 'invisible'])),
    [pending],
  );
});
test('视频预算跟随范围和速度，超限不可启动，建议倍速满足两分钟', () => {
  const trips = Array.from({ length: 100 }, (_, i) => ({
    ...trip,
    id: String(i),
  }));
  assert.equal(videoBudget(trips, 1080, 1).allowed, false);
  assert.equal(videoBudget(trips, 1080, 32).allowed, true);
  assert.ok(videoBudget(trips, 1080, recommendedSpeed(trips)).seconds <= 120);
  assert.equal(videoBudget([trip, pending]).omitted, 1);
  assert.equal(videoBudget([pending]).allowed, false);
});
test('视频呈现不修改原始记录，隐藏编号和地名覆盖片头及片段输入', () => {
  const options = {
    hideNumbers: true,
    citiesOnly: true,
    cityIndex: { airports: { PEK: { city: '北京' }, XMN: { city: '厦门' } } },
  };
  const [shown] = videoPresentation([trip, pending], options);
  assert.equal(shown.from.name, '北京');
  assert.equal(shown.to.name, '厦门');
  assert.equal(shown.number, '飞机旅程');
  assert.equal(trip.number, 'CA1001');
  assert.equal(trip.from.name, '北京首都');
  assert.equal(
    videoFilename([trip], { hideDates: true }, 'mp4'),
    '途映-旅程视频.mp4',
  );
  assert.match(
    videoRouteNote({
      ...trip,
      isReference: true,
      quality: 'station-schematic',
    }),
    /时刻参考/,
  );
  assert.equal(
    videoPresentation([trip], { citiesOnly: true })[0].from.name,
    '出发城市',
  );
});
