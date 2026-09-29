import { coordinate, flightArc, localDateTime, parseTime } from './core.js';

export const sourceOf = (draft, key) => {
  const entry = draft.fieldSources?.[key];
  return typeof entry === 'string' ? entry : entry?.source;
};
export const isAutomatic = (draft, key) =>
  ['lookup', 'reference'].includes(sourceOf(draft, key));
const queryMetadata = [
  'airline',
  'status',
  'referenceStatus',
  'isReference',
  'referenceDate',
  'scheduleWarning',
  'scheduleProvenance',
  'queriedAt',
  'queryDate',
  'source',
];
function clearQueryMetadata(record) {
  for (const key of queryMetadata) delete record[key];
}
function discardAutomaticTimes(draft) {
  for (const key of ['departure', 'arrival'])
    if (isAutomatic(draft, key)) {
      delete draft[key];
      delete draft.fieldSources[key];
    }
}
const journeyIdentity = (record) =>
  JSON.stringify([
    record.mode,
    String(record.number || '')
      .trim()
      .toUpperCase(),
    record.date || record.travelDate || record.departure?.slice(0, 10),
    String(record.from?.name ?? record.from ?? '').trim(),
    String(record.to?.name ?? record.to ?? '').trim(),
  ]);
export function fieldSourceLabel(draft, key) {
  const source = sourceOf(draft, key),
    caption = {
      text: '原文',
      manual: '手动填写',
      lookup: '自动匹配',
      reference: '其他日期参考',
      legacy: '已有记录',
    }[source];
  const date = draft.fieldSources?.[key]?.referenceDate;
  return caption ? `${caption}${date ? ` · ${date}` : ''}` : '待补全';
}
export function initializeDraft(input, source = 'text') {
  const draft = structuredClone(input),
    fields = [
      'mode',
      'number',
      'date',
      'from',
      'to',
      'departure',
      'arrival',
      'via',
      'fromCoord',
      'toCoord',
    ];
  draft.fieldSources ||= {};
  for (const field of fields)
    if (draft[field] && !draft.fieldSources[field])
      draft.fieldSources[field] = { source };
  draft.travelDate = draft.date || draft.travelDate;
  return draft;
}
export function updateDraftField(input, key, value) {
  const draft = initializeDraft(input),
    old = draft[key];
  draft[key] = key === 'number' ? String(value).toUpperCase().trim() : value;
  draft.fieldSources[key] = { source: 'manual' };
  if (old === draft[key]) return draft;
  draft.routeConfirmed = false;
  if (key === 'date') {
    draft.travelDate = value;
    const delta = parseTime(`${value}T00:00`) - parseTime(`${old}T00:00`);
    for (const field of ['departure', 'arrival']) {
      if (isAutomatic(draft, field)) delete draft[field];
      else if (
        Number.isFinite(delta) &&
        Number.isFinite(parseTime(draft[field]))
      )
        draft[field] = localDateTime(parseTime(draft[field]) + delta);
    }
  }
  if (['mode', 'number', 'date', 'from', 'to'].includes(key)) {
    clearQueryMetadata(draft);
    delete draft.queryDate;
    delete draft.fromStopIndex;
    delete draft.toStopIndex;
    discardAutomaticTimes(draft);
  }
  if (['from', 'to', 'mode'].includes(key)) {
    for (const field of key === 'mode'
      ? ['fromCoord', 'toCoord']
      : [`${key}Coord`])
      delete draft[field];
  }
  return draft;
}
export function chooseCandidate(row, candidate) {
  const next = initializeDraft(candidate.draft);
  for (const endpoint of ['from', 'to'])
    if (next[endpoint] !== row.draft[endpoint]) {
      delete next[`${endpoint}Coord`];
      delete next.fieldSources[`${endpoint}Coord`];
    }
  for (const key of ['departure', 'arrival'])
    if (['manual', 'text', 'legacy'].includes(sourceOf(row.draft, key))) {
      next[key] = row.draft[key];
      next.fieldSources[key] = structuredClone(row.draft.fieldSources[key]);
    }
  next.routeConfirmed = false;
  return {
    ...row,
    draft: next,
    lookup: candidate.lookup,
    candidates: [],
    route: null,
    routeKey: null,
    routeConfirmed: false,
    referenceAccepted: false,
    reviewed: false,
    error: '',
    needsResolve: false,
    warnings: [
      ...new Set([
        ...(row.warnings || []).filter(
          (w) => !/多个|航段与填写|请仅补充/.test(w),
        ),
        ...(candidate.warnings || []),
        ...(candidate.lookup?.isReference && candidate.lookup.note
          ? [candidate.lookup.note]
          : []),
      ]),
    ],
  };
}
export const missingFields = (draft) =>
  ['number', 'date', 'from', 'to', 'departure', 'arrival'].filter(
    (key) => !draft?.[key],
  );
