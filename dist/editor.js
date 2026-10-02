import {
  $,
  state,
  api,
  esc,
  status,
  saveTrips,
  saveDraft,
  repository,
  toast,
} from './store.js';
import { chinaToday } from './core.js';
import { normalizeTrip, validateRecord, canRenderRoute } from './domain.js';
import { validateDraft } from './draft-validation.js';
import {
  setupBatchEditor,
  isBatchBusy,
  initializeBatch,
  cancelBatch,
  flushBatchDraft,
} from './batch-editor.js';
import { resolveBatchDraft } from './batch-resolver.js';
import { routeKey, routeRequest } from './batch-review.js';
import {
  initializeDraft,
  updateDraftField,
  draftFromTrip,
  tripFromDraft,
  chooseCandidate,
  clearAutomaticTimes,
  needsRouteConfirmation,
  hasReferenceFields,
  routePreviewMarkup,
  fieldSourceLabel,
  editorConflictDifferences,
  rebaseEditorRow,
  routeIdentityFields,
  routeReviewFromTrip,
  restoreRouteReview,
  routeReviewAccepted,
} from './editor-draft.js';
import {
  editorSession,
  DraftJournal,
  requestBudget,
  isAbort,
  abortError,
} from './editor-session.js';
import { pause } from './map.js';
import {
  fillRailProviderSelect,
  preferredRailProvider,
  railProviderDataVersion,
  switchRowProvider,
} from './rail-providers.js';
export { prepareBatchImport as importText } from './batch-editor.js';

let single = null,
  original = null,
  journal = null,
  busy = false,
  batchInitialized = false,
  currentKind = 'single',
  baseTripRevision = null,
  groupId = null;
const ids = {
  number: 'trip-number',
  date: 'trip-date',
  from: 'trip-from',
  to: 'trip-to',
  departure: 'trip-departure',
  arrival: 'trip-arrival',
  via: 'trip-via',
  fromCoord: 'from-coord',
  toCoord: 'to-coord',
};
const mode = () =>
  document.querySelector('input[name="mode"]:checked')?.value || 'train';
