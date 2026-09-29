import { addDays, chinaToday, localDateTime, parseTime } from './core.js';
import { initializeDraft, isAutomatic } from './editor-draft.js';
import { abortError, isAbort } from './editor-session.js';

const airportKey = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/国际|机场|\s+/g, '');
const stationKey = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/(?:火车站|高铁站|站)$/, '');
const airportAliases = new Map([['沈阳仙桃', '沈阳桃仙']]);

function normalizePlace(value, mode, places, warnings) {
  let name = String(value || '').trim();
  if (!name) return '';
  const key = mode === 'flight' ? airportKey : stationKey;
  if (mode === 'flight' && airportAliases.has(key(name))) {
    const corrected = airportAliases.get(key(name));
    warnings.push(`“${name}”已按常见笔误识别为“${corrected}”，请确认。`);
    name = corrected;
  }
  const normalized = key(name);
  const matches = places.filter((p) =>
    [p.name, p.code, ...(mode === 'flight' ? [p.icao, p.english] : [])]
      .filter(Boolean)
      .some((v) => key(v) === normalized),
  );
  if (matches.length === 1) return matches[0].name;
  if (matches.length > 1)
    warnings.push(
      `“${name}”匹配到多个${mode === 'flight' ? '机场' : '车站'}，请从确认表中选择具体地点。`,
    );
  return mode === 'train' ? stationKey(name) : name;
}

function samePlace(input, place, mode, places) {
  if (!input) return true;
  const key = mode === 'flight' ? airportKey : stationKey;
  const normalized = normalizePlace(input, mode, places, []);
  return [place?.name, place?.code, place?.icao, place?.english]
    .filter(Boolean)
    .some(
      (value) => key(value) === key(normalized) || key(value) === key(input),
    );
}

function applyTimes(draft, departure, arrival, warnings, lookup) {
  for (const [field, value, caption] of [
    ['departure', departure, '出发'],
    ['arrival', arrival, '到达'],
  ]) {
    if (!Number.isFinite(parseTime(value))) continue;
    if (!draft[field] || isAutomatic(draft, field)) {
      draft[field] = value;
      draft.fieldSources[field] = {
        source: lookup?.isReference ? 'reference' : 'lookup',
        sourceName: lookup?.source,
        ...(lookup?.isReference ? { referenceDate: lookup.referenceDate } : {}),
      };
    } else if (parseTime(draft[field]) !== parseTime(value))
      warnings.push(
        `已保留你填写的${caption}时间；查询的计划时刻为 ${value.replace('T', ' ')}，请核对。`,
      );
  }
}

function finish(result) {
  const { draft, warnings } = result;
  if (result.lookup) {
    draft.isReference = Boolean(result.lookup.isReference);
    draft.referenceDate = result.lookup.referenceDate || null;
    draft.scheduleWarning = result.lookup.isReference
      ? result.lookup.note
      : null;
  }
  if (!result.candidates?.length) {
    const missing = [
      ['from', '起点'],
      ['to', '终点'],
      ['departure', '出发时间'],
      ['arrival', '到达时间'],
    ]
      .filter(([key]) => !draft[key])
      .map(([, text]) => text);
    if (missing.length)
      warnings.push(
        `已保留识别的信息，待补全：${missing.join('、')}；可先保存，稍后补充。`,
      );
  }
  if (draft.departure && !Number.isFinite(parseTime(draft.departure)))
    warnings.push('出发时间格式不正确，请在确认表中修改。');
  if (draft.arrival && !Number.isFinite(parseTime(draft.arrival)))
    warnings.push('到达时间格式不正确，请在确认表中修改。');
  if (
    Number.isFinite(parseTime(draft.departure)) &&
    Number.isFinite(parseTime(draft.arrival)) &&
    parseTime(draft.arrival) <= parseTime(draft.departure)
  )
    warnings.push('到达时间必须晚于出发时间；跨午夜的行程请核对到达日期。');
  result.warnings = [...new Set(warnings)];
  return result;
}

