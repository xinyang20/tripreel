import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createTravelServer, REQUEST_BUDGETS } from '../server.mjs';
const stations = [
  { name: '甲', code: 'AAA', coord: [110, 30] },
  { name: '乙', code: 'BBB', coord: [111, 31] },
  { name: '丙', code: 'CCC', coord: [112, 32] },
];
const airports = [
  { name: '甲机场', code: 'AAA', coord: [110, 30] },
  { name: '乙机场', code: 'BBB', coord: [111, 31] },
];
const response = (data) => ({ ok: true, json: async () => data });
function httpJSON(base, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      new URL(pathname, base),
      {
        method: body ? 'POST' : 'GET',
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode,
              headers: response.headers,
              data: JSON.parse(text),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
}
async function localServer(t, options = {}) {
  const server = await createTravelServer({
    stations,
    airports,
    today: '2026-09-26',
    schedulerOptions: { railIntervalMs: 0, upstreamTimeoutMs: 100 },
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (pathname, body, options = {}) => {
    const result = await fetch(base + pathname, {
      method: body ? 'POST' : 'GET',
      headers: body
        ? { 'Content-Type': 'application/json', ...options.headers }
        : options.headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: options.signal,
    });
    return { status: result.status, data: await result.json() };
  };
  return { api, base, server };
}
function provider({
  emptyTrack = true,
  missingCoord = false,
  oldDateFails = false,
  repeated = false,
  timetable,
} = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const parsed = new URL(url);
    if (parsed.hostname === 'search.12306.cn')
      return response({
        data:
          oldDateFails && parsed.searchParams.get('date') !== '20260926'
            ? []
            : [
                {
                  station_train_code: 'K1',
                  from_station: '甲',
                  to_station: '丙',
                  train_no: 'K1-internal',
                },
              ],
      });
    if (parsed.pathname.includes('queryByTrainNo'))
      return response({
        data: {
          data:
            timetable ||
            (repeated ? ['甲', '乙', '甲', '丙'] : ['甲', '乙', '丙']).map(
              (name, i) => ({
                station_name: name,
                arrive_time: `0${i + 7}:00`,
                start_time: `0${i + 7}:05`,
              }),
            ),
        },
      });
    if (parsed.pathname.includes('mapLine'))
      return response({
        success: true,
        data: {
          stations: (repeated
            ? ['甲', '乙', '甲', '丙']
            : ['甲', '乙', '丙']
          ).map((name) => ({
            [name]: stations.find((stop) => stop.name === name).coord,
          })),
          train: emptyTrack
            ? {}
            : {
                line: {
                  index: 0,
                  line: [
                    [110, 30],
                    [111, 31],
                    [112, 32],
                  ],
                },
              },
        },
      });
    throw new Error('Unexpected test URL');
  };
  return { fetchImpl, calls };
}

test('可导入服务工厂及三个接口保留旧字段、默认预算固定', async (t) => {
  const upstream = provider();
  const { api } = await localServer(t, upstream);
  assert.deepEqual(REQUEST_BUDGETS, {
    train: 75000,
    flight: 20000,
    route: 75000,
  });
  const lookup = await api('/api/train?number=K1&date=2026-09-26');
  assert.equal(lookup.status, 200);
  assert.equal(lookup.data.stops.length, 3);
  assert.equal(lookup.data.stops[1].stopIndex, 1);
  const route = await api('/api/route', {
    mode: 'train',
    number: 'K1',
    date: '2026-09-26',
    from: '甲',
    to: '丙',
  });
  assert.equal(route.status, 200);
  assert.equal(route.data.quality, 'station-schematic');
  assert.equal(route.data.resolution.state, 'needs-confirmation');
  assert.equal(route.data.requiresConfirmation, true);
  assert.equal(route.data.stops.length, 3);
  assert.ok(route.data.routeCoordinates.length > 20);
  assert.equal(
    upstream.calls.filter((url) => url.includes('queryByTrainNo')).length,
    1,
  );
  const flight = await api('/api/route', {
    mode: 'flight',
    from: 'AAA',
    to: 'BBB',
  });
  assert.equal(flight.data.resolution.state, 'ready');
  assert.equal(flight.data.quality, 'schematic');
});

test('真实线路优先，几何缺失通用停站候选保留来源，缺坐标则待补全', async (t) => {
  const complete = await localServer(t, provider({ emptyTrack: false }));
  const real = await complete.api('/api/route', {
    mode: 'train',
    number: 'K1',
    date: '2026-09-26',
    from: '甲',
    to: '丙',
  });
  assert.equal(real.data.quality, 'latest');
  assert.equal(real.data.requiresConfirmation, false);
  const { api } = await localServer(t, {
    stations: [stations[0], { ...stations[1], coord: null }, stations[2]],
    fetchImpl: async (url) => {
      if (String(url).includes('rg-api')) throw new Error('offline');
      return provider().fetchImpl(url);
    },
  });
  const pending = await api('/api/route', {
    mode: 'train',
    number: 'K1',
    date: '2026-09-26',
    from: '甲',
    to: '丙',
  });
  assert.equal(pending.status, 200);
  assert.equal(pending.data.quality, 'pending');
  assert.equal(pending.data.resolution.state, 'unavailable');
  assert.match(pending.data.resolution.message, /乙.*缺少/);
  assert.equal(pending.data.distance, null);
});

test('非法来源时刻保留停站和警告，路线响应继续传递来源异常', async (t) => {
  const { api } = await localServer(
    t,
    provider({
      timetable: [
        { station_name: '甲', arrive_time: '----', start_time: '25:99' },
        { station_name: '乙', arrive_time: '08:00', start_time: '12:60' },
        { station_name: '丙', arrive_time: '09:00', start_time: '----' },
      ],
    }),
  );
  const lookup = await api('/api/train?number=K1&date=2026-09-26');
  assert.equal(lookup.status, 200);
  assert.equal(lookup.data.stops.length, 3);
  assert.equal(lookup.data.stops[0].departure, undefined);
  assert.equal(lookup.data.stops[1].arrival, '2026-09-26T08:00');
  assert.equal(lookup.data.stops[1].departure, undefined);
  assert.equal(lookup.data.stops[2].arrival, '2026-09-26T09:00');
  assert.equal(lookup.data.warningDetails.length, 2);
  assert.ok(
    lookup.data.warningDetails.every(
      (item) =>
        item.code === 'INVALID_TIMETABLE_TIME' && item.scope === 'schedule',
    ),
  );
  assert.match(lookup.data.note, /12306.*时刻无效/);
  const route = await api('/api/route', {
    mode: 'train',
    number: 'K1',
    date: '2026-09-26',
    from: '甲',
    to: '丙',
  });
  assert.equal(route.data.quality, 'station-schematic');
  assert.equal(
    route.data.warningDetails.filter(
      (item) => item.code === 'INVALID_TIMETABLE_TIME',
    ).length,
    2,
  );
});

test('整张停站表没有有效时刻时结构化失败且后续恢复不受失败缓存影响', async (t) => {
  let attempts = 0;
  const valid = provider();
  const { api } = await localServer(t, {
    fetchImpl: async (url) => {
      if (String(url).includes('queryByTrainNo') && ++attempts === 1)
        return response({
          data: {
            data: [
              { station_name: '甲', start_time: '24:10' },
              { station_name: '丙', arrive_time: '12:60' },
            ],
          },
        });
      return valid.fetchImpl(url);
    },
  });
  const failed = await api('/api/train?number=K1&date=2026-09-26');
  assert.equal(failed.status, 404);
  assert.equal(failed.data.code, 'NO_TIMETABLE');
  assert.equal(failed.data.retryable, true);
  assert.match(failed.data.error, /没有可用时刻/);
  const recovered = await api('/api/train?number=K1&date=2026-09-26');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.stops[0].departure, '2026-09-26T07:05');
  assert.equal(attempts, 2);
});

test('RailGo 空结果与异常坐标不缓存，异常几何保留本次停站候选并允许恢复', async (t) => {
  const complete = await (
    await provider({ emptyTrack: false }).fetchImpl(
      'https://rg-api.zenglingkun.cn/api/v2/mapLine?train=K1',
    )
  ).json();
  for (const [name, data, quality] of [
    ['empty', { stations: [], train: {} }, 'pending'],
    [
      'coordinates',
      { stations: [{ 甲: [0, 0] }, { 丙: [112, 32] }], train: {} },
      'pending',
    ],
    [
      'geometry',
      {
        ...complete.data,
        train: {
          bad: {
            index: 0,
            line: [
              [0, 0],
              [112, 32],
            ],
          },
        },
      },
      'station-schematic',
    ],
    ['shape', { ...complete.data, train: [] }, 'station-schematic'],
  ]) {
    await t.test(name, async (t) => {
      let attempts = 0;
      const { api } = await localServer(t, {
        fetchImpl: async () =>
          response(++attempts === 1 ? { success: true, data } : complete),
      });
      const body = { mode: 'train', number: 'K1', from: '甲', to: '丙' };
      const first = (await api('/api/route', body)).data;
      assert.equal(first.quality, quality);
      if (quality === 'pending')
        assert.equal(first.resolution.code, 'UPSTREAM_FORMAT');
      else assert.equal(first.requiresConfirmation, true);
      assert.equal((await api('/api/route', body)).data.quality, 'latest');
      assert.equal((await api('/api/route', body)).data.quality, 'latest');
      assert.equal(attempts, 2);
    });
  }
});

test('合法的 RailGo 停站候选继续缓存，轨道缺口只影响经过缺口的区间', async (t) => {
  const upstream = provider();
  const { api } = await localServer(t, upstream);
  const body = { mode: 'train', number: 'K1', from: '甲', to: '丙' };
  assert.equal(
    (await api('/api/route', body)).data.quality,
    'station-schematic',
  );
  assert.equal(
    (await api('/api/route', body)).data.quality,
    'station-schematic',
  );
  assert.equal(upstream.calls.length, 1);
  const fixture = JSON.parse(
    await readFile(
      new URL('./fixtures/g1802-railgo.json', import.meta.url),
      'utf8',
    ),
  );
  const full = await localServer(t, {
    fetchImpl: async () => response(fixture),
  });
  const result = (
    await full.api('/api/route', {
      mode: 'train',
      number: 'G1802',
      from: '南京南',
      to: '西安北',
    })
  ).data;
  assert.equal(result.quality, 'latest');
  assert.ok(result.distance > 1160 && result.distance < 1180);
});

test('原日期回退结果在路线查询重用，参考日期与请求日期分离', async (t) => {
  const upstream = provider({ oldDateFails: true });
  const { api } = await localServer(t, upstream);
  const lookup = await api('/api/train?number=K1&date=2026-07-07');
  assert.equal(lookup.data.isReference, true);
  assert.equal(lookup.data.referenceDate, '2026-09-26');
  assert.equal(lookup.data.date, '2026-07-07');
  const route = await api('/api/route', {
    mode: 'train',
    number: 'K1',
    date: '2026-07-07',
    from: '甲',
    to: '丙',
  });
  assert.equal(route.data.scheduleProvenance.basis, 'reference');
  assert.ok(
    route.data.warningDetails.some(
      (item) => item.code === 'SCHEDULE_REFERENCE',
    ),
  );
  assert.equal(
    upstream.calls.filter((url) => url.includes('search.12306')).length,
    2,
  );
});

test('重复站名必须选择站次，明确选择后只截取该次区间', async (t) => {
  const { api } = await localServer(t, provider({ repeated: true }));
  const body = {
    mode: 'train',
    number: 'K1',
    date: '2026-09-26',
    from: '甲',
    to: '丙',
  };
  const ambiguous = await api('/api/route', body);
  assert.equal(ambiguous.data.resolution.code, 'STOP_AMBIGUOUS');
  assert.equal(ambiguous.data.resolution.candidates.length, 2);
  const selected = await api('/api/route', {
    ...body,
    fromStopIndex: 2,
    toStopIndex: 3,
  });
  assert.equal(selected.data.quality, 'station-schematic');
  assert.equal(selected.data.stops.length, 2);
  const stale = await api('/api/route', {
    ...body,
    fromStopIndex: 1,
    toStopIndex: 3,
  });
  assert.equal(stale.data.resolution.code, 'STOP_SELECTION_CHANGED');
});

test('无来源时返回待补全，明确手动途经点才提供手动示意候选', async (t) => {
  const { api } = await localServer(t, {
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  const body = { mode: 'train', number: 'K1', from: '甲', to: '丙', via: '乙' };
  assert.equal((await api('/api/route', body)).data.quality, 'pending');
  const manual = (await api('/api/route', { ...body, manualSchematic: true }))
    .data;
  assert.equal(manual.quality, 'manual-schematic');
  assert.equal(manual.requiresConfirmation, true);
  assert.match(manual.routeNote, /未经停站/);
});

test('请求总预算到达不查询今日，不缓存失败，诊断不含行程或日期', async (t) => {
  const calls = [];
  const { api } = await localServer(t, {
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Promise(() => {});
    },
    schedulerOptions: { railIntervalMs: 0, upstreamTimeoutMs: 1000 },
  });
  const result = await api('/api/train?number=K1234&date=2026-07-07', null, {
    headers: { 'X-Travel-Budget-Ms': '25' },
  });
  assert.equal(result.status, 504);
  assert.equal(result.data.code, 'DEADLINE_EXCEEDED');
  assert.equal(result.data.retryable, true);
  assert.equal(calls.length, 1);
  const diagnostic = await api('/api/diagnostics');
  const serialized = JSON.stringify(diagnostic.data);
  assert.equal(diagnostic.status, 200);
  assert.equal(diagnostic.data.localOnly, true);
  assert.doesNotMatch(serialized, /K1234|2026-07-07|search\.12306|甲|丙/);
});

test('HTTP 接口校验 Host、Origin、方法、JSON 和请求体上限', async (t) => {
  const { api, base } = await localServer(t, {
    fetchImpl: async () => {
      throw new Error('must not query');
    },
  });
  assert.equal(
    (
      await api('/api/diagnostics', null, {
        headers: { Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  const wrongHost = await new Promise((resolve) => {
    http.get(
      base + '/api/diagnostics',
      { headers: { Host: 'evil.example' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
  });
  assert.equal(wrongHost, 403);
  const malformed = await fetch(base + '/api/route', {
    method: 'POST',
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, 'INVALID_INPUT');
  const tooLarge = await fetch(base + '/api/route', {
    method: 'POST',
    body: 'x'.repeat(32001),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((await api('/api/not-real')).status, 404);
});

test('默认本机能力保持 RailGo 可用，公开配置校验 HTTPS origin', async (t) => {
  const { api } = await localServer(t);
  const { data } = await api('/api/capabilities');
  assert.equal(data.deployment, 'local');
  assert.equal(data.railgoEnabled, true);
  assert.equal(data.notice, '');
  assert.equal(data.defaultRailProvider, 'railgo');
  assert.equal(data.autoRefreshRoutes, true);
  assert.deepEqual(
    data.railProviders.map((provider) => [provider.id, provider.available]),
    [
      ['railgo', true],
      ['osm-local', true],
    ],
  );
  for (const publicOrigin of [
    'http://tripreel.xinyang20.cn',
    'https://tripreel.xinyang20.cn/path',
    'https://tripreel.xinyang20.cn/../',
    'https://user:password@tripreel.xinyang20.cn',
    'https://tripreel.xinyang20.cn?query=1',
    'https://tripreel.xinyang20.cn?',
    'https://tripreel.xinyang20.cn#fragment',
    'https://tripreel.xinyang20.cn#',
    'tripreel.xinyang20.cn',
    '',
    false,
  ])
    await assert.rejects(
      createTravelServer({ publicOrigin, stations, airports }),
      TypeError,
    );
  await assert.rejects(
    createTravelServer({ railgoEnabled: 'false', stations, airports }),
    TypeError,
  );
});

test('公开部署按精确 Host 和 Origin 校验，不信任转发头', async (t) => {
  const publicOrigin = 'https://tripreel.xinyang20.cn',
    Host = 'tripreel.xinyang20.cn',
    body = { mode: 'flight', from: 'AAA', to: 'BBB' };
  const { base } = await localServer(t, {
    publicOrigin: 'https://tripReel.xinyang20.cn/',
    fetchImpl: async () => {
      throw new Error('must not query');
    },
  });
  const capabilities = await httpJSON(base, '/api/capabilities', {
    headers: { Host },
  });
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.headers['cache-control'], 'no-store');
  assert.equal(capabilities.data.deployment, 'public');
  assert.equal(capabilities.data.railgoEnabled, false);
  assert.match(capabilities.data.notice, /已停用 RailGo/);
  assert.equal(capabilities.data.defaultRailProvider, 'osm-local');
  assert.equal(capabilities.data.autoRefreshRoutes, false);
  assert.equal(
    (await httpJSON(base, '/api/diagnostics', { headers: { Host } })).data
      .localOnly,
    false,
  );
  for (const headers of [
    { Host: 'evil.example' },
    { Host: 'tripreel.xinyang20.cn.evil.example' },
    {
      Host: 'evil.example',
      'X-Forwarded-Host': Host,
      'X-Forwarded-Proto': 'https',
    },
  ]) {
    const result = await httpJSON(base, '/api/capabilities', { headers });
    assert.equal(result.status, 403);
    assert.equal(result.data.code, 'INVALID_HOST');
  }
  for (const Origin of [
    'https://evil.example',
    'http://tripreel.xinyang20.cn',
    'null',
  ]) {
    const result = await httpJSON(base, '/api/capabilities', {
      headers: { Host, Origin, 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(result.status, 403);
    assert.equal(result.data.code, 'INVALID_ORIGIN');
  }
  const missingOrigin = await httpJSON(base, '/api/route', {
    headers: { Host },
    body,
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal(missingOrigin.data.code, 'INVALID_ORIGIN');
  const sameOrigin = await httpJSON(base, '/api/route', {
    headers: {
      Host,
      Origin: publicOrigin,
      'X-Forwarded-Host': 'evil.example',
      'X-Forwarded-Proto': 'http',
    },
    body,
  });
  assert.equal(sameOrigin.status, 200);
  assert.equal(sameOrigin.data.quality, 'schematic');
  assert.equal((await httpJSON(base, '/api/capabilities')).status, 200);
});

test('公开禁用 RailGo 后仍能生成停站示意且不请求 RailGo', async (t) => {
  const upstream = provider({ emptyTrack: false });
  const { api } = await localServer(t, {
    ...upstream,
    publicOrigin: 'https://tripreel.xinyang20.cn',
  });
  const route = await api('/api/route', {
    mode: 'train',
    number: 'K1',
    date: '2026-09-26',
    from: '甲',
    to: '丙',
  });
  assert.equal(route.status, 200);
  assert.equal(route.data.quality, 'station-schematic');
  assert.equal(route.data.requiresConfirmation, true);
  assert.equal(route.data.routeSource, '12306');
  assert.ok(
    route.data.warnings.some((message) => message.includes('已停用 RailGo')),
  );
  assert.ok(upstream.calls.length > 0);
  assert.ok(
    upstream.calls.every((url) =>
      ['search.12306.cn', 'kyfw.12306.cn'].includes(new URL(url).hostname),
    ),
  );
});

test('停用 RailGo 的缺线路提示不可重试，手工和飞机示意不依赖上游', async (t) => {
  let calls = 0;
  const { api } = await localServer(t, {
    railgoEnabled: false,
    fetchImpl: async () => {
      calls++;
      throw new Error('must not query');
    },
  });
  const body = { mode: 'train', number: 'K1', from: '甲', to: '丙' };
  const pending = await api('/api/route', body);
  assert.equal(pending.data.resolution.state, 'unavailable');
  assert.equal(pending.data.resolution.code, 'OSM_ROUTE_UNAVAILABLE');
  assert.equal(pending.data.resolution.retryable, false);
  assert.match(pending.data.resolution.message, /完整停站表/);
  const manual = await api('/api/route', {
    ...body,
    via: '乙',
    manualSchematic: true,
  });
  assert.equal(manual.data.quality, 'manual-schematic');
  assert.equal(manual.data.requiresConfirmation, true);
  const flight = await api('/api/route', {
    mode: 'flight',
    from: 'AAA',
    to: 'BBB',
  });
  assert.equal(flight.data.quality, 'schematic');
  assert.equal(calls, 0);
});

test('公开模式强制禁用 RailGo，拒绝显式请求且不会触发上游', async (t) => {
  let calls = 0;
  const { api } = await localServer(t, {
    publicOrigin: 'https://tripreel.xinyang20.cn',
    railgoEnabled: true,
    fetchImpl: async () => {
      calls++;
      throw new Error('must not query');
    },
  });
  assert.equal((await api('/api/capabilities')).data.railgoEnabled, false);
  const denied = await api('/api/route', {
    mode: 'train',
    number: 'G1',
    date: '2026-10-02',
    from: '甲',
    to: '丙',
    provider: 'railgo',
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, 'RAIL_PROVIDER_DISABLED');
  assert.equal(calls, 0);
});

test('本机主动选择 OSM 或无效来源不暗中查询 RailGo', async (t) => {
  const upstream = provider({ emptyTrack: false });
  const { api } = await localServer(t, upstream);
  const body = {
    mode: 'train',
    number: 'K1',
    date: '2026-09-26',
    from: '甲',
    to: '丙',
  };
  const result = await api('/api/route', { ...body, provider: 'osm-local' });
  assert.equal(result.data.quality, 'station-schematic');
  assert.equal(result.data.routeProvider, 'osm-local');
  assert.ok(upstream.calls.every((url) => !url.includes('zenglingkun')));
  assert.equal(
    (await api('/api/route', { ...body, provider: 'other' })).status,
    400,
  );
});

test('OSM 白名单区间通过独立停站核对后返回待确认轨道参考', async (t) => {
  const dataset = JSON.parse(
    await readFile(
      new URL('../dist/data/rail-corridors.json', import.meta.url),
      'utf8',
    ),
  );
  const corridor = dataset.corridors[0],
    train = corridor.trains[0];
  const places = train.stops.map((name, index) => ({
    name,
    code: `S${String(index).padStart(2, '0')}`,
    coord: corridor.stations.find((stop) => stop.name === name)?.coord || [
      116, 39,
    ],
  }));
  const calls = [];
  let today = '2026-10-02';
  const { api } = await localServer(t, {
    publicOrigin: 'https://tripreel.xinyang20.cn',
    stations: places,
    osmDataset: dataset,
    today: () => today,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('search.12306.cn'))
        return response({
          data: [
            {
              station_train_code: 'G1',
              train_no: 'test-G1',
              from_station: train.stops[0],
              to_station: train.stops.at(-1),
            },
          ],
        });
      if (String(url).includes('queryByTrainNo'))
        return response({
          data: {
            data: train.stops.map((name, i) => ({
              station_name: name,
              arrive_time: `${String(i + 7).padStart(2, '0')}:00`,
              start_time: `${String(i + 7).padStart(2, '0')}:05`,
            })),
          },
        });
      throw new Error('unexpected source');
    },
  });
  const request = {
    mode: 'train',
    number: 'G1',
    date: '2026-10-02',
    from: '德州东',
    to: '南京南',
    provider: 'osm-local',
  };
  const result = await api('/api/route', request);
  assert.equal(result.data.quality, 'corridor');
  assert.equal(result.data.requiresConfirmation, true);
  assert.equal(result.data.routeDataVersion, dataset.dataVersion);
  assert.equal(result.data.routeProvider, 'osm-local');
  assert.equal(result.data.scheduleProvenance.source, '12306');
  assert.equal(result.data.routeEvidence.geometry.relationId, 356778);
  today = '2026-11-02';
  const expired = await api('/api/route', request);
  assert.equal(expired.data.quality, 'station-schematic');
  assert.equal(expired.data.requiresConfirmation, true);
  assert.equal(expired.data.routeProvider, 'osm-local');
  assert.equal(expired.data.routeEvidence, undefined);
  assert.match(
    (await api('/api/capabilities')).data.railProviders.find(
      (entry) => entry.id === 'osm-local',
    ).coverage,
    /已到期/,
  );
  assert.ok(
    calls.every(
      (url) => !url.includes('railgo') && !url.includes('zenglingkun'),
    ),
  );
});

test('G813 共线白名单继续优先使用经核验的 G1 区间', async (t) => {
  const fixtures = Object.fromEntries(
    await Promise.all(
      ['g813', 'g1', 'g813-main'].map(async (name) => [
        name,
        JSON.parse(
          await readFile(
            new URL(`./fixtures/${name}-railgo.json`, import.meta.url),
            'utf8',
          ),
        ),
      ]),
    ),
  );
  const calls = [];
  const { api } = await localServer(t, {
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      return response(
        parsed.pathname.includes('getTrainMain')
          ? fixtures['g813-main']
          : parsed.searchParams.get('train') === 'G1'
            ? fixtures.g1
            : fixtures.g813,
      );
    },
  });
  const result = (
    await api('/api/route', {
      mode: 'train',
      number: 'G813',
      from: '天津南',
      to: '南京南',
    })
  ).data;
  assert.equal(result.quality, 'corridor');
  assert.equal(result.requiresConfirmation, false);
  assert.ok(result.distance > 900 && result.distance < 905);
  assert.equal(
    calls.filter((url) => url.searchParams.get('train') === 'G1').length,
    1,
  );
  assert.equal(
    calls.filter((url) => url.pathname.includes('getTrainMain')).length,
    1,
  );
});

test('G813 最新主数据空表不缓存，恢复后仍可采用核验过的共线区间', async (t) => {
  const fixtures = Object.fromEntries(
    await Promise.all(
      ['g813', 'g1', 'g813-main'].map(async (name) => [
        name,
        JSON.parse(
          await readFile(
            new URL(`./fixtures/${name}-railgo.json`, import.meta.url),
            'utf8',
          ),
        ),
      ]),
    ),
  );
  let mainAttempts = 0;
  const { api } = await localServer(t, {
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes('getTrainMain'))
        return response(
          ++mainAttempts === 1
            ? { success: true, data: { timetable: [] } }
            : fixtures['g813-main'],
        );
      return response(
        parsed.searchParams.get('train') === 'G1' ? fixtures.g1 : fixtures.g813,
      );
    },
  });
  const body = { mode: 'train', number: 'G813', from: '天津南', to: '南京南' };
  assert.equal(
    (await api('/api/route', body)).data.quality,
    'station-schematic',
  );
  assert.equal((await api('/api/route', body)).data.quality, 'corridor');
  assert.equal(mainAttempts, 2);
});

test('HTTP 客户端取消释放共用请求，另一订阅仍能完成', async (t) => {
  let calls = 0,
    firstSignal,
    finish;
  const firstResponse = new Promise((resolve) => {
    finish = resolve;
  });
  const normal = provider();
  const { base } = await localServer(t, {
    fetchImpl: async (url, options) => {
      calls++;
      if (String(url).includes('search.12306')) {
        firstSignal = options.signal;
        await firstResponse;
      }
      return normal.fetchImpl(url);
    },
  });
  const firstController = new AbortController();
  const first = fetch(base + '/api/train?number=K1&date=2026-09-26', {
    signal: firstController.signal,
  });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = fetch(base + '/api/train?number=K1&date=2026-09-26');
  while (!firstSignal) await new Promise((resolve) => setImmediate(resolve));
  // Both local HTTP requests must reach the shared cache before cancelling one.
  await new Promise((resolve) => setTimeout(resolve, 10));
  firstController.abort();
  await rejected;
  assert.equal(firstSignal.aborted, false);
  finish();
  assert.equal((await (await second).json()).stops.length, 3);
  assert.equal(calls, 2);
});

test('航班 API 保留来源与计划字段，缺时刻留空，90天之外不发送请求', async (t) => {
  let calls = 0;
  const { api } = await localServer(t, {
    fetchImpl: async () => {
      calls++;
      return response({
        errCode: 0,
        status: 0,
        flightStatusList: [
          {
            flightNo: 'CA1234',
            deptCityCode: 'AAA',
            destCityCode: 'BBB',
            deptFlightDate: '2026-09-26',
            destFlightDate: '2026-09-27',
            std: '23:10',
            sta: '01:00',
            flightStatus: '计划',
          },
          {
            flightNo: 'CA1234',
            deptCityCode: 'AAA',
            destCityCode: 'BBB',
            std: '待定',
            sta: '待定',
          },
        ],
      });
    },
  });
  const result = await api('/api/flight?number=CA1234&date=2026-09-26');
  assert.equal(result.status, 200);
  assert.equal(result.data.flights[0].arrival, '2026-09-27T01:00');
  assert.equal(result.data.flights[1].departure, null);
  assert.equal(result.data.scheduleProvenance.sourceDate, '2026-09-26');
  const distant = await api('/api/flight?number=CA1234&date=2027-12-01');
  assert.equal(distant.data.code, 'DATE_NOT_AVAILABLE');
  assert.equal(calls, 1);
});

test('请求体读取也受总预算限制，慢上传超时后没有来源查询', async (t) => {
  let calls = 0;
  const { base } = await localServer(t, {
    fetchImpl: async () => {
      calls++;
      return response({});
    },
  });
  const result = await new Promise((resolve, reject) => {
    const request = http.request(
      base + '/api/route',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Travel-Budget-Ms': '20',
        },
      },
      (response) => {
        let text = '';
        response.on('data', (part) => (text += part));
        response.on('end', () => {
          resolve({ status: response.statusCode, data: JSON.parse(text) });
          request.destroy();
        });
      },
    );
    request.on('error', reject);
    request.write('{');
  });
  assert.equal(result.status, 504);
  assert.equal(result.data.code, 'DEADLINE_EXCEEDED');
  assert.equal(calls, 0);
});
