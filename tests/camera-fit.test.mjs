import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {
  mercatorPoint,
  projectMercator,
  fitMercatorPoints,
  fitInViewport,
  safeViewportRects,
} from '../dist/camera-fit.js';
import {
  journeyBounds,
  journeyWorldPoints,
  tripRouteLines,
} from '../dist/map-scene.js';
import { distance } from '../dist/core.js';
import { videoViewportBlockers } from '../dist/video-layout.js';

const fov = 36.86989764584402;
// Independent 4×4 perspective transform in MapLibre's rendering order. These checks
// do not rely on fitMercatorPoints' own `inside` flag or its scalar projection.
function referenceProjector(camera, { width, height, fov: fieldOfView = fov }) {
  const near = 1,
    far = 1e9,
    halfHeight = near * Math.tan((fieldOfView * Math.PI) / 360),
    halfWidth = (halfHeight * width) / height;
  const world = 512 * 2 ** camera.zoom,
    center = mercatorPoint(camera.center),
    distance = height / (2 * Math.tan((fieldOfView * Math.PI) / 360));
  const matrix = new T.Matrix4().makePerspective(
    -halfWidth,
    halfWidth,
    halfHeight,
    -halfHeight,
    near,
    far,
  );
  for (const next of [
    new T.Matrix4().makeScale(1, -1, 1),
    new T.Matrix4().makeTranslation(0, 0, -distance),
    new T.Matrix4().makeRotationX((camera.pitch * Math.PI) / 180),
    new T.Matrix4().makeRotationZ((-camera.bearing * Math.PI) / 180),
    new T.Matrix4().makeTranslation(-center[0] * world, -center[1] * world, 0),
    new T.Matrix4().makeScale(world, world, world),
  ])
    matrix.multiply(next);
  return (point) => {
    const p = new T.Vector4(...point, 1).applyMatrix4(matrix);
    return {
      x: ((p.x / p.w + 1) * width) / 2,
      y: ((1 - p.y / p.w) * height) / 2,
      w: p.w,
    };
  };
}
function assertVisible(points, fit, viewport) {
  assert.ok(fit, '应该存在完整取景方案');
  assert.ok(fit.inside);
  const project = referenceProjector(fit.camera, viewport),
    { rect } = fit;
  for (const point of points) {
    const p = project(point);
    assert.ok(p.w > 0, '顶点应位于相机前方');
    assert.ok(
      p.x >= rect.left - 0.01 &&
        p.x <= rect.right + 0.01 &&
        p.y >= rect.top - 0.01 &&
        p.y <= rect.bottom + 0.01,
      `顶点被安全区域裁剪：${JSON.stringify(p)}`,
    );
  }
}
const viewports = [
  {
    name: '桌面',
    width: 1050,
    height: 824,
    blockers: [
      { left: 36, top: 35, right: 410, bottom: 122 },
      { left: 36, top: 150, right: 290, bottom: 169 },
      { left: 35, top: 628, right: 1015, bottom: 790 },
      { left: 750, top: 30, right: 1024, bottom: 162 },
    ],
  },
  {
    name: '全屏',
    width: 1440,
    height: 900,
    blockers: [
      { left: 36, top: 35, right: 410, bottom: 122 },
      { left: 36, top: 150, right: 290, bottom: 169 },
      { left: 220, top: 704, right: 1220, bottom: 866 },
      { left: 1140, top: 30, right: 1414, bottom: 162 },
    ],
  },
  {
    name: '手机',
    width: 390,
    height: 520,
    blockers: [
      { left: 20, top: 24, right: 240, bottom: 118 },
      { left: 20, top: 148, right: 288, bottom: 165 },
      { left: 13, top: 350, right: 377, bottom: 494 },
      { left: 280, top: 101, right: 370, bottom: 235 },
    ],
  },
];

