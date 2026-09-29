import { test, expect } from '@playwright/test';
const flight = (id, day = '01') => ({
  id,
  mode: 'flight',
  number: 'CA1001',
  travelDate: `2027-01-${day}`,
  departure: `2027-01-${day}T08:00`,
  arrival: `2027-01-${day}T10:00`,
  from: { name: '北京首都', code: 'PEK', coord: [116.6, 40.08] },
  to: { name: '厦门高崎', code: 'XMN', coord: [118.12, 24.54] },
  quality: 'schematic',
  distance: 1700,
  routeState: 'ready',
  routeConfirmed: true,
  stops: [],
  legs: [],
  revision: 0,
});
async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#add-trip')).toBeEnabled();
  await page.waitForFunction(
    () => document.querySelector('#place-list').options.length > 0,
  );
}
async function saveThroughStore(page, trips) {
  return page.evaluate(
    async (items) => (await import('/store.js')).saveTrips(items),
    trips,
  );
}
async function currentData(page) {
  return page.evaluate(async () =>
    (await import('/store.js')).repository.snapshot(),
  );
}
test('缺时刻行程可确认保存并刷新；地图不虚构连线', async ({ page }) => {
  await ready(page);
  await page.locator('#add-trip').click();
  await page.locator('#trip-number').fill('G1001');
  await page.locator('#trip-date').fill('2027-02-01');
  await page.locator('#trip-from').fill('北京南');
  await page.locator('#trip-to').fill('上海虹桥');
  await page.locator('#save-trip').click();
  await expect(page.locator('#editor')).not.toBeVisible();
  await expect(page.locator('#trip-list')).toContainText('待补全');
  await expect(page.locator('#play')).toBeDisabled();
  await page.reload();
  await expect(page.locator('#trip-list')).toContainText('G1001');
  const data = await currentData(page);
  expect(data.trips).toHaveLength(1);
  expect(data.trips[0].departure).toBeFalsy();
  expect(data.drafts).toHaveLength(0);
  await page.locator('[data-detail]').click();
  await expect(page.locator('#details-body')).toContainText(
    '北京南 · 手动填写',
  );
});
test('单段草稿刷新后可继续，手动字段不丢失', async ({ page }) => {
  await ready(page);
  await page.locator('#add-trip').click();
  await page.locator('#trip-number').fill('G1002');
  await page.locator('#trip-date').fill('2027-02-02');
  await page.locator('#trip-from').fill('北京南');
  await page.locator('#trip-to').fill('上海虹桥');
  await expect
    .poll(async () => (await currentData(page)).drafts[0]?.row?.draft?.to)
    .toBe('上海虹桥');
  await page.reload();
  await page.locator('#open-drafts').click();
  await page.locator('[data-resume]').click();
  await expect(page.locator('#trip-number')).toHaveValue('G1002');
  await expect(page.locator('#trip-to')).toHaveValue('上海虹桥');
  await expect(page.locator('#trip-date')).toHaveValue('2027-02-02');
});
test('两个页面共享数据库，不同记录合并，同记录冲突保留先提交结果', async ({
  page,
  context,
}) => {
  await ready(page);
  const other = await context.newPage();
  await ready(other);
  await Promise.all([
    saveThroughStore(page, [flight('a', '01')]),
    saveThroughStore(other, [flight('b', '02')]),
  ]);
  await expect.poll(async () => (await currentData(page)).trips.length).toBe(2);
  const a = (await currentData(page)).trips.find((t) => t.id === 'a');
  await saveThroughStore(other, [{ ...a, number: 'CA1002' }]);
  const error = await page.evaluate(async (stale) => {
    try {
      await (
        await import('/store.js')
      ).saveTrips([{ ...stale, number: 'CA1003' }]);
      return null;
    } catch (e) {
      return e.message;
    }
  }, a);
  expect(error).toBeTruthy();
  expect((await currentData(page)).trips.find((t) => t.id === 'a').number).toBe(
    'CA1002',
  );
  await other.close();
});
test('完整备份可导入独立浏览器数据并离线回放', async ({ page, browser }) => {
  await ready(page);
  await saveThroughStore(page, [flight('backup-trip')]);
  await page.locator('#about-button').click();
  const wait = page.waitForEvent('download');
  await page.locator('#export-backup').click();
  const file = await (await wait).path();
  const context = await browser.newContext();
  const restored = await context.newPage();
  await ready(restored);
  await restored.locator('#about-button').click();
  await restored.locator('#import-backup').setInputFiles(file);
  await expect(restored.locator('#restore-summary')).toContainText('1 条新增');
  await restored.locator('#apply-restore').click();
  await restored.locator('[data-close="about"]').click();
  await expect(restored.locator('#play')).toBeEnabled();
  expect((await currentData(restored)).trips[0].from.coord).toEqual([
    116.6, 40.08,
  ]);
  await context.close();
});
test('旅程分组、筛选和勾选范围一致；解散分组保留行程', async ({ page }) => {
  await ready(page);
  await saveThroughStore(page, [flight('a', '01'), flight('b', '02')]);
  await page.locator('#manage-groups').click();
  await page.locator('#group-name').fill('春日旅程');
  await page.locator('#group-form button').click();
  await expect(page.locator('#group-list input')).toHaveValue('春日旅程');
  await page.locator('[data-close="groups-dialog"]').click();
  await page.locator('[data-select="a"]').check();
  const groupId = (await currentData(page)).groups[0].id;
  await page.locator('#bulk-group').selectOption(groupId);
  await page.locator('#apply-group').click();
  await page.locator('#filter-group').selectOption(groupId);
  await expect(page.locator('.trip-card')).toHaveCount(1);
  await expect(page.locator('#map-title')).toHaveText('春日旅程');
  await page.locator('#manage-groups').click();
  await page.locator('[data-remove-group]').click();
  await page.locator('[data-close="groups-dialog"]').click();
  await expect(page.locator('.trip-card')).toHaveCount(2);
  expect((await currentData(page)).trips).toHaveLength(2);
});
test('390px窄屏主要操作首屏可达，无横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await saveThroughStore(page, [flight('mobile')]);
  const boxes = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: innerWidth,
    add: document.querySelector('#add-trip').getBoundingClientRect().bottom,
    paste: document.querySelector('#import-text').getBoundingClientRect()
      .bottom,
  }));
  expect(boxes.width).toBeLessThanOrEqual(boxes.viewport);
  expect(boxes.add).toBeLessThanOrEqual(844);
  expect(boxes.paste).toBeLessThanOrEqual(844);
  await expect(page.locator('#map')).toHaveAttribute('data-ready', 'true');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'output/playwright/mobile.png' });
});
test('短视频实际生成、预览和下载，呈现设置不改原始行程', async ({ page }) => {
  test.setTimeout(90000);
  await ready(page);
  await saveThroughStore(page, [flight('movie')]);
  await page.locator('#export-video').click();
  await page.locator('#video-resolution').selectOption('720');
  await page.locator('#video-speed').selectOption('32');
  await page.locator('#video-hide-dates').check();
  await page.locator('#video-hide-numbers').check();
  await page.locator('#video-cities-only').check();
  const downloaded = page.waitForEvent('download', { timeout: 60000 });
  await page.locator('#video-start').click();
  const download = await downloaded;
  await download.saveAs(
    'output/playwright/verified-video.' +
      (download.suggestedFilename().endsWith('.mp4') ? 'mp4' : 'webm'),
  );
  await expect(page.locator('#video-result')).toBeVisible();
  const meta = await page.locator('#video-result').evaluate((video) => ({
    ready: video.readyState,
    width: video.videoWidth,
    height: video.videoHeight,
    error: video.error?.message,
  }));
  expect(meta.error).toBeFalsy();
  expect(meta.width).toBe(1280);
  expect(meta.height).toBe(720);
  expect(download.suggestedFilename()).toMatch(/旅程视频/);
  expect((await currentData(page)).trips[0].number).toBe('CA1001');
  await page.screenshot({ path: 'output/playwright/video.png' });
});
test('批量匹配六段及一行错误，紧凑核对后原子保存有效项', async ({ page }) => {
  await ready(page);
  await page.route('**/api/flight?*', async (route) => {
    const url = new URL(route.request().url()),
      date = url.searchParams.get('date'),
      number = url.searchParams.get('number');
    await route.fulfill({
      json: {
        number,
        date,
        source: '测试计划',
        fetchedAt: '2027-01-01T00:00:00Z',
        flights: [
          {
            ...flight(number),
            number,
            departure: date + 'T08:00',
            arrival: date + 'T10:00',
          },
        ],
      },
    });
  });
  await page.route('**/api/route', async (route) => {
    const t = flight('route');
    await route.fulfill({
      json: {
        from: t.from,
        to: t.to,
        stops: [t.from, t.to],
        legs: [],
        quality: 'schematic',
        distance: 1700,
        resolution: { state: 'ready' },
      },
    });
  });
  await page.locator('#import-text').click();
  await page
    .locator('#batch-text')
    .fill(
      Array.from(
        { length: 6 },
        (_, i) => `飞机 CA${1100 + i} 2027/1/${i + 1} 北京首都-厦门高崎`,
      ).join('\n') + '\n这是一行无效文本',
    );
  await page.locator('#save-batch').click();
  await expect(page.locator('#batch-status')).toContainText('匹配完成');
  await expect(page.locator('#stop-batch')).not.toBeVisible();
  await expect(page.locator('#batch-rows > details')).toHaveCount(7);
  const visibleCandidates = await page
    .locator('#batch-rows > details > summary')
    .evaluateAll((rows) => {
      const footerTop = document
        .querySelector('.batch-confirm-footer')
        .getBoundingClientRect().top;
      return rows.filter((row) => {
        const box = row.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= footerTop;
      }).length;
    });
  expect(visibleCandidates).toBeGreaterThanOrEqual(5);
  await page.screenshot({ path: 'output/playwright/batch.png' });
  await page.locator('#confirm-batch').click();
  await expect(page.locator('#editor')).not.toBeVisible();
  expect((await currentData(page)).trips).toHaveLength(6);
});

