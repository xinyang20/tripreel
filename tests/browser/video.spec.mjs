import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const flight = (index) => {
  const day = String(index + 1).padStart(2, '0');
  return {
    id: `video-test-${index}`,
    mode: 'flight',
    number: `CA${1000 + index}`,
    travelDate: `2027-01-${day}`,
    departure: `2027-01-${day}T08:00`,
    arrival: `2027-01-${day}T10:00`,
    from: { name: '北京首都', code: 'PEK', coord: [116.6, 40.08] },
    to: { name: '厦门高崎', code: 'XMN', coord: [118.12, 24.54] },
    quality: 'schematic',
    distance: 1700,
    routeState: 'ready',
    routeConfirmed: true,
    stops: [],
    legs: [],
    revision: 0,
  };
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const originalCapture = HTMLCanvasElement.prototype.captureStream;
    const OriginalRecorder = window.MediaRecorder;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    window.videoTest = {
      streams: [],
      recorders: [],
      urls: new Set(),
      webmOnly: false,
      capturedTypes: [],
    };
    HTMLCanvasElement.prototype.captureStream = function (...args) {
      const stream = originalCapture.apply(this, args);
      if (this.id === 'video-canvas') window.videoTest.streams.push(stream);
      return stream;
    };
    window.MediaRecorder = class extends OriginalRecorder {
      constructor(...args) {
        super(...args);
        window.videoTest.recorders.push(this);
        window.videoTest.capturedTypes.push(this.mimeType);
      }
      static isTypeSupported(type) {
        return (
          (!window.videoTest.webmOnly || !type.includes('mp4')) &&
          OriginalRecorder.isTypeSupported(type)
        );
      }
    };
    URL.createObjectURL = function (blob) {
      const url = originalCreate.call(this, blob);
      if (blob.type?.startsWith('video/')) window.videoTest.urls.add(url);
      return url;
    };
    URL.revokeObjectURL = function (url) {
      window.videoTest.urls.delete(url);
      return originalRevoke.call(this, url);
    };
  });
});

async function openVideo(page, count = 1, speed = '32') {
  await page.goto('/');
  await expect(page.locator('#add-trip')).toBeEnabled();
  await page.evaluate(
    async (trips) => (await import('/store.js')).saveTrips(trips),
    Array.from({ length: count }, (_, index) => flight(index)),
  );
  await expect(page.locator('#map')).toHaveAttribute('data-ready', 'true');
  await page.locator('#export-video').click();
  await page.locator('#video-resolution').selectOption('720');
  await page.locator('#video-speed').selectOption(speed);
}

async function resourcesReleased(page, { preview = false } = {}) {
  await expect(page.locator('.video-render-map')).toHaveCount(0);
  await expect(page.locator('#video-start')).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        activeTracks: window.videoTest.streams
          .flatMap((stream) => stream.getTracks())
          .filter((track) => track.readyState !== 'ended').length,
        activeRecorders: window.videoTest.recorders.filter(
          (recorder) => recorder.state !== 'inactive',
        ).length,
      })),
    )
    .toEqual({ activeTracks: 0, activeRecorders: 0 });
  if (!preview) {
    await expect(page.locator('#video-download')).toBeHidden();
    expect(await page.locator('#video-result').getAttribute('src')).toBeNull();
    expect(await page.evaluate(() => window.videoTest.urls.size)).toBe(0);
  }
}

async function waitRecording(page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.videoTest.recorders.some(
          (recorder) => recorder.state === 'recording',
        ),
      ),
    )
    .toBe(true);
}

