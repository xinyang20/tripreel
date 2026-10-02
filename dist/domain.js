import { coordinate, parseTime } from './core.js';
import { measureStage } from './performance.js';

export const ROUTE_FIELDS = [
  'from',
  'to',
  'stops',
  'legs',
  'routeCoordinates',
  'routePolicy',
  'routeTiming',
  'quality',
  'distance',
  'routeSource',
  'routeSourceUrl',
  'routeNote',
  'routeFetchedAt',
  'routeProvider',
  'routeDataVersion',
  'routeEvidence',
  'via',
  'routeInputs',
  'requiresConfirmation',
  'resolution',
  'warningDetails',
];
const derivedCodes = new Set([
  'missing-time',
  'missing-coordinates',
  'missing-route',
  'route-unconfirmed',
  'reference-schedule',
  'reference-unconfirmed',
  'schematic-route',
  'corridor-route',
  'frozen-route',
  'date-mismatch',
]);
export const actualTravelDate = (trip) =>
  (typeof trip?.travelDate === 'string' && trip.travelDate) ||
  (typeof trip?.departure === 'string' && trip.departure.slice(0, 10)) ||
  (typeof trip?.date === 'string' && trip.date) ||
  '';
export const journeyPlaceName = (value) =>
  String(value?.name || value || '')
    .trim()
    .replace(/(?:国际机场|机场|火车站|高铁站|站)$/, '');
export const hasDateMismatch = (trip) =>
  Boolean(
    (trip.travelDate || trip.date) &&
    typeof trip.departure === 'string' &&
    actualTravelDate(trip) !== trip.departure.slice(0, 10),
  );
const point = (p) => {
  try {
    return Array.isArray(p) && Boolean(coordinate(p));
  } catch {
    return false;
  }
};
const immutableValues = new WeakSet();
const lineResults = new WeakMap();
const derivedResults = new WeakMap();
const metadataResults = new WeakMap();
const replayResults = new WeakMap();
const issueResults = new WeakMap();
export const isReadOnlyTrip = (trip) => immutableValues.has(trip);
// Only values frozen recursively by this boundary may reuse validation results.
// Editable drafts and caller-owned objects always retain fresh validation.
export function prepareReadOnlyTrip(trip) {
  const freeze = (value) => {
    if (!value || typeof value !== 'object' || immutableValues.has(value))
      return value;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
    immutableValues.add(value);
    return value;
  };
  return freeze(trip);
}
function line(points) {
  if (!Array.isArray(points)) return false;
  if (immutableValues.has(points) && lineResults.has(points))
    return lineResults.get(points);
  const valid =
    points.length >= 2 && points.length <= 150000 && points.every(point);
  if (immutableValues.has(points)) lineResults.set(points, valid);
  return valid;
}
export function tripMetadata(trip) {
  if (immutableValues.has(trip) && metadataResults.has(trip))
    return metadataResults.get(trip);
  const departure = parseTime(trip.departure);
  const value = Object.freeze({
    date: actualTravelDate(trip),
    sortTime: Number.isFinite(departure)
      ? departure
      : parseTime(actualTravelDate(trip) + 'T00:00'),
    search: [trip.number, trip.from?.name, trip.to?.name].map((item) =>
      String(item || '').toLocaleLowerCase(),
    ),
  });
  Object.freeze(value.search);
  if (immutableValues.has(trip)) metadataResults.set(trip, value);
  return value;
}
export function tripSummary(trip) {
  if (immutableValues.has(trip) && derivedResults.has(trip))
    return derivedResults.get(trip);
  const value = Object.freeze({
    ...tripMetadata(trip),
    renderable: canRenderRoute(trip),
    playable: canReplay(trip),
  });
  if (immutableValues.has(trip)) derivedResults.set(trip, value);
  return value;
}
export const validDate = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(parseTime(value + 'T00:00'));
const isOsmReference = (trip) =>
  trip.quality === 'corridor' &&
  /^OpenStreetMap(?:\s|·|$)/.test(trip.routeSource || '');
