import {
  $,
  state,
  api,
  esc,
  status,
  saveTrips,
  saveDraft,
  toast,
} from './store.js';
import { parseBatchLines, chinaToday } from './core.js';
import { validateRecord } from './domain.js';
import { resolveBatchDraft } from './batch-resolver.js';
import { sameJourney, routeRequest, routeKey } from './batch-review.js';
import {
  fillRailProviderSelect,
  preferredRailProvider,
  railProviderDataVersion,
  switchRowProvider,
} from './rail-providers.js';
import {
  initializeDraft,
  updateDraftField,
  chooseCandidate,
  missingFields,
  needsRouteConfirmation,
  hasReferenceFields,
  routePreviewMarkup,
  fieldSourceLabel,
  rowNeedsReview,
  routeIdentityFields,
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

let rows = [],
  running = false,
  reviewText = '',
  journal = null,
  groupId = null,
  provider,
  createTrip,
  openEditor;
export const isBatchBusy = () => running;
const visible = () =>
  !$('batch-panel').classList.contains('hidden') && $('editor').open;
const snapshot = () => ({
  kind: 'batch',
  raw: $('batch-text').value,
  reviewText,
  rows,
  groupId,
  provider,
  filter: $('batch-filter')?.value || 'all',
});
function persist() {
  if (!journal?.meta.revision && !$('batch-text').value.trim() && !rows.length)
    return;
  journal?.schedule(snapshot());
  if ($('draft-status'))
    $('draft-status').textContent = '输入与核对结果会自动保存为草稿。';
}
function newJournal(restored) {
  const createdJournal = new DraftJournal(saveDraft, restored, (error) => {
    if (journal === createdJournal && visible())
      status('draft-status', `草稿未保存：${error.message}`, true);
  });
  journal = createdJournal;
}
export function initializeBatch(restored) {
  cancelBatch();
  rows = restored?.rows
    ? structuredClone(restored.rows).map((row) => restoreRouteReview(row))
    : [];
  provider =
    preferredRailProvider(
      state.capabilities,
      restored?.provider || state.preferences?.railProvider,
    ) ||
    restored?.provider ||
    state.preferences?.railProvider;
  rows = rows.map((row) => {
    if (!row.draft || row.draft.mode !== 'train') return row;
    const previous = row.draft.provider;
    const allowed =
      preferredRailProvider(state.capabilities, previous || provider) ||
      previous ||
      provider;
    if (previous && previous !== allowed) {
      const next = switchRowProvider(
        row,
        allowed,
        railProviderDataVersion(state.capabilities, allowed),
      );
      next.warnings = [
        ...(row.warnings || []),
        '原线路来源在此部署不可用，请重新查询并核对候选。',
      ];
      return next;
    }
    row.draft.provider = allowed;
    return switchRowProvider(
      row,
      allowed,
      railProviderDataVersion(state.capabilities, allowed),
    );
  });
  fillRailProviderSelect(
    $('batch-provider'),
    state.capabilities,
    provider,
    $('batch-provider-hint'),
  );
  for (const row of rows) {
    if (row.draft) row.draft = initializeDraft(row.draft);
    row.running = false;
  }
  reviewText = restored?.reviewText || '';
  groupId = restored?.groupId || state.activeGroupId || null;
  $('batch-text').value = restored?.raw || '';
  if ($('batch-filter')) $('batch-filter').value = restored?.filter || 'all';
  newJournal(restored);
  renderAll();
  $('batch-review').classList.toggle('hidden', !rows.length);
}
export function cancelBatch() {
  if (running) {
    editorSession.cancel();
    running = false;
  }
  for (const row of rows)
    if (row.running) {
      row.running = false;
      row.message = '查询已停止，已完成的识别结果已保留。';
    }
  if (journal && visible()) {
    persist();
    journal.flush().catch(() => {});
  }
  if (visible()) {
    renderAll();
    syncControls();
  }
}
export async function flushBatchDraft() {
  return journal?.flush();
}

const field = (row, key, label, type = 'text') =>
  `<label>${label}<input data-field="${key}" type="${type}" value="${esc(row.draft[key] || '')}" ${['from', 'to'].includes(key) ? 'list="batch-places"' : ''} aria-label="第 ${row.line} 行 ${label}" title="来源：${esc(fieldSourceLabel(row.draft, key))}"><small class="field-origin">${esc(fieldSourceLabel(row.draft, key))}</small></label>`;
function rowPending(row) {
  return (
    missingFields(row.draft).length > 0 ||
    !row.route ||
    row.route.resolution?.state === 'unavailable' ||
    (needsRouteConfirmation(row.route) && !routeReviewAccepted(row)) ||
    Boolean(row.candidates?.length)
  );
}
function syncControls() {
  const selected = rows.filter((row) => row.included).length;
  $('save-batch').disabled = running;
  $('confirm-batch').disabled =
    running || !selected || $('batch-text').value !== reviewText;
  $('confirm-batch').textContent = '确认保存选中行程';
  $('batch-selection').textContent =
    `已选 ${selected} / ${rows.length} 段 · 未完备的行程可先保存为待补全`;
  $('batch-summary').textContent =
    `${rows.filter((row) => row.draft && !rowPending(row)).length} 段可生成轨迹 · ${rows.filter((row) => row.draft && rowPending(row)).length} 段待补全`;
  $('batch-rows')
    .querySelectorAll('input,select,textarea,button')
    .forEach((el) => (el.disabled = running));
  if ($('stop-batch')) {
    $('stop-batch').disabled = !running;
    $('stop-batch').classList.toggle('hidden', !running);
  }
  for (const id of ['retry-batch-failed', 'accept-batch-reference'])
    if ($(id)) $(id).disabled = running;
  $('save-trip').disabled = running;
}
function applyFilter() {
  const filter = $('batch-filter')?.value || 'all';
  for (const row of rows) {
    const show =
      filter === 'all' ||
      (filter === 'review' && rowNeedsReview(row)) ||
      (filter === 'pending' && rowPending(row)) ||
      (filter === 'duplicate' && row.duplicate);
    $('batch-rows')
      .querySelector(`[data-row="${row.index}"]`)
      ?.classList.toggle('hidden', !show);
  }
}
function renderRow(row) {
  const old = $('batch-rows').querySelector(`[data-row="${row.index}"]`),
    details = document.createElement('details');
  details.dataset.row = row.index;
  details.className = `batch-row${rowNeedsReview(row) ? ' needs-review' : ''}${!row.included ? ' is-skipped' : ''}`;
  details.open = row.expanded ?? rowNeedsReview(row);
  const draft = row.draft,
    title = draft
      ? `${draft.mode === 'train' ? '🚄' : '✈'} ${draft.number}`
      : '待修正文本';
  details.innerHTML = `<summary><label><input data-include type="checkbox" ${row.included ? 'checked' : ''} aria-label="选择第 ${row.line} 行">${esc(title)}</label><span class="batch-route-summary">${draft ? `${esc(draft.date || '')} · ${esc(draft.from || '起点待补')} → ${esc(draft.to || '终点待补')}` : `第 ${row.line} 行`}</span><span class="batch-state">${row.duplicate ? '重复' : row.running ? '匹配中' : rowPending(row) ? '待补全' : row.reviewed ? '已核对' : rowNeedsReview(row) ? '需核对' : '可保存'}</span></summary><div class="batch-row-body"><span class="batch-original">${esc(row.raw)}</span><div class="batch-row-actions"><button type="button" data-retry>${draft ? '重新匹配' : '重新识别'}</button><button type="button" data-reviewed ${draft ? '' : 'disabled'}>${row.reviewed ? '重新核对' : '已完成核对'}</button></div></div>`;
  const body = details.querySelector('.batch-row-body');
  if (draft) {
    body.innerHTML += `<div class="batch-primary-fields"><label>方式<select data-field="mode" aria-label="第 ${row.line} 行 交通方式"><option value="train" ${draft.mode === 'train' ? 'selected' : ''}>火车</option><option value="flight" ${draft.mode === 'flight' ? 'selected' : ''}>飞机</option></select></label>${field(row, 'number', '编号')}${field(row, 'date', '实际乘车日期', 'date')}</div><div class="form-row">${field(row, 'from', '出发站 / 机场')}${field(row, 'to', '到达站 / 机场')}</div><div class="form-row">${field(row, 'departure', '出发时间（可稍后补）', 'datetime-local')}${field(row, 'arrival', '到达时间（可稍后补）', 'datetime-local')}</div>`;
    if (row.candidates?.length)
      body.innerHTML += `<label>可选运行区间<select data-candidate aria-label="第 ${row.line} 行 选择航段"><option value="">尚未选择，可先保存为待补全</option>${row.candidates.map((c, i) => `<option value="${i}">${esc(c.label)}</option>`).join('')}<option value="manual">保留原起止地点，时刻由我核对</option></select></label>`;
    if (hasReferenceFields(draft, row.lookup))
      body.innerHTML += `<label class="batch-accept"><input data-reference type="checkbox" ${row.referenceAccepted ? 'checked' : ''}>我已核对参考日期与时刻</label>`;
    if (needsRouteConfirmation(row.route))
      body.innerHTML += `<label class="batch-accept"><input data-route-confirm type="checkbox" ${row.routeCandidateAccepted ? 'checked' : ''}>${row.route?.routeProvider === 'osm-local' && row.route?.quality === 'corridor' ? '接受此 OSM 线路参考（不代表乘车当日实际轨迹）' : '接受此候选示意线路（不是已核实的真实轨道）'}</label>`;
    body.innerHTML += `<details class="batch-coordinates"><summary>调整坐标与途经站</summary><div class="form-row">${field(row, 'fromCoord', '出发地经度,纬度')}${field(row, 'toCoord', '目的地经度,纬度')}</div>${field(row, 'via', '途经站（用顿号分隔）')}</details>`;
  } else
    body.innerHTML += `<textarea data-raw class="batch-raw-edit" aria-label="修正第 ${row.line} 行文本">${esc(row.raw)}</textarea>`;
  if (row.route)
    body.innerHTML += routePreviewMarkup(row.route, row.draft.mode);
  if (row.warnings?.length)
    body.innerHTML += `<ul class="batch-warnings">${[...new Set(row.warnings)].map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
  body.innerHTML += `<div class="batch-row-status ${row.error ? 'error' : ''}" role="status">${esc(row.error || row.message || '核对后即可保存，缺失内容可稍后补全。')}</div>`;
  if (running)
    details
      .querySelectorAll('input,select,textarea,button')
      .forEach((el) => (el.disabled = true));
  if (old) old.replaceWith(details);
  else $('batch-rows').append(details);
  applyFilter();
}
function renderAll() {
  $('batch-rows').replaceChildren();
  rows.forEach(renderRow);
  syncControls();
}
function markDuplicate(row) {
  row.duplicate = false;
  if (!row.draft?.from || !row.draft?.to) return;
  const saved = state.saved.find((t) => sameJourney(row.draft, t)),
    earlier = rows.find(
      (r) => r.index < row.index && r.draft && sameJourney(row.draft, r.draft),
    );
  if (saved || earlier) {
    row.duplicate = true;
    row.included = false;
    row.warnings.push(
      saved
        ? '此行程已保存，已取消勾选以避免重复。'
        : `与第 ${earlier.line} 行重复，已取消勾选。`,
    );
  }
}
async function prepareRoute(row, token, budget) {
  if (!row.draft?.from || !row.draft?.to || row.candidates?.length) return;
  Object.assign(
    row,
    switchRowProvider(
      row,
      row.draft.provider,
      railProviderDataVersion(state.capabilities, row.draft.provider),
    ),
  );
  const key = routeKey(row.draft, row.lookup);
  if (row.route && row.routeKey === key) return;
  if (budget.remaining() <= 0) throw abortError();
  try {
    const route = await api('/api/route', routeRequest(row.draft, row.lookup), {
      signal: budget.signal,
      timeoutMs: Math.min(80000, budget.remaining()),
    });
    if (!editorSession.current(token)) return;
    row.route = route;
    if (
      route.routeProvider === 'osm-local' &&
      typeof route.routeDataVersion === 'string'
    )
      row.draft.providerDataVersion = route.routeDataVersion;
    row.routeKey = routeKey(row.draft, row.lookup);
    row.routeError = '';
    row.routeConfirmed =
      !needsRouteConfirmation(route) &&
      route.resolution?.state !== 'unavailable';
    row.routeIsCandidate = needsRouteConfirmation(route);
    row.routeCandidateAccepted = false;
    row.message =
      route.resolution?.state === 'unavailable'
        ? '暂未获得可靠线路，可以先保存为待补全。'
        : needsRouteConfirmation(route)
          ? '已取得候选线路；请预览并明确确认后再显示该轨迹。'
          : '线路已匹配，核对后可保存。';
    if (route.routeNote) row.warnings.push(route.routeNote);
    for (const issue of route.issues || route.resolution?.issues || [])
      row.warnings.push(
        typeof issue === 'string' ? issue : issue.message || issue.code,
      );
  } catch (error) {
    if (isAbort(error) || budget.signal.aborted) throw error;
    if (!editorSession.current(token)) return;
    row.route = null;
    row.routeError = error.message;
    row.message = '线路暂不可用，可以先保存为待补全。';
    row.warnings.push(error.message);
  }
}
async function matchRow(row, token, overall) {
  const budget = requestBudget(
    overall.signal,
    Math.min(150000, overall.remaining()),
  );
  row.running = true;
  row.error = '';
  row.message = '正在查询时刻…';
  renderRow(row);
  try {
    const result = await resolveBatchDraft(row.draft, {
      api,
      stations: state.stations,
      airports: state.airports,
      today: chinaToday(),
      signal: budget.signal,
      deadline: Date.now() + budget.remaining(),
    });
    if (!editorSession.current(token)) return;
    Object.assign(
      row,
      {
        candidates: [],
        route: null,
        routeKey: null,
        routeConfirmed: false,
        routeIsCandidate: false,
        routeCandidateAccepted: false,
        referenceAccepted: false,
        reviewed: false,
      },
      result,
    );
    row.needsResolve = false;
    row.warnings ||= [];
    markDuplicate(row);
    persist();
    if (!row.error) await prepareRoute(row, token, budget);
  } catch (error) {
    if (!editorSession.current(token)) return;
    row.needsResolve = true;
    row.message =
      isAbort(error) || budget.signal.aborted
        ? '本行查询已停止，已识别内容保留，可重试或先保存为待补全。'
        : '查询未完成，已保留识别内容。';
    if (!isAbort(error) && !budget.signal.aborted)
      row.warnings.push(error.message);
  } finally {
    budget.dispose();
    row.running = false;
    if (editorSession.current(token)) {
      renderRow(row);
      syncControls();
      persist();
    }
  }
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
async function runMatching(targets) {
  if (running || !targets.length || !visible()) return;
  if (state.capabilities?.deployment === 'unknown') {
    status(
      'batch-status',
      '尚未确认本站查询能力，已保留输入和草稿，可先保存或稍后重试。',
      true,
    );
    return;
  }
  const token = editorSession.begin(),
    overall = requestBudget(token.signal, 300000);
  running = true;
  syncControls();
  let cursor = 0,
    done = 0;
  status(
    'batch-status',
    `正在匹配 ${targets.length} 段，单行最多 150 秒；可随时停止并核对已完成结果。`,
  );
  try {
    await ensurePlaces(overall.signal);
    if (!editorSession.current(token)) return;
    $('batch-places').innerHTML = [
      ...new Set([...state.stations, ...state.airports].map((p) => p.name)),
    ]
      .map((name) => `<option value="${esc(name)}"></option>`)
      .join('');
    async function worker() {
      while (
        cursor < targets.length &&
        editorSession.current(token) &&
        overall.remaining() > 0 &&
        !overall.signal.aborted
      ) {
        const row = targets[cursor++];
        await matchRow(row, token, overall);
        done++;
        if (editorSession.current(token))
          status(
            'batch-status',
            `已处理 ${done} / ${targets.length} 段，尚未正式保存。`,
          );
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(3, targets.length) }, worker),
    );
    if (editorSession.current(token))
      status(
        'batch-status',
        done === targets.length
          ? '匹配完成。可逐项核对，或将缺失信息保存为待补全。'
          : '查询时间已用完。已完成结果保留，未完成项可稍后重试或先保存。',
      );
  } catch (error) {
    if (editorSession.current(token))
      status(
        'batch-status',
        isAbort(error) ? '查询已停止，已完成结果保留。' : error.message,
        !isAbort(error),
      );
  } finally {
    overall.dispose();
    if (editorSession.current(token)) {
      running = false;
      syncControls();
      persist();
    }
  }
}
export async function prepareBatchImport(text) {
  if (!visible()) openEditor(true);
  cancelBatch();
  const preparationToken = editorSession.begin();
  const parsed = parseBatchLines(text);
  $('batch-text').value = text;
  reviewText = text;
  if (!journal) newJournal();
  rows = parsed.map((row, index) => ({
    ...row,
    draft: row.draft
      ? initializeDraft(
          { ...row.draft, ...(row.draft.mode === 'train' ? { provider } : {}) },
          'text',
        )
      : null,
    index,
    included: Boolean(row.draft),
    warnings: [],
    needsResolve: true,
    reviewed: false,
  }));
  renderAll();
  $('batch-review').classList.remove('hidden');
  persist();
  await journal.flush();
  if (!editorSession.current(preparationToken))
    return { saved: false, requiresConfirmation: true, cancelled: true };
  await runMatching(rows.filter((row) => row.draft));
  return {
    saved: false,
    requiresConfirmation: true,
    recognized: rows.filter((row) => row.draft).length,
  };
}
async function confirmBatch() {
  if (running) return;
  if ($('batch-text').value !== reviewText)
    throw new Error('文本已修改，请重新匹配以更新确认列表。');
  const selected = rows.filter((row) => row.included);
  if (!selected.length) return;
  const token = editorSession.begin();
  running = true;
  syncControls();
  const staged = [];
  try {
    let failed = false;
    for (const row of selected) {
      try {
        row.error = '';
        if (!row.draft) throw new Error('请修正本行文本，或取消勾选。');
        if (
          state.saved.some((t) => sameJourney(row.draft, t)) ||
          staged.some((t) => sameJourney(row.draft, t))
        )
          throw new Error('此行程已存在，请取消勾选。');
        const route =
          !row.needsResolve &&
          !row.candidates?.length &&
          row.routeKey === routeKey(row.draft, row.lookup)
            ? row.route
            : null;
        const trip = await createTrip(row.draft, row.lookup, route, {
          routeConfirmed: routeReviewAccepted(row),
          referenceAccepted: row.referenceAccepted,
          groupId,
          fetchRoute: false,
        });
        if (row.candidates?.length)
          trip.issues.push({
            code: 'MULTIPLE_CANDIDATES',
            message: '运行区间尚未选择，待补全。',
          });
        validateRecord(trip, [...state.saved, ...staged]);
        staged.push(trip);
      } catch (error) {
        row.error = error.message;
        row.reviewed = false;
        failed = true;
      }
      if (!editorSession.current(token)) return;
      renderRow(row);
    }
    if (failed) {
      persist();
      status(
        'batch-status',
        '请修改所选行程中的无效地点、日期或冲突时间；缺少时刻和路线不会阻止保存。本次未写入正式记录。',
        true,
      );
      return;
    }
    persist();
    const meta = await journal.flush();
    if (!editorSession.current(token)) return;
    await saveTrips(staged, {
      draftId: meta.id,
      draftRevision: meta.revision,
      signal: token.signal,
    });
    if (!editorSession.current(token)) return;
    journal.finish();
    running = false;
    rows = [];
    $('batch-review').classList.add('hidden');
    $('editor').close();
    toast(
      `已保存 ${staged.length} 段行程${staged.some((t) => t.routeState === 'pending') ? '，未完备项可稍后补全' : ''}。`,
    );
  } finally {
    if (editorSession.current(token)) {
      running = false;
      syncControls();
    }
  }
}
function changeRow(row, key, value) {
  row.draft = updateDraftField(row.draft, key, value);
  if (key === 'mode' && value === 'train') row.draft.provider = provider;
  row.error = '';
  row.reviewed = false;
  if (routeIdentityFields.includes(key)) {
    row.routeConfirmed = false;
    row.routeIsCandidate = false;
    row.routeCandidateAccepted = false;
  }
  if (['mode', 'number', 'date', 'from', 'to'].includes(key)) {
    row.lookup = null;
    row.route = null;
    row.routeKey = null;
    row.candidates = [];
    row.needsResolve = true;
    row.referenceAccepted = false;
  }
  if (['fromCoord', 'toCoord', 'via'].includes(key)) {
    row.route = null;
    row.routeKey = null;
    row.needsResolve = true;
  }
  row.message = '修改已保留；可重新匹配，或直接保存为待补全。';
}
export function setupBatchEditor(options) {
  ({ createTrip, openEditor } = options);
  const changeProvider = () => {
    cancelBatch();
    editorSession.cancel();
    provider =
      preferredRailProvider(
        state.capabilities,
        $('batch-provider').value || provider,
      ) || provider;
    rows = rows.map((row) =>
      switchRowProvider(
        row,
        provider,
        railProviderDataVersion(state.capabilities, provider),
      ),
    );
    fillRailProviderSelect(
      $('batch-provider'),
      state.capabilities,
      provider,
      $('batch-provider-hint'),
    );
    renderAll();
    persist();
    if (rows.length)
      status(
        'batch-status',
        '本批线路来源已更换，已保留时刻和地点；请重新匹配未确认的线路。',
      );
  };
  $('batch-provider').onchange = changeProvider;
  document.addEventListener('rail-capabilities-change', () => {
    if (visible()) changeProvider();
  });
  $('save-batch').onclick = () =>
    prepareBatchImport($('batch-text').value).catch((error) => {
      if (visible()) status('batch-status', error.message, true);
    });
  $('confirm-batch').onclick = () =>
    confirmBatch().catch((error) => {
      if (visible()) status('batch-status', error.message, true);
    });
  $('batch-text').oninput = () => {
    if (running) cancelBatch();
    persist();
    syncControls();
    if (rows.length && $('batch-text').value !== reviewText)
      status('batch-status', '原文已修改，请重新匹配；旧结果仍保留在草稿中。');
  };
  if ($('stop-batch'))
    $('stop-batch').onclick = () => {
      cancelBatch();
      status(
        'batch-status',
        '已停止后续查询，可以继续核对并保存已完成的结果。',
      );
    };
  if ($('batch-filter'))
    $('batch-filter').onchange = () => {
      applyFilter();
      persist();
    };
  if ($('retry-batch-failed'))
    $('retry-batch-failed').onclick = () =>
      runMatching(
        rows.filter(
          (row) =>
            row.draft &&
            (row.needsResolve ||
              row.routeError ||
              row.error ||
              rowPending(row)) &&
            !row.reviewed,
        ),
      );
  if ($('accept-batch-reference'))
    $('accept-batch-reference').onclick = () => {
      for (const row of rows.filter(
        (r) => r.included && hasReferenceFields(r.draft, r.lookup),
      ))
        row.referenceAccepted = true;
      renderAll();
      persist();
    };
  $('batch-rows').oninput = (event) => {
    const article = event.target.closest('[data-row]');
    if (!article || running) return;
    const row = rows[Number(article.dataset.row)];
    if (event.target.matches('[data-raw]')) {
      row.raw = event.target.value;
      persist();
      return;
    }
    const key = event.target.dataset.field;
    if (key && row.draft && event.target.tagName !== 'SELECT') {
      changeRow(row, key, event.target.value.trim());
      persist();
      syncControls();
    }
  };
  $('batch-rows').onchange = (event) => {
    const article = event.target.closest('[data-row]');
    if (!article || running) return;
    const row = rows[Number(article.dataset.row)],
      target = event.target;
    if (target.matches('[data-include]')) row.included = target.checked;
    else if (target.matches('[data-reference]'))
      row.referenceAccepted = target.checked;
    else if (target.matches('[data-route-confirm]')) {
      row.routeCandidateAccepted = target.checked;
    } else if (target.matches('[data-candidate]')) {
      if (!target.value) return;
      if (target.value === 'manual') {
        row.lookup = null;
        row.candidates = [];
        row.route = null;
        row.routeKey = null;
        row.routeConfirmed = false;
        row.routeIsCandidate = false;
        row.routeCandidateAccepted = false;
        row.referenceAccepted = false;
        row.needsResolve = false;
        row.warnings = [
          '已保留原起止地点，未采用查询航段，可手动核对或先保存为待补全。',
        ];
      } else {
        const candidate = row.candidates?.[Number(target.value)];
        if (!candidate) return;
        Object.assign(row, chooseCandidate(row, candidate));
        if (candidate.needsDateReview) {
          persist();
          renderRow(row);
          runMatching([row]);
          return;
        }
      }
      const token = editorSession.begin(),
        budget = requestBudget(token.signal, 150000);
      running = true;
      syncControls();
      prepareRoute(row, token, budget)
        .catch((error) => {
          if (!isAbort(error) && editorSession.current(token))
            row.error = error.message;
        })
        .finally(() => {
          budget.dispose();
          if (editorSession.current(token)) {
            running = false;
            markDuplicate(row);
            renderRow(row);
            syncControls();
            persist();
          }
        });
      return;
    } else if (target.dataset.field && row.draft)
      changeRow(row, target.dataset.field, target.value.trim());
    renderRow(row);
    syncControls();
    persist();
  };
  $('batch-rows').onclick = (event) => {
    const article = event.target.closest('[data-row]');
    if (!article || running) return;
    const row = rows[Number(article.dataset.row)];
    const summary = event.target.closest('summary');
    if (
      summary?.parentElement === article &&
      !event.target.closest('input,label,button,select,a')
    ) {
      row.expanded = !article.open;
      persist();
    }
    if (event.target.closest('[data-reviewed]')) {
      row.reviewed = !row.reviewed;
      if (row.reviewed) row.expanded = false;
      renderRow(row);
      persist();
      return;
    }
    if (!event.target.closest('[data-retry]')) return;
    if (!row.draft) {
      try {
        const parsed = parseBatchLines(row.raw);
        if (parsed.length !== 1) throw new Error('每行只能填写一段行程。');
        Object.assign(row, parsed[0], { line: row.line });
        row.draft = row.draft
          ? initializeDraft(
              {
                ...row.draft,
                ...(row.draft.mode === 'train' ? { provider } : {}),
              },
              'text',
            )
          : null;
        row.included = Boolean(row.draft);
        if (!row.draft) throw new Error(row.error);
      } catch (error) {
        row.error = error.message;
        renderRow(row);
        persist();
        return;
      }
    }
    runMatching([row]);
  };
  $('batch-rows').onkeydown = (event) => {
    if (
      !['Enter', ' '].includes(event.key) ||
      !event.target.matches('details.batch-row > summary')
    )
      return;
    const article = event.target.parentElement,
      row = rows[Number(article.dataset.row)];
    row.expanded = !article.open;
    persist();
  };
}
