import { test, expect } from '@playwright/test';
async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#add-trip')).toBeEnabled();
}
async function loadDemoFromEmptyState(page) {
  await page.locator('[data-empty-demo]').click();
  await expect(page.locator('.trip-card')).toHaveCount(2);
  await expect(page.locator('#map')).toHaveAttribute('data-ready', 'true');
}
const rect = (page, selector) =>
  page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, selector);
const overlaps = (a, b) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
// Visible text smaller than 12px; spaced uppercase Latin labels may use 11px.
const smallText = (page) =>
  page.evaluate(() => {
    const found = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.trim();
      const element = walker.currentNode.parentElement;
      if (!text || !element.getClientRects().length) continue;
      if (element.closest('.maplibregl-canvas-container,[aria-hidden="true"]'))
        continue;
      const size = parseFloat(getComputedStyle(element).fontSize);
      const latinLabel = /^[A-Z0-9 ,.'·-]+$/.test(text);
      if (size < (latinLabel ? 11 : 12)) found.push(`${size}px ${text}`);
    }
    return found;
  });

test('空状态可直接体验示例，有记录时不再显示示例入口', async ({ page }) => {
  await ready(page);
  await expect(page.locator('[data-empty-demo]')).toBeVisible();
  await loadDemoFromEmptyState(page);
  await page.locator('#new-journey').click();
  await page.evaluate(async () => {
    const [store, domain] = await Promise.all([
      import('/store.js'),
      import('/domain.js'),
    ]);
    const demo = await (await fetch('/data/demo.json')).json();
    await store.saveTrips(
      demo.trips.map((trip) => domain.normalizeTrip(trip, { legacy: true })),
    );
  });
  await expect(page.locator('.trip-card')).toHaveCount(2);
  await page.locator('#filter-search').fill('不存在的地点');
  await expect(page.locator('.empty-state')).toBeVisible();
  await expect(page.locator('[data-empty-demo]')).toHaveCount(0);
});

test('提示信息显示在打开的弹窗之上且不遮挡回放面板', async ({ page }) => {
  await ready(page);
  await loadDemoFromEmptyState(page);
  const toast = page.locator('#toast');
  await expect(toast).toBeVisible();
  expect(
    overlaps(await rect(page, '#toast'), await rect(page, '.playback')),
  ).toBe(false);
  await page.locator('#about-button').click();
  await page.evaluate(async () =>
    (await import('/store.js')).toast('弹窗打开时的提示'),
  );
  await expect(toast).toHaveText('弹窗打开时的提示');
  await expect(toast).toBeVisible();
  expect(await toast.evaluate((el) => el.matches(':popover-open'))).toBe(true);
});

test('桌面与平板宽度保留跟随开关，可见文字不小于 12px', async ({ page }) => {
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 760 });
    await ready(page);
    await loadDemoFromEmptyState(page);
    await expect(page.locator('#follow')).toBeVisible();
    expect(await smallText(page)).toEqual([]);
    await page.locator('#add-trip').click();
    await page.locator('#advanced-fields > summary').click();
    expect(await smallText(page)).toEqual([]);
    await page.locator('[data-close="editor"]').click();
    await page.locator('#about-button').click();
    expect(await smallText(page)).toEqual([]);
  }
});

