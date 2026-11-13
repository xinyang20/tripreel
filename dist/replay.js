import {
  flightArc,
  lineIndex,
  alongIndex,
  distance,
  parseTime,
} from './core.js';
import { canReplay } from './domain.js';

const indexes = new Map();
let indexedPoints = 0;
function routeIndex(coordinates, revision) {
  let entry = indexes.get(coordinates);
  if (
    entry &&
    entry.revision === revision &&
    entry.index.cumulative.length === coordinates.length
  ) {
    indexes.delete(coordinates);
    indexes.set(coordinates, entry);
    return entry.index;
  }
  if (entry) {
    indexedPoints -= entry.index.cumulative.length;
    indexes.delete(coordinates);
  }
  entry = { revision, index: lineIndex(coordinates) };
  if (coordinates.length <= 600000) {
    indexes.set(coordinates, entry);
    indexedPoints += coordinates.length;
    while (indexes.size > 512 || indexedPoints > 600000) {
      const oldest = indexes.keys().next().value;
      indexedPoints -= indexes.get(oldest).index.cumulative.length;
      indexes.delete(oldest);
    }
  }
  return entry.index;
}
// Share of each moving segment spent accelerating and braking. Trains depart and
// arrive at every timed stop; flights accelerate on take-off and slow on landing.
const TRAIN_RAMP = 0.2,
  FLIGHT_RAMP = 0.12;
export function easeTravel(u, ramp = TRAIN_RAMP) {
  const t = Math.max(0, Math.min(1, u));
  if (t > 0.5) return 1 - easeTravel(1 - t, ramp);
  const peak = 1 / (1 - ramp);
  return t < ramp ? (peak * t * t) / (2 * ramp) : peak * (t - ramp / 2);
}
const isPoint = (p) =>
  Array.isArray(p) &&
  p.length >= 2 &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]);
// Locate a stop on the ridden line, scanning forward so stops keep their order.
function projectForward(index, point, from) {
  const { coordinates, cumulative } = index,
    k = Math.cos((point[1] * Math.PI) / 180);
  let best = Infinity,
    found = null;
  for (let i = Math.max(1, from); i < coordinates.length; i++) {
    const a = coordinates[i - 1],
      b = coordinates[i],
      dx = (b[0] - a[0]) * k,
      dy = b[1] - a[1],
      px = (point[0] - a[0]) * k,
      py = point[1] - a[1],
      span = dx * dx + dy * dy,
      t = span ? Math.max(0, Math.min(1, (px * dx + py * dy) / span)) : 0,
      ex = px - t * dx,
      ey = py - t * dy,
      gap = ex * ex + ey * ey;
    if (gap < best) {
      best = gap;
      found = { segment: i, t };
    }
  }
  if (!found) return null;
  const { segment, t } = found,
    a = coordinates[segment - 1],
    b = coordinates[segment],
    snapped = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return {
    segment,
    along:
      cumulative[segment - 1] +
      (cumulative[segment] - cumulative[segment - 1]) * t,
    offset: distance(point, snapped),
  };
}
// Time and distance key frames along the whole ridden line. Only stops that were
// matched to the line and carry plausible times become dwell points; any other
// stop is ignored so it can neither cut the line nor invent a stop.
function trackSchedule(trip, index, begin, end) {
  const keys = [{ time: begin, along: 0 }];
  let cursor = 1;
  for (const stop of trip.stops || []) {
    if (stop.routeMatched === false) continue;
    const point = stop.routeCoord || stop.coord;
    let arrive = parseTime(stop.arrival),
      leave = parseTime(stop.departure);
    if (!Number.isFinite(arrive)) arrive = leave;
    if (!Number.isFinite(leave)) leave = arrive;
    if (
      !isPoint(point) ||
      !Number.isFinite(arrive) ||
      leave < arrive ||
      arrive <= begin ||
      leave >= end
    )
      continue;
    const last = keys.at(-1),
      hit = projectForward(index, point, cursor);
    if (!hit || hit.offset > 2 || hit.along < last.along || arrive < last.time)
      continue;
    keys.push(
      { time: arrive, along: hit.along },
      { time: leave, along: hit.along },
    );
    cursor = hit.segment;
  }
  keys.push({ time: end, along: index.length });
  return keys;
}
function scheduledAlong(keys, stamp) {
  if (stamp <= keys[0].time) return 0;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1],
      b = keys[i];
    if (stamp > b.time) continue;
    if (b.along === a.along) return a.along;
    return (
      a.along +
      (b.along - a.along) *
        easeTravel((stamp - a.time) / (b.time - a.time || 1))
    );
  }
  return keys.at(-1).along;
}
const preparedTrips = new WeakMap();
function prepareTrip(trip) {
  const signature = [
    trip.mode,
    trip.departure,
    trip.arrival,
    trip.routeTiming,
    trip.routeRevision,
    trip.from.coord.join(','),
    trip.to.coord.join(','),
  ].join('|');
  const cached = preparedTrips.get(trip);
  if (
    cached?.signature === signature &&
    cached.route === trip.routeCoordinates &&
    cached.legs === trip.legs &&
    cached.stops === trip.stops
  )
    return cached;
  const begin = parseTime(trip.departure),
    end = parseTime(trip.arrival),
    entry = {
      signature,
      route: trip.routeCoordinates,
      legs: trip.legs,
      stops: trip.stops,
      begin,
      end,
      arc:
        trip.mode === 'flight'
          ? flightArc(trip.from.coord, trip.to.coord, 120)
          : null,
      intervals: [],
      track: null,
    };
  if (trip.mode !== 'flight' && trip.routeCoordinates?.length > 1) {
    const index = routeIndex(trip.routeCoordinates, trip.routeRevision);
    if (index.length > 0)
      entry.track = { index, keys: trackSchedule(trip, index, begin, end) };
  }
  if (trip.mode !== 'flight' && !entry.track) {
    const legs = trip.legs || [],
      weights = legs.map((leg) => leg.km || 1),
      sum = weights.reduce((a, b) => a + b, 0);
    let done = 0;
    for (let i = 0; i < (trip.stops?.length || 0) - 1; i++) {
      const a = trip.stops[i],
        b = trip.stops[i + 1],
        start = a.departure
          ? parseTime(a.departure)
          : begin + (done / sum) * (end - begin);
      done += weights[i] || 1;
      entry.intervals.push({
        start,
        finish: b.arrival
          ? parseTime(b.arrival)
          : begin + (done / sum) * (end - begin),
        stop: a,
        coordinates: legs[i]?.coordinates,
      });
      if (legs[i]?.coordinates)
        routeIndex(legs[i].coordinates, trip.routeRevision);
    }
  }
  preparedTrips.set(trip, entry);
  return entry;
}

