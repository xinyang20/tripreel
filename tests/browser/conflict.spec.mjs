import { test, expect } from '@playwright/test';

const fixture = {
  id: 'conflict-ui',
  mode: 'flight',
  number: 'CZ9001',
  travelDate: '2027-03-04',
  departure: '2027-03-04T08:00',
  arrival: '2027-03-04T10:00',
  from: { name: '合肥新桥', code: 'HFE', coord: [116.978, 31.989] },
  to: { name: '昆明长水', code: 'KMG', coord: [102.93, 25.102] },
  quality: 'schematic',
  routeState: 'ready',
  routeConfirmed: true,
  referenceAccepted: true,
  distance: 1650,
  stops: [],
  legs: [],
  revision: 0,
};
async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#add-trip')).toBeEnabled();
}
async function snapshot(page) {
  return page.evaluate(async () =>
    (await import('/store.js')).repository.snapshot(),
  );
}
async function save(page, trip) {
  return page.evaluate(
    async (value) => (await import('/store.js')).saveTrips([value]),
    trip,
  );
}
async function setup(page, context) {
  await ready(page);
  const [base] = await save(page, fixture);
  const other = await context.newPage();
  await ready(other);
  await page.locator(`[data-edit="${base.id}"]`).click();
  await page.locator('#trip-departure').fill('2027-03-04T08:30');
  return { base, other };
}
async function waitForDraft(page) {
  await expect
    .poll(async () => (await snapshot(page)).drafts[0]?.row?.draft?.departure)
    .toBe('2027-03-04T08:30');
  return (await snapshot(page)).drafts[0];
}

test('版本冲突显示差异并保留草稿，用户确认后只合并本次修改', async ({
  page,
  context,
}) => {
  const { base, other } = await setup(page, context);
  await save(other, { ...base, arrival: '2027-03-04T11:00' });
  await page.locator('#save-trip').click();
  await expect(page.locator('#single-conflict')).toBeVisible();
  await expect(page.locator('#single-conflict')).toContainText(
    '2027-03-04T11:00',
  );
  await expect(page.locator('#single-conflict')).toContainText(
    '2027-03-04T08:30',
  );
  await expect(page.locator('#save-trip')).toBeDisabled();
  const before = await snapshot(page);
  expect(before.trips[0].departure).toBe(base.departure);
  expect(before.drafts[0].baseTripRevision).toBe(base.revision);
  await page.locator('#conflict-confirm').click();
  await expect(page.locator('#editor')).not.toBeVisible();
  const after = await snapshot(page);
  expect(after.trips[0].departure).toBe('2027-03-04T08:30');
  expect(after.trips[0].arrival).toBe('2027-03-04T11:00');
  expect(after.trips[0].revision).toBe(3);
  expect(after.drafts).toHaveLength(0);
  await other.close();
});

test('恢复旧草稿保留原基准，后台路线版本冲突确认后不覆盖最新几何', async ({
  page,
  context,
}) => {
  const { base, other } = await setup(page, context);
  const draft = await waitForDraft(page);
  expect(draft.baseTripRevision).toBe(base.revision);
  expect(draft.original.routeRevision).toBe(base.routeRevision);
  await page.locator('[data-close="editor"]').click();
  const newFrom = { ...base.from, coord: [116.981, 31.993] };
  await other.evaluate(
    async ({ trip, from }) => {
      await (
        await import('/store.js')
      ).repository.updateRoute(trip, {
        ...trip,
        from,
        distance: 1850,
        routeCoordinates: [from.coord, trip.to.coord],
        resolution: { state: 'ready' },
      });
    },
    { trip: base, from: newFrom },
  );
  const latest = (await snapshot(page)).trips[0];
  expect(latest.revision).toBe(base.revision);
  expect(latest.routeRevision).toBeGreaterThan(base.routeRevision);
  await page.reload();
  await page.locator('#open-drafts').click();
  await page.locator(`[data-resume="${draft.id}"]`).click();
  await expect(page.locator('#trip-departure')).toHaveValue('2027-03-04T08:30');
  await page.locator('#save-trip').click();
  await expect(page.locator('#single-conflict')).toBeVisible();
  expect((await snapshot(page)).drafts[0].original.routeRevision).toBe(
    base.routeRevision,
  );
  await page.locator('#conflict-confirm').click();
  await expect(page.locator('#editor')).not.toBeVisible();
  const saved = (await snapshot(page)).trips[0];
  expect(saved.from.coord).toEqual(newFrom.coord);
  expect(saved.routeCoordinates).toEqual(latest.routeCoordinates);
  expect(saved.distance).toBe(1850);
  expect(saved.departure).toBe('2027-03-04T08:30');
  await other.close();
});

test('其他页面删除行程后保留草稿，恢复草稿也不会自动重新建立原行程', async ({
  page,
  context,
}) => {
  const { base, other } = await setup(page, context);
  await other.evaluate(
    async (trip) =>
      (await import('/store.js')).deleteTrip(trip.id, trip.revision),
    base,
  );
  await page.locator('#save-trip').click();
  await expect(page.locator('#single-conflict')).toContainText(
    '原行程已被删除',
  );
  await expect(page.locator('#conflict-confirm')).toHaveCount(0);
  await expect(page.locator('#save-trip')).toBeDisabled();
  await page.locator('#conflict-keep-draft').click();
  await expect(page.locator('#editor')).not.toBeVisible();
  await expect.poll(async () => (await snapshot(page)).drafts.length).toBe(1);
  await page.reload();
  await page.locator('#open-drafts').click();
  await page.locator('[data-resume]').click();
  await expect(page.locator('#single-conflict')).toContainText(
    '原行程已被删除',
  );
  await expect(page.locator('#save-trip')).toBeDisabled();
  const data = await snapshot(page);
  expect(data.trips).toHaveLength(0);
  expect(data.drafts[0].row.draft.departure).toBe('2027-03-04T08:30');
  expect(data.drafts[0].baseTripRevision).toBe(base.revision);
  await other.close();
});

test('核对期间再次变更需重新确认，采用数据库版本不会偷偷提交', async ({
  page,
  context,
}) => {
  const { base, other } = await setup(page, context);
  const [second] = await save(other, { ...base, arrival: '2027-03-04T11:00' });
  await page.locator('#save-trip').click();
  await expect(page.locator('#single-conflict')).toBeVisible();
  const [third] = await save(other, {
    ...second,
    departure: '2027-03-04T09:00',
    arrival: '2027-03-04T12:00',
  });
  await page.locator('#conflict-confirm').click();
  await expect(page.locator('#single-conflict')).toContainText(
    '核对期间记录再次变化',
  );
  expect((await snapshot(page)).trips[0].revision).toBe(third.revision);
  await page.locator('#conflict-load-latest').click();
  await expect(page.locator('#single-conflict')).toHaveCount(0);
  await expect(page.locator('#trip-departure')).toHaveValue('2027-03-04T09:00');
  await expect(page.locator('#trip-arrival')).toHaveValue('2027-03-04T12:00');
  await expect(page.locator('#save-trip')).toBeEnabled();
  await expect
    .poll(async () => (await snapshot(page)).drafts[0]?.baseTripRevision)
    .toBe(third.revision);
  expect((await snapshot(page)).trips[0].revision).toBe(third.revision);
  await other.close();
});
