import { test, expect } from '@playwright/test';

const legacyKey = 'travel-trace.v1';
const fixture = (id = 'recovery-demo', day = '04') => ({
  id,
  mode: 'flight',
  number: 'CZ9001',
  travelDate: `2027-03-${day}`,
  departure: `2027-03-${day}T08:00`,
  arrival: `2027-03-${day}T10:00`,
  from: { name: '合肥新桥', code: 'HFE', coord: [116.978, 31.989] },
  to: { name: '昆明长水', code: 'KMG', coord: [102.93, 25.102] },
  quality: 'schematic',
  routeState: 'ready',
  routeConfirmed: true,
  distance: 1650,
  stops: [],
  legs: [],
  revision: 0,
});
async function snapshot(page) {
  return page.evaluate(async () =>
    (await import('/store.js')).repository.snapshot(),
  );
}
async function seedLegacy(page, raw) {
  await page.addInitScript(
    ({ key, text }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, text);
    },
    { key: legacyKey, text: raw },
  );
}
async function loaded(page) {
  await page.goto('/');
  await expect(page.locator('#about-button')).toBeEnabled();
  await expect
    .poll(
      async () =>
        await page.evaluate(
          async () => (await import('/store.js')).state.ready,
        ),
    )
    .toBe(true);
}

test('损坏的v1 JSON保留原文，用户可在恢复界面导入有效备份解除锁定', async ({
  page,
}) => {
  const broken = '{"version":1,"trips":[损坏的测试内容';
  await seedLegacy(page, broken);
  await loaded(page);
  await expect(page.locator('#recovery-banner')).toBeVisible();
  const initial = await snapshot(page);
  expect(initial.locked).toBe(true);
  expect(initial.trips).toHaveLength(0);
  expect(initial.recovery.rawLegacy).toBe(broken);
  await page.locator('#about-button').click();
  await page.locator('#import-backup').setInputFiles({
    name: 'recovery-test.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'travel-trace-backup',
        version: 2,
        trips: [fixture()],
        groups: [],
        drafts: [],
      }),
    ),
  });
  await expect(page.locator('#restore-dialog')).toBeVisible();
  await expect(page.locator('#restore-summary')).toContainText('1 条新增');
  await expect(page.locator('#apply-restore')).toBeEnabled();
  await page.locator('#apply-restore').click();
  await expect(page.locator('#restore-dialog')).not.toBeVisible();
  await page.locator('[data-close="about"]').click();
  await expect(page.locator('#trip-list')).toContainText('CZ9001');
  const restored = await snapshot(page);
  expect(restored.locked).toBe(false);
  expect(restored.trips).toHaveLength(1);
  expect(restored.trips[0].departure).toBe('2027-03-04T08:00');
  expect(
    await page.evaluate((key) => localStorage.getItem(key), legacyKey),
  ).toBe(broken);
  await page.reload();
  await expect(page.locator('#trip-list')).toContainText('CZ9001');
  expect((await snapshot(page)).locked).toBe(false);
});

test('旧页面修改v1后可打开差异预览，预览与取消均不覆盖当前记录', async ({
  page,
  context,
}) => {
  const original = fixture('old-page-record');
  await seedLegacy(page, JSON.stringify({ version: 1, trips: [original] }));
  await loaded(page);
  await expect(page.locator('#trip-list')).toContainText('CZ9001');
  const before = (await snapshot(page)).trips[0];
  const oldPage = await context.newPage();
  await oldPage.goto('/?old-page-test');
  const changed = {
    ...original,
    departure: '2027-03-04T09:00',
    arrival: '2027-03-04T11:00',
  };
  const additional = { ...fixture('old-page-added', '05'), number: 'CZ9002' };
  await oldPage.evaluate(({ key, text }) => localStorage.setItem(key, text), {
    key: legacyKey,
    text: JSON.stringify({ version: 1, trips: [changed, additional] }),
  });
  await expect(page.locator('#recovery-banner')).toContainText('旧页面修改');
  await page.locator('#about-button').click();
  await expect(page.locator('#review-legacy')).toBeVisible();
  await page.locator('#review-legacy').click();
  await expect(page.locator('#restore-dialog')).toBeVisible();
  await expect(page.locator('#restore-summary')).toContainText('1 条新增');
  await expect(page.locator('#restore-summary')).toContainText('1 条冲突');
  await expect(page.locator('#restore-status')).toContainText(
    '默认保留现有冲突记录',
  );
  const conflict = page.locator('.restore-row').filter({ hasText: 'CZ9001' });
  await expect(conflict.locator('select')).toHaveValue('skip');
  let current = await snapshot(page);
  expect(current.trips).toHaveLength(1);
  expect(current.trips[0].departure).toBe(before.departure);
  await page
    .locator('#restore-dialog [data-close="restore-dialog"]')
    .first()
    .click();
  current = await snapshot(page);
  expect(current.trips).toHaveLength(1);
  expect(current.trips[0].departure).toBe(before.departure);
  expect(current.trips[0].revision).toBe(before.revision);
  await oldPage.close();
});

test('键盘可打开编辑器、左右切换录入页签，关闭后焦点回到入口', async ({
  page,
}) => {
  await loaded(page);
  await expect(page.locator('#add-trip')).toBeEnabled();
  await page.locator('#add-trip').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#editor')).toBeVisible();
  await page.locator('#single-tab').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#batch-tab')).toBeFocused();
  await expect(page.locator('#batch-tab')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('#batch-panel')).toBeVisible();
  await expect(page.locator('#trip-form')).not.toBeVisible();
  await expect(page.locator('#batch-tab')).toHaveAttribute('tabindex', '0');
  await expect(page.locator('#single-tab')).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('Home');
  await expect(page.locator('#single-tab')).toBeFocused();
  await expect(page.locator('#trip-form')).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.locator('#batch-tab')).toBeFocused();
  await expect(page.locator('#batch-panel')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#single-tab')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#batch-tab')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#single-tab')).toBeFocused();
  await expect(page.locator('#single-tab')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('#single-tab')).toHaveAttribute('tabindex', '0');
  await expect(page.locator('#batch-tab')).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('Escape');
  await expect(page.locator('#editor')).not.toBeVisible();
  await expect(page.locator('#add-trip')).toBeFocused();
  await page.locator('#import-text').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#batch-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#editor')).not.toBeVisible();
  await expect(page.locator('#import-text')).toBeFocused();
});
