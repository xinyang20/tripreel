// 下列班次、日期和时刻均为合成数据；地点保留用于验证站名及机场别名。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBatchDraft } from '../dist/batch-resolver.js';

const today = '2030-03-15';
const stations = [
  { name: '天津南', code: 'TIP' },
  { name: '南京南', code: 'NKH' },
  { name: '上海虹桥', code: 'AOH' },
];
const airports = [
  { name: '南京禄口', code: 'NKG', icao: 'ZSNJ' },
  { name: '沈阳桃仙', code: 'SHE' },
  { name: '成都双流', code: 'CTU' },
];
const trainStops = [
  {
    name: '北京南',
    departure: '2030-03-04T08:00',
    arrival: '2030-03-04T08:00',
  },
  {
    name: '天津南',
    departure: '2030-03-04T08:40',
    arrival: '2030-03-04T08:38',
  },
  {
    name: '南京南',
    departure: '2030-03-04T12:40',
    arrival: '2030-03-04T12:38',
  },
  {
    name: '上海虹桥',
    departure: '2030-03-04T13:40',
    arrival: '2030-03-04T13:40',
  },
];
const trainDraft = {
  mode: 'train',
  number: 'G9003',
  date: '2030-03-04',
  from: '天津南',
  to: '南京南',
};
const flightDraft = {
  mode: 'flight',
  number: 'ZH9001',
  date: '2030-02-10',
  from: '南京禄口',
  to: '沈阳桃仙',
};
const flight = {
  number: 'ZH9001',
  from: airports[0],
  to: airports[1],
  departure: `${today}T23:10`,
  arrival: '2030-03-16T01:20',
  status: '计划',
};
const resolve = (draft, api) =>
  resolveBatchDraft(draft, { api, stations, airports, today });

test('列车按填写的乘坐区间补本站时刻，不覆盖成全程始发终到', async () => {
  const r = await resolve(
    { ...trainDraft, from: 'TIP', to: '南京南站' },
    async () => ({ stops: trainStops, source: '12306' }),
  );
  assert.equal(r.draft.from, '天津南');
  assert.equal(r.draft.to, '南京南');
  assert.equal(r.draft.departure, '2030-03-04T08:40');
  assert.equal(r.draft.arrival, '2030-03-04T12:38');
  assert.equal(r.lookup.stops.length, 4);
  assert.deepEqual(r.warnings, []);
});

test('跨日参考停站按实际乘车日复核失败后保留明确参考标记', async () => {
  const r = await resolve(trainDraft, async () => ({
    date: trainDraft.date,
    isReference: true,
    referenceDate: today,
    note: '今日同车次参考，请核对票面',
    stops: trainStops.map((s) => ({
      ...s,
      departure: s.departure.replace('03-04', '03-05'),
      arrival: s.arrival.replace('03-04', '03-05'),
    })),
  }));
  assert.equal(r.lookup.isReference, true);
  assert.equal(r.lookup.referenceDate, today);
  assert.equal(r.draft.departure, '2030-03-04T08:40');
  assert.equal(r.draft.queryDate, '2030-03-03');
  assert.match(r.warnings.join('\n'), /参考/);
});

test('未匹配或反向上下车站时保留地点，不采用任意时刻', async () => {
  const r = await resolve(
    { ...trainDraft, from: '南京南', to: '天津南' },
    async () => ({ stops: trainStops }),
  );
  assert.equal(r.draft.from, '南京南');
  assert.equal(r.draft.to, '天津南');
  assert.equal(r.draft.departure, undefined);
  assert.match(r.warnings.join('\n'), /未匹配/);
});

test('用户已填的两个时刻保留，仅提示与计划时刻的差异', async () => {
  const r = await resolve(
    {
      ...trainDraft,
      departure: '2030-03-04T09:00',
      arrival: '2030-03-04T13:00',
    },
    async () => ({ stops: trainStops }),
  );
  assert.equal(r.draft.departure, '2030-03-04T09:00');
  assert.equal(r.draft.arrival, '2030-03-04T13:00');
  assert.match(r.warnings.join('\n'), /已保留你填写/);
});

