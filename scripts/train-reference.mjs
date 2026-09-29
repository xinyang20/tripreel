import { parseTime, localDateTime } from '../dist/core.js';
import {
  isCancellation,
  throwIfCancelled,
  TravelError,
} from './request-scheduler.mjs';

export async function queryTrainWithReference(
  query,
  lookup,
  today,
  { signal } = {},
) {
  throwIfCancelled(signal);
  const date = query.get('date'),
    number = query.get('number');
  if (!Number.isFinite(parseTime(`${date}T00:00`)))
    throw new Error('日期格式不正确。');
  try {
    return await lookup(query);
  } catch (original) {
    throwIfCancelled(signal);
    if (date === today || isCancellation(original)) throw original;
    let reference;
    try {
      reference = await lookup(new URLSearchParams({ number, date: today }));
    } catch (error) {
      throwIfCancelled(signal);
      if (isCancellation(error)) throw error;
      throw new TravelError(
        error.code || 'TIMETABLE_UNAVAILABLE',
        `${original.message} 今日同车次也暂无可用停站，可手动填写或补充途经站。`,
        { retryable: error.retryable ?? true, status: error.status || 502 },
      );
    }
    const offset = parseTime(date + 'T00:00') - parseTime(today + 'T00:00');
    const shift = (value) =>
      Number.isFinite(parseTime(value))
        ? localDateTime(parseTime(value) + offset)
        : value;
    return {
      ...reference,
      date,
      referenceDate: today,
      isReference: true,
      source: '12306 · 今日参考',
      scheduleProvenance: {
        source: '12306',
        requestedDate: date,
        sourceDate: today,
        fetchedAt: reference.fetchedAt || null,
        basis: 'reference',
      },
      note: `${date} 暂未查询成功，以下停靠站来自今日（${today}）同车次，仅供选择。时刻已平移到所选始发日期，请按票面核对，未来停站可能调整。`,
      stops: reference.stops.map((s) => ({
        ...s,
        arrival: shift(s.arrival),
        departure: shift(s.departure),
      })),
    };
  }
}