test.describe('触屏窄屏', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test('版权栏、提示和底部操作栏不遮挡回放控件', async ({ page }) => {
    await ready(page);
    await loadDemoFromEmptyState(page);
    await expect(page.locator('#follow')).toBeVisible();
    await expect(page.locator('.maplibregl-ctrl-attrib')).not.toHaveClass(
      /maplibregl-compact-show/,
    );
    const controls = await rect(page, '.playback-controls');
    const progress = await rect(page, '.progress-labels');
    const attribution = await rect(page, '.maplibregl-ctrl-attrib');
    expect(overlaps(attribution, controls)).toBe(false);
    expect(overlaps(attribution, progress)).toBe(false);
    await expect(page.locator('#toast')).toBeVisible();
    const toast = await rect(page, '#toast');
    expect(overlaps(toast, await rect(page, '.playback'))).toBe(false);
    expect(overlaps(toast, await rect(page, '.panel-footer'))).toBe(false);
    expect(await smallText(page)).toEqual([]);
  });

  test('页面内的地图需双指拖动，全屏时恢复单指操作', async ({ page }) => {
    await ready(page);
    const cooperative = () =>
      page.evaluate(() =>
        document
          .querySelector('.maplibregl-canvas-container')
          .classList.contains('maplibregl-cooperative-gestures'),
      );
    expect(
      await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
    ).toBe(true);
    expect(await cooperative()).toBe(true);
    await page.locator('#map-fullscreen').click();
    expect(await cooperative()).toBe(false);
    await page.locator('#map-fullscreen').click();
    expect(await cooperative()).toBe(true);
  });
});

test('数据与说明分为两个标签页，每次打开回到设置与数据', async ({ page }) => {
  await ready(page);
  await page.locator('#about-button').click();
  await expect(page.locator('#about-data')).toBeVisible();
  await expect(page.locator('#about-sources')).toBeHidden();
  await page.locator('#about-sources-tab').click();
  await expect(page.locator('#about-sources')).toBeVisible();
  await expect(page.locator('#about-data')).toBeHidden();
  await expect(page.locator('#about-sources-tab')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#about-data-tab')).toBeFocused();
  await expect(page.locator('#about-data')).toBeVisible();
  await page.locator('#about-sources-tab').click();
  await page.locator('[data-close="about"]').click();
  await page.locator('#about-button').click();
  await expect(page.locator('#about-data')).toBeVisible();
  await expect(page.locator('#about-data-tab')).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('线路来源收进高级设置，查询提示显示当前来源', async ({ page }) => {
  await ready(page);
  await page.locator('#add-trip').click();
  await expect(page.locator('#trip-provider')).toBeHidden();
  await expect(page.locator('#lookup-hint')).toContainText('线路来源：');
  await expect(page.locator('#advanced-summary')).toContainText('线路来源');
  await page.locator('#advanced-fields > summary').click();
  await expect(page.locator('#trip-provider')).toBeVisible();
  await page.locator('input[name="mode"][value="flight"]').check();
  await expect(page.locator('#advanced-summary')).toHaveText(
    '高级设置 · 手动坐标',
  );
  await expect(page.locator('#lookup-hint')).not.toContainText('线路来源');
});

test('列表、详情和批量核对中的文本按纯文本显示', async ({ page }) => {
  await ready(page);
  const name = '北京<img src=x onerror="window.__injected=1">';
  await page.evaluate(async (name) => {
    const store = await import('/store.js');
    await store.saveTrips([
      {
        id: 'escaped',
        mode: 'flight',
        number: 'CA1001',
        travelDate: '2027-01-01',
        departure: '2027-01-01T08:00',
        arrival: '2027-01-01T10:00',
        from: { name, code: 'PEK', coord: [116.6, 40.08] },
        to: { name: '厦门高崎', code: 'XMN', coord: [118.12, 24.54] },
        quality: 'schematic',
        distance: 1700,
        routeState: 'ready',
        routeConfirmed: true,
        stops: [],
        legs: [],
        revision: 0,
      },
    ]);
  }, name);
  await expect(page.locator('.card-route')).toContainText(name);
  await page.locator('[data-detail]').click();
  await expect(page.locator('#details-body')).toContainText(name);
  await page.locator('[data-close="trip-details"]').click();
  await page.locator('#import-text').click();
  await page
    .locator('#batch-text')
    .fill(`飞机 CA1002 2027/1/9 ${name}-厦门高崎`);
  await page.locator('#save-batch').click();
  await expect(page.locator('#batch-review')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.batch-original').first()).toContainText(name);
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  expect(await page.evaluate(() => window.__injected)).toBeUndefined();
});
