export const TZ = '+08:00';
export function parseTime(s) {
  if (typeof s !== 'string') return NaN;
  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/,
  );
  if (!m) return NaN;
  const [, y, month, day, h, min, sec = '00', zone = TZ] = m;
  const check = new Date(Date.UTC(+y, +month - 1, +day));
  if (
    check.getUTCFullYear() !== +y ||
    check.getUTCMonth() !== +month - 1 ||
    check.getUTCDate() !== +day ||
    +h > 23 ||
    +min > 59 ||
    +sec > 59
  )
    return NaN;
  return Date.parse(`${y}-${month}-${day}T${h}:${min}:${sec}${zone}`);
}
export const localDateTime = (timestamp) =>
  new Date(timestamp + 8 * 3600000).toISOString().slice(0, 16);
export const chinaToday = () => localDateTime(Date.now()).slice(0, 10);
export const addDays = (date, n) =>
  new Date(Date.parse(date + 'T00:00:00+08:00') + n * 86400000 + 8 * 3600000)
    .toISOString()
    .slice(0, 10);
export function coordinate(s) {
  if (!s) return null;
  const c = Array.isArray(s)
    ? s
    : String(s)
        .split(/[,，\s]+/)
        .map(Number);
  if (
    c.length !== 2 ||
    !c.every(Number.isFinite) ||
    c[0] < 73 ||
    c[0] > 135.2 ||
    c[1] < 18 ||
    c[1] > 54
  )
    throw new Error('请输入中国大陆范围内的 WGS84 经度,纬度。');
  return c;
}
export function distance(a, b) {
  const r = Math.PI / 180,
    p = (b[1] - a[1]) * r,
    q = (b[0] - a[0]) * r;
  return (
    12742 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin(p / 2) ** 2 +
            Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(q / 2) ** 2,
        ),
      ),
    )
  );
}
export function lineLength(c) {
  return c.slice(1).reduce((n, p, i) => n + distance(c[i], p), 0);
}
export function along(c, t) {
  if (!c?.length) return null;
  if (c.length === 1) return c[0];
  const d = lineLength(c) * Math.max(0, Math.min(1, t));
  let acc = 0;
  for (let i = 1; i < c.length; i++) {
    const l = distance(c[i - 1], c[i]);
    if (acc + l >= d) {
      const f = l ? (d - acc) / l : 0;
      return [
        c[i - 1][0] + (c[i][0] - c[i - 1][0]) * f,
        c[i - 1][1] + (c[i][1] - c[i - 1][1]) * f,
      ];
    }
    acc += l;
  }
  return c.at(-1);
}
export function flightArc(a, b, count = 100) {
  const r = Math.PI / 180,
    ar = a.map((x) => x * r),
    br = b.map((x) => x * r),
    v1 = [
      Math.cos(ar[1]) * Math.cos(ar[0]),
      Math.cos(ar[1]) * Math.sin(ar[0]),
      Math.sin(ar[1]),
    ],
    v2 = [
      Math.cos(br[1]) * Math.cos(br[0]),
      Math.cos(br[1]) * Math.sin(br[0]),
      Math.sin(br[1]),
    ];
  const angle = Math.acos(
    Math.max(
      -1,
      Math.min(
        1,
        v1.reduce((s, v, i) => s + v * v2[i], 0),
      ),
    ),
  );
  return Array.from({ length: count + 1 }, (_, i) => {
    const t = i / count;
    if (angle < 1e-8) return [...a, 0];
    const f = Math.sin((1 - t) * angle) / Math.sin(angle),
      g = Math.sin(t * angle) / Math.sin(angle),
      v = v1.map((x, k) => x * f + v2[k] * g),
      bend = 4 * t * (1 - t) * 0.09;
    return [
      Math.atan2(v[1], v[0]) / r - (b[1] - a[1]) * bend,
      Math.atan2(v[2], Math.hypot(v[0], v[1])) / r + (b[0] - a[0]) * bend,
      4 * t * (1 - t) * Math.min(180000, distance(a, b) * 100),
    ];
  });
}
export function validateTrip(trip, others = []) {
  if (!['train', 'flight'].includes(trip.mode))
    throw new Error('请选择火车或飞机。');
  if (!/^[A-Z0-9]{1,10}$/i.test(trip.number))
    throw new Error('请填写有效车次或航班号。');
  if (!trip.from?.name || !trip.to?.name) throw new Error('请填写起止地点。');
  if (trip.from.name === trip.to.name) throw new Error('起点和终点不能相同。');
  const begin = parseTime(trip.departure),
    end = parseTime(trip.arrival);
  if (!Number.isFinite(begin) || !Number.isFinite(end) || end <= begin)
    throw new Error('到达时间必须晚于出发时间；跨午夜请选择次日。');
  if (end - begin > 7 * 86400000)
    throw new Error('单段行程不能超过 7 天，请核对日期。');
  coordinate(trip.from.coord);
  coordinate(trip.to.coord);
  if (!trip.from.coord || !trip.to.coord)
    throw new Error('起止地点缺少坐标，请先匹配或补充。');
  for (const x of others) {
    if (
      x.id !== trip.id &&
      begin < parseTime(x.arrival) &&
      end > parseTime(x.departure)
    )
      throw new Error(`与 ${x.number} 的行程时间重叠，请核对后再保存。`);
  }
  return trip;
}
export function timetableTimes(stops, date, { onInvalidTime = () => {} } = {}) {
  let day = 0,
    last = -1;
  return stops.map((s, i) => {
    const record = { ...s },
      invalid = new Set();
    delete record.arrival;
    delete record.departure;
    for (const [field, key] of [
      ['arrive_time', 'arrival'],
      ['start_time', 'departure'],
    ]) {
      const value = s[field];
      if (value == null || value === '' || /^[-:]+$/.test(value)) continue;
      if (
        typeof value !== 'string' ||
        !/^\d\d:\d\d$/.test(value) ||
        !Number.isFinite(parseTime(`${date}T${value}`))
      ) {
        invalid.add(key);
        onInvalidTime({ stopIndex: i, field: key });
        continue;
      }
      const min = Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
      if (min < last) day++;
      record[key] = `${addDays(date, day)}T${value}`;
      last = min;
    }
    if (!record.arrival && !invalid.has('arrival'))
      record.arrival = record.departure;
    if (!record.departure && !invalid.has('departure'))
      record.departure = record.arrival;
    return record;
  });
}
const batchModes = {
  火车: 'train',
  列车: 'train',
  高铁: 'train',
  动车: 'train',
  '🚄': 'train',
  飞机: 'flight',
  航班: 'flight',
  '✈': 'flight',
  '✈️': 'flight',
  train: 'train',
  flight: 'flight',
};
function batchNumberMode(number) {
  if (/^[GDCZTKYSPL]?\d{1,5}$/i.test(number)) return 'train';
  if (/^(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\d{1,4}$/i.test(number)) return 'flight';
  return null;
}
function parseBatchLine(raw) {
  const input = raw
    .replace(/：/g, ':')
    .replace(/^(火车|列车|高铁|动车|飞机|航班|🚄|✈️?)(?=\s|[A-Z\d])/i, '$1 ');
  let tokens = input.split(/[\s,，|]+/).filter(Boolean);
  const dates = tokens.filter((t) => /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(t));
  if (dates.length !== 1)
    throw new Error('请填写一个有效出发日期，例如 2026/7/7。');
  const [year, month, day] = dates[0].split(/[-/]/),
    date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  if (!Number.isFinite(parseTime(date + 'T00:00')))
    throw new Error('出发日期不存在，请核对年月日。');
  tokens = tokens.filter((t) => t !== dates[0]);
  const modes = tokens.map((t) => batchModes[t.toLowerCase()]).filter(Boolean);
  if (new Set(modes).size > 1)
    throw new Error('同一行不能同时指定火车和飞机。');
  tokens = tokens.filter((t) => !batchModes[t.toLowerCase()]);
  const numbers = tokens.filter((t) => batchNumberMode(t));
  if (numbers.length !== 1)
    throw new Error('请填写一个有效车次或航班号，例如 G1802、CA4246。');
  const number = numbers[0].toUpperCase(),
    mode = batchNumberMode(number);
  if (modes.length && modes[0] !== mode)
    throw new Error(`交通方式与 ${number} 不符，请核对火车或飞机。`);
  tokens = tokens
    .filter((t) => t.toUpperCase() !== number)
    .join(' ')
    .replace(/->|→|—+|–|-/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const places = [],
    times = [];
  let offset = 0,
    hasOffset = false;
  for (const token of tokens) {
    if (/^\+\d+$/.test(token)) {
      if (hasOffset || times.length !== 1 || Number(token) > 7)
        throw new Error(
          '跨日请在到达时间前填写 +1 至 +7，例如 23:10 +1 01:20。',
        );
      offset = Number(token);
      hasOffset = true;
      continue;
    }
    if (/^\d{1,2}:\d{2}$/.test(token)) {
      const clock = token.padStart(5, '0');
      if (times.length >= 2 || !Number.isFinite(parseTime(`${date}T${clock}`)))
        throw new Error('时间应为有效的 HH:mm，请核对小时和分钟。');
      times.push(clock);
      continue;
    }
    if (token.includes(':') || token.startsWith('+'))
      throw new Error(
        '时间格式无效，请使用 HH:mm；跨日到达请在时间前填写 +1。',
      );
    places.push(token);
  }
  if (hasOffset && times.length !== 2)
    throw new Error('跨日标记后还需要填写到达时间。');
  if (places.length > 2)
    throw new Error(
      '起止地点未能识别，请使用“南京南-西安北”或用空格分隔两个地点。',
    );
  const draft = { date, number, mode };
  if (places[0]) draft.from = places[0];
  if (places[1]) draft.to = places[1];
  if (times[0]) draft.departure = `${date}T${times[0]}`;
  if (times[1]) draft.arrival = `${addDays(date, offset)}T${times[1]}`;
  if (draft.arrival && parseTime(draft.arrival) <= parseTime(draft.departure))
    throw new Error('到达时间必须晚于出发时间；跨午夜请在到达时间前填写 +1。');
  return draft;
}
export function parseBatchLines(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((raw, i) => ({ line: i + 1, raw: raw.trim() }))
    .filter((row) => row.raw);
  if (!lines.length) throw new Error('请先粘贴行程文本。');
  if (lines.length > 20) throw new Error('一次最多导入 20 段行程。');
  return lines.map((row) => {
    try {
      return { ...row, draft: parseBatchLine(row.raw), error: null };
    } catch (error) {
      return {
        ...row,
        draft: null,
        error: `第 ${row.line} 行：${error.message}`,
      };
    }
  });
}
export function parseBatch(text) {
  return parseBatchLines(text).map((row) => {
    if (row.error) throw new Error(row.error);
    return row.draft;
  });
}