test('桌面地图总览、全屏与2D切换保持范围；筛选后不携带隐藏选中项导出', async ({
  page,
}) => {
  await ready(page);
  await saveThroughStore(page, [
    flight('scope-a', '01'),
    { ...flight('scope-b', '02'), number: 'CA1002' },
    {
      ...flight('scope-c', '03'),
      number: 'G1003',
      mode: 'train',
      departure: null,
      arrival: null,
      routeState: 'pending',
    },
  ]);
  await expect(page.locator('#map')).toHaveAttribute('data-ready', 'true');
  await page.locator('[data-select="scope-b"]').check();
  await page.locator('#filter-search').fill('CA1001');
  await expect(page.locator('.trip-card')).toHaveCount(1);
  await page.locator('#export-video').click();
  await expect(page.locator('#video-scope')).toContainText(
    '当前范围 1 段，将导出 1 段',
  );
  await page.locator('#video-close').click();
  await page.locator('#filter-search').fill('');
  await expect(page.locator('.trip-card')).toHaveCount(3);
  await page.locator('#map-fullscreen').click();
  await expect(page.locator('body')).toHaveClass(/map-fullscreen/);
  const fullscreen = await page.locator('#map').boundingBox();
  expect(fullscreen.width).toBe(1280);
  expect(fullscreen.height).toBe(720);
  await page.locator('#toggle-3d').click();
  await page.locator('#fit-map').click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'output/playwright/fullscreen.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/map-fullscreen/);
  await page.locator('#export-video').click();
  await expect(page.locator('#video-scope')).toContainText('1 段待补全');
  await page.locator('#video-omitted summary').click();
  await expect(page.locator('#video-omitted-list')).toContainText('G1003');
});
