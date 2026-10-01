import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  referenceGeometry,
  referenceStations,
  latestJourney,
} from './scripts/rail-geometry.mjs';
import { queryTrainWithReference } from './scripts/train-reference.mjs';
import {
  sharedCorridorPlan,
  sharedCorridorReference,
  selectStopInterval,
  stationSchematicJourney,
} from './scripts/rail-fallback.mjs';
import {
  createRequestScheduler,
  TravelError,
  isCancellation,
  requestBudget,
  throwIfCancelled,
  withSignal,
} from './scripts/request-scheduler.mjs';
import {
  coordinate,
  timetableTimes,
  addDays,
  chinaToday,
  parseTime,
  distance,
} from './dist/core.js';

const defaultRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'dist',
);
export const REQUEST_BUDGETS = { train: 75000, flight: 20000, route: 75000 };
const types = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const stationName = (name) =>
  String(name || '')
    .trim()
    .replace(/站$/, '');
const warning = (
  code,
  message,
  scope = 'route',
  requiresConfirmation = false,
) => ({ code, scope, severity: 'warning', message, requiresConfirmation });
const invalid = (message) => new TravelError('INVALID_INPUT', message);

function validQuery(query) {
  const number = (query.get('number') || '').trim().toUpperCase(),
    date = query.get('date');
  if (
    !/^[A-Z0-9]{1,10}$/.test(number) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date || '') ||
    !Number.isFinite(parseTime(date + 'T00:00'))
  )
    throw invalid('车次/航班号或日期格式不正确。');
  return { number, date };
}
function send(res, data, status = 200) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}
function errorPayload(error) {
  return {
    error: error.message || '查询失败，请重试。',
    code: error.code || 'INVALID_INPUT',
    retryable: Boolean(error.retryable),
    ...(error.candidates ? { candidates: error.candidates } : {}),
  };
}
function readRequestJSON(req, signal) {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => {
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('error', fail);
      signal.removeEventListener('abort', abort);
    };
    const fail = (error) => {
      cleanup();
      req.pause();
      reject(error);
    };
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > 32000)
        return fail(
          new TravelError('BODY_TOO_LARGE', '内容过长。', { status: 413 }),
        );
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(invalid('请求内容不是有效 JSON。'));
      }
    };
    const abort = () => fail(signal.reason);
    req.on('data', data);
    req.once('end', end);
    req.once('error', fail);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

