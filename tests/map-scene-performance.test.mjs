import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../dist/vendor/three.module.js';
import {
  journeyWorldPoints,
  prepareJourneyWorldPoints,
  installJourneyLayers,
} from '../dist/map-scene.js';
const trip = {
  id: 'test-route',
  mode: 'train',
  from: { coord: [118, 32] },
  to: { coord: [120, 33] },
  routeCoordinates: [
    [118, 32],
    [119, 35],
    [120, 33],
  ],
  routeRevision: 1,
};
test('点缓存跨记录浅拷贝和时刻修改复用，并响应几何、确认及路线版本变更', () => {
  const local = structuredClone(trip),
    first = journeyWorldPoints([local]);
  assert.strictEqual(
    journeyWorldPoints([{ ...local, departure: '2027-01-01T08:00' }]),
    first,
  );
  const other = {
    ...local,
    id: 'second',
    routeCoordinates: [
      [118, 32],
      [121, 32],
      [120, 33],
    ],
  };
  const together = journeyWorldPoints([local, other]);
  assert.strictEqual(
    journeyWorldPoints([{ ...local }, { ...other }]),
    together,
  );
  local.routeCoordinates[1] = [117, 36];
  local.routeRevision++;
  assert.notStrictEqual(journeyWorldPoints([local]), first);
  assert.equal(
    journeyWorldPoints([{ ...local, routeState: 'pending' }]).length,
    2,
  );
});
test('更新行程保留Three层，只销毁变更或删除的飞机网格', () => {
  const layers = new Map(),
    sources = new Map();
  const map = {
    getLayer: (id) => layers.get(id),
    getSource: (id) => sources.get(id),
    addSource(id, source) {
      sources.set(id, {
        ...source,
        setData(data) {
          this.data = data;
        },
      });
    },
    addLayer(layer) {
      layers.set(layer.id, layer);
    },
  };
  const flights = [
    { ...trip, id: 'a', mode: 'flight', distance: 1000 },
    { ...trip, id: 'b', mode: 'flight', distance: 800 },
  ];
  const original = T.BufferGeometry.prototype.dispose;
  let disposals = 0;
  T.BufferGeometry.prototype.dispose = function () {
    disposals++;
    return original.call(this);
  };
  try {
    installJourneyLayers(map, flights);
    const layer = layers.get('flight-arcs-3d');
    installJourneyLayers(
      map,
      flights.map((f) => ({ ...f, departure: '2027-01-01T08:00' })),
    );
    assert.strictEqual(layers.get('flight-arcs-3d'), layer);
    assert.equal(disposals, 0);
    installJourneyLayers(map, [{ ...flights[0], distance: 1100 }, flights[1]]);
    assert.equal(disposals, 1);
    installJourneyLayers(map, [{ ...flights[0], distance: 1100 }]);
    assert.equal(disposals, 2);
    layer.onRemove();
    layers.delete(layer.id);
    assert.equal(disposals, 3);
    installJourneyLayers(map, flights);
    assert.notStrictEqual(layers.get('flight-arcs-3d'), layer);
    layers.get('flight-arcs-3d').onRemove();
  } finally {
    T.BufferGeometry.prototype.dispose = original;
  }
});

test('分片几何准备与同步路径完整一致，沿用缓存并保留飞机高度', async () => {
  const route = {
    ...trip,
    routeCoordinates: Array.from({ length: 8000 }, (_, i) => [
      118 + i / 8000,
      32 + Math.sin(i / 120) * 2,
    ]),
  };
  const flight = {
    ...trip,
    id: 'flight-async',
    mode: 'flight',
    distance: 1500,
    routeCoordinates: [],
  };
  const expected = journeyWorldPoints([route, flight]);
  const fresh = structuredClone([route, flight]);
  let yields = 0,
    time = 0;
  const prepared = await prepareJourneyWorldPoints(fresh, {
    now: () => time++,
    budgetMs: 2,
    yieldControl: async () => {
      yields++;
    },
  });
  assert.deepEqual(prepared, expected);
  assert.ok(yields > 0);
  assert.ok(prepared.some((point) => point[2] > 0));
  assert.strictEqual(journeyWorldPoints(fresh), prepared);
  assert.strictEqual(await prepareJourneyWorldPoints(fresh), prepared);
});

test('分片几何取消后不发布部分点集，后续准备仍得到全部点', async () => {
  const fresh = {
    ...trip,
    routeCoordinates: Array.from({ length: 6000 }, (_, i) => [
      118 + i / 6000,
      32,
    ]),
  };
  const controller = new AbortController();
  await assert.rejects(
    prepareJourneyWorldPoints([fresh], {
      signal: controller.signal,
      budgetMs: 0,
      yieldControl: async () => controller.abort(),
    }),
    { name: 'AbortError' },
  );
  let yields = 0;
  const points = await prepareJourneyWorldPoints([fresh], {
    budgetMs: 0,
    yieldControl: async () => {
      yields++;
    },
  });
  assert.ok(yields > 0);
  assert.equal(points.length, 6002);
  assert.deepEqual(points, journeyWorldPoints([fresh]));
});
