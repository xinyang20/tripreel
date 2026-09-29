// 草稿使用合成班次、日期和时刻，不关联真实乘车记录。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeDraft,
  updateDraftField,
  chooseCandidate,
  tripFromDraft,
  draftFromTrip,
  clearAutomaticTimes,
  hasReferenceFields,
  routePreviewMarkup,
} from '../dist/editor-draft.js';
import {
  normalizeTrip,
  validateRecord,
  canReplay,
  canRenderRoute,
} from '../dist/domain.js';
import { routeRequest } from '../dist/batch-review.js';
const input = {
  mode: 'train',
  number: 'G9003',
  date: '2030-03-04',
  from: '天津南',
  to: '南京南',
  departure: '2030-03-04T08:00',
  arrival: '2030-03-04T12:00',
};
const from = { name: '天津南', coord: [117, 39] },
  to = { name: '南京南', coord: [118.8, 31.9] };
const route = {
  from,
  to,
  routeCoordinates: [from.coord, to.coord],
  stops: [from, to],
  legs: [{ from: from.name, to: to.name, coordinates: [from.coord, to.coord] }],
  quality: 'latest',
  distance: 850,
  resolution: { state: 'ready' },
};

test('手动编辑保留来源，日期变更清理自动时间并平移人工时间', () => {
  const d = initializeDraft(input);
  d.fieldSources.arrival = { source: 'reference', referenceDate: '2030-03-18' };
  const changed = updateDraftField(d, 'date', '2030-03-05');
  assert.equal(changed.departure, '2030-03-05T08:00');
  assert.equal(changed.arrival, undefined);
  assert.equal(changed.fieldSources.date.source, 'manual');
  assert.equal(changed.travelDate, '2030-03-05');
  assert.equal(d.date, '2030-03-04');
});
test('重查清理自动时刻，保留原文与手工时刻', () => {
  const d = initializeDraft(input);
  d.fieldSources.departure = { source: 'lookup' };
  d.fieldSources.arrival = { source: 'manual' };
  const cleared = clearAutomaticTimes(d);
  assert.equal(cleared.departure, undefined);
  assert.equal(cleared.arrival, input.arrival);
});
test('选择候选不覆盖选择之前手动修改的时刻，保留来源警告', () => {
  const d = updateDraftField(
    initializeDraft(input),
    'departure',
    '2030-03-04T08:30',
  );
  const candidate = {
    draft: { ...input, departure: '2030-03-04T07:50' },
    lookup: {
      isReference: true,
      referenceDate: '2030-03-18',
      note: '参考时刻',
    },
    warnings: [],
  };
  const r = chooseCandidate(
    { draft: d, warnings: ['机场笔误已纠正', '查询到多个航段'] },
    candidate,
  );
  assert.equal(r.draft.departure, '2030-03-04T08:30');
  assert.equal(r.draft.fieldSources.departure.source, 'manual');
  assert.ok(r.warnings.includes('机场笔误已纠正'));
  assert.ok(r.warnings.includes('参考时刻'));
  assert.equal(r.routeConfirmed, false);
});
test('缺时刻坐标路线可形成正式待补全记录，不伪造坐标或时刻', () => {
  const { departure: _a, arrival: _b, ...partial } = input;
  const trip = normalizeTrip(tripFromDraft(partial, null, null));
  validateRecord(trip);
  assert.equal(trip.departure, null);
  assert.equal(trip.from.coord, null);
  assert.equal(trip.routeState, 'pending');
  assert.equal(trip.groupId, null);
  assert.equal(canReplay(trip), false);
});
test('已有可靠线路但缺时间仍可显示路线，不允许回放', () => {
  const d = { ...input, departure: null, arrival: null };
  const trip = normalizeTrip(tripFromDraft(d, null, route));
  validateRecord(trip);
  assert.equal(trip.routeState, 'ready');
  assert.equal(canRenderRoute(trip), true);
  assert.equal(canReplay(trip), false);
});
test('非参考完整记录可以回放，不被默认参考确认标记阻止', () => {
  const trip = normalizeTrip(tripFromDraft(input, null, route));
  validateRecord(trip);
  assert.equal(trip.referenceAccepted, true);
  assert.equal(trip.routeConfirmed, true);
  assert.equal(canReplay(trip), true);
});
test('停站连线必须主动确认，未确认候选保留用于后续补全', () => {
  const schematic = {
    ...route,
    quality: 'station-schematic',
    requiresConfirmation: true,
    resolution: { state: 'needs-confirmation' },
  };
  const pending = normalizeTrip(tripFromDraft(input, null, schematic));
  assert.equal(pending.routeState, 'pending');
  assert.equal(canRenderRoute(pending), false);
  assert.equal(pending.routeCoordinates.length, 0);
  assert.ok(pending.routeCandidate.routeCoordinates.length);
  const accepted = normalizeTrip(
    tripFromDraft(input, null, schematic, { routeConfirmed: true }),
  );
  assert.equal(canRenderRoute(accepted), true);
  assert.equal(canReplay(accepted), true);
});
test('参考时刻未接受时不能回放，接受后保持参考出处', () => {
  const lookup = {
    isReference: true,
    referenceDate: '2030-03-18',
    note: '今日参考',
  };
  const pending = normalizeTrip(tripFromDraft(input, lookup, route));
  assert.equal(canReplay(pending), false);
  const accepted = normalizeTrip(
    tripFromDraft(input, lookup, route, { referenceAccepted: true }),
  );
  assert.equal(canReplay(accepted), true);
  assert.equal(accepted.isReference, true);
  assert.equal(accepted.referenceDate, '2030-03-18');
});
test('编辑历史记录保留基准版本与参考来源', () => {
  const original = normalizeTrip({
    ...tripFromDraft(input, null, route),
    revision: 4,
    isReference: true,
    referenceDate: '2030-03-18',
    source: '12306 · 参考',
    routeHistory: [{ id: 'route-old' }],
  });
  const d = draftFromTrip(original);
  const edited = tripFromDraft(d, null, route, {
    original,
    referenceAccepted: true,
  });
  assert.equal(edited.revision, 4);
  assert.equal(edited.isReference, true);
  assert.equal(edited.referenceDate, '2030-03-18');
  assert.deepEqual(edited.routeHistory, original.routeHistory);
});
test('重复站名称使用选择的站次生成中途区间和请求', () => {
  const stops = ['天津南', '南京南', '天津南', '济南西', '南京南'].map(
    (name) => ({ name }),
  );
  const body = routeRequest(
    { ...input, fromStopIndex: 2, toStopIndex: 4 },
    { date: input.date, stops },
  );
  assert.equal(body.via, '济南西');
  assert.equal(body.fromStopIndex, 2);
  assert.equal(body.toStopIndex, 4);
});
test('路线预览只在取得路线或飞行端点时生成', () => {
  assert.equal(routePreviewMarkup(null, 'train'), '');
  assert.match(routePreviewMarkup(route, 'train'), /<polyline/);
  assert.match(routePreviewMarkup({ from, to }, 'flight'), /<polyline/);
});

