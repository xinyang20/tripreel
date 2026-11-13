import * as store from './store.js';
import { canReplay, normalizeTrip, routeLabel, tripIssues } from './domain.js';
import { tripDate, filterTrips, scopeSummary } from './selectors.js';
import { pause, drawMap, selectTrip } from './map.js';
import { openEditor, setMode, importText } from './editor.js';
import { refreshStoredRoutes } from './routes.js';
import { fillRailProviderSelect } from './rail-providers.js';
import { measureStage } from './performance.js';
import { safe } from './html.js';
import {
  setupLibraryUI,
  renderLibraryUI,
  showTripDetails,
} from './library-ui.js';
const { $, state, api, toast } = store;
export const filters = {
  group: '',
  year: '',
  from: '',
  to: '',
  mode: '',
  search: '',
};
state.selection = new Set();
state.capabilities = { deployment: 'unknown', railgoEnabled: false };
let deleteTarget,
  previousView = '',
  previousGeometry = '',
  previousScope = '',
  loaded = false,
  pendingRender = 0;
const cardNodes = new Map();
function renderProviderSettings() {
  fillRailProviderSelect(
    $('default-rail-provider'),
    state.capabilities,
    state.preferences?.railProvider,
    $('default-provider-hint'),
  );
}
async function loadCapabilities() {
  try {
    const capabilities = await api('/api/capabilities', undefined, {
      timeoutMs: 10000,
    });
    if (
      !['local', 'public'].includes(capabilities.deployment) ||
      typeof capabilities.railgoEnabled !== 'boolean' ||
      typeof capabilities.notice !== 'string'
    )
      throw new Error('部署能力信息无效。');
    state.capabilities = capabilities;
    renderProviderSettings();
    document.dispatchEvent(new Event('rail-capabilities-change'));
    if (!capabilities.railgoEnabled) {
      const notice =
        capabilities.notice ||
        '此部署已停用 RailGo 在线轨道查询；火车可使用停站或手动途经点示意，飞机使用示意弧线。';
      for (const id of ['deployment-notice', 'query-source-notice']) {
        $(id).textContent = notice;
        $(id).classList.remove('hidden');
      }
      $('train-route-hint').textContent =
        '可选 OSM 已核实区间参考；未覆盖时保留停站或手动途经点示意。新候选须预览确认，不代表乘车当日实际轨迹。';
      $('train-source-copy').textContent =
        '火车：此部署停用 RailGo 在线轨道查询，使用本站 OSM 已核实区间参考。未覆盖区间可根据 12306 停站或手动途经点生成示意，均须核对提示和候选，不代表乘车当日实际轨迹。原有线路和导入备份仍可查看。';
      $('railgo-source-link').textContent = 'RailGo（示例及本机版线路来源）';
    }
  } catch {
    const message =
      '暂时无法确认本站线路查询能力，已暂停自动更新线路。已有行程和手动录入仍可使用，请刷新页面重试。';
    for (const id of ['deployment-notice', 'query-source-notice']) {
      $(id).textContent = message;
      $(id).classList.remove('hidden');
    }
    $('train-route-hint').textContent =
      '本站线路查询能力暂未确认；可保留输入，已有线路不会自动更新。';
    $('train-source-copy').textContent =
      '火车：暂时无法确认本站线路查询能力，已暂停自动更新。可手动记录车次、日期、地点与时刻，已有线路和备份不受影响。';
  }
}
// Elements updated on every render are looked up once.
const view = Object.fromEntries(
  [
    'trip-list',
    'stat-count',
    'stat-distance',
    'stat-places',
    'journey-caption',
    'new-journey',
    'map-title',
    'map-subtitle',
    'refresh-routes',
    'progress-start',
    'progress-end',
    'play',
    'restart',
    'progress',
    'export-video',
    'add-trip',
    'import-text',
  ].map((id) => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), $(id)]),
);
function renderCards(trips, source) {
  const list = view.tripList,
    live = new Set(source.map((trip) => trip.id));
  for (const [id] of cardNodes) if (!live.has(id)) cardNodes.delete(id);
  if (!trips.length) {
    const markup = String(
      safe`<div class="empty-state"><strong>${source.length ? '这个范围还没有行程' : '第一段旅程，从这里开始'}</strong><p>写出车次、日期与地点，时刻可以稍后补全。</p><div class="empty-actions"><button class="primary" data-empty-add>添加一段</button><button class="secondary" data-empty-paste>粘贴多段</button>${!source.length && !state.demo && safe`<button class="secondary" data-empty-demo>体验示例</button>`}</div><p class="format-example">火车 G1 2027/1/8 北京南-上海虹桥</p></div>`,
    );
    if (list.innerHTML !== markup) list.innerHTML = markup;
    return;
  }
  let cursor = list.firstElementChild;
  for (const trip of trips) {
    let entry = cardNodes.get(trip.id);
    if (!entry || entry.trip !== trip || entry.demo !== state.demo) {
      const markup = card(trip);
      if (!entry) {
        const template = document.createElement('template');
        template.innerHTML = markup;
        entry = { node: template.content.firstElementChild };
        cardNodes.set(trip.id, entry);
      } else if (entry.markup !== markup) {
        const template = document.createElement('template');
        template.innerHTML = markup;
        const next = template.content.firstElementChild;
        const focused = entry.node.contains(document.activeElement)
          ? [...entry.node.querySelectorAll('button,input')].indexOf(
              document.activeElement,
            )
          : -1;
        entry.node.className = next.className;
        entry.node.replaceChildren(...next.childNodes);
        if (focused >= 0)
          entry.node
            .querySelectorAll('button,input')
            [focused]?.focus({ preventScroll: true });
      }
      Object.assign(entry, { trip, demo: state.demo, markup });
    }
    entry.node.classList.toggle('selected', trip.id === state.selected);
    const checkbox = entry.node.querySelector('[data-select]');
    if (checkbox) checkbox.checked = state.selection.has(trip.id);
    if (entry.node !== cursor) list.insertBefore(entry.node, cursor);
    cursor = entry.node.nextElementSibling;
  }
  while (cursor) {
    const next = cursor.nextElementSibling;
    cursor.remove();
    cursor = next;
  }
}
function card(trip) {
  const date = tripDate(trip),
    playable = canReplay(trip),
    issues = tripIssues(trip);
  const times =
    trip.departure || trip.arrival
      ? `${trip.departure?.slice(11, 16) || '待补全'} — ${trip.arrival?.slice(11, 16) || '待补全'}`
      : '时刻待补全';
  const warning =
    !playable ||
    ['station-schematic', 'manual-schematic'].includes(trip.quality);
  return String(safe`<article class="trip-card ${trip.mode === 'flight' ? 'flight' : ''} ${trip.id === state.selected ? 'selected' : ''}" data-trip="${trip.id}">
    <div class="card-head">${!state.demo && safe`<input type="checkbox" data-select="${trip.id}" aria-label="选择 ${trip.number} ${date}" ${state.selection.has(trip.id) ? 'checked' : ''}/>`}<span class="mode-icon" aria-hidden="true">${trip.mode === 'train' ? '🚄' : '✈️'}</span><strong>${trip.number}</strong><span class="card-date">${date.slice(5).replace('-', ' / ')}</span></div>
    <button class="card-view" data-view="${trip.id}" aria-label="查看 ${trip.number} ${trip.from.name} 至 ${trip.to.name}"><span class="card-route">${trip.from.name} <span>→</span> ${trip.to.name}</span><span class="card-time">${times}${trip.arrival && trip.arrival.slice(0, 10) !== date ? ` · 到达 ${trip.arrival.slice(5, 10)}` : ''}</span></button>
    <div class="station-summary">${trip.isReference ? `${trip.referenceDate} 时刻参考` : trip.source || '已知行程信息'}${issues.length ? ` · ${issues.length} 项说明` : ''}</div>
    <div class="card-meta"><span class="quality-badge ${warning ? 'warn' : ''}">${!playable ? '待补全 · ' : ''}${routeLabel(trip)}</span><span class="card-actions"><button class="text-button" data-detail="${trip.id}">详情</button>${!state.demo && safe`<button class="text-button" data-edit="${trip.id}" aria-label="编辑 ${trip.number}">编辑</button><button class="text-button" data-delete="${trip.id}" aria-label="删除 ${trip.number}">删除</button>`}</span></div>
  </article>`);
}
function synchronizeView() {
  if (!loaded) return;
  const source = state.demo ? state.demoTrips || [] : state.saved;
  const groups = new Map((state.groups || []).map((g) => [g.id, g.name]));
  if (
    filters.group &&
    filters.group !== 'ungrouped' &&
    !groups.has(filters.group)
  )
    filters.group = '';
  state.activeGroupId = groups.has(filters.group) ? filters.group : null;
  state.trips = measureStage('filter', () =>
    filterTrips(source, filters, groups),
  );
  const trips = state.trips,
    ids = new Set(trips.map((t) => t.id));
  state.selection = new Set([...state.selection].filter((id) => ids.has(id)));
  state.selected = ids.has(state.selected) ? state.selected : trips[0]?.id;
  return { source, trips };
}
function renderView() {
  if (!loaded) return;
  const source = state.demo ? state.demoTrips || [] : state.saved,
    trips = state.trips;
  const summary = measureStage('summary', () => scopeSummary(trips)),
    playable = trips.filter(canReplay);
  view.statCount.textContent = summary.count;
  view.statDistance.textContent =
    summary.count && summary.distance.unknown < summary.count
      ? Math.round(summary.totalDistance).toLocaleString()
      : '—';
  view.statDistance.title = `铁路曲线 ${Math.round(summary.distance.rail)} km；停站示意 ${Math.round(summary.distance.schematic)} km；机场间距离 ${Math.round(summary.distance.flight)} km；${summary.distance.unknown} 段尚无里程`;
  view.statPlaces.textContent = summary.places;
  view.journeyCaption.textContent = state.demo
    ? '示例旅程 · 未保存'
    : `当前范围 ${summary.count} 段 · ${summary.count - summary.playable} 段待补全`;
  view.newJourney.classList.toggle('hidden', !state.demo);
  measureStage('cards', () => renderCards(trips, source));
  const group = (state.groups || []).find((g) => g.id === filters.group);
  view.mapTitle.textContent =
    group?.name ||
    (trips.length
      ? `${trips[0].from.name}，到${trips.at(-1).to.name}`
      : '下一站，去哪里？');
  view.mapSubtitle.textContent = trips.length
    ? `${tripDate(trips[0]).replaceAll('-', '.')} — ${(trips.at(-1).arrival?.slice(0, 10) || tripDate(trips.at(-1))).replaceAll('-', '.')} / ${trips.length} 段 · ${playable.length} 段可回放`
    : '添加行程，在地图上串起每一次出发。';
  for (const key of ['play', 'restart', 'progress', 'exportVideo'])
    view[key].disabled = !playable.length;
  for (const key of ['addTrip', 'importText'])
    view[key].disabled = !!state.locked;
  view.refreshRoutes.disabled =
    state.locked ||
    !state.saved.some((trip) => trip.mode === 'train' && !trip.routeFrozen);
  view.progressStart.textContent = playable[0]?.from.name || '起点';
  view.progressEnd.textContent = playable.at(-1)?.to.name || '终点';
  measureStage('library', () => renderLibraryUI(filters));
  const signature = JSON.stringify(
    trips.map((t) => [
      t.id,
      t.routeRevision,
      t.number,
      t.mode,
      t.departure,
      t.arrival,
      t.travelDate,
      t.routeState,
      t.routeConfirmed,
      t.referenceAccepted,
      t.quality,
    ]),
  );
  const geometry = JSON.stringify([
    state.demo,
    trips.map((t) => [
      t.id,
      t.mode,
      t.routeRevision,
      t.routeState,
      t.routeConfirmed,
      t.quality,
    ]),
  ]);
  const scope = JSON.stringify([state.demo, trips.map((t) => t.id)]);
  if (signature !== previousView) {
    previousView = signature;
    const changedGeometry = geometry !== previousGeometry;
    if (scope !== previousScope) {
      pause();
      state.progress = 0;
    }
    previousScope = scope;
    previousGeometry = geometry;
    measureStage('mapSubmit', () => drawMap({ geometry: changedGeometry }));
  }
}
function render() {
  synchronizeView();
  return measureStage('render', renderView);
}
function scheduleRender() {
  // Keep API/export scope correct even when rAF is suspended in a hidden tab.
  synchronizeView();
  if (!pendingRender)
    pendingRender = requestAnimationFrame(() => {
      pendingRender = 0;
      measureStage('render', renderView);
    });
}
document.addEventListener('journey-change', scheduleRender);
document.addEventListener('library-refresh', scheduleRender);
document.addEventListener('preferences-change', renderProviderSettings);
$('default-rail-provider').onchange = async (event) => {
  try {
    await store.savePreferences({ railProvider: event.target.value });
    $('provider-status').textContent = '默认来源已保存，已有线路保持原来源。';
  } catch (error) {
    $('provider-status').textContent = error.message;
    renderProviderSettings();
  }
};
setupLibraryUI({ filters, render: scheduleRender });
$('trip-list').onclick = (event) => {
  if (event.target.closest('[data-empty-add]')) return openEditor();
  if (event.target.closest('[data-empty-paste]')) return openEditor(true);
  if (event.target.closest('[data-empty-demo]')) return loadDemo();
  const element = event.target.closest(
    '[data-edit],[data-delete],[data-detail],[data-view]',
  );
  if (!element) return;
  const id =
    element.dataset.edit ||
    element.dataset.delete ||
    element.dataset.detail ||
    element.dataset.view;
  const trip = state.trips.find((t) => t.id === id);
  if (!trip) return;
  if (element.dataset.edit) openEditor(false, trip);
  else if (element.dataset.delete) {
    deleteTarget = { id: trip.id, revision: trip.revision };
    $('delete-caption').textContent =
      `${trip.number} ${trip.from.name} → ${trip.to.name}`;
    $('delete-dialog').showModal();
  } else if (element.dataset.detail) showTripDetails(trip);
  else selectTrip(id);
};
$('trip-list').onchange = (event) => {
  const id = event.target.dataset.select;
  if (!id) return;
  event.target.checked ? state.selection.add(id) : state.selection.delete(id);
  renderLibraryUI(filters);
};
$('confirm-delete').onclick = async () => {
  if (!deleteTarget) return;
  $('confirm-delete').disabled = true;
  try {
    await store.deleteTrip(deleteTarget.id, deleteTarget.revision);
    $('delete-dialog').close();
    toast('已删除这段行程。');
  } catch (error) {
    toast(error.message);
  } finally {
    $('confirm-delete').disabled = false;
  }
};
$('new-journey').onclick = () => {
  state.demo = false;
  state.demoTrips = [];
  previousView = '';
  render();
};
async function loadDemo() {
  $('demo-button').disabled = true;
  try {
    const demo = await api('/data/demo.json');
    state.demoTrips = demo.trips.map((t) => normalizeTrip(t, { legacy: true }));
    state.demo = true;
    state.selection.clear();
    Object.keys(filters).forEach((k) => (filters[k] = ''));
    previousView = '';
    render();
    toast('示例仅用于体验，不会保存到你的行程。');
  } catch (error) {
    toast('示例暂不可用：' + error.message);
  } finally {
    $('demo-button').disabled = false;
  }
}
$('demo-button').onclick = loadDemo;
$('refresh-routes').onclick = async () => {
  $('about').close();
  try {
    await refreshStoredRoutes({ force: true });
  } catch (error) {
    toast(error.message);
  }
};
async function init() {
  for (const id of ['add-trip', 'import-text']) $(id).disabled = true;
  const capabilities = loadCapabilities();
  await store.load();
  await store.loadPreferences();
  renderProviderSettings();
  loaded = true;
  render();
  try {
    [state.stations, state.airports] = await Promise.all([
      api('/data/stations.json'),
      api('/data/airports.json'),
    ]);
    setMode(document.querySelector('input[name="mode"]:checked').value);
  } catch {
    toast('地点字典读取失败，已知行程仍可保存，稍后可重试匹配。');
  }
  await capabilities;
  if (!state.locked) refreshStoredRoutes();
}
init().catch((error) => {
  loaded = true;
  state.locked = true;
  render();
  $('save-status').textContent = '数据读取失败 · 可导出恢复材料';
  toast(error.message);
});
const context = document.modelContext,
  lifecycle = new AbortController();
