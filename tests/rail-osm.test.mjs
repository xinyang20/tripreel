import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildOsmCorridor,
  importOsmFile,
} from '../scripts/import-rail-osm.mjs';
import {
  createOsmRailProvider,
  validateOsmDataset,
} from '../scripts/rail-osm.mjs';

const readJSON = async (file) =>
  JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
const dataset = await readJSON('../dist/data/rail-corridors.json');
const raw = await readJSON('../scripts/rail-data/jinghu-356778.osm');
const manifest = await readJSON('../scripts/rail-data/jinghu-pilot.json');
const scheduleEvidence = await readJSON(
  '../scripts/rail-data/g1-stops-2026-10-02.json',
);
const schedule = {
  number: 'G1',
  stops: manifest.trains[0].stops.map((name) => ({ name })),
};
const selected = (from = '沧州西', to = '南京南') => ({
  stops: schedule.stops.slice(
    schedule.stops.findIndex((stop) => stop.name === from),
    schedule.stops.findIndex((stop) => stop.name === to) + 1,
  ),
});

test('独立 OSM 原始关系可重复构建试点，截取后保留来源与确认要求', () => {
  const rebuilt = buildOsmCorridor(raw, manifest);
  assert.deepEqual(rebuilt, dataset);
  assert.deepEqual(
    scheduleEvidence.stops.map((stop) => stop.name),
    manifest.trains[0].stops,
  );
  assert.equal(
    scheduleEvidence.sourceUrl,
    manifest.trains[0].evidence.scheduleUrl,
  );
  const provider = createOsmRailProvider(rebuilt, { today: '2026-10-02' });
  const route = provider.resolve({
    number: 'G1',
    schedule,
    selectedSchedule: selected(),
  });
  assert.equal(route.quality, 'corridor');
  assert.equal(route.requiresConfirmation, true);
  assert.equal(route.resolution.state, 'needs-confirmation');
  assert.equal(route.routeProvider, 'osm-local');
  assert.equal(route.routeDataVersion, manifest.dataVersion);
  assert.equal(route.routeFetchedAt, null);
  assert.equal(route.routeEvidence.geometry.sourceDate, '2026-10-02');
  assert.equal(route.routeEvidence.geometry.relationId, 356778);
  assert.equal(route.routeEvidence.service.scheduleDate, '2026-10-02');
  assert.ok(route.distance > 780 && route.distance < 840);
  assert.ok(route.stops.every((stop) => stop.routeMatched));
  assert.deepEqual(
    route.stops.map((stop) => stop.name),
    ['沧州西', '德州东', '曲阜东', '南京南'],
  );
  assert.ok(
    provider.resolve({
      number: 'G1',
      schedule,
      selectedSchedule: selected('德州东', '曲阜东'),
    }).distance < route.distance,
  );
});

test('车次身份、停站顺序、区间边界与反向均不能从几何推断', () => {
  const provider = createOsmRailProvider(dataset, { today: '2026-10-02' });
  for (const args of [
    { number: 'G813', schedule, selectedSchedule: selected() },
    { number: 'G1', schedule: null, selectedSchedule: selected() },
    {
      number: 'G1',
      schedule: { ...schedule, stops: [...schedule.stops].reverse() },
      selectedSchedule: selected(),
    },
    {
      number: 'G1',
      schedule: { ...schedule, stops: [...schedule.stops, { name: '未知' }] },
      selectedSchedule: selected(),
    },
    { number: 'G1', schedule, selectedSchedule: { stops: schedule.stops } },
    {
      number: 'G1',
      schedule,
      selectedSchedule: { stops: [...selected().stops].reverse() },
    },
    {
      number: 'G1',
      schedule,
      selectedSchedule: { stops: [{ name: '沧州西' }, { name: '南京南' }] },
    },
  ])
    assert.throws(() => provider.resolve(args), /停站|白名单/);
});

