import {
  coordinate,
  distance,
  lineLength,
  parseTime,
  chinaToday,
} from '../dist/core.js';
import { latestJourney } from './rail-geometry.mjs';
import { TravelError } from './request-scheduler.mjs';

const unavailable = (message) =>
  new TravelError('OSM_ROUTE_UNAVAILABLE', message, { retryable: false });
const validDate = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
  Number.isFinite(parseTime(`${value}T00:00`));
const sourceURL = (value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

// The dataset contains checked line intervals, never a routable national graph.
// A timetable match permits a reference candidate; it is not historical GPS.
export function validateOsmDataset(data) {
  if (
    data?.version !== 1 ||
    typeof data.dataVersion !== 'string' ||
    !data.dataVersion ||
    !validDate(data.sourceDate) ||
    data.coordinateSystem !== 'WGS84' ||
    data.license !== 'ODbL-1.0' ||
    !Array.isArray(data.corridors) ||
    data.corridors.length > 100
  )
    throw new Error('OSM 本地数据清单格式无效。');
  const ids = new Set();
  for (const corridor of data.corridors) {
    if (
      typeof corridor.id !== 'string' ||
      !corridor.id ||
      ids.has(corridor.id) ||
      typeof corridor.name !== 'string' ||
      !corridor.name ||
      !Array.isArray(corridor.stations) ||
      corridor.stations.length < 2 ||
      corridor.stations.length > 82 ||
      !Array.isArray(corridor.coordinates) ||
      corridor.coordinates.length < 2 ||
      corridor.coordinates.length > 100000 ||
      !Array.isArray(corridor.trains) ||
      !sourceURL(corridor.evidence?.geometry?.url) ||
      !Number.isInteger(corridor.evidence.geometry.relationId) ||
      !Number.isInteger(corridor.evidence.geometry.relationVersion)
    )
      throw new Error('OSM 区间数据不完整。');
    ids.add(corridor.id);
    const names = new Set();
    for (const station of corridor.stations) {
      if (
        typeof station.name !== 'string' ||
        !station.name ||
        names.has(station.name)
      )
        throw new Error('OSM 区间站名不唯一。');
      names.add(station.name);
      coordinate(station.coord);
    }
    for (const [i, point] of corridor.coordinates.entries()) {
      coordinate(point);
      if (i && distance(corridor.coordinates[i - 1], point) > 20)
        throw new Error('OSM 区间存在过长的几何接缝。');
    }
    const measured = lineLength(corridor.coordinates);
    if (
      !Array.isArray(corridor.distanceRangeKm) ||
      corridor.distanceRangeKm.length !== 2 ||
      !corridor.distanceRangeKm.every(Number.isFinite) ||
      corridor.distanceRangeKm[0] <= 0 ||
      measured < corridor.distanceRangeKm[0] ||
      measured > corridor.distanceRangeKm[1]
    )
      throw new Error('OSM 区间长度超出核实范围。');
    const reference = {
      stations: corridor.stations,
      coordinates: corridor.coordinates,
      gaps: [],
    };
    const check = latestJourney(reference, corridor.stations, null);
    if (check.stops.some((stop) => !stop.routeMatched))
      throw new Error('OSM 区间站点未按顺序投影到线路。');
    const numbers = new Set();
    for (const train of corridor.trains) {
      if (
        !/^[A-Z0-9]{1,10}$/.test(train.number || '') ||
        numbers.has(train.number) ||
        !Array.isArray(train.stops) ||
        train.stops.length < 2 ||
        train.stops.length > 82 ||
        train.stops.some((name) => typeof name !== 'string' || !name) ||
        new Set(train.stops).size !== train.stops.length ||
        !sourceURL(train.evidence?.routeUrl) ||
        !sourceURL(train.evidence?.scheduleUrl) ||
        !validDate(train.evidence?.checkedDate) ||
        !validDate(train.evidence?.scheduleDate) ||
        !validDate(train.evidence?.validFrom) ||
        !validDate(train.evidence?.validUntil) ||
        train.evidence.validFrom < train.evidence.checkedDate ||
        train.evidence.validUntil < train.evidence.validFrom ||
        parseTime(`${train.evidence.validUntil}T00:00`) -
          parseTime(`${train.evidence.checkedDate}T00:00`) >
          30 * 86400000 ||
        typeof train.evidence?.basis !== 'string' ||
        !train.evidence.basis.trim()
      )
        throw new Error('OSM 车次白名单缺少独立径路或停站证据。');
      numbers.add(train.number);
      const positions = train.stops
        .filter((name) => names.has(name))
        .map((name) =>
          corridor.stations.findIndex((stop) => stop.name === name),
        );
      if (
        positions.length < 2 ||
        positions.some((value, i) => i && value <= positions[i - 1])
      )
        throw new Error('OSM 白名单方向或区间停站无效。');
    }
  }
  return data;
}

export function createOsmRailProvider(dataset, { today = chinaToday } = {}) {
  const data = dataset ? validateOsmDataset(structuredClone(dataset)) : null;
  const active = () => {
    const current = typeof today === 'function' ? today() : today;
    return (data?.corridors || [])
      .map((corridor) => ({
        ...corridor,
        trains: corridor.trains.filter(
          (train) =>
            validDate(current) &&
            train.evidence.validFrom <= current &&
            current <= train.evidence.validUntil,
        ),
      }))
      .filter((corridor) => corridor.trains.length);
  };
  return {
    get capability() {
      const available = active();
      return {
        id: 'osm-local',
        label: 'OSM 本地线路参考',
        available: true,
        coverage: available.length
          ? available
              .map(
                (corridor) =>
                  `${corridor.name}：${corridor.trains.map((train) => `${train.number}（${train.stops.filter((name) => corridor.stations.some((stop) => stop.name === name)).join('、')}之间同向子区间）`).join('；')}`,
              )
              .join('；')
          : data?.corridors.some((corridor) => corridor.trains.length)
            ? '线路映射未生效或已到期，重新核实前使用停站示意'
            : '暂未收录已核实线路，可使用停站示意',
        requiresConfirmation: true,
        autoRefresh: false,
        dataVersion: available.length ? data.dataVersion : null,
      };
    },
    resolve({ number, selectedSchedule, schedule }) {
      if (!schedule || !selectedSchedule)
        throw unavailable('OSM 本地线路参考需要先核对该车次的完整停站表。');
      const candidates = active().flatMap((corridor) =>
        corridor.trains
          .filter((train) => train.number === number)
          .map((train) => ({ corridor, train })),
      );
      const matched = candidates.filter(({ corridor, train }) => {
        const names = selectedSchedule.stops.map((stop) => stop.name);
        const from = train.stops.indexOf(names[0]);
        return (
          names.length >= 2 &&
          from >= 0 &&
          names.join('|') ===
            train.stops.slice(from, from + names.length).join('|') &&
          train.stops.join('|') ===
            schedule.stops.map((stop) => stop.name).join('|') &&
          names.every((name) =>
            corridor.stations.some((stop) => stop.name === name),
          )
        );
      });
      if (matched.length !== 1)
        throw unavailable(
          '此车次或所选区间未通过 OSM 线路白名单核对，改用可确认的停站示意。',
        );
      const { corridor, train } = matched[0];
      const stops = selectedSchedule.stops.map((stop) => ({
        ...stop,
        coord: [
          ...corridor.stations.find((station) => station.name === stop.name)
            .coord,
        ],
      }));
      const route = latestJourney(
        {
          stations: corridor.stations,
          coordinates: corridor.coordinates,
          gaps: [],
        },
        stops,
        null,
      );
      if (route.stops.some((stop) => !stop.routeMatched))
        throw unavailable('所选停站不能完整匹配 OSM 区间，暂不使用轨道参考。');
      const routeNote = `OSM 线路参考：${corridor.name}，轨道资料日期 ${data.sourceDate}，车次映射核对有效至 ${train.evidence.validUntil}；根据独立车次资料和本次停站核对，仅表示参考线路，不是乘车当日实测轨迹，请预览确认。`;
      return {
        ...route,
        from: stops[0],
        to: stops.at(-1),
        quality: 'corridor',
        via: stops
          .slice(1, -1)
          .map((stop) => stop.name)
          .join('、'),
        routeSource: `OpenStreetMap · ${corridor.name}`,
        routeSourceUrl: corridor.evidence.geometry.url,
        routeNote,
        routeFetchedAt: null,
        routeProvider: 'osm-local',
        routeDataVersion: data.dataVersion,
        routeEvidence: {
          geometry: structuredClone(corridor.evidence.geometry),
          service: structuredClone(train.evidence),
          corridorId: corridor.id,
          license: data.license,
          attribution: '© OpenStreetMap contributors',
        },
        requiresConfirmation: true,
        resolution: {
          state: 'needs-confirmation',
          code: 'OSM_CONFIRMATION_REQUIRED',
          message: routeNote,
          requiresConfirmation: true,
        },
      };
    },
  };
}