test('倾斜、旋转和不同视场下，三维坐标投影与真实矩阵顺序一致', () => {
  const points = [
    [118.8, 32, 0],
    [116.2, 40, 180000],
    [121.5, 31.2, 85000],
  ].map(mercatorPoint);
  for (const pitch of [0, 48, 65])
    for (const bearing of [-13, 77])
      for (const fieldOfView of [fov, 50]) {
        const camera = { center: [118, 34], zoom: 5.5, pitch, bearing },
          viewport = { width: 1100, height: 720, fov: fieldOfView },
          reference = referenceProjector(camera, viewport);
        for (const point of points) {
          const actual = projectMercator(point, camera, viewport),
            expected = reference(point);
          assert.ok(
            Math.hypot(actual.x - expected.x, actual.y - expected.y) < 0.00001,
          );
        }
      }
});

test('桌面、全屏与手机取景都包住完整飞机曲线网格，并避开标题和播放栏', () => {
  const flight = {
    mode: 'flight',
    distance: 1050,
    from: { coord: [113.2988, 23.3924] },
    to: { coord: [118.864, 31.742] },
  };
  const points = journeyWorldPoints([flight]);
  assert.ok(
    points.length > 700,
    '应该获取曲线管身顶点，而不只是航线端点或中心线',
  );
  assert.ok(
    points.some((p) => p[2] > 0.001),
    '应保留飞机弧线高度',
  );
  for (const viewport of viewports) {
    const fit = fitInViewport(points, {
      ...viewport,
      pitch: 48,
      bearing: -13,
      maxZoom: 13.5,
    });
    assertVisible(points, fit, viewport);
    for (const blocker of viewport.blockers) {
      const r = fit.rect;
      assert.ok(
        r.right <= blocker.left ||
          r.left >= blocker.right ||
          r.bottom <= blocker.top ||
          r.top >= blocker.bottom,
        `${viewport.name} 取景区不应与控件相交`,
      );
    }
  }
});

test('稀疏直线与稠密、局部重复采样的同一路线保持相同取景尺度', () => {
  const sparse = [
      [0.82, 0.36, 0],
      [0.83, 0.38, 0],
    ],
    dense = Array.from({ length: 101 }, (_, i) =>
      sparse[0].map((value, j) => value + ((sparse[1][j] - value) * i) / 100),
    );
  const biased = [...dense, ...Array.from({ length: 800 }, () => dense[5])],
    viewport = {
      width: 1000,
      height: 800,
      rect: { left: 25, top: 170, right: 975, bottom: 620 },
      pitch: 48,
      bearing: -13,
    };
  const first = fitMercatorPoints(sparse, viewport);
  for (const points of [dense, biased]) {
    const fit = fitMercatorPoints(points, viewport);
    assertVisible(points, fit, viewport);
    assert.ok(Math.abs(first.camera.zoom - fit.camera.zoom) < 0.000001);
  }
});

test('短途允许超过原来的 zoom8，沿途外绕顶点始终纳入取景', () => {
  const from = { coord: [118.794, 31.967] },
    to = { coord: [118.912, 32.124] },
    trip = {
      mode: 'train',
      from,
      to,
      stops: [from, to],
      routeCoordinates: [from.coord, [118.68, 32.04], to.coord],
    };
  const points = journeyWorldPoints([trip]);
  assert.ok(
    points.some(
      (p) =>
        Math.abs(p[0] - mercatorPoint(trip.routeCoordinates[1])[0]) < 1e-12,
    ),
  );
  for (const viewport of viewports) {
    const fit = fitInViewport(points, { ...viewport, maxZoom: 13.5 });
    assertVisible(points, fit, viewport);
    assert.ok(fit.camera.zoom > 8 && fit.camera.zoom <= 13.5);
  }
});

