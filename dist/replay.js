import { flightArc, along, distance, parseTime } from './core.js';
import { canReplay } from './domain.js';

export function buildTimeline(trips) {
  trips = trips.filter(canReplay);
  const items = [];
  let duration = 0;
  trips.forEach((trip, i) => {
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
    begin = parseTime(t.departure),
    end = parseTime(t.arrival),
    stamp = begin + f * (end - begin),
    label = t.number;
  if (t.mode === 'flight') {
    const arc = flightArc(t.from.coord, t.to.coord, 120),
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
    return { coord: along(t.routeCoordinates, f), stamp, label };
  const weights = t.legs.map((l) => l.km || 1),
    sum = weights.reduce((a, b) => a + b, 0);
  let fractionDone = 0;
  for (let i = 0; i < t.stops.length - 1; i++) {
    const a = t.stops[i],
      b = t.stops[i + 1],
      start = a.departure
        ? parseTime(a.departure)
        : begin + (fractionDone / sum) * (end - begin);
    fractionDone += weights[i] || 1;
    const finish = b.arrival
      ? parseTime(b.arrival)
      : begin + (fractionDone / sum) * (end - begin);
    if (stamp < start) return { coord: a.routeCoord || a.coord, stamp, label };
    if (stamp <= finish) {
      const c = t.legs[i]?.coordinates;
      return {
        coord: c ? along(c, (stamp - start) / (finish - start || 1)) : null,
        stamp,
        label,
      };
    }
  }
  return { coord: t.to.coord, stamp, label };
}
export function replayFrame(timeline, progress) {
  if (!timeline.items.length) return null;
  const item =
      timeline.items.find((x) => progress * timeline.duration <= x.to) ||
      timeline.items.at(-1),
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
