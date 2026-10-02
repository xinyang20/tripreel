import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';
import { createTravelServer } from '../server.mjs';
import { addDays, lineLength } from '../dist/core.js';
import {
  mercatorPoint,
  fitInViewport,
  createCameraFitCache,
} from '../dist/camera-fit.js';
import { buildTimeline, replayFrame } from '../dist/replay.js';
import { filterTrips } from '../dist/selectors.js';
import { extractRoute } from '../dist/domain.js';

const viewport = { width: 1280, height: 720 };
const warmupSamples = 3;
const measuredSamples = 15;
const browserWarmupFrames = 60;
const browserMeasuredFrames = 300;
const channel = process.env.TRIPREEL_PERF_CHANNEL || 'chrome';
const cpuOnly = process.argv.includes('--cpu-only');
const software = process.env.TRAVEL_TEST_SOFTWARE_GL === '1';
const launchArgs = software
  ? ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : ['--enable-webgl'];
const output = process.env.TRIPREEL_PERF_OUTPUT
  ? path.resolve(process.env.TRIPREEL_PERF_OUTPUT)
  : fileURLToPath(
      new URL('../output/performance-baseline.json', import.meta.url),
    );

function summary(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    median:
      sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    min: sorted[0],
    max: sorted.at(-1),
  };
}

function summarizeStages(samples) {
  const names = [...new Set(samples.flatMap((stages) => Object.keys(stages)))];
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        callsPerOperation: summary(
          samples.map((stages) => stages[name]?.length || 0),
        ),
        totalMsPerOperation: summary(
          samples.map((stages) =>
            (stages[name] || []).reduce((sum, value) => sum + value, 0),
          ),
        ),
        callMs: summary(samples.flatMap((stages) => stages[name] || [])),
      },
    ]),
  );
}

function measurement(values) {
  return { ...summary(values), samples: values };
}

function target(name, actual, limit, unit = 'ms') {
  return { name, actual, limit, unit, passed: actual <= limit };
}
function memoryDelta(before, after) {
  const difference = (a, b) =>
    Object.fromEntries(
      Object.keys(b).map((key) => [
        key,
        typeof a[key] === 'number' && typeof b[key] === 'number'
          ? b[key] - a[key]
          : null,
      ]),
    );
  return {
    heap: difference(before.heap, after.heap),
    dom: difference(before.dom, after.dom),
  };
}

function targetsFor(report) {
  const dense = report.cpu?.denseRoutes.find(
    (row) => row.pointCount === 150000,
  );
  const checks = dense
    ? [
        target('150000点冷取景 p95', dense.fit.p95, 150),
        target('150000点缓存取景 p95', dense.fitCached.p95, 5),
        target('150000点单帧路径插值 p95', dense.replay.p95, 0.1),
      ]
    : [];
  const browser = report.browser;
  if (browser?.status === 'complete') {
    for (const filter of browser.filters) {
      checks.push(
        target(`${filter.name} 同步脚本 p95`, filter.synchronousMs.p95, 150),
      );
      checks.push(
        target(
          `${filter.name} 输入至两次 rAF p95`,
          filter.throughNextFrameMs.p95,
          250,
        ),
      );
    }
    checks.push(
      target(
        '稳定段标签新增/移除节点数',
        browser.stableLabels.nodesAdded + browser.stableLabels.nodesRemoved,
        0,
        'nodes',
      ),
    );
    checks.push(
      target(
        '稳定段标签身份变化',
        browser.stableLabels.sameNodes ? 0 : 1,
        0,
        'changes',
      ),
    );
    checks.push(
      target(
        '稳定段每帧标签布局次数',
        Math.max(...browser.stableLabels.layoutsPerFrame),
        1,
        'calls/frame',
      ),
    );
    checks.push(
      target(
        '回放 rAF 间隔 p95',
        browser.playback.frameIntervalMs.p95,
        1000 / 30,
      ),
    );
    checks.push(
      target(
        '回放超过50ms帧占比',
        browser.playback.intervalsOver50Ms / browser.playback.measuredFrames,
        0.01,
        'ratio',
      ),
    );
    checks.push(
      target(
        '500段准备定时取消到结束最大耗时',
        Math.max(
          ...browser.videoPreparation500.cancelled.map(
            (sample) => sample.scheduleToSettledMs,
          ),
        ),
        100,
      ),
    );
    checks.push(
      target(
        '密集单段准备取消含事件分派等待最大耗时',
        Math.max(
          ...browser.videoCycles.cycles
            .filter((sample) => sample.phase === 'preparing')
            .map(
              (sample) =>
                sample.preparationToCancelMs + sample.cancelToReleasedMs,
            ),
        ),
        100,
      ),
    );
    checks.push(
      target(
        '视频点击取消到资源释放最大耗时',
        Math.max(
          ...browser.videoCycles.cycles.map(
            (sample) => sample.cancelToReleasedMs,
          ),
        ),
        100,
      ),
    );
    checks.push(
      target(
        '视频取消残留资源数',
        Object.values(browser.videoCycles.finalResources).reduce(
          (sum, value) => sum + value,
          0,
        ),
        0,
        'resources',
      ),
    );
  }
  return {
    allMeasuredPassed: checks.every((check) => check.passed),
    completeScopeMeasured: browser?.status === 'complete',
    backend: browser?.backend || null,
    checks,
    note: 'complete 表示测量执行完成；是否达到目标由 checks 判定。软件渲染结果只适用于所记录的软件后端。',
  };
}

