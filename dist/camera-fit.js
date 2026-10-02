// Fit the actual 3D route in the unobstructed map area. No DOM or map mutation.
// The projection matches MapLibre 6.10 Mercator, roll=0, elevation=0, no terrain.
// Source: src/geo/projection/mercator_transform.ts::_calcMatrices.
const RAD = Math.PI / 180,
  EARTH = 2 * Math.PI * 6371008.8;
export function mercatorPoint([lng, lat, alt = 0]) {
  lat = Math.max(-85.051129, Math.min(85.051129, lat));
  return [
    (lng + 180) / 360,
    (1 - Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) / Math.PI) / 2,
    alt / (EARTH * Math.cos(lat * RAD)),
  ];
}
export function lngLat([x, y]) {
  return [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / RAD];
}
const rotate = ([x, y, z = 0], b) => [
  x * Math.cos(b) + y * Math.sin(b),
  -x * Math.sin(b) + y * Math.cos(b),
  z,
];
const unrotate = ([x, y], b) => [
  x * Math.cos(b) - y * Math.sin(b),
  x * Math.sin(b) + y * Math.cos(b),
];

// Pure version of projecting exactly the normalized Mercator geometry rendered by Three.
export function projectMercator(
  point,
  camera,
  { width, height, fov = 36.86989764584402 },
) {
  const [u, v, z] = rotate(point, camera.bearing * RAD),
    [cu, cv] = rotate(mercatorPoint(camera.center), camera.bearing * RAD);
  const scale = 512 * 2 ** camera.zoom,
    d = height / (2 * Math.tan((fov * RAD) / 2)),
    p = camera.pitch * RAD;
  const w = d - scale * (Math.sin(p) * (v - cv) + Math.cos(p) * z);
  return {
    x: width / 2 + (d * scale * (u - cu)) / w,
    y:
      height / 2 + (d * scale * (Math.cos(p) * (v - cv) - Math.sin(p) * z)) / w,
    w,
  };
}
function clip(poly, a, b, c) {
  if (!poly.length) return poly;
  const result = [];
  let prev = poly.at(-1),
    pv = a * prev[0] + b * prev[1] - c;
  for (const now of poly) {
    const nv = a * now[0] + b * now[1] - c;
    if (nv <= 0 !== pv <= 0) {
      const t = pv / (pv - nv);
      result.push([
        prev[0] + t * (now[0] - prev[0]),
        prev[1] + t * (now[1] - prev[1]),
      ]);
    }
    if (nv <= 0) result.push(now);
    prev = now;
    pv = nv;
  }
  return result;
}
// All points impose the same five half-plane normals. Their tightest right-hand
// sides describe the exact intersection, so zoom search need not revisit them.
function fitConstraints(points, { width, height, rect, pitch, fov }) {
  const d = height / (2 * Math.tan((fov * RAD) / 2)),
    s = Math.sin(pitch * RAD),
    c = Math.cos(pitch * RAD),
    kl = (rect.left - width / 2) / d,
    kr = (rect.right - width / 2) / d,
    kt = (rect.top - height / 2) / d,
    kb = (rect.bottom - height / 2) / d;
  let left = Infinity,
    right = Infinity,
    top = Infinity,
    bottom = Infinity,
    front = Infinity,
    mx = 0,
    my = 0;
  for (const [u, v, z] of points) {
    if (!Number.isFinite(u + v + z)) return null;
    mx += u / points.length;
    my += v / points.length;
    left = Math.min(left, u + kl * s * v + kl * c * z);
    right = Math.min(right, -u - kr * s * v - kr * c * z);
    top = Math.min(top, (c + kt * s) * v + (-s + kt * c) * z);
    bottom = Math.min(bottom, -(c + kb * s) * v + (s - kb * c) * z);
    front = Math.min(front, -s * v - c * z);
  }
  return {
    d,
    mean: [mx, my],
    planes: [
      [1, kl * s, left, -kl],
      [-1, -kr * s, right, kr],
      [0, c + kt * s, top, -kt],
      [0, -(c + kb * s), bottom, kb],
      [0, -s, front, 0.99],
    ],
  };
}
function polygonCenter(poly) {
  // Area centroid is unchanged by redundant/collinear clipping vertices. Work
  // relative to the first point to retain precision at street-level zoom.
  const origin = poly[0];
  let area = 0,
    x = 0,
    y = 0;
  for (let i = 1; i < poly.length - 1; i++) {
    const ax = poly[i][0] - origin[0],
      ay = poly[i][1] - origin[1],
      bx = poly[i + 1][0] - origin[0],
      by = poly[i + 1][1] - origin[1],
      cross = ax * by - ay * bx;
    area += cross;
    x += (ax + bx) * cross;
    y += (ay + by) * cross;
  }
  if (Math.abs(area) > 1e-24)
    return [origin[0] + x / (3 * area), origin[1] + y / (3 * area)];
  return poly.reduce(
    (a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length],
    [0, 0],
  );
}
function feasibleCenter(prepared, zoom, bearing) {
  const { d, mean, planes } = prepared,
    t = d / (512 * 2 ** zoom);
  let poly = [
    [mean[0] - 2, mean[1] - 2],
    [mean[0] + 2, mean[1] - 2],
    [mean[0] + 2, mean[1] + 2],
    [mean[0] - 2, mean[1] + 2],
  ];
  for (const [a, b, base, scale] of planes) {
    poly = clip(poly, a, b, base + scale * t);
    if (!poly.length) return null;
  }
  return lngLat(unrotate(polygonCenter(poly), bearing * RAD));
}
export function fitMercatorPoints(points, options) {
  const {
    width,
    height,
    rect,
    pitch = 48,
    bearing = -13,
    minZoom = 2,
    maxZoom = 13.5,
    fov = 36.86989764584402,
  } = options;
  if (
    !points.length ||
    !rect ||
    rect.right <= rect.left ||
    rect.bottom <= rect.top
  )
    return null;
  const opts = { width, height, rect, pitch, bearing, fov },
    rotated = points.map((p) => rotate(p, bearing * RAD));
  const prepared = fitConstraints(rotated, opts);
  if (!prepared) return null;
  let lo = minZoom,
    hi = maxZoom,
    center = feasibleCenter(prepared, lo, bearing);
  if (!center) return null; // tell the caller to expand the safe rectangle or use its existing fallback
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2,
      c = feasibleCenter(prepared, mid, bearing);
    if (c) {
      lo = mid;
      center = c;
    } else hi = mid;
  }
  // Leave ~2% safety beyond the input's icon/stroke envelope.
  const zoom = Math.max(minZoom, lo - 0.025);
  center = feasibleCenter(prepared, zoom, bearing) || center;
  const camera = { center, zoom, pitch, bearing };
  const bounds = {
    left: Infinity,
    top: Infinity,
    right: -Infinity,
    bottom: -Infinity,
  };
  const [cu, cv] = rotate(mercatorPoint(camera.center), bearing * RAD),
    scale = 512 * 2 ** zoom,
    d = prepared.d,
    sine = Math.sin(pitch * RAD),
    cosine = Math.cos(pitch * RAD);
  let inside = true;
  // Check every original vertex, reusing camera constants and the already
  // rotated coordinates instead of allocating a projection object per point.
  for (const [u, v, z] of rotated) {
    const w = d - scale * (sine * (v - cv) + cosine * z),
      x = width / 2 + (d * scale * (u - cu)) / w,
      y = height / 2 + (d * scale * (cosine * (v - cv) - sine * z)) / w;
    bounds.left = Math.min(bounds.left, x);
    bounds.top = Math.min(bounds.top, y);
    bounds.right = Math.max(bounds.right, x);
    bounds.bottom = Math.max(bounds.bottom, y);
    inside &&=
      w > 0 &&
      x >= rect.left - 0.01 &&
      x <= rect.right + 0.01 &&
      y >= rect.top - 0.01 &&
      y <= rect.bottom + 0.01;
  }
  return { camera, rect, bounds, inside };
}
const overlaps = (a, b) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const contains = (a, b) =>
  a.left <= b.left &&
  a.right >= b.right &&
  a.top <= b.top &&
  a.bottom >= b.bottom;
