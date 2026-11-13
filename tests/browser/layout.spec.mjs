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
