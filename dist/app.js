import * as store from './store.js';
import { canReplay, normalizeTrip, routeLabel, tripIssues } from './domain.js';
import { tripDate, filterTrips, scopeSummary } from './selectors.js';
import { pause, drawMap, selectTrip } from './map.js';
import { openEditor, setMode, importText } from './editor.js';
import { refreshStoredRoutes } from './routes.js';
import {
  setupLibraryUI,
  renderLibraryUI,
  showTripDetails,
} from './library-ui.js';
const { $, state, api, esc, toast } = store;
export const filters = {
  group: '',
  year: '',
  from: '',
  to: '',
  mode: '',
  search: '',
};
state.selection = new Set();
let deleteTarget,
  previousView = '',
  loaded = false;
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
  return `<article class="trip-card ${trip.mode === 'flight' ? 'flight' : ''} ${trip.id === state.selected ? 'selected' : ''}" data-trip="${esc(trip.id)}">
    <div class="card-head">${state.demo ? '' : `<input type="checkbox" data-select="${esc(trip.id)}" aria-label="选择 ${esc(trip.number)} ${esc(date)}" ${state.selection.has(trip.id) ? 'checked' : ''}/>`}<span class="mode-icon" aria-hidden="true">${trip.mode === 'train' ? '🚄' : '✈️'}</span><strong>${esc(trip.number)}</strong><span class="card-date">${esc(date.slice(5).replace('-', ' / '))}</span></div>
    <button class="card-view" data-view="${esc(trip.id)}" aria-label="查看 ${esc(trip.number)} ${esc(trip.from.name)} 至 ${esc(trip.to.name)}"><span class="card-route">${esc(trip.from.name)} <span>→</span> ${esc(trip.to.name)}</span><span class="card-time">${esc(times)}${trip.arrival && trip.arrival.slice(0, 10) !== date ? ` · 到达 ${esc(trip.arrival.slice(5, 10))}` : ''}</span></button>
    <div class="station-summary">${esc(trip.isReference ? `${trip.referenceDate} 时刻参考` : trip.source || '已知行程信息')}${issues.length ? ` · ${issues.length} 项说明` : ''}</div>
    <div class="card-meta"><span class="quality-badge ${warning ? 'warn' : ''}">${!playable ? '待补全 · ' : ''}${esc(routeLabel(trip))}</span><span class="card-actions"><button class="text-button" data-detail="${esc(trip.id)}">详情</button>${state.demo ? '' : `<button class="text-button" data-edit="${esc(trip.id)}" aria-label="编辑 ${esc(trip.number)}">编辑</button><button class="text-button" data-delete="${esc(trip.id)}" aria-label="删除 ${esc(trip.number)}">删除</button>`}</span></div>
  </article>`;
}
function render() {
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
  state.trips = filterTrips(
    source.map((t) => ({ ...t, groupName: groups.get(t.groupId) || '' })),
    filters,
  );
  const trips = state.trips,
    ids = new Set(trips.map((t) => t.id));
  state.selection = new Set([...state.selection].filter((id) => ids.has(id)));
  state.selected = ids.has(state.selected) ? state.selected : trips[0]?.id;
  const summary = scopeSummary(trips),
    playable = trips.filter(canReplay);
  $('stat-count').textContent = summary.count;
  $('stat-distance').textContent =
    summary.count && summary.distance.unknown < summary.count
      ? Math.round(summary.totalDistance).toLocaleString()
      : '—';
  $('stat-distance').title =
    `铁路曲线 ${Math.round(summary.distance.rail)} km；停站示意 ${Math.round(summary.distance.schematic)} km；机场间距离 ${Math.round(summary.distance.flight)} km；${summary.distance.unknown} 段尚无里程`;
  $('stat-places').textContent = summary.places;
  $('journey-caption').textContent = state.demo
    ? '示例旅程 · 未保存'
    : `当前范围 ${summary.count} 段 · ${summary.count - summary.playable} 段待补全`;
  $('new-journey').classList.toggle('hidden', !state.demo);
  $('trip-list').innerHTML = trips.length
    ? trips.map(card).join('')
    : `<div class="empty-state"><strong>${source.length ? '这个范围还没有行程' : '第一段旅程，从这里开始'}</strong><p>写出车次、日期与地点，时刻可以稍后补全。</p><div class="empty-actions"><button class="primary" data-empty-add>添加一段</button><button class="secondary" data-empty-paste>粘贴多段</button></div><p class="format-example">火车 G1 2027/1/8 北京南-上海虹桥</p></div>`;
  const group = (state.groups || []).find((g) => g.id === filters.group);
  $('map-title').textContent =
    group?.name ||
    (trips.length
      ? `${trips[0].from.name}，到${trips.at(-1).to.name}`
      : '下一站，去哪里？');
  $('map-subtitle').textContent = trips.length
    ? `${tripDate(trips[0]).replaceAll('-', '.')} — ${(trips.at(-1).arrival?.slice(0, 10) || tripDate(trips.at(-1))).replaceAll('-', '.')} / ${trips.length} 段 · ${playable.length} 段可回放`
    : '添加行程，在地图上串起每一次出发。';
  for (const id of ['play', 'restart', 'progress', 'export-video'])
    $(id).disabled = !playable.length;
  for (const id of ['add-trip', 'import-text']) $(id).disabled = !!state.locked;
  $('progress-start').textContent = playable[0]?.from.name || '起点';
  $('progress-end').textContent = playable.at(-1)?.to.name || '终点';
  renderLibraryUI(filters);
  const signature = JSON.stringify(
    trips.map((t) => [
      t.id,
      t.revision,
      t.routeRevision,
      t.departure,
      t.arrival,
      t.routeState,
      t.quality,
    ]),
  );
  if (signature !== previousView) {
    previousView = signature;
    pause();
    state.progress = 0;
    drawMap();
  }
}
document.addEventListener('journey-change', render);
document.addEventListener('library-refresh', render);
setupLibraryUI({ filters, render });
$('trip-list').onclick = (event) => {
  if (event.target.closest('[data-empty-add]')) return openEditor();
  if (event.target.closest('[data-empty-paste]')) return openEditor(true);
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
$('demo-button').onclick = async () => {
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
};
async function init() {
  for (const id of ['add-trip', 'import-text']) $(id).disabled = true;
  await store.load();
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
