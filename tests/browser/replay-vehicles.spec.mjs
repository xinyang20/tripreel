import { test, expect } from '@playwright/test';
async function demo(page) {
  await page.goto('/');
  await expect(page.locator('#add-trip')).toBeEnabled();
  await page.locator('[data-empty-demo]').click();
  await expect(page.locator('.trip-card')).toHaveCount(2);
  await expect(page.locator('#map')).toHaveAttribute('data-ready', 'true');
}
const seek = (page, value) =>
  page.evaluate((v) => {
    const input = document.getElementById('progress');
    input.value = String(v);
    input.dispatchEvent(new Event('input'));
  }, value);

test('回放显示三维列车和飞机，已行驶路线随进度推进', async ({ page }) => {
  await demo(page);
  const map = page.locator('#map');
  await seek(page, 150);
  await expect(map).toHaveAttribute('data-vehicle', 'train');
  const early = Number(await map.getAttribute('data-travelled'));
  await seek(page, 300);
  await expect
    .poll(async () => Number(await map.getAttribute('data-travelled')))
    .toBeGreaterThan(early);
  await expect(page.locator('#traveller-label')).toHaveText('G2');
  await expect(page.locator('.traveller')).not.toHaveClass(/waiting/);
  await seek(page, 500);
  await expect(page.locator('.traveller')).toHaveClass(/waiting/);
  await expect(map).toHaveAttribute('data-vehicle', '');
  await seek(page, 800);
  await expect(map).toHaveAttribute('data-vehicle', 'flight');
  await expect(page.locator('#traveller-label')).toHaveText('CA1831');
});

test('界面不再用 emoji 表示交通方式或回放载具', async ({ page }) => {
  await demo(page);
  await page.locator('#play').click();
  await page.waitForTimeout(500);
  await page.locator('#play').click();
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/[🚄✈🧑]/u);
  await expect(page.locator('#play use')).toHaveAttribute('href', '#i-play');
  await expect(
    page.locator('.trip-card .mode-icon use').first(),
  ).toHaveAttribute('href', '#i-train');
});
