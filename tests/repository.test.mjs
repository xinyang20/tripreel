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
