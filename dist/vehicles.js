// Low-poly replay vehicles rendered inside the map's Three.js layer. Models are
// built in metres (x forward, y left, z up) and drawn relative to an anchor in
// Mercator units, so small meshes keep full precision at every zoom.
import * as T from './vendor/three.module.js';
import { alongIndex } from './core.js';
import { mercatorPoint } from './camera-fit.js';

const EARTH = 2 * Math.PI * 6371008.8,
  TILE = 512,
  CAR_METRES = 25,
  CARS = 6,
  PLANE_METRES = 38;
// Minimum on-screen sizes; real proportions take over once the map zooms in.
export const VEHICLE_PIXELS = { car: 28, plane: 60 };

const merc = (point) => mercatorPoint(point);
const metreUnits = (lat) => 1 / (EARTH * Math.cos((lat * Math.PI) / 180));
function exaggeration(lat, zoom, pixels, metres, pixelScale) {
  const pixelUnits = 1 / (TILE * 2 ** zoom);
  return Math.max(
    1,
    (pixels * pixelScale * pixelUnits) / (metres * metreUnits(lat)),
  );
}
const heading = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);

// Pure pose calculation: positions are Mercator offsets from the anchor.
export function vehiclePose(frame, zoom, { pixelScale = 1 } = {}) {
  const avatar = frame?.item?.type === 'trip' ? frame.avatar : null;
  if (!avatar?.coord) return null;
  if (frame.trip.mode === 'flight' && avatar.arc) {
    const { points, fraction } = avatar.arc,
      at = (f) => {
        const index = Math.max(0, Math.min(1, f)) * (points.length - 1),
          a = points[Math.floor(index)],
          b = points[Math.ceil(index)],
          p = index % 1;
        return [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * p);
      },
      here = merc([...avatar.coord, avatar.altitude || 0]),
      behind = merc(at(fraction - 0.004)),
      ahead = merc(at(fraction + 0.004)),
      run = Math.hypot(ahead[0] - behind[0], ahead[1] - behind[1]) || 1e-12,
      scale =
        exaggeration(
          avatar.coord[1],
          zoom,
          VEHICLE_PIXELS.plane,
          PLANE_METRES,
          pixelScale,
        ) * metreUnits(avatar.coord[1]);
    return {
      kind: 'flight',
      anchor: here,
      scale,
      parts: [
        {
          offset: [0, 0, 0],
          heading: heading(behind, ahead),
          pitch: Math.max(
            -0.26,
            Math.min(0.26, Math.atan2(ahead[2] - behind[2], run)),
          ),
        },
      ],
      shadow: -here[2] / scale,
    };
  }
  const track = avatar.track;
  if (!track?.index?.length) return null;
  const { index } = track,
    lat = avatar.coord[1],
    factor = exaggeration(
      lat,
      zoom,
      VEHICLE_PIXELS.car,
      CAR_METRES,
      pixelScale,
    ),
    car = Math.min((CAR_METRES * factor) / 1000, index.length / CARS),
    train = car * CARS,
    head = Math.max(train, Math.min(index.length, track.along + train / 2)),
    point = (km) =>
      merc(
        alongIndex(
          index,
          Math.max(0, Math.min(index.length, km)) / index.length,
        ),
      ),
    scale = (car * 1000 * metreUnits(lat)) / CAR_METRES,
    parts = [];
  let anchor;
  for (let i = 0; i < CARS; i++) {
    const centre = head - (i + 0.5) * car,
      front = point(centre + car * 0.4),
      rear = point(centre - car * 0.4),
      middle = [(front[0] + rear[0]) / 2, (front[1] + rear[1]) / 2, 0];
    anchor ||= middle;
    parts.push({
      offset: [
        (middle[0] - anchor[0]) / scale,
        (middle[1] - anchor[1]) / scale,
        0,
      ],
      heading: heading(rear, front),
      pitch: 0,
      role: i === 0 ? 'head' : i === CARS - 1 ? 'tail' : 'middle',
    });
  }
  // Widen the body while the train is drawn far above real size so it stays legible.
  const girth = Math.max(1, Math.min(2.4, 1 + (factor - 1) * 0.4));
  return { kind: 'train', anchor, scale, parts, shadow: 0, girth };
}

