import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';
import { createTravelServer } from '../server.mjs';
import { addDays, lineLength } from '../dist/core.js';
import { mercatorPoint, fitInViewport } from '../dist/camera-fit.js';
import { buildTimeline, replayFrame } from '../dist/replay.js';
import { filterTrips } from '../dist/selectors.js';

const viewport = { width: 1280, height: 720 };
const warmupSamples = 3;
const measuredSamples = 15;
const browserWarmupFrames = 60;
const browserMeasuredFrames = 300;
const channel = process.env.TRIPREEL_PERF_CHANNEL || 'chrome';
const cpuOnly = process.argv.includes('--cpu-only');
const launchArgs = [
  '--enable-webgl',
  '--use-angle=gl',
  '--disable-gpu-sandbox',
];
const output = fileURLToPath(
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

function syntheticTrip(index, pointCount = 100) {
  const routeCoordinates = Array.from({ length: pointCount }, (_, i) => {
    const fraction = i / (pointCount - 1);
    return [
      110 + fraction * 10,
      30 + fraction * 4 + Math.sin(fraction * Math.PI * 4) * 0.35,
    ];
  });
  const travelDate = addDays('2027-01-01', index);
  return {
    id: `performance-synthetic-${index}`,
    mode: 'train',
    number: `G${9000 + index}`,
    travelDate,
    departure: `${travelDate}T08:00`,
    arrival: `${travelDate}T10:00`,
    from: { name: '合成甲站', coord: routeCoordinates[0] },
    to: { name: '合成乙站', coord: routeCoordinates.at(-1) },
    routeCoordinates,
    routeTiming: 'continuous',
    quality: 'manual-schematic',
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
    const timeline = buildTimeline([trip]);
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
    return {
      pointCount,
      tripCount: 1,
      filter: measure(() => filterTrips([trip], filters), 200),
      fit: measure(() => fitInViewport(points, fitOptions)),
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
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol))
        return route.continue();
      externalRequestsBlocked++;
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.waitForFunction(
      () =>
        !document.querySelector('#add-trip').disabled &&
        document.querySelector('#place-list').options.length > 0 &&
        document.querySelector('#map').dataset.ready === 'true',
      undefined,
      { timeout: 60000 },
    );
    const environment = await page.evaluate(() => {
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
    const trips = Array.from({ length: 500 }, (_, index) =>
      syntheticTrip(index),
    );
    const setupMs = await page.evaluate(async (items) => {
      const start = performance.now();
      await (await import('/store.js')).saveTrips(items);
      return performance.now() - start;
    }, trips);
    await page.waitForFunction(
      () => document.querySelectorAll('.trip-card').length === 500,
    );
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
          ['filter100', 'G91', '', 100],
          ['filterAll', '', 'G91', 500],
        ]) {
          const synchronousMs = [],
            throughNextFrameMs = [];
          for (
            let sample = -warmupSamples;
            sample < measuredSamples;
            sample++
          ) {
            setFilter(reset);
            await frame();
            await frame();
            const start = performance.now();
            setFilter(value);
            const sync = performance.now() - start;
            await frame();
            await frame();
            const elapsed = performance.now() - start;
            if (document.querySelectorAll('.trip-card').length !== count)
              throw new Error('页面筛选数量不符。');
            if (sample >= 0) {
              synchronousMs.push(sync);
              throughNextFrameMs.push(elapsed);
            }
          }
          result.push({
            name,
            visibleTrips: count,
            synchronousMs,
            throughNextFrameMs,
          });
        }
        return result;
      },
      { warmupSamples, measuredSamples },
    );
    await page.locator('#speed').selectOption('32');
    const playback = await page.evaluate(
      async ({ warmupFrames, measuredFrames }) => {
        const overlay = document.querySelector('#map-place-labels');
        let measuring = false;
        let mutations = 0,
          replacements = 0,
          nodesAdded = 0,
          nodesRemoved = 0;
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
        observer.observe(overlay, { childList: true });
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
        };
      },
      {
        warmupFrames: browserWarmupFrames,
        measuredFrames: browserMeasuredFrames,
      },
    );
    if (upstreamAttempts || externalRequestsBlocked || pageErrors.length)
      throw new Error(
        `性能页面出现异常：来源请求 ${upstreamAttempts}，外部请求 ${externalRequestsBlocked}，页面错误 ${pageErrors.length}。`,
      );
    return {
      status: 'complete',
      version: browser.version(),
      channel,
      headless: true,
      launchArgs,
      viewport,
      ...environment,
      isolation: {
        temporaryLoopbackPort: true,
        separateContext: true,
        upstreamAttempts,
        externalRequestsBlocked,
      },
      dataset: {
        trips: 500,
        pointsPerTrip: 100,
        nonOverlappingDates: true,
        synthetic: true,
        setupMs,
      },
      filters: pageFilter.map((row) => ({
        name: row.name,
        visibleTrips: row.visibleTrips,
        synchronousMs: {
          ...summary(row.synchronousMs),
          samples: row.synchronousMs,
        },
        throughNextFrameMs: {
          ...summary(row.throughNextFrameMs),
          samples: row.throughNextFrameMs,
        },
      })),
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
  schemaVersion: 1,
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
    console.log('测量隔离页面的 500 段筛选、回放及标签重建。');
    report.browser = await browserBaseline();
    report.status = 'complete';
  }
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`性能基线：${output}（${report.status}）`);
}
