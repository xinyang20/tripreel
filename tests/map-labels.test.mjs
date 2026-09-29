import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  endpointPlaces,
  layoutPlaceLabels,
  cityFor,
} from '../dist/map-labels.js';
const cityIndex = JSON.parse(
  await readFile(
    new URL('../dist/data/place-city-groups.json', import.meta.url),
    'utf8',
  ),
);
const a = { name: '南京南', coord: [118.8, 31.97] },
  b = { name: '仙林', coord: [118.9, 32.12] },
  c = { name: '南京禄口', code: 'NKG', coord: [118.86, 31.74] };
const options = {
  project: (p) => ({ x: 200 + (p[0] - 118.8) * 20, y: 200 + (p[1] - 32) * 20 }),
  zoom: 5,
  width: 800,
  height: 600,
  cityIndex,
};
test('相邻南京站点和机场合并为南京，放大或播放时恢复具体地名', () => {
  const merged = layoutPlaceLabels([a, b, c], options);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, '南京');
  assert.equal(merged[0].members.length, 3);
  for (const change of [{ detail: true }, { zoom: 9 }]) {
    const names = layoutPlaceLabels([a, b, c], { ...options, ...change }).map(
      (p) => p.name,
    );
    assert.deepEqual(names, ['南京南', '仙林', '南京禄口']);
  }
});
test('只合并有城市依据且发生接近的地点，未知地点与苏州宿州不误合', () => {
  assert.notEqual(
    cityFor({ name: '苏州' }, cityIndex).id,
    cityFor({ name: '宿州' }, cityIndex).id,
  );
  assert.equal(
    layoutPlaceLabels(
      [
        { name: '苏州', coord: a.coord },
        { name: '宿州', coord: a.coord },
        { name: '未知机场', coord: a.coord },
      ],
      options,
    ).length,
    3,
  );
  assert.equal(
    layoutPlaceLabels([a, b], {
      ...options,
      project: (p) => ({ x: p === a.coord ? 100 : 600, y: 200 }),
    }).length,
    2,
  );
});
test('只取行程起终点且去重，不生成中间停站标签', () => {
  assert.deepEqual(
    endpointPlaces([
      { from: a, to: b, stops: [a, c, b] },
      { from: b, to: a },
    ]).map((p) => p.name),
    ['南京南', '仙林'],
  );
  const labels = layoutPlaceLabels([a, b, c], { ...options, detail: true });
  for (const label of labels)
    assert.ok(
      label.x >= 0 &&
        label.y >= 0 &&
        label.x + label.width <= options.width &&
        label.y + label.height <= options.height,
    );
});
test('上海虹桥车站和机场同名但不同位置，播放和放大时分别保留', () => {
  const train = { name: '上海虹桥', code: 'AOH', coord: [121.319, 31.197] },
    flight = { name: '上海虹桥', code: 'SHA', coord: [121.335, 31.198] };
  const places = endpointPlaces([
    { mode: 'train', from: train, to: a },
    { mode: 'flight', from: flight, to: c },
  ]);
  assert.equal(places.length, 4);
  const labels = layoutPlaceLabels(places, {
    ...options,
    detail: true,
    project: () => ({ x: 300, y: 300 }),
  });
  assert.ok(labels.some((p) => p.name === '上海虹桥站'));
  assert.ok(labels.some((p) => p.name === '上海虹桥机场'));
});
test('放大后靠近顶部按钮的地名向下避让，保持完整可读', () => {
  const [label] = layoutPlaceLabels([a], {
    ...options,
    project: () => ({ x: 600, y: 96 }),
    blockers: [{ left: 500, top: 30, right: 750, bottom: 72 }],
  });
  assert.ok(label.y > 72, '标签不能被顶部地图按钮盖住');
});
