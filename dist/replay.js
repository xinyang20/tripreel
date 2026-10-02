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
    };
  if (trip.mode !== 'flight') {
    if (trip.routeCoordinates?.length)
      routeIndex(trip.routeCoordinates, trip.routeRevision);
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
      index = f * 120,
      a = arc[Math.floor(index)],
      b = arc[Math.ceil(index)],
      p = index % 1;
    return {
      coord: [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p],
      altitude: a[2] + (b[2] - a[2]) * p,
      stamp,
      label,
    };
  }
  if (
    t.routeCoordinates?.length &&
    (t.routeTiming === 'continuous' || !t.legs?.length)
  )
    return {
      coord: alongIndex(routeIndex(t.routeCoordinates, t.routeRevision), f),
      stamp,
      label,
    };
  for (const { start, finish, stop, coordinates } of prepared.intervals) {
    if (stamp < start)
      return { coord: stop.routeCoord || stop.coord, stamp, label };
    if (stamp <= finish)
      return {
        coord: coordinates
          ? alongIndex(
              routeIndex(coordinates, t.routeRevision),
              (stamp - start) / (finish - start || 1),
            )
          : null,
        stamp,
        label,
      };
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
      icon: '🧑‍🚀',
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
    icon: trip.mode === 'train' ? '🚄' : '✈️',
  };
}
