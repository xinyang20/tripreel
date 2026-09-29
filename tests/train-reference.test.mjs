import test from 'node:test';
import assert from 'node:assert/strict';
import { queryTrainWithReference } from '../scripts/train-reference.mjs';
const today = '2026-09-21';
test('远期车次失败时提供今日候选，并保留跨午夜的日期差', async () => {
  const calls = [];
  const lookup = async (q) => {
    calls.push(q.get('date'));
    if (q.get('date') !== today) throw new Error('未查到');
    return {
      number: 'K1',
      date: today,
      stops: [
        {
          name: '甲',
          departure: '2026-09-21T23:00',
          arrival: '2026-09-21T23:00',
        },
        {
          name: '乙',
          arrival: '2026-09-22T23:55',
          departure: '2026-09-23T00:05',
        },
        {
          name: '丙',
          arrival: '2026-09-23T10:00',
          departure: '2026-09-23T10:00',
        },
      ],
    };
  };
  const r = await queryTrainWithReference(
    new URLSearchParams({ number: 'K1', date: '2027-01-31' }),
    lookup,
    today,
  );
  assert.deepEqual(calls, ['2027-01-31', today]);
  assert.equal(r.date, '2027-01-31');
  assert.equal(r.referenceDate, today);
  assert.equal(r.isReference, true);
  assert.equal(r.stops[1].arrival, '2027-02-01T23:55');
  assert.equal(r.stops[1].departure, '2027-02-02T00:05');
  assert.equal(r.stops[2].arrival, '2027-02-02T10:00');
});
test('所选日期可查询时不降级，查今日失败时不重复查询', async () => {
  let count = 0;
  const success = { stops: [] };
  assert.equal(
    await queryTrainWithReference(
      new URLSearchParams({ date: today }),
      async () => {
        count++;
        return success;
      },
      today,
    ),
    success,
  );
  assert.equal(count, 1);
  count = 0;
  await assert.rejects(
    () =>
      queryTrainWithReference(
        new URLSearchParams({ date: today }),
        async () => {
          count++;
          throw new Error('无车次');
        },
        today,
      ),
    /无车次/,
  );
  assert.equal(count, 1);
});
test('两次失败保留手动填写提示，无效日期不触发查询', async () => {
  await assert.rejects(
    () =>
      queryTrainWithReference(
        new URLSearchParams({ date: '2027-01-01' }),
        async () => {
          throw new Error('暂不可用');
        },
        today,
      ),
    /今日同车次也暂无/,
  );
  let count = 0;
  await assert.rejects(
    () =>
      queryTrainWithReference(
        new URLSearchParams({ date: '2026-02-31' }),
        async () => {
          count++;
        },
        today,
      ),
    /日期/,
  );
  assert.equal(count, 0);
});

test('用户取消或总预算耗尽不继续查询今日参考', async () => {
  for (const code of ['CANCELLED', 'DEADLINE_EXCEEDED']) {
    let calls = 0;
    const error = Object.assign(new Error('stopped'), { code });
    await assert.rejects(
      queryTrainWithReference(
        new URLSearchParams({ number: 'K1', date: '2026-07-07' }),
        async () => {
          calls++;
          throw error;
        },
        today,
      ),
      { code },
    );
    assert.equal(calls, 1);
  }
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    queryTrainWithReference(
      new URLSearchParams({ number: 'K1', date: '2026-07-07' }),
      async () => {
        calls++;
      },
      today,
      { signal: controller.signal },
    ),
    { code: 'CANCELLED' },
  );
  assert.equal(calls, 0);
});