if (context?.registerTool) {
  const tools = [
    {
      name: 'list_travel_segments',
      title: '读取旅行行程',
      description: '读取当前显示范围，标明待补全及未保存示例。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: () => {
        if (!loaded) throw new Error('正在读取记录，请稍后重试。');
        return {
          demo: state.demo,
          trips: state.trips.map((t) => ({
            id: t.id,
            number: t.number,
            mode: t.mode,
            from: t.from.name,
            to: t.to.name,
            travelDate: tripDate(t),
            departure: t.departure,
            arrival: t.arrival,
            quality: t.quality,
            pending: !canReplay(t),
          })),
        };
      },
    },
    {
      name: 'start_trip_entry',
      title: '打开行程录入',
      description: '打开表单，不保存数据。',
      inputSchema: {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['train', 'flight'] } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: (input) => {
        if (!loaded || state.locked) throw new Error('记录尚未准备好。');
        if (input.mode && !['train', 'flight'].includes(input.mode))
          throw new Error('交通方式不正确');
        openEditor();
        if (input.mode) setMode(input.mode);
        return { opened: true, saved: false };
      },
    },
    {
      name: 'import_travel_text',
      title: '匹配文本并打开确认列表',
      description: '最多20段，保留缺项和参考信息，用户确认后才保存。',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1 } },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (input) => {
        if (!loaded || state.locked) throw new Error('记录尚未准备好。');
        if (typeof input.text !== 'string' || !input.text.trim())
          throw new Error('请提供行程文本。');
        return importText(input.text);
      },
    },
  ];
  for (const tool of tools)
    try {
      Promise.resolve(
        context.registerTool(tool, { signal: lifecycle.signal }),
      ).catch(() => {});
    } catch {}
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}

new MutationObserver(() => {
  if (!$('batch-review').classList.contains('hidden'))
    $('batch-input').open = false;
}).observe($('batch-review'), { attributes: true, attributeFilter: ['class'] });