export const needsRouteConfirmation = (route) =>
  Boolean(
    route?.requiresConfirmation ||
    route?.resolution?.state === 'needs-confirmation',
  );
export const hasReferenceFields = (draft, lookup) =>
  Boolean(
    draft?.isReference ||
    lookup?.isReference ||
    Object.entries(draft?.fieldSources || {}).some(
      ([key, entry]) =>
        Boolean(draft[key]) &&
        (typeof entry === 'string' ? entry : entry?.source) === 'reference',
    ),
  );
export function rowNeedsReview(row) {
  return Boolean(
    !row.reviewed &&
    (row.error ||
      row.candidates?.length ||
      row.warnings?.length ||
      missingFields(row.draft).length ||
      row.route?.resolution?.state === 'unavailable' ||
      (hasReferenceFields(row.draft, row.lookup) && !row.referenceAccepted) ||
      (needsRouteConfirmation(row.route) && !row.routeConfirmed)),
  );
}
export function clearAutomaticTimes(input) {
  const draft = initializeDraft(input);
  discardAutomaticTimes(draft);
  return draft;
}

export function draftFromTrip(trip) {
  return initializeDraft(
    {
      ...trip,
      date: trip.travelDate || trip.departure?.slice(0, 10) || trip.queryDate,
      from: trip.from?.name || '',
      to: trip.to?.name || '',
      fromCoord: trip.from?.coord?.join(',') || '',
      toCoord: trip.to?.coord?.join(',') || '',
      via:
        trip.via ||
        trip.stops
          ?.slice(1, -1)
          .map((s) => s.name)
          .join('、') ||
        '',
    },
    'legacy',
  );
}

export const editorFields = [
  ['mode', '交通方式'],
  ['number', '车次 / 航班号'],
  ['date', '实际出行日期'],
  ['from', '起点'],
  ['to', '终点'],
  ['via', '途经站'],
  ['fromCoord', '起点坐标'],
  ['toCoord', '终点坐标'],
  ['departure', '出发时间'],
  ['arrival', '到达时间'],
];
const fieldValue = (draft, key) => String(draft?.[key] ?? '').trim();
const routeIdentity = (draft) =>
  JSON.stringify(
    editorFields
      .map(([key]) => key)
      .filter((key) => !['departure', 'arrival'].includes(key))
      .map((key) => fieldValue(draft, key)),
  );

export function editorConflictDifferences(row, current) {
  const latest = current ? draftFromTrip(current) : null;
  return editorFields
    .filter(
      ([key]) =>
        !latest || fieldValue(row.draft, key) !== fieldValue(latest, key),
    )
    .map(([key, label]) => ({
      key,
      label,
      draft: fieldValue(row.draft, key),
      current: latest ? fieldValue(latest, key) : '已删除',
    }));
}

