import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBatch, parseBatchLines } from '../dist/core.js';

const sampleText = `火车 G1001 2027/7/7 南京南-西安北
火车 G1002 2027/7/10 西安北-南京南
火车 G1003 2027/9/4 仙林-苏州
火车 G1004 2027/9/5 苏州-南京
火车 G1005 2027/9/10 南京南-天津南
火车 G1006 2027/9/12 天津南-南京南
飞机 CA1001 2027/7/19 南京禄口-成都双流
飞机 CA1002 2027/7/21 成都双流-南京禄口
飞机 ZH1001 2027/8/29 南京禄口-沈阳仙桃
飞机 ZH1002 2027/9/29 沈阳仙桃-南京禄口
飞机 SC1001 2027/9/16 南京禄口-厦门高崎
飞机 MF1001 2027/9/18 厦门高崎-南京禄口`;

test('十二段合成示例文本完整解析，缺失时刻不编造，日期和地名保留', () => {
  const rows = parseBatch(sampleText);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows[0], {
    date: '2027-07-07',
    number: 'G1001',
    mode: 'train',
    from: '南京南',
    to: '西安北',
  });
  assert.deepEqual(rows[5], {
    date: '2027-09-12',
    number: 'G1006',
    mode: 'train',
    from: '天津南',
    to: '南京南',
  });
  assert.deepEqual(rows[9], {
    date: '2027-09-29',
    number: 'ZH1002',
    mode: 'flight',
    from: '沈阳仙桃',
    to: '南京禄口',
  });
  assert.equal(rows.filter((row) => row.mode === 'train').length, 6);
  assert.equal(rows.filter((row) => row.mode === 'flight').length, 6);
  assert.ok(
    rows.every(
      (row) => row.departure === undefined && row.arrival === undefined,
    ),
  );
});

test('兼容两列、六列、显式跨日，支持日期编号换序和可选信息', () => {
  const rows = parseBatch(`2027-09-21 G2
2027-09-22 CA1831 PEK XMN 23:10 +1 01:20
g1001 2027/7/7 南京南 → 西安北 7:42 13:51
2027-7-7 火车 G1001 南京南-西安北
飞机 CA1001 2027/7/19
2027/7/7 G1001 07:42 13:51
火车G1001 2027/7/7 南京南 07:42`);
  assert.deepEqual(rows[0], {
    date: '2027-09-21',
    number: 'G2',
    mode: 'train',
  });
  assert.equal(rows[1].arrival, '2027-09-23T01:20');
  assert.equal(rows[2].departure, '2027-07-07T07:42');
  assert.equal(rows[3].to, '西安北');
  assert.equal(rows[4].from, undefined);
  assert.equal(rows[5].to, undefined);
  assert.equal(rows[5].arrival, '2027-07-07T13:51');
  assert.equal(rows[6].arrival, undefined);
  assert.equal(rows[6].from, '南京南');
});

test('一行错误不会阻断其他行，错误保留原始行号，旧调用仍严格抛错', () => {
  const text =
    '火车 G1001 2027/7/7 南京南-西安北\n\n飞机 G1002 2027/7/10 西安北-南京南\n飞机 CA1001 2027/7/19 南京禄口-成都双流';
  const rows = parseBatchLines(text);
  assert.deepEqual(
    rows.map((row) => row.line),
    [1, 3, 4],
  );
  assert.equal(rows[0].error, null);
  assert.equal(rows[1].draft, null);
  assert.match(rows[1].error, /第 3 行.*交通方式/);
  assert.equal(rows[2].draft.number, 'CA1001');
  assert.equal(rows[2].raw, '飞机 CA1001 2027/7/19 南京禄口-成都双流');
  assert.throws(() => parseBatch(text), /第 3 行/);
});

test('拒绝无效日期、编号、时刻、冲突类型以及未明确的跨日', () => {
  for (const text of [
    '2027/2/29 G1',
    '2027/13/1 G1',
    '2027/9/1 2027/9/2 G1',
    '2027/9/1 hello',
    '2027/9/1 CAABC',
    '2027/9/1 G1 CA1001',
    '火车 CA1001 2027/9/1',
    '飞机 G1 2027/9/1',
    '2027/9/1 G1 北京 上海 24:00 25:00',
    '2027/9/1 G1 北京 上海 10:60 11:00',
    '2027/9/1 G1 北京 上海 10:0 11:00',
    '2027/9/1 G1 北京 上海 23:00 01:00',
    '2027/9/1 G1 北京 上海 23:00 +1',
    '2027/9/1 G1 北京 上海 23:00 +8 01:00',
    '2027/9/1 G1 北京 上海 10:00 11:00 12:00',
  ])
    assert.throws(() => parseBatch(text), undefined, text);
  assert.throws(() => parseBatch('  \n '), /请先粘贴/);
  assert.throws(
    () => parseBatch(Array(21).fill('2027/9/1 G1').join('\n')),
    /最多导入 20/,
  );
  assert.equal(
    parseBatch('2028/2/29 3U8888 成都双流-南京禄口')[0].date,
    '2028-02-29',
  );
});