test('损坏、未知版本、坐标与证据缺失数据不进入提供者', () => {
  for (const mutate of [
    (data) => {
      data.version = 2;
    },
    (data) => {
      data.corridors[0].coordinates[0] = [Infinity, 30];
    },
    (data) => {
      data.corridors[0].stations[1].coord = [110, 30];
    },
    (data) => {
      data.corridors[0].trains[0].evidence.routeUrl = '';
    },
    (data) => {
      data.corridors[0].distanceRangeKm = [10, 20];
    },
    (data) => {
      data.corridors[0].trains[0].evidence.validUntil = '2026-12-01';
    },
    (data) => {
      data.corridors[0].trains[0].evidence.validFrom = '2026-02-30';
    },
  ]) {
    const broken = structuredClone(dataset);
    mutate(broken);
    assert.throws(() => validateOsmDataset(broken));
  }
  assert.match(createOsmRailProvider(null).capability.coverage, /暂未收录/);
});

test('车次映射按北京时间生效和到期，返回证据不能更改后续提供者状态', () => {
  let today = '2026-10-01';
  const provider = createOsmRailProvider(dataset, { today: () => today });
  const args = { number: 'G1', schedule, selectedSchedule: selected() };
  assert.match(provider.capability.coverage, /未生效或已到期/);
  assert.throws(() => provider.resolve(args), /白名单/);
  today = '2026-10-02';
  assert.match(
    provider.capability.coverage,
    /G1（沧州西、德州东、曲阜东、南京南/,
  );
  const route = provider.resolve(args);
  assert.equal(route.routeEvidence.service.validUntil, '2026-11-01');
  route.routeEvidence.service.validUntil = '2099-01-01';
  route.routeEvidence.geometry.relationId = -1;
  const again = provider.resolve(args);
  assert.equal(again.routeEvidence.service.validUntil, '2026-11-01');
  assert.equal(again.routeEvidence.geometry.relationId, 356778);
  today = '2026-11-01';
  assert.equal(provider.resolve(args).quality, 'corridor');
  today = '2026-11-02';
  assert.match(provider.capability.coverage, /未生效或已到期/);
  assert.equal(provider.capability.dataVersion, null);
  assert.throws(() => provider.resolve(args), /白名单/);
});

test('原始数据缺 way、缺 node 或所选股道有分岔时拒绝构建', () => {
  const seed = raw.elements.find(
    (element) => element.type === 'way' && element.id === manifest.trackSeedWay,
  );
  for (const broken of [
    {
      ...raw,
      elements: raw.elements.filter(
        (element) => !(element.type === 'way' && element.id === seed.id),
      ),
    },
    {
      ...raw,
      elements: raw.elements.filter(
        (element) => !(element.type === 'node' && element.id === seed.nodes[0]),
      ),
    },
  ])
    assert.throws(() => buildOsmCorridor(broken, manifest), /不完整/);
  const branching = structuredClone(raw);
  branching.elements.push({ ...seed, id: -1 });
  branching.elements
    .find((element) => element.type === 'relation')
    .members.push({ type: 'way', ref: -1, role: '' });
  assert.throws(() => buildOsmCorridor(branching, manifest), /分岔/);
  const changedVersion = structuredClone(raw);
  changedVersion.elements.find((element) => element.type === 'relation')
    .version++;
  assert.throws(() => buildOsmCorridor(changedVersion, manifest), /版本/);
});

test('导入失败保留旧数据，成功只原子替换明确的输出文件', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tripreel-osm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'routes.json'),
    bad = path.join(dir, 'broken.json');
  await writeFile(output, 'previous');
  await writeFile(bad, '{}');
  const options = {
    osm: filePath('../scripts/rail-data/jinghu-356778.osm'),
    manifest: bad,
    output,
  };
  await assert.rejects(importOsmFile(options));
  assert.equal(await readFile(output, 'utf8'), 'previous');
  await importOsmFile({
    ...options,
    manifest: filePath('../scripts/rail-data/jinghu-pilot.json'),
  });
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), dataset);
});

function filePath(relative) {
  return new URL(relative, import.meta.url).pathname;
}
