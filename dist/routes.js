import {
  $,
  state,
  api,
  updateStoredRoute,
  recordRouteAttempt,
} from './store.js';
let running = false,
  reportTimer,
  controller;
const attempted = new Set();
function hideReport() {
  clearTimeout(reportTimer);
  $('route-update-status')?.classList.add('hidden');
  if (!running && $('save-status'))
    $('save-status').textContent = state.locked
      ? '原数据需要救援'
      : '已保存在此浏览器';
}
function report(text, failures = [], retry = false, duration = 0) {
  clearTimeout(reportTimer);
  const panel = $('route-update-status');
  if (!panel) return;
  panel.replaceChildren();
  panel.classList.remove('hidden');
  const close = document.createElement('button');
  close.className = 'flash-close';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭线路更新提示');
  close.onclick = hideReport;
  panel.append(close);
  const heading = document.createElement('p');
  heading.textContent = text;
  panel.append(heading);
  for (const failure of failures) {
    const row = document.createElement('p');
    row.textContent = `${failure.number}：${failure.message}`;
    panel.append(row);
  }
  if (retry) {
    const button = document.createElement('button');
    button.className = 'text-button';
    button.textContent = '重新更新线路';
    button.onclick = () => refreshStoredRoutes({ force: true });
    panel.append(button);
  }
  if (duration) reportTimer = setTimeout(hideReport, duration);
}
export function cancelRouteRefresh() {
  controller?.abort();
}
export async function refreshStoredRoutes({ force = false } = {}) {
  if (running || !state.ready || state.locked || $('editor')?.open) return;
  if (force) attempted.clear();
  const pending = state.saved.filter(
    (trip) =>
      trip.mode === 'train' &&
      !trip.routeFrozen &&
      trip.from?.name &&
      trip.to?.name &&
      !attempted.has(`${trip.id}:${trip.revision}`) &&
      (force ||
        trip.routePolicy !== 'latest-v2' ||
        !trip.routeCoordinates?.length ||
        !(Date.now() - Date.parse(trip.routeFetchedAt) < 6 * 3600000)),
  );
  if (!pending.length) return;
  running = true;
  controller = new AbortController();
  const signal = controller.signal;
  let updated = 0;
  const failures = [];
  try {
    for (const trip of pending) {
      if (signal.aborted || $('editor')?.open) break;
      const key = `${trip.id}:${trip.revision}`;
      attempted.add(key);
      if ($('save-status'))
        $('save-status').textContent = `正在更新 ${trip.number} 的线路…`;
      report(`正在更新 ${trip.number} 的线路，日期和时刻保持不变。`);
      try {
        const route = await api(
          '/api/route',
          {
            mode: 'train',
            number: trip.number,
            date:
              trip.queryDate || trip.travelDate || trip.departure?.slice(0, 10),
            from: trip.from.name,
            to: trip.to.name,
            via:
              trip.via ||
              trip.stops
                .slice(1, -1)
                .map((stop) => stop.name)
                .join('、'),
            fromCoord: trip.from.coord,
            toCoord: trip.to.coord,
          },
          { signal, timeoutMs: 80000, priority: 'background' },
        );
        if (signal.aborted || $('editor')?.open) {
          attempted.delete(key);
          break;
        }
        if (await updateStoredRoute(trip, route, { signal })) updated++;
        else attempted.delete(key);
      } catch (error) {
        if (signal.aborted) {
          attempted.delete(key);
          break;
        }
        if (!error.routeAttemptRecorded)
          await recordRouteAttempt(trip, error, { signal }).catch(() => {});
        failures.push({
          number: trip.number,
          message: /timeout|aborted/i.test(error.message)
            ? '请求超时，请检查网络后重试。'
            : error.message || '线路查询失败。',
        });
      }
    }
  } finally {
    running = false;
    controller = null;
    if ($('save-status'))
      $('save-status').textContent = state.locked
        ? '原数据需要救援'
        : '已保存在此浏览器';
    if (failures.length)
      report(
        `已更新 ${updated} 段；以下 ${failures.length} 段保留原记录，无需重新添加。`,
        failures,
        true,
        12000,
      );
    else if (updated)
      report(
        `已更新 ${updated} 段线路，原日期和时间已保留；示意线路需确认后使用。`,
        [],
        false,
        6000,
      );
    else hideReport();
  }
}
$('editor')?.addEventListener('close', refreshStoredRoutes);
if (typeof MutationObserver !== 'undefined' && $('editor'))
  new MutationObserver(() => {
    if ($('editor').open) cancelRouteRefresh();
  }).observe($('editor'), { attributes: true, attributeFilter: ['open'] });
if (typeof window !== 'undefined')
  window.addEventListener('pagehide', cancelRouteRefresh);
