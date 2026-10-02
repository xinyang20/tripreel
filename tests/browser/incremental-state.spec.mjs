import { test, expect } from '@playwright/test';

const capabilities = (
  autoRefreshRoutes = false,
  sourceAutoRefresh = false,
) => ({
  deployment: 'local',
  railgoEnabled: true,
  notice: '',
  defaultRailProvider: 'railgo',
  autoRefreshRoutes,
  railProviders: [
    { id: 'railgo', label: 'RailGo（仅本机）', available: true },
    {
      id: 'osm-local',
      label: 'OSM 本地线路参考',
      available: true,
      ...(sourceAutoRefresh === undefined
        ? {}
        : { autoRefresh: sourceAutoRefresh }),
    },
  ],
});
const trip = (id, day, patch = {}) => ({
  id,
  mode: 'train',
  number: `G900${day}`,
  travelDate: `2030-01-0${day}`,
  departure: `2030-01-0${day}T08:00`,
  arrival: `2030-01-0${day}T10:00`,
  from: { name: '合成起点', coord: [118.79, 31.96] },
  to: { name: '合成终点', coord: [118.91, 32.12] },
  routeCoordinates: [
    [118.79, 31.96],
    [118.84, 32.06],
    [118.91, 32.12],
  ],
  routeState: 'ready',
  routeConfirmed: true,
  routeFrozen: true,
  quality: 'latest',
  distance: 22,
  stops: [],
  legs: [],
  revision: 0,
  ...patch,
});
async function ready(page, caps = capabilities()) {
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({ json: caps }),
  );
  await page.goto('/');
  await expect(page.locator('#add-trip')).toBeEnabled();
  await expect(page.locator('#default-rail-provider option')).toHaveCount(2);
}
async function frames(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

test('增量提交在下一帧前保持筛选范围及未变记录引用', async ({ page }) => {
  await ready(page);
  await page.evaluate(
    async (items) => {
      const store = await import('/store.js');
      await store.saveTrips(items);
      await store.saveGroup({ id: 'incremental-group', name: '合成分组' });
    },
    [trip('visible', 1), trip('hidden', 2)],
  );
  await page.locator('#filter-search').fill('G9001');
  await expect(page.locator('.trip-card')).toHaveCount(1);
  await frames(page);
  const result = await page.evaluate(
    async (addition) => {
      const store = await import('/store.js');
      const visible = store.state.saved.find((item) => item.id === 'visible');
      const hidden = store.state.saved.find((item) => item.id === 'hidden');
      const originalRaf = window.requestAnimationFrame;
      const originalCancel = window.cancelAnimationFrame;
      const queued = new Map();
      let nextId = -1;
      window.requestAnimationFrame = (callback) => {
        const id = nextId--;
        queued.set(id, callback);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        if (id < 0) queued.delete(id);
        else originalCancel.call(window, id);
      };
      try {
        await store.assignGroup(
          [{ id: hidden.id, revision: hidden.revision }],
          'incremental-group',
        );
        const grouped = store.state.saved.find((item) => item.id === hidden.id);
        const afterGroup = {
          ids: store.state.trips.map((item) => item.id),
          visibleSame: store.state.trips[0] === visible,
          geometrySame: grouped.routeCoordinates === hidden.routeCoordinates,
          groupId: grouped.groupId,
        };
        await store.saveTrips([addition]);
        return {
          afterGroup,
          afterSave: {
            ids: store.state.trips.map((item) => item.id),
            visibleSame: store.state.trips[0] === visible,
            hiddenSame:
              store.state.saved.find((item) => item.id === hidden.id) ===
              grouped,
            count: store.state.saved.length,
          },
          deferredFrames: queued.size,
        };
      } finally {
        window.requestAnimationFrame = originalRaf;
        window.cancelAnimationFrame = originalCancel;
        for (const callback of queued.values())
          originalRaf.call(window, callback);
      }
    },
    trip('new-hidden', 3),
  );
  expect(result.afterGroup).toEqual({
    ids: ['visible'],
    visibleSame: true,
    geometrySame: true,
    groupId: 'incremental-group',
  });
  expect(result.afterSave).toEqual({
    ids: ['visible'],
    visibleSame: true,
    hiddenSame: true,
    count: 3,
  });
  expect(result.deferredFrames).toBeGreaterThan(0);
  await expect(page.locator('.trip-card')).toHaveCount(1);
  await expect(page.locator('.trip-card')).toContainText('G9001');
});

for (const kind of ['single', 'batch']) {
  test(`${kind} 草稿在能力延迟返回期间保留 OSM 来源和已接受候选`, async ({
    page,
  }) => {
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    await page.route('**/api/capabilities', async (route) => {
      await hold;
      await route.fulfill({ json: capabilities() }).catch(() => {});
    });
    try {
      await page.goto('/');
      await expect(page.locator('#add-trip')).toBeEnabled();
      await page.evaluate(
        async ({ kind, route }) => {
          const store = await import('/store.js');
          const editor = await import('/editor.js');
          const row = {
            index: 0,
            line: 1,
            included: true,
            draft: {
              mode: 'train',
              provider: 'osm-local',
              number: 'G9001',
              date: '2030-01-01',
              from: '合成起点',
              to: '合成终点',
              departure: '2030-01-01T08:00',
              arrival: '2030-01-01T10:00',
            },
            route,
            routeIsCandidate: true,
            routeCandidateAccepted: true,
            needsResolve: false,
            warnings: [],
            candidates: [],
          };
          const draft = await store.saveDraft({
            id: `${kind}-slow-capabilities`,
            revision: 0,
            kind,
            ...(kind === 'single'
              ? { row }
              : {
                  rows: [row],
                  provider: 'osm-local',
                  raw: '火车 G9001 2030/1/1 合成起点-合成终点',
                  reviewText: '火车 G9001 2030/1/1 合成起点-合成终点',
                }),
          });
          editor.openEditor(kind === 'batch', null, draft);
        },
        {
          kind,
          route: trip('draft-route', 1, {
            quality: 'corridor',
            routeProvider: 'osm-local',
            routeSource: 'OpenStreetMap · 合成参考区间',
            routeDataVersion: 'synthetic-v1',
            requiresConfirmation: true,
          }),
        },
      );
      const provider = page.locator(
        kind === 'single' ? '#trip-provider' : '#batch-provider',
      );
      const accepted = page.locator(
        kind === 'single' ? '#single-route-confirm' : '[data-route-confirm]',
      );
      await expect(provider).toBeDisabled();
      await expect(accepted).toBeChecked();
      if (kind === 'batch')
        await page.locator('#batch-rows > details > summary').first().click();
      await accepted.uncheck();
      await accepted.check();
      await expect
        .poll(() =>
          page.evaluate(async (kind) => {
            const draft = (await (await import('/store.js')).listDrafts()).find(
              (item) => item.id === `${kind}-slow-capabilities`,
            );
            const row = kind === 'single' ? draft?.row : draft?.rows?.[0];
            return {
              saved: draft?.revision > 1,
              provider: row?.draft.provider,
              candidate: row?.routeCandidateAccepted,
              version: row?.route?.routeDataVersion,
            };
          }, kind),
        )
        .toEqual({
          saved: true,
          provider: 'osm-local',
          candidate: true,
          version: 'synthetic-v1',
        });
      release();
      await expect(provider).toBeEnabled();
      await expect(provider).toHaveValue('osm-local');
      await expect(accepted).toBeChecked();
      await expect(page.locator('#editor .route-preview')).toHaveCount(1);
      await expect(page.locator('#default-rail-provider')).toHaveValue(
        'railgo',
      );
    } finally {
      release();
    }
  });
}

test('OSM 禁止自动刷新，未知能力拒绝强制查询，能力明确后可主动查询', async ({
  page,
}) => {
  const requests = [];
  await page.route('**/api/route', (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { resolution: { state: 'unavailable' } } });
  });
  await ready(page, capabilities(true, false));
  await page.evaluate(
    async (item) => {
      const store = await import('/store.js');
      await store.saveTrips([item]);
      await store.savePreferences({ railProvider: 'osm-local' });
      store.state.capabilities = {
        deployment: 'unknown',
        railgoEnabled: false,
      };
      await (await import('/routes.js')).refreshStoredRoutes({ force: true });
    },
    trip('osm-refresh', 1, {
      routeFrozen: false,
      routeFetchedAt: null,
      quality: 'corridor',
      routeProvider: 'osm-local',
      routeSource: 'OpenStreetMap · 合成参考区间',
      requiresConfirmation: true,
    }),
  );
  await expect(page.locator('#route-update-status')).toContainText(
    '能力尚未确认',
  );
  await page.locator('#about-button').click();
  await page.locator('#refresh-routes').click();
  await expect(page.locator('#route-update-status')).toContainText(
    '能力尚未确认',
  );
  expect(requests).toHaveLength(0);
  await page.reload();
  await expect(page.locator('#default-rail-provider')).toHaveValue('osm-local');
  await expect(page.locator('.trip-card')).toHaveCount(1);
  await page.evaluate(async () =>
    (await import('/routes.js')).refreshStoredRoutes(),
  );
  expect(requests).toHaveLength(0);
  await page.evaluate(async () =>
    (await import('/routes.js')).refreshStoredRoutes({ force: true }),
  );
  expect(requests).toHaveLength(1);
  expect(requests[0].provider).toBe('osm-local');
});