const area = (r) => (r.right - r.left) * (r.bottom - r.top);
// Rectangles must be relative to map.getContainer(), measured AFTER map.resize().
// Pass visible title, notice, playback, legend and control rectangles as blockers.
export function safeViewportRects({
  width,
  height,
  blockers = [],
  edge = 20,
  gap = 14,
}) {
  let free = [
    { left: edge, top: edge, right: width - edge, bottom: height - edge },
  ];
  for (const raw of blockers) {
    const b = {
      left: raw.left - gap,
      right: raw.right + gap,
      top: raw.top - gap,
      bottom: raw.bottom + gap,
    };
    free = free
      .flatMap((r) =>
        !overlaps(r, b)
          ? [r]
          : [
              { ...r, right: Math.min(r.right, b.left) },
              { ...r, left: Math.max(r.left, b.right) },
              { ...r, bottom: Math.min(r.bottom, b.top) },
              { ...r, top: Math.max(r.top, b.bottom) },
            ],
      )
      .filter(
        (r) =>
          r.right - r.left >= Math.min(200, width * 0.3) &&
          r.bottom - r.top >= Math.min(140, height * 0.25),
      );
    free = free.filter(
      (r, i, list) =>
        !list.some(
          (o, j) => j !== i && contains(o, r) && (area(o) > area(r) || j < i),
        ),
    );
  }
  return free.sort((a, b) => area(b) - area(a));
}
export function fitInViewport(points, options) {
  const rects = safeViewportRects(options),
    fits = rects
      .map((rect) => fitMercatorPoints(points, { ...options, rect }))
      .filter((r) => r?.inside);
  // Perspective makes zoom an unreliable measure of visible route size. Compare
  // the projected geometry itself, including where it lands within the viewport.
  const score = (f) => {
    const b = f.bounds,
      w = b.right - b.left,
      h = b.bottom - b.top;
    const size = Math.sqrt(Math.max(1, w) * Math.max(1, h));
    const offset = Math.hypot(
      ((b.left + b.right) / 2 - options.width / 2) / options.width,
      ((b.top + b.bottom) / 2 - options.height / 2) / options.height,
    );
    return Math.log2(Math.max(1, size)) - 0.12 * offset;
  };
  return fits.sort((a, b) => score(b) - score(a))[0] || null;
}