// Only the user's changes are reapplied; concurrent route updates keep their geometry.
export function rebaseEditorRow(row, base, current) {
  if (!current)
    throw Object.assign(
      new Error('原行程已删除，草稿已保留，不能覆盖或自动重建。'),
      { code: 'CONFLICT' },
    );
  if (!base || base.id !== current.id || row.draft.id !== current.id)
    throw new Error('缺少原始编辑版本，不能合并；请采用数据库版本后重新编辑。');
  const baseline = draftFromTrip(base),
    latest = draftFromTrip(current),
    changed = editorFields
      .map(([key]) => key)
      .filter(
        (key) =>
          fieldValue(row.draft, key) !== fieldValue(baseline, key) ||
          (sourceOf(row.draft, key) === 'manual' &&
            sourceOf(baseline, key) !== 'manual'),
      );
  let draft = latest;
  for (const key of changed) {
    draft = updateDraftField(draft, key, row.draft[key] || '');
    if (row.draft.fieldSources?.[key])
      draft.fieldSources[key] = structuredClone(row.draft.fieldSources[key]);
  }
  const sameLookupIdentity =
      journeyIdentity(draft) === journeyIdentity(row.draft),
    lookup = sameLookupIdentity ? structuredClone(row.lookup || null) : null;
  if (!sameLookupIdentity)
    for (const key of ['departure', 'arrival'])
      if (changed.includes(key) && isAutomatic(row.draft, key)) {
        delete draft[key];
        delete draft.fieldSources[key];
      }
  const reuseRoute = routeIdentity(draft) === routeIdentity(latest),
    route = reuseRoute
      ? structuredClone(
          current.routeState === 'ready'
            ? current
            : current.routeCandidate || null,
        )
      : null;
  return {
    ...row,
    draft,
    lookup,
    candidates: [],
    conflict: null,
    route,
    routeKey: null,
    routeConfirmed:
      reuseRoute &&
      current.routeState === 'ready' &&
      current.routeConfirmed !== false,
    referenceAccepted: hasReferenceFields(draft, lookup)
      ? sameLookupIdentity
        ? Boolean(row.referenceAccepted)
        : current.referenceAccepted === true
      : true,
    needsResolve: !reuseRoute,
    error: '',
    warnings: [],
    message: reuseRoute
      ? '已合并本次修改；其他字段及路线采用数据库最新版本。'
      : '已合并本次修改；起止或线路信息有变化，旧路线已清除，可先保存为待补全。',
  };
}

export function tripFromDraft(
  input,
  lookup,
  route,
  { original, routeConfirmed = false, referenceAccepted = false, groupId } = {},
) {
  const draft = initializeDraft(input),
    from = String(draft.from || '').trim(),
    to = String(draft.to || '').trim();
  const identityChanged =
    original && journeyIdentity(draft) !== journeyIdentity(original);
  const previous = { ...(original || {}) };
  if (identityChanged) {
    clearQueryMetadata(previous);
    if (!lookup) {
      clearQueryMetadata(draft);
      discardAutomaticTimes(draft);
    }
  }
  const routeReady =
    route &&
    route.routeState !== 'pending' &&
    route.quality !== 'pending' &&
    route.resolution?.state !== 'unavailable' &&
    (!needsRouteConfirmation(route) || routeConfirmed);
  const place = (key, name) => {
    const found = route?.[key]?.name
      ? route[key]
      : original?.[key]?.name === name
        ? original[key]
        : { name, coord: null };
    return {
      ...found,
      name: found.name || name,
      coord: draft[`${key}Coord`]
        ? coordinate(draft[`${key}Coord`])
        : found.coord || null,
    };
  };
  const fromPlace = place('from', from),
    toPlace = place('to', to);
  const effective = routeReady ? structuredClone(route) : {};
  const fieldSources = structuredClone(draft.fieldSources),
    reference = hasReferenceFields(draft, lookup);
  let source = previous.source || '手动填写';
  if (lookup)
    source = lookup.isReference
      ? `${draft.mode === 'train' ? '12306' : '航旅纵横'} · ${lookup.referenceDate} 参考`
      : draft.mode === 'train'
        ? '12306'
        : '航旅纵横';
  if (['departure', 'arrival'].some((key) => sourceOf(draft, key) === 'manual'))
    source =
      source === '手动填写' || source.startsWith('手动调整')
        ? source
        : `手动调整 · ${source}`;
  const trip = {
    ...previous,
    ...effective,
    id: draft.id || crypto.randomUUID(),
    revision: original?.revision ?? draft.revision ?? 0,
    mode: draft.mode,
    number: String(draft.number || '')
      .toUpperCase()
      .trim(),
    travelDate: draft.date,
    queryDate:
      draft.queryDate || lookup?.queryDate || lookup?.date || draft.date,
    from: fromPlace,
    to: toPlace,
    departure: draft.departure || null,
    arrival: draft.arrival || null,
    groupId: groupId || draft.groupId || original?.groupId || null,
    fieldSources,
    source,
    via: effective.via ?? draft.via ?? '',
    fromStopIndex: draft.fromStopIndex,
    toStopIndex: draft.toStopIndex,
    routeState: routeReady ? 'ready' : 'pending',
    routeConfirmed:
      routeReady && (!needsRouteConfirmation(route) || routeConfirmed),
    routeRevision: original?.routeRevision || 0,
    routeFrozen: original?.routeFrozen || false,
    routeHistory: structuredClone(original?.routeHistory || []),
    stops: effective.stops || [fromPlace, toPlace],
    legs: effective.legs || [],
    routeCoordinates: effective.routeCoordinates || [],
    distance: effective.distance ?? null,
    quality: effective.quality || 'pending',
    routeTiming: effective.routeTiming || 'continuous',
    resolution: route?.resolution || {
      state: 'unavailable',
      reason: '路线尚未匹配，可稍后补全。',
    },
    routeCandidate: !routeReady && route ? structuredClone(route) : null,
    isReference: reference,
    referenceDate: lookup?.referenceDate || draft.referenceDate || null,
    referenceAccepted: reference ? Boolean(referenceAccepted) : true,
    scheduleWarning: lookup?.note || draft.scheduleWarning || null,
    queriedAt: lookup?.fetchedAt || null,
    issues: [
      ...(route?.issues || route?.resolution?.issues || []),
      ...(routeReady
        ? []
        : [
            {
              code: needsRouteConfirmation(route)
                ? 'ROUTE_CONFIRMATION_REQUIRED'
                : 'ROUTE_UNAVAILABLE',
              message: needsRouteConfirmation(route)
                ? '停站连线示意尚未确认，可稍后接受或补全真实路线。'
                : '路线待补全。',
            },
          ]),
    ],
  };
  const selected = lookup?.selected;
  if (draft.mode === 'flight' && selected) {
    trip.airline = selected.airline;
    trip.status = lookup.isReference ? '时刻参考' : selected.status;
    trip.referenceStatus = lookup.isReference ? selected.status : undefined;
  }
  if (draft.mode === 'train' && lookup?.stops) {
    const a =
        draft.fromStopIndex ?? lookup.stops.findIndex((s) => s.name === from),
      b = draft.toStopIndex ?? lookup.stops.findIndex((s) => s.name === to),
      schedule = lookup.stops.slice(a, b + 1);
    if (
      a >= 0 &&
      b > a &&
      schedule[0]?.departure === draft.departure &&
      schedule.at(-1)?.arrival === draft.arrival &&
      schedule.length === trip.stops.length &&
      schedule.every((s, i) => s.name === trip.stops[i].name)
    )
      trip.stops = trip.stops.map((s, i) => ({
        ...s,
        arrival: schedule[i].arrival,
        departure: schedule[i].departure,
      }));
  }
  return trip;
}