const isCurrentSingle = () => currentKind === 'single' && $('editor').open;
function draftSnapshot() {
  return {
    kind: 'single',
    row: single,
    original,
    groupId,
    baseTripRevision,
  };
}
function persistSingle() {
  if (!single || !journal) return;
  if (
    !original &&
    !journal.meta.revision &&
    !['number', 'from', 'to', 'departure', 'arrival'].some(
      (key) => single.draft[key],
    )
  )
    return;
  journal.schedule(draftSnapshot());
  if (isCurrentSingle())
    status('draft-status', '输入和核对结果会自动保存为草稿。');
}
function stopSingle({ flush = true } = {}) {
  if (busy) editorSession.cancel();
  busy = false;
  if (flush && journal && single) {
    persistSingle();
    journal.flush().catch(() => {});
  }
  $('lookup').disabled = false;
  $('save-trip').disabled = false;
  $('save-trip').textContent = '保存行程';
}
export function setMode(value) {
  const radio = document.querySelector(`input[name="mode"][value="${value}"]`);
  if (radio) radio.checked = true;
  $('train-extra').classList.toggle('hidden', value !== 'train');
  $('single-provider-field').classList.toggle('hidden', value !== 'train');
  $('train-candidates').classList.add('hidden');
  $('lookup').innerHTML =
    value === 'train' ? '自动匹配停站与时刻' : '自动匹配机场与时刻';
  $('lookup-hint').textContent =
    value === 'train'
      ? '填写实际乘车日期与上下车站；中途跨日会自动复核一次始发日期。时刻和线路缺失时可先保存。'
      : '填写实际起飞日期；没有当日信息时会提供明确标注的参考时刻，机场不会被静默替换。';
  $('trip-number').placeholder =
    value === 'train' ? '例如 G813' : '例如 CA1831';
  $('trip-from').placeholder = value === 'train' ? '天津南' : '南京禄口 / NKG';
  $('trip-to').placeholder = value === 'train' ? '南京南' : '成都双流 / CTU';
  $('place-list').innerHTML = (
    value === 'train' ? state.stations : state.airports
  )
    .map(
      (place) =>
        `<option value="${esc(place.name)}">${esc(place.code)}</option>`,
    )
    .join('');
}
function tabs(batch) {
  currentKind = batch ? 'batch' : 'single';
  $('editor').classList.toggle('batch-editor', batch);
  $('trip-form').classList.toggle('hidden', batch);
  $('batch-panel').classList.toggle('hidden', !batch);
  for (const [id, on] of [
    ['single-tab', !batch],
    ['batch-tab', batch],
  ]) {
    $(id).classList.toggle('active', on);
    $(id).setAttribute('aria-selected', String(on));
    $(id).tabIndex = on ? 0 : -1;
    $(id).disabled = false;
  }
}
function populateSingle() {
  if (!single) return;
  setMode(single.draft.mode);
  fillRailProviderSelect(
    $('trip-provider'),
    state.capabilities,
    single.draft.provider || state.preferences?.railProvider,
    $('trip-provider-hint'),
  );
  for (const [key, id] of Object.entries(ids)) {
    $(id).value = single.draft[key] || '';
    $(id).title = `来源：${fieldSourceLabel(single.draft, key)}`;
  }
  if (single.draft.departure || single.draft.arrival || original)
    $('time-details').open = true;
  renderSingleReview();
}
function showTrainCandidates() {
  const data = single?.lookup;
  if (!data?.stops?.length) {
    $('train-candidates').classList.add('hidden');
    return;
  }
  $('train-candidates').classList.remove('hidden');
  $('candidates-caption').textContent =
    `${data.isReference ? `${data.referenceDate} 参考停站` : '运行停站'} · 按站次选择，避免同名站混淆`;
  for (const [id, field, selected] of [
    ['boarding-stop', 'departure', single.draft.fromStopIndex],
    ['alighting-stop', 'arrival', single.draft.toStopIndex],
  ]) {
    $(id).innerHTML = data.stops
      .map(
        (stop, index) =>
          `<option value="${index}">${index + 1}. ${esc(stop.name)} · ${esc(stop[field]?.replace('T', ' ') || '')}</option>`,
      )
      .join('');
    if (Number.isInteger(selected)) $(id).value = String(selected);
  }
}
function renderSingleReview() {
  if (!single) return;
  const review = $('single-review');
  review.replaceChildren();
  if (single.warnings?.length)
    review.innerHTML += `<ul class="batch-warnings">${[...new Set(single.warnings)].map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul>`;
  if (single.routeIsCandidate && original && canRenderRoute(original)) {
    review.innerHTML += '<p class="field-hint">当前已确认线路</p>';
    review.innerHTML += routePreviewMarkup(original, single.draft.mode);
    review.innerHTML +=
      '<p class="field-hint">以下为待确认候选；未接受时继续保留当前线路。</p>';
  }
  if (single.route)
    review.innerHTML += routePreviewMarkup(single.route, single.draft.mode);
  if (single.candidates?.length)
    review.innerHTML += `<label>选择运行区间<select id="single-candidate"><option value="">尚未选择，可先保存为待补全</option>${single.candidates.map((candidate, index) => `<option value="${index}">${esc(candidate.label)}</option>`).join('')}<option value="manual">保留原起止地点，手动核对时刻</option></select></label>`;
  if (hasReferenceFields(single.draft, single.lookup))
    review.innerHTML += `<label class="batch-accept"><input id="single-reference-accept" type="checkbox" ${single.referenceAccepted ? 'checked' : ''}>我已核对参考日期与时刻</label>`;
  if (single.routeIsCandidate && needsRouteConfirmation(single.route))
    review.innerHTML += `<label class="batch-accept"><input id="single-route-confirm" type="checkbox" ${single.routeCandidateAccepted ? 'checked' : ''}>${single.route?.routeProvider === 'osm-local' && single.route?.quality === 'corridor' ? '接受此 OSM 线路参考（不代表乘车当日实际轨迹）' : '接受此候选示意线路（不是已核实的真实轨道）'}</label>`;
  review.innerHTML += `<p class="field-hint">${esc(single.message || '地点和日期确认后即可保存；时刻、坐标或路线可稍后补全。')}</p>`;
  renderConflict(review);
  if ($('single-reference-accept'))
    $('single-reference-accept').onchange = (event) => {
      single.referenceAccepted = event.target.checked;
      persistSingle();
    };
  if ($('single-route-confirm'))
    $('single-route-confirm').onchange = (event) => {
      single.routeCandidateAccepted = event.target.checked;
      persistSingle();
    };
  if ($('single-candidate'))
    $('single-candidate').onchange = (event) => {
      if (!event.target.value) return;
      stopSingle();
      if (event.target.value === 'manual') {
        single.lookup = null;
        single.candidates = [];
        single.route = null;
        single.routeKey = null;
        single.needsResolve = false;
        single.warnings = [
          '已保留原起止地点。未采用查询航段，可先保存或手动核对时刻。',
        ];
        single.routeConfirmed = false;
        single.routeIsCandidate = false;
        single.routeCandidateAccepted = false;
        single.referenceAccepted = false;
        populateSingle();
        persistSingle();
        resolveSingleRoute();
      } else {
        const candidate = single.candidates[Number(event.target.value)];
        if (!candidate) return;
        single = chooseCandidate(single, candidate);
        populateSingle();
        persistSingle();
        if (candidate.needsDateReview) lookupSingle();
        else resolveSingleRoute();
      }
    };
  showTrainCandidates();
  state.lookup = single.lookup || null;
}
function renderConflict(review) {
  if (!single.conflict) return;
  const current = single.conflict.current;
  let merged;
  if (current && original) merged = rebaseEditorRow(single, original, current);
  const display = (value) =>
    ({ train: '火车', flight: '飞机' })[value] || value || '未填写';
  const differences = editorConflictDifferences(single, current);
  review.innerHTML += `<section id="single-conflict" role="region" aria-labelledby="conflict-title"><h3 id="conflict-title">${current ? '行程已有新版本，请核对差异' : '原行程已被删除'}</h3><p>${current ? `本次编辑基于版本 ${esc(baseTripRevision)}，数据库当前版本 ${esc(current.revision)}。只合并你修改的字段；其他字段和后台更新的路线保留最新版本。` : '本页输入仍保留为草稿，不会自动重新建立已删除的行程。'}</p><div style="overflow-x:auto"><table><thead><tr><th>字段</th><th>本次草稿</th><th>数据库当前</th>${merged ? '<th>确认后保存</th>' : ''}</tr></thead><tbody>${differences.map((item) => `<tr><th scope="row">${esc(item.label)}</th><td>${esc(display(item.draft))}</td><td>${esc(display(item.current))}</td>${merged ? `<td>${esc(display(merged.draft[item.key]))}</td>` : ''}</tr>`).join('')}<tr><th scope="row">路线版本</th><td>${esc(original?.routeRevision ?? 0)}</td><td>${current ? esc(current.routeRevision) : '已删除'}</td>${merged ? `<td>${merged.route ? '保留数据库最新路线' : '待重新匹配'}</td>` : ''}</tr></tbody></table></div>${single.conflict.message ? `<p class="field-hint">${esc(single.conflict.message)}</p>` : ''}<div class="batch-row-actions">${current ? '<button id="conflict-load-latest" type="button">采用数据库版本</button><button id="conflict-confirm" type="button">确认差异并保存本次修改</button>' : ''}<button id="conflict-keep-draft" type="button">保留草稿，关闭</button></div></section>`;
  $('save-trip').disabled = true;
  $('save-trip').textContent = '请先核对版本差异';
  if ($('conflict-confirm'))
    $('conflict-confirm').onclick = () => resolveConflict(false);
  if ($('conflict-load-latest'))
    $('conflict-load-latest').onclick = () => resolveConflict(true);
  $('conflict-keep-draft').onclick = () => $('editor').close();
}
async function captureConflict(error, token) {
  const snapshot = await repository.snapshot();
  if (!editorSession.current(token)) return;
  const storedDraft = snapshot.drafts.find(
    (draft) => draft.id === journal.meta.id,
  );
  if (!storedDraft || storedDraft.revision !== journal.meta.revision) {
    journal.finish();
    journal = new DraftJournal(saveDraft, {}, (failure) => {
      if (isCurrentSingle())
        status('draft-status', `草稿未保存：${failure.message}`, true);
    });
  }
  single.conflict = {
    current: snapshot.trips.find((trip) => trip.id === original.id) || null,
    message: error.message,
  };
  renderSingleReview();
  persistSingle();
  await journal.flush();
  if (editorSession.current(token)) {
    status(
      'form-error',
      '保存未覆盖原记录。请核对下方版本差异；本次输入已保留为草稿。',
      true,
    );
    $('single-conflict').scrollIntoView({ block: 'nearest' });
  }
}
async function resolveConflict(useCurrent) {
  if (!single?.conflict?.current || !original) return;
  stopSingle();
  const token = editorSession.begin(),
    shown = single.conflict.current;
  busy = true;
  try {
    const snapshot = await repository.snapshot();
    if (!editorSession.current(token)) return;
    const current = snapshot.trips.find((trip) => trip.id === original.id);
    if (
      !current ||
      current.revision !== shown.revision ||
      current.routeRevision !== shown.routeRevision
    ) {
      single.conflict = {
        current: current || null,
        message: '核对期间记录再次变化，请按最新差异重新确认。',
      };
      renderSingleReview();
      persistSingle();
      return;
    }
    if (useCurrent) {
      single = {
        draft: draftFromTrip(current),
        lookup: null,
        candidates: [],
        warnings: [],
        ...routeReviewFromTrip(current),
        referenceAccepted: current.referenceAccepted ?? !current.isReference,
        needsResolve: false,
        message: '已采用数据库最新版本，可继续编辑后保存。',
      };
    } else single = rebaseEditorRow(single, original, current);
    original = structuredClone(current);
    baseTripRevision = current.revision;
    groupId = current.groupId || null;
    single.routeKey = single.route
      ? routeKey(single.draft, single.lookup)
      : null;
    populateSingle();
    persistSingle();
    status('form-error', '');
    if (!useCurrent) await saveSingle({ preventDefault() {} });
  } catch (error) {
    if (editorSession.current(token)) status('form-error', error.message, true);
  } finally {
    if (editorSession.current(token)) {
      busy = false;
      $('save-trip').disabled = Boolean(single.conflict);
      $('save-trip').textContent = single.conflict
        ? '请先核对版本差异'
        : '保存行程';
    }
  }
}
export function openEditor(batch = false, trip, restored) {
  if (restored) {
    restored = validateDraft(restored);
    batch = restored.kind === 'batch';
  }
  pause();
  stopSingle();
  cancelBatch();
  editorSession.cancel();
  state.editing = trip?.id || restored?.original?.id || null;
  state.lookup = null;
  status('form-error', '');
  status('lookup-status', '');
  status('batch-status', '');
  status('draft-status', restored ? '已恢复草稿，尚未写入正式行程。' : '');
  $('editor-title').textContent =
    trip || restored?.original ? '编辑旅程' : '添加旅程';
  groupId = restored?.groupId || trip?.groupId || state.activeGroupId || null;
  tabs(batch);
  if (batch) {
    initializeBatch(restored);
    batchInitialized = true;
  } else {
    original = restored?.original
      ? structuredClone(restored.original)
      : trip
        ? structuredClone(trip)
        : null;
    baseTripRevision = Number.isInteger(restored?.baseTripRevision)
      ? restored.baseTripRevision
      : (original?.revision ?? null);
    if (original) original.revision = baseTripRevision;
    const draft =
      restored?.row?.draft ||
      (trip
        ? draftFromTrip(trip)
        : initializeDraft(
            { mode: 'train', date: chinaToday(), groupId },
            'manual',
          ));
    single = restored?.row
      ? restoreRouteReview(structuredClone(restored.row), original)
      : {
          draft,
          lookup: null,
          candidates: [],
          warnings: [],
          ...routeReviewFromTrip(trip),
          referenceAccepted: trip?.referenceAccepted ?? !trip?.isReference,
          needsResolve: !trip,
        };
    single.draft = initializeDraft(single.draft, trip ? 'legacy' : 'manual');
    const requestedProvider = single.draft.provider;
    const allowedProvider =
      preferredRailProvider(
        state.capabilities,
        requestedProvider || state.preferences?.railProvider,
      ) || requestedProvider;
    if (
      requestedProvider &&
      allowedProvider &&
      requestedProvider !== allowedProvider
    ) {
      single = switchRowProvider(
        single,
        allowedProvider,
        railProviderDataVersion(state.capabilities, allowedProvider),
      );
      single.warnings ||= [];
      single.warnings.push(
        '原线路来源在此部署不可用，已保留输入；重新查询后须核对新候选。',
      );
    } else single.draft.provider = allowedProvider;
    single = switchRowProvider(
      single,
      allowedProvider,
      railProviderDataVersion(state.capabilities, allowedProvider),
    );
    if (single.route && !single.routeKey)
      single.routeKey = routeKey(single.draft, single.lookup);
    const createdJournal = new DraftJournal(saveDraft, restored, (error) => {
      if (journal === createdJournal && isCurrentSingle())
        status('draft-status', `草稿未保存：${error.message}`, true);
    });
    journal = createdJournal;
    $('trip-form').reset();
    populateSingle();
  }
  $('save-trip').disabled = !batch && Boolean(single?.conflict);
  $('save-trip').textContent =
    !batch && single?.conflict ? '请先核对版本差异' : '保存行程';
  if (!$('editor').open) $('editor').showModal();
}
export function resumeDraft(draft) {
  openEditor(draft.kind === 'batch', null, draft);
}
function editField(key, value) {
  stopSingle({ flush: false });
  editorSession.cancel();
  single.draft = updateDraftField(single.draft, key, value);
  if (key === 'mode' && value === 'train') {
    const provider = preferredRailProvider(
      state.capabilities,
      single.draft.provider || state.preferences?.railProvider,
    );
    if (provider)
      single = switchRowProvider(
        single,
        provider,
        railProviderDataVersion(state.capabilities, provider),
      );
    fillRailProviderSelect(
      $('trip-provider'),
      state.capabilities,
      single.draft.provider,
      $('trip-provider-hint'),
    );
  }
  for (const field of Object.values(ids))
    $(field).removeAttribute('aria-invalid');
  if (ids[key])
    $(ids[key]).title = `来源：${fieldSourceLabel(single.draft, key)}`;
  if (routeIdentityFields.includes(key)) {
    single.routeConfirmed = false;
    single.routeIsCandidate = false;
    single.routeCandidateAccepted = false;
  }
  single.error = '';
  single.reviewed = false;
  if (['mode', 'number', 'date', 'from', 'to'].includes(key)) {
    single.lookup = null;
    single.candidates = [];
    single.route = null;
    single.routeKey = null;
    single.needsResolve = true;
    single.referenceAccepted = false;
  }
  if (['fromCoord', 'toCoord', 'via'].includes(key)) {
    single.route = null;
    single.routeKey = null;
    single.needsResolve = true;
  }
  single.message = '修改已保留，可重新匹配或保存为待补全。';
  if (key === 'mode') setMode(value);
  if (['mode', 'number', 'date', 'from', 'to'].includes(key))
    for (const time of ['departure', 'arrival'])
      $(ids[time]).value = single.draft[time] || '';
  renderSingleReview();
  persistSingle();
}
async function ensurePlaces(signal) {
  if (state.stations.length && state.airports.length) return;
  const [stations, airports] = await Promise.all([
    api('/data/stations.json', undefined, { signal, timeoutMs: 15000 }),
    api('/data/airports.json', undefined, { signal, timeoutMs: 15000 }),
  ]);
  if (signal.aborted) throw signal.reason;
  state.stations = stations;
  state.airports = airports;
}
async function fetchSingleRoute(token, budget) {
  if (!single.draft.from || !single.draft.to || single.candidates?.length)
    return;
  if (state.capabilities?.deployment === 'unknown')
    throw new Error('尚未确认本站线路来源，已保留输入，请稍后重试。');
  if (budget.signal.aborted || budget.remaining() <= 0)
    throw budget.signal.reason || abortError('查询时间已用完。');
  single = switchRowProvider(
    single,
    single.draft.provider,
    railProviderDataVersion(state.capabilities, single.draft.provider),
  );
  try {
    const route = await api(
      '/api/route',
      routeRequest(single.draft, single.lookup),
      { signal: budget.signal, timeoutMs: Math.min(80000, budget.remaining()) },
    );
    if (!editorSession.current(token)) return;
    single.route = route;
    if (
      route.routeProvider === 'osm-local' &&
      typeof route.routeDataVersion === 'string'
    )
      single.draft.providerDataVersion = route.routeDataVersion;
    single.routeKey = routeKey(single.draft, single.lookup);
    single.routeConfirmed =
      !needsRouteConfirmation(route) &&
      route.resolution?.state !== 'unavailable';
    single.routeIsCandidate = needsRouteConfirmation(route);
    single.routeCandidateAccepted = false;
    single.needsResolve = false;
    single.message =
      route.resolution?.state === 'unavailable'
        ? '暂未取得可靠路线，可以先保存为待补全。'
        : needsRouteConfirmation(route)
          ? '已取得候选线路；需预览并明确接受后才会显示该轨迹。'
          : '路线已匹配，请核对后保存。';
    if (route.routeNote) single.warnings.push(route.routeNote);
    for (const warning of route.warnings || []) single.warnings.push(warning);
  } catch (error) {
    if (isAbort(error) || budget.signal.aborted) throw error;
    if (!editorSession.current(token)) return;
    single.route = null;
    single.routeKey = null;
    single.message = '路线查询失败，可以先保存为待补全。';
    single.warnings.push(error.message);
  }
}
async function resolveSingleRoute() {
  const token = editorSession.begin(),
    budget = requestBudget(token.signal, 150000);
  busy = true;
  $('lookup').disabled = true;
  try {
    await fetchSingleRoute(token, budget);
  } catch (error) {
    if (editorSession.current(token))
      single.message = isAbort(error)
        ? '查询已停止，结果已保留。'
        : error.message;
  } finally {
    budget.dispose();
    if (editorSession.current(token)) {
      busy = false;
      $('lookup').disabled = false;
      renderSingleReview();
      persistSingle();
    }
  }
}
async function lookupSingle() {
  if (!single) return;
  if (state.capabilities?.deployment === 'unknown') {
    status(
      'lookup-status',
      '尚未确认本站查询能力，已保留输入和草稿，可先保存或稍后重试。',
      true,
    );
    return;
  }
  stopSingle();
  const token = editorSession.begin(),
    budget = requestBudget(token.signal, 150000);
  busy = true;
  $('lookup').disabled = true;
  single.draft = clearAutomaticTimes(single.draft);
  single.routeConfirmed = false;
  single.routeCandidateAccepted = false;
  single.referenceAccepted = false;
  status(
    'lookup-status',
    '正在匹配公开时刻与路线；可以修改输入或切换页面以停止查询…',
  );
  persistSingle();
  try {
    await ensurePlaces(budget.signal);
    const result = await resolveBatchDraft(single.draft, {
      api,
      stations: state.stations,
      airports: state.airports,
      today: chinaToday(),
      signal: budget.signal,
      deadline: Date.now() + budget.remaining(),
    });
    if (!editorSession.current(token)) return;
    Object.assign(
      single,
      {
        candidates: [],
        route: null,
        routeKey: null,
        routeIsCandidate: false,
        routeCandidateAccepted: false,
        needsResolve: false,
      },
      result,
    );
    populateSingle();
    $('time-details').open = true;
    persistSingle();
    if (!result.error) await fetchSingleRoute(token, budget);
    if (editorSession.current(token))
      status(
        'lookup-status',
        result.error || '匹配结果已填入下方，请核对参考提示。',
        Boolean(result.error),
      );
  } catch (error) {
    if (editorSession.current(token)) {
      single.message =
        isAbort(error) || budget.signal.aborted
          ? '查询时间已用完，已保留现有结果，可先保存为待补全。'
          : error.message;
      status('lookup-status', single.message, !isAbort(error));
    }
  } finally {
    budget.dispose();
    if (editorSession.current(token)) {
      busy = false;
      $('lookup').disabled = false;
      populateSingle();
      persistSingle();
    }
  }
}
export async function createTrip(draft, lookup, preparedRoute, options = {}) {
  const previous = Object.hasOwn(options, 'original')
    ? options.original
    : state.saved.find((trip) => trip.id === draft.id);
  const trip = normalizeTrip(
    tripFromDraft(draft, lookup, preparedRoute, {
      ...options,
      original: previous,
    }),
  );
  validateRecord(trip);
  return trip;
}
async function saveSingle(event) {
  event.preventDefault();
  if (!single || isBatchBusy()) return;
  if (single.conflict) {
    renderSingleReview();
    return;
  }
  stopSingle();
  const token = editorSession.begin();
  busy = true;
  $('save-trip').disabled = true;
  $('save-trip').textContent = '正在保存…';
  status('form-error', '');
  try {
    const route =
      !single.needsResolve &&
      !single.candidates?.length &&
      single.routeKey === routeKey(single.draft, single.lookup)
        ? single.route
        : null;
    const trip = await createTrip(single.draft, single.lookup, route, {
      original,
      routeConfirmed: routeReviewAccepted(single),
      referenceAccepted: single.referenceAccepted,
      groupId,
      fetchRoute: false,
    });
    if (single.candidates?.length)
      trip.issues.push({
        code: 'MULTIPLE_CANDIDATES',
        message: '运行区间尚未选择，待补全。',
      });
    validateRecord(trip, state.saved);
    persistSingle();
    const meta = await journal.flush();
    if (!editorSession.current(token)) return;
    await saveTrips([trip], {
      draftId: meta.id,
      draftRevision: meta.revision,
      signal: token.signal,
    });
    if (!editorSession.current(token)) return;
    journal.finish();
    busy = false;
    state.selected = trip.id;
    $('editor').close();
    toast(
      trip.routeState === 'pending' || !trip.departure || !trip.arrival
        ? '行程已保存，未完备内容可稍后补全。'
        : '行程已保存，可以开始回放。',
    );
  } catch (error) {
    if (editorSession.current(token)) {
      if (error.code === 'DATE_MISMATCH') {
        for (const key of error.fields || ['date', 'departure'])
          if (ids[key]) $(ids[key]).setAttribute('aria-invalid', 'true');
        $('trip-date').focus();
      }
      if (error.code === 'CONFLICT' && original?.id) {
        try {
          await captureConflict(error, token);
        } catch (failure) {
          if (editorSession.current(token))
            status(
              'form-error',
              `版本冲突，输入仍在编辑器中。${failure.message}`,
              true,
            );
        }
      } else
        status('form-error', error.message || '保存失败，草稿已保留。', true);
    }
  } finally {
    if (editorSession.current(token)) {
      busy = false;
      $('save-trip').disabled = Boolean(single.conflict);
      $('save-trip').textContent = single.conflict
        ? '请先核对版本差异'
        : '保存行程';
    }
  }
}
setupBatchEditor({ createTrip, openEditor });
$('trip-provider').onchange = () => {
  if (!single) return;
  stopSingle({ flush: false });
  editorSession.cancel();
  single = switchRowProvider(
    single,
    $('trip-provider').value,
    railProviderDataVersion(state.capabilities, $('trip-provider').value),
  );
  populateSingle();
  persistSingle();
};
document.addEventListener('rail-capabilities-change', () => {
  if (!single || !isCurrentSingle()) return;
  const provider = preferredRailProvider(
    state.capabilities,
    single.draft.provider || state.preferences?.railProvider,
  );
  const next = provider
    ? switchRowProvider(
        single,
        provider,
        railProviderDataVersion(state.capabilities, provider),
      )
    : single;
  if (next !== single) {
    stopSingle({ flush: false });
    editorSession.cancel();
    single = next;
    persistSingle();
  }
  populateSingle();
});
$('lookup').onclick = lookupSingle;
$('trip-form').onsubmit = saveSingle;
for (const [key, id] of Object.entries(ids))
  $(id).oninput = () => {
    if (single) editField(key, $(id).value.trim());
  };
