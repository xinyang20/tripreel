import { gcj02ToWgs84 } from './coord-transform.js';
import { coordinate, distance, lineLength } from '../dist/core.js';
const convert = (p) => {
  if (!Array.isArray(p) || p.length !== 2)
    throw new Error('线路坐标格式错误。');
  coordinate(p);
  const c = gcj02ToWgs84(p[0], p[1]);
  return [c.lng, c.lat];
};
export function referenceStations(data) {
  if (!data?.success || !Array.isArray(data.data?.stations))
    throw new Error('该车次没有可用的线路参考。');
  return data.data.stations.map((s) => {
    if (!s || typeof s !== 'object' || Array.isArray(s))
      throw new Error('车站坐标格式错误。');
    const entries = Object.entries(s);
    if (entries.length !== 1 || !entries[0][0].trim())
      throw new Error('车站坐标格式错误');
    return { name: entries[0][0], coord: convert(entries[0][1]) };
  });
}
export function assertBoardingStops(schedule, from, to) {
  if (!schedule) return;
  const a = schedule.stops.findIndex((s) => s.name === from),
    b = schedule.stops.findIndex((s) => s.name === to);
  if (a < 0 || b < 0)
    throw new Error(
      `${schedule.latest ? '最新线路的' : '该日期的'} ${schedule.number} 不停靠“${a < 0 ? from : to}”，请查询并选择实际停靠站。`,
    );
  if (a >= b)
    throw new Error('起止站顺序与该车次运行方向不符，请核对车次或交换起止站。');
}
export function referenceGeometry(data) {
  if (
    !data?.success ||
    !Array.isArray(data.data?.stations) ||
    !data.data?.train
  )
    throw new Error('该车次没有可用的线路参考。');
  const stations = referenceStations(data);
  const segments = Object.values(data.data.train);
  if (
    segments.some(
      (segment) => !segment || !Number.isFinite(Number(segment.index)),
    )
  )
    throw new Error('线路片段次序异常。');
  segments.sort((a, b) => Number(a.index) - Number(b.index));
  if (!segments.length)
    throw new Error('线路源仅返回停靠站，尚未提供该车次的轨道坐标。');
  const coordinates = [],
    gaps = [];
  for (const s of segments) {
    if (!Array.isArray(s.line) || s.line.length < 2)
      throw new Error('线路片段不完整。');
    if (coordinates.length + s.line.length > 100000)
      throw new Error('线路坐标数量异常。');
    let line = s.line.map(convert);
    if (!coordinates.length) {
      coordinates.push(...line);
      continue;
    }
    if (
      distance(coordinates.at(-1), line.at(-1)) <
      distance(coordinates.at(-1), line[0])
    )
      line = line.reverse();
    const gap = distance(coordinates.at(-1), line[0]);
    if (gap > 0.25) {
      gaps.push({
        start: coordinates.length - 1,
        end: coordinates.length,
        km: gap,
      });
      coordinates.push(...line);
    } else coordinates.push(...line.slice(1));
  }
  if (coordinates.length < 2 || coordinates.length > 100000)
    throw new Error('线路坐标数量异常。');
  if (
    stations.length &&
    distance(coordinates[0], stations[0].coord) >
      distance(coordinates.at(-1), stations[0].coord)
  ) {
    coordinates.reverse();
    for (const gap of gaps) {
      const start = gap.start;
      gap.start = coordinates.length - 1 - gap.end;
      gap.end = coordinates.length - 1 - start;
    }
    gaps.sort((a, b) => a.start - b.start);
  }
  return { stations, coordinates, gaps };
}
export function snapToLine(p, line, minIndex = 0, gaps = []) {
  let best = { distance: Infinity, index: -1, coord: null };
  for (let i = Math.max(0, Math.floor(minIndex)); i < line.length - 1; i++) {
    if (gaps.some((g) => i >= g.start && i < g.end)) continue;
    const a = line[i],
      b = line[i + 1],
      cos = Math.cos((p[1] * Math.PI) / 180),
      dx = (b[0] - a[0]) * cos,
      dy = b[1] - a[1],
      t = Math.max(
        0,
        minIndex - i,
        Math.min(
          1,
          ((p[0] - a[0]) * cos * dx + (p[1] - a[1]) * dy) /
            (dx * dx + dy * dy || 1),
        ),
      ),
      c = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      d = distance(p, c);
    if (d < best.distance) best = { distance: d, index: i + t, coord: c };
  }
  return best;
}
function sliceLine(start, end, line) {
  if (!start.coord || !end.coord || end.index <= start.index)
    throw new Error('站点顺序与当前线路不符。');
  const coordinates = [
    start.coord,
    ...line.slice(Math.floor(start.index) + 1, Math.ceil(end.index)),
    end.coord,
  ];
  return { coordinates, km: lineLength(coordinates) };
}
export function referenceLeg(a, b, line) {
  const start = snapToLine(a, line),
    end = snapToLine(b, line);
  if (start.distance > 2 || end.distance > 2)
    throw new Error('站点不在当前车次运行线上。');
  return sliceLine(start, end, line);
}

