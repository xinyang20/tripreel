// G1802 几何来自公开 RailGo 夹具；本文件行程日期和时刻均为合成数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IDBFactory } from 'fake-indexeddb';
import { referenceGeometry, latestJourney } from '../scripts/rail-geometry.mjs';

const reference = referenceGeometry(
  JSON.parse(
    await readFile(
      new URL('./fixtures/g1802-railgo.json', import.meta.url),
      'utf8',
    ),
  ),
);
const stops = reference.stations.slice(
  reference.stations.findIndex((s) => s.name === '南京南'),
  reference.stations.findIndex((s) => s.name === '西安北') + 1,
);
const old = {
  id: 'old-g1802',
  mode: 'train',
  number: 'G1802',
  queryDate: '2030-02-03',
  departure: '2030-02-03T08:00',
  arrival: '2030-02-03T14:00',
  from: stops[0],
  to: stops.at(-1),
  stops,
  legs: stops.slice(1).map(() => ({ coordinates: null })),
  isReference: true,
  referenceDate: '2030-03-15',
  source: '12306 · 今日参考',
  quality: 'partial',
};
const raw = JSON.stringify({ version: 1, trips: [old] });
globalThis.indexedDB = new IDBFactory();
globalThis.localStorage = {
  getItem: () => raw,
  setItem() {
    throw new Error('Legacy must remain untouched');
  },
};
const elements = new Map();
const element = () => ({
  open: false,
  textContent: '',
  children: [],
  classList: {
    values: new Set(),
    add(v) {
      this.values.add(v);
    },
    remove(v) {
      this.values.delete(v);
    },
    toggle(v, on) {
      on ? this.values.add(v) : this.values.delete(v);
    },
  },
  setAttribute() {},
  addEventListener() {},
  append(child) {
    this.children.push(child);
  },
  replaceChildren() {
    this.children = [];
  },
});
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  },
  createElement: element,
  dispatchEvent() {},
};
globalThis.window = { addEventListener() {} };
const store = await import('../dist/store.js');
test('异步facade迁移并更新旧G1802，原时刻与参考来源保留且失败临时显示', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await store.load();
  assert.equal(store.state.ready, true);
  assert.equal(store.state.saved.length, 1);
  const response = {
    from: old.from,
    to: old.to,
    ...latestJourney(reference, stops, null),
    routeFetchedAt: '2030-03-18T00:00:00Z',
  };
  globalThis.fetch = async (_, options) => {
    assert.equal(JSON.parse(options.body).number, 'G1802');
    assert.equal(options.headers['X-Travel-Priority'], 'background');
    assert.equal(options.headers['X-Travel-Budget-Ms'], '75000');
    return { ok: true, json: async () => response };
  };
  const { refreshStoredRoutes } = await import('../dist/routes.js');
  await refreshStoredRoutes();
  const saved = store.state.saved[0];
  assert.equal(saved.routeCoordinates.length, 663);
  assert.equal(saved.routePolicy, 'latest-v2');
  assert.equal(saved.departure, old.departure);
  assert.equal(saved.referenceDate, old.referenceDate);
  assert.equal(saved.revision, 1);
  assert.equal(saved.routeRevision, 1);
  assert.equal(saved.routeHistory.length, 0);
  assert.equal(store.state.recovery.rawLegacy, raw);
  t.mock.timers.tick(6000);
  assert.equal(
    elements.get('route-update-status').classList.values.has('hidden'),
    true,
  );
  const before = structuredClone(store.state.saved[0]);
  globalThis.fetch = async () => ({
    ok: false,
    json: async () => ({ error: '测试线路源暂不可用' }),
  });
  await refreshStoredRoutes({ force: true });
  assert.deepEqual(store.state.saved[0], {
    ...before,
    lastRouteAttempt: store.state.saved[0].lastRouteAttempt,
  });
  assert.equal(
    store.state.saved[0].lastRouteAttempt.error,
    '测试线路源暂不可用',
  );
  const messages = elements
    .get('route-update-status')
    .children.map((el) => el.textContent)
    .join('\n');
  assert.match(messages, /G1802：测试线路源暂不可用/);
  assert.match(messages, /重新更新线路/);
  t.mock.timers.tick(12000);
  assert.equal(
    elements.get('route-update-status').classList.values.has('hidden'),
    true,
  );
});
test('facade保存必须await，分组及草稿同步快照，删除不使用旧全量commit', async () => {
  const group = await store.saveGroup({
    id: 'group',
    name: '分组',
    revision: 0,
  });
  assert.equal(store.state.groups[0].revision, 1);
  const draft = await store.saveDraft({
    id: 'draft',
    revision: 0,
    raw: '待保存',
  });
  assert.equal(store.state.drafts.length, 1);
  const [saved] = await store.saveTrips(
    [
      {
        id: 'pending',
        mode: 'train',
        number: 'G2',
        travelDate: '2030-03-20',
        from: { name: '甲' },
        to: { name: '乙' },
        groupId: group.id,
        revision: 0,
      },
    ],
    { draftId: draft.id, draftRevision: draft.revision },
  );
  assert.equal(store.state.drafts.length, 0);
  assert.equal(saved.routeState, 'pending');
  await store.deleteTrip(saved.id, saved.revision);
  assert.equal(store.state.saved.length, 1);
});
test('API合并外部取消和预算；未确认新示意不直接回放', async () => {
  let observed;
  const controller = new AbortController();
  globalThis.fetch = async (_, options) => {
    observed = options;
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await store.api('/api/flight?number=CA1001', null, {
    signal: controller.signal,
    timeoutMs: 12000,
  });
  assert.equal(observed.headers['X-Travel-Budget-Ms'], '7000');
  controller.abort();
  assert.equal(observed.signal.aborted, true);
  const current = store.state.saved[0],
    schematic = {
      ...current,
      quality: 'station-schematic',
      requiresConfirmation: true,
    };
  await assert.rejects(store.updateStoredRoute(current, schematic), /质量低/);
  assert.equal(store.state.saved[0].routeConfirmed, true);
  assert.equal(store.state.saved[0].quality, current.quality);
  assert.equal(store.state.saved[0].routeCandidate, null);
  assert.equal(
    store.state.saved[0].lastRouteAttempt.code,
    'LOWER_QUALITY_ROUTE',
  );
  store.repository.close();
});
