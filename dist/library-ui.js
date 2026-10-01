import * as store from './store.js';
import { canReplay, routeLabel, tripIssues } from './domain.js';
import { tripDate } from './selectors.js';
import { resumeDraft } from './editor.js';
import { validateDraft } from './draft-validation.js';
const { $, state, esc, status, toast } = store;
let restorePreview, detailsId;
const refresh = () => document.dispatchEvent(new Event('library-refresh'));
const sourceNames = {
  text: '文本明确填写',
  manual: '手动填写',
  lookup: '所选日期计划',
  reference: '参考日期时刻',
  legacy: '旧记录 · 来源未知',
  parsed: '文本明确填写',
};
const dateCaption = (value) =>
  value
    ? String(value)
        .replace('T', ' ')
        .replace(/\.\d+Z$/, ' UTC')
    : '尚未取得';
function download(name, value, type = 'application/json') {
  const url = URL.createObjectURL(
    new Blob(
      [typeof value === 'string' ? value : JSON.stringify(value, null, 2)],
      { type },
    ),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function options(groups, current = '', all = true) {
  return `${all ? '<option value="">全部旅程</option><option value="ungrouped">未分组</option>' : '<option value="">移至未分组</option>'}${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === current ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}`;
}
function draftCaption(draft) {
  const data = draft.payload || draft.data || draft;
  return draft.kind === 'batch' || data.rows
    ? `多段行程 · ${(data.rows || []).length} 条候选`
    : `${data.row?.draft?.number || data.draft?.number || data.number || '单段行程'} · 待继续`;
}
export function renderLibraryUI(filters) {
  const groups = state.groups || [],
    drafts = state.drafts || [];
  if (
    filters.group &&
    filters.group !== 'ungrouped' &&
    !groups.some((g) => g.id === filters.group)
  )
    filters.group = '';
  $('filter-group').innerHTML = options(groups, filters.group);
  $('filter-group').value = filters.group;
  const years = [
    ...new Set(state.saved.map((t) => tripDate(t).slice(0, 4)).filter(Boolean)),
  ]
    .sort()
    .reverse();
  $('filter-year').innerHTML =
    '<option value="">全部年份</option>' +
    years.map((y) => `<option value="${esc(y)}">${esc(y)}</option>`).join('');
  for (const key of ['year', 'from', 'to', 'mode', 'search'])
    if (document.activeElement !== $('filter-' + key))
      $('filter-' + key).value = filters[key];
  const active = ['year', 'from', 'to', 'mode', 'search'].filter(
    (key) => filters[key],
  ).length;
  $('filter-summary').textContent = active ? `· ${active} 项` : '';
  $('draft-banner').classList.toggle('hidden', !drafts.length);
  $('open-drafts').textContent = `继续 ${drafts.length} 份未完成草稿`;
  $('draft-list').innerHTML = drafts.length
    ? drafts
        .map(
          (d) =>
            `<div class="draft-item"><span>${esc(draftCaption(d))}<small>${esc(dateCaption(d.updatedAt))}</small></span><button class="text-button" data-resume="${esc(d.id)}">继续</button><button class="text-button" data-discard="${esc(d.id)}">丢弃</button></div>`,
        )
        .join('')
    : '<p class="field-hint">没有待继续的草稿。</p>';
  $('bulk-toolbar').classList.toggle(
    'hidden',
    !state.selection?.size || state.demo,
  );
  $('selected-count').textContent = `已选 ${state.selection?.size || 0} 段`;
  const bulkValue = $('bulk-group').value;
  $('bulk-group').innerHTML = options(groups, bulkValue, false);
  const recovery = state.recovery;
  const items = recovery?.items || recovery?.quarantined || [];
  const recoveryMessage =
    recovery?.error ||
    (recovery?.legacyChanged
      ? '检测到旧页面修改：可在数据与说明中导入旧记录差异。'
      : items.length
        ? `${items.length} 项原始内容待恢复，正常记录仍可使用。`
        : '');
  $('recovery-banner').textContent = recoveryMessage;
  $('recovery-banner').classList.toggle('hidden', !recoveryMessage);
  $('group-list').innerHTML =
    groups
      .map(
        (g) =>
          `<form class="group-item" data-group="${esc(g.id)}"><input aria-label="旅程名称" maxlength="60" required value="${esc(g.name)}"/><span>${state.saved.filter((t) => t.groupId === g.id).length} 段</span><button class="text-button" type="submit">重命名</button><button class="text-button" type="button" data-remove-group="${esc(g.id)}">解散分组</button></form>`,
      )
      .join('') ||
    '<p class="field-hint">创建命名旅程后，可勾选行程批量归组。</p>';
  for (const id of ['group-name'])
    $(id).disabled = state.locked || !state.ready;
  $('export-backup').disabled = !state.ready;
  $('apply-restore').disabled = !state.ready;
  $('review-legacy').classList.toggle('hidden', !recovery?.legacyChanged);
  try {
    const last = localStorage.getItem('travel-trace.lastBackupAt');
    $('backup-date').textContent = last
      ? `最近备份：${new Date(last).toLocaleString('zh-CN')}`
      : '尚未导出备份';
  } catch {}
}
export function showTripDetails(trip) {
  detailsId = trip.id;
  const issues = tripIssues(trip),
    history = trip.routeHistory || [];
  $('details-title').textContent =
    `${trip.number} · ${trip.from.name} → ${trip.to.name}`;
  const fieldSource = (field) => {
    const source = trip.fieldSources?.[field];
    return (
      sourceNames[source?.source || source?.kind || source] || '来源未记录'
    );
  };
  $('details-body').innerHTML =
    `<dl class="trip-facts">${['from', 'to'].map((field) => `<dt>${field === 'from' ? '出发地点' : '到达地点'}</dt><dd>${esc(trip[field].name)} · ${esc(fieldSource(field))}</dd>`).join('')}<dt>出行日期</dt><dd>${esc(tripDate(trip))}</dd><dt>出发时刻</dt><dd>${esc(dateCaption(trip.departure))} · ${esc(fieldSource('departure'))}</dd><dt>到达时刻</dt><dd>${esc(dateCaption(trip.arrival))} · ${esc(fieldSource('arrival'))}</dd><dt>回放状态</dt><dd>${canReplay(trip) ? '可以回放' : '待补全，暂不参与回放'}</dd><dt>查询始发日期</dt><dd>${esc(trip.queryDate || '未查询')}</dd><dt>时刻参考日期</dt><dd>${esc(trip.referenceDate || '无')}</dd><dt>线路</dt><dd>${esc(routeLabel(trip))}</dd><dt>线路来源</dt><dd>${esc(trip.routeSource || '尚未取得')}</dd><dt>线路取得时间</dt><dd>${esc(dateCaption(trip.routeFetchedAt))}</dd><dt>距离口径</dt><dd>${Number.isFinite(trip.distance) ? Math.round(trip.distance) + ' km · ' : ''}${trip.mode === 'flight' ? '机场间球面距离' : trip.quality?.includes('schematic') ? '停站示意曲线长度' : '铁路几何长度'}，均非实测里程</dd></dl>
  ${issues.length ? `<ul class="issue-list">${issues.map((i) => `<li>${esc(typeof i === 'string' ? i : i.message)}</li>`).join('')}</ul>` : ''}
  ${trip.lastRouteAttempt?.error ? `<p class="form-status">最近线路查询：${esc(trip.lastRouteAttempt.error)}</p>` : ''}
  ${state.demo ? '' : `<label class="check-label"><input id="freeze-route" type="checkbox" ${trip.routeFrozen ? 'checked' : ''}/>固定当前线路版本</label><h3>保留的线路版本</h3><div class="route-history">${history.length ? history.map((h) => `<div>${esc(routeLabel(h))} · ${esc(dateCaption(h.routeFetchedAt || h.savedAt))}<button class="text-button" data-restore-route="${esc(h.id || h.versionId)}">恢复并固定</button></div>`).join('') : '<p class="field-hint">没有较早的不同线路版本。</p>'}</div>`}`;
  status('details-status', '');
  if (!$('trip-details').open) $('trip-details').showModal();
  if ($('freeze-route'))
    $('freeze-route').onchange = async (event) => {
      event.target.disabled = true;
      try {
        await store.setRouteFrozen(
          trip.id,
          event.target.checked,
          trip.revision,
          trip.routeRevision,
        );
        showTripDetails(state.saved.find((t) => t.id === trip.id));
      } catch (error) {
        status('details-status', error.message, true);
        event.target.checked = !event.target.checked;
      } finally {
        event.target.disabled = false;
      }
    };
}
function drawRestore() {
  const entries = restorePreview.entries || [];
  $('restore-extras').classList.toggle(
    'hidden',
    !(
      restorePreview.groups?.length ||
      restorePreview.drafts?.length ||
      restorePreview.recovery
    ),
  );
  $('restore-extras-caption').textContent =
    `同时恢复 ${restorePreview.groups?.length || 0} 个分组、${restorePreview.drafts?.length || 0} 份草稿及原始恢复材料（同 ID 内容保留现有）`;
  $('restore-include-extras').checked = true;
  $('restore-summary').textContent =
    `${entries.filter((e) => e.kind === 'new').length} 条新增，${entries.filter((e) => e.kind === 'duplicate').length} 条重复，${entries.filter((e) => e.kind === 'conflict').length} 条冲突，${entries.filter((e) => e.kind === 'invalid').length} 条无效。${restorePreview.extraIssues?.length ? `另有 ${restorePreview.extraIssues.length} 份草稿无法继续，原内容将保存在恢复材料中。` : ''}`;
  $('restore-rows').innerHTML = entries
    .map((entry, index) => {
      const t = entry.incoming || {},
        label = {
          new: '新增',
          duplicate: '完全重复',
          conflict: '内容冲突',
          invalid: '无效',
        }[entry.kind];
      return `<div class="restore-row"><div><strong>${esc(t.number || '记录 ' + (index + 1))} · ${esc(label)}</strong><p>${esc(t.from?.name || '')} → ${esc(t.to?.name || '')} ${esc(tripDate(t))}</p>${entry.issues?.length ? `<small>${esc(entry.issues.map((i) => i.message || i).join('；'))}</small>` : ''}</div><select data-restore-key="${esc(entry.key)}" aria-label="处理 ${esc(t.number || '记录')}" ${['invalid', 'duplicate'].includes(entry.kind) ? 'disabled' : ''}><option value="skip">保留现有 / 跳过</option>${entry.kind === 'new' ? '<option value="add" selected>新增此记录</option>' : ''}${entry.kind === 'conflict' ? '<option value="replace">采用导入内容</option>' : ''}</select></div>`;
    })
    .join('');
  $('restore-rows').innerHTML += (restorePreview.extraIssues || [])
    .map(
      (issue) =>
        `<div class="restore-row"><div><strong>草稿 ${issue.index + 1} · 已隔离</strong><p>${esc(issue.message)}</p></div></div>`,
    )
    .join('');
}
export function setupLibraryUI({ filters, render }) {
  document.addEventListener('draft-change', () => renderLibraryUI(filters));
  for (const key of Object.keys(filters))
    $('filter-' + key).addEventListener(
      key === 'search' ? 'input' : 'change',
      (event) => {
        filters[key] = event.target.value;
        render();
      },
    );
  $('clear-filters').onclick = () => {
    Object.keys(filters).forEach((k) => (filters[k] = ''));
    render();
  };
  $('clear-selection').onclick = () => {
    state.selection.clear();
    renderLibraryUI(filters);
  };
  $('apply-group').onclick = async () => {
    $('apply-group').disabled = true;
    try {
      const groupId = $('bulk-group').value || null;
      await store.saveTrips(
        state.saved
          .filter((t) => state.selection.has(t.id))
          .map((t) => ({ ...t, groupId })),
      );
      state.selection.clear();
      refresh();
      toast('已更新选中行程的分组。');
    } catch (error) {
      toast(error.message);
    } finally {
      $('apply-group').disabled = false;
    }
  };
  $('manage-groups').onclick = () => {
    renderLibraryUI(filters);
    $('groups-dialog').showModal();
  };
  $('group-form').onsubmit = async (event) => {
    event.preventDefault();
    try {
      await store.saveGroup({
        id: crypto.randomUUID(),
        name: $('group-name').value.trim(),
        revision: 0,
      });
      $('group-name').value = '';
      status('groups-status', '旅程已创建。');
    } catch (error) {
      status('groups-status', error.message, true);
    }
  };
  $('group-list').onsubmit = async (event) => {
    event.preventDefault();
    const form = event.target.closest('[data-group]'),
      g = state.groups.find((g) => g.id === form?.dataset.group);
    if (!g) return;
    try {
      await store.saveGroup({
        ...g,
        name: form.querySelector('input').value.trim(),
      });
      status('groups-status', '名称已更新。');
    } catch (error) {
      status('groups-status', error.message, true);
    }
  };
  $('group-list').onclick = async (event) => {
    const id = event.target.dataset.removeGroup;
    if (!id) return;
    const g = state.groups.find((g) => g.id === id);
    try {
      await store.deleteGroup(id, g.revision);
      status('groups-status', '已解散分组，行程已移至未分组。');
    } catch (error) {
      status('groups-status', error.message, true);
    }
  };
  $('open-drafts').onclick = () => {
    $('about').showModal();
    $('draft-list').closest('details').open = true;
  };
  $('draft-list').onclick = async (event) => {
    const id = event.target.dataset.resume || event.target.dataset.discard,
      draft = state.drafts.find((d) => d.id === id);
    if (!draft) return;
    try {
      if (event.target.dataset.resume) {
        const restored = validateDraft(draft);
        $('about').close();
        await resumeDraft(restored);
      } else {
        await store.deleteDraft(id, draft.revision);
        renderLibraryUI(filters);
      }
    } catch (error) {
      status('data-status', error.message, true);
    }
  };
  $('export-backup').onclick = async () => {
    try {
      const backup = await store.exportBackup({
        includeDrafts: $('backup-drafts').checked,
      });
      download(
        `途映备份-${new Date().toISOString().slice(0, 10)}.json`,
        backup,
      );
      try {
        localStorage.setItem(
          'travel-trace.lastBackupAt',
          new Date().toISOString(),
        );
      } catch {}
      renderLibraryUI(filters);
      status('data-status', '完整备份已下载，可在另一浏览器中导入恢复。');
    } catch (error) {
      status('data-status', error.message, true);
    }
  };
  $('export-rescue').onclick = () => {
    try {
      const raw =
        state.recovery?.rawLegacy || localStorage.getItem('travel-trace.v1');
      download('途映原始恢复材料.json', {
        format: 'travel-trace-rescue',
        exportedAt: new Date().toISOString(),
        rawLegacy: raw,
        recovery: state.recovery || {},
      });
      status('data-status', '原始内容已导出，未清空任何记录。');
    } catch (error) {
      status('data-status', error.message, true);
    }
  };
  $('import-backup').onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      restorePreview = await store.previewRestore(
        JSON.parse(await file.text()),
      );
      drawRestore();
      status('restore-status', '');
      $('restore-dialog').showModal();
    } catch (error) {
      status('data-status', '无法读取备份：' + error.message, true);
    } finally {
      event.target.value = '';
    }
  };
  $('review-legacy').onclick = async () => {
    try {
      const raw = localStorage.getItem('travel-trace.v1');
      if (!raw) throw new Error('旧页面内容为空，请导出原始恢复材料核对。');
      restorePreview = await store.previewRestore(JSON.parse(raw));
      drawRestore();
      status(
        'restore-status',
        '旧页面修改只在确认后合并；默认保留现有冲突记录。',
      );
      $('restore-dialog').showModal();
    } catch (error) {
      status('data-status', '无法核对旧记录：' + error.message, true);
    }
  };
  $('apply-restore').onclick = async () => {
    if (!restorePreview) return;
    const selections = {};
    document
      .querySelectorAll('[data-restore-key]')
      .forEach((el) => (selections[el.dataset.restoreKey] = el.value));
    $('apply-restore').disabled = true;
    try {
      const preview = $('restore-include-extras').checked
        ? restorePreview
        : { ...restorePreview, groups: [], drafts: [], recovery: null };
      await store.applyRestore(preview, selections);
      $('restore-dialog').close();
      status('data-status', '选中内容已合并，原有记录已保留。');
      restorePreview = null;
    } catch (error) {
      status(
        'restore-status',
        error.message + ' 原记录未改动，请重新选择文件生成预览。',
        true,
      );
    } finally {
      $('apply-restore').disabled = false;
    }
  };
  $('details-body').onclick = async (event) => {
    const version = event.target.dataset.restoreRoute;
    if (!version) return;
    const trip = state.saved.find((t) => t.id === detailsId);
    if (!trip) return;
    event.target.disabled = true;
    try {
      await store.restoreRoute(trip.id, version, trip.revision);
      showTripDetails(state.saved.find((t) => t.id === trip.id));
      status('details-status', '已恢复并固定该线路版本。');
    } catch (error) {
      status('details-status', error.message, true);
      event.target.disabled = false;
    }
  };
  $('refresh-diagnostics').onclick = async () => {
    try {
      $('diagnostics').textContent = JSON.stringify(
        await store.api('/api/diagnostics'),
        null,
        2,
      );
    } catch (error) {
      $('diagnostics').textContent = error.message;
    }
  };
  $('copy-diagnostics').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('diagnostics').textContent);
      toast('诊断摘要已复制。');
    } catch {
      toast('无法自动复制，可选中诊断文字手动复制。');
    }
  };
}
