import { measureAsyncStage } from './performance.js';
// Canvas labels use the 1280×720 layout; map fitting scales the same exclusions.
const blockers = [
  { left: 25, top: 25, right: 650, bottom: 125 },
  { left: 25, top: 600, right: 1255, bottom: 720 },
];
export function videoViewportBlockers(scale = 1) {
  return blockers.map((rect) =>
    Object.fromEntries(
      Object.entries(rect).map(([edge, value]) => [edge, value * scale]),
    ),
  );
}

export const videoShotKey = (trips) =>
  JSON.stringify(trips.map((trip) => trip.id));

export function videoAttribution(trips) {
  const lines = [
    '底图 © Natural Earth · © OpenStreetMap contributors · https://www.openstreetmap.org/copyright',
  ];
  if (
    trips.some(
      (trip) =>
        /^OpenStreetMap/.test(trip.routeSource || '') ||
        (trip.routeProvider === 'osm-local' &&
          trip.quality === 'corridor' &&
          Boolean(trip.routeDataVersion)),
    )
  )
    lines.push(
      '线路 © OpenStreetMap contributors · ODbL · https://www.openstreetmap.org/copyright',
    );
  if (
    trips.some(
      (trip) =>
        /^RailGo/.test(trip.routeSource || '') ||
        (!trip.routeSource &&
          trip.routeProvider === 'railgo' &&
          ['latest', 'corridor'].includes(trip.quality)),
    )
  )
    lines.push('线路 RailGo · https://railgo.dev/');
  return lines;
}

// Prepare only camera descriptions. The caller applies a camera when its shot
// becomes visible; preparing hundreds of shots must not move the map hundreds
// of times. Yield regularly so cancellation and the progress UI remain usable.
export async function prepareVideoShots(
  trips,
  timeline,
  compute,
  {
    signal,
    budgetMs = 8,
    now = () => performance.now(),
    yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)),
  } = {},
) {
  const shots = new Map([[videoShotKey(trips), trips]]);
  for (const item of timeline.items) {
    const scope = item.type === 'gap' ? [item.trip, item.next] : [item.trip];
    shots.set(videoShotKey(scope), scope);
  }
  const cameras = new Map();
  if (globalThis.__tripreelPerformance)
    performance.mark('tripreel-video-preparation-start');
  let start = now();
  for (const [key, scope] of shots) {
    signal?.throwIfAborted();
    const camera = await measureAsyncStage('videoPrepareShot', () =>
      compute(scope),
    );
    signal?.throwIfAborted();
    cameras.set(key, camera);
    if (now() - start >= budgetMs) {
      await yieldControl();
      signal?.throwIfAborted();
      start = now();
    }
  }
  signal?.throwIfAborted();
  if (globalThis.__tripreelPerformance)
    performance.mark('tripreel-video-preparation-end');
  return cameras;
}