function materials() {
  const lambert = (color) => new T.MeshLambertMaterial({ color });
  return {
    body: lambert('#f3f6f8'),
    stripe: lambert('#1f6fa3'),
    glass: lambert('#22303b'),
    skirt: lambert('#5d6a75'),
    wing: lambert('#c9d4de'),
    tail: lambert('#1f6fa3'),
    engine: lambert('#aab6c0'),
    shadow: new T.MeshBasicMaterial({
      color: '#0d1f2d',
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    }),
  };
}
const box = (x, y, z) => new T.BoxGeometry(x, y, z);
function place(geometry, material, x, y, z) {
  const mesh = new T.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  return mesh;
}
// A half ellipsoid pointing forward along +x.
function nose(length, width, height) {
  const g = new T.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  g.rotateZ(-Math.PI / 2);
  g.scale(length, width / 2, height / 2);
  return g;
}
function trainCar(m, role) {
  const group = new T.Group(),
    w = 3.3,
    h = 3.2,
    base = 0.55,
    bodyLength = role === 'middle' ? CAR_METRES - 0.6 : CAR_METRES - 6.6,
    shift = role === 'middle' ? 0 : -3;
  group.add(
    place(box(bodyLength, w, h), m.body, shift, 0, base + h / 2),
    place(box(bodyLength, w + 0.04, 0.26), m.stripe, shift, 0, base + 1.1),
    place(box(bodyLength - 1.2, w + 0.06, 0.72), m.glass, shift, 0, base + 2.2),
    place(box(bodyLength - 1.2, w - 0.5, 0.5), m.skirt, shift, 0, base * 0.55),
  );
  if (role !== 'middle') {
    const front = bodyLength / 2 + shift;
    group.add(
      place(nose(6.3, w, h), m.body, front, 0, base + h / 2),
      place(
        nose(3.2, w * 0.74, h * 0.46),
        m.glass,
        front + 0.7,
        0,
        base + h * 0.78,
      ),
      place(nose(6.3, w + 0.04, 0.26), m.stripe, front, 0, base + 1.1),
    );
  }
  if (role === 'tail') group.rotation.z = Math.PI;
  const outer = new T.Group();
  outer.add(group);
  return outer;
}
function planform(points, thickness) {
  const shape = new T.Shape(points.map(([x, y]) => new T.Vector2(x, y)));
  const g = new T.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
  });
  g.translate(0, 0, -thickness / 2);
  return g;
}
function aircraft(m) {
  const group = new T.Group(),
    r = 1.9,
    fuselage = new T.CylinderGeometry(r, r, 26, 16);
  fuselage.rotateZ(Math.PI / 2);
  const tailCone = new T.ConeGeometry(r, 8, 16);
  tailCone.rotateZ(Math.PI / 2);
  const wing = planform(
      [
        [3.5, 0],
        [-5.5, 17],
        [-7.6, 17],
        [-4, 1.6],
        [-4, -1.6],
        [-7.6, -17],
        [-5.5, -17],
      ],
      0.45,
    ),
    stabiliser = planform(
      [
        [-14, 0],
        [-17.6, 6.2],
        [-19, 6.2],
        [-17.2, 0.8],
        [-17.2, -0.8],
        [-19, -6.2],
        [-17.6, -6.2],
      ],
      0.3,
    ),
    fin = planform(
      [
        [-12.5, 0],
        [-17.8, 7.4],
        [-19.6, 7.4],
        [-18.6, 0],
      ],
      0.35,
    );
  fin.rotateX(Math.PI / 2);
  const engine = new T.CylinderGeometry(0.85, 0.75, 3.6, 12);
  engine.rotateZ(Math.PI / 2);
  group.add(
    place(fuselage, m.body, -1, 0, 0),
    place(nose(5, r * 2, r * 2), m.body, 12, 0, 0),
    place(nose(2, r * 1.3, r * 0.8), m.glass, 13.6, 0, 0.7),
    place(tailCone, m.body, -18, 0, 0.35),
    place(wing, m.wing, 0, 0, -0.6),
    place(stabiliser, m.wing, 0, 0, 0.6),
    place(fin, m.tail, 0, 0, r * 0.6),
    place(engine, m.engine, -1.4, 6.2, -1.6),
    place(engine, m.engine, -1.4, -6.2, -1.6),
  );
  return { group, outline: [fuselage, wing, stabiliser] };
}
function flatShadow(geometries, material, scaleY = 1) {
  const group = new T.Group();
  for (const g of geometries) {
    const mesh = new T.Mesh(g, material);
    mesh.scale.set(1, scaleY, 0.02);
    group.add(mesh);
  }
  return group;
}

