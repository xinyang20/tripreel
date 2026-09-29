import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  readdir,
  rm,
  rename,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildData, prepareData, parseCSV } from '../scripts/prepare-data.mjs';
const fixture = {
  stationCSV: 'station_name,lon,lat\n甲,110,30\n乙,111,31\n',
  stationNames:
    "var station_names='@jia|甲|AAA|jia|j|0|01|测试城|||@yi|乙|BBB|yi|y|1|01|测试城|||';",
  airportCSV:
    'iso_country,iata_code,type,name,coordinates,icao_code,municipality\nCN,NKG,large_airport,"Test, Airport","32, 119",ZSNJ,Nanjing\n',
  network: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [110, 30],
            [111, 31],
          ],
        },
        properties: {},
      },
    ],
    metadata: { license: 'ODbL', builtAt: '2026-09-02' },
  },
  sourceDate: '2026-09-21',
  generatedAt: '2026-09-26T00:00:00.000Z',
};
async function prepareFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'travel-data-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = {
    stationCSVPath: path.join(dir, 'stations.csv'),
    stationNamesPath: path.join(dir, 'names.js'),
    airportCSVPath: path.join(dir, 'airports.csv'),
    outputDir: path.join(dir, 'data'),
    ...fixture,
  };
  await Promise.all(
    [
      [paths.stationCSVPath, fixture.stationCSV],
      [paths.stationNamesPath, fixture.stationNames],
      [paths.airportCSVPath, fixture.airportCSV],
    ].map(([filename, text]) => writeFile(filename, text)),
  );
  await mkdir(paths.outputDir);
  await writeFile(path.join(paths.outputDir, 'stations.json'), 'ORIGINAL');
  await writeFile(path.join(paths.outputDir, 'countries.geojson'), 'PRESERVE');
  return { dir, paths };
}
test('CSV 引号解析、坐标顺序、同城分组和来源日期可独立重建', () => {
  assert.deepEqual(parseCSV('a,b\n"a,b","x""y"\n'), [
    ['a', 'b'],
    ['a,b', 'x"y'],
  ]);
  const result = buildData(fixture);
  assert.deepEqual(result['airports.json'][0].coord, [119, 32]);
  assert.equal(result['place-city-groups.json'].stations.甲.city, '测试城');
  assert.equal(result['place-city-groups.json'].airports.NKG.city, '南京');
  assert.equal(result['data-sources.json'].sourceDate, '2026-09-21');
  assert.equal(
    result['data-sources.json'].generatedAt,
    '2026-09-26T00:00:00.000Z',
  );
  assert.equal(
    result['data-sources.json'].sources.railwayBackground.date,
    '2026-09-02',
  );
});
test('缺字段、坏坐标、重复代码、未闭合CSV、坏背景全部拒绝', () => {
  assert.throws(
    () => buildData({ ...fixture, airportCSV: 'x,y\na,b' }),
    /缺少字段/,
  );
  assert.throws(
    () =>
      buildData({ ...fixture, stationCSV: 'station_name,lon,lat\n甲,no,30' }),
    /无效经纬度/,
  );
  assert.throws(
    () =>
      buildData({
        ...fixture,
        stationNames: fixture.stationNames.replace('BBB', 'AAA'),
      }),
    /代码.*重复/,
  );
  assert.throws(() => parseCSV('a,b\n"broken'), /引号未闭合/);
  assert.throws(
    () =>
      buildData({
        ...fixture,
        network: { type: 'FeatureCollection', features: [] },
      }),
    /非空/,
  );
  assert.throws(
    () => buildData({ ...fixture, sourceDate: undefined }),
    /来源核实日期/,
  );
});
test('成功只发布校验通过整组文件，保留原目录其他资源', async (t) => {
  const { paths } = await prepareFixture(t);
  const manifest = await prepareData(paths);
  assert.equal(manifest.counts.stations, 2);
  assert.equal(
    await readFile(path.join(paths.outputDir, 'countries.geojson'), 'utf8'),
    'PRESERVE',
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(paths.outputDir, 'stations.json'), 'utf8'),
    ).length,
    2,
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(paths.outputDir, 'data-sources.json'), 'utf8'),
    ).sourceDate,
    fixture.sourceDate,
  );
});
test('任何输入校验失败均不碰输出；发布失败完整回滚', async (t) => {
  const { dir, paths } = await prepareFixture(t);
  await writeFile(paths.airportCSVPath, 'bad');
  await assert.rejects(prepareData(paths), /缺少字段/);
  assert.equal(
    await readFile(path.join(paths.outputDir, 'stations.json'), 'utf8'),
    'ORIGINAL',
  );
  await writeFile(paths.airportCSVPath, fixture.airportCSV);
  let count = 0;
  await assert.rejects(
    prepareData({
      ...paths,
      renameImpl: async (from, to) => {
        if (++count === 2) throw new Error('simulated publish failure');
        return rename(from, to);
      },
    }),
    /simulated publish/,
  );
  assert.equal(
    await readFile(path.join(paths.outputDir, 'stations.json'), 'utf8'),
    'ORIGINAL',
  );
  assert.equal(
    await readFile(path.join(paths.outputDir, 'countries.geojson'), 'utf8'),
    'PRESERVE',
  );
  assert.equal(
    (await readdir(dir)).some((name) => name.startsWith('.travel-data')),
    false,
  );
});
