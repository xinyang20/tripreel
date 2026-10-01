import { test, expect } from '@playwright/test';

const flight = {
  id: 'map-flight',
  mode: 'flight',
  number: 'CA1001',
  travelDate: '2027-01-01',
  departure: '2027-01-01T08:00',
  arrival: '2027-01-01T10:00',
  from: { name: '北京首都', code: 'PEK', coord: [116.6, 40.08] },
  to: { name: '厦门高崎', code: 'XMN', coord: [118.12, 24.54] },
  quality: 'schematic',
  distance: 1700,
  routeState: 'ready',
  routeConfirmed: true,
  stops: [],
  legs: [],
  revision: 0,
};
const pending = (withRoute) => ({
  id: withRoute ? 'map-missing-time' : 'map-missing-route',
  mode: 'train',
  number: withRoute ? 'G1002' : 'G1003',
  travelDate: '2027-01-02',
  departure: null,
  arrival: null,
  from: { name: '合成起点', coord: [118.79, 31.96] },
  to: { name: '合成终点', coord: [118.91, 32.12] },
  quality: withRoute ? 'latest' : 'pending',
  routeState: withRoute ? 'ready' : 'pending',
  routeConfirmed: true,
  routeCoordinates: withRoute
    ? [
        [118.79, 31.96],
        [118.84, 32.06],
        [118.91, 32.12],
      ]
    : [],
  distance: withRoute ? 22 : null,
  stops: [],
  legs: [],
  revision: 0,
});

async function ready(page, trips = [flight]) {
  await page.goto('/');
  await expect(page.locator('#add-trip')).toBeEnabled();
  await page.evaluate(
    async (items) => (await import('/store.js')).saveTrips(items),
    trips,
  );
  await expect(page.locator('#map')).toHaveAttribute('data-ready', 'true');
  // Capture the real map through an existing user action, without a production test API.
  await page.evaluate(async () => {
    const { Map } = await import('/vendor/maplibre-gl.mjs');
    const original = Map.prototype.easeTo;
    Map.prototype.easeTo = function (...args) {
      if (this.getContainer().id === 'map') window.mapTest = this;
      return original.apply(this, args);
    };
    document.querySelector('#fit-map').click();
    Map.prototype.easeTo = original;
  });
  await settled(page);
}
async function settled(page) {
  await expect
    .poll(() => page.evaluate(() => window.mapTest?.isMoving()))
    .toBe(false);
}
async function camera(page) {
  return page.evaluate(() => {
    const map = window.mapTest;
    return {
      center: map.getCenter().toArray(),
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    };
  });
}
async function freeView(page) {
  await page.locator('#follow').uncheck();
  await page.evaluate(() =>
    window.mapTest.jumpTo({
      center: [114, 30],
      zoom: 5.8,
      pitch: 25,
      bearing: 7,
    }),
  );
  return camera(page);
}
async function expectCamera(page, expected) {
  const actual = await camera(page);
  expect(actual.center[0]).toBeCloseTo(expected.center[0], 6);
  expect(actual.center[1]).toBeCloseTo(expected.center[1], 6);
  for (const key of ['zoom', 'pitch', 'bearing'])
    expect(actual[key]).toBeCloseTo(expected[key], 6);
}

test('选中缺时刻或缺线路记录后，移动、尺寸变化及全屏保留地名与选中状态', async ({
  page,
}) => {
  const records = [pending(true), pending(false)];
  await ready(page, [flight, ...records]);
  await page.locator('#progress').fill('500');
  for (const trip of records) {
    await page.locator(`[data-view="${trip.id}"]`).click();
    await settled(page);
    await expect(page.locator('#playback-title')).toHaveText(
      trip.number + ' · 待补全',
    );
    await expect(page.locator('#traveller')).toBeHidden();
    const labels = page.locator('.map-place-label');
    await expect(labels).toHaveText(['合成起点', '合成终点']);
    await page.evaluate(() => window.mapTest.panBy([12, 8], { duration: 0 }));
    await expect(labels).toHaveText(['合成起点', '合成终点']);
    await page.setViewportSize({ width: 1280, height: 780 });
    await settled(page);
    await expect(labels).toHaveText(['合成起点', '合成终点']);
    await page.locator('#map-fullscreen').click();
    await expect(page.locator('body')).toHaveClass(/map-fullscreen/);
    await settled(page);
    await expect(labels).toHaveText(['合成起点', '合成终点']);
    await expect(page.locator(`[data-trip="${trip.id}"]`)).toHaveClass(
      /selected/,
    );
    await page.keyboard.press('Escape');
    await settled(page);
  }
});

test('关闭跟随后暂停、播放、结束与尺寸变化保留视角，显式操作可重新取景', async ({
  page,
}) => {
  await ready(page);
  const expected = await freeView(page);
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.waitForTimeout(250);
  await expectCamera(page, expected);
  await page.locator('#map-fullscreen').click();
  await page.waitForTimeout(250);
  await expectCamera(page, expected);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  await expectCamera(page, expected);
  await page.locator('#progress').fill('500');
  await page.locator('#play').click();
  await expect(page.locator('#play')).toHaveAttribute('aria-label', '暂停旅程');
  await page.waitForTimeout(300);
  await expectCamera(page, expected);
  await page.locator('#play').click();
  await expectCamera(page, expected);
  await page.locator('#speed').selectOption('32');
  await page.locator('#play').click();
  await expect(page.locator('#play')).toHaveAttribute('aria-label', '播放旅程');
  await expect(page.locator('#progress')).toHaveValue('1000');
  await page.waitForTimeout(250);
  await expectCamera(page, expected);
  await page.locator('#progress').fill('0');
  await expectCamera(page, expected);

  await page.locator('#fit-map').click();
  await settled(page);
  expect(await camera(page)).not.toEqual(expected);
  const selectedExpected = await freeView(page);
  await page.locator('[data-view="map-flight"]').click();
  await settled(page);
  expect(await camera(page)).not.toEqual(selectedExpected);
  const followExpected = await freeView(page);
  await page.locator('#follow').check();
  await settled(page);
  expect(await camera(page)).not.toEqual(followExpected);
});
