import { measureStage } from './performance.js';
import * as ML from './vendor/maplibre-gl.mjs';
import { $, state, toast } from './store.js';
import { localDateTime } from './core.js';
import {
  baseStyle,
  installJourneyLayers,
  journeyBounds,
  journeyWorldPoints,
  avatarPixel,
} from './map-scene.js';
import { createCameraFitCache } from './camera-fit.js';
import { buildTimeline, replayFrame } from './replay.js';
import {
  endpointPlaces,
  layoutPlaceLabels,
  renderPlaceLabels,
} from './map-labels.js';
import { openVideoExport } from './video-export.js';
import { selectedScope } from './selectors.js';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const cameraFits = createCameraFitCache();
let labelFrame,
  labelKey = '',
  overviewPlaces = [],
  lastLabelView,
  selectedCardId;
let map,
  ready = false,
  timeline = buildTimeline([]),
  current = null,
  selectedTrip = null,
  frame,
  resizeTimer,
  lastTick = 0,
  lastCamera = 0,
  playbackPhase = '',
  online = false,
  projection,
  overview = true,
  cityIndex = {};
try {
  map = new ML.Map({
    container: 'map',
    style: structuredClone(baseStyle),
    center: [115, 32.5],
    zoom: 4.7,
    pitch: 48,
    bearing: -13,
    maxPitch: 70,
    minZoom: 2,
    maxZoom: 15,
    attributionControl: { compact: true },
    locale: {
      'NavigationControl.ZoomIn': '放大',
      'NavigationControl.ZoomOut': '缩小',
      'NavigationControl.ResetBearing': '恢复正北方向',
      'AttributionControl.ToggleAttribution': '数据来源',
    },
  });
  map.addControl(new ML.NavigationControl(), 'top-right');
} catch {
  $('map-notice').textContent =
    '无法启动三维地图，请启用硬件加速或换用 Chrome。行程仍可录入。';
}
fetch('/data/place-city-groups.json')
  .then((r) => r.json())
  .then((data) => {
    cityIndex = data;
    updateLabels(true);
  })
  .catch(() => {});
