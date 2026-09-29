import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  cp,
  rename,
  rm,
  access,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CHINA_NETWORK } from '@railroute-ts/china';
import { coordinate, parseTime } from '../dist/core.js';

const airportAliases = {
  PEK: ['北京首都', '北京'],
  PKX: ['北京大兴', '北京'],
  SHA: ['上海虹桥', '上海'],
  PVG: ['上海浦东', '上海'],
  NKG: ['南京禄口', '南京'],
  HGH: ['杭州萧山', '杭州'],
  XMN: ['厦门高崎', '厦门'],
  FOC: ['福州长乐', '福州'],
  CAN: ['广州白云', '广州'],
  SZX: ['深圳宝安', '深圳'],
  CTU: ['成都双流', '成都'],
  TFU: ['成都天府', '成都'],
  CKG: ['重庆江北', '重庆'],
  XIY: ['西安咸阳', '西安'],
  WUH: ['武汉天河', '武汉'],
  CSX: ['长沙黄花', '长沙'],
  CGO: ['郑州新郑', '郑州'],
  TAO: ['青岛胶东', '青岛'],
  TNA: ['济南遥墙', '济南'],
  DLC: ['大连周水子', '大连'],
  SHE: ['沈阳桃仙', '沈阳'],
  HRB: ['哈尔滨太平', '哈尔滨'],
  KMG: ['昆明长水', '昆明'],
  KWE: ['贵阳龙洞堡', '贵阳'],
  NNG: ['南宁吴圩', '南宁'],
  HAK: ['海口美兰', '海口'],
  SYX: ['三亚凤凰', '三亚'],
  LHW: ['兰州中川', '兰州'],
  URC: ['乌鲁木齐天山', '乌鲁木齐'],
  LXA: ['拉萨贡嘎', '拉萨'],
  TSN: ['天津滨海', '天津'],
  HFE: ['合肥新桥', '合肥'],
  KHN: ['南昌昌北', '南昌'],
  WNZ: ['温州龙湾', '温州'],
  NGB: ['宁波栎社', '宁波'],
  WUX: ['无锡硕放', '无锡'],
  YNT: ['烟台蓬莱', '烟台'],
  CZX: ['常州奔牛', '常州'],
  YTY: ['扬州泰州', '扬州'],
  JJN: ['泉州晋江', '泉州'],
  ZUH: ['珠海金湾', '珠海'],
  HET: ['呼和浩特白塔', '呼和浩特'],
  INC: ['银川河东', '银川'],
  XNN: ['西宁曹家堡', '西宁'],
  SJW: ['石家庄正定', '石家庄'],
  TYN: ['太原武宿', '太原'],
  CGQ: ['长春龙嘉', '长春'],
};

