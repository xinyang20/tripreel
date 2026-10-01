import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createRepository } from '../dist/repository.js';
import { canRenderRoute, normalizeTrip } from '../dist/domain.js';
import {
  draftFromTrip,
  tripFromDraft,
  updateDraftField,
  routeReviewFromTrip,
  restoreRouteReview,
  routeReviewAccepted,
  rebaseEditorRow,
} from '../dist/editor-draft.js';

const from = { name: '合成起点', coord: [118, 32] },
  to = { name: '合成终点', coord: [119, 32] },
  route = {
    from,
    to,
    stops: [from, to],
    routeCoordinates: [from.coord, to.coord],
    quality: 'manual-schematic',
    requiresConfirmation: true,
    resolution: { state: 'needs-confirmation', requiresConfirmation: true },
  };
const fixture = () =>
  normalizeTrip({
    id: 'route-review-fixture',
    mode: 'train',
    number: 'G9001',
    travelDate: '2030-03-04',
    departure: '2030-03-04T08:00',
    arrival: '2030-03-04T12:00',
    ...route,
    routeConfirmed: true,
  });
const candidate = {
  ...route,
  quality: 'station-schematic',
  routeCoordinates: [from.coord, [118.4, 32.3], to.coord],
};
const edit = (original) => ({
  draft: draftFromTrip(original),
  ...routeReviewFromTrip(original),
});
const saveInput = (row, original) =>
  normalizeTrip(
    tripFromDraft(row.draft, null, row.route, {
      original,
      routeConfirmed: routeReviewAccepted(row),
    }),
  );

test('后台候选与已确认主线独立保存，只有明确接受才替换并归档', async () => {
  const repository = createRepository({
    indexedDB: new IDBFactory(),
    legacyStorage: { getItem: () => null },
    dbName: crypto.randomUUID(),
    broadcast: false,
  });
  try {
    await repository.init();
    const [base] = await repository.saveTrips([fixture()]);
    await repository.updateRoute(base, candidate);
    let stored = (await repository.snapshot()).trips[0],
      row = edit(stored);
    assert.equal(row.routeCandidateAccepted, false);
    assert.equal(routeReviewAccepted(row), false);
    [stored] = await repository.saveTrips([saveInput(row, stored)]);
    assert.equal(stored.quality, 'manual-schematic');
    assert.deepEqual(stored.routeCoordinates, route.routeCoordinates);
    assert.deepEqual(
      stored.routeCandidate.routeCoordinates,
      candidate.routeCoordinates,
    );
    assert.equal(stored.routeHistory.length, 0);

    row = edit(stored);
    row.draft = updateDraftField(row.draft, 'departure', '2030-03-04T08:30');
    [stored] = await repository.saveTrips([saveInput(row, stored)]);
    assert.equal(stored.routeConfirmed, true);
    assert.equal(canRenderRoute(stored), true);
    assert.equal(stored.departure, '2030-03-04T08:30');
    assert.deepEqual(stored.routeCoordinates, route.routeCoordinates);
    assert.deepEqual(
      stored.routeCandidate.routeCoordinates,
      candidate.routeCoordinates,
    );
    assert.equal(stored.routeHistory.length, 0);

    row = edit(stored);
    row.routeCandidateAccepted = true;
    [stored] = await repository.saveTrips([saveInput(row, stored)]);
    assert.equal(stored.quality, 'station-schematic');
    assert.equal(stored.routeCandidate, null);
    assert.deepEqual(stored.routeCoordinates, candidate.routeCoordinates);
    assert.equal(stored.routeHistory.length, 1);
    assert.deepEqual(
      stored.routeHistory[0].routeCoordinates,
      route.routeCoordinates,
    );
  } finally {
    repository.close();
  }
});

