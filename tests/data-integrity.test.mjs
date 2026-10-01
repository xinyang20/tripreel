import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createRepository } from '../dist/repository.js';
import {
  actualTravelDate,
  journeyKey,
  validateRecord,
  normalizeTrip,
  canReplay,
} from '../dist/domain.js';
import { sameJourney } from '../dist/batch-review.js';
import { validateDraft } from '../dist/draft-validation.js';

const trip = (id = 'a', date = '2030-01-02') => ({
  id,
  mode: 'flight',
  number: 'CA9001',
  travelDate: date,
  departure: `${date}T08:00`,
  arrival: `${date}T10:00`,
  from: { name: '甲机场', coord: [118, 32] },
  to: { name: '乙机场', coord: [119, 33] },
  quality: 'schematic',
  routeState: 'ready',
  routeConfirmed: true,
  revision: 0,
  routeRevision: 0,
  distance: 100,
});
const mismatch = () => ({ ...trip(), travelDate: '2030-01-03' });
const draft = () => ({
  id: 'draft',
  kind: 'batch',
  raw: '未完成原文',
  rows: [
    {
      draft: { mode: 'train', number: 'G1', date: '2030-01-04' },
      warnings: [],
    },
  ],
});
const backup = (trips = [], drafts = []) => ({
  format: 'travel-trace-backup',
  version: 2,
  trips,
  drafts,
});
async function setup(legacy) {
  const repository = createRepository({
    indexedDB: new IDBFactory(),
    legacyStorage: { getItem: () => legacy || null },
    broadcast: false,
  });
  await repository.init();
  return repository;
}

test('实际日期、地点身份在批量、正式记录与缺时刻数据之间一致', () => {
  const old = mismatch();
  const input = {
    mode: 'flight',
    number: 'ca9001',
    date: old.travelDate,
    from: '甲国际机场',
    to: '乙机场',
  };
  assert.equal(sameJourney(input, old), true);
  assert.equal(journeyKey(input), journeyKey(old));
  assert.equal(actualTravelDate({ queryDate: '2030-01-03' }), '');
  assert.equal(actualTravelDate({ departure: { bad: true } }), '');
  assert.throws(() => validateRecord({ ...trip(), travelDate: {} }), /日期/);
  assert.equal(
    actualTravelDate({
      departure: '2030-01-02T08:00',
      queryDate: '2030-01-01',
    }),
    '2030-01-02',
  );
  for (const suffix of ['站', '火车站', '高铁站'])
    assert.equal(
      journeyKey({ ...input, from: '甲' + suffix }),
      journeyKey({ ...input, from: '甲' }),
    );
});

test('新写入日期矛盾定位两个字段，跨午夜和不同始发查询日仍合法', () => {
  assert.throws(
    () => validateRecord(mismatch()),
    (error) => {
      assert.equal(error.code, 'DATE_MISMATCH');
      assert.deepEqual(error.fields, ['date', 'departure']);
      return true;
    },
  );
  const old = normalizeTrip(mismatch());
  assert.equal(old.travelDate, '2030-01-03');
  assert.equal(old.departure, '2030-01-02T08:00');
  assert.equal(canReplay(old), false);
  assert.ok(old.issues.some((issue) => issue.code === 'date-mismatch'));
  assert.doesNotThrow(() =>
    validateRecord({
      ...trip(),
      queryDate: '2030-01-01',
      arrival: '2030-01-03T01:00',
    }),
  );
});

test('迁移保留日期矛盾记录，不阻塞无关新增；编辑该记录仍需修正', async () => {
  const raw = JSON.stringify({ version: 1, trips: [mismatch()] });
  const repo = await setup(raw);
  try {
    let snapshot = await repo.snapshot();
    assert.equal(snapshot.trips.length, 1);
    assert.equal(snapshot.recovery.rawLegacy, raw);
    assert.equal(canReplay(snapshot.trips[0]), false);
    await repo.saveTrips([trip('b', '2030-01-05')]);
    await assert.rejects(repo.saveTrips([snapshot.trips[0]]), {
      code: 'DATE_MISMATCH',
    });
    await repo.saveTrips([{ ...snapshot.trips[0], travelDate: '2030-01-02' }]);
    snapshot = await repo.snapshot();
    assert.equal(snapshot.trips.length, 2);
    assert.equal(
      canReplay(snapshot.trips.find((item) => item.id === 'a')),
      true,
    );
  } finally {
    repo.close();
  }
});

