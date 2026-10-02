import {
  normalizeTrip,
  validateRecord,
  extractRoute,
  routeInputs,
  journeyKey,
  canRenderRoute,
  routeQualityRank,
  ROUTE_FIELDS,
  actualTravelDate,
} from './domain.js';
import { validateDraft } from './draft-validation.js';
import { parseTime } from './core.js';
import { measureStage } from './performance.js';

export const LEGACY_KEY = 'travel-trace.v1';
const STORES = ['meta', 'trips', 'routes', 'drafts', 'groups', 'rescue'];
const MAX_BACKUP_BYTES = 30 * 1024 * 1024;
const IDENTITY_INDEX_KEY = 'trip-identities';
const IDENTITY_FIELDS = [
  'id',
  'mode',
  'number',
  'travelDate',
  'departure',
  'arrival',
  'from',
  'to',
  'groupId',
  'revision',
];
function identityRecord(trip) {
  return {
    id: trip.id,
    mode: trip.mode,
    number: trip.number,
    travelDate: actualTravelDate(trip),
    departure: trip.departure || null,
    arrival: trip.arrival || null,
    from: trip.from?.name || '',
    to: trip.to?.name || '',
    groupId: trip.groupId ?? null,
    revision: trip.revision,
  };
}
function validIdentityIndex(index, revision, count) {
  if (
    index?.schemaVersion !== 1 ||
    index.datasetRevision !== revision ||
    !Array.isArray(index.entries) ||
    index.entries.length !== count
  )
    return false;
  const seen = new Set();
  return index.entries.every((entry) => {
    if (
      !entry ||
      Object.keys(entry).length !== IDENTITY_FIELDS.length ||
      Object.keys(entry).some((key) => !IDENTITY_FIELDS.includes(key)) ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      seen.has(entry.id) ||
      !['train', 'flight'].includes(entry.mode) ||
      !['number', 'travelDate', 'from', 'to'].every(
        (field) => typeof entry[field] === 'string',
      ) ||
      !['departure', 'arrival', 'groupId'].every(
        (field) => entry[field] === null || typeof entry[field] === 'string',
      ) ||
      !Number.isInteger(entry.revision) ||
      entry.revision < 0
    )
      return false;
    try {
      validateRecord(
        { ...entry, from: { name: entry.from }, to: { name: entry.to } },
        [],
        { allowDateMismatch: true },
      );
    } catch {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
}
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
function checkSet(
  trips,
  changedIds = new Set(trips.map((trip) => trip.id)),
  { allowDateMismatch = false } = {},
) {
  const ids = new Set(),
    keys = new Map();
  for (const trip of trips) {
    const changed = changedIds.has(trip.id),
      key = journeyKey(trip);
    if (changed) validateRecord(trip, [], { allowDateMismatch });
    if (
      ids.has(trip.id) ||
      (keys.has(key) && (changed || changedIds.has(keys.get(key))))
    )
      throw new Error(`行程 ${trip.number} 重复，请核对。`);
    ids.add(trip.id);
    if (!keys.has(key) || changed) keys.set(key, trip.id);
  }
  const intervals = trips
    .map((trip) => ({
      trip,
      start: parseTime(trip.departure),
      end: parseTime(trip.arrival),
    }))
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end))
    .sort((a, b) => a.start - b.start);
  let latest = null,
    latestChanged = null;
  for (const interval of intervals) {
    const changed = changedIds.has(interval.trip.id);
    const overlapping = changed ? latest : latestChanged;
    if (overlapping && overlapping.end > interval.start)
      throw new Error(`与 ${overlapping.trip.number} 的行程时间重叠。`);
    if (!latest || interval.end > latest.end) latest = interval;
    if (changed && (!latestChanged || interval.end > latestChanged.end))
      latestChanged = interval;
  }
}
function split(trip) {
  const base = { ...trip },
    route = {
      id: trip.id,
      data: extractRoute(trip),
      revision: trip.routeRevision,
      history: clone(trip.routeHistory || []),
    };
  for (const key of ROUTE_FIELDS)
    if (!['from', 'to', 'via'].includes(key)) delete base[key];
  delete base.routeHistory;
  return { base: clone(base), route };
}
function hydrate(base, route) {
  return measureStage('hydrate', () =>
    normalizeTrip({
      ...base,
      ...(route?.data || {}),
      revision: base.revision,
      routeRevision: route?.revision || 0,
      routeHistory: route?.history || [],
    }),
  );
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
    // Provenance belongs to the incoming geometry. Old history and providers
    // that omit these fields must not inherit another source's evidence.
    routeProvider: undefined,
    routeDataVersion: null,
    routeEvidence: null,
    routeSource: null,
    routeSourceUrl: null,
    routeNote: null,
    routeFetchedAt: null,
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
  const subscribers = new Set(),
    commitSubscribers = new Set();
  async function publish(change) {
    channel?.postMessage(change);
    await Promise.all([...commitSubscribers].map((fn) => fn(change)));
  }
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
    const changes = Object.fromEntries(STORES.map((name) => [name, new Set()]));
    const identityChanges = new Map();
    const stores = Object.fromEntries(
      STORES.map((name) => {
        const original = tx.objectStore(name);
        return [
          name,
          {
            get: (key) => original.get(key),
            getAll: () => original.getAll(),
            count: () => original.count(),
            put(value) {
              changes[name].add(value.id);
              if (name === 'trips')
                identityChanges.set(value.id, identityRecord(value));
              return original.put(value);
            },
            delete(key) {
              changes[name].add(key);
              if (name === 'trips') identityChanges.set(key, null);
              return original.delete(key);
            },
          },
        ];
      }),
    );
    stores.changes = changes;
    stores.identityChanges = identityChanges;
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
  async function persistIdentityIndex(stores, revision) {
    for (const [id, entry] of stores.identityChanges) {
      if (entry) stores.identityIndex.set(id, entry);
      else stores.identityIndex.delete(id);
    }
    await request(
      stores.meta.put({
        id: IDENTITY_INDEX_KEY,
        schemaVersion: 1,
        datasetRevision: revision,
        entries: [...stores.identityIndex.values()],
      }),
    );
  }
  async function rebuildIdentityIndex(stores, revision) {
    // Old v2 pages do not maintain this optional meta record. Their dataset
    // revision makes it stale; rebuild once inside the same write transaction.
    const bases = await request(stores.trips.getAll());
    stores.identityIndex = new Map(
      bases.map((trip) => [trip.id, identityRecord(trip)]),
    );
    await persistIdentityIndex(stores, revision);
    return stores.identityIndex;
  }
  async function identityIndex(stores, meta) {
    if (stores.identityIndex) return stores.identityIndex;
    meta ||= await request(stores.meta.get('dataset'));
    const [index, count] = await Promise.all([
      request(stores.meta.get(IDENTITY_INDEX_KEY)),
      request(stores.trips.count()),
    ]);
    if (!validIdentityIndex(index, meta.revision, count))
      return rebuildIdentityIndex(stores, meta.revision);
    stores.identityIndex = new Map(
      index.entries.map((entry) => [entry.id, entry]),
    );
    return stores.identityIndex;
  }
  async function indexedBases(stores, ids) {
    let index = await identityIndex(stores);
    const bases = new Map(
      await Promise.all(
        [...new Set(ids)].map(async (id) => [
          id,
          await request(stores.trips.get(id)),
        ]),
      ),
    );
    if (
      [...bases].some(
        ([id, base]) =>
          JSON.stringify(base ? identityRecord(base) : null) !==
          JSON.stringify(index.get(id) || null),
      )
    ) {
      const meta = await request(stores.meta.get('dataset'));
      index = await rebuildIdentityIndex(stores, meta.revision);
    }
    return { map: new Map(index), bases };
  }
  async function bump(stores) {
    const meta = await request(stores.meta.get('dataset'));
    meta.revision++;
    await request(stores.meta.put(meta));
    await persistIdentityIndex(stores, meta.revision);
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
              validateRecord(raw, [], { allowDateMismatch: true });
              trip = normalizeTrip(raw);
              if (
                valid.some(
                  (t) => t.id === trip.id || journeyKey(t) === journeyKey(trip),
                )
              )
                throw new Error('旧记录存在重复标识或旅程。');
              trip.revision = 1;
              trip.routeRevision = canRenderRoute(trip) ? 1 : 0;
              validateRecord(trip, [], { allowDateMismatch: true });
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
      await identityIndex(stores, meta);
    });
    if (broadcast && !channel && globalThis.BroadcastChannel) {
      channel = new BroadcastChannel(`${dbName}:changes`);
      channel.onmessage = (event) =>
        subscribers.forEach((fn) => fn(event.data));
      channel.unref?.();
    }
    return snapshot();
  }
  async function readSnapshot(stores) {
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
  }
  async function snapshot() {
    return run('readonly', readSnapshot);
  }
  // A change describes exactly one committed transaction. Any missing revision,
  // old sender, or subsequent commit requires a consistent complete snapshot.
  async function readChanges(change, expectedRevision) {
    return run('readonly', async (stores) => {
      const meta = await request(stores.meta.get('dataset'));
      if (
        !change ||
        change.full ||
        !Number.isInteger(change.fromRevision) ||
        change.fromRevision !== expectedRevision ||
        change.revision !== expectedRevision + 1 ||
        meta?.revision !== change.revision ||
        !Array.isArray(change.changedTripIds)
      )
        return readSnapshot(stores);
      const trips = [],
        removedTripIds = [];
      await Promise.all(
        change.changedTripIds.map(async (id) => {
          const [base, route] = await Promise.all([
            request(stores.trips.get(id)),
            request(stores.routes.get(id)),
          ]);
          if (base) trips.push(hydrate(base, route));
          else removedTripIds.push(id);
        }),
      );
      return {
        partial: true,
        trips: sorted(trips),
        removedTripIds,
        datasetRevision: meta.revision,
        ...(change.groupsChanged
          ? { groups: await request(stores.groups.getAll()) }
          : {}),
        ...(change.draftsChanged
          ? { drafts: await request(stores.drafts.getAll()) }
          : {}),
        kind: change.kind,
      };
    });
  }
  async function readTrips(ids) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
      throw new Error('行程标识列表无效。');
    return run('readonly', async (stores) => {
      const trips = await Promise.all(
        [...new Set(ids)].map(async (id) => {
          const [base, route] = await Promise.all([
            request(stores.trips.get(id)),
            request(stores.routes.get(id)),
          ]);
          return base ? hydrate(base, route) : null;
        }),
      );
      return sorted(trips.filter(Boolean));
    });
  }
  async function loadPreferences() {
    return run('readonly', async (stores) => {
      const preferences = await request(stores.meta.get('preferences'));
      return {
        railProvider:
          preferences?.railProvider === 'osm-local' ? 'osm-local' : 'railgo',
      };
    });
  }
  async function savePreferences(patch) {
    if (
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch) ||
      Object.keys(patch).some((key) => key !== 'railProvider') ||
      (patch.railProvider !== undefined &&
        !['railgo', 'osm-local'].includes(patch.railProvider))
    )
      throw new Error('线路来源设置无效。');
    const preferences = await run('readwrite', async (stores) => {
      const current = await request(stores.meta.get('preferences'));
      const value = {
        railProvider:
          patch.railProvider ||
          (current?.railProvider === 'osm-local' ? 'osm-local' : 'railgo'),
      };
      await request(stores.meta.put({ id: 'preferences', ...value }));
      return value;
    });
    await publish({ kind: 'preferences' });
    return preferences;
  }
  async function mutate(work, options) {
    const result = await run(
      'readwrite',
      async (stores) => {
        const meta = await writable(stores);
        await identityIndex(stores, meta);
        const value = await work(stores);
        const revision = value === false ? null : await bump(stores);
        const changes = stores.changes;
        return {
          value,
          revision,
          change: {
            fromRevision: meta.revision,
            revision,
            kind: options?.kind || 'records',
            changedTripIds: [...new Set([...changes.trips, ...changes.routes])],
            groupsChanged: changes.groups.size > 0,
            draftsChanged: changes.drafts.size > 0,
            full: changes.rescue.size > 0,
          },
        };
      },
      options,
    );
    if (result.revision !== null) await publish(result.change);
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
        const { map, bases } = await indexedBases(
            stores,
            prepared.map((trip) => trip.id),
          ),
          seen = new Set(),
          saved = [];
        for (const incoming of prepared) {
          if (seen.has(incoming.id)) throw new Error('本批记录包含重复标识。');
          seen.add(incoming.id);
          const base = bases.get(incoming.id);
          const current = base
            ? hydrate(base, await request(stores.routes.get(incoming.id)))
            : null;
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
        checkSet([...map.values()], seen);
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
      for (const entry of (await identityIndex(stores)).values())
        if (entry.groupId === id) {
          const trip = await request(stores.trips.get(entry.id));
          await request(
            stores.trips.put({
              ...trip,
              groupId: null,
              revision: trip.revision + 1,
            }),
          );
        }
      await request(stores.groups.delete(id));
      return true;
    });
  }
  async function assignGroup(records, groupId) {
    if (
      !Array.isArray(records) ||
      !records.length ||
      records.length > 10000 ||
      (groupId !== null && typeof groupId !== 'string')
    )
      throw new Error('分组修改无效。');
    return mutate(async (stores) => {
      if (groupId && !(await request(stores.groups.get(groupId))))
        throw new Error('旅程分组不存在，请重新选择。');
      const seen = new Set();
      for (const record of records) {
        if (typeof record?.id !== 'string' || seen.has(record.id))
          throw new Error('分组修改包含无效或重复记录。');
        seen.add(record.id);
        const current = await request(stores.trips.get(record.id));
        if (!current) throw conflict('行程已删除。');
        assertRevision(current, record.revision);
        await request(
          stores.trips.put({
            ...current,
            groupId: groupId || null,
            revision: current.revision + 1,
            updatedAt: new Date().toISOString(),
          }),
        );
      }
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
          validateRecord(resolved, [], { allowDateMismatch: true });
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
          route.routeProvider === 'osm-local' ||
          route.requiresConfirmation ||
          route.resolution?.requiresConfirmation ||
          route.resolution?.state === 'needs-confirmation' ||
          ['station-schematic', 'manual-schematic'].includes(resolved.quality),
        );
        const alreadyConfirmed =
          current.quality === resolved.quality &&
          current.routeConfirmed === true &&
          [
            'routeProvider',
            'routeDataVersion',
            'routeSource',
            'routeSourceUrl',
            'routeEvidence',
          ].every(
            (field) =>
              JSON.stringify(current[field] ?? null) ===
              JSON.stringify(resolved[field] ?? null),
          ) &&
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
        validateRecord(next, [], { allowDateMismatch: true });
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
      validateRecord(next, [], { allowDateMismatch: true });
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
      existingById = new Map(existing.trips.map((trip) => [trip.id, trip])),
      existingByJourney = new Map(
        existing.trips.map((trip) => [journeyKey(trip), trip]),
      ),
      seen = new Set(),
      entries = data.trips.map((raw, index) => {
        const key = String(index);
        try {
          validateRecord(raw, [], { allowDateMismatch: true });
          const incoming = normalizeTrip(raw);
          if (seen.has(incoming.id))
            throw new Error('备份中存在重复行程标识。');
          seen.add(incoming.id);
          const found =
            existingById.get(incoming.id) ||
            existingByJourney.get(journeyKey(incoming));
          return {
            key,
            kind: found
              ? content(found) === content(incoming)
                ? 'duplicate'
                : 'conflict'
              : 'new',
            incoming,
            existing: found || null,
            issues: incoming.issues.filter(
              (issue) => issue.code === 'date-mismatch',
            ),
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
    const drafts = [],
      extraIssues = [];
    const draftInputs = Array.isArray(data.drafts)
      ? data.drafts
      : data.drafts == null
        ? []
        : [data.drafts];
    const draftIds = new Set();
    for (const [index, raw] of draftInputs.entries()) {
      try {
        const draft = validateDraft(raw);
        if (draftIds.has(draft.id)) throw new Error('备份中草稿标识重复。');
        draftIds.add(draft.id);
        drafts.push(draft);
      } catch (error) {
        extraIssues.push({ kind: 'draft', index, message: error.message, raw });
      }
    }
    const recovery = extraIssues.length
      ? {
          ...(data.recovery || {}),
          items: [
            ...(data.recovery?.items || []),
            ...extraIssues.map((issue) => ({
              reason: issue.message,
              raw: issue.raw,
            })),
          ],
        }
      : data.recovery || null;
    return {
      format: 'travel-trace-restore-preview',
      datasetRevision: existing.datasetRevision,
      entries,
      groups: Array.isArray(data.groups) ? safeData(data.groups) : [],
      drafts,
      extraIssues,
      recovery,
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
      const selectedIds = preview.entries
        .filter(
          (entry) =>
            (selections[entry.key] ||
              (entry.kind === 'new' ? 'add' : 'skip')) !== 'skip',
        )
        .map((entry) => entry.existing?.id || entry.incoming?.id)
        .filter((id) => typeof id === 'string');
      const { map, bases } = await indexedBases(stores, selectedIds);
      const saved = [];
      for (const entry of preview.entries) {
        const action =
          selections[entry.key] || (entry.kind === 'new' ? 'add' : 'skip');
        if (action === 'skip') continue;
        if (!['add', 'replace'].includes(action) || entry.kind === 'invalid')
          throw new Error('恢复选择无效，请修正问题项。');
        validateRecord(entry.incoming, [], { allowDateMismatch: true });
        const incoming = normalizeTrip(safeData(entry.incoming)),
          base = entry.existing
            ? bases.get(entry.existing.id)
            : bases.get(incoming.id);
        const current = base
          ? hydrate(base, await request(stores.routes.get(base.id)))
          : null;
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
      checkSet([...map.values()], new Set(saved.map((trip) => trip.id)), {
        allowDateMismatch: true,
      });
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
        const draft = validateDraft(safeData(raw));
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
      await persistIdentityIndex(stores, meta.revision);
      return { saved: saved.length, revision: meta.revision };
    });
    await publish({ revision: result.revision, kind: 'records', full: true });
    return result;
  }
  return {
    init,
    snapshot,
    readChanges,
    readTrips,
    loadPreferences,
    savePreferences,
    saveTrips,
    deleteTrip,
    saveDraft,
    listDrafts,
    deleteDraft,
    saveGroup,
    deleteGroup,
    assignGroup,
    updateRoute,
    recordRouteAttempt,
    setRouteFrozen,
    restoreRoute,
    exportBackup,
    previewRestore,
    applyRestore,
    subscribeCommits(fn) {
      commitSubscribers.add(fn);
      return () => commitSubscribers.delete(fn);
    },
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
