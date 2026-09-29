const clean = (name) => String(name || '').replace(/站$/, '');
const placeKey = (p) =>
  `${p.name}:${p.coord?.map((n) => Number(n).toFixed(4)).join(',')}`;
export function cityFor(place, index = {}) {
  const airport =
    index.airports?.[place.code] ||
    (place.kind === 'flight'
      ? Object.values(index.airports || {}).find((a) => a.name === place.name)
      : null);
  const item =
    airport ||
    index.stations?.[place.name] ||
    index.stations?.[clean(place.name)] ||
    Object.values(index.airports || {}).find((a) => a.name === place.name);
  return item?.city
    ? { name: item.city, id: item.cityGroup || item.city }
    : place.city
      ? { name: place.city, id: place.city }
      : null;
}
export function endpointPlaces(trips) {
  const found = new Map();
  for (const trip of trips)
    for (const p of [trip.from, trip.to])
      if (p?.coord && !found.has(placeKey(p)))
        found.set(placeKey(p), { ...p, kind: trip.mode });
  return [...found.values()];
}
const overlaps = (a, b, pad = 5) =>
  a.x < b.x + b.width + pad &&
  a.x + a.width + pad > b.x &&
  a.y < b.y + b.height + pad &&
  a.y + a.height + pad > b.y;
export function layoutPlaceLabels(
  places,
  {
    project,
    zoom,
    width,
    height,
    cityIndex = {},
    detail = false,
    blockers = [],
    measure = (name) =>
      [...name].reduce((n, c) => n + (/[\x00-\x7F]/.test(c) ? 7 : 12), 0) + 26,
  },
) {
  const obstacles = blockers.map((b) => ({
    x: b.left,
    y: b.top,
    width: b.right - b.left,
    height: b.bottom - b.top,
  }));
  const seen = new Set(),
    points = [];
  for (const p of places) {
    if (!p?.coord || seen.has(placeKey(p))) continue;
    seen.add(placeKey(p));
    const pixel = project(p.coord);
    if (
      !pixel ||
      !Number.isFinite(pixel.x + pixel.y) ||
      pixel.x < 0 ||
      pixel.y < 0 ||
      pixel.x > width ||
      pixel.y > height
    )
      continue;
    points.push({
      ...p,
      city: cityFor(p, cityIndex),
      anchorX: pixel.x,
      anchorY: pixel.y,
      width: measure(p.name),
      height: 28,
    });
  }
  const groups = points.map((_, i) => i),
    root = (i) => (groups[i] === i ? i : (groups[i] = root(groups[i])));
  if (!detail && zoom < 8.5)
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i],
          b = points[j];
        if (!a.city || a.city.id !== b.city?.id) continue;
        if (
          overlaps(
            {
              x: a.anchorX - a.width / 2,
              y: a.anchorY - 40,
              ...{ width: a.width, height: a.height },
            },
            {
              x: b.anchorX - b.width / 2,
              y: b.anchorY - 40,
              width: b.width,
              height: b.height,
            },
            18,
          )
        )
          groups[root(j)] = root(i);
      }
  const clusters = new Map();
  points.forEach((p, i) => {
    const key = root(i);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(p);
  });
  const labels = [];
  for (const members of clusters.values()) {
    const merged = members.length > 1,
      first = members[0],
      duplicate = points.filter((p) => p.name === first.name).length > 1;
    const suffix = duplicate
      ? first.kind === 'flight' && !first.name.endsWith('机场')
        ? '机场'
        : first.kind === 'train' && !first.name.endsWith('站')
          ? '站'
          : ''
      : '';
    const name = merged ? first.city.name : first.name + suffix,
      anchorX = members.reduce((s, p) => s + p.anchorX, 0) / members.length,
      anchorY = members.reduce((s, p) => s + p.anchorY, 0) / members.length,
      w = measure(name),
      h = 28;
    const options = [
      [0, -40],
      [0, 14],
      [w / 2 + 12, -14],
      [-w / 2 - 12, -14],
      [0, -76],
      [0, 50],
      [w / 2 + 12, -50],
      [-w / 2 - 12, 22],
    ];
    let chosen,
      score = Infinity;
    for (const [dx, dy] of options) {
      const box = {
        x: Math.max(6, Math.min(width - w - 6, anchorX - w / 2 + dx)),
        y: Math.max(6, Math.min(height - h - 6, anchorY + dy)),
        width: w,
        height: h,
      };
      const collisions =
        labels.filter((other) => overlaps(box, other)).length +
        obstacles.filter((other) => overlaps(box, other)).length * 10;
      if (collisions < score) {
        chosen = box;
        score = collisions;
        if (!collisions) break;
      }
    }
    labels.push({
      ...chosen,
      name,
      anchorX,
      anchorY,
      merged,
      members: members.map((p) => p.name),
    });
  }
  return labels;
}
