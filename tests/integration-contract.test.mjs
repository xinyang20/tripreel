import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createRepository } from '../dist/repository.js';
import {
  normalizeTrip,
  validateRecord,
  canRenderRoute,
} from '../dist/domain.js';
import {
  draftFromTrip,
  updateDraftField,
  tripFromDraft,
  chooseCandidate,
} from '../dist/editor-draft.js';
import { resolveBatchDraft } from '../dist/batch-resolver.js';
const train = {
  id: 'trip',
  mode: 'train',
  number: 'G1',
  travelDate: '2026-09-26',
  queryDate: '2026-09-26',
  departure: '2026-09-26T08:00',
  arrival: '2026-09-26T10:00',
  from: { name: '甲', coord: [118, 32] },
  to: { name: '乙', coord: [119, 32] },
  stops: [
    { name: '甲', coord: [118, 32] },
    { name: '乙', coord: [119, 32] },
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
  routeState: 'ready',
  routeConfirmed: true,
  revision: 1,
  routeRevision: 1,
  source: '12306',
  routeHistory: [],
};
test('更换为其他机场候选时不沿用旧机场的手工坐标', async () => {
  const input = {
    mode: 'flight',
    number: 'CA1001',
    date: '2026-09-26',
    from: '南京禄口',
    to: '成都双流',
    fromCoord: '118.8,32',
    toCoord: '103.95,30.58',
    fieldSources: {
      fromCoord: { source: 'manual' },
      toCoord: { source: 'manual' },
    },
  };
  const result = await resolveBatchDraft(input, {
    api: async () => ({
      date: '2026-09-26',
      source: '航旅纵横',
      flights: [
        {
          from: { name: '北京首都', coord: [116.6, 40.08] },
          to: { name: '成都双流', coord: [103.95, 30.58] },
          departure: '2026-09-26T08:00',
          arrival: '2026-09-26T10:00',
        },
      ],
    }),
  });
  const selected = chooseCandidate(
    { draft: input, warnings: [] },
    result.candidates[0],
  );
  assert.equal(selected.draft.from, '北京首都');
  assert.equal(selected.draft.fromCoord, undefined);
  assert.equal(selected.draft.toCoord, input.toCoord);
});
test('旧已核实行程仅改时刻且不重新查询，必须显示手动调整来源', () => {
  const draft = updateDraftField(
    draftFromTrip(train),
    'departure',
    '2026-09-26T08:15',
  );
  const next = tripFromDraft(draft, null, train, {
    original: train,
    routeConfirmed: true,
  });
  validateRecord(next);
  assert.equal(next.fieldSources.departure.source, 'manual');
  assert.match(next.source, /手动/);
  assert.deepEqual(next.routeCoordinates, train.routeCoordinates);
});
test('未确认示意正式保存后，再编辑接受候选无需联网即可恢复ready', async () => {
  const repository = createRepository({
    indexedDB: new IDBFactory(),
    legacyStorage: { getItem: () => null },
    dbName: 'candidate-confirmation',
    broadcast: false,
  });
  await repository.init();
  const candidate = {
    from: train.from,
    to: train.to,
    stops: train.stops,
    legs: train.legs,
    routeCoordinates: train.routeCoordinates,
    quality: 'station-schematic',
    requiresConfirmation: true,
    resolution: { state: 'needs-confirmation', requiresConfirmation: true },
    distance: 100,
  };
  const draft = draftFromTrip({
    ...train,
    id: 'candidate-trip',
    revision: 0,
    routeRevision: 0,
  });
  const pending = normalizeTrip(
    tripFromDraft(draft, null, candidate, { routeConfirmed: false }),
  );
  const [stored] = await repository.saveTrips([pending]);
  assert.equal(stored.routeState, 'pending');
  assert.equal(canRenderRoute(stored), false);
  assert.ok(stored.routeCandidate);
  const approved = normalizeTrip(
    tripFromDraft(draftFromTrip(stored), null, stored.routeCandidate, {
      original: stored,
      routeConfirmed: true,
    }),
  );
  assert.equal(approved.routeState, 'ready');
  assert.equal(canRenderRoute(approved), true);
  const [saved] = await repository.saveTrips([approved]);
  assert.equal(saved.routeConfirmed, true);
  assert.equal(saved.routeCandidate, null);
  repository.close();
});
test('备份未确认路线候选坏坐标应列为无效，而非绕过主路线校验', async () => {
  const repository = createRepository({
    indexedDB: new IDBFactory(),
    legacyStorage: { getItem: () => null },
    dbName: 'bad-candidate',
    broadcast: false,
  });
  await repository.init();
  const preview = await repository.previewRestore({
    version: 1,
    trips: [
      {
        ...train,
        routeState: 'pending',
        routeCoordinates: [],
        legs: [],
        routeCandidate: {
          from: train.from,
          to: train.to,
          routeCoordinates: [
            [118, 32],
            [999, 32],
          ],
          quality: 'station-schematic',
        },
      },
    ],
  });
  assert.equal(preview.entries[0].kind, 'invalid');
  repository.close();
});
test('后台取得可靠线路后清除旧未确认候选，避免编辑时又显示旧示意', async () => {
  const repository = createRepository({
    indexedDB: new IDBFactory(),
    legacyStorage: { getItem: () => null },
    dbName: 'candidate-retired',
    broadcast: false,
  });
  await repository.init();
  const candidate = {
    from: train.from,
    to: train.to,
    stops: train.stops,
    legs: train.legs,
    routeCoordinates: train.routeCoordinates,
    quality: 'station-schematic',
    requiresConfirmation: true,
    resolution: { state: 'needs-confirmation', requiresConfirmation: true },
    distance: 100,
  };
  const pending = normalizeTrip(
    tripFromDraft(
      draftFromTrip({ ...train, id: 'upgrade', revision: 0, routeRevision: 0 }),
      null,
      candidate,
      { routeConfirmed: false },
    ),
  );
  const [stored] = await repository.saveTrips([pending]);
  assert.equal(
    await repository.updateRoute(stored, {
      ...train,
      quality: 'latest',
      requiresConfirmation: false,
      resolution: { state: 'ready' },
    }),
    true,
  );
  const ready = (await repository.snapshot()).trips[0];
  assert.equal(ready.routeCandidate, null);
  assert.equal(
    ready.issues.some((issue) => issue.code === 'ROUTE_CONFIRMATION_REQUIRED'),
    false,
  );
  repository.close();
});

test('后台未确认示意仅更新候选，待补全保持pending，已有主线保持可用', async () => {
  for (const ready of [false, true]) {
    const repository = createRepository({
      indexedDB: new IDBFactory(),
      legacyStorage: { getItem: () => null },
      dbName: `candidate-background-${ready}`,
      broadcast: false,
    });
    await repository.init();
    const [current] = await repository.saveTrips([
      {
        ...train,
        id: 'background',
        revision: 0,
        routeRevision: 0,
        routeState: ready ? 'ready' : 'pending',
        routeConfirmed: ready,
        quality: ready ? 'latest' : 'pending',
        routeCoordinates: ready ? train.routeCoordinates : [],
        legs: ready ? train.legs : [],
      },
    ]);
    const candidate = {
      ...train,
      quality: 'station-schematic',
      requiresConfirmation: true,
      resolution: { state: 'needs-confirmation', requiresConfirmation: true },
    };
    if (ready)
      await assert.rejects(
        repository.updateRoute(current, candidate),
        /质量低/,
      );
    else assert.equal(await repository.updateRoute(current, candidate), true);
    const saved = (await repository.snapshot()).trips[0];
    assert.equal(saved.routeState, current.routeState);
    assert.equal(saved.routeConfirmed, current.routeConfirmed);
    assert.deepEqual(saved.routeCoordinates, current.routeCoordinates);
    if (!ready) assert.equal(saved.routeCandidate.quality, 'station-schematic');
    else assert.equal(saved.routeCandidate, undefined);
    assert.equal(saved.routeHistory.length, 0);
    assert.equal(canRenderRoute(saved), ready);
    if (!ready) {
      await assert.rejects(
        repository.updateRoute(saved, {
          ...candidate,
          quality: 'manual-schematic',
        }),
        /质量低/,
      );
      assert.equal(
        (await repository.snapshot()).trips[0].routeCandidate.quality,
        'station-schematic',
      );
      const approved = normalizeTrip(
        tripFromDraft(draftFromTrip(saved), null, saved.routeCandidate, {
          original: saved,
          routeConfirmed: true,
        }),
      );
      assert.equal(approved.routeState, 'ready');
      assert.equal(canRenderRoute(approved), true);
      await repository.saveTrips([approved]);
    }
    repository.close();
  }
});
