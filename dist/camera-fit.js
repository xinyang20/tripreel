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
function feasibleCenter(
  points,
  zoom,
  { width, height, rect, pitch, bearing, fov },
) {
  const d = height / (2 * Math.tan((fov * RAD) / 2)),
    t = d / (512 * 2 ** zoom),
    p = pitch * RAD,
    s = Math.sin(p),
    c = Math.cos(p);
  const kl = (rect.left - width / 2) / d,
    kr = (rect.right - width / 2) / d,
    kt = (rect.top - height / 2) / d,
    kb = (rect.bottom - height / 2) / d;
  // Camera center within a generous range around these points (not a geographical crop).
  const mean = points.reduce(
    (a, v) => [a[0] + v[0] / points.length, a[1] + v[1] / points.length],
    [0, 0],
  );
  let poly = [
    [mean[0] - 2, mean[1] - 2],
    [mean[0] + 2, mean[1] - 2],
    [mean[0] + 2, mean[1] + 2],
    [mean[0] - 2, mean[1] + 2],
  ];
  for (const [u, v, z] of points) {
    poly = clip(poly, 1, kl * s, u - kl * t + kl * s * v + kl * c * z);
    poly = clip(poly, -1, -kr * s, -u + kr * t - kr * s * v - kr * c * z);
    poly = clip(
      poly,
      0,
      c + kt * s,
      -kt * t + (c + kt * s) * v + (-s + kt * c) * z,
    );
    poly = clip(
      poly,
      0,
      -(c + kb * s),
      kb * t - (c + kb * s) * v + (s - kb * c) * z,
    );
    poly = clip(poly, 0, -s, 0.99 * t - s * v - c * z); // keep points in front of camera
    if (!poly.length) return null;
  }
  const center = poly.reduce(
    (a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length],
    [0, 0],
  );
  return lngLat(unrotate(center, bearing * RAD));
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
  let lo = minZoom,
    hi = maxZoom,
    center = feasibleCenter(rotated, lo, opts);
  if (!center) return null; // tell the caller to expand the safe rectangle or use its existing fallback
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2,
      c = feasibleCenter(rotated, mid, opts);
    if (c) {
      lo = mid;
      center = c;
    } else hi = mid;
  }
  // Leave ~2% safety beyond the input's icon/stroke envelope.
  const zoom = Math.max(minZoom, lo - 0.025);
  center = feasibleCenter(rotated, zoom, opts) || center;
  const camera = { center, zoom, pitch, bearing };
  const bounds = {
    left: Infinity,
    top: Infinity,
    right: -Infinity,
    bottom: -Infinity,
  };
  let inside = true;
  for (const point of points) {
    const p = projectMercator(point, camera, { width, height, fov });
    bounds.left = Math.min(bounds.left, p.x);
    bounds.top = Math.min(bounds.top, p.y);
    bounds.right = Math.max(bounds.right, p.x);
    bounds.bottom = Math.max(bounds.bottom, p.y);
    inside &&=
      p.w > 0 &&
      p.x >= rect.left - 0.01 &&
      p.x <= rect.right + 0.01 &&
      p.y >= rect.top - 0.01 &&
      p.y <= rect.bottom + 0.01;
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
