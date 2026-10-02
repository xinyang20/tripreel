import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestJourney } from './rail-geometry.mjs';
import { validateOsmDataset } from './rail-osm.mjs';

// Read a reviewed OSM relation and follow its connected, unbranched track only.
// Missing ways/nodes and junction ambiguity are errors, not invented connectors.
export function buildOsmCorridor(raw, manifest) {
  if (!Array.isArray(raw?.elements)) throw new Error('缺少 OSM elements。');
  if (
    !/^https?:\/\/opendatacommons\.org\/licenses\/odbl\/1-0\/?$/.test(
      raw.license || '',
    )
  )
    throw new Error('原始资料必须保留可核对的 ODbL 数据许可。');
  const relation = raw.elements.find(
    (element) =>
      element.type === 'relation' && element.id === manifest.relationId,
  );
  if (
    !relation ||
    relation.tags?.route !== 'railway' ||
    !Number.isInteger(relation.version) ||
    relation.version !== manifest.relationVersion ||
    relation.timestamp !== manifest.relationTimestamp
  )
    throw new Error('缺少已核实的铁路线路 relation，或版本与核实清单不符。');
  const nodes = new Map(
    raw.elements
      .filter((element) => element.type === 'node')
      .map((node) => [node.id, node]),
  );
  const sourceWays = new Map(
    raw.elements
      .filter((element) => element.type === 'way')
      .map((way) => [way.id, way]),
  );
  const ways = new Map();
  const ends = new Map();
  for (const member of relation.members) {
    if (member.type === 'relation')
      throw new Error('嵌套关系需要单独核实，不能自动展开。');
    if (member.type !== 'way') continue;
    const way = sourceWays.get(member.ref);
    if (
      !way ||
      way.tags?.railway !== 'rail' ||
      !Array.isArray(way.nodes) ||
      way.nodes.length < 2 ||
      way.nodes.some((id) => !nodes.has(id))
    )
      throw new Error('铁路 way 或坐标节点不完整。');
    if (ways.has(way.id)) throw new Error('关系包含重复 way。');
    ways.set(way.id, way);
    for (const id of [way.nodes[0], way.nodes.at(-1)]) {
      if (!ends.has(id)) ends.set(id, []);
      ends.get(id).push(way.id);
    }
  }
  const seed = ways.get(manifest.trackSeedWay);
  if (!seed) throw new Error('所选股道的 seed way 不属于本关系。');
  const walk = (firstNode, firstWay, collect) => {
    const visited = new Set();
    let nodeId = firstNode,
      wayId = firstWay;
    while (wayId !== undefined) {
      if (visited.has(wayId)) throw new Error('所选股道存在环路，需人工核对。');
      visited.add(wayId);
      const way = ways.get(wayId);
      const ordered =
        way.nodes[0] === nodeId ? way.nodes : [...way.nodes].reverse();
      collect?.(way, ordered);
      nodeId = ordered.at(-1);
      const next = ends.get(nodeId).filter((id) => id !== wayId);
      if (next.length > 1) throw new Error('所选股道存在分岔，不能自动选择。');
      wayId = next[0];
    }
    return nodeId;
  };
  const endpoint = walk(seed.nodes[0], seed.id);
  const coordinates = [],
    wayIds = [];
  walk(endpoint, ends.get(endpoint)[0], (way, ids) => {
    wayIds.push(way.id);
    for (const id of coordinates.length ? ids.slice(1) : ids) {
      const node = nodes.get(id);
      coordinates.push([node.lon, node.lat]);
    }
  });
  const stations = manifest.stationNodeIds.map((id) => {
    const node = nodes.get(id);
    if (
      !node ||
      node.tags?.railway !== 'station' ||
      !node.tags.name ||
      !relation.members.some(
        (member) => member.type === 'node' && member.ref === id,
      )
    )
      throw new Error('所选站点缺少 relation 成员和车站标签。');
    return { name: node.tags.name, coord: [node.lon, node.lat], osmNodeId: id };
  });
  let journey;
  for (const line of [coordinates, [...coordinates].reverse()]) {
    try {
      const result = latestJourney(
        { coordinates: line, stations, gaps: [] },
        stations,
        null,
      );
      if (result.stops.some((stop) => !stop.routeMatched)) continue;
      journey = result;
      break;
    } catch {}
  }
  if (!journey) throw new Error('所选股道不能连续连接全部站点。');
  const result = {
    version: 1,
    dataVersion: manifest.dataVersion,
    sourceDate: manifest.sourceDate,
    coordinateSystem: 'WGS84',
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    corridors: [
      {
        id: manifest.id,
        name: manifest.name,
        stations,
        coordinates: journey.routeCoordinates,
        distanceRangeKm: manifest.distanceRangeKm,
        trains: manifest.trains,
        evidence: {
          geometry: {
            url: `https://www.openstreetmap.org/relation/${relation.id}`,
            relationId: relation.id,
            relationVersion: relation.version,
            relationTimestamp: relation.timestamp,
            sourceDate: manifest.sourceDate,
            trackSeedWay: manifest.trackSeedWay,
            wayIds,
            note: '仅沿本 relation 内连续且无分岔的一股轨道裁剪；站内实际股道不作声明。',
          },
        },
      },
    ],
  };
  return validateOsmDataset(result);
}

export async function importOsmFile({ osm, manifest, output }) {
  if (!osm || !manifest || !output)
    throw new Error('必须明确提供 --osm、--manifest 和 --output。');
  const [raw, rules] = await Promise.all([
    readFile(osm, 'utf8'),
    readFile(manifest, 'utf8'),
  ]);
  const data = buildOsmCorridor(JSON.parse(raw), JSON.parse(rules));
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  let created = false;
  try {
    await writeFile(temporary, JSON.stringify(data) + '\n', { flag: 'wx' });
    created = true;
    await rename(temporary, output);
  } finally {
    if (created) await rm(temporary, { force: true });
  }
  return {
    output,
    dataVersion: data.dataVersion,
    corridors: data.corridors.length,
    points: data.corridors.reduce(
      (sum, corridor) => sum + corridor.coordinates.length,
      0,
    ),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2),
      options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (
        !['--osm', '--manifest', '--output'].includes(args[i]) ||
        !args[i + 1]
      )
        throw new Error('参数仅支持 --osm、--manifest、--output。');
      options[args[i].slice(2)] = args[i + 1];
    }
    console.log(JSON.stringify(await importOsmFile(options)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