function viewportBlockers(container) {
  return [
    ...document.querySelectorAll(
      '.map-heading,.map-notice,.map-tools,.playback,.map-legend,.maplibregl-ctrl-top-right',
    ),
  ]
    .filter((el) => el.getClientRects().length)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left - container.left,
        top: r.top - container.top,
        right: r.right - container.left,
        bottom: r.bottom - container.top,
      };
    });
}
export function fitMap(trip, duration = 750) {
  if (!map) return;
  clearTimeout(resizeTimer);
  resizeTimer = undefined;
  const trips = trip ? [trip] : state.trips,
    points = journeyWorldPoints(trips);
  if (!points.length) {
    map.easeTo({
      center: [115, 32.5],
      zoom: 4.7,
      pitch: 48,
      bearing: -13,
      duration: reduced ? 0 : 900,
    });
    return;
  }
  const container = map.getContainer().getBoundingClientRect(),
    blockers = viewportBlockers(container);
  const fit = measureStage('cameraFit', () =>
    cameraFits.fit(points, {
      width: container.width,
      height: container.height,
      blockers,
      edge: container.width < 760 ? 16 : 22,
      gap: 14,
      pitch: map.getPitch(),
      bearing: map.getBearing(),
      fov: map.getVerticalFieldOfView(),
      maxZoom: 13,
    }),
  );
  const center = map.getCenter();
  if (
    fit &&
    !map.isMoving() &&
    Math.abs(center.lng - fit.camera.center[0]) < 1e-10 &&
    Math.abs(center.lat - fit.camera.center[1]) < 1e-10 &&
    Math.abs(map.getZoom() - fit.camera.zoom) < 1e-10 &&
    Object.values(map.getPadding()).every((value) => value === 0)
  )
    return;
  map.stop();
  if (fit)
    map.easeTo({ ...fit.camera, padding: 0, duration: reduced ? 0 : duration });
  else
    map.fitBounds(journeyBounds(trips), {
      padding: { top: 100, bottom: 150, left: 35, right: 35 },
      maxZoom: 12,
      duration: reduced ? 0 : duration,
      pitch: map.getPitch(),
      bearing: map.getBearing(),
      retainPadding: false,
    });
}
function updateLabels(force = false) {
  if (!ready || !map) return;
  const key = overview
    ? 'overview'
    : (current?.item.type || '') +
      ':' +
      (current?.trip.id || selectedTrip?.id || '');
  if (!force && labelKey === key) return;
  labelKey = key;
  if (labelFrame != null) return;
  labelFrame = requestAnimationFrame(() => {
    labelFrame = undefined;
    paintLabels();
  });
}
function paintLabels() {
  if (!ready || !map) return;
  const all = overview,
    places = all
      ? overviewPlaces
      : current?.places || endpointPlaces(selectedTrip ? [selectedTrip] : []),
    width = map.getContainer().clientWidth,
    height = map.getContainer().clientHeight,
    blockers = viewportBlockers(map.getContainer().getBoundingClientRect()),
    center = map.getCenter(),
    key = JSON.stringify([
      center.lng,
      center.lat,
      map.getZoom(),
      map.getPitch(),
      map.getBearing(),
      width,
      height,
      blockers,
      all,
      all
        ? null
        : places.map((place) => [
            place.name,
            place.coord,
            place.kind,
            place.code,
            place.city,
          ]),
    ]);
  if (
    lastLabelView?.key === key &&
    lastLabelView.cityIndex === cityIndex &&
    (!all || lastLabelView.places === places)
  )
    return;
  lastLabelView = { key, cityIndex, places };
  return measureStage('labelLayout', () => {
    const labels = layoutPlaceLabels(places, {
      project: (c) => map.project(c),
      zoom: map.getZoom(),
      width,
      height,
      cityIndex,
      detail: !all,
      blockers,
    });
    renderPlaceLabels($('map-place-labels'), labels);
  });
}

function positionAvatar() {
  const p = map && avatarPixel(map, current?.avatar, projection);
  $('traveller').classList.toggle('hidden', !p);
  if (p)
    $('traveller').style.transform = `translate(${p.x - 24}px,${p.y - 47}px)`;
}
export function drawMap({ geometry = true } = {}) {
  if (geometry) overviewPlaces = endpointPlaces(state.trips);
  selectedCardId = state.selected;
  timeline = buildTimeline(state.trips);
  if (!timeline.duration) pause();
  overview = state.progress <= 0 || state.progress >= 1;
  if (!ready || !map) return;
  if (geometry) {
    installJourneyLayers(map, state.trips, (matrix) => {
      projection = matrix;
      positionAvatar();
    });
  }
  updateReplay();
  if (geometry && $('follow').checked)
    fitMap(overview ? undefined : selectedTrip || undefined, 0);
  updateLabels(true);
}
function fitCurrentView() {
  if (!ready || !map || !$('follow').checked) return;
  fitMap(overview ? undefined : selectedTrip, 0);
  if (state.playing) lastCamera = performance.now() + 130;
}
function scheduleFit() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fitCurrentView, 100);
}
map?.on('load', () => {
  $('map').dataset.ready = 'true';
  ready = true;
  drawMap();
});
map?.on('move', () => {
  updateLabels(true);
  positionAvatar();
});
map?.on('resize', () => {
  updateLabels(true);
  positionAvatar();
  scheduleFit();
});
// CSS/fullscreen resizing can finish before an explicit map.resize() call. In
// that case MapLibre emits no resize event, so observe the container as well.
if (map)
  new ResizeObserver(() => {
    map.resize();
    scheduleFit();
  }).observe(map.getContainer());