async function completedVideo(page, output, resolution = 720) {
  const downloaded = page.waitForEvent('download', { timeout: 350000 });
  await page.locator('#video-start').click();
  const download = await downloaded;
  if (output) await download.saveAs(output);
  await expect(page.locator('#video-result')).toBeVisible();
  const metadata = await page.locator('#video-result').evaluate((video) => ({
    width: video.videoWidth,
    height: video.videoHeight,
    duration: Number.isFinite(video.duration) ? video.duration : null,
    readyState: video.readyState,
    error: video.error?.message || null,
    bytes: Number(document.querySelector('#video-download').dataset.bytes),
    expectedSeconds: Number(
      document.querySelector('#video-download').dataset.seconds,
    ),
  }));
  expect(metadata).toMatchObject({
    width: (resolution * 16) / 9,
    height: resolution,
    error: null,
  });
  expect(metadata.readyState).toBeGreaterThanOrEqual(2);
  expect(metadata.bytes).toBeGreaterThan(1000);
  await resourcesReleased(page, { preview: true });
  return { download, metadata };
}

test('超过五分钟的预算阻止生成，调高倍速后恢复', async ({ page }) => {
  await openVideo(page, 13, '1');
  await expect(page.locator('#video-start')).toBeDisabled();
  await expect(page.locator('#video-status')).toContainText('五分钟');
  expect(await page.evaluate(() => window.videoTest.streams.length)).toBe(0);
  await expect(page.locator('.video-render-map')).toHaveCount(0);
  await page.locator('#video-speed').selectOption('2');
  await expect(page.locator('#video-start')).toBeEnabled();
});

test('地图准备阶段收到后台事件立即取消并清理', async ({ page }) => {
  await openVideo(page);
  await page.evaluate(async () => {
    const { Map } = await import('/vendor/maplibre-gl.mjs');
    const once = Map.prototype.once;
    Map.prototype.once = function (event, listener) {
      if (
        event === 'load' &&
        this.getContainer().classList.contains('video-render-map')
      )
        return this;
      return once.call(this, event, listener);
    };
  });
  await page.locator('#video-start').click();
  await expect(page.locator('.video-render-map')).toHaveCount(1);
  expect(await page.evaluate(() => window.videoTest.recorders.length)).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#video-status')).toContainText('后台');
  await resourcesReleased(page);
});

test('录制开始后可取消并重新生成，关闭时释放视频URL', async ({ page }) => {
  await openVideo(page);
  await page.locator('#video-start').click();
  await waitRecording(page);
  await page.locator('#video-cancel').click();
  await expect(page.locator('#video-status')).toContainText('已取消');
  await resourcesReleased(page);
  await completedVideo(page);
  expect(await page.evaluate(() => window.videoTest.urls.size)).toBe(1);
  await page.locator('#video-close').click();
  await resourcesReleased(page);
});

