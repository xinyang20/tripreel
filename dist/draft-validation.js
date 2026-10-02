import { coordinate } from './core.js';
import { validateRecord } from './domain.js';

const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message) => {
  throw new Error(
    `草稿无法继续：${message}。原内容已保留，可导出备份或恢复材料。`,
  );
};
function text(value, label, limit = 100000) {
  if (value != null && (typeof value !== 'string' || value.length > limit))
    fail(`${label}不是有效文本或超过长度限制`);
}
function nested(value, depth = 0) {
  if (depth > 24) fail('嵌套层级过多');
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (entry == null) continue;
    if (
      key === 'providerDataVersion' &&
      (typeof entry !== 'string' || !entry.trim() || entry.length > 200)
    )
      fail('铁路数据版本无效');
    if (
      ['provider', 'railProvider', 'routeProvider'].includes(key) &&
      !['railgo', 'osm-local'].includes(entry)
    )
      fail('铁路来源无效');
    if (key === 'fieldSources') {
      if (!object(entry)) fail('字段来源结构无效');
      for (const source of Object.values(entry)) {
        if (typeof source !== 'string' && !object(source))
          fail('字段来源条目无效');
        if (object(source)) {
          text(source.source, '字段来源');
          text(source.referenceDate, '字段参考日期');
        }
      }
      continue;
    }
    if (['coord', 'routeCoord'].includes(key)) {
      try {
        if (!Array.isArray(entry) || entry.length !== 2) throw new Error();
        coordinate(entry);
      } catch {
        fail('候选或原始记录含无效坐标');
      }
    } else if (['routeCoordinates', 'coordinates'].includes(key)) {
      if (!Array.isArray(entry) || entry.length > 150000 || entry.length === 1)
        fail('线路坐标结构无效');
      for (const point of entry) {
        try {
          if (!Array.isArray(point) || point.length !== 2) throw new Error();
          coordinate(point);
        } catch {
          fail('线路含无效坐标');
        }
      }
    } else if (
      key === 'distance' &&
      (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0)
    ) {
      fail('线路距离无效');
    } else {
      if (
        ['stops', 'legs'].includes(key) &&
        (!Array.isArray(entry) || entry.length > 1000)
      )
        fail('停站或路段结构无效');
      if (['stops', 'legs'].includes(key))
        for (const item of entry) {
          if (!object(item)) fail('停站或路段条目无效');
          if (
            key === 'stops' &&
            (typeof item.name !== 'string' || !item.name.trim())
          )
            fail('停站名称无效');
        }
      if (
        [
          'name',
          'departure',
          'arrival',
          'number',
          'quality',
          'routeNote',
          'label',
          'note',
        ].includes(key)
      )
        text(entry, key);
      if (key === 'routeHistory' && (!Array.isArray(entry) || entry.length > 3))
        fail('历史线路结构无效');
      if (key === 'routeCandidate' && !object(entry)) fail('线路候选结构无效');
      nested(entry, depth + 1);
    }
  }
}
function row(value, allowParseError = false, depth = 0) {
  if (depth > 4) fail('候选嵌套层级过多');
  if (!object(value)) fail('核对行结构无效');
  if (
    value.draft == null &&
    allowParseError &&
    typeof value.error === 'string'
  ) {
    if (value.route != null || value.lookup != null || value.candidates?.length)
      fail('未识别行不能携带查询或线路候选');
    nested(value);
    return;
  }
  if (!object(value.draft)) fail('缺少可编辑字段');
  for (const key of [
    'mode',
    'number',
    'date',
    'from',
    'to',
    'departure',
    'arrival',
    'via',
    'fromCoord',
    'toCoord',
  ])
    text(value.draft[key], key);
  if (
    value.draft.mode != null &&
    !['train', 'flight'].includes(value.draft.mode)
  )
    fail('交通方式无效');
  if (
    value.warnings != null &&
    (!Array.isArray(value.warnings) ||
      value.warnings.some((warning) => typeof warning !== 'string'))
  )
    fail('来源提示结构无效');
  if (value.lookup != null && !object(value.lookup)) fail('查询结果结构无效');
  if (value.route != null && !object(value.route)) fail('线路结构无效');
  if (value.conflict != null) {
    if (!object(value.conflict)) fail('冲突核对结构无效');
    if (value.conflict.current != null) {
      try {
        validateRecord(value.conflict.current, [], { allowDateMismatch: true });
      } catch {
        fail('冲突核对的原始记录无效');
      }
    }
  }
  if (value.candidates != null) {
    if (!Array.isArray(value.candidates) || value.candidates.length > 1000)
      fail('候选列表结构无效');
    for (const candidate of value.candidates) {
      if (!object(candidate) || !object(candidate.draft))
        fail('候选字段结构无效');
      row(candidate, false, depth + 1);
    }
  }
  nested(value);
}

// Drafts may contain incomplete or invalid user input. Validate their structure,
// not the completeness of a formal record, before any editor state is changed.
export function validateDraft(input) {
  if (!object(input)) fail('结构无效');
  const payload = input.payload ?? input.data ?? input;
  if (!object(payload)) fail('内容结构无效');
  for (const source of [input, payload])
    if (
      (source.schemaVersion != null && source.schemaVersion !== 1) ||
      (source.version != null && source.version !== 1)
    )
      fail('不支持此草稿版本');
  const draft = {
    ...payload,
    id: input.id,
    revision: input.revision,
    updatedAt: input.updatedAt,
  };
  if (typeof draft.id !== 'string' || !draft.id.trim() || draft.id.length > 200)
    fail('标识无效');
  if (
    draft.revision != null &&
    (!Number.isInteger(draft.revision) || draft.revision < 0)
  )
    fail('版本无效');
  draft.kind ??= input.kind;
  if (!['single', 'batch'].includes(draft.kind)) fail('类型无效');
  if (draft.kind === 'batch') {
    text(draft.raw, '原文');
    text(draft.reviewText, '已核对原文');
    if (!Array.isArray(draft.rows) || draft.rows.length > 20)
      fail('批量列表必须是最多 20 行的数组');
    draft.rows.forEach((entry) => row(entry, true));
    draft.rows = draft.rows.map((entry, index) => {
      if (
        entry.line != null &&
        (!Number.isInteger(entry.line) || entry.line < 1)
      )
        fail('原文行号无效');
      return { ...entry, index, line: entry.line ?? index + 1 };
    });
  } else row(draft.row);
  if (draft.original != null) {
    try {
      validateRecord(draft.original, [], { allowDateMismatch: true });
    } catch {
      fail('原始记录结构无效');
    }
  }
  nested(draft);
  return draft;
}