function flightCandidate(flight, draft, lookup, airports) {
  const warnings = [],
    next = initializeDraft(draft);
  next.from = normalizePlace(
    flight.from?.name || flight.from?.code,
    'flight',
    airports,
    warnings,
  );
  next.to = normalizePlace(
    flight.to?.name || flight.to?.code,
    'flight',
    airports,
    warnings,
  );
  for (const key of ['from', 'to'])
    if (!draft[key] || next[key] !== draft[key]) {
      next.fieldSources[key] = {
        source: lookup.isReference ? 'reference' : 'lookup',
        sourceName: lookup.source,
        referenceDate: lookup.referenceDate,
      };
      if (next[key] !== draft[key]) {
        delete next[`${key}Coord`];
        delete next.fieldSources[`${key}Coord`];
      }
    }
  applyTimes(next, flight.departure, flight.arrival, warnings, lookup);
  if (flight.status?.includes('取消'))
    warnings.push(
      lookup.isReference
        ? '参考日期的该航班显示已取消，不能据此判断实际出行日的状态，请按实际票面核对。'
        : '查询结果显示该航班已取消，请按实际行程核对后再保存。',
    );
  return {
    label: `${next.from} → ${next.to} · ${String(flight.departure || '时刻待确认').replace('T', ' ')}${lookup.isReference ? ` · ${lookup.referenceDate} 参考` : ''}${flight.status ? ` · ${flight.status}` : ''}`,
    draft: next,
    lookup: { ...lookup, selected: flight },
    warnings,
  };
}

function referenceFlight(data, date, today) {
  const offset = parseTime(`${date}T00:00`) - parseTime(`${today}T00:00`);
  const shift = (value) =>
    Number.isFinite(parseTime(value))
      ? localDateTime(parseTime(value) + offset)
      : value;
  const note = `${date} 的航班时刻暂未取得，以下使用 ${today} 同航班的计划时刻作为参考，并平移到所选日期；跨日间隔已保留，请按实际票面核对。`;
  return {
    ...data,
    date,
    isReference: true,
    referenceDate: today,
    source: '航旅纵横 · 今日参考',
    note,
    flights: data.flights.map((f) => ({
      ...f,
      departure: shift(f.departure),
      arrival: shift(f.arrival),
      isReference: true,
      referenceDate: today,
    })),
  };
}