test('旧版来源能力省略 autoRefresh 时仍兼容被动刷新', async ({ page }) => {
  const caps = capabilities(true);
  delete caps.railProviders[1].autoRefresh;
  const requests = [];
  await page.route('**/api/route', (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { resolution: { state: 'unavailable' } } });
  });
  await ready(page, caps);
  await page.evaluate(
    async (item) => {
      await (await import('/store.js')).saveTrips([item]);
      await (await import('/routes.js')).refreshStoredRoutes();
    },
    trip('legacy-refresh', 1, {
      routeFrozen: false,
      routeFetchedAt: null,
      routeProvider: 'osm-local',
    }),
  );
  expect(requests).toHaveLength(1);
  expect(requests[0].provider).toBe('osm-local');
});

test('仅编号和时间修改保留回放位置且不重建几何层', async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.__tripreelPerformance = {};
  });
  await ready(page);
  await page.evaluate(
    async (item) => (await import('/store.js')).saveTrips([item]),
    trip('replay-reference', 1),
  );
  await expect(page.locator('#map')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.trip-card')).toContainText('G9001');
  await expect
    .poll(() =>
      page.evaluate(() => globalThis.__tripreelPerformance.layers?.length || 0),
    )
    .toBeGreaterThan(0);
  await frames(page);
  await page.locator('#progress').fill('500');
  await page.evaluate(async () => {
    const store = await import('/store.js');
    globalThis.__tripreelPerformance = {};
    await store.saveTrips([{ ...store.state.saved[0], number: 'G9008' }]);
  });
  await expect(page.locator('.trip-card')).toContainText('G9008');
  await expect(page.locator('#progress')).toHaveValue('500');
  await page.evaluate(async () => {
    const store = await import('/store.js');
    await store.saveTrips([
      {
        ...store.state.saved[0],
        departure: '2030-01-01T08:10',
        arrival: '2030-01-01T10:10',
      },
    ]);
  });
  await expect(page.locator('.trip-card')).toContainText('08:10');
  await frames(page);
  const actual = await page.evaluate(async () => ({
    progress: (await import('/store.js')).state.progress,
    layers: globalThis.__tripreelPerformance.layers?.length || 0,
    mapSubmits: globalThis.__tripreelPerformance.mapSubmit?.length || 0,
  }));
  expect(actual.progress).toBeCloseTo(0.5, 6);
  expect(actual.layers).toBe(0);
  expect(actual.mapSubmits).toBe(2);
  await expect(page.locator('#progress')).toHaveValue('500');
});
