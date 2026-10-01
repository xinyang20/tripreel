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
        '线路 <a href="https://railgo.dev/" target="_blank">RailGo</a> · © Natural Earth · 路网 © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>',
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
const pointCache = new WeakMap();
export function journeyWorldPoints(trips) {
  return trips.flatMap((trip) => {
    if (pointCache.has(trip)) return pointCache.get(trip);
    let points;
    if (trip.mode === 'flight' && canRenderRoute(trip)) {
      const path = flightArc(trip.from.coord, trip.to.coord).map(
          (c) => new T.Vector3(...mercatorPoint(c)),
        ),
        radius =
          mercatorPoint([...trip.from.coord, 1])[2] *
          Math.max(450, Math.min(5000, trip.distance * 3));
      const tube = new T.TubeGeometry(
          new T.CatmullRomCurve3(path),
          100,
          radius,
          6,
          false,
        ),
        position = tube.getAttribute('position');
      points = Array.from({ length: position.count }, (_, i) => [
        position.getX(i),
        position.getY(i),
        position.getZ(i),
      ]);
      tube.dispose();
    } else points = tripCoordinates([trip]).map(mercatorPoint);
    pointCache.set(trip, points);
    return points;
  });
}
export function installJourneyLayers(map, trips, onProjection = () => {}) {
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
  if (map.getLayer('flight-arcs-3d')) map.removeLayer('flight-arcs-3d');
  const scene = new T.Scene(),
    camera = new T.Camera();
  let renderer;
  for (const t of trips.filter(
    (t) => t.mode === 'flight' && canRenderRoute(t),
  )) {
    const points = flightArc(t.from.coord, t.to.coord).map((c) => {
      const m = ML.MercatorCoordinate.fromLngLat(c, c[2]);
      return new T.Vector3(m.x, m.y, m.z);
    });
    const radius =
      ML.MercatorCoordinate.fromLngLat(
        t.from.coord,
      ).meterInMercatorCoordinateUnits() *
      Math.max(450, Math.min(5000, t.distance * 3));
    scene.add(
      new T.Mesh(
        new T.TubeGeometry(
          new T.CatmullRomCurve3(points),
          100,
          radius,
          6,
          false,
        ),
        new T.MeshBasicMaterial({
          color: '#8290cf',
          transparent: true,
          opacity: 0.9,
          depthTest: false,
        }),
      ),
    );
  }
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
      const projection = new T.Matrix4().fromArray(
        options.defaultProjectionData.mainMatrix,
      );
      camera.projectionMatrix.copy(projection);
      renderer.resetState();
      renderer.render(scene, camera);
      onProjection(projection);
    },
    onRemove() {
      for (const mesh of scene.children) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      renderer?.dispose();
    },
  });
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
