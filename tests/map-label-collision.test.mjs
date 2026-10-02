import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutPlaceLabels } from '../dist/map-labels.js';

const overlaps = (a, b) =>
  a.x < b.x + b.width + 5 &&
  a.x + a.width + 5 > b.x &&
  a.y < b.y + b.height + 5 &&
  a.y + a.height + 5 > b.y;

test('密集未知端点完整保留，每个位置与穷举碰撞计数的最优结果一致', () => {
  const places = Array.from({ length: 360 }, (_, i) => ({
    name: i % 9 === 0 ? '同名地点' : `未知地点${i}`,
    kind: i % 4 ? 'train' : 'flight',
    coord: [200 + (i % 19) * 5, 170 + (i % 13) * 4],
  }));
  const blockers = [
      { left: 10, top: 10, right: 600, bottom: 125 },
      { left: 10, top: 450, right: 790, bottom: 590 },
    ],
    obstacles = blockers.map((box) => ({
      x: box.left,
      y: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top,
    }));
  const labels = layoutPlaceLabels(places, {
    project: (p) => ({ x: p[0], y: p[1] }),
    zoom: 9,
    width: 800,
    height: 600,
    blockers,
  });
  assert.equal(labels.length, places.length);
  const placed = [];
  for (const label of labels) {
    const w = label.width,
      h = label.height;
    const offsets = [
      [0, -40],
      [0, 14],
      [w / 2 + 12, -14],
      [-w / 2 - 12, -14],
      [0, -76],
      [0, 50],
      [w / 2 + 12, -50],
      [-w / 2 - 12, 22],
    ];
    const candidates = offsets.map(([dx, dy]) => ({
      x: Math.max(6, Math.min(800 - w - 6, label.anchorX - w / 2 + dx)),
      y: Math.max(6, Math.min(600 - h - 6, label.anchorY + dy)),
      width: w,
      height: h,
    }));
    const scores = candidates.map(
      (box) =>
        placed.filter((other) => overlaps(box, other)).length +
        10 * obstacles.filter((other) => overlaps(box, other)).length,
    );
    const best = candidates[scores.indexOf(Math.min(...scores))];
    assert.deepEqual([label.x, label.y], [best.x, best.y]);
    placed.push(label);
  }
});
