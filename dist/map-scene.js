import { measureStage } from './performance.js';
import * as ML from './vendor/maplibre-gl.mjs';
import * as T from './vendor/three.module.js';
import { flightArc } from './core.js';
import { canRenderRoute } from './domain.js';
const isPoint = (p) =>
  Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
import { mercatorPoint } from './camera-fit.js';
export const baseStyle = {
  version: 8,
  sources: {
    land: {
      type: 'geojson',
      data: '/data/countries.geojson',
      attribution:
        '线路来源见行程详情 · © Natural Earth · 路网 © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>',
    },
    rail: { type: 'geojson', data: '/data/rail-network.geojson' },
  },
  layers: [
    {
      id: 'water',
      type: 'background',
      paint: { 'background-color': '#dbeefa' },
    },
    {
      id: 'land',
      type: 'fill',
      source: 'land',
      paint: { 'fill-color': '#f5fafe' },
    },
    {
      id: 'borders',
      type: 'line',
      source: 'land',
      paint: {
        'line-color': '#afcbdc',
        'line-width': 0.65,
        'line-opacity': 0.65,
      },
    },
    {
      id: 'rail-network',
      type: 'line',
      source: 'rail',
      paint: {
        'line-color': '#8db4cb',
        'line-width': 0.55,
        'line-opacity': 0.42,
      },
    },
  ],
};
export function tripRouteLines(trip) {
  if (!canRenderRoute(trip)) return [];
  return trip.routeCoordinates?.length
    ? [trip.routeCoordinates]
    : (trip.legs || []).map((leg) => leg.coordinates);
}
export function tripCoordinates(trips) {
  return trips
    .flatMap((t) => [t.from?.coord, t.to?.coord, ...tripRouteLines(t).flat()])
    .filter(isPoint);
}
export function journeyBounds(trips) {
  const points = tripCoordinates(trips);
  if (!points.length) return null;
  const b = new ML.LngLatBounds(points[0], points[0]);
  points.forEach((p) => b.extend(p));
  return b;
}
const pointCache = new Map(),
  combinedPointCache = [];
let retainedPoints = 0,
  retainedCombinedPoints = 0;
const geometryStamp = (trip) =>
  [
    trip.mode,
    trip.routeRevision,
    trip.routeState,
    trip.routeConfirmed,
    trip.quality,
    trip.distance,
    trip.from?.coord?.join(','),
    trip.to?.coord?.join(','),
  ].join('|');
function flightGeometry(trip) {
  const path = flightArc(trip.from.coord, trip.to.coord).map(
      (c) => new T.Vector3(...mercatorPoint(c)),
    ),
    radius =
      mercatorPoint([...trip.from.coord, 1])[2] *
      Math.max(450, Math.min(5000, trip.distance * 3));
  return new T.TubeGeometry(
    new T.CatmullRomCurve3(path),
    100,
    radius,
    6,
    false,
  );
}
const pointCacheKey = (trip) =>
  (trip.routeCoordinates?.length && trip.routeCoordinates) ||
  (trip.legs?.length && trip.legs) ||
  trip.from?.coord ||
  trip;
