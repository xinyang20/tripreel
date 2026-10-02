import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createRepository, LEGACY_KEY } from '../dist/repository.js';
const trip = (id = 'a', date = '2026-09-26') => ({
  id,
  mode: 'train',
  number: 'G1',
  travelDate: date,
  queryDate: date,
  departure: `${date}T08:00`,
  arrival: `${date}T10:00`,
  from: { name: '甲', coord: [118, 32] },
  to: { name: '乙', coord: [119, 32] },
  stops: [
    { name: '甲', coord: [118, 32], departure: `${date}T08:00` },
    { name: '乙', coord: [119, 32], arrival: `${date}T10:00` },
  ],
  legs: [
    {
      coordinates: [
        [118, 32],
        [119, 32],
      ],
    },
  ],
  routeCoordinates: [
    [118, 32],
    [119, 32],
  ],
  quality: 'latest',
  revision: 0,
  routeRevision: 0,
  distance: 100,
});
async function setup(raw = null) {
  let legacy = raw;
  const storage = {
    getItem: (key) => (key === LEGACY_KEY ? legacy : null),
    setItem() {
      throw new Error('Must never modify legacy');
    },
  };
  const factory = new IDBFactory(),
    name = crypto.randomUUID(),
    options = {
      indexedDB: factory,
      legacyStorage: storage,
      dbName: name,
      broadcast: false,
    };
  const repository = createRepository(options);
  await repository.init();
  return { repository, options, setLegacy: (value) => (legacy = value) };
}
const snapshot = (repo) => repo.snapshot();
const idbResult = (operation) =>
  new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
