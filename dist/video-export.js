import * as ML from './vendor/maplibre-gl.mjs';
import { $, status } from './store.js';
import { localDateTime } from './core.js';
import { canReplay } from './domain.js';
import {
  baseStyle,
  installJourneyLayers,
  journeyBounds,
  journeyWorldPoints,
  avatarPixel,
} from './map-scene.js';
import { fitInViewport } from './camera-fit.js';
import { buildTimeline, replayFrame } from './replay.js';
import { endpointPlaces, layoutPlaceLabels } from './map-labels.js';
import {
  videoBudget,
  recommendedSpeed,
  videoPresentation,
  videoRouteNote,
  videoFilename,
  VIDEO_MAX_BYTES,
} from './video-options.js';
let settings, controller, downloadUrl;
const abortError = () => new DOMException('已取消视频生成。', 'AbortError');
const formatCandidates = [
  'video/mp4;codecs=avc1.42E028',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];
export function videoFormat(Recorder = globalThis.MediaRecorder) {
  if (!Recorder) return null;
  return (
    formatCandidates.find((type) => Recorder.isTypeSupported(type)) || null
  );
}
function waitStopped(promise, signal, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const clean = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      },
      abort = () => {
        clean();
        reject(abortError());
      };
    const timer = setTimeout(() => {
      clean();
      reject(new Error('视频编码器未能完成收尾，请降低画质后重试。'));
    }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    promise.then(
      (value) => {
        clean();
        resolve(value);
      },
      (error) => {
        clean();
        reject(error);
      },
    );
  });
}
const estimate = () => {
  if (!settings) return;
  const budget = videoBudget(
      settings.trips,
      Number($('video-resolution').value),
      Number($('video-speed').value),
    ),
    format = videoFormat();
  $('video-estimate').textContent =
    `预计 ${Math.ceil(budget.seconds)} 秒 · 约 ${(budget.bytes / 1048576).toFixed(1)} MB（按目标码率估算） · ${format?.includes('mp4') ? 'MP4' : 'WebM'} · 本地底图`;
  $('video-scope').textContent =
    `当前范围 ${settings.trips.length} 段，将导出 ${budget.count} 段${budget.omitted ? '；' + budget.omitted + ' 段待补全，未纳入视频' : ''}。`;
  const omitted = settings.trips.filter((trip) => !canReplay(trip));
  $('video-omitted').classList.toggle('hidden', !omitted.length);
  $('video-omitted-list').replaceChildren(
    ...omitted.map((trip) => {
      const item = document.createElement('li');
      item.textContent = `${trip.number} · ${trip.travelDate || '日期待补全'} · ${trip.from.name} → ${trip.to.name}`;
      return item;
    }),
  );
  if (!budget.allowed)
    status(
      'video-status',
      budget.count
        ? '预计超过五分钟或 250 MB，请提高倍速或缩小导出范围。'
        : '当前范围没有可回放的行程。',
      true,
    );
  else status('video-status', '');
  $('video-start').disabled =
    !budget.allowed || !format || !HTMLCanvasElement.prototype.captureStream;
};
function revokeDownload() {
  $('video-result').pause();
  $('video-result').removeAttribute('src');
  $('video-result').load();
  $('video-result').classList.add('hidden');
  $('video-canvas').classList.remove('hidden');
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  $('video-download').classList.add('hidden');
  $('video-download').removeAttribute('href');
}
export function openVideoExport(options) {
  if (controller) return;
  settings = { ...options, trips: structuredClone(options.trips) };
  $('video-speed').value = String(recommendedSpeed(settings.trips));
  revokeDownload();
  $('video-stage').classList.add('hidden');
  $('video-progress').classList.add('hidden');
  status('video-status', '');
  estimate();
  $('video-dialog').showModal();
  if (!videoFormat() || !HTMLCanvasElement.prototype.captureStream) {
    status(
      'video-status',
      '当前浏览器暂不支持视频生成，请使用支持 MediaRecorder 的最新版 Chrome 或 Edge。',
      true,
    );
    $('video-start').disabled = true;
  } else estimate();
}
function waitMap(map, event, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const clean = () => {
      clearTimeout(timer);
      map.off(event, done);
      signal.removeEventListener('abort', abort);
    };
    const done = () => {
        clean();
        resolve();
      },
      abort = () => {
        clean();
        reject(abortError());
      };
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    map.once(event, done);
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      clean();
      reject(new Error('地图准备超时，请稍后重试。'));
    }, 20000);
  });
}
function rounded(ctx, x, y, w, h, r, fill, stroke) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
function renderMovieFrame(ctx, canvas, map, visual, projection, options) {
  const scale = canvas.width / 1280,
    w = 1280,
    h = 720;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(map.getCanvas(), 0, 0, w, h);
  const shade = ctx.createLinearGradient(0, 0, 0, 180);
  shade.addColorStop(0, 'rgba(255,255,255,.94)');
  shade.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, w, 180);
  ctx.font = '12px "PingFang SC","Microsoft YaHei",sans-serif';
  const labels = layoutPlaceLabels(
    visual.overview ? endpointPlaces(options.trips) : visual.frame.places,
    {
      project: (c) => {
        const p = map.project(c);
        return { x: p.x / scale, y: p.y / scale };
      },
      zoom: map.getZoom() - Math.log2(scale),
      width: w,
      height: h,
      cityIndex: options.cityIndex,
      detail: !visual.overview,
      measure: (name) => ctx.measureText(name).width + 26,
    },
  );
  for (const l of labels) {
    ctx.beginPath();
    ctx.moveTo(l.anchorX, l.anchorY);
    ctx.lineTo(
      Math.max(l.x, Math.min(l.x + l.width, l.anchorX)),
      Math.max(l.y, Math.min(l.y + l.height, l.anchorY)),
    );
    ctx.strokeStyle = '#a8c9dc';
    ctx.stroke();
    rounded(
      ctx,
      l.x,
      l.y,
      l.width,
      l.height,
      5,
      l.merged ? '#edf7ff' : 'rgba(255,255,255,.95)',
      '#b6d5e6',
    );
    ctx.fillStyle = '#325f7a';
    ctx.textAlign = 'center';
    ctx.fillText('• ' + l.name, l.x + l.width / 2, l.y + 18);
  }
  const pixel = avatarPixel(map, visual.frame.avatar, projection);
  if (pixel && !visual.overview) {
    const x = pixel.x / scale,
      y = pixel.y / scale;
    ctx.beginPath();
    ctx.arc(x, y - 22, 25, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#7cbbe5';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = '30px "Apple Color Emoji","Segoe UI Emoji",sans-serif';
    ctx.fillText(visual.frame.icon, x, y - 11);
    ctx.font = '13px "PingFang SC",sans-serif';
    const label = visual.frame.avatar.label,
      lw = ctx.measureText(label).width + 20;
    rounded(ctx, x - lw / 2, y + 12, lw, 28, 5, '#ffffffee', '#c3dcea');
    ctx.fillStyle = '#285774';
    ctx.fillText(label, x, y + 31);
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#7897ac';
  ctx.font = '12px sans-serif';
  ctx.fillText('TRIPREEL  /  途映', 42, 43);
  ctx.fillStyle = '#1c3b51';
  ctx.font = 'bold 28px "PingFang SC",sans-serif';
  const first = options.trips[0],
    last = options.trips.at(-1);
  ctx.fillText(
    visual.overview
      ? `${first.from.name}，到${last.to.name}`
      : visual.frame.title,
    42,
    84,
  );
  ctx.font = '14px "PingFang SC",sans-serif';
  ctx.fillStyle = '#5d819a';
  ctx.fillText(
    options.hideDates
      ? `${options.trips.length} 段旅程`
      : `${first.departure.slice(0, 10)} — ${last.arrival.slice(0, 10)} / ${options.trips.length} 段旅程`,
    42,
    115,
  );
  rounded(ctx, 40, 613, 1200, 65, 11, 'rgba(255,255,255,.94)', '#c7e0f2');
  ctx.fillStyle = '#275776';
  ctx.font = '16px "PingFang SC",sans-serif';
  ctx.fillText(
    visual.overview
      ? visual.progress >= 1
        ? '旅程已抵达 · 把走过的路，连成故事。'
        : '旅程即将开始'
      : visual.frame.title,
    61,
    640,
  );
  ctx.font = '12px "PingFang SC",sans-serif';
  ctx.fillStyle = '#638398';
  ctx.fillText(videoRouteNote(visual.frame.trip), 61, 661);
  ctx.textAlign = 'right';
  ctx.fillText(
    options.hideDates
      ? '旅程回放'
      : localDateTime(visual.frame.avatar.stamp).replace('T', '  '),
    1215,
    640,
  );
  ctx.textAlign = 'left';
  ctx.fillStyle = '#cee7f6';
  ctx.fillRect(61, 670, 1158, 3);
  ctx.fillStyle = '#71b1df';
  ctx.fillRect(61, 670, 1158 * visual.progress, 3);
  ctx.textAlign = 'right';
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#4c718a';
  ctx.fillText(
    '线路 RailGo · © Natural Earth · © OpenStreetMap contributors',
    1240,
    705,
  );
}
async function recordMovie(options, canvas, signal, onProgress) {
  const outerSignal = signal,
    session = new AbortController();
  const relayAbort = () => session.abort();
  outerSignal.addEventListener('abort', relayAbort, { once: true });
  signal = session.signal;
  if (outerSignal.aborted) session.abort();
  const height = Number($('video-resolution').value),
    width = (height * 16) / 9,
    speed = Number($('video-speed').value),
    timeline = buildTimeline(options.trips),
    seconds = timeline.duration / speed + 4;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d'),
    host = document.createElement('div');
  host.className = 'video-render-map';
  host.style.width = width + 'px';
  host.style.height = height + 'px';
  host.setAttribute('aria-hidden', 'true');
  document.body.append(host);
  let map,
    stream,
    recorder,
    raf,
    projection,
    renderHandler,
    visibilityHandler,
    watchdog,
    stopped,
    contextLostHandler,
    failRecording,
    renderFailure,
    visual = { overview: true, progress: 0, frame: replayFrame(timeline, 0) };
  const chunks = [];
  let recordedBytes = 0;
  const interrupt = (error) => {
    renderFailure = error;
    failRecording?.(error);
    session.abort();
  };
  visibilityHandler = () => {
    if (document.hidden)
      interrupt(
        new Error('页面已进入后台，生成已停止。请保持页面可见后重新导出。'),
      );
  };
  document.addEventListener('visibilitychange', visibilityHandler);
  watchdog = setTimeout(
    () => interrupt(new Error('视频准备或录制超时，请降低画质或缩小范围。')),
    (seconds + 40) * 1000,
  );
  try {
    visibilityHandler();
    if (signal.aborted) throw abortError();
    map = new ML.Map({
      container: host,
      style: structuredClone(baseStyle),
      center: [115, 32.5],
      zoom: 4,
      pitch: options.pitch,
      bearing: options.bearing,
      interactive: false,
      attributionControl: false,
      pixelRatio: 1,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    await waitMap(map, 'load', signal);
    installJourneyLayers(map, options.trips, (matrix) => (projection = matrix));
    const cameras = new Map(),
      scale = width / 1280;
    const frameTrip = (trips) => {
      const key = trips.map((t) => t.id).join('|');
      if (!cameras.has(key))
        cameras.set(
          key,
          fitInViewport(journeyWorldPoints(trips), {
            width,
            height,
            pitch: options.pitch,
            bearing: options.bearing,
            fov: map.getVerticalFieldOfView(),
            maxZoom: 13,
            edge: 28 * scale,
            gap: 20 * scale,
            blockers: [
              {
                left: 25 * scale,
                top: 25 * scale,
                right: 650 * scale,
                bottom: 125 * scale,
              },
              {
                left: 25 * scale,
                top: 600 * scale,
                right: 1255 * scale,
                bottom: 720 * scale,
              },
            ],
          }),
        );
      const fit = cameras.get(key);
      if (fit) map.jumpTo({ ...fit.camera, padding: 0 });
      else
        map.fitBounds(journeyBounds(trips), {
          padding: 60 * scale,
          maxZoom: 12,
          pitch: options.pitch,
          bearing: options.bearing,
          duration: 0,
          retainPadding: false,
        });
    };
    // Precompute individual shots before recording; 32× playback must not stall on fitting.
    for (const t of options.trips) frameTrip([t]);
    frameTrip(options.trips);
    await waitMap(map, 'idle', signal);
    if (signal.aborted) throw abortError();
    renderMovieFrame(ctx, canvas, map, visual, projection, options);
    // Drawing is kept in the render event so the WebGL frame and its 3D projection match.
    renderHandler = () => {
      try {
        renderMovieFrame(ctx, canvas, map, visual, projection, options);
      } catch (error) {
        renderFailure = error;
        failRecording?.(error);
      }
    };
    map.on('render', renderHandler);
    contextLostHandler = () => {
      renderFailure = new Error(
        '地图绘图中断，请关闭其他占用显卡的页面后重试。',
      );
      failRecording?.(renderFailure);
    };
    map.getCanvas().addEventListener('webglcontextlost', contextLostHandler);
    stream = canvas.captureStream(30);
    let startError;
    for (const mimeType of formatCandidates.filter((type) =>
      MediaRecorder.isTypeSupported(type),
    )) {
      try {
        recorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: height === 1080 ? 6000000 : 3500000,
        });
        stopped = new Promise((resolve, reject) => {
          recorder.ondataavailable = (e) => {
            if (e.data.size) {
              recordedBytes += e.data.size;
              if (recordedBytes > VIDEO_MAX_BYTES) {
                const error = new Error(
                  '视频超过 250 MB，已停止生成，请提高倍速或缩小范围。',
                );
                renderFailure = error;
                failRecording?.(error);
                return;
              }
              chunks.push(e.data);
            }
          };
          recorder.onstop = resolve;
          recorder.onerror = (e) =>
            reject(e.error || new Error('视频编码失败，请重试或降低画质。'));
        });
        stopped.catch(() => {});
        recorder.start(1000);
        startError = null;
        break;
      } catch (error) {
        startError = error;
        chunks.length = 0;
        recordedBytes = 0;
      }
    }
    if (startError || !recorder || recorder.state === 'inactive')
      throw startError || new Error('当前浏览器不能启动视频编码。');
    clearTimeout(watchdog);
    watchdog = setTimeout(
      () =>
        interrupt(new Error('视频录制超时，已停止生成，请提高倍速后重试。')),
      Math.min(305, seconds + 10) * 1000,
    );
    await new Promise((resolve, reject) => {
      const start = performance.now();
      let phase = 'overview',
        finished = false;
      const clean = () => {
        signal.removeEventListener('abort', abort);
      };
      const fail = (error) => {
        if (finished) return;
        finished = true;
        clean();
        cancelAnimationFrame(raf);
        reject(error);
      };
      failRecording = fail;
      const abort = () => fail(abortError());
      signal.addEventListener('abort', abort, { once: true });
      stopped.catch(fail);
      const tick = (now) => {
        try {
          if (signal.aborted) {
            abort();
            return;
          }
          const elapsed = (now - start) / 1000,
            progress = Math.max(
              0,
              Math.min(1, (elapsed - 2) / (timeline.duration / speed)),
            ),
            overview = elapsed < 2 || progress >= 1;
          visual = {
            overview,
            progress,
            frame: replayFrame(timeline, progress),
          };
          const next = overview
            ? 'overview'
            : visual.frame.item.type + visual.frame.trip.id;
          if (next !== phase) {
            phase = next;
            frameTrip(
              overview
                ? options.trips
                : visual.frame.item.type === 'gap'
                  ? [visual.frame.trip, visual.frame.item.next]
                  : [visual.frame.trip],
            );
          }
          map.triggerRepaint();
          onProgress(Math.min(1, elapsed / seconds), seconds);
          if (elapsed >= seconds) {
            finished = true;
            clean();
            resolve();
            return;
          }
          raf = requestAnimationFrame(tick);
        } catch (error) {
          fail(error);
        }
      };
      if (renderFailure) fail(renderFailure);
      else raf = requestAnimationFrame(tick);
    });
    if (signal.aborted) throw abortError();
    recorder.stop();
    await waitStopped(stopped, signal);
    if (signal.aborted) throw abortError();
    if (renderFailure) throw renderFailure;
    const type = recorder.mimeType || videoFormat(),
      blob = new Blob(chunks, { type });
    if (!blob.size) throw new Error('未生成有效视频，请重试。');
    return {
      blob,
      extension: type.includes('mp4') ? 'mp4' : 'webm',
      seconds,
      width,
      height,
    };
  } catch (error) {
    throw renderFailure || error;
  } finally {
    clearTimeout(watchdog);
    outerSignal.removeEventListener('abort', relayAbort);
    cancelAnimationFrame(raf);
    if (visibilityHandler)
      document.removeEventListener('visibilitychange', visibilityHandler);
    try {
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
        try {
          await waitStopped(stopped, undefined, 3000);
        } catch {}
      }
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      if (map && renderHandler) map.off('render', renderHandler);
      if (map && contextLostHandler)
        map
          .getCanvas()
          .removeEventListener('webglcontextlost', contextLostHandler);
      map?.remove();
      host.remove();
      chunks.length = 0;
    }
  }
}
function setBusy(busy) {
  $('video-start').disabled = busy;
  $('video-resolution').disabled = busy;
  $('video-speed').disabled = busy;
  for (const id of [
    'video-hide-dates',
    'video-hide-numbers',
    'video-cities-only',
  ])
    $(id).disabled = busy;
  $('video-cancel').classList.toggle('hidden', !busy);
}
$('video-resolution').onchange = estimate;
$('video-speed').onchange = estimate;
$('video-start').onclick = async () => {
  if (controller || !settings?.trips.length) return;
  if (
    !videoBudget(
      settings.trips,
      Number($('video-resolution').value),
      Number($('video-speed').value),
    ).allowed
  ) {
    estimate();
    return;
  }
  const presentation = {
    ...settings,
    hideDates: $('video-hide-dates').checked,
    hideNumbers: $('video-hide-numbers').checked,
    citiesOnly: $('video-cities-only').checked,
  };
  presentation.trips = videoPresentation(settings.trips, presentation);
  controller = new AbortController();
  revokeDownload();
  setBusy(true);
  $('video-stage').classList.remove('hidden');
  $('video-progress').classList.remove('hidden');
  $('video-progress').value = 0;
  status('video-status', '正在准备地图和视频…');
  try {
    const result = await recordMovie(
      presentation,
      $('video-canvas'),
      controller.signal,
      (progress, seconds) => {
        $('video-progress').value = progress;
        status(
          'video-status',
          `正在生成 ${Math.round(progress * 100)}% · 约剩 ${Math.max(0, Math.ceil(seconds * (1 - progress)))} 秒`,
        );
      },
    );
    downloadUrl = URL.createObjectURL(result.blob);
    const link = $('video-download');
    link.href = downloadUrl;
    link.download = videoFilename(
      settings.trips,
      presentation,
      result.extension,
    );
    link.textContent = `下载 ${result.extension.toUpperCase()} 视频`;
    link.dataset.bytes = String(result.blob.size);
    link.dataset.seconds = String(result.seconds);
    $('video-progress').value = 1;
    await new Promise((resolve, reject) => {
      const video = $('video-result');
      const timer = setTimeout(
        () =>
          finish(
            new Error('视频已编码但无法载入预览，请尝试其他格式或浏览器。'),
          ),
        12000,
      );
      const finish = (error) => {
        clearTimeout(timer);
        video.removeEventListener('loadeddata', ready);
        video.removeEventListener('error', failed);
        controller?.signal.removeEventListener('abort', cancel);
        error ? reject(error) : resolve();
      };
      const ready = () => finish();
      const failed = () =>
        finish(new Error('生成视频无法解码，请降低画质或更换浏览器。'));
      const cancel = () => finish(abortError());
      video.addEventListener('loadeddata', ready, { once: true });
      video.addEventListener('error', failed, { once: true });
      controller.signal.addEventListener('abort', cancel, { once: true });
      video.src = downloadUrl;
      video.load();
    });
    if (controller.signal.aborted) throw abortError();
    link.classList.remove('hidden');
    $('video-result').classList.remove('hidden');
    $('video-canvas').classList.add('hidden');
    status(
      'video-status',
      `视频已生成并通过浏览器预览：${result.width} × ${result.height} · ${Math.round(result.seconds)} 秒 · ${(result.blob.size / 1048576).toFixed(1)} MB。已开始下载，也可点击下方再次保存。`,
    );
    link.click();
  } catch (error) {
    revokeDownload();
    status(
      'video-status',
      error.name === 'AbortError'
        ? '已取消生成。'
        : error.message || '视频生成失败，请重试。',
      error.name !== 'AbortError',
    );
  } finally {
    controller = null;
    setBusy(false);
  }
};
$('video-cancel').onclick = () => controller?.abort();
$('video-close').onclick = () => {
  controller?.abort();
  revokeDownload();
  $('video-dialog').close();
};
$('video-dialog').addEventListener('cancel', () => {
  controller?.abort();
  revokeDownload();
});
window.addEventListener('pagehide', () => {
  controller?.abort();
  revokeDownload();
});