function cachedTripPoints(key, stamp) {
  const cached = pointCache.get(key);
  if (cached?.stamp === stamp) {
    pointCache.delete(key);
    pointCache.set(key, cached);
    return cached.points;
  }
  if (cached) {
    retainedPoints -= cached.points.length;
    pointCache.delete(key);
  }
}
function rememberTripPoints(key, stamp, points) {
  if (points.length <= 600000) {
    const previous = pointCache.get(key);
    if (previous) retainedPoints -= previous.points.length;
    pointCache.delete(key);
    pointCache.set(key, { stamp, points });
    retainedPoints += points.length;
    while (pointCache.size > 512 || retainedPoints > 600000) {
      const oldest = pointCache.keys().next().value;
      retainedPoints -= pointCache.get(oldest).points.length;
      pointCache.delete(oldest);
    }
  }
  return points;
}
function tripWorldPoints(trip) {
  const key = pointCacheKey(trip),
    stamp = geometryStamp(trip),
    cached = cachedTripPoints(key, stamp);
  if (cached) return cached;
  let points;
  if (trip.mode === 'flight' && canRenderRoute(trip)) {
    const tube = flightGeometry(trip),
      position = tube.getAttribute('position');
    points = Array.from({ length: position.count }, (_, i) => [
      position.getX(i),
      position.getY(i),
      position.getZ(i),
    ]);
    tube.dispose();
  } else points = tripCoordinates([trip]).map(mercatorPoint);
  return rememberTripPoints(key, stamp, points);
}
function cachedCombinedPoints(parts) {
  if (parts.length === 1) return parts[0];
  const index = combinedPointCache.findIndex(
    (entry) =>
      entry.parts.length === parts.length &&
      entry.parts.every((part, i) => part === parts[i]),
  );
  if (index >= 0) {
    const [entry] = combinedPointCache.splice(index, 1);
    combinedPointCache.push(entry);
    return entry.points;
  }
}
function rememberCombinedPoints(parts, points) {
  if (points.length <= 600000) {
    combinedPointCache.push({ parts, points });
    retainedCombinedPoints += points.length;
    while (combinedPointCache.length > 16 || retainedCombinedPoints > 600000)
      retainedCombinedPoints -= combinedPointCache.shift().points.length;
  }
  return points;
}
export function journeyWorldPoints(trips) {
  const parts = trips.map(tripWorldPoints);
  return (
    cachedCombinedPoints(parts) || rememberCombinedPoints(parts, parts.flat())
  );
}
// Video preparation retains every original coordinate and uses the same bounded
// caches as the synchronous map path. Only incomplete work stays local on abort.
export async function prepareJourneyWorldPoints(
  trips,
  {
    signal,
    budgetMs = 8,
    now = () => performance.now(),
    yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)),
  } = {},
) {
  signal?.throwIfAborted();
  let start = now(),
    visited = 0;
  const checkpoint = async () => {
    signal?.throwIfAborted();
    if (now() - start >= budgetMs) {
      await yieldControl();
      signal?.throwIfAborted();
      start = now();
    }
  };
  const parts = [];
  for (const trip of trips) {
    const key = pointCacheKey(trip),
      stamp = geometryStamp(trip),
      cached = cachedTripPoints(key, stamp);
    if (cached) parts.push(cached);
    else if (trip.mode === 'flight' && canRenderRoute(trip))
      parts.push(tripWorldPoints(trip));
    else {
      const points = [];
      for (const line of [
        [trip.from?.coord, trip.to?.coord],
        ...tripRouteLines(trip),
      ])
        for (const point of line) {
          if (isPoint(point)) points.push(mercatorPoint(point));
          if (++visited % 1024 === 0) await checkpoint();
        }
      signal?.throwIfAborted();
      parts.push(rememberTripPoints(key, stamp, points));
    }
    await checkpoint();
  }
  const combined = cachedCombinedPoints(parts);
  if (combined) return combined;
  const points = [];
  for (const part of parts)
    for (const point of part) {
      points.push(point);
      if (++visited % 1024 === 0) await checkpoint();
    }
  signal?.throwIfAborted();
  return rememberCombinedPoints(parts, points);
}
const flightLayers = new WeakMap();
function updateFlightLayer(map, trips, onProjection) {
  let state = flightLayers.get(map);
  if (!state || !map.getLayer('flight-arcs-3d')) {
    const scene = new T.Scene(),
      camera = new T.Camera(),
      projection = new T.Matrix4();
    state = { scene, meshes: new Map(), onProjection };
    flightLayers.set(map, state);
    let renderer;
    map.addLayer({
      id: 'flight-arcs-3d',
      type: 'custom',
      renderingMode: '3d',
      onAdd(m, gl) {
        renderer = new T.WebGLRenderer({
          canvas: m.getCanvas(),
          context: gl,
          antialias: true,
        });
        renderer.autoClear = false;
      },
      render(gl, options) {
        projection.fromArray(options.defaultProjectionData.mainMatrix);
        camera.projectionMatrix.copy(projection);
        renderer.resetState();
        renderer.render(scene, camera);
        state.onProjection(projection);
      },
      onRemove() {
        for (const { mesh } of state.meshes.values()) {
          mesh.geometry.dispose();
          mesh.material.dispose();
        }
        state.meshes.clear();
        scene.clear();
        renderer?.dispose();
        if (flightLayers.get(map) === state) flightLayers.delete(map);
      },
    });
  }
  state.onProjection = onProjection;
  const keep = new Set();
  trips.forEach((trip, i) => {
    if (trip.mode !== 'flight' || !canRenderRoute(trip)) return;
    const key = trip.id || i,
      stamp = geometryStamp(trip),
      previous = state.meshes.get(key);
    keep.add(key);
    if (previous?.stamp === stamp) return;
    if (previous) {
      state.scene.remove(previous.mesh);
      previous.mesh.geometry.dispose();
      previous.mesh.material.dispose();
    }
    const mesh = new T.Mesh(
      flightGeometry(trip),
      new T.MeshBasicMaterial({
        color: '#8290cf',
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      }),
    );
    state.scene.add(mesh);
    state.meshes.set(key, { stamp, mesh });
  });
  for (const [key, { mesh }] of state.meshes)
    if (!keep.has(key)) {
      state.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      state.meshes.delete(key);
    }
}
export function installJourneyLayers(map, trips, onProjection = () => {}) {
  return measureStage('layers', () =>
    updateJourneyLayers(map, trips, onProjection),
  );
}
function updateJourneyLayers(map, trips, onProjection) {
  const lines = [],
    dots = [];
  for (const t of trips) {
    for (const coordinates of tripRouteLines(t))
      if (coordinates?.length > 1)
        lines.push({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates },
        });
    for (const s of canRenderRoute(t)
      ? t.stops || [t.from, t.to]
      : [t.from, t.to])
      if (isPoint(s?.coord) && s.routeMatched !== false)
        dots.push({
          type: 'Feature',
          properties: { name: s.name },
          geometry: { type: 'Point', coordinates: s.routeCoord || s.coord },
        });
  }
  const geo = { type: 'FeatureCollection', features: lines },
    points = { type: 'FeatureCollection', features: dots };
  if (!map.getSource('journeys')) {
    map.addSource('journeys', { type: 'geojson', data: geo });
    map.addLayer({
      id: 'journey-glow',
      type: 'line',
      source: 'journeys',
      paint: {
        'line-color': '#248ebd',
        'line-width': 10,
        'line-opacity': 0.12,
      },
    });
    map.addLayer({
      id: 'journey-lines',
      type: 'line',
      source: 'journeys',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#248ebd', 'line-width': 3.2 },
    });
    map.addSource('journey-stops', { type: 'geojson', data: points });
    map.addLayer({
      id: 'journey-dots',
      type: 'circle',
      source: 'journey-stops',
      paint: {
        'circle-radius': 4,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#2995be',
        'circle-stroke-width': 2,
      },
    });
  } else {
    map.getSource('journeys').setData(geo);
    map.getSource('journey-stops').setData(points);
  }
  updateFlightLayer(map, trips, onProjection);
}

export function avatarPixel(map, avatar, projection) {
  if (!avatar?.coord || !projection) return null;
  const c = ML.MercatorCoordinate.fromLngLat(
      avatar.coord,
      avatar.altitude || 0,
    ),
    p = new T.Vector4(c.x, c.y, c.z, 1).applyMatrix4(projection),
    w = map.getContainer().clientWidth,
    h = map.getContainer().clientHeight;
  const x = ((p.x / p.w + 1) * w) / 2,
    y = ((1 - p.y / p.w) * h) / 2;
  return p.w > 0 && x >= 0 && x <= w && y >= 0 && y <= h ? { x, y } : null;
}
