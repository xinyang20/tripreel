import {
  normalizeTrip,
  validateRecord,
  extractRoute,
  routeInputs,
  journeyKey,
  canRenderRoute,
  routeQualityRank,
  ROUTE_FIELDS,
} from './domain.js';

export const LEGACY_KEY = 'travel-trace.v1';
const STORES = ['meta', 'trips', 'routes', 'drafts', 'groups', 'rescue'];
const MAX_BACKUP_BYTES = 30 * 1024 * 1024;
const clone = (value) => structuredClone(value);
const request = (p) =>
  new Promise((resolve, reject) => {
    p.onsuccess = () => resolve(p.result);
    p.onerror = () => reject(p.error);
  });
const abortError = () =>
  new DOMException('操作已取消，原记录未改动。', 'AbortError');
const conflict = (message) =>
  Object.assign(
    new Error(message || '记录已在其他页面修改，请保留输入并重新核对。'),
    { code: 'CONFLICT' },
  );
function safeData(value) {
  const raw = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item))
      throw new Error('数据含无效数字。');
    return item;
  });
  if (!raw || raw.length > MAX_BACKUP_BYTES)
    throw new Error('数据超过 30 MB 或结构无效。');
  return JSON.parse(raw);
}
function assertRevision(current, expected, label = '记录') {
  if (
    !Number.isInteger(expected) ||
    expected < 0 ||
    (current ? current.revision !== expected : expected !== 0)
  )
    throw conflict(`${label}已改变或被删除，请重新核对后保存。`);
}
function sorted(trips) {
  return trips.sort((a, b) =>
    (a.departure || a.travelDate || '').localeCompare(
      b.departure || b.travelDate || '',
    ),
  );
}
function content(trip) {
  const value = clone(trip);
  for (const key of [
    'revision',
    'routeRevision',
    'routeHistory',
    'updatedAt',
    'createdAt',
    'issues',
  ])
    delete value[key];
  const canonical = (item) =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, canonical(item[key])]),
          )
        : item;
  return JSON.stringify(canonical(value));
}
function checkSet(trips) {
  const ids = new Set(),
    keys = new Set();
  for (const trip of trips) {
    validateRecord(trip, trips);
    if (ids.has(trip.id) || keys.has(journeyKey(trip)))
      throw new Error(`行程 ${trip.number} 重复，请核对。`);
    ids.add(trip.id);
    keys.add(journeyKey(trip));
  }
}
function split(trip) {
  const base = clone(trip),
    route = {
      id: trip.id,
      data: extractRoute(trip),
      revision: trip.routeRevision,
      history: clone(trip.routeHistory || []),
    };
  for (const key of ROUTE_FIELDS)
    if (!['from', 'to', 'via'].includes(key)) delete base[key];
  delete base.routeHistory;
  return { base, route };
}
function hydrate(base, route) {
  return normalizeTrip({
    ...base,
    ...(route?.data || {}),
    revision: base.revision,
    routeRevision: route?.revision || 0,
    routeHistory: route?.history || [],
  });
}
function routeChanged(a, b) {
  return JSON.stringify(extractRoute(a)) !== JSON.stringify(extractRoute(b));
}
function routeVersionKey(route, fallback = {}) {
  const place = (value) => [value?.name || '', value?.coord || null];
  return JSON.stringify([
    route.mode || route.tripMode || fallback.mode,
    route.number || route.tripNumber || fallback.number,
    place(route.from),
    place(route.to),
    (route.stops || []).map(place),
    route.routeCoordinates || [],
    (route.legs || []).map((leg) => leg.coordinates || []),
  ]);
}
function distinctHistory(next, candidates) {
  const seen = new Set([routeVersionKey(next)]),
    history = [];
  for (const candidate of candidates) {
    const key = routeVersionKey(candidate, next);
    if (
      seen.has(key) ||
      !canRenderRoute({
        ...candidate,
        mode: candidate.mode || candidate.tripMode || next.mode,
        routeState: undefined,
        routeConfirmed: true,
      })
    )
      continue;
    seen.add(key);
    history.push(candidate);
    if (history.length === 3) break;
  }
  return history;
}
function matchingRouteRequest(current, original) {
  return (
    !current.routeFrozen &&
    current.revision === original.revision &&
    current.routeRevision === original.routeRevision &&
    routeInputs(current) === routeInputs(original)
  );
}
function routeAttempt(error = null, code = null) {
  return { at: new Date().toISOString(), error, code };
}
function archive(current) {
  return {
    id: crypto.randomUUID(),
    ...extractRoute(current),
    tripNumber: current.number,
    tripMode: current.mode,
    routeConfirmed: current.routeConfirmed,
    routeRevision: current.routeRevision,
    savedAt: new Date().toISOString(),
  };
}
function assignRoute(current, route) {
  const result = {
    ...current,
    ...extractRoute(route),
    routeState: undefined,
    routeCandidate: null,
    issues: (current.issues || []).filter(
      (issue) =>
        !['ROUTE_CONFIRMATION_REQUIRED', 'ROUTE_UNAVAILABLE'].includes(
          issue.code,
        ),
    ),
  };
  result.from = { ...current.from, ...route.from, name: current.from.name };
  result.to = { ...current.to, ...route.to, name: current.to.name };
  result.stops = (route.stops || current.stops || []).map((stop, index) => {
    const old =
      current.stops?.[index]?.name === stop.name
        ? current.stops[index]
        : current.stops?.find((s) => s.name === stop.name);
    return {
      ...stop,
      ...(old?.arrival ? { arrival: old.arrival } : {}),
      ...(old?.departure ? { departure: old.departure } : {}),
    };
  });
  return result;
}
export function createRepository({
  indexedDB = globalThis.indexedDB,
  legacyStorage = globalThis.localStorage,
  dbName = 'travel-trace',
  broadcast = typeof window !== 'undefined',
  onBlocked,
} = {}) {
  let db,
    opening,
    channel,
    closed = false;
  const subscribers = new Set();
  const publish = (revision, kind = 'records') =>
    channel?.postMessage({ revision, kind });
  async function open() {
    if (closed) throw new Error('存储连接已关闭，请刷新页面。');
    if (db) return db;
    if (opening) return opening;
    if (!indexedDB)
      throw new Error(
        '当前浏览器无法使用 IndexedDB，原记录已保留，请更换支持的浏览器或导出旧数据。',
      );
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 2);
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error('其他页面阻止数据库升级，请关闭旧页面后重试。'));
      }, 5000);
      req.onupgradeneeded = () => {
        for (const name of STORES)
          if (!req.result.objectStoreNames.contains(name))
            req.result.createObjectStore(name, { keyPath: 'id' });
      };
      req.onblocked = () => onBlocked?.();
      req.onerror = () => {
        clearTimeout(timer);
        settled = true;
        reject(req.error);
      };
      req.onsuccess = () => {
        clearTimeout(timer);
        if (settled) {
          req.result.close();
          return;
        }
        settled = true;
        db = req.result;
        db.onversionchange = () => {
          db.close();
          db = null;
          subscribers.forEach((fn) => fn({ upgrade: true }));
        };
        resolve(db);
      };
    }).finally(() => {
      opening = null;
    });
    return opening;
  }
  async function run(mode, work, { signal } = {}) {
    if (signal?.aborted) throw abortError();
    const database = await open();
    if (signal?.aborted) throw abortError();
    const tx = database.transaction(STORES, mode);
    let result, workError;
    const abort = () => {
      try {
        tx.abort();
      } catch {}
    };
    signal?.addEventListener('abort', abort, { once: true });
    const completed = new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(
          workError ||
            (signal?.aborted
              ? abortError()
              : tx.error || new Error('存储事务未完成，原记录未改动。')),
        );
      tx.onerror = () => {};
    });
    const stores = Object.fromEntries(
      STORES.map((name) => [name, tx.objectStore(name)]),
    );
    try {
      result = await work(stores);
      if (signal?.aborted) {
        abort();
        throw abortError();
      }
      await completed;
      return result;
    } catch (error) {
      workError = error;
      abort();
      await completed.catch(() => {});
      if (signal?.aborted) throw abortError();
      if (error?.name === 'QuotaExceededError')
        throw new Error('浏览器存储空间不足，原记录未改动，请先导出备份。');
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  async function getAll(stores) {
    const [bases, routes] = await Promise.all([
      request(stores.trips.getAll()),
      request(stores.routes.getAll()),
    ]);
    const map = new Map(routes.map((r) => [r.id, r]));
    return sorted(bases.map((t) => hydrate(t, map.get(t.id))));
  }
  async function write(stores, trip) {
    const { base, route } = split(trip);
    await request(stores.trips.put(base));
    await request(stores.routes.put(route));
  }
  async function bump(stores) {
    const meta = await request(stores.meta.get('dataset'));
    meta.revision++;
    await request(stores.meta.put(meta));
    return meta.revision;
  }
  async function writable(stores) {
    const meta = await request(stores.meta.get('dataset'));
    if (!meta) throw new Error('存储尚未初始化。');
    if (meta.error)
      throw new Error('原数据需要救援，暂不保存新记录；请先导出或恢复。');
    return meta;
  }
  async function init() {
    await open();
    let rawLegacy = null,
      legacyError = null;
    try {
      rawLegacy = legacyStorage?.getItem(LEGACY_KEY) ?? null;
    } catch {
      legacyError = '无法读取旧浏览器记录，原数据未覆盖。';
    }
    await run('readwrite', async (stores) => {
      if (await request(stores.meta.get('dataset'))) return;
      const meta = {
        id: 'dataset',
        schemaVersion: 2,
        revision: 0,
        legacyRaw: rawLegacy,
        migratedAt: new Date().toISOString(),
        error: legacyError,
      };
      if (rawLegacy) {
        let data;
        try {
          data = JSON.parse(rawLegacy);
          if (data.version !== 1 || !Array.isArray(data.trips))
            throw new Error('旧数据格式不支持。');
        } catch (error) {
          meta.error = error.message || '旧数据无法解析。';
        }
        if (data?.version === 1 && Array.isArray(data.trips)) {
          const valid = [];
          for (let i = 0; i < data.trips.length; i++) {
            const raw = data.trips[i];
            let trip;
            try {
              if (!raw?.id) throw new Error('缺少行程标识。');
              validateRecord(raw);
              trip = normalizeTrip(raw);
              if (
                valid.some(
                  (t) => t.id === trip.id || journeyKey(t) === journeyKey(trip),
                )
              )
                throw new Error('旧记录存在重复标识或旅程。');
              trip.revision = 1;
              trip.routeRevision = canRenderRoute(trip) ? 1 : 0;
              validateRecord(trip);
              valid.push(trip);
            } catch (error) {
              await request(
                stores.rescue.put({
                  id: `legacy-${i}`,
                  reason: error.message,
                  raw: clone(raw),
                }),
              );
              continue;
            }
            // Storage failure aborts the entire migration; only invalid input
            // belongs in rescue. Otherwise a quota error could leave half a row.
            await write(stores, trip);
          }
        }
      }
      await request(stores.meta.put(meta));
    });
    if (broadcast && !channel && globalThis.BroadcastChannel) {
      channel = new BroadcastChannel(`${dbName}:changes`);
      channel.onmessage = (event) =>
        subscribers.forEach((fn) => fn(event.data));
      channel.unref?.();
    }
    return snapshot();
  }
  async function snapshot() {
    return run('readonly', async (stores) => {
      const [meta, trips, groups, drafts, items] = await Promise.all([
        request(stores.meta.get('dataset')),
        getAll(stores),
        request(stores.groups.getAll()),
        request(stores.drafts.getAll()),
        request(stores.rescue.getAll()),
      ]);
      let legacyChanged = false;
      try {
        legacyChanged =
          (legacyStorage?.getItem(LEGACY_KEY) ?? null) !== meta?.legacyRaw;
      } catch {}
      return {
        trips,
        groups,
        drafts,
        datasetRevision: meta?.revision || 0,
        recovery: {
          items,
          rawLegacy: meta?.legacyRaw ?? null,
          error: meta?.error || null,
          legacyChanged,
        },
        locked: Boolean(meta?.error),
      };
    });
  }
  async function mutate(work, options) {
    const result = await run(
      'readwrite',
      async (stores) => {
        await writable(stores);
        const value = await work(stores);
        const revision = value === false ? null : await bump(stores);
        return { value, revision };
      },
      options,
    );
    if (result.revision !== null) publish(result.revision, options?.kind);
    return result.value;
  }
  async function saveTrips(inputs, { draftId, draftRevision, signal } = {}) {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 10000)
      throw new Error('待保存的行程列表无效。');
    const prepared = inputs.map((input) => {
      validateRecord(input);
      return normalizeTrip(safeData(input));
    });
    return mutate(
      async (stores) => {
        const all = await getAll(stores),
          map = new Map(all.map((t) => [t.id, t])),
          seen = new Set(),
          saved = [];
        for (const incoming of prepared) {
          if (seen.has(incoming.id)) throw new Error('本批记录包含重复标识。');
          seen.add(incoming.id);
          const current = map.get(incoming.id);
          assertRevision(current, incoming.revision);
          if (
            incoming.groupId &&
            !(await request(stores.groups.get(incoming.groupId)))
          )
            throw new Error('旅程分组不存在，请重新选择。');
          const next = normalizeTrip({
            ...incoming,
            revision: (current?.revision || 0) + 1,
            createdAt: current?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          if (current) {
            if (incoming.routeRevision !== current.routeRevision)
              throw conflict('路线已在其他页面更新，请重新核对后保存。');
            next.lastRouteAttempt = current.lastRouteAttempt;
            next.routeHistory = distinctHistory(next, current.routeHistory);
            if (routeChanged(current, next)) {
              next.routeHistory = distinctHistory(next, [
                archive(current),
                ...current.routeHistory,
              ]);
              next.routeRevision = current.routeRevision + 1;
            }
          } else {
            next.routeRevision = canRenderRoute(next) ? 1 : 0;
            next.routeHistory = distinctHistory(next, next.routeHistory);
          }
          map.set(next.id, next);
          saved.push(next);
        }
        checkSet([...map.values()]);
        if (draftId) {
          const draft = await request(stores.drafts.get(draftId));
          if (!draft) throw conflict('草稿已在其他页面删除。');
          assertRevision(draft, draftRevision, '草稿');
        }
        for (const trip of saved) await write(stores, trip);
        if (draftId) await request(stores.drafts.delete(draftId));
        return saved;
      },
      { signal },
    );
  }
  async function deleteTrip(id, expectedRevision) {
    return mutate(async (stores) => {
      const trip = await request(stores.trips.get(id));
      if (!trip) throw conflict('行程已删除。');
      assertRevision(trip, expectedRevision);
      await request(stores.trips.delete(id));
      await request(stores.routes.delete(id));
      return true;
    });
  }
  async function saveDraft(input) {
    const draft = safeData(input);
    draft.id ||= crypto.randomUUID();
    const expected = draft.revision ?? 0;
    return mutate(
      async (stores) => {
        const current = await request(stores.drafts.get(draft.id));
        assertRevision(current, expected, '草稿');
        const next = {
          ...draft,
          revision: expected + 1,
          updatedAt: new Date().toISOString(),
        };
        await request(stores.drafts.put(next));
        return next;
      },
      { kind: 'drafts' },
    );
  }
  async function listDrafts() {
    return run('readonly', (stores) => request(stores.drafts.getAll()));
  }
  async function deleteDraft(id, options) {
    const expected = typeof options === 'object' ? options?.revision : options;
    return mutate(
      async (stores) => {
        const current = await request(stores.drafts.get(id));
        if (!current) return false;
        assertRevision(current, expected, '草稿');
        await request(stores.drafts.delete(id));
        return true;
      },
      { signal: options?.signal, kind: 'drafts' },
    );
  }
  async function saveGroup(input) {
    const group = safeData(input);
    group.id ||= crypto.randomUUID();
    group.name = String(group.name || '').trim();
    if (!group.name || group.name.length > 80)
      throw new Error('分组名称须为 1 至 80 个字符。');
    return mutate(async (stores) => {
      const current = await request(stores.groups.get(group.id));
      assertRevision(current, group.revision ?? 0, '分组');
      const next = {
        ...group,
        revision: (current?.revision || 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      await request(stores.groups.put(next));
      return next;
    });
  }
  async function deleteGroup(id, revision) {
    return mutate(async (stores) => {
      const group = await request(stores.groups.get(id));
      if (!group) throw conflict('分组已删除。');
      assertRevision(group, revision, '分组');
      for (const trip of await getAll(stores))
        if (trip.groupId === id)
          await write(stores, {
            ...trip,
            groupId: null,
            revision: trip.revision + 1,
          });
      await request(stores.groups.delete(id));
      return true;
    });
  }
  async function updateRoute(original, route, { signal } = {}) {
    const result = await mutate(
      async (stores) => {
        const base = await request(stores.trips.get(original.id));
        if (!base) return false;
        const current = hydrate(
          base,
          await request(stores.routes.get(base.id)),
        );
        if (!matchingRouteRequest(current, original)) return false;
        let resolved;
        try {
          const merged = assignRoute(current, route || {});
          // Missing geometry must not inherit the old curve and appear successful.
          merged.routeCoordinates = route?.routeCoordinates || [];
          merged.legs = route?.legs || [];
          merged.routeConfirmed = true;
          resolved = normalizeTrip(merged);
          validateRecord(resolved);
          if (
            !canRenderRoute(resolved) ||
            route?.quality === 'pending' ||
            route?.resolution?.state === 'unavailable'
          )
            throw Object.assign(new Error('返回的线路不完整，原线路已保留。'), {
              code: 'ROUTE_UNAVAILABLE',
            });
          if (
            routeQualityRank(resolved) <
            Math.max(
              routeQualityRank(current),
              current.routeCandidate
                ? routeQualityRank(current.routeCandidate)
                : 0,
            )
          )
            throw Object.assign(
              new Error('新线路质量低于当前线路，已保留原线路。'),
              { code: 'LOWER_QUALITY_ROUTE' },
            );
        } catch (error) {
          current.lastRouteAttempt = routeAttempt(
            error.message,
            error.code || 'INVALID_ROUTE',
          );
          await write(stores, current);
          return { error: current.lastRouteAttempt };
        }
        const requiresConfirmation = Boolean(
          route.requiresConfirmation ||
          route.resolution?.requiresConfirmation ||
          route.resolution?.state === 'needs-confirmation' ||
          ['station-schematic', 'manual-schematic'].includes(resolved.quality),
        );
        const alreadyConfirmed =
          current.quality === resolved.quality &&
          current.routeConfirmed === true &&
          JSON.stringify(current.routeCoordinates) ===
            JSON.stringify(resolved.routeCoordinates) &&
          current.stops.map((stop) => stop.name).join('|') ===
            resolved.stops.map((stop) => stop.name).join('|');
        const candidateOnly = requiresConfirmation && !alreadyConfirmed;
        const next = candidateOnly
          ? normalizeTrip({
              ...current,
              routeCandidate: extractRoute(resolved),
            })
          : resolved;
        next.lastRouteAttempt = routeAttempt();
        next.revision = current.revision;
        next.routeRevision =
          current.routeRevision +
          Number(
            routeChanged(current, next) ||
              JSON.stringify(current.routeCandidate) !==
                JSON.stringify(next.routeCandidate),
          );
        if (!candidateOnly)
          next.routeHistory = distinctHistory(next, [
            archive(current),
            ...current.routeHistory,
          ]);
        validateRecord(next);
        await write(stores, next);
        return true;
      },
      { signal },
    );
    if (result?.error)
      throw Object.assign(new Error(result.error.error), {
        code: result.error.code,
        routeAttemptRecorded: true,
      });
    return result;
  }
  async function recordRouteAttempt(original, error, { signal } = {}) {
    return mutate(
      async (stores) => {
        const base = await request(stores.trips.get(original.id));
        if (!base) return false;
        const current = hydrate(
          base,
          await request(stores.routes.get(base.id)),
        );
        if (!matchingRouteRequest(current, original)) return false;
        current.lastRouteAttempt = routeAttempt(
          String(error?.message || error || '线路查询失败，请稍后重试。'),
          error?.code || null,
        );
        await write(stores, current);
        return true;
      },
      { signal },
    );
  }
  async function setRouteFrozen(
    id,
    frozen,
    expectedRevision,
    expectedRouteRevision,
  ) {
    return mutate(async (stores) => {
      const base = await request(stores.trips.get(id));
      if (!base) throw conflict('行程已删除。');
      assertRevision(base, expectedRevision ?? base.revision);
      const trip = hydrate(base, await request(stores.routes.get(id)));
      if (
        expectedRouteRevision !== undefined &&
        expectedRouteRevision !== trip.routeRevision
      )
        throw conflict('线路已更新，请重新打开详情核对后再冻结。');
      trip.routeFrozen = Boolean(frozen);
      trip.revision++;
      await write(stores, normalizeTrip(trip));
      return trip;
    });
  }
  async function restoreRoute(id, versionId, expectedRevision) {
    return mutate(async (stores) => {
      const base = await request(stores.trips.get(id));
      if (!base) throw conflict('行程已删除。');
      assertRevision(base, expectedRevision ?? base.revision);
      const current = hydrate(base, await request(stores.routes.get(id))),
        historical = current.routeHistory.find(
          (route) => route.id === versionId,
        );
      if (!historical) throw new Error('此线路版本已不存在，请刷新列表。');
      if (
        historical.from?.name !== current.from.name ||
        historical.to?.name !== current.to.name ||
        (historical.tripNumber && historical.tripNumber !== current.number) ||
        (historical.tripMode && historical.tripMode !== current.mode)
      )
        throw new Error('此历史线路属于其他车次或区间，不能恢复到当前行程。');
      const next = normalizeTrip(assignRoute(current, historical));
      next.routeConfirmed = historical.routeConfirmed !== false;
      next.routeFrozen = true;
      next.revision = current.revision + 1;
      next.routeRevision = current.routeRevision + 1;
      next.routeHistory = distinctHistory(next, [
        archive(current),
        ...current.routeHistory.filter((route) => route.id !== versionId),
      ]);
      next.lastRouteAttempt = routeAttempt();
      validateRecord(next);
      await write(stores, next);
      return next;
    });
  }
  async function exportBackup({ includeDrafts = true } = {}) {
    const data = await snapshot();
    return {
      format: 'travel-trace-backup',
      version: 2,
      exportedAt: new Date().toISOString(),
      trips: data.trips,
      groups: data.groups,
      ...(includeDrafts ? { drafts: data.drafts } : {}),
      ...(data.recovery.items.length || data.recovery.error
        ? { recovery: data.recovery }
        : {}),
    };
  }
  async function previewRestore(input) {
    const data =
      typeof input === 'string' ? JSON.parse(input) : safeData(input);
    if (JSON.stringify(data).length > MAX_BACKUP_BYTES)
      throw new Error('备份不能超过 30 MB。');
    if (
      !(
        data.version === 1 ||
        (data.version === 2 && data.format === 'travel-trace-backup')
      ) ||
      !Array.isArray(data.trips) ||
      data.trips.length > 10000
    )
      throw new Error('不支持此备份格式或记录数量。');
    const existing = await snapshot(),
      seen = new Set(),
      entries = data.trips.map((raw, index) => {
        const key = String(index);
        try {
          validateRecord(raw);
          const incoming = normalizeTrip(raw);
          if (seen.has(incoming.id))
            throw new Error('备份中存在重复行程标识。');
          seen.add(incoming.id);
          const found =
            existing.trips.find((t) => t.id === incoming.id) ||
            existing.trips.find((t) => journeyKey(t) === journeyKey(incoming));
          return {
            key,
            kind: found
              ? content(found) === content(incoming)
                ? 'duplicate'
                : 'conflict'
              : 'new',
            incoming,
            existing: found || null,
            issues: [],
          };
        } catch (error) {
          return {
            key,
            kind: 'invalid',
            incoming: raw,
            existing: null,
            issues: [
              {
                code: 'invalid-backup-record',
                severity: 'error',
                message: error.message,
              },
            ],
          };
        }
      });
    return {
      format: 'travel-trace-restore-preview',
      datasetRevision: existing.datasetRevision,
      entries,
      groups: Array.isArray(data.groups) ? safeData(data.groups) : [],
      drafts: Array.isArray(data.drafts) ? safeData(data.drafts) : [],
      recovery: data.recovery || null,
    };
  }
  async function applyRestore(preview, selections = {}) {
    if (
      preview?.format !== 'travel-trace-restore-preview' ||
      !Array.isArray(preview.entries)
    )
      throw new Error('恢复预览无效，请重新选择文件。');
    const result = await run('readwrite', async (stores) => {
      const meta = await request(stores.meta.get('dataset'));
      if (meta.revision !== preview.datasetRevision)
        throw conflict('预览后记录已改变，请重新生成恢复预览。');
      const all = await getAll(stores),
        map = new Map(all.map((t) => [t.id, t]));
      const saved = [];
      for (const entry of preview.entries) {
        const action =
          selections[entry.key] || (entry.kind === 'new' ? 'add' : 'skip');
        if (action === 'skip') continue;
        if (!['add', 'replace'].includes(action) || entry.kind === 'invalid')
          throw new Error('恢复选择无效，请修正问题项。');
        validateRecord(entry.incoming);
        const incoming = normalizeTrip(safeData(entry.incoming)),
          current = entry.existing
            ? map.get(entry.existing.id)
            : map.get(incoming.id);
        if (current && action !== 'replace')
          throw conflict('已有记录需明确选择替换。');
        if (!current && action === 'replace')
          throw conflict('待替换记录已不存在。');
        const next = normalizeTrip({
          ...incoming,
          id: current?.id || incoming.id,
          revision: (current?.revision || 0) + 1,
          routeRevision: (current?.routeRevision || 0) + 1,
        });
        next.routeHistory = distinctHistory(
          next,
          current
            ? [archive(current), ...current.routeHistory, ...next.routeHistory]
            : next.routeHistory,
        );
        map.set(next.id, next);
        saved.push(next);
      }
      checkSet([...map.values()]);
      for (const raw of preview.groups) {
        if (
          typeof raw.id !== 'string' ||
          typeof raw.name !== 'string' ||
          !raw.name.trim() ||
          raw.name.length > 80
        )
          throw new Error('备份分组无效。');
        if (!(await request(stores.groups.get(raw.id))))
          await request(stores.groups.put({ ...raw, revision: 1 }));
      }
      for (const trip of saved) {
        if (trip.groupId && !(await request(stores.groups.get(trip.groupId))))
          trip.groupId = null;
        await write(stores, trip);
      }
      for (const raw of preview.drafts) {
        const draft = safeData(raw);
        if (typeof draft.id !== 'string') throw new Error('备份草稿无效。');
        if (!(await request(stores.drafts.get(draft.id))))
          await request(stores.drafts.put({ ...draft, revision: 1 }));
      }
      // Invalid records remain user data and must survive backup round trips.
      const importedRecovery = preview.recovery;
      if (importedRecovery) {
        const candidates = Array.isArray(importedRecovery.items)
          ? [...importedRecovery.items]
          : [];
        if (
          typeof importedRecovery.rawLegacy === 'string' &&
          importedRecovery.rawLegacy !== meta.legacyRaw
        )
          candidates.push({
            reason: importedRecovery.error || '从备份保留的旧记录原文。',
            raw: importedRecovery.rawLegacy,
          });
        const currentRescue = await request(stores.rescue.getAll());
        for (const item of candidates) {
          if (!item || typeof item.reason !== 'string' || !('raw' in item))
            throw new Error('备份中的救援数据结构无效。');
          if (
            currentRescue.some(
              (existing) =>
                existing.reason === item.reason &&
                JSON.stringify(existing.raw) === JSON.stringify(item.raw),
            )
          )
            continue;
          const restored = {
            id: crypto.randomUUID(),
            reason: item.reason,
            raw: safeData(item.raw),
          };
          await request(stores.rescue.put(restored));
          currentRescue.push(restored);
        }
      }
      if (saved.length) meta.error = null;
      meta.revision++;
      await request(stores.meta.put(meta));
      return { saved: saved.length, revision: meta.revision };
    });
    publish(result.revision);
    return result;
  }
  return {
    init,
    snapshot,
    saveTrips,
    deleteTrip,
    saveDraft,
    listDrafts,
    deleteDraft,
    saveGroup,
    deleteGroup,
    updateRoute,
    recordRouteAttempt,
    setRouteFrozen,
    restoreRoute,
    exportBackup,
    previewRestore,
    applyRestore,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    close() {
      closed = true;
      db?.close();
      channel?.close();
      db = null;
    },
    rawLegacy() {
      try {
        return legacyStorage?.getItem(LEGACY_KEY) ?? null;
      } catch {
        return null;
      }
    },
  };
}
