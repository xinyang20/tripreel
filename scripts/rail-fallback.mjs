import { referenceStations, latestJourney } from './rail-geometry.mjs';
import { coordinate, distance, lineLength } from '../dist/core.js';
import { TravelError } from './request-scheduler.mjs';

// Only the verified shared corridor is eligible; the rest of G813 runs on different lines.
const jinghuStops = [
  '天津南',
  '济南西',
  '曲阜东',
  '徐州东',
  '宿州东',
  '南京南',
];
export function sharedCorridorPlan(number, from, to) {
  if (number !== 'G813') return null;
  const a = jinghuStops.indexOf(from),
    b = jinghuStops.indexOf(to);
  return a >= 0 && b > a
    ? { number, donor: 'G1', name: '京沪高铁', stops: jinghuStops }
    : null;
}
export function sharedCorridorReference(
  plan,
  targetMap,
  donor,
  latestTimetable,
) {
  const names = latestTimetable?.data?.timetable?.map((s) => s.station) || [];
  const a = names.indexOf(plan.stops[0]),
    b = names.indexOf(plan.stops.at(-1));
  if (
    !latestTimetable?.success ||
    a < 0 ||
    b < a ||
    names.slice(a, b + 1).join('|') !== plan.stops.join('|')
  )
    throw new Error('最新停站已变化，暂不能采用已核对的共线区间。');
  const byName = new Map(referenceStations(targetMap).map((s) => [s.name, s]));
  const stations = plan.stops.map((name) => byName.get(name));
  if (stations.some((s) => !s))
    throw new Error('共线区间缺少可核对的车站坐标。');
  const reference = { ...donor, stations };
  const check = latestJourney(reference, stations, null);
  if (
    check.stops.some((s) => !s.routeMatched) ||
    check.distance < 880 ||
    check.distance > 930
  )
    throw new Error('共线区间的轨道或站点发生变化，暂不采用。');
  return {
    ...reference,
    provenance: {
      quality: 'corridor',
      routeSource: 'RailGo · 京沪高铁共线区间',
      routeSourceUrl: 'https://railgo.dev/',
      routeNote: `${plan.name}共线区间参考（${plan.donor} 线路）；不是乘车当日实测轨迹。`,
    },
  };
}

export function selectStopInterval(
  stops,
  from,
  to,
  { fromStopIndex, toStopIndex } = {},
) {
  if (
    !Array.isArray(stops) ||
    stops.some(
      (stop) => !stop || typeof stop.name !== 'string' || !stop.name.trim(),
    )
  )
    throw new TravelError('STOPS_INVALID', '停站表格式不完整，暂不能采用。');
  const starts = stops.flatMap((stop, index) =>
    stop.name === from ? [index] : [],
  );
  const ends = stops.flatMap((stop, index) =>
    stop.name === to ? [index] : [],
  );
  const pairs = starts.flatMap((start) =>
    ends.filter((end) => end > start).map((end) => [start, end]),
  );
  if (fromStopIndex !== undefined || toStopIndex !== undefined) {
    if (
      !Number.isInteger(fromStopIndex) ||
      !Number.isInteger(toStopIndex) ||
      !pairs.some(
        ([start, end]) => start === fromStopIndex && end === toStopIndex,
      )
    )
      throw new TravelError(
        'STOP_SELECTION_CHANGED',
        '所选站次与当前停站表不符，请重新查询后选择上下车站。',
      );
    return {
      stops: stops.slice(fromStopIndex, toStopIndex + 1),
      fromStopIndex,
      toStopIndex,
    };
  }
  if (pairs.length !== 1) {
    const error = new TravelError(
      pairs.length ? 'STOP_AMBIGUOUS' : 'STOP_MISMATCH',
      pairs.length
        ? '停站表中同名站出现多次，请选择具体上下车站次。'
        : '起止站不属于该车次的同向运行区间，请核对后再选择。',
    );
    error.candidates = pairs.map(([start, end]) => ({
      fromStopIndex: start,
      toStopIndex: end,
      from: stops[start].name,
      to: stops[end].name,
      departure: stops[start].departure || null,
      arrival: stops[end].arrival || null,
    }));
    throw error;
  }
  const [start, end] = pairs[0];
  return {
    stops: stops.slice(start, end + 1),
    fromStopIndex: start,
    toStopIndex: end,
  };
}

