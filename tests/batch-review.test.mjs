// 合成日期、时刻与编号仅用于匹配测试，不代表真实班次或个人行程。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sameJourney, routeRequest, routeKey } from '../dist/batch-review.js';

const draft = {
  mode: 'train',
  number: 'G9001',
  date: '2030-02-03',
  from: '南京南',
  to: '西安北',
  departure: '2030-02-03T07:42',
  arrival: '2030-02-03T13:51',
};
const saved = {
  mode: 'train',
  number: 'G9001',
  queryDate: '2030-02-03',
  from: { name: '南京南站' },
  to: { name: '西安北站' },
  departure: '2030-02-03T07:40',
  arrival: '2030-02-03T13:45',
};
const lookup = {
  date: '2030-03-15',
  isReference: true,
  stops: [
    '上海虹桥',
    '南京南',
    '蚌埠南',
    '徐州东',
    '郑州东',
    '西安北',
    '宝鸡南',
  ].map((name) => ({ name })),
};

test('同日同车次同起止使用请求日期或实际出发日期识别重复，不因参考时刻变化新增', () => {
  assert.equal(sameJourney(draft, saved), true);
  assert.equal(
    sameJourney(
      { ...draft, number: 'g9001' },
      {
        ...saved,
        queryDate: '2030-03-15',
        departure: '2030-02-03T07:45',
        arrival: '2030-02-03T13:55',
      },
    ),
    true,
  );
  assert.equal(
    sameJourney(draft, {
      ...saved,
      departure: undefined,
      queryDate: '2030-02-03',
    }),
    true,
  );
  assert.equal(
    sameJourney(draft, {
      ...saved,
      departure: undefined,
      queryDate: undefined,
      date: '2030-02-03',
    }),
    true,
  );
  assert.equal(
    sameJourney(draft, { ...saved, queryDate: undefined, date: undefined }),
    true,
  );
  const flight = {
    mode: 'flight',
    number: 'CA9001',
    date: '2030-02-05',
    from: '南京禄口',
    to: '成都双流',
  };
  assert.equal(
    sameJourney(flight, {
      ...flight,
      from: { name: '南京禄口国际机场' },
      to: { name: '成都双流机场' },
      departure: '2030-02-05T20:00',
    }),
    true,
  );
});

test('不同日期、车次、方向、站点和交通方式不会误判为重复', () => {
  for (const other of [
    {
      ...draft,
      date: '2030-02-04',
      departure: '2030-02-04T07:42',
      arrival: '2030-02-04T13:51',
    },
    { ...draft, date: '2030-02-04', departure: undefined, arrival: undefined },
    { ...draft, number: 'G9002' },
    { ...draft, from: '西安北', to: '南京南' },
    { ...draft, from: '南京' },
    { ...draft, to: '西安' },
    { ...draft, mode: 'flight' },
  ])
    assert.equal(sameJourney(other, saved), false, JSON.stringify(other));
  assert.equal(
    sameJourney(
      {
        ...draft,
        date: '2030-03-15',
        departure: '2030-03-15T07:42',
        arrival: '2030-03-15T13:51',
      },
      {
        ...saved,
        queryDate: '2030-03-15',
        referenceDate: '2030-03-15',
        isReference: true,
      },
    ),
    false,
    '查询参考时刻的日期不是实际乘车日期',
  );
});

test('跨日列车中途上车按实际出发日去重，始发查询日与参考日期不覆盖实际日期', () => {
  const overnightSaved = {
    ...saved,
    queryDate: '2030-03-15',
    departure: '2030-03-16T01:40',
    arrival: '2030-03-16T07:45',
  };
  const overnightDraft = {
    ...draft,
    date: '2030-03-15',
    departure: '2030-03-16T01:42',
    arrival: '2030-03-16T07:51',
  };
  assert.equal(
    sameJourney(overnightDraft, overnightSaved),
    true,
    '同次跨日列车的始发查询日不妨碍实际乘坐区间去重',
  );
  assert.equal(
    sameJourney({ ...overnightDraft, date: '2030-03-16' }, overnightSaved),
    true,
    '按实际乘车日重新导入仍识别重复',
  );
  assert.equal(
    sameJourney(
      {
        ...overnightDraft,
        departure: '2030-03-15T01:42',
        arrival: '2030-03-15T07:51',
      },
      overnightSaved,
    ),
    false,
    '始发查询日当天的另一趟行程不是重复',
  );
  assert.equal(
    sameJourney(
      {
        ...draft,
        date: '2030-03-15',
        departure: undefined,
        arrival: undefined,
      },
      {
        ...saved,
        queryDate: '2030-03-15',
        referenceDate: '2030-03-15',
        isReference: true,
      },
    ),
    false,
    '缺少新行程时刻时也不能仅凭旧参考日期拦截',
  );
});

test('列车线路请求仅提取实际乘坐区间的中途停站，并使用参考数据日期', () => {
  assert.deepEqual(routeRequest(draft, lookup), {
    mode: 'train',
    number: 'G9001',
    date: '2030-03-15',
    from: '南京南',
    to: '西安北',
    via: '蚌埠南、徐州东、郑州东',
    fromCoord: undefined,
    toCoord: undefined,
  });
  assert.equal(
    routeRequest({ ...draft, from: '徐州东' }, lookup).via,
    '郑州东',
  );
  assert.equal(routeRequest({ ...draft, to: '蚌埠南' }, lookup).via, '');
  assert.equal(
    routeRequest(
      { ...draft, from: '西安北', to: '南京南', via: '自定站' },
      lookup,
    ).via,
    '自定站',
  );
  assert.equal(
    routeRequest({ ...draft, from: '未识别站', via: '自定站' }, lookup).via,
    '自定站',
  );
  const manual = {
    ...draft,
    via: '郑州东',
    fromCoord: [118.8, 31.9],
    toCoord: [108.9, 34.3],
  };
  assert.deepEqual(routeRequest(manual).fromCoord, manual.fromCoord);
  assert.deepEqual(routeRequest(manual).toCoord, manual.toCoord);
  assert.equal(routeRequest(manual).date, draft.date);
  assert.equal(routeRequest(manual).via, '郑州东');
});

test('线路缓存随起止和请求日期变化，调整时刻可继续复用，参考日期变化会更新', () => {
  const key = routeKey(draft, lookup);
  assert.equal(
    routeKey(
      { ...draft, departure: '2030-02-03T08:00', arrival: '2030-02-03T14:00' },
      lookup,
    ),
    key,
  );
  assert.notEqual(routeKey({ ...draft, from: '徐州东' }, lookup), key);
  assert.notEqual(routeKey({ ...draft, to: '郑州东' }, lookup), key);
  assert.notEqual(routeKey({ ...draft, date: '2030-02-04' }, lookup), key);
  assert.notEqual(routeKey(draft, { ...lookup, date: '2030-03-16' }), key);
  assert.notEqual(routeKey({ ...draft, date: '2030-02-04' }), routeKey(draft));
});

test('手工或文本指定途经站不被查询停站覆盖，包括主动清空', () => {
  const custom = {
    ...draft,
    via: '自定站、补充站',
    fieldSources: { via: { source: 'manual' } },
  };
  assert.equal(routeRequest(custom, lookup).via, '自定站、补充站');
  assert.equal(routeRequest({ ...custom, via: '' }, lookup).via, '');
  assert.equal(
    routeRequest({ ...custom, fieldSources: { via: 'text' } }, lookup).via,
    '自定站、补充站',
  );
  assert.equal(
    routeRequest({ ...draft, via: '单段手填', explicitVia: true }, lookup).via,
    '单段手填',
  );
});