test('旧版连续 legs 的外绕几何与绘制共用取景，正反方向和视频都完整可见', () => {
  const a = [118.79, 31.96],
    b = [118.91, 32.12],
    via = [118.5, 32.04],
    end = [119.02, 32.15],
    outward = [119.12, 32.35];
  const routes = [
    [[a, via, b]],
    [[b, via, a]],
    [
      [a, via, b],
      [b, outward, end],
    ],
  ];
  for (const paths of routes) {
    const trip = {
      mode: 'train',
      from: { coord: paths[0][0] },
      to: { coord: paths.at(-1).at(-1) },
      stops: [
        { coord: paths[0][0] },
        ...paths.map((path) => ({ coord: path.at(-1) })),
      ],
      legs: paths.map((coordinates) => ({ coordinates })),
    };
    assert.deepEqual(tripRouteLines(trip), paths);
    const actualVertices = paths.flat().map(mercatorPoint),
      bounds = journeyBounds([trip]);
    for (const [lng, lat] of paths.flat())
      assert.ok(
        lng >= bounds.getWest() &&
          lng <= bounds.getEast() &&
          lat >= bounds.getSouth() &&
          lat <= bounds.getNorth(),
      );
    const videoViewports = [1, 1.5].map((scale) => ({
      width: 1280 * scale,
      height: 720 * scale,
      blockers: videoViewportBlockers(scale),
    }));
    for (const viewport of [...viewports, ...videoViewports])
      assertVisible(
        actualVertices,
        fitInViewport(journeyWorldPoints([trip]), viewport),
        viewport,
      );
    assert.deepEqual(tripRouteLines({ ...trip, routeState: 'pending' }), []);
  }
});

test('空行程、无空间以及最小 zoom 仍无法容纳时返回 null', () => {
  const viewport = {
    width: 390,
    height: 520,
    rect: { left: 20, top: 180, right: 370, bottom: 330 },
  };
  assert.equal(fitMercatorPoints([], viewport), null);
  assert.equal(
    fitMercatorPoints([[0.5, 0.5, 0]], {
      ...viewport,
      rect: { left: 0, right: 0, top: 0, bottom: 100 },
    }),
    null,
  );
  assert.equal(
    fitMercatorPoints(
      [
        [0.1, 0.1, 0],
        [0.9, 0.9, 0],
      ],
      { ...viewport, minZoom: 10, maxZoom: 10 },
    ),
    null,
  );
  assert.deepEqual(
    safeViewportRects({
      width: 390,
      height: 520,
      blockers: [{ left: 0, top: 0, right: 390, bottom: 520 }],
    }),
    [],
  );
});

test('十五万路线点不会因 Math.min/max 的参数展开而溢出', () => {
  const points = Array.from({ length: 150000 }, (_, i) => [
    0.82 + i * 0.0000000001,
    0.36,
    0,
  ]);
  const viewport = {
    width: 1000,
    height: 800,
    rect: { left: 20, top: 100, right: 980, bottom: 600 },
    minZoom: 8,
    maxZoom: 8,
  };
  const fit = fitMercatorPoints(points, viewport);
  assert.ok(fit?.inside);
  assert.ok(Object.values(fit.bounds).every(Number.isFinite));
  assertVisible([points[0], points.at(-1)], fit, viewport);
});