// The map's depth range spans the whole view, which is far too coarse to sort
// the faces of a small model. Stretch clip-space depth around the vehicle so
// its own extent uses the full depth buffer.
function focusDepth(projection, radius) {
  const ndc = (x, y, z) => {
    const v = new T.Vector4(x, y, z, 1).applyMatrix4(projection);
    return v.z / v.w;
  };
  const centre = ndc(0, 0, 0);
  let extent = 0;
  for (const [x, y, z] of [
    [radius, 0, 0],
    [-radius, 0, 0],
    [0, radius, 0],
    [0, -radius, 0],
    [0, 0, radius],
    [0, 0, -radius],
  ])
    extent = Math.max(extent, Math.abs(ndc(x, y, z) - centre));
  if (!Number.isFinite(extent) || !extent) return projection;
  const k = 0.9 / extent;
  return new T.Matrix4()
    .set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, k, -k * centre, 0, 0, 0, 1)
    .multiply(projection);
}
export function createVehicleRenderer() {
  const scene = new T.Scene(),
    camera = new T.Camera(),
    m = materials(),
    sky = new T.HemisphereLight('#ffffff', '#9fb2c0', 2.4),
    sun = new T.DirectionalLight('#ffffff', 1.6),
    cars = ['head', 'middle', 'middle', 'middle', 'middle', 'tail'].map(
      (role) => trainCar(m, role),
    ),
    carShadows = cars.map(() =>
      place(box(CAR_METRES - 0.6, 4.2, 0.05), m.shadow, 0, 0, 0.02),
    ),
    plane = aircraft(m),
    planeShadow = flatShadow(plane.outline, m.shadow);
  sky.position.set(0, 0, 1);
  sun.position.set(0.35, -0.6, 1);
  scene.add(sky, sun, ...cars, ...carShadows, plane.group, planeShadow);
  // The map projection mirrors Mercator space, which reverses face winding.
  // Mirror the (symmetric) geometry itself so front faces stay front-facing;
  // an object-level mirror would be compensated by Three.js and change nothing.
  const mirrored = new Set();
  scene.traverse((object) => {
    if (!object.geometry || mirrored.has(object.geometry)) return;
    mirrored.add(object.geometry);
    object.geometry.scale(1, -1, 1);
  });
  const pose = { current: null };
  function apply(object, part, girth = 1, z = part.offset[2]) {
    object.position.set(part.offset[0], part.offset[1], z);
    object.rotation.set(0, -part.pitch, part.heading, 'ZYX');
    object.scale.set(1, girth, girth);
  }
  return {
    setPose(next) {
      pose.current = next;
    },
    render(renderer, mainMatrix) {
      const next = pose.current;
      for (const object of [...cars, ...carShadows, plane.group, planeShadow])
        object.visible = false;
      if (!next) return;
      const [x, y, z] = next.anchor;
      const projection = new T.Matrix4()
          .fromArray(mainMatrix)
          .multiply(new T.Matrix4().makeTranslation(x, y, z))
          .multiply(
            new T.Matrix4().makeScale(next.scale, next.scale, next.scale),
          ),
        radius =
          next.kind === 'train'
            ? Math.max(...next.parts.map((p) => Math.hypot(...p.offset))) +
              CAR_METRES
            : Math.max(PLANE_METRES, Math.abs(next.shadow)) + PLANE_METRES;
      camera.projectionMatrix.copy(focusDepth(projection, radius));
      if (next.kind === 'train')
        next.parts.forEach((part, i) => {
          cars[i].visible = carShadows[i].visible = true;
          apply(cars[i], part, next.girth);
          carShadows[i].position.set(part.offset[0], part.offset[1], 0.02);
          carShadows[i].rotation.set(0, 0, part.heading);
          carShadows[i].scale.set(1, next.girth, 1);
        });
      else {
        const [part] = next.parts;
        plane.group.visible = planeShadow.visible = true;
        apply(plane.group, part);
        planeShadow.position.set(0, 0, next.shadow + 0.05);
        planeShadow.rotation.set(0, 0, part.heading);
      }
      renderer.clearDepth();
      renderer.render(scene, camera);
    },
    dispose() {
      scene.traverse((object) => object.geometry?.dispose());
      Object.values(m).forEach((material) => material.dispose());
      scene.clear();
    },
  };
}