const oldFlight = {
  id: 'old-flight',
  revision: 3,
  mode: 'flight',
  number: 'CZ9001',
  travelDate: '2027-03-04',
  queryDate: '2027-03-01',
  departure: '2027-03-04T08:00',
  arrival: '2027-03-04T10:00',
  from: { name: '合肥新桥', coord: [116.978, 31.989] },
  to: { name: '昆明长水', coord: [102.93, 25.102] },
  airline: '旧航空公司',
  status: '时刻参考',
  referenceStatus: '已取消',
  isReference: true,
  referenceDate: '2027-03-01',
  scheduleWarning: '旧参考提示',
  scheduleProvenance: { source: '旧来源', sourceDate: '2027-03-01' },
  source: '航旅纵横 · 2027-03-01 参考',
  fieldSources: {
    departure: { source: 'reference', referenceDate: '2027-03-01' },
    arrival: { source: 'lookup' },
  },
};

test('任一行程身份字段变化后，失败查询保存待补全不会继承旧航班状态', () => {
  for (const [key, value] of [
    ['mode', 'train'],
    ['number', 'CZ9002'],
    ['date', '2027-03-05'],
    ['from', '南京禄口'],
    ['to', '成都双流'],
  ]) {
    const changed = updateDraftField(draftFromTrip(oldFlight), key, value);
    assert.equal(changed.isReference, undefined, key);
    assert.equal(changed.departure, undefined, key);
    assert.equal(changed.fieldSources.departure, undefined, key);
    const trip = tripFromDraft(changed, null, null, { original: oldFlight });
    for (const field of [
      'airline',
      'status',
      'referenceStatus',
      'scheduleProvenance',
    ])
      assert.equal(trip[field], undefined, `${key}: ${field}`);
    assert.equal(trip.source, '手动填写', key);
    assert.equal(trip.isReference, false, key);
    assert.equal(trip.referenceDate, null, key);
    assert.equal(trip.scheduleWarning, null, key);
    assert.equal(trip.routeState, 'pending', key);
    assert.equal(trip.queryDate, changed.date, key);
    assert.equal(trip.revision, oldFlight.revision, key);
  }
});

test('保存层也清理直接改变身份的旧查询信息，但保留用户输入的时刻', () => {
  const draft = draftFromTrip(oldFlight);
  draft.number = 'CZ9002';
  draft.fieldSources.departure = { source: 'manual' };
  draft.fieldSources.arrival = { source: 'text' };
  const trip = tripFromDraft(draft, null, null, { original: oldFlight });
  assert.equal(trip.departure, oldFlight.departure);
  assert.equal(trip.arrival, oldFlight.arrival);
  assert.equal(trip.fieldSources.departure.source, 'manual');
  assert.equal(trip.fieldSources.arrival.source, 'text');
  assert.equal(trip.status, undefined);
  assert.equal(trip.source, '手动填写');
  assert.equal(trip.isReference, false);
});

test('新身份成功查询使用新航班状态，同一身份只改时间保留原出处', () => {
  const changed = updateDraftField(
    draftFromTrip(oldFlight),
    'number',
    'CZ9002',
  );
  const refreshed = tripFromDraft(
    changed,
    { selected: { airline: '新航空公司', status: '计划' } },
    null,
    { original: oldFlight },
  );
  assert.equal(refreshed.airline, '新航空公司');
  assert.equal(refreshed.status, '计划');
  assert.equal(refreshed.referenceStatus, undefined);
  assert.equal(refreshed.isReference, false);
  assert.equal(refreshed.source, '航旅纵横');
  const edited = updateDraftField(
    draftFromTrip(oldFlight),
    'departure',
    '2027-03-04T08:30',
  );
  const sameFlight = tripFromDraft(edited, null, null, { original: oldFlight });
  assert.equal(sameFlight.airline, oldFlight.airline);
  assert.equal(sameFlight.referenceStatus, oldFlight.referenceStatus);
  assert.equal(sameFlight.isReference, true);
  assert.equal(sameFlight.source, `手动调整 · ${oldFlight.source}`);
});

test('已清空字段的参考来源不产生虚假的参考确认要求', () => {
  const draft = initializeDraft({ ...input, arrival: null });
  draft.fieldSources.arrival = { source: 'reference' };
  assert.equal(hasReferenceFields(draft, null), false);
});
