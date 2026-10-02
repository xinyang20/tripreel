import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareVideoShots,
  videoShotKey,
  videoAttribution,
} from '../dist/video-layout.js';
const trips = [{ id: 'one' }, { id: 'two' }, { id: 'three' }],
  timeline = {
    items: [
      { type: 'trip', trip: trips[0] },
      { type: 'gap', trip: trips[0], next: trips[1] },
      { type: 'trip', trip: trips[1] },
      { type: 'gap', trip: trips[1], next: trips[2] },
      { type: 'trip', trip: trips[2] },
    ],
  };
test('视频准备包含总览、单段与相邻停留，不执行镜头切换', async () => {
  const computed = [];
  let yields = 0,
    time = 0;
  const cameras = await prepareVideoShots(
    trips,
    timeline,
    (scope) => {
      computed.push(scope);
      time += 5;
      return { center: [118, 32] };
    },
    {
      now: () => time,
      yieldControl: async () => {
        yields++;
      },
    },
  );
  assert.equal(cameras.size, 6);
  assert.equal(computed.length, 6);
  assert.equal(yields, 3);
  assert.ok(cameras.has(videoShotKey([trips[0], trips[1]])));
  assert.ok(cameras.has(videoShotKey([trips[1], trips[2]])));
});
test('取消视频准备后不计算剩余镜头，已取消输入不启动计算', async () => {
  const controller = new AbortController();
  let count = 0;
  await assert.rejects(
    prepareVideoShots(
      trips,
      timeline,
      () => {
        count++;
        return {};
      },
      {
        signal: controller.signal,
        budgetMs: 0,
        yieldControl: async () => controller.abort(),
      },
    ),
    { name: 'AbortError' },
  );
  assert.equal(count, 1);
  await assert.rejects(
    prepareVideoShots(
      trips,
      timeline,
      () => {
        count++;
      },
      { signal: controller.signal },
    ),
    { name: 'AbortError' },
  );
  assert.equal(count, 1);
});

test('视频只为实际线路来源署名，保留底图归属和OSM许可地址', () => {
  const base = videoAttribution([
    { mode: 'flight' },
    {
      routeProvider: 'railgo',
      routeSource: '手动途经地点',
      quality: 'manual-schematic',
    },
    {
      routeProvider: 'osm-local',
      routeSource: '12306 · 最新停靠站',
      quality: 'station-schematic',
    },
  ]);
  assert.equal(base.length, 1);
  assert.ok(!base.join(' ').includes('RailGo'));
  const mixed = videoAttribution([
    { routeProvider: 'osm-local', routeSource: 'OpenStreetMap · 核实区间' },
    { routeSource: 'RailGo · 最新停靠站' },
  ]);
  assert.equal(mixed.length, 3);
  assert.ok(
    mixed.some(
      (line) =>
        line.includes('ODbL') &&
        line.includes('https://www.openstreetmap.org/copyright'),
    ),
  );
  assert.ok(mixed.some((line) => line.includes('线路 RailGo')));
  assert.equal(
    videoAttribution([
      {
        routeProvider: 'osm-local',
        quality: 'corridor',
        routeDataVersion: 'synthetic-v1',
      },
    ]).length,
    2,
  );
  assert.equal(
    videoAttribution([{ routeProvider: 'osm-local', quality: 'corridor' }])
      .length,
    1,
  );
});