// API errors leave each parsed row editable; no route creation or storage happens here.
export async function resolveBatchDraft(
  input,
  {
    api,
    stations = [],
    airports = [],
    today = chinaToday(),
    signal,
    deadline = Date.now() + 150000,
  } = {},
) {
  const draft = initializeDraft(input),
    warnings = [],
    result = { draft, lookup: null, warnings };
  draft.number = String(draft.number || '')
    .trim()
    .toUpperCase();
  draft.date = String(draft.date || '').replace(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/,
    (_, y, m, d) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`,
  );
  draft.travelDate = draft.date;
  // Automatically populated clocks are refreshed on a re-query; text/manual values are protected.
  for (const key of ['departure', 'arrival'])
    if (isAutomatic(draft, key)) delete draft[key];
  const places = draft.mode === 'train' ? stations : airports;
  draft.from = normalizePlace(draft.from, draft.mode, places, warnings);
  draft.to = normalizePlace(draft.to, draft.mode, places, warnings);
  for (const field of ['departure', 'arrival'])
    if (/^\d{2}:\d{2}$/.test(draft[field] || ''))
      draft[field] = `${draft.date}T${draft[field]}`;
  if (
    !['train', 'flight'].includes(draft.mode) ||
    !/^[A-Z0-9]{1,10}$/.test(draft.number) ||
    !Number.isFinite(parseTime(`${draft.date}T00:00`))
  ) {
    result.error = '交通方式、日期或车次/航班号格式不正确，请在确认表中修改。';
    warnings.push(result.error);
    return finish(result);
  }
  const query = async (date) => {
    if (signal?.aborted) throw signal.reason || abortError();
    const timeoutMs = Math.min(
      draft.mode === 'train' ? 80000 : 25000,
      deadline - Date.now(),
    );
    if (timeoutMs <= 0) throw abortError('查询时间已用完，已保留识别信息。');
    const data = await api(
      `/api/${draft.mode}?${new URLSearchParams({ number: draft.number, date })}`,
      undefined,
      { signal, timeoutMs },
    );
    if (data?.error) throw new Error(data.error);
    if (
      draft.mode === 'train'
        ? !Array.isArray(data?.stops) ||
          !data.stops.length ||
          data.stops.some((s) => !s?.name)
        : !Array.isArray(data?.flights) ||
          !data.flights.length ||
          data.flights.some(
            (f) =>
              !(f?.from?.name || f?.from?.code) ||
              !(f?.to?.name || f?.to?.code),
          )
    )
      throw new Error('没有查到可用的停站或航段。');
    return data;
  };
  let lookup;
  try {
    lookup = await query(
      draft.mode === 'train' ? draft.queryDate || draft.date : draft.date,
    );
  } catch (original) {
    if (isAbort(original) || signal?.aborted) throw original;
    if (draft.mode === 'flight' && draft.date !== today) {
      try {
        lookup = referenceFlight(await query(today), draft.date, today);
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw error;
        warnings.push(
          `所选日期及今日同航班均未查到可用时刻：${original.message || '查询暂不可用'}。起止机场和已填时刻已保留。`,
        );
      }
    } else
      warnings.push(
        `${original.message || '查询暂不可用'} 已保留输入的行程信息。`,
      );
  }
  if (!lookup) return finish(result);
  result.lookup = lookup;
  if (lookup.isReference)
    warnings.push(
      lookup.note ||
        `停站与时刻来自 ${lookup.referenceDate || '最新可用日期'} 的参考数据，请按票面核对。`,
    );

  if (draft.mode === 'train') {
    const findPairs = (data) => {
      const stops = data.stops;
      const starts = draft.from
        ? stops
            .map((s, i) =>
              samePlace(draft.from, s, 'train', stations) ? i : -1,
            )
            .filter((i) => i >= 0)
        : [0];
      const ends = draft.to
        ? stops
            .map((s, i) => (samePlace(draft.to, s, 'train', stations) ? i : -1))
            .filter((i) => i >= 0)
        : [stops.length - 1];
      const pairs = starts.flatMap((a) =>
        ends.filter((b) => b > a).map((b) => [a, b]),
      );
      const selected = pairs.find(
        ([a, b]) => a === draft.fromStopIndex && b === draft.toStopIndex,
      );
      return selected ? [selected] : pairs;
    };
    let pairs = findPairs(lookup);
    if (pairs.length === 1) {
      const boarding = lookup.stops[pairs[0][0]],
        boardDay = (boarding.departure || boarding.arrival)?.slice(0, 10);
      const baseDate = lookup.date || draft.queryDate || draft.date;
      const offset =
        (parseTime(`${boardDay}T00:00`) - parseTime(`${baseDate}T00:00`)) /
        86400000;
      if (
        Number.isFinite(offset) &&
        offset >= 0 &&
        offset <= 7 &&
        boardDay !== draft.date
      ) {
        const queryDate = addDays(draft.date, -offset);
        try {
          const checked = await query(queryDate),
            checkedPairs = findPairs(checked);
          if (
            checkedPairs.length !== 1 ||
            (
              checked.stops[checkedPairs[0][0]].departure ||
              checked.stops[checkedPairs[0][0]].arrival
            )?.slice(0, 10) !== draft.date
          )
            throw new Error('本站日期仍不一致');
          lookup = checked;
          pairs = checkedPairs;
          result.lookup = lookup;
          warnings.push(
            `已按实际乘车日 ${draft.date} 复核：该列车的始发查询日为 ${queryDate}。`,
          );
        } catch (error) {
          if (isAbort(error) || signal?.aborted) throw error;
          // Keep the itinerary editable, but never present a shifted schedule as verified history.
          const delta =
            parseTime(`${draft.date}T00:00`) - parseTime(`${boardDay}T00:00`);
          lookup = {
            ...lookup,
            isReference: true,
            referenceDate: lookup.referenceDate || baseDate,
            date: queryDate,
            note: `始发日期 ${queryDate} 复核未成功，时刻按已有停站表平移到实际乘车日 ${draft.date}，仅供参考，请核对票面。`,
            stops: lookup.stops.map((s) => ({
              ...s,
              arrival: Number.isFinite(parseTime(s.arrival))
                ? localDateTime(parseTime(s.arrival) + delta)
                : s.arrival,
              departure: Number.isFinite(parseTime(s.departure))
                ? localDateTime(parseTime(s.departure) + delta)
                : s.departure,
            })),
          };
          result.lookup = lookup;
          warnings.push(lookup.note);
        }
      }
    }
    draft.queryDate = lookup.date || draft.queryDate || draft.date;
    const stops = lookup.stops;
    if (!pairs.length) {
      warnings.push(
        `查询停站未匹配“${draft.from || '起点'} → ${draft.to || '终点'}”的运行区间，已保留原地点；请核对车次和上下车站。`,
      );
      return finish(result);
    }
    const candidate = ([a, b]) => {
      const next = initializeDraft({
          ...draft,
          from: stops[a].name,
          to: stops[b].name,
          fromStopIndex: a,
          toStopIndex: b,
        }),
        notes = [];
      for (const key of ['from', 'to'])
        if (!draft[key])
          next.fieldSources[key] = {
            source: lookup.isReference ? 'reference' : 'lookup',
            sourceName: lookup.source,
            referenceDate: lookup.referenceDate,
          };
      applyTimes(
        next,
        stops[a].departure || stops[a].arrival,
        stops[b].arrival || stops[b].departure,
        notes,
        lookup,
      );
      return {
        label: `${next.from}（第 ${a + 1} 站）→ ${next.to}（第 ${b + 1} 站）· ${String(stops[a].departure || '').replace('T', ' ')}`,
        draft: next,
        lookup,
        needsDateReview:
          (stops[a].departure || stops[a].arrival)?.slice(0, 10) !== draft.date,
        warnings: notes,
      };
    };
    if (pairs.length > 1) {
      result.candidates = pairs.map(candidate);
      warnings.push('查询到多个符合起止站的运行区间，请选择本次乘坐的一段。');
    } else {
      if (!draft.from || !draft.to)
        warnings.push(
          '未填写的起止站已按该车次始发站或终到站补全，请确认实际乘坐区间。',
        );
      const selected = candidate(pairs[0]);
      Object.assign(draft, selected.draft);
      warnings.push(...selected.warnings);
    }
    return finish(result);
  }

  const matched = lookup.flights.filter(
    (f) =>
      samePlace(draft.from, f.from, 'flight', airports) &&
      samePlace(draft.to, f.to, 'flight', airports),
  );
  if (matched.length === 1) {
    const selected = flightCandidate(matched[0], draft, lookup, airports);
    Object.assign(draft, selected.draft);
    result.lookup = selected.lookup;
    warnings.push(...selected.warnings);
  } else {
    result.candidates = (matched.length ? matched : lookup.flights).map((f) =>
      flightCandidate(f, draft, lookup, airports),
    );
    warnings.push(
      matched.length
        ? '查询到多个符合起止机场的航段，请选择本次乘坐的一段。'
        : '查询航段与填写的起止机场不符，已保留原地点和时刻。可选择查询航段，或保留原行程并补充缺失信息。',
    );
  }
  return finish(result);
}
