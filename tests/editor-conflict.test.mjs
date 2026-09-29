import test from 'node:test';
import assert from 'node:assert/strict';
import {
  draftFromTrip,
  updateDraftField,
  rebaseEditorRow,
  editorConflictDifferences,
  tripFromDraft,
} from '../dist/editor-draft.js';

const base = {
  id: 'conflict-flight',
  mode: 'flight',
  number: 'CZ9001',
  revision: 1,
  routeRevision: 1,
  travelDate: '2027-03-04',
  from: { name: '合肥新桥', coord: [116.978, 31.989] },
  to: { name: '昆明长水', coord: [102.93, 25.102] },
  departure: '2027-03-04T08:00',
  arrival: '2027-03-04T10:00',
  source: '航旅纵横',
  status: '计划',
  quality: 'schematic',
  routeState: 'ready',
  routeConfirmed: true,
  referenceAccepted: true,
  stops: [],
  legs: [],
  routeCoordinates: [],
  distance: 1700,
  fieldSources: {
    departure: { source: 'lookup' },
    arrival: { source: 'lookup' },
  },
};
const row = (draft = draftFromTrip(base)) => ({
  draft,
  route: structuredClone(base),
  lookup: null,
  routeConfirmed: true,
  warnings: [],
});

test('冲突合并只采用本次变更，其他字段和后台新几何保留当前版本', () => {
  const draft = updateDraftField(
    draftFromTrip(base),
    'departure',
    '2027-03-04T08:30',
  );
  const current = {
    ...base,
    revision: 2,
    routeRevision: 3,
    arrival: '2027-03-04T11:00',
    distance: 1720,
    from: { ...base.from, coord: [116.98, 31.99] },
  };
  const merged = rebaseEditorRow(row(draft), base, current);
  assert.equal(merged.draft.departure, draft.departure);
  assert.equal(merged.draft.arrival, current.arrival);
  assert.equal(merged.draft.revision, 2);
  assert.deepEqual(merged.route.from.coord, current.from.coord);
  assert.equal(merged.route.distance, 1720);
  assert.equal(merged.routeConfirmed, true);
  const saved = tripFromDraft(merged.draft, merged.lookup, merged.route, {
    original: current,
    routeConfirmed: merged.routeConfirmed,
  });
  assert.equal(saved.routeRevision, 3);
  assert.deepEqual(saved.from.coord, current.from.coord);
  assert.equal(saved.arrival, current.arrival);
  assert.equal(base.revision, 1);
});

test('同一字段冲突有当前值与草稿值，明确确认后保留本次修改', () => {
  const draft = updateDraftField(
    draftFromTrip(base),
    'departure',
    '2027-03-04T08:30',
  );
  const current = { ...base, revision: 2, departure: '2027-03-04T09:00' };
  const diff = editorConflictDifferences(row(draft), current).find(
    (item) => item.key === 'departure',
  );
  assert.equal(diff.draft, draft.departure);
  assert.equal(diff.current, current.departure);
  assert.equal(
    rebaseEditorRow(row(draft), base, current).draft.departure,
    draft.departure,
  );
});

test('其他页面改变航班身份时保留其自动时刻，本页手工时间仍可合并', () => {
  const draft = updateDraftField(
    draftFromTrip(base),
    'departure',
    '2027-03-04T08:30',
  );
  const current = {
    ...base,
    revision: 2,
    number: 'CZ9002',
    arrival: '2027-03-04T11:00',
  };
  const merged = rebaseEditorRow(row(draft), base, current);
  assert.equal(merged.draft.number, 'CZ9002');
  assert.equal(merged.draft.departure, draft.departure);
  assert.equal(merged.draft.arrival, current.arrival);
  assert.equal(merged.draft.fieldSources.arrival.source, 'lookup');
});

test('本次改变路线输入后不携带旧几何覆盖并发新路线', () => {
  const draft = updateDraftField(draftFromTrip(base), 'to', '成都双流');
  const current = { ...base, routeRevision: 2 };
  const merged = rebaseEditorRow(row(draft), base, current);
  assert.equal(merged.route, null);
  assert.equal(merged.routeConfirmed, false);
  assert.equal(merged.needsResolve, true);
  const saved = tripFromDraft(merged.draft, null, merged.route, {
    original: current,
  });
  assert.equal(saved.routeState, 'pending');
  assert.deepEqual(saved.routeCoordinates, []);
  assert.equal(saved.to.name, '成都双流');
});

test('已删除的行程不能通过冲突重试自动建立', () => {
  assert.throws(() => rebaseEditorRow(row(), base, null), { code: 'CONFLICT' });
  assert.ok(
    editorConflictDifferences(row(), null).every(
      (item) => item.current === '已删除',
    ),
  );
});
