import { test, expect } from '@playwright/test';

const from = { name: '天津南', coord: [117.067, 39.058] },
  to = { name: '南京南', coord: [118.797, 31.968] },
  originalCoordinates = [from.coord, [117.6, 36], to.coord],
  schematicCoordinates = [from.coord, to.coord];
const original = {
  id: 'public-main',
  mode: 'train',
  number: 'G9001',
  travelDate: '2030-01-02',
  departure: '2030-01-02T08:00',
  arrival: '2030-01-02T12:00',
  from,
  to,
  stops: [from, to],
  routeCoordinates: originalCoordinates,
  quality: 'latest',
  routeConfirmed: true,
  routeState: 'ready',
  distance: 850,
};
const schematic = {
  from,
  to,
  stops: [from, to],
  routeCoordinates: schematicCoordinates,
  quality: 'station-schematic',
  requiresConfirmation: true,
  resolution: { state: 'needs-confirmation', requiresConfirmation: true },
  distance: 800,
};
const notice =
  '此部署已停用 RailGo 在线轨道查询；火车可使用停站或手动途经点示意，飞机使用示意弧线。';
const snapshot = (page) =>
  page.evaluate(async () => (await import('/store.js')).repository.snapshot());
async function ready(page, trips = [original]) {
  await page.addInitScript(
    (items) =>
      localStorage.setItem(
        'travel-trace.v1',
        JSON.stringify({ version: 1, trips: items }),
      ),
    trips,
  );
  await page.goto('/');
  await expect(page.locator('#add-trip')).toBeEnabled();
  await expect(page.locator('#trip-list')).toContainText('G9001');
}

test('公开版关闭自动线路刷新，主动检查保留主线并等待示意候选确认', async ({
  page,
}) => {
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({
      json: { deployment: 'public', railgoEnabled: false, notice },
    }),
  );
  const requests = [];
  await page.route('**/api/route', (route) => {
    requests.push(route.request().headers()['x-travel-priority']);
    return route.fulfill({ json: schematic });
  });
  await ready(page, [
    original,
    {
      id: 'public-pending',
      mode: 'train',
      number: 'G9002',
      travelDate: '2030-01-03',
      from,
      to,
      stops: [from, to],
      routeState: 'pending',
      distance: null,
    },
  ]);
  await expect(page.locator('#deployment-notice')).toHaveText(notice);
  await expect(page.locator('#deployment-notice')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#deployment-notice')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('[data-edit="public-main"]').click();
  await expect(page.locator('#query-source-notice')).toHaveText(notice);
  await page.locator('[data-close="editor"]').click();
  await page.evaluate(async () =>
    (await import('/routes.js')).refreshStoredRoutes(),
  );
  expect(requests).toHaveLength(0);
  await page.locator('#about-button').click();
  await expect(page.locator('#train-source-copy')).toContainText(
    '此部署停用 RailGo 在线轨道查询',
  );
  await page.locator('#refresh-routes').click();
  await expect.poll(() => requests.length).toBe(2);
  await expect
    .poll(
      async () =>
        (await snapshot(page)).trips.find(
          (trip) => trip.id === 'public-pending',
        )?.routeCandidate?.quality,
    )
    .toBe('station-schematic');
  const trips = (await snapshot(page)).trips,
    main = trips.find((trip) => trip.id === 'public-main'),
    pending = trips.find((trip) => trip.id === 'public-pending');
  expect(main.routeCoordinates).toEqual(originalCoordinates);
  expect(main.quality).toBe('latest');
  expect(pending.routeState).toBe('pending');
  expect(pending.routeCoordinates || []).toHaveLength(0);
  expect(requests).toEqual(['foreground', 'foreground']);
});

test('能力读取失败仍能加载和编辑本地行程，并保守停止自动刷新', async ({
  page,
}) => {
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({ status: 503, json: { error: '合成服务暂不可用' } }),
  );
  let requests = 0;
  await page.route('**/api/route', (route) => {
    requests++;
    return route.fulfill({ json: schematic });
  });
  await ready(page);
  await expect(page.locator('#deployment-notice')).toContainText(
    '已暂停自动更新线路',
  );
  await expect(page.locator('#deployment-notice')).toBeVisible();
  await expect(page.locator('#play')).toBeEnabled();
  await page.locator('[data-edit="public-main"]').click();
  await expect(page.locator('#trip-number')).toHaveValue('G9001');
  await expect(page.locator('#query-source-notice')).toContainText(
    '已有行程和手动录入仍可使用',
  );
  await page.locator('[data-close="editor"]').click();
  await page.evaluate(async () =>
    (await import('/routes.js')).refreshStoredRoutes(),
  );
  expect(requests).toBe(0);
  expect((await snapshot(page)).trips[0].routeCoordinates).toEqual(
    originalCoordinates,
  );
});

test('本机能力确认后继续自动刷新，并保留原日期和时刻', async ({ page }) => {
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({
      json: { deployment: 'local', railgoEnabled: true, notice: '' },
    }),
  );
  const refreshed = [from.coord, [118, 35], to.coord];
  const requests = [];
  await page.route('**/api/route', (route) => {
    requests.push(route.request().headers()['x-travel-priority']);
    return route.fulfill({
      json: {
        ...schematic,
        routeCoordinates: refreshed,
        quality: 'latest',
        routePolicy: 'latest-v2',
        requiresConfirmation: false,
        resolution: { state: 'ready' },
      },
    });
  });
  await ready(page);
  await expect
    .poll(async () => (await snapshot(page)).trips[0].routeCoordinates)
    .toEqual(refreshed);
  const saved = (await snapshot(page)).trips[0];
  expect(saved.travelDate).toBe(original.travelDate);
  expect(saved.departure).toBe(original.departure);
  expect(requests).toEqual(['background']);
  await expect(page.locator('#deployment-notice')).toBeHidden();
});