export function routePreviewMarkup(route, mode) {
  let coordinates = route?.routeCoordinates || [];
  if (mode === 'flight' && route?.from?.coord && route?.to?.coord)
    coordinates = flightArc(route.from.coord, route.to.coord, 40);
  if (!coordinates.length)
    coordinates = (route?.legs || []).flatMap((leg) => leg.coordinates || []);
  const points = coordinates
    .filter(
      (point, i) =>
        i % Math.max(1, Math.floor(coordinates.length / 600)) === 0 ||
        i === coordinates.length - 1,
    )
    .filter(
      (point) => Number.isFinite(point?.[0]) && Number.isFinite(point?.[1]),
    );
  if (points.length < 2) return '';
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(x, minX);
    minY = Math.min(y, minY);
    maxX = Math.max(x, maxX);
    maxY = Math.max(y, maxY);
  }
  const middle = (minY + maxY) / 2,
    cos = Math.cos((middle * Math.PI) / 180),
    width = Math.max((maxX - minX) * cos, 0.0001),
    height = Math.max(maxY - minY, 0.0001),
    scale = Math.min(292 / width, 104 / height);
  const mapped = points.map(([x, y]) => [
    160 + (x - (minX + maxX) / 2) * cos * scale,
    64 - (y - middle) * scale,
  ]);
  return `<svg class="route-preview" viewBox="0 0 320 128" role="img" aria-label="候选线路形状预览"><rect width="320" height="128" rx="12" fill="#f1f8ff"/><polyline points="${mapped.map((point) => point.map((n) => n.toFixed(2)).join(',')).join(' ')}" fill="none" stroke="#399aca" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${mapped[0][0]}" cy="${mapped[0][1]}" r="5" fill="#fff" stroke="#399aca" stroke-width="2"/><circle cx="${mapped.at(-1)[0]}" cy="${mapped.at(-1)[1]}" r="5" fill="#399aca"/></svg>`;
}