for (const radio of document.querySelectorAll('input[name="mode"]'))
  radio.onchange = () => {
    if (single) editField('mode', mode());
  };
for (const id of ['boarding-stop', 'alighting-stop'])
  $(id).onchange = () => {
    const lookup = single?.lookup;
    if (!lookup?.stops) return;
    const a = Number($('boarding-stop').value),
      b = Number($('alighting-stop').value);
    if (a >= b) {
      status('lookup-status', '下车站必须位于上车站之后。', true);
      return;
    }
    single.draft = updateDraftField(single.draft, 'from', lookup.stops[a].name);
    single.draft = updateDraftField(single.draft, 'to', lookup.stops[b].name);
    single.draft.fromStopIndex = a;
    single.draft.toStopIndex = b;
    single.lookup = lookup;
    populateSingle();
    persistSingle();
    lookupSingle();
  };
$('add-trip').onclick = () => openEditor();
$('import-text').onclick = () => openEditor(true);
const editorTabs = [
  ['single-tab', false],
  ['batch-tab', true],
];
for (const [index, [id, batch]] of editorTabs.entries()) {
  $(id).onclick = () => {
    if (currentKind === (batch ? 'batch' : 'single')) return;
    stopSingle();
    cancelBatch();
    editorSession.cancel();
    tabs(batch);
    if (batch && !batchInitialized) {
      initializeBatch();
      batchInitialized = true;
    }
    if (!batch && !single) openEditor(false);
    else if (!batch) populateSingle();
  };
  $(id).onkeydown = (event) => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % editorTabs.length;
    else if (event.key === 'ArrowLeft')
      next = (index + editorTabs.length - 1) % editorTabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = editorTabs.length - 1;
    else return;
    event.preventDefault();
    const button = $(editorTabs[next][0]);
    button.click();
    button.focus();
  };
}
$('editor').addEventListener('close', () => {
  stopSingle();
  cancelBatch();
  editorSession.cancel();
  if (currentKind === 'batch') flushBatchDraft().catch(() => {});
});
window.addEventListener('pagehide', () => {
  stopSingle();
  cancelBatch();
  editorSession.cancel();
  flushBatchDraft().catch(() => {});
});
$('about-button').onclick = () => $('about').showModal();
document
  .querySelectorAll('[data-close]')
  .forEach(
    (button) => (button.onclick = () => $(button.dataset.close).close()),
  );
