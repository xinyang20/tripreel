import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCameraFitCache,
  fitInViewport,
  mercatorPoint,
  projectMercator,
} from '../dist/camera-fit.js';
const options = {
  width: 1280,
  height: 720,
  pitch: 48,
  bearing: -13,
  blockers: [
    { left: 25, top: 25, right: 650, bottom: 125 },
    { left: 25, top: 600, right: 1255, bottom: 720 },
  ],
};
function assertInside(points, fit, viewport) {
  assert.ok(fit?.inside);
  for (const point of points) {
    const pixel = projectMercator(point, fit.camera, viewport);
    assert.ok(
      pixel.w > 0 &&
        pixel.x >= fit.rect.left - 0.01 &&
        pixel.x <= fit.rect.right + 0.01 &&
        pixel.y >= fit.rect.top - 0.01 &&
        pixel.y <= fit.rect.bottom + 0.01,
    );
  }
}
test('精确约束保留绕行、折返、重复点与高度，退化几何保持确定取景', () => {
  const paths = [
    [
      [118.8, 32],
      [117, 35],
      [120, 31],
      [118.8, 32],
    ],
    [
      [118.8, 32, 0],
      [117, 35, 180000],
      [120, 31, 0],
    ],
    Array.from({ length: 20 }, () => [118.8, 32]),
  ];
  for (const path of paths)
    for (const pitch of [0, 48, 65]) {
      const points = path.map(mercatorPoint),
        viewport = { ...options, pitch },
        fit = fitInViewport(points, viewport);
      assertInside(points, fit, viewport);
      const reversed = fitInViewport([...points].reverse(), viewport);
      assertInside(points, reversed, viewport);
      assert.ok(Math.abs(reversed.camera.zoom - fit.camera.zoom) < 1e-5);
      assert.ok(
        Math.hypot(
          ...reversed.camera.center.map((n, i) => n - fit.camera.center[i]),
        ) < 1e-8,
      );
    }
});
test('相机缓存按几何、视口和遮挡区隔离，并遵守容量和清理边界', () => {
  const cache = createCameraFitCache({
      maxPointSets: 2,
      maxViews: 2,
      maxPoints: 6,
    }),
    a = [
      [118, 32],
      [119, 33],
    ].map(mercatorPoint),
    b = [
      [117, 32],
      [118, 33],
    ].map(mercatorPoint),
    c = [
      [116, 32],
      [117, 33],
    ].map(mercatorPoint);
  const first = cache.fit(a, options);
  assert.strictEqual(cache.fit(a, { ...options }), first);
  assert.notStrictEqual(cache.fit(a, { ...options, width: 390 }), first);
  cache.fit(a, { ...options, height: 900 });
  assert.notStrictEqual(cache.fit(a, options), first, '单几何视口缓存有界');
  const newer = cache.fit(a, options);
  cache.fit(b, options);
  cache.fit(c, options);
  assert.notStrictEqual(cache.fit(a, options), newer, '几何集合缓存有界');
  const recent = cache.fit(a, options);
  cache.clear();
  assert.notStrictEqual(cache.fit(a, options), recent);
  const uncached = createCameraFitCache({ maxPoints: 1 });
  assert.notStrictEqual(
    uncached.fit(a, options),
    uncached.fit(a, options),
    '超限输入不占缓存',
  );
});
