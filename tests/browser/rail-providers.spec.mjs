import { test, expect } from '@playwright/test';
const capabilities = (deployment = 'local') => ({
  deployment,
  railgoEnabled: deployment === 'local',
  notice: deployment === 'public' ? '此部署停用 RailGo 在线轨道查询。' : '',
  defaultRailProvider: deployment === 'local' ? 'railgo' : 'osm-local',
  autoRefreshRoutes: false,
  railProviders: [
    {
      id: 'railgo',
      label: 'RailGo（仅本机）',
      available: deployment === 'local',
      coverage: '测试线路',
    },
    {
      id: 'osm-local',
      label: 'OSM 本地线路参考',
      available: true,
      coverage: '合成覆盖说明',
    },
  ],
});
async function ready(page, deployment = 'local') {
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({ json: capabilities(deployment) }),
  );
  await page.goto('/');
  await expect(page.locator('#add-trip')).toBeEnabled();
  await expect(page.locator('#default-rail-provider option')).toHaveCount(
    deployment === 'local' ? 2 : 1,
  );
}
test('默认来源持久化，单次覆盖不改变默认，切换保留手动时间并阻止迟到结果', async ({
  page,
}) => {
  await ready(page);
  await page.locator('#about-button').click();
  await page.locator('#default-rail-provider').selectOption('osm-local');
  await expect(page.locator('#provider-status')).toContainText('已保存');
  await page.reload();
  await expect(page.locator('#default-rail-provider')).toHaveValue('osm-local');
  await page.locator('#add-trip').click();
  await expect(page.locator('#trip-provider')).toHaveValue('osm-local');
  await expect(page.locator('#lookup-hint')).toContainText(
    '线路来源：OSM 本地线路参考',
  );
  await page.locator('#advanced-fields > summary').click();
  await page.locator('#trip-provider').selectOption('railgo');
  await expect(page.locator('#lookup-hint')).toContainText(
    '线路来源：RailGo（仅本机）',
  );
  await page.locator('#trip-number').fill('G9001');
  await page.locator('#trip-date').fill('2030-01-01');
  await page.locator('#trip-from').fill('天津南');
  await page.locator('#trip-to').fill('南京南');
  await page.locator('#time-details').evaluate((el) => (el.open = true));
  await page.locator('#trip-departure').fill('2030-01-01T08:07');
  let release, requested;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    requested = resolve;
  });
  await page.route('**/api/train?*', async (route) => {
    requested();
    await hold;
    await route
      .fulfill({
        json: {
          number: 'G9001',
          date: '2030-01-01',
          stops: [
            { name: '天津南', departure: '2030-01-01T08:00' },
            { name: '南京南', arrival: '2030-01-01T12:00' },
          ],
        },
      })
      .catch(() => {});
  });
  let routeRequests = 0;
  await page.route('**/api/route', (route) => {
    routeRequests++;
    return route.fulfill({ json: { resolution: { state: 'unavailable' } } });
  });
  await page.locator('#lookup').click();
  await started;
  await page.locator('#trip-provider').selectOption('osm-local');
  release();
  await expect(page.locator('#lookup')).toBeEnabled();
  await expect(page.locator('#trip-departure')).toHaveValue('2030-01-01T08:07');
  await expect(page.locator('#single-review')).toContainText('线路来源已更换');
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await import('/store.js')).repository
          .listDrafts()
          .then((items) => items.at(-1)?.row?.draft?.provider),
      ),
    )
    .toBe('osm-local');
  expect(routeRequests).toBe(0);
});
test('批量来源进入全部铁路请求；公开模式恢复本地草稿撤销旧候选授权', async ({
  page,
}) => {
  await ready(page);
  await page.locator('#import-text').click();
  await page.locator('#batch-provider').selectOption('osm-local');
  const providers = [];
  await page.route('**/api/train?*', (route) => {
    const url = new URL(route.request().url()),
      date = url.searchParams.get('date');
    return route.fulfill({
      json: {
        number: url.searchParams.get('number'),
        date,
        stops: [
          { name: '天津南', departure: date + 'T08:00' },
          { name: '南京南', arrival: date + 'T12:00' },
        ],
      },
    });
  });
  await page.route('**/api/route', (route) => {
    providers.push(route.request().postDataJSON().provider);
    return route.fulfill({
      json: {
        routeProvider: 'osm-local',
        resolution: { state: 'unavailable' },
      },
    });
  });
  await page
    .locator('#batch-text')
    .fill(
      '火车 G9001 2030/1/1 天津南-南京南\n火车 G9002 2030/1/2 天津南-南京南',
    );
  await page.locator('#save-batch').click();
  await expect(page.locator('#batch-status')).toContainText('匹配完成');
  expect(providers).toEqual(['osm-local', 'osm-local']);
  await page.locator('#batch-provider').selectOption('railgo');
  await page.locator('[data-close="editor"]').click();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await import('/store.js')).repository
          .listDrafts()
          .then((items) => items[0]?.provider),
      ),
    )
    .toBe('railgo');
  await page.unroute('**/api/capabilities');
  await ready(page, 'public');
  await expect(page.locator('#default-rail-provider')).toHaveValue('osm-local');
  await page.locator('#open-drafts').click();
  await page.locator('[data-resume]').first().click();
  await expect(page.locator('#batch-provider')).toHaveValue('osm-local');
  await expect(page.locator('#batch-rows')).toContainText(
    '原线路来源在此部署不可用',
  );
  await expect(page.locator('[data-route-confirm]:checked')).toHaveCount(0);
});

