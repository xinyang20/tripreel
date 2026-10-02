const clean = (name) => String(name || '').replace(/站$/, '');
const placeKey = (p) =>
  `${p.name}:${p.coord?.map((n) => Number(n).toFixed(4)).join(',')}`;
const airportIndexes = new WeakMap();
function airportNames(index) {
  if (airportIndexes.has(index)) return airportIndexes.get(index);
  const names = new Map();
  for (const airport of Object.values(index.airports || {}))
    if (!names.has(airport.name)) names.set(airport.name, airport);
  airportIndexes.set(index, names);
  return names;
}
export function cityFor(place, index = {}) {
  const airport =
    index.airports?.[place.code] ||
    (place.kind === 'flight' ? airportNames(index).get(place.name) : null);
  const item =
    airport ||
    index.stations?.[place.name] ||
    index.stations?.[clean(place.name)] ||
    airportNames(index).get(place.name);
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
  if (!detail && zoom < 8.5) {
    const cities = new Map();
    points.forEach((point, i) => {
      if (!point.city) return;
      const members = cities.get(point.city.id) || [];
      for (const j of members) {
        const a = point,
          b = points[j];
        if (
          overlaps(
            {
              x: a.anchorX - a.width / 2,
              y: a.anchorY - 40,
              width: a.width,
              height: a.height,
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
          groups[root(i)] = root(j);
      }
      members.push(i);
      cities.set(point.city.id, members);
    });
  }
  const clusters = new Map();
  points.forEach((p, i) => {
    const key = root(i);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(p);
  });
  const labels = [],
    nameCounts = new Map(),
    cells = new Map();
  for (const p of points)
    nameCounts.set(p.name, (nameCounts.get(p.name) || 0) + 1);
  const cellKeys = (box, pad = 0) => {
    const keys = [];
    for (
      let x = Math.floor((box.x - pad) / 128);
      x <= Math.floor((box.x + box.width + pad) / 128);
      x++
    )
      for (
        let y = Math.floor((box.y - pad) / 128);
        y <= Math.floor((box.y + box.height + pad) / 128);
        y++
      )
        keys.push(x + ':' + y);
    return keys;
  };
  let queryId = 0;
  const collisionCount = (box, limit) => {
    const query = ++queryId;
    let count = 0;
    for (const key of cellKeys(box, 5))
      for (const entry of cells.get(key) || []) {
        if (entry.query === query) continue;
        entry.query = query;
        if (overlaps(box, entry.label) && ++count >= limit) return count;
      }
    return count;
  };
  for (const members of clusters.values()) {
    const merged = members.length > 1,
      first = members[0],
      duplicate = nameCounts.get(first.name) > 1;
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
      let blocked = 0;
      for (const other of obstacles) if (overlaps(box, other)) blocked += 10;
      // Ties keep the earlier position. Once this candidate reaches the best
      // score, further collisions cannot change the choice, so stop counting.
      if (blocked >= score) continue;
      const collisions = blocked + collisionCount(box, score - blocked);
      if (collisions < score) {
        chosen = box;
        score = collisions;
        if (!collisions) break;
      }
    }
    const label = {
      key: members.map(placeKey).sort().join('|'),
      ...chosen,
      name,
      anchorX,
      anchorY,
      merged,
      members: members.map((p) => p.name),
    };
    labels.push(label);
    const entry = { label, query: 0 };
    for (const key of cellKeys(label)) {
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(entry);
    }
  }
  return labels;
}

const overlays = new WeakMap();
export function renderPlaceLabels(overlay, labels) {
  const doc = overlay.ownerDocument;
  let state = overlays.get(overlay);
  if (!state || state.svg.parentNode !== overlay) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.replaceChildren(svg);
    state = { svg, nodes: new Map() };
    overlays.set(overlay, state);
  }
  const keep = new Set();
  for (const label of labels) {
    const key = label.key || label.members.join('|');
    keep.add(key);
    let node = state.nodes.get(key);
    if (!node) {
      const line = doc.createElementNS('http://www.w3.org/2000/svg', 'line'),
        el = doc.createElement('div');
      line.setAttribute('stroke', '#a8c9dc');
      line.setAttribute('stroke-width', '1');
      state.svg.append(line);
      overlay.append(el);
      node = { line, el };
      state.nodes.set(key, node);
    }
    for (const [name, value] of Object.entries({
      x1: label.anchorX,
      y1: label.anchorY,
      x2: Math.max(label.x, Math.min(label.x + label.width, label.anchorX)),
      y2: Math.max(label.y, Math.min(label.y + label.height, label.anchorY)),
    }))
      if (node.line.getAttribute(name) !== String(value))
        node.line.setAttribute(name, String(value));
    const className = 'map-place-label' + (label.merged ? ' merged' : '');
    if (node.el.className !== className) node.el.className = className;
    if (node.el.textContent !== label.name) node.el.textContent = label.name;
    const title = label.members.join('、');
    if (node.el.title !== title) node.el.title = title;
    for (const [name, value] of Object.entries({
      left: label.x,
      top: label.y,
      width: label.width,
    }))
      if (node.el.style[name] !== value + 'px')
        node.el.style[name] = value + 'px';
  }
  for (const [key, node] of state.nodes)
    if (!keep.has(key)) {
      node.line.remove();
      node.el.remove();
      state.nodes.delete(key);
    }
}
