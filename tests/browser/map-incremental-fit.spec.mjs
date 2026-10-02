import { test, expect } from '@playwright/test';

const trip = (id, day, from, to) => ({
  id,
  mode: 'train',
  number: `G901${day}`,
  travelDate: `2030-01-0${day}`,
  departure: `2030-01-0${day}T08:00`,
  arrival: `2030-01-0${day}T10:00`,
  from: { name: `${id}起点`, coord: from },
  to: { name: `${id}终点`, coord: to },
  routeCoordinates: [from, to],
  routeState: 'ready',
  routeConfirmed: true,
  routeFrozen: true,
  quality: 'latest',
  distance: 22,
  revision: 0,
});

test('同范围线路更新保留当前段取景，自由视角不改相机，播放资格全部撤回立即暂停', async ({
  page,
}) => {
  await page.addInitScript(() => {
    globalThis.__tripreelPerformance = {};
  });
  await page.goto('/');
  await expect(page.locator('#add-trip')).toBeEnabled();
  await expect(page.locator('#map')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(
    async (items) => {
      await (await import('/store.js')).saveTrips(items);
    },
    [
      trip('near', 1, [118.79, 31.96], [118.91, 32.12]),
      trip('far', 2, [87.5, 43.8], [90, 45]),
    ],
  );
  await expect(page.locator('.trip-card')).toHaveCount(2);
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    const { Map } = await import('/vendor/maplibre-gl.mjs'),
      original = Map.prototype.easeTo,
      getContainer = Map.prototype.getContainer;
    globalThis.__cameraCalls = [];
    Map.prototype.getContainer = function (...args) {
      const container = getContainer.apply(this, args);
      if (container.id === 'map') globalThis.__testMap = this;
      return container;
    };
    Map.prototype.easeTo = function (camera, ...rest) {
      if (this.getContainer().id === 'map') {
        if (typeof camera.zoom === 'number')
          globalThis.__cameraCalls.push({
            zoom: camera.zoom,
            center: camera.center,
          });
      }
      return original.call(this, camera, ...rest);
    };
    try {
      (await import('/map.js')).selectTrip('near');
    } finally {
      Map.prototype.getContainer = getContainer;
    }
  });
  await page.waitForFunction(
    () => globalThis.__testMap.loaded() && !globalThis.__testMap.isMoving(),
  );
  const nearZoom = await page.evaluate(() => globalThis.__testMap.getZoom());
  await page.locator('#speed').selectOption('0.5');
  await page.locator('#play').click();
  await page.evaluate(async () => {
    const store = await import('/store.js');
    globalThis.__cameraCalls = [];
    globalThis.__tripreelPerformance = {};
    const current = store.state.saved.find((item) => item.id === 'near');
    globalThis.__previousRouteRevision = current.routeRevision;
    await store.saveTrips([
      {
        ...current,
        routeCoordinates: [
          current.from.coord,
          [118.83, 32.01],
          current.to.coord,
        ],
      },
    ]);
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const current = (await import('/store.js')).state.saved.find(
          (item) => item.id === 'near',
        );
        return (
          current.routeRevision > globalThis.__previousRouteRevision &&
          current.routeCoordinates.length === 3 &&
          current.routeCoordinates[1][0] === 118.83 &&
          (globalThis.__tripreelPerformance.layers?.length || 0) > 0
        );
      }),
    )
    .toBe(true);
  const during = await page.evaluate(async () => ({
    calls: globalThis.__cameraCalls,
    playing: (await import('/store.js')).state.playing,
    zoom: globalThis.__testMap.getZoom(),
  }));
  expect(during.playing).toBe(true);
  expect(during.zoom).toBeGreaterThan(nearZoom - 0.5);
  expect(during.calls.every((camera) => camera.zoom > nearZoom - 0.5)).toBe(
    true,
  );

  await page.locator('#follow').uncheck();
  const freeView = await page.evaluate(async () => {
    const controls = await import('/map.js');
    controls.pause();
    const map = globalThis.__testMap;
    globalThis.__cameraCalls = [];
    globalThis.__tripreelPerformance = {};
    const store = await import('/store.js'),
      current = store.state.saved.find((item) => item.id === 'near');
    await store.saveTrips([
      {
        ...current,
        routeCoordinates: [
          current.from.coord,
          [118.85, 32.04],
          current.to.coord,
        ],
      },
    ]);
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    const before = { center: map.getCenter().toArray(), zoom: map.getZoom() };
    globalThis.__tripreelPerformance = {};
    for (let i = 0; i < 3; i++) {
      controls.drawMap({ geometry: false });
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    }
    return {
      before,
      after: { center: map.getCenter().toArray(), zoom: map.getZoom() },
      calls: globalThis.__cameraCalls.length,
      layouts: globalThis.__tripreelPerformance.labelLayout?.length || 0,
    };
  });
  expect(freeView.calls).toBe(0);
  expect(freeView.after).toEqual(freeView.before);
  expect(freeView.layouts).toBe(0);

  await page.locator('#play').click();
  const revoked = await page.evaluate(async () => {
    const store = await import('/store.js');
    await store.saveTrips(
      store.state.saved.map((item) => ({ ...item, referenceAccepted: false })),
    );
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    return { playing: store.state.playing, progress: store.state.progress };
  });
  expect(revoked.playing).toBe(false);
  expect(Number.isFinite(revoked.progress)).toBe(true);
  expect(revoked.progress).toBeLessThan(1);
  await expect(page.locator('#play')).toBeDisabled();
});