// Arrays are already WGS84. The old RailGo-shaped argument remains supported,
// and only that adapter performs GCJ-02 conversion.
export function stationCurveReference(input, provenance = {}) {
  const stations = Array.isArray(input)
    ? input.map((stop) => ({ ...stop, coord: stop.coord && [...stop.coord] }))
    : referenceStations(input);
  if (stations.length < 2 || stations.length > 82)
    throw new Error('缺少停靠站，暂时无法生成停站连线。');
  for (const stop of stations) {
    if (!stop.name || !stop.coord)
      throw new TravelError(
        'STOP_COORDINATE_MISSING',
        `“${stop.name || '未命名站'}”缺少可靠坐标，请补全后再生成停站示意线。`,
      );
    coordinate(stop.coord);
  }
  const coordinates = [],
    legRanges = [];
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i].coord,
      b = stations[i + 1].coord,
      previous = stations[i - 1]?.coord,
      next = stations[i + 2]?.coord;
    const tangent = (point, other, neighbor, sign) => {
      const direction = neighbor
        ? [other[0] - neighbor[0], other[1] - neighbor[1]]
        : [other[0] - point[0], other[1] - point[1]];
      const length = Math.hypot(...direction),
        step = Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.18;
      return length
        ? point.map(
            (value, j) => value + ((sign * direction[j]) / length) * step,
          )
        : point;
    };
    if (distance(a, b) < 0.01)
      throw new TravelError(
        'STOPS_INVALID',
        '相邻停站位置重合，请核对停站表。',
      );
    const clampControl = (point) =>
      point.map((value, k) =>
        Math.max(Math.min(a[k], b[k]), Math.min(Math.max(a[k], b[k]), value)),
      );
    const c = clampControl(tangent(a, b, previous, 1)),
      d = clampControl(tangent(b, a, next, 1)),
      samples = Math.max(12, Math.min(100, Math.ceil(distance(a, b) / 4)));
    if (!coordinates.length) coordinates.push(a);
    const start = coordinates.length - 1;
    for (let j = 1; j <= samples; j++) {
      const t = j / samples,
        u = 1 - t;
      coordinates.push(
        j === samples
          ? b
          : [0, 1].map(
              (k) =>
                u * u * u * a[k] +
                3 * u * u * t * c[k] +
                3 * u * t * t * d[k] +
                t * t * t * b[k],
            ),
      );
    }
    legRanges.push([start, coordinates.length - 1]);
  }
  return {
    stations,
    coordinates,
    legRanges,
    gaps: [],
    useLatestStops: true,
    provenance: {
      quality: 'station-schematic',
      routeSource: 'RailGo · 最新停靠站',
      routeSourceUrl: 'https://railgo.dev/',
      routeNote: '停站连线示意：按最新停靠站生成曲线，尚无真实轨道数据。',
      ...provenance,
    },
  };
}

export function stationSchematicJourney(stops, provenance = {}) {
  const reference = stationCurveReference(stops, provenance);
  const legs = reference.legRanges.map(([start, end], i) => {
    const coordinates = reference.coordinates.slice(start, end + 1);
    return {
      from: stops[i].name,
      to: stops[i + 1].name,
      coordinates,
      km: lineLength(coordinates),
    };
  });
  return {
    from: stops[0],
    to: stops.at(-1),
    stops: stops.map((stop, i) => ({
      ...stop,
      routeMatched: true,
      routeCoord: stop.coord,
      routeIndex: i ? reference.legRanges[i - 1][1] : 0,
    })),
    legs,
    routeCoordinates: reference.coordinates,
    distance: lineLength(reference.coordinates),
    routeTiming: 'stops',
    routePolicy: 'latest-v2',
    ...reference.provenance,
    requiresConfirmation: true,
    resolution: {
      state: 'needs-confirmation',
      code: 'SCHEMATIC_CONFIRMATION_REQUIRED',
      message: reference.provenance.routeNote,
      requiresConfirmation: true,
    },
  };
}