// Callers own this cache and clear it when their map is disposed. Geometry
// arrays are immutable snapshots; different arrays or viewports never alias.
export function createCameraFitCache({
  maxPointSets = 16,
  maxViews = 8,
  maxPoints = 600000,
} = {}) {
  const entries = new Map();
  let retainedPoints = 0;
  return {
    fit(points, options) {
      const key = JSON.stringify([
        options.width,
        options.height,
        options.pitch ?? 48,
        options.bearing ?? -13,
        options.fov ?? 36.86989764584402,
        options.minZoom ?? 2,
        options.maxZoom ?? 13.5,
        options.edge ?? 20,
        options.gap ?? 14,
        options.blockers || [],
      ]);
      let views = entries.get(points);
      if (views?.has(key)) {
        const fit = views.get(key);
        views.delete(key);
        views.set(key, fit);
        entries.delete(points);
        entries.set(points, views);
        return fit;
      }
      const fit = fitInViewport(points, options);
      if (points.length > maxPoints || maxPointSets < 1 || maxViews < 1)
        return fit;
      if (!views) {
        views = new Map();
        entries.set(points, views);
        retainedPoints += points.length;
      }
      views.set(key, fit);
      while (views.size > maxViews) views.delete(views.keys().next().value);
      while (entries.size > maxPointSets || retainedPoints > maxPoints) {
        const oldest = entries.keys().next().value;
        retainedPoints -= oldest.length;
        entries.delete(oldest);
      }
      return fit;
    },
    clear() {
      entries.clear();
      retainedPoints = 0;
    },
  };
}
