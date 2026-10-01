import { test, expect } from '@playwright/test';

const flight = {
  id: 'date-review',
  mode: 'flight',
  number: 'CA9001',
  travelDate: '2030-01-03',
  departure: '2030-01-02T08:00',
  arrival: '2030-01-02T10:00',
  from: { name: '甲机场', coord: [118, 32] },
  to: { name: '乙机场', coord: [119, 33] },
  quality: 'schematic',
  routeState: 'ready',
  routeConfirmed: true,
  routeFrozen: true,
  distance: 100,
};
async function ready(page) {
  await page.goto('/');
  await expect
    .poll(() =>
      page.evaluate(async () => (await import('/store.js')).state.ready),
    )
    .toBe(true);
}
const snapshot = (page) =>
  page.evaluate(async () => (await import('/store.js')).repository.snapshot());

test('历史日期矛盾可查阅和修正，保存失败聚焦字段并保留草稿', async ({
  page,
}) => {
  await page.addInitScript(
    (trip) =>
      localStorage.setItem(
        'travel-trace.v1',
        JSON.stringify({ version: 1, trips: [trip] }),
      ),
    flight,
  );
  await ready(page);
  await expect(page.locator('#trip-list')).toContainText('CA9001');
  await expect(page.locator('#play')).toBeDisabled();
  await page.locator('[data-edit="date-review"]').click();
  await page.locator('#save-trip').click();
  await expect(page.locator('#form-error')).toContainText('实际出行日期');
  await expect(page.locator('#trip-date')).toBeFocused();
  await expect(page.locator('#trip-departure')).toHaveValue('2030-01-02T08:00');
  expect((await snapshot(page)).trips[0].travelDate).toBe('2030-01-03');
  await expect.poll(async () => (await snapshot(page)).drafts.length).toBe(1);
  await page.locator('#trip-departure').fill('2030-01-03T08:00');
  await page.locator('#trip-arrival').fill('2030-01-03T10:00');
  await page.locator('#save-trip').click();
  await expect(page.locator('#editor')).not.toBeVisible();
  await expect(page.locator('#play')).toBeEnabled();
  expect((await snapshot(page)).drafts).toHaveLength(0);
});

test('恢复界面隔离坏草稿并保留原文，有效记录正常恢复', async ({ page }) => {
  await ready(page);
  const broken = { id: 'broken', kind: 'batch', rows: { oops: true } };
  await page.locator('#about-button').click();
  await page.locator('#import-backup').setInputFiles({
    name: 'synthetic-recovery.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'travel-trace-backup',
        version: 2,
        trips: [
          { ...flight, travelDate: '2030-01-02' },
          {
            ...flight,
            id: 'invalid-date',
            travelDate: null,
            departure: { bad: true },
          },
        ],
        drafts: [broken],
      }),
    ),
  });
  await expect(page.locator('#restore-summary')).toContainText(
    '1 份草稿无法继续',
  );
  await expect(page.locator('#restore-rows')).toContainText('已隔离');
  await expect(page.locator('#restore-summary')).toContainText('1 条无效');
  await page.locator('#apply-restore').click();
  await expect(page.locator('#restore-dialog')).not.toBeVisible();
  const result = await snapshot(page);
  expect(result.trips).toHaveLength(1);
  expect(result.drafts).toHaveLength(0);
  expect(result.recovery.items[0].raw).toEqual(broken);
});

test('继续已有坏草稿时保持恢复界面和原内容，错误可见', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const store = await import('/store.js');
    await store.saveDraft({
      id: 'broken-existing',
      kind: 'batch',
      rows: { oops: true },
    });
  });
  await page.locator('#open-drafts').click();
  await page.locator('[data-resume="broken-existing"]').click();
  await expect(page.locator('#about')).toBeVisible();
  await expect(page.locator('#data-status')).toContainText('草稿无法继续');
  await expect(page.locator('#editor')).not.toBeVisible();
  expect((await snapshot(page)).drafts[0].rows).toEqual({ oops: true });
});
