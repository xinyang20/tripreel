import { test, expect } from '@playwright/test';

async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#add-trip')).toBeEnabled();
  await page.waitForFunction(
    () => document.querySelector('#place-list').options.length > 0,
  );
}
async function data(page) {
  return page.evaluate(async () =>
    (await import('/store.js')).repository.snapshot(),
  );
}
const start = { name: '天津南', coord: [117.067, 39.058] },
  end = { name: '南京南', coord: [118.797, 31.968] };
function schedule(number, date) {
  return {
    number,
    date,
    source: '12306',
    stops: [
      { ...start, arrival: date + 'T08:00', departure: date + 'T08:00' },
      { ...end, arrival: date + 'T12:00', departure: date + 'T12:00' },
    ],
  };
}
const schematic = {
  from: start,
  to: end,
  stops: [start, end],
  legs: [
    { from: start.name, to: end.name, coordinates: [start.coord, end.coord] },
  ],
  routeCoordinates: [start.coord, end.coord],
  quality: 'station-schematic',
  distance: 800,
  requiresConfirmation: true,
  resolution: { state: 'needs-confirmation', requiresConfirmation: true },
};
async function fillTrain(page, number = 'G1001') {
  await page.locator('#add-trip').click();
  await page.locator('#trip-number').fill(number);
  await page.locator('#trip-date').fill('2027-02-01');
  await page.locator('#trip-from').fill(start.name);
  await page.locator('#trip-to').fill(end.name);
}

test('关闭单段查询后旧响应不能覆盖新会话，也不能关闭新编辑器', async ({
  page,
}) => {
  await ready(page);
  let release, requested;
  const requestedPromise = new Promise((resolve) => (requested = resolve)),
    hold = new Promise((resolve) => (release = resolve));
  await page.route('**/api/train?*', async (route) => {
    requested();
    await hold;
    await route
      .fulfill({ json: schedule('G1001', '2027-02-01') })
      .catch(() => {});
  });
  await fillTrain(page);
  await page.locator('#lookup').click();
  await requestedPromise;
  await page.locator('[data-close="editor"]').click();
  await page.locator('#add-trip').click();
  await page.locator('#trip-number').fill('G2002');
  await page.locator('#trip-from').fill('北京南');
  release();
  await expect(page.locator('#trip-number')).toHaveValue('G2002');
  await expect(page.locator('#trip-from')).toHaveValue('北京南');
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#lookup')).toBeEnabled();
  expect((await data(page)).trips).toHaveLength(0);
});

test('列车示意未确认先存待补全，编辑接受后保留示意来源并可回放', async ({
  page,
}) => {
  await ready(page);
  await page.route('**/api/train?*', async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      json: schedule(
        url.searchParams.get('number'),
        url.searchParams.get('date'),
      ),
    });
  });
  await page.route('**/api/route', (route) =>
    route.fulfill({ json: schematic }),
  );
  await fillTrain(page);
  await page.locator('#lookup').click();
  await expect(page.locator('#single-route-confirm')).toBeVisible();
  await expect(page.locator('#single-route-confirm')).not.toBeChecked();
  await page.locator('#save-trip').click();
  await expect(page.locator('#editor')).not.toBeVisible();
  let saved = (await data(page)).trips[0];
  expect(saved.routeState).toBe('pending');
  expect(saved.routeCandidate.quality).toBe('station-schematic');
  await page.locator(`[data-edit="${saved.id}"]`).click();
  await page.locator('#single-route-confirm').check();
  await page.locator('#save-trip').click();
  await expect(page.locator('#editor')).not.toBeVisible();
  saved = (await data(page)).trips[0];
  expect(saved.routeState).toBe('ready');
  expect(saved.quality).toBe('station-schematic');
  expect(saved.routeConfirmed).toBe(true);
  await expect(page.locator('#play')).toBeEnabled();
});

test('停止批量查询保留已完成结果与勾选，刷新后能继续核对草稿', async ({
  page,
}) => {
  await ready(page);
  let releaseSlow;
  const hold = new Promise((resolve) => (releaseSlow = resolve));
  await page.route('**/api/train?*', async (route) => {
    const url = new URL(route.request().url()),
      number = url.searchParams.get('number');
    if (number === 'G1002') await hold;
    await route
      .fulfill({ json: schedule(number, url.searchParams.get('date')) })
      .catch(() => {});
  });
  await page.route('**/api/route', (route) =>
    route.fulfill({
      json: {
        ...schematic,
        quality: 'latest',
        requiresConfirmation: false,
        resolution: { state: 'ready' },
      },
    }),
  );
  const raw =
    '火车 G1001 2027/2/1 天津南-南京南\n火车 G1002 2027/2/2 天津南-南京南';
  await page.locator('#import-text').click();
  await page.locator('#batch-text').fill(raw);
  await page.locator('#save-batch').click();
  await expect(page.locator('[data-row="0"] .batch-state')).toHaveText(
    '可保存',
  );
  await expect(page.locator('[data-row="0"]')).not.toHaveAttribute('open', '');
  await page.locator('#stop-batch').click();
  releaseSlow();
  await page.locator('[data-row="1"] [data-include]').uncheck();
  await expect
    .poll(async () => {
      const draft = (await data(page)).drafts.find(
        (item) => item.kind === 'batch',
      );
      return draft?.rows?.[1]?.included;
    })
    .toBe(false);
  await page.reload();
  await page.locator('#open-drafts').click();
  await page.locator('[data-resume]').first().click();
  await expect(page.locator('#batch-text')).toHaveValue(raw);
  await expect(page.locator('[data-row="0"] [data-include]')).toBeChecked();
  await expect(page.locator('[data-row="1"] [data-include]')).not.toBeChecked();
  expect((await data(page)).trips).toHaveLength(0);
  await page.locator('#confirm-batch').click();
  await expect(page.locator('#editor')).not.toBeVisible();
  expect((await data(page)).trips).toHaveLength(1);
});