test('已确认示意主线仅改时间可复用，路线输入变化不沿用主线或候选', () => {
  const original = fixture(),
    row = edit(original);
  row.draft = updateDraftField(row.draft, 'departure', '2030-03-04T08:30');
  assert.equal(row.draft.routeConfirmed, true);
  const updated = saveInput(row, original);
  assert.equal(updated.routeState, 'ready');
  assert.equal(updated.routeConfirmed, true);
  assert.deepEqual(updated.routeCoordinates, original.routeCoordinates);
  for (const [field, value] of [
    ['number', 'G9002'],
    ['date', '2030-03-05'],
    ['from', '新起点'],
    ['via', '新增途经点'],
    ['fromCoord', '118.1,32.1'],
  ]) {
    const changed = updateDraftField(draftFromTrip(original), field, value);
    const result = normalizeTrip(
      tripFromDraft(changed, null, null, {
        original: { ...original, routeCandidate: candidate },
      }),
    );
    assert.equal(result.routeState, 'pending', field);
    assert.equal(result.routeCandidate, null, field);
    assert.deepEqual(result.routeCoordinates, [], field);
  }
});

test('旧草稿不把主线确认当作候选确认，新草稿的明确候选选择可恢复', () => {
  const original = { ...fixture(), routeCandidate: candidate },
    legacy = {
      draft: draftFromTrip(original),
      route: candidate,
      routeConfirmed: true,
    };
  for (const prior of [original, undefined]) {
    const restored = restoreRouteReview(legacy, prior);
    assert.equal(restored.routeIsCandidate, true);
    assert.equal(routeReviewAccepted(restored), false);
  }
  const legacyMain = restoreRouteReview(
    { ...legacy, route: original },
    original,
  );
  assert.equal(legacyMain.routeIsCandidate, false);
  assert.equal(routeReviewAccepted(legacyMain), true);
  assert.deepEqual(
    saveInput(legacyMain, original).routeCandidate.routeCoordinates,
    candidate.routeCoordinates,
  );
  const explicit = edit(original);
  explicit.routeCandidateAccepted = true;
  const restored = restoreRouteReview(structuredClone(explicit), original);
  assert.equal(routeReviewAccepted(restored), true);
  assert.equal(saveInput(restored, original).quality, 'station-schematic');
});

test('并发冲突合并只改时刻时保留最新主线与待确认候选', () => {
  const base = fixture(),
    latest = { ...base, routeCandidate: candidate, routeRevision: 2 },
    row = edit(base);
  row.draft = updateDraftField(row.draft, 'departure', '2030-03-04T08:30');
  const merged = rebaseEditorRow(row, base, latest),
    result = saveInput(merged, latest);
  assert.equal(merged.routeCandidateAccepted, false);
  assert.equal(result.departure, '2030-03-04T08:30');
  assert.deepEqual(result.routeCoordinates, base.routeCoordinates);
  assert.deepEqual(
    result.routeCandidate.routeCoordinates,
    candidate.routeCoordinates,
  );
});

test('旧版ready但未确认的示意主线仍提供明确确认入口', () => {
  const original = normalizeTrip({ ...fixture(), routeConfirmed: false }),
    row = edit(original);
  assert.equal(row.routeIsCandidate, true);
  assert.equal(routeReviewAccepted(row), false);
  row.routeCandidateAccepted = true;
  assert.equal(canRenderRoute(saveInput(row, original)), true);
});

test('修正矛盾实际日期时保留手工与旧时刻，自动时刻仍按原规则清除', () => {
  for (const source of ['manual', 'legacy']) {
    const draft = draftFromTrip({ ...fixture(), travelDate: '2030-03-05' });
    draft.fieldSources.departure = { source };
    draft.fieldSources.arrival = { source };
    const corrected = updateDraftField(draft, 'date', '2030-03-04');
    assert.equal(corrected.date, '2030-03-04');
    assert.equal(corrected.travelDate, '2030-03-04');
    assert.equal(corrected.departure, draft.departure);
    assert.equal(corrected.arrival, draft.arrival);
  }
  const automatic = draftFromTrip({ ...fixture(), travelDate: '2030-03-05' });
  automatic.fieldSources.departure = { source: 'lookup' };
  automatic.fieldSources.arrival = { source: 'reference' };
  const corrected = updateDraftField(automatic, 'date', '2030-03-04');
  assert.equal(corrected.departure, undefined);
  assert.equal(corrected.arrival, undefined);
  const regular = updateDraftField(
    draftFromTrip(fixture()),
    'date',
    '2030-03-05',
  );
  assert.equal(regular.departure, '2030-03-05T08:00');
  assert.equal(regular.arrival, '2030-03-05T12:00');
});