export function parseCSV(input) {
  const rows = [];
  let row = [],
    cell = '',
    quoted = false;
  const text = input.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' && !quoted) {
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') cell += char;
  }
  if (quoted) throw new Error('CSV 引号未闭合，未发布数据。');
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
function records(csv, required) {
  const [headers, ...rows] = parseCSV(csv);
  if (!headers || required.some((key) => !headers.includes(key)))
    throw new Error(`CSV 缺少字段：${required.join('、')}`);
  return rows.map((row) => {
    if (row.length !== headers.length)
      throw new Error('CSV 列数不一致，未发布数据。');
    return Object.fromEntries(
      headers.map((header, index) => [header, row[index].trim()]),
    );
  });
}
function worldCoordinate(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every(Number.isFinite) ||
    Math.abs(value[0]) > 180 ||
    Math.abs(value[1]) > 90
  )
    throw new Error('来源包含无效经纬度，未发布数据。');
  return value;
}
function supportedCoordinate(value) {
  try {
    return coordinate(value);
  } catch {
    return null;
  }
}
function unique(items, field, label) {
  const seen = new Set();
  for (const item of items) {
    if (!item[field] || seen.has(item[field]))
      throw new Error(`${label}缺失或重复：${item[field] || '空值'}`);
    seen.add(item[field]);
  }
}
function validateNetwork(network) {
  if (
    network?.type !== 'FeatureCollection' ||
    !Array.isArray(network.features) ||
    !network.features.length
  )
    throw new Error('铁路背景不是有效的非空 FeatureCollection。');
  for (const feature of network.features) {
    const geometry = feature?.geometry;
    if (!['LineString', 'MultiLineString'].includes(geometry?.type))
      throw new Error('铁路背景含未知几何类型。');
    const lines =
      geometry.type === 'LineString'
        ? [geometry.coordinates]
        : geometry.coordinates;
    if (!Array.isArray(lines) || !lines.length)
      throw new Error('铁路背景缺少线路。');
    for (const line of lines) {
      if (!Array.isArray(line) || line.length < 2)
        throw new Error('铁路背景线路不完整。');
      line.forEach(worldCoordinate);
    }
  }
}
export function buildData({
  stationCSV,
  stationNames,
  airportCSV,
  network = CHINA_NETWORK,
  sourceDate,
  generatedAt = new Date().toISOString(),
  inputs = {},
}) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(sourceDate || '') ||
    !Number.isFinite(parseTime(`${sourceDate}T00:00`))
  )
    throw new Error(
      '必须明确提供有效的原始资料日期 --source-date，不把构建日期当成来源核实日期。',
    );
  const byName = new Map();
  for (const row of records(stationCSV, ['station_name', 'lon', 'lat'])) {
    if (!row.station_name || !row.lon || !row.lat)
      throw new Error('铁路站点 CSV 缺少名称或坐标。');
    const coord = worldCoordinate([Number(row.lon), Number(row.lat)]);
    byName.set(
      row.station_name,
      byName.has(row.station_name) ? null : supportedCoordinate(coord),
    );
  }
  const stationGroups = {},
    cityGroups = new Map();
  const stations = stationNames
    .split('@')
    .slice(1)
    .map((raw) => {
      const [, name, code, pinyin, , , group, city] = raw.split('|');
      if (!name || !/^[A-Z]{3}$/.test(code || ''))
        throw new Error('12306 站名文件格式错误，未发布数据。');
      stationGroups[name] = {
        code,
        city: city || null,
        cityGroup: group ? `12306:${group}` : null,
      };
      if (city && group) cityGroups.set(city, `12306:${group}`);
      return { name, code, pinyin, coord: byName.get(name) || null };
    });
  if (!stations.length) throw new Error('12306 站名文件为空，未发布数据。');
  unique(stations, 'name', '站名');
  unique(stations, 'code', '车站代码');
  if (!stations.some((stop) => stop.coord))
    throw new Error('未匹配到任何有效车站坐标，请核对输入资料，未发布数据。');
  const airportGroups = {};
  let excludedAirports = 0;
  const airports = records(airportCSV, [
    'iso_country',
    'iata_code',
    'type',
    'name',
    'coordinates',
  ])
    .filter(
      (row) =>
        row.iso_country === 'CN' && row.iata_code && row.type !== 'closed',
    )
    .flatMap((row) => {
      const coord = worldCoordinate(
        row.coordinates.split(',').map(Number).reverse(),
      );
      if (!supportedCoordinate(coord)) {
        excludedAirports++;
        return [];
      }
      if (!/^[A-Z]{3}$/.test(row.iata_code) || !row.name)
        throw new Error('机场代码或名称无效。');
      const [name, city] = airportAliases[row.iata_code] || [row.name, null];
      airportGroups[row.iata_code] = {
        name,
        city,
        cityGroup: city ? cityGroups.get(city) || `city:${city}` : null,
        municipality: row.municipality || null,
        assignment: city ? 'explicit-service-city' : null,
      };
      return [
        {
          name,
          english: row.name,
          code: row.iata_code,
          icao: row.icao_code || row.gps_code || '',
          coord,
        },
      ];
    });
  if (!airports.length) throw new Error('未生成任何范围内机场，未发布数据。');
  unique(airports, 'code', '机场三字码');
  validateNetwork(network);
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    sourceDate,
    coordinateSystem: 'WGS84',
    note: '来源日期由操作者提供；本脚本不联网，不表示生成当天重新核实。超出当前地图坐标范围的机场未纳入。',
    sources: {
      stations: {
        input: inputs.stationCSV || null,
        url: 'https://github.com/wensimehrp/chinese-railway-gtfs',
        license: 'OSM-derived; ODbL attribution retained',
        date: sourceDate,
      },
      stationNames: {
        input: inputs.stationNames || null,
        url: 'https://kyfw.12306.cn/otn/resources/js/framework/station_name.js',
        date: sourceDate,
      },
      airports: {
        input: inputs.airports || null,
        url: 'https://ourairports.com/data/',
        license: 'Public domain',
        date: sourceDate,
      },
      railwayBackground: {
        package: '@railroute-ts/china',
        url: 'https://github.com/mayurrawte/railroutes',
        license: network.metadata?.license || 'ODbL-1.0',
        date: network.metadata?.builtAt || null,
      },
    },
    counts: {
      stations: stations.length,
      locatedStations: stations.filter((stop) => stop.coord).length,
      airports: airports.length,
      excludedAirports,
      railwayFeatures: network.features.length,
    },
  };
  const groups = {
    schemaVersion: 1,
    preparedAt: sourceDate,
    source: {
      stations: manifest.sources.stationNames,
      airports: manifest.sources.airports,
      use: 'Display-only; never overwrite saved locations or infer cities by distance.',
    },
    stations: stationGroups,
    airports: airportGroups,
  };
  return {
    'stations.json': stations,
    'airports.json': airports,
    'rail-network.geojson': network,
    'place-city-groups.json': groups,
    'data-sources.json': manifest,
  };
}