function selectCard(id) {
  if (id === selectedCardId) return;
  if (selectedCardId)
    document
      .querySelector('[data-trip="' + CSS.escape(selectedCardId) + '"]')
      ?.classList.remove('selected');
  document
    .querySelector('[data-trip="' + CSS.escape(id) + '"]')
    ?.classList.add('selected');
  selectedCardId = id;
}
const setText = (element, value) => {
  if (element.textContent !== value) element.textContent = value;
};
export function updateReplay() {
  current = replayFrame(timeline, state.progress);
  selectedTrip = current?.trip || null;
  if (!current) {
    positionAvatar();
    $('playback-title').textContent = '准备好，再出发';
    $('current-time').textContent = '— — : — —';
    $('current-date').textContent = '行程回放 · 非实时定位';
    $('progress').value = '0';
    updateLabels();
    return;
  }
  const { trip, avatar, item } = current;
  setText($('playback-title'), current.title);
  setText(document.querySelector('.traveller-icon'), current.icon);
  setText($('traveller-label'), avatar.label);
  setText($('current-time'), localDateTime(avatar.stamp).slice(11));
  setText(
    $('current-date'),
    localDateTime(avatar.stamp).slice(0, 10) +
      (item.type === 'gap' ? ' · 停留已压缩' : ' · 旅程回放'),
  );
  $('progress').value = String(Math.round(state.progress * 1000));
  state.selected = trip.id;
  selectCard(trip.id);
  if (
    state.playing &&
    $('follow').checked &&
    item.type === 'trip' &&
    playbackPhase !== trip.id
  ) {
    playbackPhase = trip.id;
    const duration = Math.min(500, 1600 / state.speed);
    fitMap(trip, duration);
    lastCamera = performance.now() + duration;
  }
  if (
    state.playing &&
    $('follow').checked &&
    avatar.coord &&
    performance.now() - lastCamera > 130
  ) {
    lastCamera = performance.now();
    map?.easeTo({
      center: avatar.coord,
      duration: 160,
      easing: (x) => x,
      essential: true,
    });
  }
  map?.triggerRepaint();
  positionAvatar();
  updateLabels();
}
export function pause() {
  state.playing = false;
  playbackPhase = '';
  cancelAnimationFrame(frame);
  $('play').textContent = '▶';
  $('play').setAttribute('aria-label', '播放旅程');
}
function tick(now) {
  if (!state.playing) return;
  const dt = Math.min((now - lastTick) / 1000, 0.2);
  lastTick = now;
  state.progress = Math.min(
    1,
    state.progress + (dt * state.speed) / timeline.duration,
  );
  updateReplay();
  if (state.progress >= 1) {
    pause();
    overview = true;
    if ($('follow').checked) fitMap();
    updateLabels();
    return;
  }
  frame = requestAnimationFrame(tick);
}
export function selectTrip(id) {
  pause();
  const item = timeline.items.find(
    (x) => x.type === 'trip' && x.trip.id === id,
  );
  if (!item) {
    const trip = state.trips.find((t) => t.id === id);
    if (!trip) return;
    current = null;
    selectedTrip = trip;
    overview = false;
    state.selected = id;
    positionAvatar();
    $('playback-title').textContent = trip.number + ' · 待补全';
    $('current-time').textContent = '— — : — —';
    $('current-date').textContent = '时刻或线路未完整，暂不回放';
    if (trip.from?.coord || trip.to?.coord) fitMap(trip);
    selectCard(id);
    updateLabels();
    return;
  }
  overview = false;
  state.selected = id;
  state.progress = item.from / timeline.duration + 0.000001;
  updateReplay();
  fitMap(item.trip);
}
$('play').onclick = () => {
  if (state.playing) {
    pause();
    return;
  }
  if (!timeline.duration) return;
  if (state.progress >= 1) state.progress = 0;
  overview = false;
  state.playing = true;
  $('play').textContent = 'Ⅱ';
  $('play').setAttribute('aria-label', '暂停旅程');
  updateReplay();
  lastTick = performance.now();
  frame = requestAnimationFrame(tick);
};
$('restart').onclick = () => {
  pause();
  overview = true;
  state.progress = 0;
  updateReplay();
  fitMap();
};
$('progress').oninput = (e) => {
  pause();
  state.progress = Number(e.target.value) / 1000;
  overview = state.progress === 0 || state.progress === 1;
  updateReplay();
  if (overview && $('follow').checked) fitMap();
};
$('speed').onchange = (e) => (state.speed = Number(e.target.value));
$('follow').onchange = () => {
  map?.stop();
  playbackPhase = '';
  if ($('follow').checked) fitCurrentView();
};
$('fit-map').onclick = () => {
  pause();
  overview = true;
  fitMap();
  updateLabels();
};
function fullscreen(enabled) {
  document.body.classList.toggle('map-fullscreen', enabled);
  const button = $('map-fullscreen');
  button.textContent = enabled ? '退出' : '全屏';
  button.title = enabled ? '退出地图全屏（Esc）' : '地图全屏';
  button.setAttribute('aria-label', enabled ? '退出地图全屏' : '地图全屏');
  button.setAttribute('aria-pressed', String(enabled));
  requestAnimationFrame(() => {
    map?.resize();
    fitCurrentView();
  });
}
$('map-fullscreen').onclick = () =>
  fullscreen(!document.body.classList.contains('map-fullscreen'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.querySelector('dialog[open]'))
    fullscreen(false);
});
$('export-video').onclick = () => {
  pause();
  openVideoExport({
    trips: selectedScope(state.trips, state.selection),
    cityIndex,
    pitch: map?.getPitch() || 0,
    bearing: map?.getBearing() || 0,
    speed: state.speed,
  });
};
$('toggle-3d').onclick = () => {
  if (!map) return;
  const enabled = map.getPitch() < 10;
  map.easeTo({ pitch: enabled ? 48 : 0, bearing: enabled ? -13 : 0 });
  map.once('moveend', scheduleFit);
  $('toggle-3d').classList.toggle('active', enabled);
  $('toggle-3d').setAttribute('aria-pressed', String(enabled));
};
$('map-details').onclick = async () => {
  if (!map) return;
  if (online) {
    online = false;
    ready = false;
    map.setStyle(structuredClone(baseStyle));
    map.once('style.load', () => {
      ready = true;
      drawMap();
    });
    $('map-notice').textContent = '简约底图 · 可切换在线精细地图';
    return;
  }
  $('map-details').disabled = true;
  $('map-notice').textContent = '正在连接 OpenFreeMap…';
  try {
    const res = await fetch('https://tiles.openfreemap.org/styles/positron', {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error();
    const style = await res.json();
    ready = false;
    map.setStyle(style);
    map.once('style.load', () => {
      ready = true;
      drawMap();
    });
    online = true;
    $('map-notice').textContent =
      'OpenFreeMap 精细地图 · 点击“地图”返回简约底图';
  } catch {
    $('map-notice').textContent = '精细地图连接失败 · 已保留本地底图和旅行轨迹';
    toast('在线地图暂不可用，本地底图仍可使用。');
  } finally {
    $('map-details').disabled = false;
  }
};

$('map-more').onclick = () => {
  const tools = document.querySelector('.map-tools');
  const expanded = tools.classList.toggle('expanded');
  $('map-more').setAttribute('aria-expanded', String(expanded));
  scheduleFit();
};
$('collapse-playback').onclick = () => {
  const collapsed = document
    .querySelector('.playback')
    .classList.toggle('collapsed');
  $('collapse-playback').setAttribute('aria-expanded', String(!collapsed));
  $('collapse-playback').textContent = collapsed ? '展开' : '收起';
  scheduleFit();
};
if (map) {
  const observers = new ResizeObserver(scheduleFit);
  for (const el of document.querySelectorAll(
    '.map-heading,.map-tools,.playback',
  ))
    observers.observe(el);
}
