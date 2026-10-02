import { cp, mkdir, access } from 'node:fs/promises';
await mkdir('dist/vendor', { recursive: true });
for (const [from, to] of [
  ['node_modules/maplibre-gl/dist/maplibre-gl.mjs', 'maplibre-gl.mjs'],
  [
    'node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs',
    'maplibre-gl-shared.mjs',
  ],
  [
    'node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs',
    'maplibre-gl-worker.mjs',
  ],
  ['node_modules/maplibre-gl/dist/maplibre-gl.css', 'maplibre-gl.css'],
  ['node_modules/three/build/three.module.js', 'three.module.js'],
  ['node_modules/three/build/three.core.js', 'three.core.js'],
])
  await cp(from, `dist/vendor/${to}`);
for (const file of [
  'index.html',
  'app.js',
  'styles.css',
  'controls.css',
  'core.js',
])
  await access(`dist/${file}`);
console.log('已生成本地网站资源。');