test('公开模式恢复本机飞机草稿后改为火车，显示和请求来源均切换为 OSM', async ({
  page,
}) => {
  await ready(page);
  await page.locator('#add-trip').click();
  await expect(page.locator('#trip-provider')).toHaveValue('railgo');
  await page.locator('input[name="mode"][value="flight"]').check();
  await page.locator('#trip-number').fill('CA9001');
  await page.locator('#trip-date').fill('2030-01-01');
  await page.locator('#trip-from').fill('北京首都');
  await page.locator('#trip-to').fill('上海虹桥');
  await page.locator('[data-close="editor"]').click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const drafts = await (
          await import('/store.js')
        ).repository.listDrafts();
        const draft = drafts.find((entry) => entry.kind === 'single');
        return [draft?.row?.draft?.mode, draft?.row?.draft?.provider];
      }),
    )
    .toEqual(['flight', 'railgo']);

  await page.unroute('**/api/capabilities');
  await ready(page, 'public');
  await page.locator('#open-drafts').click();
  await page.locator('[data-resume]').first().click();
  await expect(
    page.locator('input[name="mode"][value="flight"]'),
  ).toBeChecked();
  await page.locator('input[name="mode"][value="train"]').check();
  await expect(page.locator('#trip-provider')).toHaveValue('osm-local');
  await page.locator('#trip-number').fill('G9001');
  await page.locator('#trip-from').fill('天津南');
  await page.locator('#trip-to').fill('南京南');

  await page.route('**/api/train?*', (route) =>
    route.fulfill({
      json: {
        number: 'G9001',
        date: '2030-01-01',
        stops: [
          { name: '天津南', departure: '2030-01-01T08:00' },
          { name: '南京南', arrival: '2030-01-01T12:00' },
        ],
      },
    }),
  );
  const providers = [];
  await page.route('**/api/route', (route) => {
    providers.push(route.request().postDataJSON().provider);
    return route.fulfill({
      json: {
        routeProvider: 'osm-local',
        resolution: { state: 'unavailable' },
      },
    });
  });
  await page.locator('#lookup').click();
  await expect(page.locator('#lookup-status')).toContainText('匹配结果已填入');
  expect(providers).toEqual(['osm-local']);
  await expect(page.locator('#trip-provider')).toHaveValue('osm-local');
});

for (const kind of ['single', 'batch'])
  test(`${kind} 恢复同版本 OSM 草稿保留接受，能力版本改变后撤销候选`, async ({
    page,
  }) => {
    await ready(page, 'public');
    await page.evaluate(async (kind) => {
      const store = await import('/store.js');
      const { routeKey } = await import('/batch-review.js');
      store.state.capabilities.railProviders.find(
        (source) => source.id === 'osm-local',
      ).dataVersion = 'fixture-v1';
      document.dispatchEvent(new Event('rail-capabilities-change'));
      const draft = {
        mode: 'train',
        number: 'G9001',
        date: '2030-01-01',
        from: '天津南',
        to: '南京南',
        departure: '2030-01-01T08:07',
        arrival: '2030-01-01T12:00',
        provider: 'osm-local',
        providerDataVersion: 'fixture-v1',
        fieldSources: {
          departure: { source: 'manual' },
          arrival: { source: 'manual' },
        },
      };
      const from = { name: '天津南', coord: [117, 39] },
        to = { name: '南京南', coord: [118, 32] };
      const row = {
        draft,
        routeKey: routeKey(draft),
        routeIsCandidate: true,
        routeCandidateAccepted: true,
        routeConfirmed: false,
        needsResolve: false,
        included: true,
        line: 1,
        warnings: [],
        route: {
          from,
          to,
          stops: [from, to],
          routeCoordinates: [
            [117, 39],
            [118, 32],
          ],
          distance: 800,
          quality: 'corridor',
          routeProvider: 'osm-local',
          routeDataVersion: 'fixture-v1',
          requiresConfirmation: true,
          resolution: { state: 'needs-confirmation' },
        },
      };
      await store.saveDraft({
        id: `osm-version-${kind}`,
        kind,
        ...(kind === 'single'
          ? { row }
          : {
              rows: [row],
              raw: '合成草稿',
              reviewText: '合成草稿',
              provider: 'osm-local',
            }),
      });
    }, kind);
    await page.locator('#open-drafts').click();
    await page.locator(`[data-resume="osm-version-${kind}"]`).click();
    const checkbox =
      kind === 'single' ? '#single-route-confirm' : '[data-route-confirm]';
    await expect(page.locator(checkbox)).toBeChecked();
    await page.evaluate(async () => {
      const { state } = await import('/store.js');
      state.capabilities.railProviders.find(
        (source) => source.id === 'osm-local',
      ).dataVersion = 'fixture-v2';
      document.dispatchEvent(new Event('rail-capabilities-change'));
    });
    await expect(page.locator(checkbox)).toHaveCount(0);
    await expect(
      page.locator(kind === 'single' ? '#single-review' : '#batch-rows'),
    ).toContainText('数据版本已变化');
    await expect(
      page.locator(
        kind === 'single' ? '#trip-departure' : '[data-field="departure"]',
      ),
    ).toHaveValue('2030-01-01T08:07');
    await expect
      .poll(() =>
        page.evaluate(async (kind) => {
          const drafts = await (
            await import('/store.js')
          ).repository.listDrafts();
          const saved = drafts.find(
            (entry) => entry.id === `osm-version-${kind}`,
          );
          const row = kind === 'single' ? saved.row : saved.rows[0];
          return [
            row.draft.providerDataVersion,
            row.routeCandidateAccepted,
            row.route,
          ];
        }, kind),
      )
      .toEqual(['fixture-v2', false, null]);
  });