test('浏览器不支持MP4时实际编码并预览WebM', async ({ page }) => {
  await openVideo(page);
  await page.evaluate(() => {
    window.videoTest.webmOnly = true;
  });
  await page.locator('#video-speed').selectOption('16');
  const { download } = await completedVideo(
    page,
    'output/playwright/verified-fallback.webm',
  );
  expect(download.suggestedFilename()).toMatch(/\.webm$/);
  expect(
    await page.evaluate(() =>
      window.videoTest.capturedTypes.every((type) =>
        type.startsWith('video/webm'),
      ),
    ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await resourcesReleased(page);
});

for (const resolution of [720, 1080]) {
  test(`${resolution}p 以 1× 实际编码、预览并释放资源`, async ({ page }) => {
    await openVideo(page, 1, '1');
    await page.locator('#video-resolution').selectOption(String(resolution));
    const { download, metadata } = await completedVideo(
      page,
      undefined,
      resolution,
    );
    expect(metadata.expectedSeconds).toBe(26);
    expect(download.suggestedFilename()).toMatch(/\.mp4$/);
    expect(
      await page.evaluate(() => window.videoTest.capturedTypes[0]),
    ).toMatch(/^video\/mp4/);
    await page.locator('#video-close').click();
    await resourcesReleased(page);
  });
  test(`${resolution}p 视频片头、当前段和片尾的地名避开标题与底栏`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.videoLabelFrames = [];
      const frames = new WeakMap(),
        prototype = CanvasRenderingContext2D.prototype,
        transform = prototype.setTransform,
        rounded = prototype.roundRect,
        text = prototype.fillText;
      prototype.setTransform = function (...args) {
        if (this.canvas.id === 'video-canvas')
          frames.set(this, { phase: 'trip', labels: [] });
        return transform.apply(this, args);
      };
      prototype.roundRect = function (x, y, width, height, ...args) {
        const frame = frames.get(this);
        if (frame) frame.box = { x, y, width, height };
        return rounded.call(this, x, y, width, height, ...args);
      };
      prototype.fillText = function (value, ...args) {
        const frame = frames.get(this);
        if (frame) {
          if (String(value).startsWith('• ')) frame.labels.push(frame.box);
          if (value === '旅程即将开始') frame.phase = 'opening';
          if (String(value).startsWith('旅程已抵达')) frame.phase = 'closing';
          if (String(value).includes('Natural Earth'))
            window.videoLabelFrames.push({
              phase: frame.phase,
              labels: frame.labels,
            });
        }
        return text.call(this, value, ...args);
      };
    });
    await openVideo(page);
    await page.locator('#video-resolution').selectOption(String(resolution));
    await completedVideo(page, undefined, resolution);
    const result = await page.evaluate(async () => {
      const { videoViewportBlockers } = await import('/video-layout.js');
      const frames = window.videoLabelFrames;
      return {
        phases: [...new Set(frames.map((frame) => frame.phase))].sort(),
        labelCount: frames.reduce(
          (count, frame) => count + frame.labels.length,
          0,
        ),
        overlaps: frames.flatMap((frame) =>
          frame.labels.filter((label) =>
            videoViewportBlockers().some(
              (blocker) =>
                label.x < blocker.right &&
                label.x + label.width > blocker.left &&
                label.y < blocker.bottom &&
                label.y + label.height > blocker.top,
            ),
          ),
        ),
      };
    });
    expect(result.phases).toEqual(['closing', 'opening', 'trip']);
    expect(result.labelCount).toBeGreaterThan(0);
    expect(result.overlaps).toEqual([]);
    for (const [phase, seconds] of [
      ['opening', 0.8],
      ['trip', 2.35],
      ['closing', 3.6],
    ]) {
      const pixels = await page
        .locator('#video-result')
        .evaluate(async (video, time) => {
          video.pause();
          await new Promise((resolve, reject) => {
            video.addEventListener('seeked', resolve, { once: true });
            video.addEventListener('error', reject, { once: true });
            video.currentTime = time;
          });
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext('2d').drawImage(video, 0, 0);
          return canvas.toDataURL('image/png').split(',')[1];
        }, seconds);
      await writeFile(
        `output/playwright/video-${resolution}-${phase}.png`,
        Buffer.from(pixels, 'base64'),
      );
    }
    await page.locator('#video-close').click();
    await resourcesReleased(page);
  });
}

for (const failure of ['webgl', 'encoder']) {
  test(`${failure === 'webgl' ? 'WebGL中断' : '编码失败'}释放流、地图和预览资源`, async ({
    page,
  }) => {
    await openVideo(page);
    await page.locator('#video-start').click();
    await waitRecording(page);
    await page.evaluate((kind) => {
      if (kind === 'webgl') {
        document
          .querySelector('.video-render-map canvas')
          .dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
      } else {
        const event = new Event('error');
        Object.defineProperty(event, 'error', {
          value: new Error('测试编码失败'),
        });
        window.videoTest.recorders.at(-1).dispatchEvent(event);
      }
    }, failure);
    await expect(page.locator('#video-status')).toContainText(
      failure === 'webgl' ? '地图绘图中断' : '测试编码失败',
    );
    await resourcesReleased(page);
  });
}