export function buildTimeline(trips) {
  trips = trips.filter(canReplay);
  const items = [];
  let duration = 0;
  trips.forEach((trip, i) => {
    prepareTrip(trip);
    if (i) {
      items.push({
        type: 'gap',
        from: duration,
        to: duration + 2,
        trip: trips[i - 1],
        next: trip,
      });
      duration += 2;
    }
    items.push({ type: 'trip', from: duration, to: duration + 22, trip });
    duration += 22;
  });
  return { items, duration };
}
export function tripPosition(trip, fraction) {
  const t = trip,
    f = Math.max(0, Math.min(1, fraction)),
    prepared = prepareTrip(t),
    { begin, end } = prepared,
    stamp = begin + f * (end - begin),
    label = t.number;
  if (t.mode === 'flight') {
    const arc = prepared.arc,
      travelled = easeTravel(f, FLIGHT_RAMP),
      index = travelled * 120,
      a = arc[Math.floor(index)],
      b = arc[Math.ceil(index)],
      p = index % 1;
    return {
      coord: [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p],
      altitude: a[2] + (b[2] - a[2]) * p,
      stamp,
      label,
      arc: { points: arc, fraction: travelled },
    };
  }
  if (prepared.track) {
    const { index, keys } = prepared.track,
      travelled = scheduledAlong(keys, stamp);
    return {
      coord: alongIndex(index, travelled / index.length),
      stamp,
      label,
      track: { index, along: travelled },
    };
  }
  for (const { start, finish, stop, coordinates } of prepared.intervals) {
    if (stamp < start)
      return { coord: stop.routeCoord || stop.coord, stamp, label };
    if (stamp <= finish) {
      const index = coordinates && routeIndex(coordinates, t.routeRevision),
        travelled = easeTravel((stamp - start) / (finish - start || 1));
      return {
        coord: index ? alongIndex(index, travelled) : null,
        stamp,
        label,
        ...(index && { track: { index, along: travelled * index.length } }),
      };
    }
  }
  return { coord: t.to.coord, stamp, label };
}
export function replayFrame(timeline, progress) {
  if (!timeline.items.length) return null;
  const elapsed = progress * timeline.duration;
  let lo = 0,
    hi = timeline.items.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (elapsed <= timeline.items[mid].to) hi = mid;
    else lo = mid + 1;
  }
  const item = timeline.items[lo],
    trip = item.trip;
  if (item.type === 'gap')
    return {
      item,
      trip,
      avatar: {
        coord: trip.to.coord,
        stamp: parseTime(trip.arrival),
        label: '停留 · 等待下一段',
      },
      title:
        distance(trip.to.coord, item.next.from.coord) > 0.5
          ? '下一段起点不同 · 中间交通未记录'
          : '停留后继续出发',
      places: [
        { ...trip.to, kind: trip.mode },
        { ...item.next.from, kind: item.next.mode },
      ],
    };
  return {
    item,
    trip,
    avatar: tripPosition(
      trip,
      (progress * timeline.duration - item.from) / (item.to - item.from),
    ),
    title: `${trip.number}　${trip.from.name} → ${trip.to.name}`,
    places: [
      { ...trip.from, kind: trip.mode },
      { ...trip.to, kind: trip.mode },
    ],
  };
}
