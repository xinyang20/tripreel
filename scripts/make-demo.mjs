import { writeFile } from 'node:fs/promises';
import { chinaToday, addDays } from '../dist/core.js';
const api = async (path, body) => {
  const r = await fetch('http://127.0.0.1:4173' + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error);
  return d;
};
const date = chinaToday(),
  rail = await api(`/api/train?number=G2&date=${date}`),
  air = await api(`/api/flight?number=CA1831&date=${addDays(date, 2)}`);
const stops = rail.stops,
  route = await api('/api/route', {
    mode: 'train',
    number: 'G2',
    date,
    from: stops[0].name,
    to: stops.at(-1).name,
    via: stops
      .slice(1, -1)
      .map((s) => s.name)
      .join('、'),
  });
const flight = air.flights[0],
  airRoute = await api('/api/route', {
    mode: 'flight',
    from: flight.from.code,
    to: flight.to.code,
  });
const trips = [
  {
    id: 'demo-train',
    mode: 'train',
    number: rail.number,
    departure: stops[0].departure,
    arrival: stops.at(-1).arrival,
    ...route,
    stops: route.stops.map((s, i) => ({
      ...s,
      departure: stops[i].departure,
      arrival: stops[i].arrival,
    })),
    source: '12306 · 示例快照',
  },
  {
    id: 'demo-flight',
    mode: 'flight',
    ...flight,
    ...airRoute,
    source: '航旅纵横 · 示例快照',
  },
];
await writeFile(
  'dist/data/demo.json',
  JSON.stringify({ fetchedAt: new Date().toISOString(), trips }),
);
console.log(
  JSON.stringify(
    trips.map((t) => ({
      number: t.number,
      quality: t.quality,
      stops: t.stops.length,
      km: t.distance,
      warnings: t.warnings,
    })),
  ),
);