test('机场别名与 IATA 自动规范并明确提示仙桃笔误', async () => {
  const r = await resolve(
    { ...flightDraft, from: 'nkg', to: '沈阳仙桃国际机场' },
    async () => ({
      flights: [
        {
          ...flight,
          departure: '2030-02-10T10:00',
          arrival: '2030-02-10T12:00',
        },
      ],
    }),
  );
  assert.equal(r.draft.from, '南京禄口');
  assert.equal(r.draft.to, '沈阳桃仙');
  assert.match(r.warnings.join('\n'), /笔误.*沈阳桃仙/);
  assert.equal(r.lookup.selected.number, 'ZH9001');
});

test('历史航班失败改用今日参考，平移日期时保留跨午夜间隔', async () => {
  const calls = [];
  const r = await resolve(flightDraft, async (url) => {
    const date = new URL(url, 'http://localhost').searchParams.get('date');
    calls.push(date);
    if (date !== today) throw new Error('未查到');
    return { date, flights: [flight], source: '航旅纵横' };
  });
  assert.deepEqual(calls, ['2030-02-10', today]);
  assert.equal(r.draft.departure, '2030-02-10T23:10');
  assert.equal(r.draft.arrival, '2030-02-11T01:20');
  assert.equal(r.lookup.isReference, true);
  assert.equal(r.lookup.referenceDate, today);
  assert.equal(r.lookup.date, '2030-02-10');
  assert.equal(r.lookup.selected.isReference, true);
  assert.match(r.lookup.note, /仅|参考/);
});

test('查询失败保留全部识别信息，缺时刻留空，今日失败不重复查询', async () => {
  let count = 0;
  const r = await resolve({ ...flightDraft, date: today }, async () => {
    count++;
    throw new Error('离线');
  });
  assert.equal(count, 1);
  assert.equal(r.draft.from, '南京禄口');
  assert.equal(r.draft.to, '沈阳桃仙');
  assert.equal(r.lookup, null);
  assert.equal(r.draft.departure, undefined);
  assert.equal(r.draft.arrival, undefined);
  assert.match(r.warnings.join('\n'), /待补全：出发时间、到达时间/);
});

test('按用户起止机场筛选多个航段，不静默采用不符目的地', async () => {
  const other = { ...flight, to: airports[2] };
  const exact = await resolve(flightDraft, async () => ({
    flights: [other, flight],
  }));
  assert.equal(exact.lookup.selected.to.code, 'SHE');
  assert.equal(exact.candidates, undefined);
  const mismatch = await resolve(flightDraft, async () => ({
    flights: [other],
  }));
  assert.equal(mismatch.draft.to, '沈阳桃仙');
  assert.equal(mismatch.draft.departure, undefined);
  assert.equal(mismatch.lookup.selected, undefined);
  assert.equal(mismatch.candidates[0].draft.to, '成都双流');
  assert.match(mismatch.warnings.join('\n'), /不符/);
});

test('同起止机场多个航段保留待选，候选含各自完整时刻与来源', async () => {
  const second = {
    ...flight,
    departure: `${today}T16:00`,
    arrival: `${today}T18:20`,
  };
  const r = await resolve(flightDraft, async () => ({
    flights: [flight, second],
  }));
  assert.equal(r.candidates.length, 2);
  assert.equal(r.draft.departure, undefined);
  assert.equal(r.lookup.selected, undefined);
  assert.equal(r.candidates[1].draft.departure, `${today}T16:00`);
  assert.equal(r.candidates[1].lookup.selected, second);
});

test('火车地点不会跨类型匹配机场，输入对象保持不变', async () => {
  const input = { ...trainDraft, from: 'NKG' },
    before = structuredClone(input);
  const r = await resolve(input, async () => ({ stops: trainStops }));
  assert.deepEqual(input, before);
  assert.equal(r.draft.from, 'NKG');
  assert.equal(r.draft.departure, undefined);
});

test('格式错误保留可编辑字段，不发起查询', async () => {
  let count = 0;
  const r = await resolve({ ...trainDraft, date: '2030-02-31' }, async () => {
    count++;
  });
  assert.equal(count, 0);
  assert.equal(r.draft.from, '天津南');
  assert.match(r.error, /格式/);
});