function syntheticTrip(index, pointCount = 100, mixed = false) {
  const routeCoordinates = Array.from({ length: pointCount }, (_, i) => {
    const fraction = i / (pointCount - 1);
    return [
      110 + (mixed ? (index % 10) * 0.2 : 0) + fraction * 10,
      30 +
        (mixed ? (index % 7) * 0.3 : 0) +
        fraction * 4 +
        Math.sin(fraction * Math.PI * 4) * 0.35,
    ];
  });
  const travelDate = addDays('2027-01-01', index);
  const flight = mixed && index % 5 === 0;
  const trip = {
    id: `performance-synthetic-${index}`,
    mode: flight ? 'flight' : 'train',
    number: `${flight ? 'CA' : 'G'}${9000 + index}`,
    travelDate,
    departure: `${travelDate}T08:00`,
    arrival: `${travelDate}T10:00`,
    from: {
      name: mixed
        ? `合成${index >= 100 && index < 200 ? '组A' : '组B'}甲${index}`
        : '合成甲站',
      coord: routeCoordinates[0],
    },
    to: {
      name: mixed ? `合成乙${index}` : '合成乙站',
      coord: routeCoordinates.at(-1),
    },
    routeCoordinates,
    routeTiming: 'continuous',
    quality: flight ? 'schematic' : 'manual-schematic',
    routeState: 'ready',
    routeConfirmed: true,
    routeFrozen: true,
    routeSource: '性能基线合成数据',
    routeNote: '仅用于隔离的性能测试，不代表任何实际行程或线路。',
    distance: lineLength(routeCoordinates),
    stops: [],
    legs: [],
    revision: 0,
  };
  if (mixed) {
    trip.routeHistory = [1, 2, 3].map((version) => ({
      ...extractRoute(trip),
      id: `history-${index}-${version}`,
      versionId: `history-${index}-${version}`,
      tripMode: trip.mode,
      routeCoordinates: routeCoordinates.map(([lng, lat], i) => [
        lng,
        lat + (i && i < pointCount - 1 ? version * 0.005 : 0),
      ]),
      routeConfirmed: true,
    }));
    if (index % 10 === 1)
      trip.routeCandidate = {
        ...trip.routeHistory[0],
        requiresConfirmation: true,
        routeConfirmed: false,
      };
  }
  return trip;
}

function measure(run, operationsPerSample = 1) {
  const values = [];
  let result;
  for (let sample = -warmupSamples; sample < measuredSamples; sample++) {
    const start = performance.now();
    for (let operation = 0; operation < operationsPerSample; operation++)
      result = run();
    const elapsed = (performance.now() - start) / operationsPerSample;
    if (sample >= 0) values.push(elapsed);
  }
  if (result == null) throw new Error('性能场景没有产生有效结果。');
  return {
    unit: 'ms/operation',
    operationsPerSample,
    ...summary(values),
    samples: values,
  };
}

function cpuBaseline() {
  const denseRoutes = [1000, 10000, 150000].map((pointCount) => {
    const trip = syntheticTrip(0, pointCount);
    const buildStart = performance.now();
    const timeline = buildTimeline([trip]);
    const indexPreparationMs = performance.now() - buildStart;
    const points = trip.routeCoordinates.map(mercatorPoint);
    const filters = { mode: 'train', year: '2027', search: '合成' };
    const fitOptions = {
      ...viewport,
      pitch: 48,
      bearing: -13,
      edge: 22,
      gap: 14,
      blockers: [
        { left: 24, top: 20, right: 400, bottom: 85 },
        { left: 24, top: 605, right: 1256, bottom: 700 },
      ],
    };
    const fitCache = createCameraFitCache();
    return {
      pointCount,
      tripCount: 1,
      filter: measure(() => filterTrips([trip], filters), 200),
      fit: measure(() => fitInViewport(points, fitOptions)),
      fitCached: measure(() => fitCache.fit(points, fitOptions)),
      indexPreparationMs,
      replay: measure(() => replayFrame(timeline, 0.5), 5),
    };
  });
  const trips = Array.from({ length: 500 }, (_, index) => syntheticTrip(index));
  const timeline = buildTimeline(trips);
  return {
    denseRoutes,
    manyTrips: {
      tripCount: trips.length,
      pointsPerTrip: trips[0].routeCoordinates.length,
      filterAll: measure(() => filterTrips(trips), 5),
      filter100: measure(() => filterTrips(trips, { search: 'G91' }), 5),
      buildTimeline: measure(() => buildTimeline(trips), 5),
      replayLastTrip: measure(() => replayFrame(timeline, 0.999), 200),
    },
  };
}

