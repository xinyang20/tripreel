import { createRepository, LEGACY_KEY } from './repository.js';
export const $ = (id) => document.getElementById(id);
export const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
export const state = {
  trips: [],
  saved: [],
  groups: [],
  drafts: [],
  demo: false,
  selected: null,
  editing: null,
  lookup: null,
  playing: false,
  progress: 0,
  speed: 1,
  locked: false,
  ready: false,
  stations: [],
  airports: [],
  datasetRevision: 0,
  recovery: { items: [], rawLegacy: null, error: null, legacyChanged: false },
};
export const repository = createRepository();
let timer, loadPromise;
export function toast(text) {
  const element = $('toast');
  if (!element) return;
  element.textContent = text;
  element.classList.remove('hidden');
  clearTimeout(timer);
  timer = setTimeout(() => element.classList.add('hidden'), 5000);
}
export function status(id, text, error = false) {
  const element = $(id);
  if (!element) return;
  element.textContent = text;
  element.classList.toggle('hidden', !text);
  element.classList.toggle('error', error);
}
export async function api(
  url,
  body,
  {
    signal,
    timeoutMs = String(url).startsWith('/api/flight')
      ? 25000
      : String(url).startsWith('/api/')
        ? 80000
        : 40000,
    priority = 'foreground',
  } = {},
) {
  const budget = AbortSignal.timeout(timeoutMs),
    combined = signal ? AbortSignal.any([signal, budget]) : budget;
  const headers = {
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(String(url).startsWith('/api/')
      ? {
          'X-Travel-Budget-Ms': String(Math.max(1, timeoutMs - 5000)),
          'X-Travel-Priority': priority,
        }
      : {}),
  };
  const response = await fetch(url, {
    cache: 'no-cache',
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: combined,
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('服务返回格式无效，请重试。');
  }
  if (!response.ok || data.error) {
    const error = new Error(data.error || '请求失败');
    error.code = data.code;
    error.retryable = data.retryable;
    throw error;
  }
  return data;
}
export const changed = () =>
  document.dispatchEvent(new Event('journey-change'));
function accept(snapshot, { render = true, personal = false } = {}) {
  if (state.ready && snapshot.datasetRevision < state.datasetRevision)
    return snapshot;
  state.saved = snapshot.trips;
  state.groups = snapshot.groups;
  state.drafts = snapshot.drafts;
  state.datasetRevision = snapshot.datasetRevision;
  state.recovery = snapshot.recovery;
  state.locked = snapshot.locked;
  state.ready = true;
  if (personal) state.demo = false;
  if (!state.demo) state.trips = [...snapshot.trips];
  const label = state.locked
    ? '原数据需要救援，已停止覆盖'
    : state.recovery.items.length
      ? '部分旧记录需修复，已保留原始数据'
      : '已保存在此浏览器';
  if ($('save-status')) $('save-status').textContent = label;
  if (render) changed();
  return snapshot;
}
export async function load() {
  if (loadPromise) return loadPromise;
  loadPromise = repository
    .init()
    .then((snapshot) => accept(snapshot, { render: false }))
    .catch((error) => {
      state.locked = true;
      state.ready = true;
      state.recovery.error = error.message;
      state.recovery.rawLegacy = repository.rawLegacy();
      if ($('save-status'))
        $('save-status').textContent = '存储暂不可用，原记录已保留';
      toast(error.message);
      return null;
    })
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
}
async function refresh(options) {
  return accept(await repository.snapshot(), options);
}
export async function saveTrips(trips, options) {
  if (!state.ready) await load();
  if (state.locked) throw new Error('原记录需要救援，暂不能保存。');
  const saved = await repository.saveTrips(trips, options);
  state.progress = 0;
  state.playing = false;
  await refresh({ personal: true });
  return saved;
}
// Compatibility for old callers: updates/additions only. Deletion uses deleteTrip.
export const commit = (trips, options) => saveTrips(trips, options);
export async function deleteTrip(id, revision) {
  const result = await repository.deleteTrip(id, revision);
  await refresh({ personal: true });
  return result;
}
export async function saveDraft(draft) {
  const saved = await repository.saveDraft(draft);
  state.drafts = await repository.listDrafts();
  document.dispatchEvent(new Event('draft-change'));
  return saved;
}
export const listDrafts = () => repository.listDrafts();
export async function deleteDraft(id, revision) {
  const result = await repository.deleteDraft(id, revision);
  state.drafts = await repository.listDrafts();
  document.dispatchEvent(new Event('draft-change'));
  return result;
}
export async function saveGroup(group) {
  const result = await repository.saveGroup(group);
  await refresh();
  return result;
}
export async function deleteGroup(id, revision) {
  const result = await repository.deleteGroup(id, revision);
  await refresh();
  return result;
}
export const exportBackup = (options) => repository.exportBackup(options);
export const previewRestore = (data) => repository.previewRestore(data);
export async function applyRestore(preview, selections) {
  const result = await repository.applyRestore(preview, selections);
  await refresh({ personal: true });
  return result;
}
export async function setRouteFrozen(id, frozen, revision, routeRevision) {
  const result = await repository.setRouteFrozen(
    id,
    frozen,
    revision,
    routeRevision,
  );
  await refresh();
  return result;
}
export async function restoreRoute(id, versionId, revision) {
  const result = await repository.restoreRoute(id, versionId, revision);
  await refresh();
  return result;
}
export async function updateStoredRoute(original, route, options) {
  if (state.locked || $('editor')?.open) return false;
  try {
    const result = await repository.updateRoute(original, route, options);
    if (result) await refresh();
    return result;
  } catch (error) {
    if (error.routeAttemptRecorded) await refresh();
    throw error;
  }
}
export async function recordRouteAttempt(original, error, options) {
  const result = await repository.recordRouteAttempt(original, error, options);
  if (result) await refresh();
  return result;
}
repository.subscribe(async (message) => {
  if (message.upgrade) {
    state.locked = true;
    toast('数据结构已更新，请刷新此页面。');
    return;
  }
  try {
    if (message.kind === 'drafts') {
      state.drafts = await repository.listDrafts();
      document.dispatchEvent(new Event('draft-change'));
      return;
    }
    await refresh();
    if ($('editor')?.open)
      toast('其他页面已修改数据，当前输入已保留；保存时会核对版本。');
  } catch (error) {
    toast(error.message);
  }
});
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === LEGACY_KEY && state.ready) {
      state.recovery.legacyChanged = true;
      toast(
        '检测到旧版本页面写入，请关闭旧页面并导出其记录，再通过恢复预览合并。',
      );
      changed();
    }
  });