test('超过250MB的编码分块立即中止且不保留下载资源', async ({ page }) => {
  await openVideo(page);
  await page.locator('#video-start').click();
  await waitRecording(page);
  await page.evaluate(() => {
    // Inject only the reported chunk size; do not allocate a 251 MiB Blob.
    window.videoTest.recorders.at(-1).ondataavailable({
      data: { size: 251 * 1024 * 1024 },
    });
  });
  await expect(page.locator('#video-status')).toContainText('超过 250 MB');
  await resourcesReleased(page);
});

for (const action of ['error', 'close']) {
  test(`预览${action === 'error' ? '解码失败' : '准备时关闭'}释放Blob并隐藏下载`, async ({
    page,
  }) => {
    await openVideo(page);
    await page.evaluate((pendingAction) => {
      const original = HTMLMediaElement.prototype.load;
      HTMLMediaElement.prototype.load = function () {
        if (this.id === 'video-result' && this.getAttribute('src')) {
          window.videoTest.previewStarted = true;
          if (pendingAction === 'error')
            queueMicrotask(() => this.dispatchEvent(new Event('error')));
          else
            queueMicrotask(() => {
              window.videoTest.urlsBeforeClose = window.videoTest.urls.size;
              window.videoTest.downloadHiddenBeforeClose = document
                .querySelector('#video-download')
                .classList.contains('hidden');
              document.querySelector('#video-close').click();
            });
          return;
        }
        return original.call(this);
      };
    }, action);
    await page.locator('#video-start').click();
    await expect
      .poll(() => page.evaluate(() => window.videoTest.previewStarted))
      .toBe(true);
    await expect(page.locator('#video-download')).toBeHidden();
    if (action === 'close') {
      expect(await page.evaluate(() => window.videoTest.urlsBeforeClose)).toBe(
        1,
      );
      expect(
        await page.evaluate(() => window.videoTest.downloadHiddenBeforeClose),
      ).toBe(true);
      await expect(page.locator('#video-dialog')).toBeHidden();
      await expect(page.locator('#video-status')).toContainText('已取消');
    } else {
      await expect(page.locator('#video-status')).toContainText('无法解码');
    }
    await resourcesReleased(page);
  });
}

test('接近预算上限的真实720p视频 @near-limit', async ({ page }) => {
  test.skip(
    process.env.TRAVEL_VIDEO_LONG !== '1',
    '单独设置 TRAVEL_VIDEO_LONG=1 执行约五分钟的实际录制',
  );
  test.slow();
  test.setTimeout(420000);
  await openVideo(page, 12, '1');
  const startedAt = Date.now();
  const progress = setInterval(async () => {
    try {
      console.log(
        '[near-limit]',
        await page.locator('#video-status').textContent(),
      );
    } catch {}
  }, 30000);
  try {
    const { download, metadata } = await completedVideo(
      page,
      'output/playwright/near-limit.mp4',
    );
    expect(download.suggestedFilename()).toMatch(/\.mp4$/);
    expect(metadata.expectedSeconds).toBe(290);
    expect(metadata.bytes).toBeLessThanOrEqual(250 * 1024 * 1024);
    expect((Date.now() - startedAt) / 1000).toBeGreaterThanOrEqual(285);
    if (metadata.duration !== null)
      expect(metadata.duration).toBeGreaterThanOrEqual(285);
    const report = {
      ...metadata,
      wallSeconds: (Date.now() - startedAt) / 1000,
      format: 'mp4',
      resolution: '720p',
      speed: 1,
      trips: 12,
      sample: 'synthetic',
      preview: 'decoded',
      recordedAt: new Date().toISOString(),
    };
    await writeFile(
      'output/playwright/near-limit.json',
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log('[near-limit] completed', JSON.stringify(report));
    await page.locator('#video-close').click();
    await resourcesReleased(page);
  } finally {
    clearInterval(progress);
  }
});
