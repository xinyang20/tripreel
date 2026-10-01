import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutPlaceLabels } from '../dist/map-labels.js';
import { videoViewportBlockers } from '../dist/video-layout.js';

test('视频地名避开片头和底栏，720p 与 1080p 取景使用同一版式', () => {
  const blockers = videoViewportBlockers();
  for (const anchor of [
    { x: 300, y: 145 },
    { x: 850, y: 590 },
  ]) {
    const labels = layoutPlaceLabels(
      [{ name: '合成的较长起终点名称', coord: [118, 32] }],
      {
        project: () => anchor,
        zoom: 5,
        width: 1280,
        height: 720,
        detail: true,
        blockers,
      },
    );
    assert.equal(labels.length, 1);
    for (const label of labels)
      for (const blocker of blockers)
        assert.ok(
          label.x + label.width <= blocker.left ||
            label.x >= blocker.right ||
            label.y + label.height <= blocker.top ||
            label.y >= blocker.bottom,
          '地名不能与标题或播放栏交叠',
        );
  }
  for (const scale of [1, 1.5])
    assert.deepEqual(
      videoViewportBlockers(scale).map((rect) =>
        Object.fromEntries(
          Object.entries(rect).map(([edge, value]) => [edge, value / scale]),
        ),
      ),
      blockers,
    );
});