async function browserBaseline() {
  let upstreamAttempts = 0;
  let externalRequestsBlocked = 0;
  let browser;
  let context;
  let environment;
  const pageErrors = [];
  const server = await createTravelServer({
    fetchImpl: async () => {
      upstreamAttempts++;
      throw new Error('性能基线禁止外部来源请求。');
    },
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (server.address().port === 4173)
      throw new Error('性能基线禁止使用个人服务端口。');
    browser = await chromium.launch({
      headless: true,
      ...(channel === 'chromium' ? {} : { channel }),
      args: launchArgs,
    });
    context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
    });
    await context.addInitScript(() => {
      globalThis.__tripreelPerformance = {};
      const resources = (globalThis.__tripreelVideoResources = {
        streams: [],
        recorders: [],
        contexts: new Set(),
        urls: new Set(),
      });
      const capture = HTMLCanvasElement.prototype.captureStream,
        getContext = HTMLCanvasElement.prototype.getContext,
        Recorder = window.MediaRecorder,
        createUrl = URL.createObjectURL,
        revokeUrl = URL.revokeObjectURL;
      HTMLCanvasElement.prototype.captureStream = function (...args) {
        const stream = capture.apply(this, args);
        if (this.id === 'video-canvas') resources.streams.push(stream);
        return stream;
      };
      HTMLCanvasElement.prototype.getContext = function (...args) {
        const context = getContext.apply(this, args);
        if (
          context &&
          ['webgl', 'webgl2'].includes(args[0]) &&
          this.closest('.video-render-map')
        )
          resources.contexts.add(context);
        return context;
      };
      if (Recorder)
        window.MediaRecorder = class extends Recorder {
          constructor(...args) {
            super(...args);
            resources.recorders.push(this);
          }
        };
      URL.createObjectURL = function (blob) {
        const url = createUrl.call(this, blob);
        if (blob.type?.startsWith('video/')) resources.urls.add(url);
        return url;
      };
      URL.revokeObjectURL = function (url) {
        resources.urls.delete(url);
        return revokeUrl.call(this, url);
      };
    });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol))
        return route.continue();
      externalRequestsBlocked++;
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page),
      memory = [];
    const captureMemory = async (name, cycle = null, visibleTrips = null) => {
      await cdp.send('HeapProfiler.collectGarbage');
      const heap = await cdp.send('Runtime.getHeapUsage'),
        dom = await cdp.send('Memory.getDOMCounters');
      memory.push({
        name,
        cycle,
        visibleTrips,
        collectedGarbage: true,
        heap,
        dom,
      });
    };
    await page.exposeFunction('__tripreelHeapSnapshot', captureMemory);
    page.on('pageerror', (error) =>
      pageErrors.push(error.stack || error.message),
    );
    const firstOpenStart = performance.now();
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    environment = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      const graphics = gl
        ? {
            renderer: debug
              ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
              : gl.getParameter(gl.RENDERER),
            vendor: debug
              ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
              : gl.getParameter(gl.VENDOR),
          }
        : null;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      return { userAgent: navigator.userAgent, devicePixelRatio, graphics };
    });
    await page.waitForFunction(
      () =>
        !document.querySelector('#add-trip').disabled &&
        document.querySelector('#place-list').options.length > 0 &&
        document.querySelector('#map').dataset.ready === 'true',
      undefined,
      { timeout: 60000 },
    );
    const firstOpenMs = performance.now() - firstOpenStart;
    const trips = Array.from({ length: 500 }, (_, index) =>
      syntheticTrip(index, 300, true),
    );
    const setupMs = await page.evaluate(async (items) => {
      const start = performance.now();
      await (await import('/store.js')).saveTrips(items);
      return performance.now() - start;
    }, trips);
    await page.waitForFunction(
      () => document.querySelectorAll('.trip-card').length === 500,
    );
    const reloadStart = performance.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.trip-card').length === 500 &&
        document.querySelector('#map').dataset.ready === 'true',
      undefined,
      { timeout: 60000 },
    );
    const reload = {
      throughReadyMs: performance.now() - reloadStart,
      stages: await page.evaluate(() => globalThis.__tripreelPerformance),
    };
    await page.evaluate(async () => {
      const { Map } = await import('/vendor/maplibre-gl.mjs'),
        original = Map.prototype.getContainer;
      Map.prototype.getContainer = function (...args) {
        const container = original.apply(this, args);
        if (container.id === 'map') globalThis.__tripreelBenchmarkMap = this;
        return container;
      };
      try {
        document.querySelector('#fit-map').click();
      } finally {
        Map.prototype.getContainer = original;
      }
    });
    await page.waitForFunction(
      () =>
        globalThis.__tripreelBenchmarkMap?.loaded() &&
        !globalThis.__tripreelBenchmarkMap.isMoving(),
    );
    const memoryFilter = async (value) =>
      page.evaluate(async (value) => {
        const input = document.querySelector('#filter-search'),
          map = globalThis.__tripreelBenchmarkMap;
        const frame = () =>
          new Promise((resolve) => requestAnimationFrame(resolve));
        if (value !== undefined) {
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const deadline = performance.now() + 10000;
        do {
          await frame();
          await frame();
          if (performance.now() > deadline)
            throw new Error('内存测量筛选取景超时。');
        } while (!map.loaded() || map.isMoving());
      }, value);
    await memoryFilter();
    await captureMemory('initial500', 0, 500);
    for (let cycle = 1; cycle <= 5; cycle++) {
      await memoryFilter('合成组A');
      await captureMemory(`filter100-${cycle}`, cycle, 100);
      await memoryFilter('');
      await captureMemory(`all500-${cycle}`, cycle, 500);
    }
    const libraryOperations = await page.evaluate(async () => {
      const store = await import('/store.js');
      const frame = () =>
        new Promise((resolve) => requestAnimationFrame(resolve));
      const samples = {};
      const measure = async (name, work) => {
        globalThis.__tripreelPerformance = {};
        const start = performance.now();
        await work();
        const operationMs = performance.now() - start;
        await frame();
        await frame();
        (samples[name] ||= []).push({
          operationMs,
          throughNextFrameMs: performance.now() - start,
          stages: structuredClone(globalThis.__tripreelPerformance),
        });
      };
      const group = await store.saveGroup({
        id: 'benchmark-group',
        name: '合成性能分组',
        revision: 0,
      });
      const retained = store.state.saved[1];
      for (let i = 0; i < 5; i++) {
        await measure('snapshot', () => store.repository.snapshot());
        await measure('singleMetadata', () =>
          store.assignGroup(
            [
              {
                id: store.state.saved[0].id,
                revision: store.state.saved[0].revision,
              },
            ],
            i % 2 ? null : group.id,
          ),
        );
        await measure('singleSave', () =>
          store.saveTrips([
            { ...store.state.saved[0], number: `CA${9500 + i}` },
          ]),
        );
      }
      if (store.state.saved[1] !== retained)
        throw new Error('单条提交替换了未修改的记录引用。');
      const train = store.state.saved.find((item) => item.mode === 'train');
      await store.setRouteFrozen(
        train.id,
        false,
        train.revision,
        train.routeRevision,
      );
      for (let i = 0; i < 5; i++)
        await measure('routeFailure', () =>
          store.recordRouteAttempt(
            store.state.saved.find((item) => item.id === train.id),
            new Error('合成查询失败'),
          ),
        );
      const latest = store.state.saved.find((item) => item.id === train.id);
      await store.setRouteFrozen(
        latest.id,
        true,
        latest.revision,
        latest.routeRevision,
      );
      const backup = await store.exportBackup();
      for (let i = 0; i < 3; i++)
        await measure('restorePreview', () => store.previewRestore(backup));
      return samples;
    });
    const pageFilter = await page.evaluate(
      async ({ warmupSamples, measuredSamples }) => {
        const input = document.querySelector('#filter-search');
        const frame = () =>
          new Promise((resolve) => requestAnimationFrame(resolve));
        const setFilter = (value) => {
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const result = [];
        for (const [name, value, reset, count] of [
          ['filter100', '合成组A', '', 100],
          ['filterAll', '', '合成组A', 500],
        ]) {
          const synchronousMs = [],
            throughNextFrameMs = [],
            dispatchMs = [],
            renderMs = [],
            throughMapIdleMs = [],
            stageSamples = [];
          for (
            let sample = -warmupSamples;
            sample < measuredSamples;
            sample++
          ) {
            setFilter(reset);
            await frame();
            await frame();
            const resetDeadline = performance.now() + 10000;
            while (
              !globalThis.__tripreelBenchmarkMap.loaded() ||
              globalThis.__tripreelBenchmarkMap.isMoving()
            ) {
              if (performance.now() > resetDeadline)
                throw new Error('筛选重置后地图未完成绘制。');
              await frame();
            }
            globalThis.__tripreelPerformance = {};
            const start = performance.now();
            setFilter(value);
            const dispatch = performance.now() - start;
            await frame();
            await frame();
            const elapsed = performance.now() - start;
            const stages = globalThis.__tripreelPerformance;
            const rendered = (stages.render || []).reduce((a, b) => a + b, 0),
              sync = dispatch + rendered;
            if (!stages.render?.length)
              throw new Error('筛选没有记录实际渲染耗时。');
            if (document.querySelectorAll('.trip-card').length !== count)
              throw new Error('页面筛选数量不符。');
            const mapDeadline = performance.now() + 10000;
            while (
              !globalThis.__tripreelBenchmarkMap.loaded() ||
              globalThis.__tripreelBenchmarkMap.isMoving()
            ) {
              if (performance.now() > mapDeadline)
                throw new Error('筛选后地图未完成绘制。');
              await frame();
            }
            if (sample >= 0) {
              synchronousMs.push(sync);
              throughNextFrameMs.push(elapsed);
              dispatchMs.push(dispatch);
              renderMs.push(rendered);
              throughMapIdleMs.push(performance.now() - start);
              stageSamples.push(
                structuredClone(globalThis.__tripreelPerformance),
              );
            }
          }
          result.push({
            name,
            visibleTrips: count,
            synchronousMs,
            throughNextFrameMs,
            dispatchMs,
            renderMs,
            throughMapIdleMs,
            stageSamples,
          });
        }
        return result;
      },
      { warmupSamples, measuredSamples },
    );
    await captureMemory('measured-filters-complete');
    const stableLabels = await page.evaluate(async () => {
      const store = await import('/store.js'),
        controls = await import('/map.js'),
        map = globalThis.__tripreelBenchmarkMap,
        frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      document.querySelector('#follow').checked = false;
      controls.selectTrip(
        store.state.trips.find((trip) => trip.mode === 'train').id,
      );
      const deadline = performance.now() + 10000;
      while (map.isMoving() || !map.loaded()) {
        if (performance.now() > deadline)
          throw new Error('稳定标签场景取景超时。');
        await frame();
      }
      await frame();
      await frame();
      const overlay = document.querySelector('#map-place-labels'),
        nodes = [...overlay.querySelectorAll('svg,svg line,.map-place-label')];
      let added = 0,
        removed = 0;
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          added += record.addedNodes.length;
          removed += record.removedNodes.length;
        }
      });
      observer.observe(overlay, { childList: true, subtree: true });
      globalThis.__tripreelPerformance = {};
      document.querySelector('#speed').value = '1';
      document.querySelector('#speed').dispatchEvent(new Event('change'));
      document.querySelector('#play').click();
      map.panBy([3, 2], { duration: 600 });
      const frames = 60;
      const layoutsPerFrame = [];
      let previousLayouts = 0;
      for (let i = 0; i < frames; i++) {
        await frame();
        const count = globalThis.__tripreelPerformance.labelLayout?.length || 0;
        layoutsPerFrame.push(count - previousLayouts);
        previousLayouts = count;
      }
      controls.pause();
      await Promise.resolve();
      observer.disconnect();
      const after = [
          ...overlay.querySelectorAll('svg,svg line,.map-place-label'),
        ],
        stages = structuredClone(globalThis.__tripreelPerformance);
      document.querySelector('#follow').checked = true;
      document.querySelector('#restart').click();
      return {
        frames,
        follow: false,
        gentlePanPixels: [3, 2],
        nodesBefore: nodes.length,
        nodesAfter: after.length,
        sameNodes:
          nodes.length === after.length &&
          nodes.every((node, i) => node === after[i]),
        nodesAdded: added,
        nodesRemoved: removed,
        layoutCalls: stages.labelLayout?.length || 0,
        layoutsPerFrame,
        stages,
      };
    });
    await page.locator('#speed').selectOption('32');
    const playback = await page.evaluate(
      async ({ warmupFrames, measuredFrames }) => {
        const overlay = document.querySelector('#map-place-labels');
        let measuring = false;
        let mutations = 0,
          replacements = 0,
          nodesAdded = 0,
          nodesRemoved = 0;
        globalThis.__tripreelPerformance = {};
        const observer = new MutationObserver((records) => {
          if (!measuring) return;
          for (const record of records) {
            mutations++;
            nodesAdded += record.addedNodes.length;
            nodesRemoved += record.removedNodes.length;
            if (record.addedNodes.length && record.removedNodes.length)
              replacements++;
          }
        });
        observer.observe(overlay, { childList: true, subtree: true });
        const intervals = [];
        let elapsedMs, sampledTrips;
        document.querySelector('#play').click();
        await new Promise((resolve) => {
          let frame = 0,
            previous = 0,
            start = 0;
          const tick = (timestamp) => {
            if (frame >= warmupFrames) {
              if (!measuring) {
                measuring = true;
                start = timestamp;
              } else intervals.push(timestamp - previous);
            }
            previous = timestamp;
            frame++;
            if (intervals.length >= measuredFrames) {
              elapsedMs = timestamp - start;
              sampledTrips = document.querySelectorAll('.trip-card').length;
              measuring = false;
              observer.disconnect();
              document.querySelector('#play').click();
              resolve();
            } else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        return {
          intervals,
          elapsedMs,
          sampledTrips,
          mutations,
          replacements,
          nodesAdded,
          nodesRemoved,
          stages: structuredClone(globalThis.__tripreelPerformance),
        };
      },
      {
        warmupFrames: browserWarmupFrames,
        measuredFrames: browserMeasuredFrames,
      },
    );
    const videoPreparation500 = await page.evaluate(async () => {
      const store = await import('/store.js'),
        { buildTimeline } = await import('/replay.js'),
        { prepareVideoShots, videoViewportBlockers } =
          await import('/video-layout.js'),
        { fitInViewport } = await import('/camera-fit.js'),
        { prepareJourneyWorldPoints } = await import('/map-scene.js');
      const trips = store.state.trips,
        timeline = buildTimeline(trips),
        cancelled = [];
      const compute = async (scope, signal) =>
        fitInViewport(await prepareJourneyWorldPoints(scope, { signal }), {
          width: 1280,
          height: 720,
          pitch: 48,
          bearing: -13,
          blockers: videoViewportBlockers(),
        });
      globalThis.__tripreelPerformance = {};
      const start = performance.now();
      const cameras = await prepareVideoShots(trips, timeline, compute);
      const completeMs = performance.now() - start;
      for (let i = 0; i < 3; i++) {
        const controller = new AbortController(),
          scheduledAt = performance.now();
        let requestedAt;
        const timer = setTimeout(() => {
          requestedAt = performance.now();
          controller.abort();
        }, 0);
        try {
          await prepareVideoShots(
            trips,
            timeline,
            (scope) => compute(scope, controller.signal),
            {
              signal: controller.signal,
            },
          );
          throw new Error('500段准备未响应取消。');
        } catch (error) {
          if (error.name !== 'AbortError') throw error;
          cancelled.push({
            scheduleToSettledMs: performance.now() - scheduledAt,
            cancelDispatchDelayMs: requestedAt - scheduledAt,
            cancelToSettledMs: performance.now() - requestedAt,
          });
        } finally {
          clearTimeout(timer);
        }
      }
      return {
        trips: trips.length,
        shots: cameras.size,
        completeMs,
        cancelled,
        stages: structuredClone(globalThis.__tripreelPerformance),
        method:
          '只计算镜头，不创建导出地图或编码器；500段超过现有视频时长限制。',
      };
    });
    const videoCycles = await page.evaluate(
      async (denseTrip) => {
        const { openVideoExport } = await import('/video-export.js'),
          { prepareReadOnlyTrip } = await import('/domain.js'),
          { videoSnapshot } = await import('/video-options.js'),
          resources = globalThis.__tripreelVideoResources;
        // Normal exports receive store-owned, recursively read-only records.
        // Re-cloning this raw Playwright argument for every cycle would allocate
        // a new 150k-point route each time and only measure bounded LRU warmup.
        prepareReadOnlyTrip(denseTrip);
        const resourceState = () => ({
          hosts: document.querySelectorAll('.video-render-map').length,
          activeTracks: resources.streams
            .flatMap((stream) => stream.getTracks())
            .filter((track) => track.readyState !== 'ended').length,
          activeRecorders: resources.recorders.filter(
            (recorder) => recorder.state !== 'inactive',
          ).length,
          liveContexts: [...resources.contexts].filter(
            (context) => !context.isContextLost(),
          ).length,
          urls: resources.urls.size,
        });
        const results = [];
        for (const phase of [
          'preparing',
          'recording',
          'preparing',
          'recording',
          'preparing',
          'recording',
          'preparing',
          'recording',
        ]) {
          if (
            videoSnapshot([denseTrip])[0].routeCoordinates !==
            denseTrip.routeCoordinates
          )
            throw new Error('视频基准未复用同一只读几何。');
          openVideoExport({
            trips: [denseTrip],
            cityIndex: {},
            pitch: 48,
            bearing: -13,
            speed: 32,
          });
          document.querySelector('#video-resolution').value = '720';
          document.querySelector('#video-speed').value = '32';
          document
            .querySelector('#video-speed')
            .dispatchEvent(new Event('change'));
          delete document.querySelector('#video-canvas').dataset.prepareMs;
          globalThis.__tripreelPerformance = {};
          const contextsBefore = resources.contexts.size,
            recordersBefore = resources.recorders.length,
            streamsBefore = resources.streams.length;
          const result = await new Promise((resolve, reject) => {
            let requestedAt,
              preparationStartedAt,
              completed = false;
            const finish = (error, value) => {
              if (completed) return;
              completed = true;
              clearInterval(poll);
              clearTimeout(timeout);
              observer.disconnect();
              error ? reject(error) : resolve(value);
            };
            const cancel = () => {
              if (requestedAt !== undefined) return;
              requestedAt = performance.now();
              document.querySelector('#video-cancel').click();
            };
            const observer = new PerformanceObserver((list) => {
              for (const entry of list.getEntries())
                if (entry.name === 'tripreel-video-preparation-start') {
                  preparationStartedAt = entry.startTime;
                  if (phase === 'preparing') cancel();
                }
            });
            observer.observe({ type: 'mark' });
            const poll = setInterval(() => {
              if (
                phase === 'recording' &&
                resources.recorders
                  .slice(recordersBefore)
                  .some((recorder) => recorder.state === 'recording')
              )
                cancel();
              if (requestedAt === undefined) return;
              const remaining = resourceState();
              if (
                !Object.values(remaining).some(Boolean) &&
                !document.querySelector('#video-start').disabled
              ) {
                const prepareMs = Number(
                  document.querySelector('#video-canvas').dataset.prepareMs,
                );
                finish(null, {
                  phase,
                  cycle: results.length + 1,
                  cachePhase: results.length < 2 ? 'initial-pair' : 'repeated',
                  cancelToReleasedMs: performance.now() - requestedAt,
                  preparationToCancelMs: requestedAt - preparationStartedAt,
                  prepareMs: Number.isFinite(prepareMs) ? prepareMs : null,
                  createdContexts: resources.contexts.size - contextsBefore,
                  createdRecorders:
                    resources.recorders.length - recordersBefore,
                  createdStreams: resources.streams.length - streamsBefore,
                  remaining,
                  stages: structuredClone(globalThis.__tripreelPerformance),
                });
              }
            }, 5);
            const timeout = setTimeout(() => {
              document.querySelector('#video-cancel').click();
              finish(
                new Error(
                  '视频取消资源验证超时：' +
                    JSON.stringify(resourceState()) +
                    '；' +
                    document.querySelector('#video-status').textContent,
                ),
              );
            }, 30000);
            document.querySelector('#video-start').click();
          });
          if (phase === 'preparing' && result.createdRecorders)
            throw new Error('准备取消时编码器已经启动，测量阶段不成立。');
          if (!result.createdContexts)
            throw new Error('没有观察到视频WebGL上下文，资源测量不成立。');
          results.push(result);
          document.querySelector('#video-close').click();
          // Remove the instrumentation's strong references only after verifying
          // release, so inactive test recorders do not look like application leaks.
          resources.recorders = resources.recorders.filter(
            (recorder) => recorder.state !== 'inactive',
          );
          resources.streams = resources.streams.filter((stream) =>
            stream.getTracks().some((track) => track.readyState !== 'ended'),
          );
          resources.contexts = new Set(
            [...resources.contexts].filter(
              (context) => !context.isContextLost(),
            ),
          );
          await globalThis.__tripreelHeapSnapshot(
            `video-cancel-${results.length}`,
          );
        }
        return {
          trips: 1,
          routePoints: denseTrip.routeCoordinates.length,
          resolution: 720,
          speed: 32,
          inputBoundary:
            'prepareReadOnlyTrip; same record and primary geometry identity across all 8 cycles',
          cycles: results,
          finalResources: resourceState(),
        };
      },
      syntheticTrip(600, 150000),
    );
    await captureMemory('all-scenarios-complete');
    if (upstreamAttempts || externalRequestsBlocked || pageErrors.length)
      throw new Error(
        `性能页面出现异常：来源请求 ${upstreamAttempts}，外部请求 ${externalRequestsBlocked}，页面错误 ${pageErrors.length}。${pageErrors.join('\n')}`,
      );
    return {
      status: 'complete',
      version: browser.version(),
      channel,
      headless: true,
      launchArgs,
      viewport,
      ...environment,
      pageErrors,
      backend: /swiftshader|llvmpipe|softpipe/i.test(
        environment.graphics?.renderer || '',
      )
        ? 'software'
        : 'hardware-or-driver',
      isolation: {
        temporaryLoopbackPort: true,
        separateContext: true,
        upstreamAttempts,
        externalRequestsBlocked,
      },
      dataset: {
        trips: 500,
        pointsPerTrip: 300,
        primaryRoutePoints: 150000,
        totalStoredRoutePoints: 615000,
        trainTrips: 400,
        flightTrips: 100,
        historyPerTrip: 3,
        candidates: 50,
        nonOverlappingDates: true,
        synthetic: true,
        setupMs,
      },
      firstOpenMs,
      reload: {
        throughReadyMs: reload.throughReadyMs,
        stages: summarizeStages([reload.stages]),
      },
      memory: {
        unit: 'bytes',
        checkpoints: memory.filter((sample) => sample.cycle !== null),
        resourceSnapshots: memory.filter((sample) => sample.cycle === null),
        initialToFinal500Delta: memoryDelta(
          memory.find((sample) => sample.name === 'initial500'),
          memory.find((sample) => sample.name === 'all500-5'),
        ),
        warmedFilterRound1To5Delta: memoryDelta(
          memory.find((sample) => sample.name === 'all500-1'),
          memory.find((sample) => sample.name === 'all500-5'),
        ),
        repeatedVideoDelta: memoryDelta(
          memory.find((sample) => sample.name === 'video-cancel-2'),
          memory.find((sample) => sample.name === 'video-cancel-8'),
        ),
        lastVideoPairDelta: memoryDelta(
          memory.find((sample) => sample.name === 'video-cancel-6'),
          memory.find((sample) => sample.name === 'video-cancel-8'),
        ),
        note: '测试显式 GC 后的主页面 JS heap/DOM 快照，不包含全部 GPU 或进程内存。视频使用与 store 相同的只读边界，8轮共享同一15万点几何，保留首次准备/录制及全部后续轮次；旧版raw输入逐轮复制新数组产生的LRU预热不作为正常重复导出泄漏证据。缓存预热可造成有界增长；活动资源全0不等于证明没有内存泄漏，趋势需单独解释。已移除记录器/流/已丢失上下文的测试强引用。',
      },
      libraryOperations: Object.fromEntries(
        Object.entries(libraryOperations).map(([name, samples]) => [
          name,
          {
            operationMs: measurement(
              samples.map((sample) => sample.operationMs),
            ),
            throughNextFrameMs: measurement(
              samples.map((sample) => sample.throughNextFrameMs),
            ),
            stages: summarizeStages(samples.map((sample) => sample.stages)),
          },
        ]),
      ),
      filters: pageFilter.map((row) => ({
        name: row.name,
        visibleTrips: row.visibleTrips,
        synchronousMs: measurement(row.synchronousMs),
        dispatchMs: measurement(row.dispatchMs),
        renderMs: measurement(row.renderMs),
        throughNextFrameMs: measurement(row.throughNextFrameMs),
        throughMapIdleMs: measurement(row.throughMapIdleMs),
        stages: summarizeStages(row.stageSamples),
      })),
      stableLabels: {
        ...stableLabels,
        stages: summarizeStages([stableLabels.stages]),
      },
      videoPreparation500: {
        ...videoPreparation500,
        stages: summarizeStages([videoPreparation500.stages]),
      },
      videoCycles: {
        ...videoCycles,
        cycles: videoCycles.cycles.map((cycle) => ({
          ...cycle,
          stages: summarizeStages([cycle.stages]),
        })),
      },
      playback: {
        speed: 32,
        follow: true,
        warmupFrames: browserWarmupFrames,
        measuredFrames: browserMeasuredFrames,
        sampledTrips: playback.sampledTrips,
        elapsedMs: playback.elapsedMs,
        frameIntervalMs: {
          ...summary(playback.intervals),
          samples: playback.intervals,
        },
        callbackRateHz: 1000 / summary(playback.intervals).mean,
        intervalsOver33Ms: playback.intervals.filter(
          (value) => value > 1000 / 30,
        ).length,
        intervalsOver50Ms: playback.intervals.filter((value) => value > 50)
          .length,
        stages: summarizeStages([playback.stages]),
        labels: {
          childListMutations: playback.mutations,
          replacementBatches: playback.replacements,
          nodesAdded: playback.nodesAdded,
          nodesRemoved: playback.nodesRemoved,
          replacementsPerSampledFrame:
            playback.replacements / playback.intervals.length,
        },
      },
    };
  } catch (error) {
    error.benchmarkDiagnostics = {
      status: 'failed',
      version: browser?.version(),
      channel,
      headless: true,
      launchArgs,
      viewport,
      ...environment,
      pageErrors,
      upstreamAttempts,
      externalRequestsBlocked,
    };
    throw error;
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

const report = {
  schemaVersion: 3,
  generatedAt: new Date().toISOString(),
  status: 'running',
  environment: {
    node: process.version,
    os: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
    },
    cpu: { model: os.cpus()[0]?.model, logicalCores: os.cpus().length },
  },
  methodology: {
    warmupSamples,
    measuredSamples,
    percentile: 'nearest rank; median averages the middle pair for even counts',
    fitInput:
      'precomputed Mercator points; point conversion is outside timed region',
    playbackMetric:
      'requestAnimationFrame callback intervals, not compositor presentation or video encoding',
    filterSynchronousMetric:
      'input handler dispatch plus all render stage work through two rAF callbacks; includes synchronous synchronizeView',
    stageMetric:
      'stages may be nested; do not add stage totals together. Reported separately for each scenario, including zero calls per operation',
    reloadMetric:
      'same isolated context and IndexedDB after setup; includes application load to 500 cards and map load event; Playwright routing disables HTTP cache; OS file caches and runtime warmup are not reset',
    smallSamples:
      'storage 5, restore preview 3, reload 1, video cancellation 4 per phase; for these samples p95 equals maximum and is exploratory',
    videoResourceMetric:
      'real isolated export maps, MediaRecorder, canvas streams, WebGL context loss and video object URLs; preparation and recording cancelled four times each using the same prepareReadOnlyTrip input; initial pair retained, last pair heap delta reported after GC',
    syntheticOnly: true,
  },
};
try {
  console.log('测量合成路线的 CPU 基线。');
  report.cpu = cpuBaseline();
  if (cpuOnly) {
    report.browser = { status: 'skipped', reason: '--cpu-only' };
    report.status = 'cpu-only';
  } else {
    console.log(
      '测量隔离页面的 500 段读取、筛选、回放、稳定标签与视频取消资源释放。',
    );
    report.browser = await browserBaseline();
    report.status = 'complete';
  }
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  report.errorStack = error.stack;
  if (error.benchmarkDiagnostics) report.browser = error.benchmarkDiagnostics;
  process.exitCode = 1;
} finally {
  report.targets = targetsFor(report);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`性能基线：${output}（${report.status}）`);
}