export function routeLabel(trip) {
  if (trip.routeCandidate && !canRenderRoute(trip)) return '路线待确认';
  if (trip.routeState === 'ready' && trip.routeConfirmed === false)
    return '路线待确认';
  if (!canRenderRoute(trip)) return '路线待补全';
  if (isOsmReference(trip)) return 'OSM 线路参考';
  return (
    {
      latest: '最新车次线路',
      corridor: '同线区间参考',
      'station-schematic': '停站连线示意',
      'manual-schematic': '手动途经点示意',
      schematic: '飞行示意弧线',
      partial: '部分线路待补全',
    }[trip.quality] || '线路参考'
  );
}
export function canRenderRoute(trip) {
  if (!point(trip?.from?.coord) || !point(trip?.to?.coord)) return false;
  if (trip.routeState === 'pending') return false;
  if (
    (['station-schematic', 'manual-schematic'].includes(trip.quality) ||
      trip.requiresConfirmation ||
      trip.resolution?.requiresConfirmation ||
      trip.routeProvider === 'osm-local') &&
    trip.routeConfirmed !== true
  )
    return false;
  if (trip.mode === 'flight') return true;
  return (
    line(trip.routeCoordinates) ||
    (Array.isArray(trip.legs) &&
      trip.legs.length > 0 &&
      trip.legs.every((leg) => line(leg.coordinates)))
  );
}
export function canReplay(trip) {
  if (immutableValues.has(trip) && replayResults.has(trip))
    return replayResults.get(trip);
  const result =
    canRenderRoute(trip) &&
    trip.routeConfirmed !== false &&
    trip.referenceAccepted !== false &&
    !hasDateMismatch(trip) &&
    Number.isFinite(parseTime(trip.departure)) &&
    Number.isFinite(parseTime(trip.arrival)) &&
    parseTime(trip.arrival) > parseTime(trip.departure);
  if (immutableValues.has(trip)) replayResults.set(trip, result);
  return result;
}
export function routeQualityRank(trip) {
  if (!canRenderRoute({ ...trip, routeState: undefined, routeConfirmed: true }))
    return 0;
  return (
    {
      pending: 0,
      partial: 0,
      'manual-schematic': 1,
      'station-schematic': 2,
      schematic: 2,
      corridor: 3,
      latest: 4,
    }[trip.quality] ?? 3
  );
}
export function tripIssues(trip) {
  if (immutableValues.has(trip) && issueResults.has(trip))
    return issueResults.get(trip);
  const issues = (Array.isArray(trip.issues) ? trip.issues : [])
    .filter(
      (i) =>
        i &&
        typeof i.code === 'string' &&
        typeof i.message === 'string' &&
        !derivedCodes.has(i.code) &&
        !i.derived,
    )
    .map((i) => ({
      ...i,
      severity: ['error', 'warning', 'info'].includes(i.severity)
        ? i.severity
        : 'warning',
    }));
  const add = (code, message, field, severity = 'warning') =>
    issues.push({ code, message, field, severity, derived: true });
  if (hasDateMismatch(trip))
    add(
      'date-mismatch',
      '实际出行日期与出发时刻日期不一致，请编辑核对；原值已保留，暂不能回放。',
      'date',
      'error',
    );
  if (!trip.departure || !trip.arrival)
    add('missing-time', '时刻待补全，暂不能回放。', 'time');
  if (!point(trip.from?.coord) || !point(trip.to?.coord))
    add('missing-coordinates', '地点坐标待匹配。', 'route');
  if (!canRenderRoute({ ...trip, routeConfirmed: true }))
    add('missing-route', '线路待补全，记录已保留。', 'route');
  if (
    trip.routeCandidate ||
    (trip.routeConfirmed === false && trip.routeState === 'ready')
  )
    add(
      'route-unconfirmed',
      canRenderRoute(trip)
        ? '发现新的示意线路待确认，当前保留已确认线路。'
        : '路线尚待确认，暂不能回放。',
      'route',
    );
  if (trip.isReference)
    add(
      'reference-schedule',
      trip.scheduleWarning ||
        `${trip.referenceDate || '其他日期'} 的时刻参考，请核对实际票面。`,
      'time',
    );
  if (trip.referenceAccepted === false)
    add('reference-unconfirmed', '参考时刻尚待确认，暂不能回放。', 'time');
  if (trip.quality === 'station-schematic')
    add('schematic-route', '停站连线示意，不代表真实铁轨。', 'route');
  if (trip.quality === 'manual-schematic')
    add('schematic-route', '手动途经点连线示意，不代表真实铁轨。', 'route');
  if (trip.quality === 'corridor')
    add(
      'corridor-route',
      isOsmReference(trip)
        ? 'OSM 线路参考，不代表乘车当日真实轨迹。'
        : '使用已核对的同线区间作为参考。',
      'route',
    );
  if (trip.routeFrozen)
    add('frozen-route', '当前线路已冻结，不自动更新。', 'route', 'info');
  for (const warning of trip.warningDetails || [])
    if (
      warning &&
      typeof warning.code === 'string' &&
      typeof warning.message === 'string'
    )
      issues.push({ ...warning, severity: 'warning', derived: true });
  for (const [index, warning] of (Array.isArray(trip.warnings)
    ? trip.warnings
    : []
  ).entries())
    if (typeof warning === 'string' && warning)
      add(`source-warning-${index}`, warning, 'source');
  if (trip.routeNote) add('route-note', trip.routeNote, 'route');
  const result = [...new Map(issues.map((i) => [i.code, i])).values()];
  if (immutableValues.has(trip)) {
    prepareReadOnlyTrip(result);
    issueResults.set(trip, result);
  }
  return result;
}
export function normalizeTrip(input) {
  return measureStage('normalize', () => normalizeTripValue(input));
}
function normalizeTripValue(input) {
  const trip = structuredClone(input);
  trip.id ||= crypto.randomUUID();
  trip.number = String(trip.number || '')
    .trim()
    .toUpperCase();
  trip.travelDate ||= actualTravelDate(trip);
  trip.groupId ??= null;
  trip.revision =
    Number.isInteger(trip.revision) && trip.revision >= 0 ? trip.revision : 0;
  trip.routeRevision =
    Number.isInteger(trip.routeRevision) && trip.routeRevision >= 0
      ? trip.routeRevision
      : 0;
  for (const field of ['from', 'to'])
    trip[field] =
      typeof trip[field] === 'string'
        ? { name: trip[field], coord: null }
        : {
            ...(trip[field] || {}),
            name: String(trip[field]?.name || '').trim(),
            coord: trip[field]?.coord || null,
          };
  trip.stops = Array.isArray(trip.stops) ? trip.stops : [];
  trip.legs = Array.isArray(trip.legs) ? trip.legs : [];
  trip.fieldSources =
    trip.fieldSources &&
    typeof trip.fieldSources === 'object' &&
    !Array.isArray(trip.fieldSources)
      ? trip.fieldSources
      : {};
  trip.routeHistory = Array.isArray(trip.routeHistory)
    ? trip.routeHistory.slice(0, 3)
    : [];
  trip.routeFrozen = Boolean(trip.routeFrozen);
  trip.routeState =
    trip.routeState !== 'pending' &&
    canRenderRoute({ ...trip, routeState: undefined, routeConfirmed: true })
      ? 'ready'
      : 'pending';
  trip.routeConfirmed =
    trip.routeState === 'ready' &&
    (trip.routeConfirmed ??
      !(
        trip.requiresConfirmation ||
        trip.resolution?.requiresConfirmation ||
        trip.routeProvider === 'osm-local'
      ));
  trip.distance ??= null;
  trip.issues = tripIssues(trip);
  return trip;
}
export function validateRecord(
  trip,
  others = [],
  { allowDateMismatch = false } = {},
) {
  if (!trip || typeof trip !== 'object' || Array.isArray(trip))
    throw new Error('行程结构无效。');
  if (!['train', 'flight'].includes(trip.mode))
    throw new Error('请选择火车或飞机。');
  if (!/^[A-Z0-9]{1,10}$/i.test(trip.number || ''))
    throw new Error('请填写有效车次或航班号。');
  if (
    (trip.travelDate != null && typeof trip.travelDate !== 'string') ||
    (trip.date != null && typeof trip.date !== 'string')
  )
    throw new Error('请填写有效出行日期。');
  if (!validDate(actualTravelDate(trip)))
    throw new Error('请填写有效出行日期。');
  for (const field of ['from', 'to']) {
    if (
      typeof trip[field]?.name !== 'string' ||
      !trip[field].name.trim() ||
      trip[field].name.length > 200
    )
      throw new Error('请填写起止地点。');
    if (trip[field].coord != null && !point(trip[field].coord))
      throw new Error('起止坐标无效，请重新匹配。');
  }
  if (trip.from.name === trip.to.name) throw new Error('起点和终点不能相同。');
  for (const field of ['departure', 'arrival'])
    if (trip[field] && !Number.isFinite(parseTime(trip[field])))
      throw new Error('已填写的时刻无效，请修改或留空待补全。');
  if (!allowDateMismatch && hasDateMismatch(trip))
    throw Object.assign(
      new Error('实际出行日期与出发时刻日期不一致，请核对这两个字段。'),
      {
        code: 'DATE_MISMATCH',
        fields: ['date', 'departure'],
      },
    );
  const begin = parseTime(trip.departure),
    end = parseTime(trip.arrival);
  if (Number.isFinite(begin) && Number.isFinite(end)) {
    if (end <= begin) throw new Error('到达时间必须晚于出发时间。');
    if (end - begin > 7 * 86400000) throw new Error('单段行程不能超过 7 天。');
    for (const other of others)
      if (
        other.id !== trip.id &&
        begin < parseTime(other.arrival) &&
        end > parseTime(other.departure)
      )
        throw new Error(`与 ${other.number} 的行程时间重叠。`);
  }
  if (trip.id && (typeof trip.id !== 'string' || trip.id.length > 200))
    throw new Error('行程标识无效。');
  for (const field of ['revision', 'routeRevision'])
    if (
      trip[field] != null &&
      (!Number.isInteger(trip[field]) || trip[field] < 0)
    )
      throw new Error('记录版本无效。');
  if (trip.groupId != null && typeof trip.groupId !== 'string')
    throw new Error('分组标识无效。');
  if (
    trip.distance != null &&
    (!Number.isFinite(trip.distance) || trip.distance < 0)
  )
    throw new Error('线路距离无效。');
  if (
    trip.routeCoordinates != null &&
    (!Array.isArray(trip.routeCoordinates) ||
      (trip.routeCoordinates.length && !line(trip.routeCoordinates)))
  )
    throw new Error('线路坐标结构无效。');
  if (
    trip.stops != null &&
    (!Array.isArray(trip.stops) || trip.stops.length > 1000)
  )
    throw new Error('停站结构无效。');
  for (const stop of trip.stops || [])
    if (
      !stop ||
      typeof stop.name !== 'string' ||
      (stop.coord != null && !point(stop.coord)) ||
      (stop.routeCoord != null && !point(stop.routeCoord))
    )
      throw new Error('停站坐标或名称无效。');
  if (
    trip.legs != null &&
    (!Array.isArray(trip.legs) || trip.legs.length > 1000)
  )
    throw new Error('路段结构无效。');
  for (const leg of trip.legs || [])
    if (!leg || (leg.coordinates != null && !line(leg.coordinates)))
      throw new Error('路段坐标结构无效。');
  if (trip.routeHistory != null) {
    if (!Array.isArray(trip.routeHistory) || trip.routeHistory.length > 3)
      throw new Error('历史线路结构无效。');
    const versions = new Set();
    for (const historical of trip.routeHistory) {
      if (
        !historical ||
        typeof historical.id !== 'string' ||
        versions.has(historical.id)
      )
        throw new Error('历史线路标识无效。');
      versions.add(historical.id);
      validateRecord(
        {
          ...trip,
          ...historical,
          id: trip.id,
          mode: trip.mode,
          number: trip.number,
          routeHistory: [],
        },
        [],
        { allowDateMismatch },
      );
    }
  }
  if (trip.routeCandidate != null) {
    const candidate = trip.routeCandidate;
    if (
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      candidate.routeCandidate != null
    )
      throw new Error('候选线路结构无效。');
    validateRecord(
      {
        ...trip,
        ...candidate,
        id: trip.id,
        mode: trip.mode,
        number: trip.number,
        routeHistory: [],
        routeCandidate: null,
      },
      [],
      { allowDateMismatch },
    );
  }
  return trip;
}
export function journeyKey(trip) {
  return JSON.stringify([
    trip.mode,
    String(trip.number).trim().toUpperCase(),
    actualTravelDate(trip),
    journeyPlaceName(trip.from),
    journeyPlaceName(trip.to),
  ]);
}
export function routeInputs(trip) {
  return JSON.stringify([
    trip.mode,
    trip.number,
    trip.queryDate || trip.travelDate,
    trip.from?.name,
    trip.to?.name,
    trip.via || '',
    trip.from?.coord,
    trip.to?.coord,
  ]);
}
export function extractRoute(trip) {
  return Object.fromEntries(
    ROUTE_FIELDS.filter((key) => trip[key] !== undefined).map((key) => [
      key,
      structuredClone(trip[key]),
    ]),
  );
}