test('坏响应结构按查询失败处理，不让单行错误中断批量确认', async () => {
  const r = await resolve(trainDraft, async () => ({ stops: { length: 1 } }));
  assert.equal(r.lookup, null);
  assert.equal(r.draft.from, '天津南');
  assert.equal(r.draft.departure, undefined);
  assert.match(r.warnings.join('\n'), /已保留/);
});

test('重复停站产生多个区间时必须选择，候选不会覆盖已填时间', async () => {
  const repeated = [
    ...trainStops,
    {
      ...trainStops[1],
      arrival: '2030-03-05T08:38',
      departure: '2030-03-05T08:40',
    },
    {
      ...trainStops[2],
      arrival: '2030-03-05T12:38',
      departure: '2030-03-05T12:40',
    },
  ];
  const r = await resolve(
    { ...trainDraft, departure: '2030-03-04T09:00' },
    async () => ({ stops: repeated }),
  );
  assert.equal(r.candidates.length, 3);
  assert.equal(r.draft.arrival, undefined);
  assert.ok(
    r.candidates.every(
      (candidate) => candidate.draft.departure === '2030-03-04T09:00',
    ),
  );
});

test('重查自动时刻更新为最新结果，而手动和原文时间保持不变', async () => {
  const input = {
    ...trainDraft,
    departure: '2030-03-04T07:00',
    arrival: '2030-03-04T13:00',
    fieldSources: {
      departure: { source: 'lookup' },
      arrival: { source: 'manual' },
    },
  };
  const r = await resolve(input, async () => ({
    date: trainDraft.date,
    stops: trainStops,
  }));
  assert.equal(r.draft.departure, '2030-03-04T08:40');
  assert.equal(r.draft.fieldSources.departure.source, 'lookup');
  assert.equal(r.draft.arrival, '2030-03-04T13:00');
  assert.equal(r.draft.fieldSources.arrival.source, 'manual');
});
test('实际乘车日期不被中途跨日覆盖，最多复核一次始发查询日', async () => {
  const calls = [];
  const r = await resolve(trainDraft, async (url) => {
    const date = new URL(url, 'http://localhost').searchParams.get('date');
    calls.push(date);
    const boardingDate = date === '2030-03-04' ? '2030-03-05' : '2030-03-04';
    return {
      date,
      stops: trainStops.map((s) => ({
        ...s,
        arrival: s.arrival.replace('2030-03-04', boardingDate),
        departure: s.departure.replace('2030-03-04', boardingDate),
      })),
    };
  });
  assert.deepEqual(calls, ['2030-03-04', '2030-03-03']);
  assert.equal(r.draft.date, '2030-03-04');
  assert.equal(r.draft.travelDate, '2030-03-04');
  assert.equal(r.draft.queryDate, '2030-03-03');
  assert.equal(r.draft.departure, '2030-03-04T08:40');
});
test('取消请求传播AbortSignal且不会继续请求今日参考', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    resolveBatchDraft(flightDraft, {
      airports,
      today,
      signal: controller.signal,
      api: async (_url, _body, options) => {
        calls++;
        assert.equal(options.signal, controller.signal);
        controller.abort();
        throw new DOMException('取消', 'AbortError');
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});
test('已选重复站站次保留，不重新退回首个同名区间', async () => {
  const stops = [
    ...trainStops,
    {
      ...trainStops[1],
      departure: '2030-03-04T14:00',
      arrival: '2030-03-04T13:58',
    },
    {
      ...trainStops[2],
      departure: '2030-03-04T18:02',
      arrival: '2030-03-04T18:00',
    },
  ];
  const r = await resolve(
    { ...trainDraft, fromStopIndex: 4, toStopIndex: 5 },
    async () => ({ date: trainDraft.date, stops }),
  );
  assert.equal(r.candidates, undefined);
  assert.equal(r.draft.fromStopIndex, 4);
  assert.equal(r.draft.toStopIndex, 5);
  assert.equal(r.draft.departure, '2030-03-04T14:00');
});
