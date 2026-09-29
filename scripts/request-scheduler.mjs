export class TravelError extends Error {
  constructor(code, message, { retryable = false, status = 400 } = {}) {
    super(message);
    this.name = 'TravelError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export const isCancellation = (error) =>
  ['CANCELLED', 'DEADLINE_EXCEEDED'].includes(error?.code) ||
  error?.name === 'AbortError';

function abortReason(signal) {
  return signal?.reason instanceof TravelError
    ? signal.reason
    : new TravelError('CANCELLED', '已停止本次查询，填写的信息仍保留。', {
        status: 499,
      });
}
export function throwIfCancelled(signal) {
  if (signal?.aborted) throw abortReason(signal);
}
export function withSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
export function requestBudget(
  milliseconds,
  signal,
  code = 'DEADLINE_EXCEEDED',
) {
  const controller = new AbortController();
  const abort = () => controller.abort(abortReason(signal));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new TravelError(
          code,
          code === 'UPSTREAM_TIMEOUT'
            ? '数据来源响应超时，请稍后重试。'
            : '本次查询等待时间已到，已保留填写的信息，可稍后重试。',
          { retryable: true, status: 504 },
        ),
      ),
    Math.max(0, milliseconds),
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

// All caches and queues belong to one local server. Diagnostics never expose keys,
// URLs, train numbers, dates, endpoints, or returned timetable data.
export function createRequestScheduler({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  railIntervalMs = 1200,
  maxRailQueue = 24,
  upstreamTimeoutMs = 18000,
  cacheLimit = 400,
} = {}) {
  const cache = new Map(),
    inFlight = new Map(),
    railQueue = [];
  const sources = Object.fromEntries(
    ['12306', 'umetrip', 'railgo'].map((name) => [
      name,
      {
        state: 'unknown',
        lastSuccessAt: null,
        lastErrorCode: null,
        active: 0,
        requests: 0,
        successes: 0,
        failures: 0,
      },
    ]),
  );
  let railActive = false,
    railTimer,
    lastRailStart = -Infinity,
    sequence = 0,
    closed = false;
  const priorityValue = (value) =>
    typeof value === 'function' ? value() : value;

  function memo(
    key,
    loader,
    { ttl = 3600000, signal, priority = 'foreground' } = {},
  ) {
    throwIfCancelled(signal);
    if (closed)
      throw new TravelError('CANCELLED', '服务正在停止。', { status: 499 });
    const old = cache.get(key);
    if (old && old.expires > now()) return Promise.resolve(old.data);
    if (old) cache.delete(key);
    let entry = inFlight.get(key);
    if (!entry) {
      entry = {
        controller: new AbortController(),
        subscribers: 0,
        priority,
        settled: false,
      };
      inFlight.set(key, entry);
      entry.promise = Promise.resolve()
        .then(() => {
          throwIfCancelled(entry.controller.signal);
          return loader({
            signal: entry.controller.signal,
            priority: () => priorityValue(entry.priority),
          });
        })
        .then((data) => {
          throwIfCancelled(entry.controller.signal);
          if (ttl > 0) {
            if (cache.size >= cacheLimit)
              cache.delete(cache.keys().next().value);
            cache.set(key, { data, expires: now() + ttl });
          }
          return data;
        })
        .finally(() => {
          entry.settled = true;
          if (inFlight.get(key) === entry) inFlight.delete(key);
        });
    } else if (priorityValue(priority) === 'foreground')
      entry.priority = 'foreground';
    entry.subscribers++;
    return new Promise((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal?.removeEventListener('abort', abort);
        entry.subscribers--;
        if (!entry.subscribers && !entry.settled) {
          entry.controller.abort(
            new TravelError('CANCELLED', '所有查询已取消。', { status: 499 }),
          );
          if (inFlight.get(key) === entry) inFlight.delete(key);
        }
      };
      const abort = () => {
        release();
        reject(abortReason(signal));
      };
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then(
        (data) => {
          if (!released) {
            release();
            resolve(data);
          }
        },
        (error) => {
          if (!released) {
            release();
            reject(error);
          }
        },
      );
      if (signal?.aborted) abort();
    });
  }

  function pumpRail() {
    clearTimeout(railTimer);
    if (railActive || !railQueue.length || closed) return;
    const wait = Math.max(0, railIntervalMs - (now() - lastRailStart));
    if (wait) {
      railTimer = setTimeout(pumpRail, wait);
      return;
    }
    railQueue.sort(
      (a, b) =>
        Number(b.priority() === 'foreground') -
          Number(a.priority() === 'foreground') || a.sequence - b.sequence,
    );
    const task = railQueue.shift();
    task.signal?.removeEventListener('abort', task.abort);
    if (task.signal?.aborted) {
      task.reject(abortReason(task.signal));
      pumpRail();
      return;
    }
    railActive = true;
    lastRailStart = now();
    Promise.resolve()
      .then(task.run)
      .then(task.resolve, task.reject)
      .finally(() => {
        railActive = false;
        pumpRail();
      });
  }

  function queueRail(run, { signal, priority = () => 'foreground' }) {
    throwIfCancelled(signal);
    if (railQueue.length >= maxRailQueue)
      throw new TravelError(
        'QUEUE_FULL',
        '线路服务排队已满，请保留行程并稍后重试。',
        { retryable: true, status: 503 },
      );
    return new Promise((resolve, reject) => {
      const task = {
        run,
        signal,
        priority,
        resolve,
        reject,
        sequence: sequence++,
      };
      task.abort = () => {
        const index = railQueue.indexOf(task);
        if (index >= 0) railQueue.splice(index, 1);
        reject(abortReason(signal));
        pumpRail();
      };
      signal?.addEventListener('abort', task.abort, { once: true });
      railQueue.push(task);
      pumpRail();
    });
  }

  async function fetchJSON(url, source, signal) {
    throwIfCancelled(signal);
    const item = sources[source],
      budget = requestBudget(upstreamTimeoutMs, signal, 'UPSTREAM_TIMEOUT');
    item.requests++;
    item.active++;
    try {
      const response = await withSignal(
        fetchImpl(url, {
          signal: budget.signal,
          headers: {
            'User-Agent': 'TravelTrace/0.1 (personal local itinerary viewer)',
            Accept: 'application/json',
          },
        }),
        budget.signal,
      );
      if (!response.ok)
        throw new TravelError(
          response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_HTTP',
          `数据来源返回 ${response.status}，请稍后重试。`,
          {
            retryable: response.status === 429 || response.status >= 500,
            status: 502,
          },
        );
      let data;
      try {
        data = await withSignal(response.json(), budget.signal);
      } catch (error) {
        if (budget.signal.aborted) throw abortReason(budget.signal);
        throw new TravelError(
          'UPSTREAM_FORMAT',
          '数据来源的返回格式发生变化，请保留行程并稍后重试。',
          { status: 502 },
        );
      }
      item.state = 'available';
      item.lastSuccessAt = new Date(now()).toISOString();
      item.lastErrorCode = null;
      item.successes++;
      return data;
    } catch (error) {
      const normalized = budget.signal.aborted
        ? abortReason(budget.signal)
        : error instanceof TravelError
          ? error
          : new TravelError(
              'UPSTREAM_NETWORK',
              '数据来源暂时无法连接，请稍后重试。',
              { retryable: true, status: 502 },
            );
      if (!isCancellation(normalized)) {
        item.state = 'unavailable';
        item.lastErrorCode = normalized.code;
        item.failures++;
      }
      throw normalized;
    } finally {
      item.active--;
      budget.dispose();
    }
  }

  function json(url, source, options = {}) {
    return memo(
      `json:${url}`,
      (context) => {
        const run = () => fetchJSON(url, source, context.signal);
        return source === 'railgo' ? queueRail(run, context) : run();
      },
      { ttl: 0, ...options },
    );
  }

  return {
    memo,
    json,
    diagnostics() {
      return {
        sources: structuredClone(sources),
        queue: {
          railActive: Number(railActive),
          railWaiting: railQueue.length,
          railLimit: maxRailQueue,
          minIntervalMs: railIntervalMs,
        },
        cache: { entries: cache.size, inFlight: inFlight.size },
      };
    },
    close() {
      closed = true;
      clearTimeout(railTimer);
      for (const entry of inFlight.values())
        entry.controller.abort(
          new TravelError('CANCELLED', '服务正在停止。', { status: 499 }),
        );
      for (const task of railQueue.splice(0)) {
        task.signal?.removeEventListener('abort', task.abort);
        task.reject(
          new TravelError('CANCELLED', '服务正在停止。', { status: 499 }),
        );
      }
      cache.clear();
    },
  };
}
