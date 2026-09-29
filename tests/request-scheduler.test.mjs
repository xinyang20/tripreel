import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createRequestScheduler,
  requestBudget,
  TravelError,
} from '../scripts/request-scheduler.mjs';
const response = (data) => ({ ok: true, json: async () => data });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('相同请求合并，一个订阅取消不终止其余订阅，并缓存成功结果', async (t) => {
  let calls = 0,
    upstreamSignal;
  const pending = deferred();
  const scheduler = createRequestScheduler({
    fetchImpl: async (_url, { signal }) => {
      calls++;
      upstreamSignal = signal;
      return pending.promise;
    },
  });
  t.after(() => scheduler.close());
  const one = new AbortController(),
    two = new AbortController();
  const first = scheduler.json('https://example.test/shared', '12306', {
    signal: one.signal,
    ttl: 1000,
  });
  const cancelled = assert.rejects(first, { code: 'CANCELLED' });
  const second = scheduler.json('https://example.test/shared', '12306', {
    signal: two.signal,
    ttl: 1000,
  });
  await flush();
  one.abort();
  await cancelled;
  assert.equal(calls, 1);
  assert.equal(upstreamSignal.aborted, false);
  pending.resolve(response({ ok: true }));
  assert.deepEqual(await second, { ok: true });
  assert.deepEqual(
    await scheduler.json('https://example.test/shared', '12306', { ttl: 1000 }),
    { ok: true },
  );
  assert.equal(calls, 1);
});

test('所有订阅取消后终止上游，并允许同一请求稍后重试', async (t) => {
  let calls = 0,
    signal;
  const scheduler = createRequestScheduler({
    fetchImpl: async (_url, options) => {
      calls++;
      signal = options.signal;
      return calls === 1 ? new Promise(() => {}) : response({ retry: true });
    },
  });
  t.after(() => scheduler.close());
  const controller = new AbortController(),
    pending = scheduler.json('https://example.test/abort', '12306', {
      signal: controller.signal,
    });
  const cancelled = assert.rejects(pending, { code: 'CANCELLED' });
  await flush();
  controller.abort();
  await cancelled;
  await flush();
  assert.equal(signal.aborted, true);
  assert.deepEqual(
    await scheduler.json('https://example.test/abort', '12306'),
    { retry: true },
  );
  assert.equal(calls, 2);
});

test('RailGo 串行、维持间隔，人工查询优先，取消排队项不请求上游', async (t) => {
  const first = deferred(),
    events = [];
  let active = 0,
    maxActive = 0;
  const scheduler = createRequestScheduler({
    railIntervalMs: 25,
    fetchImpl: async (url) => {
      events.push({ url, at: Date.now() });
      active++;
      maxActive = Math.max(maxActive, active);
      if (url.endsWith('/first')) await first.promise;
      active--;
      return response({ ok: true });
    },
  });
  t.after(() => scheduler.close());
  const a = scheduler.json('https://example.test/first', 'railgo');
  await flush();
  const background = scheduler.json(
    'https://example.test/background',
    'railgo',
    { priority: 'background' },
  );
  const controller = new AbortController(),
    remove = scheduler.json('https://example.test/remove', 'railgo', {
      signal: controller.signal,
    });
  const cancelled = assert.rejects(remove, { code: 'CANCELLED' });
  const foreground = scheduler.json(
    'https://example.test/foreground',
    'railgo',
  );
  await flush();
  controller.abort();
  await cancelled;
  first.resolve();
  await Promise.all([a, background, foreground]);
  assert.equal(maxActive, 1);
  assert.deepEqual(
    events.map((event) => event.url.split('/').at(-1)),
    ['first', 'foreground', 'background'],
  );
  assert.ok(events[1].at - events[0].at >= 23);
  assert.ok(events[2].at - events[1].at >= 23);
});

test('嵌套共享请求的人工优先级传递到 RailGo 等待队列', async (t) => {
  const first = deferred(),
    order = [];
  const scheduler = createRequestScheduler({
    railIntervalMs: 0,
    fetchImpl: async (url) => {
      order.push(url);
      if (url === 'first') await first.promise;
      return response({});
    },
  });
  t.after(() => scheduler.close());
  const active = scheduler.json('first', 'railgo');
  await flush();
  const outer = (key, priority) =>
    scheduler.memo(key, (context) => scheduler.json(key, 'railgo', context), {
      priority,
    });
  const bg = outer('background', 'background');
  const promotedBg = outer('promoted', 'background');
  await flush();
  const promotedFg = outer('promoted', 'foreground');
  first.resolve();
  await Promise.all([active, bg, promotedBg, promotedFg]);
  assert.deepEqual(order, ['first', 'promoted', 'background']);
});

test('排队限制和总预算覆盖排队，超时项不会稍后访问来源', async (t) => {
  const first = deferred(),
    called = [];
  const scheduler = createRequestScheduler({
    railIntervalMs: 0,
    maxRailQueue: 1,
    fetchImpl: async (url) => {
      called.push(url);
      if (url === 'first') await first.promise;
      return response({});
    },
  });
  t.after(() => scheduler.close());
  const active = scheduler.json('first', 'railgo');
  await flush();
  const budget = requestBudget(20);
  t.after(() => budget.dispose());
  const queued = scheduler.json('waiting', 'railgo', { signal: budget.signal });
  const expired = assert.rejects(queued, { code: 'DEADLINE_EXCEEDED' });
  await flush();
  await assert.rejects(scheduler.json('overflow', 'railgo'), {
    code: 'QUEUE_FULL',
  });
  await expired;
  first.resolve();
  await active;
  await flush();
  assert.deepEqual(called, ['first']);
  assert.equal(scheduler.diagnostics().queue.railWaiting, 0);
});

test('18 秒子预算可配置测试，格式错误/429/网络错误结构化且不缓存失败', async (t) => {
  let attempt = 0;
  const scheduler = createRequestScheduler({
    upstreamTimeoutMs: 15,
    fetchImpl: async () => {
      attempt++;
      if (attempt === 1) return new Promise(() => {});
      if (attempt === 2) return { ok: false, status: 429 };
      if (attempt === 3)
        return {
          ok: true,
          json: async () => {
            throw new SyntaxError();
          },
        };
      return response({ recovered: true });
    },
  });
  t.after(() => scheduler.close());
  await assert.rejects(scheduler.json('same', '12306'), {
    code: 'UPSTREAM_TIMEOUT',
    retryable: true,
  });
  await assert.rejects(scheduler.json('same', '12306'), {
    code: 'RATE_LIMITED',
    retryable: true,
  });
  await assert.rejects(scheduler.json('same', '12306'), {
    code: 'UPSTREAM_FORMAT',
    retryable: false,
  });
  assert.deepEqual(await scheduler.json('same', '12306'), { recovered: true });
  assert.equal(scheduler.diagnostics().sources['12306'].state, 'available');
  assert.equal(scheduler.diagnostics().sources['12306'].requests, 4);
});