// Validate everything before touching the output. Publish a staged full directory
// so existing unrelated assets survive, with rollback if the rename fails.
export async function prepareData({
  stationCSVPath,
  stationNamesPath,
  airportCSVPath,
  outputDir,
  sourceDate,
  network = CHINA_NETWORK,
  generatedAt,
  renameImpl = rename,
} = {}) {
  if (
    ![stationCSVPath, stationNamesPath, airportCSVPath].every(
      (value) => typeof value === 'string' && value,
    )
  )
    throw new Error(
      '必须提供 --stations、--station-names、--airports 三个输入文件。',
    );
  const target = path.resolve(
    outputDir || fileURLToPath(new URL('../dist/data/', import.meta.url)),
  );
  if (target === path.parse(target).root || target === process.cwd())
    throw new Error('输出必须是专用数据目录。');
  const [stationCSV, stationNames, airportCSV] = await Promise.all([
    readFile(stationCSVPath, 'utf8'),
    readFile(stationNamesPath, 'utf8'),
    readFile(airportCSVPath, 'utf8'),
  ]);
  const result = buildData({
    stationCSV,
    stationNames,
    airportCSV,
    network,
    sourceDate,
    generatedAt,
    inputs: {
      stationCSV: path.basename(stationCSVPath),
      stationNames: path.basename(stationNamesPath),
      airports: path.basename(airportCSVPath),
    },
  });
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(path.join(parent, '.travel-data-stage-'));
  const previous = path.join(parent, `.travel-data-previous-${randomUUID()}`);
  let existed = false,
    moved = false,
    published = false;
  try {
    try {
      await access(target);
      existed = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existed) await cp(target, stage, { recursive: true });
    await Promise.all(
      Object.entries(result).map(([filename, data]) =>
        writeFile(path.join(stage, filename), JSON.stringify(data)),
      ),
    );
    if (existed) {
      await renameImpl(target, previous);
      moved = true;
    }
    try {
      await renameImpl(stage, target);
      published = true;
    } catch (error) {
      if (moved) {
        await rename(previous, target);
        moved = false;
      }
      throw error;
    }
  } finally {
    if (!published) await rm(stage, { recursive: true, force: true });
    if (published && moved)
      await rm(previous, { recursive: true, force: true });
  }
  return result['data-sources.json'];
}
function argumentsFrom(argv) {
  const keys = {
    '--stations': 'stationCSVPath',
    '--station-names': 'stationNamesPath',
    '--airports': 'airportCSVPath',
    '--output-dir': 'outputDir',
    '--source-date': 'sourceDate',
  };
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!keys[argv[i]] || !argv[i + 1] || argv[i + 1].startsWith('--'))
      throw new Error(
        '用法：pnpm exec node scripts/prepare-data.mjs --stations 文件 --station-names 文件 --airports 文件 --source-date YYYY-MM-DD [--output-dir 目录]',
      );
    options[keys[argv[i]]] = argv[i + 1];
  }
  return options;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(
        await prepareData(argumentsFrom(process.argv.slice(2))),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