export function latestJourney(reference, stops, schedule) {
  const positions = new Map(),
    indexedPositions = new Map();
  let cursor = 0;
  for (const [stationIndex, station] of reference.stations.entries()) {
    const position = snapToLine(
      station.coord,
      reference.coordinates,
      cursor,
      reference.gaps,
    );
    if (position.distance <= 2) {
      indexedPositions.set(stationIndex, position);
      const sameName = positions.get(station.name) || [];
      sameName.push(position);
      positions.set(station.name, sameName);
      cursor = position.index;
    }
  }
  const knownPosition = (station) =>
    Number.isInteger(station.referenceStopIndex)
      ? indexedPositions.get(station.referenceStopIndex)
      : positions.get(station.name)?.length === 1
        ? positions.get(station.name)[0]
        : undefined;
  const start =
      knownPosition(stops[0]) ||
      snapToLine(stops[0].coord, reference.coordinates, 0, reference.gaps),
    end =
      knownPosition(stops.at(-1)) ||
      snapToLine(stops.at(-1).coord, reference.coordinates, 0, reference.gaps);
  if (start.distance > 2 || end.distance > 2)
    throw new Error('起止站不在最新车次线路上，请核对地点。');
  const crossedGap = reference.gaps?.find(
    (g) => Math.max(start.index, g.start) < Math.min(end.index, g.end) - 1e-8,
  );
  if (crossedGap)
    throw new Error(
      `乘坐区间内的线路数据存在约 ${Math.round(crossedGap.km * 1000)} 米缺口，请等待线路源补全后重试。`,
    );
  const whole = sliceLine(start, end, reference.coordinates),
    warnings = [];
  const stopsMatched = Boolean(
    schedule &&
    reference.stations.map((s) => s.name).join('|') ===
      schedule.stops.map((s) => s.name).join('|'),
  );
  if (schedule && !stopsMatched)
    warnings.push('停站表与最新线路不同，已采用最新线路；时刻仅供参考。');
  const projected = stops.map((s) => ({ ...s, routeMatched: false }));
  let previous = -1;
  for (let i = 0; i < projected.length; i++) {
    const s = projected[i];
    if (!s.coord) {
      warnings.push(`${s.name}缺少坐标，未用于线路定位。`);
      continue;
    }
    const known = knownPosition(s),
      snap =
        known ||
        snapToLine(
          s.coord,
          reference.coordinates,
          Math.max(start.index, previous),
          reference.gaps,
        );
    if (
      snap.distance > 2 ||
      snap.index < start.index ||
      snap.index > end.index ||
      snap.index <= previous
    ) {
      warnings.push(`${s.name}未匹配当前乘坐区间，未用于线路定位。`);
      continue;
    }
    previous = snap.index;
    s.routeCoord = snap.coord;
    s.routeIndex = snap.index;
    s.routeMatched = true;
  }
  const legs = [];
  for (let i = 0; i < projected.length - 1; i++) {
    const a = projected[i],
      b = projected[i + 1];
    let leg = { coordinates: null, from: a.name, to: b.name };
    if (a.routeMatched && b.routeMatched) {
      try {
        leg = {
          ...leg,
          ...sliceLine(
            { coord: a.routeCoord, index: a.routeIndex },
            { coord: b.routeCoord, index: b.routeIndex },
            reference.coordinates,
          ),
        };
      } catch {}
    }
    legs.push(leg);
  }
  return {
    stops: projected,
    legs,
    routeCoordinates: whole.coordinates,
    distance: whole.km,
    routeTiming: legs.some((l) => !l.coordinates) ? 'continuous' : 'stops',
    quality: 'latest',
    stopsMatched,
    warnings,
    routePolicy: 'latest-v2',
  };
}