// Screenshot-shaped synthetic data: these are geographical test fixtures,
// not the user's saved train numbers, times, or route geometry.
function multicityPoints() {
  const c = {
    ctu: [103.9471, 30.5785],
    sia: [108.9402, 34.3765],
    tsn: [117.0604, 39.062],
    she: [123.4833, 41.6398],
    nkg: [118.862, 31.735],
    xmn: [118.128, 24.544],
    su: [120.613, 31.324],
    nj: [118.796, 31.97],
    xl: [118.91, 32.125],
    njc: [118.797, 32.087],
  };
  const pairs = [
    ['nj', 'sia', 'train'],
    ['sia', 'nj', 'train'],
    ['nkg', 'ctu', 'flight'],
    ['ctu', 'nkg', 'flight'],
    ['nj', 'su', 'train'],
    ['su', 'xl', 'train'],
    ['njc', 'tsn', 'train'],
    ['tsn', 'nj', 'train'],
    ['nkg', 'she', 'flight'],
    ['she', 'nkg', 'flight'],
    ['nkg', 'xmn', 'flight'],
    ['xmn', 'nkg', 'flight'],
  ];
  return journeyWorldPoints(
    pairs.map(([a, b, mode]) => ({
      mode,
      distance: distance(c[a], c[b]),
      from: { coord: c[a] },
      to: { coord: c[b] },
      stops: [],
      routeCoordinates: mode === 'train' ? [c[a], c[b]] : undefined,
    })),
  );
}
function multicityViewport(width, height) {
  return {
    width,
    height,
    pitch: 48,
    bearing: -13,
    edge: 28,
    gap: 20,
    maxZoom: 13,
    blockers: [
      { left: 36, top: 35, right: 450, bottom: 140 },
      { left: 36, top: 150, right: 350, bottom: 170 },
      { left: width - 300, top: 30, right: width - 26, bottom: 180 },
      {
        left: width / 2 - 500,
        top: height - 176,
        right: width / 2 + 500,
        bottom: height - 34,
      },
      { left: 36, top: height - 205, right: 380, bottom: height - 187 },
    ],
  };
}
function referenceBounds(points, fit, viewport) {
  const project = referenceProjector(fit.camera, viewport),
    bounds = {
      left: Infinity,
      top: Infinity,
      right: -Infinity,
      bottom: -Infinity,
    };
  for (const point of points) {
    const p = project(point);
    bounds.left = Math.min(bounds.left, p.x);
    bounds.right = Math.max(bounds.right, p.x);
    bounds.top = Math.min(bounds.top, p.y);
    bounds.bottom = Math.max(bounds.bottom, p.y);
  }
  return {
    ...bounds,
    width: bounds.right - bounds.left,
    height: bounds.bottom - bounds.top,
  };
}

test('多城市总览优先放大屏幕上的路线，而不是只选择数值最大的 zoom', () => {
  const points = multicityPoints(),
    viewport = multicityViewport(2048, 1246);
  const fits = safeViewportRects(viewport)
    .map((rect) => fitMercatorPoints(points, { ...viewport, rect }))
    .filter(Boolean);
  const areas = fits.map((fit) => {
    const b = referenceBounds(points, fit, viewport);
    return { fit, area: b.width * b.height };
  });
  const largest = areas.reduce((a, b) => (a.area > b.area ? a : b)),
    highestZoom = areas.reduce((a, b) =>
      a.fit.camera.zoom > b.fit.camera.zoom ? a : b,
    );
  assert.ok(
    largest.area > highestZoom.area * 1.2,
    '测试布局应包含更高 zoom 却显示更小的透视陷阱',
  );
  const fit = fitInViewport(points, viewport),
    bounds = referenceBounds(points, fit, viewport);
  assertVisible(points, fit, viewport);
  assert.ok(
    bounds.width * bounds.height >= largest.area * 0.98,
    '应采用接近最大实际可见面积的方案，不能被较大的 zoom 数值误导',
  );
});

test('2560 像素宽的全屏多城市路线使用新增空间，不保留小窗口的缩放', () => {
  const points = multicityPoints(),
    large = multicityViewport(2560, 1558),
    small = multicityViewport(1440, 900);
  const fit = fitInViewport(points, large),
    smallFit = fitInViewport(points, small),
    bounds = referenceBounds(points, fit, large),
    smallBounds = referenceBounds(points, smallFit, small);
  assertVisible(points, fit, large);
  assert.ok(bounds.width > large.width * 0.6, '横向轨迹应超过全屏宽度的六成');
  assert.ok(
    bounds.height > large.height * 0.65,
    '纵向轨迹应超过全屏高度的六成五',
  );
  assert.ok(
    bounds.width * bounds.height > smallBounds.width * smallBounds.height * 2.4,
    '大屏路线应随可用面积明显放大',
  );
  assert.ok(
    bounds.top < large.height * 0.2,
    '不应在路线顶部留下超过两成屏高的无用留白',
  );
});