async function rawStores(options, work, mode = 'readonly') {
  const db = await idbResult(options.indexedDB.open(options.dbName));
  try {
    const tx = db.transaction(['meta', 'trips', 'routes'], mode);
    const completed = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    const result = await work(
      Object.fromEntries(
        ['meta', 'trips', 'routes'].map((name) => [name, tx.objectStore(name)]),
      ),
    );
    await completed;
    return result;
  } finally {
    db.close();
  }
}
async function assertIdentityIndex(options) {
  const { meta, index, trips } = await rawStores(options, async (stores) => ({
    meta: await idbResult(stores.meta.get('dataset')),
    index: await idbResult(stores.meta.get('trip-identities')),
    trips: await idbResult(stores.trips.getAll()),
  }));
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.datasetRevision, meta.revision);
  assert.equal(index.entries.length, trips.length);
  assert.equal(
    new Set(index.entries.map((entry) => entry.id)).size,
    trips.length,
  );
  for (const entry of index.entries) {
    assert.ok(
      Object.values(entry).every(
        (value) =>
          value === null || ['string', 'number'].includes(typeof value),
      ),
    );
    const actual = trips.find((trip) => trip.id === entry.id);
    for (const field of ['mode', 'number', 'revision'])
      assert.equal(entry[field], actual[field]);
    assert.equal(
      entry.travelDate,
      actual.travelDate || actual.departure?.slice(0, 10) || actual.date || '',
    );
    assert.equal(entry.departure, actual.departure || null);
    assert.equal(entry.arrival, actual.arrival || null);
    assert.equal(entry.groupId, actual.groupId ?? null);
    assert.equal(entry.from, actual.from.name);
    assert.equal(entry.to, actual.to.name);
  }
  return index;
}
test('正常保存仅读轻量索引及本次记录，不读其他候选或任何全库几何', async (t) => {
  const { repository, options } = await setup();
  const hidden = trip('indexed-hidden', '2026-09-27');
  hidden.routeCandidate = { ...hidden, requiresConfirmation: true };
  const [current] = await repository.saveTrips([
    trip('indexed-current'),
    hidden,
  ]);
  await assertIdentityIndex(options);
  const get = IDBObjectStore.prototype.get;
  const getAll = IDBObjectStore.prototype.getAll;
  const allowed = new Set([
    'indexed-current',
    'indexed-new',
    'indexed-duplicate',
    'indexed-overlap',
  ]);
  t.mock.method(IDBObjectStore.prototype, 'get', function (key) {
    if (['trips', 'routes'].includes(this.name))
      assert.ok(allowed.has(key), `不应读取 ${this.name}/${key}`);
    return get.call(this, key);
  });
  t.mock.method(IDBObjectStore.prototype, 'getAll', function (...args) {
    assert.ok(
      !['trips', 'routes'].includes(this.name),
      `不应全读 ${this.name}`,
    );
    return getAll.apply(this, args);
  });
  await repository.saveTrips([{ ...current, source: '纯元信息修改' }]);
  await repository.saveTrips([trip('indexed-new', '2026-09-28')]);
  await assert.rejects(
    repository.saveTrips([{ ...trip('indexed-duplicate', '2026-09-27') }]),
    /重复/,
  );
  await assert.rejects(
    repository.saveTrips([
      { ...trip('indexed-overlap', '2026-09-27'), number: 'G2' },
    ]),
    /重叠/,
  );
  const index = await rawStores(options, (stores) =>
    idbResult(stores.meta.get('trip-identities')),
  );
  assert.equal(index.entries.length, 3);
  assert.ok(
    index.entries.every(
      (entry) =>
        !Object.keys(entry).some((field) =>
          /route|coord|history|candidate/i.test(field),
        ),
    ),
  );
  repository.close();
});
test('旧 v2 页写入、缺失或损坏索引按版本与结构重建，随后恢复定向保存', async (t) => {
  const { repository, options } = await setup();
  let [current] = await repository.saveTrips([
    trip('index-old-a'),
    trip('index-old-b', '2026-09-27'),
  ]);
  const getAll = IDBObjectStore.prototype.getAll;
  let baseReads = 0;
  t.mock.method(IDBObjectStore.prototype, 'getAll', function (...args) {
    if (this.name === 'trips') baseReads++;
    assert.notEqual(this.name, 'routes', '重建轻量索引不需要路线表');
    return getAll.apply(this, args);
  });
  const save = async () => {
    [current] = await repository.saveTrips([
      { ...current, source: `索引重建 ${current.revision}` },
    ]);
  };
  await rawStores(
    options,
    (stores) => idbResult(stores.meta.delete('trip-identities')),
    'readwrite',
  );
  await save();
  assert.equal(baseReads, 1);
  await save();
  assert.equal(baseReads, 1);
  // Emulate the old v2 writer: same record count, changed identity/time and dataset
  // revision, with no knowledge of the new optional meta record.
  await rawStores(
    options,
    async (stores) => {
      const base = await idbResult(stores.trips.get('index-old-b'));
      await idbResult(
        stores.trips.put({
          ...base,
          number: 'G77',
          travelDate: undefined,
          date: '2026-09-28',
          departure: '2026-09-28T08:00',
          arrival: '2026-09-28T10:00',
          revision: base.revision + 1,
        }),
      );
      const meta = await idbResult(stores.meta.get('dataset'));
      await idbResult(
        stores.meta.put({ ...meta, revision: meta.revision + 1 }),
      );
    },
    'readwrite',
  );
  await save();
  assert.equal(baseReads, 2);
  await assert.rejects(
    repository.saveTrips([
      { ...trip('old-page-duplicate', '2026-09-28'), number: 'G77' },
    ]),
    /重复/,
  );
  await assert.rejects(
    repository.saveTrips([
      { ...trip('old-page-overlap', '2026-09-28'), number: 'G78' },
    ]),
    /重叠/,
  );
  for (const corrupt of [
    (index) => {
      index.schemaVersion = 999;
    },
    (index) => {
      index.entries[0].routeCandidate = { coordinates: [[1, 2]] };
    },
    (index) => {
      index.entries[1].id = index.entries[0].id;
    },
    (index) => {
      index.entries.pop();
    },
    // A well-typed but incorrect affected entry is checked against its real base.
    (index) => {
      index.entries.find((entry) => entry.id === current.id).number = 'G999';
    },
  ]) {
    await rawStores(
      options,
      async (stores) => {
        const index = await idbResult(stores.meta.get('trip-identities'));
        corrupt(index);
        await idbResult(stores.meta.put(index));
      },
      'readwrite',
    );
    const before = baseReads;
    await save();
    assert.equal(baseReads, before + 1);
    await save();
    assert.equal(baseReads, before + 1);
  }
  repository.close();
});
test('双 repository 并发、草稿分组、删除及恢复始终与轻量索引同事务推进', async () => {
  const { repository, options } = await setup();
  const other = createRepository(options);
  await other.init();
  try {
    const results = await Promise.allSettled([
      repository.saveTrips([trip('index-concurrent-a')]),
      other.saveTrips([trip('index-concurrent-b')]),
    ]);
    assert.equal(
      results.filter((item) => item.status === 'fulfilled').length,
      1,
    );
    await assertIdentityIndex(options);
    const existing = (await repository.snapshot()).trips[0];
    const group = await other.saveGroup({ name: '索引分组' });
    await repository.assignGroup(
      [{ id: existing.id, revision: existing.revision }],
      group.id,
    );
    await assertIdentityIndex(options);
    await other.deleteGroup(group.id, group.revision);
    await assertIdentityIndex(options);
    await other.saveDraft({ id: 'index-draft', kind: 'single', revision: 0 });
    await assertIdentityIndex(options);
    await repository.deleteDraft('index-draft', 1);
    await assertIdentityIndex(options);
    const preview = await repository.previewRestore({
      version: 1,
      trips: [trip('index-restored', '2026-09-27')],
    });
    await repository.applyRestore(preview);
    await assertIdentityIndex(options);
    const restored = (await other.readTrips(['index-restored']))[0];
    await other.deleteTrip(restored.id, restored.revision);
    await assertIdentityIndex(options);
    await repository.saveTrips([trip('index-readded', '2026-09-27')]);
    const readded = (await repository.readTrips(['index-readded']))[0];
    await other.setRouteFrozen(
      readded.id,
      true,
      readded.revision,
      readded.routeRevision,
    );
    const beforePreferences = await assertIdentityIndex(options);
    await repository.savePreferences({ railProvider: 'osm-local' });
    assert.deepEqual(await assertIdentityIndex(options), beforePreferences);
  } finally {
    repository.close();
    other.close();
  }
});
test('索引写入容量失败时主记录、数据版本和索引一起回滚', async (t) => {
  const { repository, options } = await setup();
  const [current] = await repository.saveTrips([trip('index-atomic')]);
  const before = await repository.snapshot();
  const beforeIndex = await assertIdentityIndex(options);
  const put = IDBObjectStore.prototype.put;
  const mocked = t.mock.method(
    IDBObjectStore.prototype,
    'put',
    function (value) {
      if (this.name === 'meta' && value.id === 'trip-identities')
        throw new DOMException('full', 'QuotaExceededError');
      return put.call(this, value);
    },
  );
  await assert.rejects(
    repository.saveTrips([{ ...current, number: 'G88' }]),
    /空间不足/,
  );
  mocked.mock.restore();
  assert.deepEqual(await repository.snapshot(), before);
  assert.deepEqual(await assertIdentityIndex(options), beforeIndex);
  repository.close();
});
test('提交通知只含变更标识，连续版本定向读取，版本缺口和旧通知回退完整快照', async () => {
  const { repository } = await setup();
  const changes = [];
  repository.subscribeCommits((change) => changes.push(change));
  const [a] = await repository.saveTrips([trip('delta-a')]);
  assert.equal(changes[0].fromRevision, 0);
  assert.equal(changes[0].revision, 1);
  assert.deepEqual(changes[0].changedTripIds, ['delta-a']);
  assert.equal('trips' in changes[0], false);
  const first = await repository.readChanges(changes[0], 0);
  assert.equal(first.partial, true);
  assert.deepEqual(
    first.trips.map((item) => item.id),
    ['delta-a'],
  );
  await repository.saveTrips([trip('delta-b', '2026-09-27')]);
  const partial = await repository.readChanges(changes[1], 1);
  assert.equal(partial.partial, true);
  assert.deepEqual(
    partial.trips.map((item) => item.id),
    ['delta-b'],
  );
  for (const change of [changes[0], changes[1], { revision: 2 }]) {
    const full = await repository.readChanges(change, 0);
    assert.equal(full.partial, undefined);
    assert.equal(full.trips.length, 2);
  }
  await repository.deleteTrip(a.id, a.revision);
  const removed = await repository.readChanges(changes.at(-1), 2);
  assert.deepEqual(removed.removedTripIds, ['delta-a']);
  assert.equal(removed.trips.length, 0);
});
test('单条保存和分组修改不读取全库路线，草稿提交也推进连续版本', async (t) => {
  const { repository } = await setup();
  const [a, b] = await repository.saveTrips([
    trip('light-a'),
    trip('light-b', '2026-09-27'),
  ]);
  const originalGetAll = IDBObjectStore.prototype.getAll;
  const originalPut = IDBObjectStore.prototype.put;
  let routeReads = 0,
    routeWrites = 0;
  t.mock.method(IDBObjectStore.prototype, 'getAll', function (...args) {
    if (this.name === 'routes') routeReads++;
    return originalGetAll.apply(this, args);
  });
  t.mock.method(IDBObjectStore.prototype, 'put', function (...args) {
    if (this.name === 'routes') routeWrites++;
    return originalPut.apply(this, args);
  });
  const [next] = await repository.saveTrips([{ ...a, source: '补充说明' }]);
  assert.equal(routeReads, 0);
  const group = await repository.saveGroup({ name: '新分组' });
  routeWrites = 0;
  await repository.assignGroup(
    [{ id: next.id, revision: next.revision }],
    group.id,
  );
  assert.equal(routeWrites, 0);
  assert.equal(routeReads, 0);
  await assert.rejects(
    repository.assignGroup(
      [
        { id: b.id, revision: b.revision },
        { id: next.id, revision: next.revision },
      ],
      group.id,
    ),
    /改变/,
  );
  assert.equal((await repository.readTrips([b.id]))[0].groupId, null);
  const changes = [];
  repository.subscribeCommits((change) => changes.push(change));
  const before = await repository.snapshot();
  await repository.saveDraft({
    id: 'delta-draft',
    revision: 0,
    kind: 'single',
  });
  const after = await repository.readChanges(
    changes[0],
    before.datasetRevision,
  );
  assert.equal(after.partial, true);
  assert.equal(after.kind, 'drafts');
  assert.equal(after.drafts.length, 1);
  assert.equal(after.trips.length, 0);
});
test('来源偏好保存到独立meta且不会使行程恢复预览失效', async () => {
  const { repository, options } = await setup();
  const other = createRepository(options);
  await other.init();
  assert.deepEqual(await repository.loadPreferences(), {
    railProvider: 'railgo',
  });
  const before = await repository.snapshot();
  const preview = await repository.previewRestore({
    version: 1,
    trips: [trip('preferences-trip')],
  });
  const changes = [];
  repository.subscribeCommits((change) => changes.push(change));
  assert.deepEqual(
    await repository.savePreferences({ railProvider: 'osm-local' }),
    { railProvider: 'osm-local' },
  );
  assert.equal((await other.loadPreferences()).railProvider, 'osm-local');
  assert.equal(
    (await repository.snapshot()).datasetRevision,
    before.datasetRevision,
  );
  assert.deepEqual(changes, [{ kind: 'preferences' }]);
  await repository.applyRestore(preview);
  await assert.rejects(
    repository.savePreferences({ railProvider: 'untrusted-url' }),
    /设置无效/,
  );
  assert.equal((await repository.loadPreferences()).railProvider, 'osm-local');
});
test('自动线路仅接受同等或更高质量，空、坏、低质与网络失败均留存原线及最近错误', async () => {
  const { repository } = await setup();
  const [current] = await repository.saveTrips([trip()]);
  for (const response of [
    null,
    {},
    { ...current, routeCoordinates: [[999, 0]], legs: [] },
    { ...current, quality: 'corridor' },
    { ...current, quality: 'station-schematic', requiresConfirmation: true },
  ]) {
    await assert.rejects(repository.updateRoute(current, response));
    const saved = (await repository.snapshot()).trips[0];
    assert.deepEqual(saved.routeCoordinates, current.routeCoordinates);
    assert.equal(saved.routeRevision, current.routeRevision);
    assert.equal(saved.routeHistory.length, 0);
    assert.ok(saved.lastRouteAttempt.error);
    assert.equal(saved.routeCandidate, undefined);
  }
  await repository.recordRouteAttempt(
    current,
    Object.assign(new Error('网络失败'), { code: 'OFFLINE' }),
  );
  assert.equal(
    (await repository.snapshot()).trips[0].lastRouteAttempt.error,
    '网络失败',
  );
  await repository.updateRoute(current, {
    ...current,
    routeFetchedAt: '2026-09-26T12:00:00Z',
  });
  const latest = (await repository.snapshot()).trips[0];
  assert.equal(latest.lastRouteAttempt.error, null);
  assert.equal(latest.routeHistory.length, 0);
  await assert.rejects(
    repository.setRouteFrozen(
      current.id,
      true,
      current.revision,
      current.routeRevision,
    ),
    /线路已更新/,
  );
  assert.equal((await repository.snapshot()).trips[0].routeFrozen, false);
  assert.equal(
    await repository.recordRouteAttempt(current, new Error('旧请求迟到')),
    false,
  );
  repository.close();
});
test('相同几何刷新不添加历史，重复几何只保留最近三个不同版本，手动保存和恢复沿用规则', async () => {
  const { repository } = await setup();
  let [current] = await repository.saveTrips([trip()]);
  const shape = (i) => [
    [118, 32],
    [118.5, 32 + i / 100],
    [119, 32],
  ];
  for (const i of [1, 2, 3, 2, 4, 5]) {
    await repository.updateRoute(current, {
      ...current,
      routeCoordinates: shape(i),
      routeFetchedAt: `seen-${i}`,
    });
    current = (await repository.snapshot()).trips[0];
  }
  assert.deepEqual(
    current.routeHistory.map((item) => item.routeCoordinates),
    [shape(4), shape(2), shape(3)],
  );
  const before = current.routeHistory.map((item) => item.id);
  await repository.updateRoute(current, {
    ...current,
    routeFetchedAt: 'new-fetch',
  });
  current = (await repository.snapshot()).trips[0];
  assert.equal(current.routeFetchedAt, 'new-fetch');
  assert.deepEqual(
    current.routeHistory.map((item) => item.id),
    before,
  );
  [current] = await repository.saveTrips([
    { ...current, routeCoordinates: shape(2) },
  ]);
  assert.deepEqual(
    current.routeHistory.map((item) => item.routeCoordinates),
    [shape(5), shape(4), shape(3)],
  );
  const restored = await repository.restoreRoute(
    current.id,
    current.routeHistory[1].id,
    current.revision,
  );
  assert.equal(restored.routeFrozen, true);
  assert.deepEqual(restored.routeCoordinates, shape(4));
  assert.deepEqual(
    restored.routeHistory.map((item) => item.routeCoordinates),
    [shape(2), shape(5), shape(3)],
  );
  repository.close();
});
const osmRoute = () => ({
  ...trip(),
  quality: 'corridor',
  routeProvider: 'osm-local',
  routeDataVersion: 'osm-v1',
  routeEvidence: { relationId: 123, relationVersion: 1 },
  routeSource: 'OpenStreetMap · 合成参考区间',
  routeSourceUrl: 'https://www.openstreetmap.org/relation/123',
  routeNote: '合成来源说明',
  routeFetchedAt: '2026-09-26T12:00:00Z',
  routeConfirmed: true,
  requiresConfirmation: true,
});
test('已接受示意的同来源同几何刷新复用确认，缺失来源不能静默复用授权', async () => {
  const { repository } = await setup();
  try {
    const response = {
      ...trip(),
      quality: 'station-schematic',
      routeProvider: 'railgo',
      requiresConfirmation: true,
      resolution: { state: 'needs-confirmation', requiresConfirmation: true },
    };
    let [current] = await repository.saveTrips([
      {
        ...response,
        departure: '2026-09-26T08:30',
        routeConfirmed: true,
        routeCandidate: null,
        routeDataVersion: null,
        routeEvidence: null,
      },
    ]);
    await repository.updateRoute(current, response);
    current = (await repository.snapshot()).trips[0];
    assert.equal(current.departure, '2026-09-26T08:30');
    assert.equal(current.routeConfirmed, true);
    assert.equal(current.routeProvider, 'railgo');
    assert.equal(current.routeCandidate, null);
    const unknown = { ...response };
    delete unknown.routeProvider;
    await repository.updateRoute(current, unknown);
    const saved = (await repository.snapshot()).trips[0];
    assert.equal(saved.routeConfirmed, true);
    assert.equal(saved.routeProvider, 'railgo');
    assert.ok(saved.routeCandidate);
    assert.equal(saved.routeCandidate.routeProvider, undefined);
  } finally {
    repository.close();
  }
});
test('OSM 升级为 RailGo 主线时清除缺省来源元信息，历史保留原证据', async () => {
  const { repository } = await setup();
  try {
    const [current] = await repository.saveTrips([osmRoute()]);
    await repository.updateRoute(current, {
      ...trip(),
      routeProvider: 'railgo',
      routeSource: 'RailGo',
      routeCoordinates: [
        [118, 32],
        [118.5, 32.1],
        [119, 32],
      ],
    });
    const saved = (await repository.snapshot()).trips[0];
    assert.equal(saved.routeProvider, 'railgo');
    assert.equal(saved.routeSource, 'RailGo');
    for (const field of [
      'routeDataVersion',
      'routeEvidence',
      'routeSourceUrl',
      'routeNote',
      'routeFetchedAt',
    ])
      assert.equal(saved[field], null, field);
    assert.equal(saved.routeCandidate, null);
    assert.equal(saved.routeHistory[0].routeProvider, 'osm-local');
    assert.equal(saved.routeHistory[0].routeDataVersion, 'osm-v1');
    assert.deepEqual(
      saved.routeHistory[0].routeEvidence,
      osmRoute().routeEvidence,
    );
  } finally {
    repository.close();
  }
});
test('恢复无新元信息的旧 RailGo 历史不会继承 OSM 来源，备份保留各版本归属', async () => {
  const { repository } = await setup();
  const { repository: target } = await setup();
  try {
    const [old] = await repository.saveTrips([
      { ...trip(), routeSource: 'RailGo' },
    ]);
    const [current] = await repository.saveTrips([
      {
        ...osmRoute(),
        revision: old.revision,
        routeRevision: old.routeRevision,
        routeCoordinates: [
          [118, 32],
          [118.5, 32.1],
          [119, 32],
        ],
      },
    ]);
    const restored = await repository.restoreRoute(
      current.id,
      current.routeHistory[0].id,
      current.revision,
    );
    assert.equal(restored.routeSource, 'RailGo');
    assert.equal(restored.routeProvider, undefined);
    assert.equal(restored.routeDataVersion, null);
    assert.equal(restored.routeEvidence, null);
    assert.equal(restored.routeNote, null);
    assert.equal(restored.routeSourceUrl, null);
    assert.equal(restored.routeFetchedAt, null);
    assert.equal(restored.routeFrozen, true);
    assert.equal(restored.routeHistory[0].routeProvider, 'osm-local');
    assert.deepEqual(
      restored.routeHistory[0].routeEvidence,
      osmRoute().routeEvidence,
    );
    const backup = await repository.exportBackup();
    await target.applyRestore(await target.previewRestore(backup));
    const imported = (await target.snapshot()).trips[0];
    assert.equal(imported.routeProvider, undefined);
    assert.equal(imported.routeDataVersion, null);
    assert.equal(imported.routeHistory[0].routeDataVersion, 'osm-v1');
    assert.deepEqual(
      imported.routeHistory[0].routeEvidence,
      osmRoute().routeEvidence,
    );
  } finally {
    repository.close();
    target.close();
  }
});
test('同几何候选改变版本、来源或证据时必须重新接受，主线与备份保留各自元信息', async (t) => {
  for (const [name, patch] of [
    ['版本', { routeDataVersion: 'osm-v2' }],
    ['查询来源', { routeProvider: 'railgo', routeSource: 'RailGo' }],
    [
      '实际来源',
      { routeSourceUrl: 'https://www.openstreetmap.org/relation/456' },
    ],
    ['证据', { routeEvidence: { relationId: 123, relationVersion: 2 } }],
  ]) {
    await t.test(name, async () => {
      const { repository } = await setup();
      const { repository: target } = await setup();
      try {
        const [current] = await repository.saveTrips([osmRoute()]);
        await repository.updateRoute(current, { ...osmRoute(), ...patch });
        const saved = (await repository.snapshot()).trips[0];
        assert.equal(saved.routeDataVersion, 'osm-v1');
        assert.equal(saved.routeProvider, 'osm-local');
        assert.deepEqual(saved.routeEvidence, current.routeEvidence);
        assert.equal(saved.routeConfirmed, true);
        assert.equal(saved.routeHistory.length, 0);
        for (const [field, value] of Object.entries(patch))
          assert.deepEqual(saved.routeCandidate[field], value);
        const backup = await repository.exportBackup();
        await target.applyRestore(await target.previewRestore(backup));
        const imported = (await target.snapshot()).trips[0];
        assert.equal(imported.routeDataVersion, 'osm-v1');
        assert.deepEqual(imported.routeCandidate, saved.routeCandidate);
      } finally {
        repository.close();
        target.close();
      }
    });
  }
});
test('OSM 来源即使缺少 requiresConfirmation 标志也必须确认，新鲜度变化不撤销同版本确认', async () => {
  const { repository } = await setup();
  try {
    let [current] = await repository.saveTrips([osmRoute()]);
    await repository.updateRoute(current, {
      ...osmRoute(),
      routeFetchedAt: '2026-09-27T12:00:00Z',
      routeNote: '说明更新，几何与证据未变',
    });
    current = (await repository.snapshot()).trips[0];
    assert.equal(current.routeCandidate, null);
    assert.equal(current.routeConfirmed, true);
    assert.equal(current.routeHistory.length, 0);
    const next = { ...osmRoute(), routeDataVersion: 'osm-v2' };
    delete next.requiresConfirmation;
    await repository.updateRoute(current, next);
    const saved = (await repository.snapshot()).trips[0];
    assert.equal(saved.routeDataVersion, 'osm-v1');
    assert.equal(saved.routeCandidate.routeDataVersion, 'osm-v2');
    assert.equal(saved.routeConfirmed, true);
  } finally {
    repository.close();
  }
});
test('迁移v1一次且保留原文，合法与损坏记录隔离', async () => {
  const valid = trip(),
    bad = { ...trip('bad'), distance: -1 };
  const raw = JSON.stringify({ version: 1, trips: [valid, bad] });
  const { repository, options } = await setup(raw);
  let data = await snapshot(repository);
  assert.equal(data.trips.length, 1);
  assert.equal(data.trips[0].revision, 1);
  assert.equal(data.recovery.items.length, 1);
  assert.equal(data.recovery.rawLegacy, raw);
  assert.deepEqual(data.recovery.items[0].raw, bad);
  const second = createRepository(options);
  await second.init();
  assert.equal((await snapshot(second)).trips.length, 1);
  repository.close();
  second.close();
});
test('坏JSON进入救援锁定，允许从备份恢复，原文仍留存', async () => {
  const { repository } = await setup('{bad');
  assert.equal((await snapshot(repository)).locked, true);
  await assert.rejects(repository.saveTrips([trip()]), /救援/);
  const preview = await repository.previewRestore({
    version: 1,
    trips: [trip()],
  });
  await repository.applyRestore(preview, {});
  const data = await snapshot(repository);
  assert.equal(data.locked, false);
  assert.equal(data.recovery.rawLegacy, '{bad');
  assert.equal(data.trips.length, 1);
  repository.close();
});
test('迁移后旧标签写入会被检测，而不反向覆盖新库', async () => {
  const { repository, setLegacy } = await setup(
    JSON.stringify({ version: 1, trips: [trip()] }),
  );
  setLegacy(JSON.stringify({ version: 1, trips: [] }));
  const data = await snapshot(repository);
  assert.equal(data.recovery.legacyChanged, true);
  assert.equal(data.trips.length, 1);
  repository.close();
});
test('两个独立repository并发新增不同日期不丢数据；同记录并发更新只成功一个', async () => {
  const { repository: a, options } = await setup();
  const b = createRepository(options);
  await b.init();
  await Promise.all([
    a.saveTrips([trip('a')]),
    b.saveTrips([trip('b', '2026-09-27')]),
  ]);
  assert.equal((await snapshot(a)).trips.length, 2);
  const base = (await snapshot(a)).trips[0];
  const results = await Promise.allSettled([
    a.saveTrips([{ ...base, number: 'G2' }]),
    b.saveTrips([{ ...base, number: 'G3' }]),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  a.close();
  b.close();
});
test('两个标签同时添加重复旅程或重叠时刻，事务内重验阻止后者', async () => {
  const { repository: a, options } = await setup();
  const b = createRepository(options);
  await b.init();
  const results = await Promise.allSettled([
    a.saveTrips([trip('a')]),
    b.saveTrips([trip('b')]),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await snapshot(a)).trips.length, 1);
  a.close();
  b.close();
});
test('批量保存失败保持整批及草稿，成功一次提交并删除正确草稿版本', async () => {
  const { repository } = await setup();
  const draft = await repository.saveDraft({
    id: 'draft',
    revision: 0,
    raw: 'original input',
  });
  await assert.rejects(
    repository.saveTrips([trip('a'), trip('b')], {
      draftId: draft.id,
      draftRevision: draft.revision,
    }),
    /重复|重叠/,
  );
  assert.equal((await snapshot(repository)).trips.length, 0);
  assert.equal((await repository.listDrafts()).length, 1);
  await repository.saveTrips([trip()], {
    draftId: draft.id,
    draftRevision: draft.revision,
  });
  assert.equal((await repository.listDrafts()).length, 0);
  await assert.rejects(
    repository.saveDraft({ ...draft, raw: 'late autosave' }),
    /草稿/,
  );
  repository.close();
});
test('草稿被另一页修改后，保存正式记录不得顺手删除新草稿', async () => {
  const { repository } = await setup();
  const draft = await repository.saveDraft({
    id: 'draft',
    revision: 0,
    raw: 'first',
  });
  await repository.saveDraft({ ...draft, raw: 'newer' });
  await assert.rejects(
    repository.saveTrips([trip()], {
      draftId: draft.id,
      draftRevision: draft.revision,
    }),
    /草稿/,
  );
  assert.equal((await snapshot(repository)).trips.length, 0);
  assert.equal((await repository.listDrafts())[0].raw, 'newer');
  repository.close();
});
test('旧revision删除和取消信号均不改变已保存记录', async () => {
  const { repository } = await setup();
  const [saved] = await repository.saveTrips([trip()]);
  const [updated] = await repository.saveTrips([{ ...saved, number: 'G2' }]);
  await assert.rejects(repository.deleteTrip(saved.id, saved.revision), /改变/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    repository.saveTrips([{ ...updated, number: 'G3' }], {
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
  assert.equal((await snapshot(repository)).trips[0].number, 'G2');
  repository.close();
});
test('容量失败中止事务，原记录和草稿不被部分修改', async () => {
  const { repository } = await setup();
  await repository.saveTrips([trip()]);
  const before = await snapshot(repository),
    put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'routes')
      throw new DOMException('full', 'QuotaExceededError');
    return put.apply(this, args);
  };
  try {
    await assert.rejects(
      repository.saveTrips([trip('b', '2026-09-27')]),
      /空间不足/,
    );
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  assert.deepEqual((await snapshot(repository)).trips, before.trips);
  repository.close();
});
test('分组删除事务内只移至未分组，不删除行程，旧编辑版本失效', async () => {
  const { repository } = await setup();
  const group = await repository.saveGroup({
    id: 'g',
    name: '旅程',
    revision: 0,
  });
  const [saved] = await repository.saveTrips([
    { ...trip(), groupId: group.id },
  ]);
  await repository.deleteGroup(group.id, group.revision);
  const data = await snapshot(repository);
  assert.equal(data.groups.length, 0);
  assert.equal(data.trips.length, 1);
  assert.equal(data.trips[0].groupId, null);
  await assert.rejects(repository.saveTrips([saved]), /改变/);
  repository.close();
});
test('后台路线更新保留日期和时间，只维护当前与3份历史，冻结及恢复可用', async () => {
  const { repository } = await setup();
  let [current] = await repository.saveTrips([
    { ...trip(), isReference: true, referenceDate: '2026-09-20' },
  ]);
  for (let i = 0; i < 5; i++) {
    const route = {
      ...current,
      routeCoordinates: [
        [118, 32],
        [118.5, 32 + i * 0.01],
        [119, 32],
      ],
      routeFetchedAt: `2026-09-26T0${i}:00:00Z`,
    };
    assert.equal(await repository.updateRoute(current, route), true);
    current = (await snapshot(repository)).trips[0];
  }
  assert.equal(current.routeHistory.length, 3);
  assert.equal(current.revision, 1);
  assert.equal(current.departure, '2026-09-26T08:00');
  assert.equal(current.referenceDate, '2026-09-20');
  const history = current.routeHistory[0];
  const frozen = await repository.setRouteFrozen(
    current.id,
    true,
    current.revision,
  );
  assert.equal(
    await repository.updateRoute(frozen, {
      ...current,
      routeFetchedAt: 'later',
    }),
    false,
  );
  const restored = await repository.restoreRoute(
    current.id,
    history.id,
    frozen.revision,
  );
  assert.equal(restored.routeFrozen, true);
  assert.deepEqual(restored.routeCoordinates, history.routeCoordinates);
  assert.equal(restored.routeHistory.length, 3);
  repository.close();
});
test('迟到路线响应不能覆盖新编辑、删除、已更新路线或冻结版本', async () => {
  const { repository } = await setup();
  const [old] = await repository.saveTrips([trip()]);
  await repository.saveTrips([{ ...old, number: 'G2' }]);
  assert.equal(await repository.updateRoute(old, old), false);
  const current = (await snapshot(repository)).trips[0];
  await repository.deleteTrip(current.id, current.revision);
  assert.equal(await repository.updateRoute(current, current), false);
  repository.close();
});
test('全量备份包含正式待补全、来源、分组、草稿、路线历史', async () => {
  const { repository } = await setup();
  await repository.saveTrips([
    {
      ...trip(),
      departure: null,
      arrival: null,
      routeState: 'pending',
      routeCoordinates: [],
      legs: [],
      distance: null,
      fieldSources: { departure: { source: 'manual' } },
    },
  ]);
  await repository.saveGroup({ id: 'g', name: '测试分组', revision: 0 });
  await repository.saveDraft({ id: 'd', revision: 0, raw: '草稿' });
  const backup = await repository.exportBackup();
  assert.equal(backup.version, 2);
  assert.equal(backup.trips[0].routeState, 'pending');
  assert.equal(backup.trips[0].distance, null);
  assert.equal(backup.drafts.length, 1);
  assert.equal(backup.groups.length, 1);
  assert.equal(
    (await repository.exportBackup({ includeDrafts: false })).drafts,
    undefined,
  );
  repository.close();
});
test('恢复预览隔离坏坐标/历史/距离，合法项可选择恢复', async () => {
  const { repository } = await setup();
  const preview = await repository.previewRestore({
    version: 1,
    trips: [
      trip(),
      {
        ...trip('bad', '2026-09-27'),
        routeHistory: [
          {
            id: 'bad-history',
            routeCoordinates: [
              [0, 0],
              [119, 32],
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    preview.entries.map((e) => e.kind),
    ['new', 'invalid'],
  );
  assert.equal((await repository.applyRestore(preview, {})).saved, 1);
  assert.equal((await snapshot(repository)).trips.length, 1);
  repository.close();
});
test('恢复预览后其他页面修改，拒绝旧选择且不覆盖', async () => {
  const { repository } = await setup();
  const preview = await repository.previewRestore({
    version: 1,
    trips: [trip()],
  });
  await repository.saveTrips([trip('b', '2026-09-27')]);
  await assert.rejects(repository.applyRestore(preview, {}), /预览后/);
  assert.deepEqual(
    (await snapshot(repository)).trips.map((t) => t.id),
    ['b'],
  );
  repository.close();
});
test('恢复默认保留已有冲突，显式替换留存旧路线历史；不存在整库清空', async () => {
  const { repository } = await setup();
  await repository.saveTrips([trip()]);
  let preview = await repository.previewRestore({
    version: 1,
    trips: [{ ...trip(), number: 'G2' }],
  });
  assert.equal(preview.entries[0].kind, 'conflict');
  await repository.applyRestore(preview, {});
  assert.equal((await snapshot(repository)).trips[0].number, 'G1');
  preview = await repository.previewRestore({
    version: 1,
    trips: [{ ...trip(), number: 'G2' }],
  });
  await repository.applyRestore(preview, { 0: 'replace' });
  assert.equal((await snapshot(repository)).trips[0].number, 'G2');
  assert.equal((await snapshot(repository)).trips[0].routeHistory.length, 1);
  repository.close();
});
test('恢复批次中一条时间冲突时不部分提交其他行，也不添加其分组', async () => {
  const { repository } = await setup();
  await repository.saveTrips([trip()]);
  const preview = await repository.previewRestore({
    format: 'travel-trace-backup',
    version: 2,
    trips: [trip('b', '2026-09-27'), { ...trip('c'), number: 'G5' }],
    groups: [{ id: 'g', name: 'group' }],
  });
  await assert.rejects(repository.applyRestore(preview, {}), /重叠/);
  const data = await snapshot(repository);
  assert.equal(data.trips.length, 1);
  assert.equal(data.groups.length, 0);
  repository.close();
});
test('迁移事务中断不会留下半批数据；重试仍从原v1完整恢复', async () => {
  const raw = JSON.stringify({
      version: 1,
      trips: [trip('a'), trip('b', '2026-09-27')],
    }),
    factory = new IDBFactory(),
    options = {
      indexedDB: factory,
      legacyStorage: { getItem: () => raw },
      dbName: 'migration-interrupted',
      broadcast: false,
    };
  const repo = createRepository(options),
    put = IDBObjectStore.prototype.put;
  let count = 0;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'routes' && ++count === 2)
      throw new DOMException('full', 'QuotaExceededError');
    return put.apply(this, args);
  };
  try {
    await assert.rejects(repo.init(), /空间不足/);
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  const snapshot = await repo.init();
  assert.equal(snapshot.trips.length, 2);
  assert.equal(snapshot.recovery.rawLegacy, raw);
  repo.close();
});
test('IndexedDB不可用时不启用隐式localStorage写入后端', async () => {
  const repo = createRepository({
    indexedDB: null,
    legacyStorage: {
      getItem: () => JSON.stringify({ version: 1, trips: [trip()] }),
      setItem() {
        assert.fail('must not write');
      },
    },
    broadcast: false,
  });
  await assert.rejects(repo.init(), /IndexedDB/);
  assert.match(repo.rawLegacy(), /G1/);
  repo.close();
});
test('备份再次导入识别为重复，忽略对象属性顺序', async () => {
  const { repository } = await setup();
  await repository.saveTrips([trip()]);
  const backup = await repository.exportBackup();
  backup.trips[0] = Object.fromEntries(
    Object.entries(backup.trips[0]).reverse(),
  );
  const preview = await repository.previewRestore(backup);
  assert.equal(preview.entries[0].kind, 'duplicate');
  await repository.applyRestore(preview, {});
  assert.equal((await snapshot(repository)).trips.length, 1);
  repository.close();
});
test('未来备份版本不被当作空数据；待补全记录仍可恢复', async () => {
  const { repository } = await setup();
  await assert.rejects(
    repository.previewRestore({
      format: 'travel-trace-backup',
      version: 99,
      trips: [],
    }),
    /格式/,
  );
  const preview = await repository.previewRestore({
    format: 'travel-trace-backup',
    version: 2,
    trips: [
      {
        ...trip(),
        departure: null,
        arrival: null,
        from: { name: '甲', coord: null },
        to: { name: '乙', coord: null },
        routeCoordinates: [],
        legs: [],
        routeState: 'pending',
        distance: null,
      },
    ],
  });
  await repository.applyRestore(preview, {});
  assert.equal((await snapshot(repository)).trips[0].routeState, 'pending');
  repository.close();
});
test('写入事务执行中收到取消，整批和草稿一起回滚', async () => {
  const { repository } = await setup();
  const draft = await repository.saveDraft({
      id: 'cancel-draft',
      revision: 0,
      raw: '保留',
    }),
    controller = new AbortController(),
    put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    const result = put.apply(this, args);
    if (this.name === 'trips') queueMicrotask(() => controller.abort());
    return result;
  };
  try {
    await assert.rejects(
      repository.saveTrips([trip()], {
        draftId: draft.id,
        draftRevision: draft.revision,
        signal: controller.signal,
      }),
      { name: 'AbortError' },
    );
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  const result = await snapshot(repository);
  assert.equal(result.trips.length, 0);
  assert.equal(result.drafts.length, 1);
  repository.close();
});
test('备份隔离记录与旧原文恢复到新库后仍可再次导出', async () => {
  const raw = JSON.stringify({
      version: 1,
      trips: [{ ...trip(), distance: -2 }],
    }),
    { repository: source } = await setup(raw),
    backup = await source.exportBackup(),
    { repository: target } = await setup();
  const preview = await target.previewRestore(backup);
  await target.applyRestore(preview, {});
  const recovered = await target.exportBackup();
  assert.ok(recovered.recovery.items.some((item) => item.raw?.distance === -2));
  assert.ok(recovered.recovery.items.some((item) => item.raw === raw));
  source.close();
  target.close();
});
