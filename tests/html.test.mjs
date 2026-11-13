import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, safe, raw } from '../dist/html.js';

test('插值默认转义，属性值中的引号也被转义', () => {
  const name = `<img src=x onerror="alert('x')">`;
  assert.equal(
    String(safe`<p title="${name}">${name}</p>`),
    '<p title="&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;">&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;</p>',
  );
  assert.equal(esc(null), '');
  assert.equal(esc(0), '0');
});

test('嵌套片段和数组不重复转义，空值与 false 不输出', () => {
  const items = ['a&b', '<c>'].map((item) => safe`<li>${item}</li>`);
  assert.equal(
    String(safe`<ul>${items}${false}${null}${undefined}</ul>`),
    '<ul><li>a&amp;b</li><li>&lt;c&gt;</li></ul>',
  );
  assert.equal(String(safe`${0} 段`), '0 段');
});

test('raw 仅保留可信片段，与字符串拼接时输出原始标记', () => {
  const trusted = raw('<svg></svg>');
  assert.equal(String(safe`<div>${trusted}</div>`), '<div><svg></svg></div>');
  assert.equal('前' + safe`<b>${'&'}</b>`, '前<b>&amp;</b>');
});
