import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPlaceLabels } from '../dist/map-labels.js';
function documentStub() {
  const counts = { created: 0, replaced: 0 };
  const doc = {
    createElement() {
      return element();
    },
    createElementNS() {
      return element();
    },
  };
  function element() {
    counts.created++;
    return {
      ownerDocument: doc,
      children: [],
      style: {},
      attributes: new Map(),
      append(...nodes) {
        for (const node of nodes) {
          node.parentNode = this;
          this.children.push(node);
        }
      },
      replaceChildren(...nodes) {
        counts.replaced++;
        for (const node of this.children) node.parentNode = null;
        this.children = [];
        this.append(...nodes);
      },
      setAttribute(k, v) {
        this.attributes.set(k, v);
      },
      getAttribute(k) {
        return this.attributes.get(k) || null;
      },
      remove() {
        const parent = this.parentNode;
        if (parent) {
          parent.children.splice(parent.children.indexOf(this), 1);
          this.parentNode = null;
        }
      },
    };
  }
  return { element, counts };
}
const label = {
  key: '南京南:118,32',
  name: '南京南',
  members: ['南京南'],
  anchorX: 200,
  anchorY: 220,
  x: 180,
  y: 180,
  width: 80,
  height: 28,
};
test('地名与连线在相机移动时保留节点身份，只在成员改变时增删', () => {
  const { element, counts } = documentStub(),
    overlay = element();
  renderPlaceLabels(overlay, [label]);
  const svg = overlay.children[0],
    node = overlay.children[1],
    line = svg.children[0],
    created = counts.created;
  for (let i = 0; i < 50; i++)
    renderPlaceLabels(overlay, [{ ...label, x: 180 + i, anchorX: 200 + i }]);
  assert.strictEqual(overlay.children[1], node);
  assert.strictEqual(svg.children[0], line);
  assert.equal(counts.created, created);
  assert.equal(counts.replaced, 1);
  assert.equal(node.style.left, '229px');
  renderPlaceLabels(overlay, [
    {
      ...label,
      key: 'city:南京',
      name: '南京',
      members: ['南京南', '仙林'],
      merged: true,
    },
  ]);
  assert.equal(node.parentNode, null);
  assert.equal(line.parentNode, null);
  assert.strictEqual(overlay.children[0], svg);
  assert.equal(overlay.children[1].textContent, '南京');
  assert.equal(svg.children.length, 1);
  renderPlaceLabels(overlay, []);
  assert.equal(overlay.children.length, 1);
  assert.equal(svg.children.length, 0);
});
