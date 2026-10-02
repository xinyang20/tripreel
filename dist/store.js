import { createRepository, LEGACY_KEY } from './repository.js';
import { prepareReadOnlyTrip } from './domain.js';
import { measureStage } from './performance.js';
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
  preferences: { railProvider: 'railgo' },
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
function accept(snapshot, options) {
  return measureStage('accept', () => acceptSnapshot(snapshot, options));
}
function acceptSnapshot(snapshot, { render = true, personal = false } = {}) {
  if (state.ready && snapshot.datasetRevision < state.datasetRevision)
    return snapshot;
  const draftOnly =
    snapshot.partial &&
    snapshot.kind === 'drafts' &&
    !snapshot.trips.length &&
    !snapshot.removedTripIds?.length &&
    !snapshot.groups;
  if (
    snapshot.partial &&
    (snapshot.trips.length || snapshot.removedTripIds?.length)
  ) {
    const removed = new Set(snapshot.removedTripIds || []);
    const records = new Map(
      state.saved
        .filter((trip) => !removed.has(trip.id))
        .map((trip) => [trip.id, trip]),
    );
    for (const trip of snapshot.trips) {
      const previous = records.get(trip.id);
      if (previous && previous.routeRevision === trip.routeRevision) {
        // Repository transactions increment routeRevision whenever primary
        // route fields change. Keep immutable geometry and its derived caches
        // across grouping, freezing and failed refresh attempts.
        for (const field of ['routeCoordinates', 'legs', 'stops'])
          if (previous[field] !== undefined) trip[field] = previous[field];
      }
      records.set(trip.id, prepareReadOnlyTrip(trip));
    }
    state.saved = [...records.values()].sort((a, b) =>
      (a.departure || a.travelDate || '').localeCompare(
        b.departure || b.travelDate || '',
      ),
    );
  } else if (!snapshot.partial)
    state.saved = snapshot.trips.map(prepareReadOnlyTrip);
  if (snapshot.groups) state.groups = snapshot.groups;
  if (snapshot.drafts) state.drafts = snapshot.drafts;
  state.datasetRevision = snapshot.datasetRevision;
  if (snapshot.recovery) state.recovery = snapshot.recovery;
  if (snapshot.locked !== undefined) state.locked = snapshot.locked;
  state.ready = true;
  if (personal) state.demo = false;
  if (!state.demo && !draftOnly) state.trips = [...state.saved];
  const label = state.locked
    ? '原数据需要救援，已停止覆盖'
    : state.recovery.items.length
      ? '部分旧记录需修复，已保留原始数据'
      : '已保存在此浏览器';
  if ($('save-status')) $('save-status').textContent = label;
  if (render) {
    if (draftOnly) document.dispatchEvent(new Event('draft-change'));
    else changed();
  }
  return snapshot;
}
export async function load() {
  if (loadPromise) return loadPromise;
  loadPromise = repository
    .init()
    .then(async (snapshot) => {
      state.preferences = await repository.loadPreferences();
      return accept(snapshot, { render: false });
    })
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
let synchronizing = Promise.resolve();
function synchronize(change) {
  const operation = synchronizing.then(async () => {
    if (change.kind === 'preferences') {
      state.preferences = await repository.loadPreferences();
      document.dispatchEvent(new Event('preferences-change'));
      return;
    }
    if (
      state.ready &&
      Number.isInteger(change.revision) &&
      change.revision <= state.datasetRevision
    )
      return;
    accept(await repository.readChanges(change, state.datasetRevision));
  });
  synchronizing = operation.catch((error) => toast(error.message));
  return synchronizing;
}
repository.subscribeCommits(synchronize);
function showPersonal() {
  if (!state.demo) return;
  state.demo = false;
  state.trips = [...state.saved];
  changed();
}
export async function saveTrips(trips, options) {
  if (!state.ready) await load();
  if (state.locked) throw new Error('原记录需要救援，暂不能保存。');
  const saved = await repository.saveTrips(trips, options);
  showPersonal();
  return saved;
}
// Compatibility for old callers: updates/additions only. Deletion uses deleteTrip.
export const commit = (trips, options) => saveTrips(trips, options);
export async function deleteTrip(id, revision) {
  const result = await repository.deleteTrip(id, revision);
  showPersonal();
  return result;
}
export async function saveDraft(draft) {
  return repository.saveDraft(draft);
}
export const listDrafts = () => repository.listDrafts();
export async function deleteDraft(id, revision) {
  return repository.deleteDraft(id, revision);
}
export async function saveGroup(group) {
  return repository.saveGroup(group);
}
export async function deleteGroup(id, revision) {
  return repository.deleteGroup(id, revision);
}
export const assignGroup = (records, groupId) =>
  repository.assignGroup(records, groupId);
export async function loadPreferences() {
  state.preferences = await repository.loadPreferences();
  return state.preferences;
}
export async function savePreferences(patch) {
  const value = await repository.savePreferences(patch);
  // The commit listener rereads the latest preferences after concurrent writes.
  return state.preferences || value;
}
export const exportBackup = (options) => repository.exportBackup(options);
export const previewRestore = (data) => repository.previewRestore(data);
export async function applyRestore(preview, selections) {
  const result = await repository.applyRestore(preview, selections);
  showPersonal();
  return result;
}
export async function setRouteFrozen(id, frozen, revision, routeRevision) {
  return repository.setRouteFrozen(id, frozen, revision, routeRevision);
}
export async function restoreRoute(id, versionId, revision) {
  return repository.restoreRoute(id, versionId, revision);
}
export async function updateStoredRoute(original, route, options) {
  if (state.locked || $('editor')?.open) return false;
  return repository.updateRoute(original, route, options);
}
export async function recordRouteAttempt(original, error, options) {
  return repository.recordRouteAttempt(original, error, options);
}
repository.subscribe(async (message) => {
  if (message.upgrade) {
    state.locked = true;
    toast('数据结构已更新，请刷新此页面。');
    return;
  }
  try {
    await synchronize(message);
    if ($('editor')?.open && !['drafts', 'preferences'].includes(message.kind))
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
