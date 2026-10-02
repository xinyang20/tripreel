import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyTrip, prepareReadOnlyTrip } from '../dist/domain.js';
import { prepareJourneyWorldPoints } from '../dist/map-scene.js';
import {
  videoPresentation,
  videoRouteNote,
  videoSnapshot,
  videoBudget,
} from '../dist/video-options.js';

function input() {
  return {
    id: 'video-snapshot',
    mode: 'train',
    number: 'G123',
    travelDate: '2027-01-01',
    departure: '2027-01-01T08:00',
    arrival: '2027-01-01T10:00',
    from: { name: '甲站', coord: [110, 30] },
    to: { name: '乙站', coord: [120, 34] },
    routeCoordinates: [
      [110, 30],
      [115, 31],
      [120, 34],
    ],
    routeTiming: 'continuous',
    distance: 1000,
    routeState: 'ready',
    routeConfirmed: true,
    quality: 'corridor',
    routeProvider: 'osm-local',
    routeSource: 'OpenStreetMap · 合成验收',
    routeDataVersion: 'test',
    routeCandidate: {
      routeCoordinates: [
        [110, 30],
        [116, 31],
        [120, 34],
      ],
    },
    routeHistory: [
      {
        routeCoordinates: [
          [110, 30],
          [114, 31],
          [120, 34],
        ],
      },
    ],
  };
}

test('视频共享可信只读主几何，排除历史/候选几何并保留来源提示', () => {
  const original = prepareReadOnlyTrip(input());
  const [shown] = videoPresentation([original], {
    hideNumbers: true,
    citiesOnly: true,
  });
  assert.equal(shown.routeCoordinates, original.routeCoordinates);
  assert.notEqual(shown.from, original.from);
  assert.equal(shown.from.coord, original.from.coord);
  assert.equal(shown.from.name, '出发城市');
  assert.equal(original.from.name, '甲站');
  assert.equal(shown.number, '火车旅程');
  assert.equal(shown.routeProvider, 'osm-local');
  assert.equal(shown.routeDataVersion, 'test');
  assert.equal('routeHistory' in shown, false);
  assert.deepEqual(shown.routeCandidate, {});
  assert.equal(isReadOnlyTrip(shown), true);
  assert.match(videoRouteNote(shown), /OSM 线路参考.*来源差异详见行程/);
});

test('外部输入和仅浅冻结输入复制主几何，不冻结调用方数据', () => {
  for (const shallowFrozen of [false, true]) {
    const original = input();
    if (shallowFrozen) Object.freeze(original);
    assert.equal(isReadOnlyTrip(original), false);
    const [shown] = videoPresentation([original]);
    assert.notEqual(shown.routeCoordinates, original.routeCoordinates);
    assert.notEqual(shown.from.coord, original.from.coord);
    assert.equal(Object.isFrozen(original.routeCoordinates), false);
    assert.equal(Object.isFrozen(original.from), false);
    original.routeCoordinates[1][0] = 113;
    original.from.name = '修改后的甲站';
    assert.equal(shown.routeCoordinates[1][0], 115);
    assert.equal(shown.from.name, '甲站');
    assert.equal(isReadOnlyTrip(shown), true);
  }
});

test('视频快照不读取历史和候选中的几何', () => {
  const original = input();
  Object.defineProperty(original, 'routeHistory', {
    get() {
      throw new Error('不应读取历史');
    },
  });
  Object.defineProperty(original.routeCandidate, 'routeCoordinates', {
    get() {
      throw new Error('不应读取候选几何');
    },
  });
  assert.equal(videoPresentation([original]).length, 1);
});

test('弹窗快照保留待补全记录用于省略提示，共享只读路线且可重复呈现', () => {
  const original = prepareReadOnlyTrip(input());
  const pending = { ...input(), id: 'pending', routeState: 'pending' };
  const snapshot = videoSnapshot([original, pending]);
  assert.equal(snapshot.length, 2);
  assert.equal(videoBudget(snapshot).omitted, 1);
  assert.equal(snapshot[0].routeCoordinates, original.routeCoordinates);
  assert.equal(
    videoPresentation(snapshot)[0].routeCoordinates,
    original.routeCoordinates,
  );
  assert.equal('routeHistory' in snapshot[0], false);
  assert.equal(Object.isFrozen(pending.from), false);
});

test('同一只读行程连续八次视频准备复用同一主几何和世界点缓存', async () => {
  const original = prepareReadOnlyTrip(input());
  let worldPoints;
  for (let cycle = 0; cycle < 8; cycle++) {
    const [shown] = videoPresentation(videoSnapshot([original]));
    assert.equal(shown.routeCoordinates, original.routeCoordinates);
    const points = await prepareJourneyWorldPoints([shown]);
    if (cycle) assert.equal(points, worldPoints);
    worldPoints = points;
  }
});