// Importing this module never starts a listener. Tests inject providers and listen
// on an ephemeral loopback port; normal CLI usage remains 127.0.0.1:4173.
export async function createTravelServer({
  fetchImpl = globalThis.fetch,
  root = defaultRoot,
  stations: inputStations,
  airports: inputAirports,
  now = Date.now,
  today = chinaToday,
  schedulerOptions = {},
} = {}) {
  const stations =
    inputStations ||
    JSON.parse(await readFile(path.join(root, 'data/stations.json'), 'utf8'));
  const airports =
    inputAirports ||
    JSON.parse(await readFile(path.join(root, 'data/airports.json'), 'utf8'));
  const stationMap = new Map(stations.map((stop) => [stop.name, stop]));
  const scheduler = createRequestScheduler({
    fetchImpl,
    now,
    ...schedulerOptions,
  });
  const timestamp = () => new Date(now()).toISOString();
  const currentDay = () => (typeof today === 'function' ? today() : today);

  async function trainLookup(query, context) {
    const { number, date } = validQuery(query);
    return scheduler.memo(
      `train:${number}:${date}`,
      async (inner) => {
        const search = await scheduler.json(
          `https://search.12306.cn/search/v1/train/search?${new URLSearchParams({ keyword: number, date: date.replaceAll('-', '') })}`,
          '12306',
          inner,
        );
        if (!Array.isArray(search.data))
          throw new TravelError(
            'UPSTREAM_FORMAT',
            '列车搜索结果格式发生变化。',
            { status: 502 },
          );
        const found = search.data.filter(
          (train) =>
            typeof train.station_train_code === 'string' &&
            train.station_train_code.toUpperCase().split('/').includes(number),
        );
        if (found.length !== 1)
          throw new TravelError(
            found.length ? 'TRAIN_AMBIGUOUS' : 'NO_TIMETABLE',
            found.length
              ? '查询到多个同号车次，请补充起止站并核对。'
              : '未查到该日期的车次，可能尚未开放或车次已调整。',
            { retryable: !found.length, status: 404 },
          );
        const train = found[0],
          from = stationMap.get(train.from_station),
          to = stationMap.get(train.to_station);
        if (!from?.code || !to?.code)
          throw new TravelError(
            'STATION_CODE_MISSING',
            '车站电报码暂未收录，请保留行程并手动核对。',
          );
        const detail = await scheduler.json(
          `https://kyfw.12306.cn/otn/czxx/queryByTrainNo?${new URLSearchParams({ train_no: train.train_no, from_station_telecode: from.code, to_station_telecode: to.code, depart_date: date })}`,
          '12306',
          inner,
        );
        if (!Array.isArray(detail.data?.data) || !detail.data.data.length)
          throw new TravelError(
            'NO_TIMETABLE',
            '停站时刻暂不可用，请保留行程并稍后重试。',
            { retryable: true, status: 404 },
          );
        if (
          detail.data.data.some(
            (stop) =>
              typeof stop?.station_name !== 'string' ||
              !stop.station_name.trim(),
          )
        )
          throw new TravelError('UPSTREAM_FORMAT', '停站表包含无效站名。', {
            status: 502,
          });
        const warningDetails = [];
        const stops = timetableTimes(detail.data.data, date, {
          onInvalidTime: ({ stopIndex, field }) => {
            warningDetails.push(
              warning(
                'INVALID_TIMETABLE_TIME',
                `12306 返回的第 ${stopIndex + 1} 站“${detail.data.data[stopIndex].station_name}”${field === 'arrival' ? '到达' : '出发'}时刻无效，已留空，请按票面核对。`,
                'schedule',
              ),
            );
          },
        }).map((stop, stopIndex) => ({
          name: stop.station_name,
          ...stationMap.get(stop.station_name),
          arrival: stop.arrival,
          departure: stop.departure,
          stopIndex,
        }));
        if (!stops.some((stop) => stop.arrival || stop.departure))
          throw new TravelError(
            'NO_TIMETABLE',
            '停站表没有可用时刻，请保留行程并手动核对。',
            { retryable: true, status: 404 },
          );
        const warnings = warningDetails.map((item) => item.message);
        return {
          number,
          date,
          stops,
          warnings,
          warningDetails,
          source: '12306',
          fetchedAt: timestamp(),
          scheduleProvenance: {
            source: '12306',
            requestedDate: date,
            sourceDate: date,
            fetchedAt: timestamp(),
            basis: 'scheduled',
          },
          note: [
            '按本次所选始发日期查询。中途上车的跨日列车请核对始发日期和本站时刻。',
            ...warnings,
          ].join(' '),
        };
      },
      context,
    );
  }
  function trainWithReference(query, context) {
    const { number, date } = validQuery(query);
    return scheduler.memo(
      `train-reference:${number}:${date}:${currentDay()}`,
      (inner) =>
        queryTrainWithReference(
          query,
          (next) => trainLookup(next, inner),
          currentDay(),
          inner,
        ),
      context,
    );
  }
  async function flightLookup(query, context) {
    const { number, date } = validQuery(query);
    if (date > addDays(currentDay(), 90))
      throw new TravelError(
        'DATE_NOT_AVAILABLE',
        '航班查询通常支持未来 90 天以内，更远的行程可先保存为待补全。',
      );
    return scheduler.memo(
      `flight:${number}:${date}`,
      async (inner) => {
        const data = await scheduler.json(
          `https://www.umetrip.com/gateway/api/web/flightstatus/getflightstatusbyflightno?${new URLSearchParams({ flightNo: number, flightDate: date, appid: '', sessionId: '', token: '' })}`,
          'umetrip',
          inner,
        );
        if (
          data.errCode !== 0 ||
          data.status !== 0 ||
          !Array.isArray(data.flightStatusList) ||
          !data.flightStatusList.length
        )
          throw new TravelError(
            'NO_FLIGHT',
            data.msg || data.errMsg || '没有查到相应航班，请核对日期和航班号。',
            { retryable: true, status: 404 },
          );
        const flights = data.flightStatusList.map((flight) => {
          if (
            !flight ||
            typeof flight.flightNo !== 'string' ||
            !flight.deptCityCode ||
            !flight.destCityCode
          )
            throw new TravelError(
              'UPSTREAM_FORMAT',
              '航班结果缺少编号或机场。',
              { status: 502 },
            );
          const from = airports.find(
              (airport) => airport.code === flight.deptCityCode,
            ),
            to = airports.find(
              (airport) => airport.code === flight.destCityCode,
            );
          const departure = `${flight.deptFlightDate || date}T${flight.std}`,
            arrival = `${flight.destFlightDate || date}T${flight.sta}`;
          return {
            number: flight.flightNo,
            from: from || {
              name: flight.deptAirportName || flight.deptCityCode,
              code: flight.deptCityCode,
              coord: null,
            },
            to: to || {
              name: flight.destAirportName || flight.destCityCode,
              code: flight.destCityCode,
              coord: null,
            },
            departure: Number.isFinite(parseTime(departure)) ? departure : null,
            arrival: Number.isFinite(parseTime(arrival)) ? arrival : null,
            status: flight.flightStatus,
            airline: flight.airlineName,
            plane: flight.planeType,
            terminalFrom: flight.deptTerminal,
            terminalTo: flight.destTerminal,
          };
        });
        return {
          number,
          date,
          source: '航旅纵横',
          fetchedAt: timestamp(),
          scheduleProvenance: {
            source: '航旅纵横',
            requestedDate: date,
            sourceDate: date,
            fetchedAt: timestamp(),
            basis: 'scheduled',
          },
          flights,
        };
      },
      { ...context, ttl: 15 * 60000 },
    );
  }
  function place(name, mode, manual) {
    if (typeof name !== 'string' || !name.trim() || name.length > 100)
      throw invalid('地点格式不正确。');
    name = name.trim();
    if (manual) return { name, coord: coordinate(manual) };
    if (mode === 'train') {
      const stop = stationMap.get(stationName(name));
      if (stop?.coord) return stop;
      throw new TravelError(
        'PLACE_UNRESOLVED',
        `“${name}”尚未匹配唯一车站坐标，可补充 WGS84 坐标。`,
      );
    }
    const key = name.toUpperCase().replace(/国际|机场/g, '');
    const matches = airports.filter((airport) =>
      [airport.code, airport.icao, airport.name, airport.english]
        .filter(Boolean)
        .some((value) => value.toUpperCase().replace(/国际|机场/g, '') === key),
    );
    if (matches.length === 1) return matches[0];
    throw new TravelError(
      'PLACE_UNRESOLVED',
      `“${name}”未匹配唯一机场，请使用机场三字码或具体机场名。`,
    );
  }
  const unresolvedPlace = (name, mode, manual) => {
    try {
      return place(name, mode, manual);
    } catch {
      return { name: String(name || '').trim(), coord: null };
    }
  };
  function railData(endpoint, number, context) {
    return scheduler.memo(
      `railgo:${endpoint}:${number}`,
      async (inner) => {
        const data = await scheduler.json(
          `https://rg-api.zenglingkun.cn/api/v2/${endpoint}?${new URLSearchParams(endpoint === 'getTrainMain' ? { trainNum: number } : { train: number })}`,
          'railgo',
          inner,
        );
        if (data?.success !== true)
          throw new TravelError('NO_RAIL_DATA', '车次线路服务暂不可用。', {
            retryable: true,
            status: 502,
          });
        const result = { ...data, fetchedAt: timestamp() };
        if (endpoint === 'getTrainMain') {
          if (
            !Array.isArray(data.data?.timetable) ||
            data.data.timetable.length < 2 ||
            data.data.timetable.some(
              (stop) =>
                typeof stop?.station !== 'string' || !stop.station.trim(),
            )
          )
            throw new TravelError(
              'UPSTREAM_FORMAT',
              '车次线路服务没有返回有效停站表，请稍后重试。',
              { retryable: true, status: 502 },
            );
          return result;
        }
        try {
          const stops = referenceStations(data);
          if (stops.length < 2) throw new Error('线路服务未返回完整停站。');
        } catch (error) {
          throw new TravelError('UPSTREAM_FORMAT', error.message, {
            retryable: true,
            status: 502,
          });
        }
        try {
          const train = data.data.train;
          if (train != null) {
            if (typeof train !== 'object' || Array.isArray(train))
              throw new Error('线路片段格式异常。');
            // Gaps are recorded by referenceGeometry and checked only after
            // selecting the travelled interval, not against the whole line.
            if (Object.keys(train).length) referenceGeometry(data);
          }
        } catch (error) {
          const failure = new TravelError('UPSTREAM_FORMAT', error.message, {
            retryable: true,
            status: 502,
          });
          // Keep usable stops for this request, but reject the memo loader so
          // malformed geometry cannot remain in the six-hour success cache.
          failure.fallbackData = {
            ...result,
            data: { stations: data.data.stations, train: {} },
          };
          throw failure;
        }
        return result;
      },
      { ...context, ttl: 6 * 3600000 },
    );
  }
  function decorateRoute(route, details, schedule) {
    const all = [
      ...details,
      ...(schedule?.warningDetails || []),
      ...(route.warnings || []).map((message) =>
        warning(
          message.includes('停站表与最新线路不同')
            ? 'SCHEDULE_ROUTE_MISMATCH'
            : 'STOP_NOT_LOCATED',
          message,
        ),
      ),
    ];
    if (schedule?.isReference)
      all.push(warning('SCHEDULE_REFERENCE', schedule.note, 'schedule'));
    if (
      route.routeNote &&
      !all.some((item) => item.message === route.routeNote)
    )
      all.push(
        warning(
          route.quality === 'corridor'
            ? 'CORRIDOR_REFERENCE'
            : 'SCHEMATIC_ROUTE',
          route.routeNote,
          'route',
          route.requiresConfirmation === true,
        ),
      );
    const seen = new Set();
    route.warningDetails = all.filter((item) => {
      const key = `${item.code}:${item.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    route.warnings = route.warningDetails.map((item) => item.message);
    if (schedule?.scheduleProvenance)
      route.scheduleProvenance = schedule.scheduleProvenance;
    return route;
  }
  function pendingRoute(body, error, details = [], schedule = null) {
    const from = unresolvedPlace(body.from, body.mode, body.fromCoord),
      to = unresolvedPlace(body.to, body.mode, body.toCoord);
    return decorateRoute(
      {
        from,
        to,
        stops: [from, to],
        legs: [],
        routeCoordinates: [],
        quality: 'pending',
        distance: null,
        routeSource: null,
        routeFetchedAt: null,
        requiresConfirmation: false,
        resolution: {
          state: 'unavailable',
          code: error.code || 'ROUTE_UNAVAILABLE',
          message: error.message,
          retryable: error.retryable ?? true,
          ...(error.candidates ? { candidates: error.candidates } : {}),
        },
      },
      [...details, warning(error.code || 'ROUTE_UNAVAILABLE', error.message)],
      schedule,
    );
  }
  async function resolveRoute(body, context) {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !['train', 'flight'].includes(body.mode)
    )
      throw invalid('交通方式错误。');
    if (
      ![body.from, body.to].every(
        (name) => typeof name === 'string' && name.trim() && name.length <= 100,
      )
    )
      throw invalid('请填写有效起止地点。');
    if (body.mode === 'flight') {
      try {
        const from = place(body.from, body.mode, body.fromCoord),
          to = place(body.to, body.mode, body.toCoord);
        if (distance(from.coord, to.coord) < 0.1)
          throw invalid('起点和终点不能是同一地点。');
        return {
          from,
          to,
          stops: [from, to],
          legs: [],
          quality: 'schematic',
          distance: distance(from.coord, to.coord),
          requiresConfirmation: false,
          resolution: { state: 'ready' },
          warnings: [],
          warningDetails: [],
        };
      } catch (error) {
        if (error.code === 'INVALID_INPUT') throw error;
        return pendingRoute(body, error);
      }
    }
    const number = String(body.number || '')
        .trim()
        .toUpperCase(),
      fromName = stationName(body.from),
      toName = stationName(body.to);
    if (!/^[A-Z0-9]{1,10}$/.test(number)) throw invalid('请填写有效车次。');
    if (body.date) validQuery(new URLSearchParams({ number, date: body.date }));
    const via = String(body.via || '')
      .split(/[、;；\n]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (via.length > 80) throw invalid('途经站最多 80 个。');
    const settle = (promise) =>
      promise.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    const [railResult, scheduleResult] = await Promise.all([
      settle(railData('mapLine', number, context)),
      body.date
        ? settle(
            trainWithReference(
              new URLSearchParams({ number, date: body.date }),
              context,
            ),
          )
        : Promise.resolve({ value: null }),
    ]);
    throwIfCancelled(context.signal);
    for (const result of [railResult, scheduleResult])
      if (isCancellation(result.error)) throw result.error;
    const data = railResult.value || railResult.error?.fallbackData,
      schedule = scheduleResult.value;
    const details = [];
    if (scheduleResult.error)
      details.push(
        warning(
          'SCHEDULE_UNAVAILABLE',
          '未取得可核对的停站时刻；路线与实际乘坐时刻需分别核对。',
          'schedule',
        ),
      );
    let reference = null,
      routeError = railResult.error;
    try {
      if (data)
        reference = { ...referenceGeometry(data), fetchedAt: data.fetchedAt };
    } catch (error) {
      routeError = railResult.error || error;
    }
    if (!reference && data) {
      const plan = sharedCorridorPlan(number, fromName, toName);
      if (plan) {
        try {
          const [donor, main] = await Promise.all([
            railData('mapLine', plan.donor, context),
            railData('getTrainMain', number, context),
          ]);
          reference = {
            ...sharedCorridorReference(
              plan,
              data,
              referenceGeometry(donor),
              main,
            ),
            fetchedAt: donor.fetchedAt,
          };
        } catch (error) {
          if (isCancellation(error)) throw error;
          routeError = error;
        }
      }
    }
    throwIfCancelled(context.signal);
    // A selected timetable occurrence is checked against that same table before
    // converting to a latest-route interval. Indices are never blindly reused.
    let selectedSchedule = null;
    if (schedule) {
      try {
        selectedSchedule = selectStopInterval(
          schedule.stops,
          fromName,
          toName,
          body,
        );
      } catch (error) {
        if (
          body.fromStopIndex !== undefined ||
          body.toStopIndex !== undefined ||
          error.code === 'STOP_AMBIGUOUS'
        )
          return pendingRoute(body, error, details, schedule);
      }
    } else if (
      body.fromStopIndex !== undefined ||
      body.toStopIndex !== undefined
    ) {
      return pendingRoute(
        body,
        new TravelError(
          'STOP_SELECTION_UNVERIFIED',
          '暂不能核对所选上下车站次，请保留记录后重新查询。',
          { retryable: true },
        ),
        details,
      );
    }
    const selectReference = (stops) => {
      const sameSequence =
        schedule &&
        stops.map((stop) => stop.name).join('|') ===
          schedule.stops.map((stop) => stop.name).join('|');
      return selectStopInterval(
        stops,
        fromName,
        toName,
        sameSequence ? body : {},
      );
    };
    if (reference) {
      try {
        const selected = selectReference(reference.stations);
        const stops = selected.stops.map((stop, i) => ({
          ...stationMap.get(stop.name),
          ...stop,
          referenceStopIndex: selected.fromStopIndex + i,
        }));
        const route = latestJourney(reference, stops, schedule);
        return decorateRoute(
          {
            from: stops[0],
            to: stops.at(-1),
            ...route,
            via: stops
              .slice(1, -1)
              .map((stop) => stop.name)
              .join('、'),
            routeSource: 'RailGo',
            routeSourceUrl: 'https://railgo.dev/',
            routeNote: null,
            ...reference.provenance,
            routeFetchedAt: reference.fetchedAt,
            requiresConfirmation: false,
            resolution: { state: 'ready' },
          },
          details,
          schedule,
        );
      } catch (error) {
        routeError = error;
        if (error.code === 'STOP_AMBIGUOUS')
          return pendingRoute(body, error, details, schedule);
      }
    }
    const candidates = [];
    if (data) {
      try {
        candidates.push({
          stops: referenceStations(data),
          source: 'RailGo · 最新停靠站',
          url: 'https://railgo.dev/',
          fetchedAt: data.fetchedAt,
          sourceDate: null,
        });
      } catch {}
    }
    if (selectedSchedule)
      candidates.push({
        stops: schedule.stops,
        source: schedule.source || '12306',
        url: 'https://www.12306.cn/',
        fetchedAt: schedule.fetchedAt,
        sourceDate: schedule.referenceDate || schedule.date,
        schedule: true,
      });
    for (const candidate of candidates) {
      try {
        const selected = candidate.schedule
          ? selectedSchedule
          : selectReference(candidate.stops);
        const stops = selected.stops.map((stop) => ({
          ...stop,
          coord: stop.coord || stationMap.get(stop.name)?.coord || null,
        }));
        const note = `停站连线示意：按${candidate.source}${candidate.sourceDate ? `（${candidate.sourceDate}）` : ''}的停靠站生成曲线，不代表真实轨道或实际行驶里程。`;
        const route = stationSchematicJourney(stops, {
          routeSource: candidate.source,
          routeSourceUrl: candidate.url,
          routeNote: note,
          routeFetchedAt: candidate.fetchedAt,
          stopSourceDate: candidate.sourceDate,
        });
        return decorateRoute(
          {
            ...route,
            via: stops
              .slice(1, -1)
              .map((stop) => stop.name)
              .join('、'),
          },
          [
            ...details,
            warning(
              'TRACK_UNAVAILABLE',
              routeError?.message || '本车次尚无可用的真实轨道。',
            ),
          ],
          schedule,
        );
      } catch (error) {
        routeError = error;
      }
    }
    if (body.manualSchematic === true && via.length) {
      try {
        const stops = [
          place(body.from, 'train', body.fromCoord),
          ...via.map((value) => {
            const [name, coord] = value.split('@');
            return place(name, 'train', coord);
          }),
          place(body.to, 'train', body.toCoord),
        ];
        const route = stationSchematicJourney(stops, {
          quality: 'manual-schematic',
          routeSource: '手动途经地点',
          routeSourceUrl: null,
          routeNote: '手动示意线：仅连接你填写的地点，未经停站或真实铁路核验。',
          routeFetchedAt: null,
        });
        return decorateRoute(route, details, schedule);
      } catch (error) {
        routeError = error;
      }
    }
    return pendingRoute(
      body,
      routeError ||
        new TravelError(
          'NO_RELIABLE_STOPS',
          '没有可靠的线路和完整停站坐标，可先保存为待补全。',
          { retryable: true },
        ),
      details,
      schedule,
    );
  }

  const server = http.createServer(async (req, res) => {
    const connection = new AbortController();
    let budget;
    const disconnected = () => {
      if (!res.writableEnded)
        connection.abort(
          new TravelError('CANCELLED', '客户端已停止查询。', { status: 499 }),
        );
    };
    req.on('aborted', disconnected);
    req.on('error', disconnected);
    res.on('close', disconnected);
    try {
      const port = server.address()?.port,
        host = req.headers.host;
      if (!host || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host))
        throw new TravelError('INVALID_HOST', '无效主机。', { status: 403 });
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        if (req.headers.origin && req.headers.origin !== `http://${host}`)
          throw new TravelError('INVALID_ORIGIN', '仅允许当前网站请求。', {
            status: 403,
          });
        if (url.pathname === '/api/diagnostics' && req.method === 'GET')
          return send(res, { localOnly: true, ...scheduler.diagnostics() });
        const endpoint = url.pathname.slice('/api/'.length),
          maximum = REQUEST_BUDGETS[endpoint];
        if (
          !maximum ||
          !(
            (endpoint === 'route' && req.method === 'POST') ||
            (endpoint !== 'route' && req.method === 'GET')
          )
        )
          throw new TravelError('NOT_FOUND', '接口不存在。', { status: 404 });
        const rawBudget = req.headers['x-travel-budget-ms'];
        const requestedBudget =
          rawBudget === undefined ? maximum : Number(rawBudget);
        if (!Number.isFinite(requestedBudget) || requestedBudget <= 0)
          throw invalid('请求等待预算必须是正数。');
        budget = requestBudget(
          Math.min(maximum, requestedBudget),
          connection.signal,
        );
        const context = {
          signal: budget.signal,
          priority:
            req.headers['x-travel-priority'] === 'background'
              ? 'background'
              : 'foreground',
        };
        if (endpoint === 'train')
          return send(
            res,
            await withSignal(
              trainWithReference(url.searchParams, context),
              budget.signal,
            ),
          );
        if (endpoint === 'flight')
          return send(
            res,
            await withSignal(
              flightLookup(url.searchParams, context),
              budget.signal,
            ),
          );
        const body = await readRequestJSON(req, budget.signal);
        return send(
          res,
          await withSignal(resolveRoute(body, context), budget.signal),
        );
      }
      if (req.method !== 'GET' && req.method !== 'HEAD')
        throw new TravelError('METHOD_NOT_ALLOWED', '不支持的方法。', {
          status: 405,
        });
      const relative = decodeURIComponent(
          url.pathname === '/' ? '/index.html' : url.pathname,
        ),
        file = path.resolve(root, '.' + relative);
      if (!file.startsWith(root + path.sep))
        throw new TravelError('NOT_FOUND', '页面不存在。', { status: 404 });
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': types[path.extname(file)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': file.endsWith('.geojson')
          ? 'public, max-age=86400'
          : 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (error.code === 'ENOENT')
        return send(
          res,
          { error: '页面不存在。', code: 'NOT_FOUND', retryable: false },
          404,
        );
      if (
        ['BODY_TOO_LARGE', 'DEADLINE_EXCEEDED'].includes(error.code) &&
        !res.destroyed
      ) {
        res.setHeader('Connection', 'close');
        res.once('finish', () => req.destroy());
      }
      send(res, errorPayload(error), error.status || 400);
    } finally {
      budget?.dispose();
      req.removeListener('aborted', disconnected);
      res.removeListener('close', disconnected);
    }
  });
  const close = server.close.bind(server);
  server.close = (callback) => {
    scheduler.close();
    return close(callback);
  };
  server.diagnostics = () => scheduler.diagnostics();
  return server;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = await createTravelServer();
  server.listen(4173, '127.0.0.1', () =>
    console.log('途映已启动：http://127.0.0.1:4173'),
  );
}