test('恢复矛盾日期提供问题说明并原样保存；恢复预览按实际日期识别重复', async () => {
  const repo = await setup();
  try {
    const preview = await repo.previewRestore(backup([mismatch()]));
    assert.equal(preview.entries[0].kind, 'new');
    assert.equal(preview.entries[0].issues[0].code, 'date-mismatch');
    await repo.applyRestore(preview);
    const saved = (await repo.snapshot()).trips[0];
    assert.equal(saved.departure, mismatch().departure);
    assert.equal(canReplay(saved), false);
    const pending = {
      ...trip('other', '2030-01-03'),
      departure: null,
      arrival: null,
    };
    assert.equal(
      (await repo.previewRestore(backup([pending]))).entries[0].kind,
      'conflict',
    );
    await repo.saveTrips([trip('b', '2030-01-06')]);
  } finally {
    repo.close();
  }
});

test('草稿校验允许不完整输入与旧包装，拒绝损坏行、候选、版本和坐标', () => {
  const valid = draft();
  valid.rows[0].draft.fieldSources = {
    number: { source: 'text' },
    departure: { source: 'manual' },
    arrival: 'legacy',
  };
  const restored = validateDraft({ id: 'draft', payload: valid });
  assert.deepEqual(restored.rows[0].draft, valid.rows[0].draft);
  assert.equal(restored.rows[0].index, 0);
  assert.equal(restored.rows[0].line, 1);
  assert.doesNotThrow(() =>
    validateDraft({
      id: 'single',
      kind: 'single',
      row: {
        draft: {
          mode: 'train',
          fromCoord: '尚未填完',
          departure: '错误输入待修正',
        },
      },
    }),
  );
  assert.doesNotThrow(() =>
    validateDraft({
      ...valid,
      rows: [{ draft: null, error: '原文解析失败', line: 1 }],
    }),
  );
  for (const bad of [
    { ...valid, rows: [{ ...valid.rows[0], draft: { fieldSources: 'oops' } }] },
    { ...valid, rows: [{ ...valid.rows[0], route: { legs: [null] } }] },
    { ...valid, rows: [{ ...valid.rows[0], lookup: { stops: [null] } }] },
    {
      ...valid,
      rows: [
        { ...valid.rows[0], lookup: { stops: [{ name: '甲', departure: 3 }] } },
      ],
    },
    { ...valid, rows: [{ draft: null, error: '解析失败', route: {} }] },
    { ...valid, rows: {} },
    { ...valid, kind: '' },
    { ...valid, kind: 'future' },
    { ...valid, schemaVersion: 99 },
    { ...valid, version: 99 },
    { ...valid, rows: Array(21).fill(valid.rows[0]) },
    { id: 'single', kind: 'single', row: {} },
    { ...valid, rows: [{ ...valid.rows[0], candidates: [{}] }] },
    {
      ...valid,
      rows: [{ ...valid.rows[0], route: { from: { coord: [999, 32] } } }],
    },
    { ...valid, rows: [{ ...valid.rows[0], lookup: { stops: {} } }] },
  ])
    assert.throws(() => validateDraft(bad), /草稿无法继续/);
});

test('损坏草稿隔离后有效正式记录和草稿可原子恢复，原文支持再次导出', async () => {
  const repo = await setup();
  const broken = { id: 'broken', kind: 'batch', rows: { oops: true } };
  try {
    const preview = await repo.previewRestore(
      backup([trip()], [broken, draft()]),
    );
    assert.equal(preview.extraIssues.length, 1);
    assert.equal(preview.drafts.length, 1);
    await repo.applyRestore(preview);
    const saved = await repo.exportBackup();
    assert.equal(saved.trips.length, 1);
    assert.equal(saved.drafts.length, 1);
    assert.deepEqual(saved.recovery.items[0].raw, broken);
    const other = await setup();
    try {
      await other.applyRestore(await other.previewRestore(saved));
      assert.deepEqual(
        (await other.exportBackup()).recovery.items[0].raw,
        broken,
      );
    } finally {
      other.close();
    }
  } finally {
    repo.close();
  }
});

test('提交恢复时再次校验草稿，失效或篡改的预览不会部分提交', async () => {
  const repo = await setup();
  try {
    const preview = await repo.previewRestore(backup([trip()], [draft()]));
    preview.drafts[0].rows = {};
    await assert.rejects(repo.applyRestore(preview), /草稿/);
    assert.equal((await repo.snapshot()).trips.length, 0);
  } finally {
    repo.close();
  }
});
