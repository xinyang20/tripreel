// Deployment capabilities are authoritative; preferences never enable a source.
import { routeKey } from './batch-review.js';

export const RAIL_PROVIDERS = ['railgo', 'osm-local'];
export function railProviderDataVersion(capabilities, provider) {
  if (
    provider !== 'osm-local' ||
    !['local', 'public'].includes(capabilities?.deployment)
  )
    return undefined;
  const source = capabilities.railProviders?.find(
    (item) => item.id === provider,
  );
  return source && Object.hasOwn(source, 'dataVersion')
    ? source.dataVersion
    : undefined;
}
export function railProviderChoices(capabilities = {}) {
  const list = capabilities.railProviders || [
    {
      id: 'railgo',
      label: 'RailGo（仅本机）',
      available: capabilities.railgoEnabled === true,
      coverage: '车次最新线路',
    },
    {
      id: 'osm-local',
      label: 'OSM 本地线路参考',
      available: capabilities.deployment === 'public',
      coverage: '以本站已核实区间为准',
    },
  ];
  return list.filter(
    (item) =>
      RAIL_PROVIDERS.includes(item.id) &&
      item.available === true &&
      (item.id !== 'railgo' ||
        (capabilities.deployment === 'local' &&
          capabilities.railgoEnabled === true)),
  );
}
export function preferredRailProvider(capabilities, preference) {
  const choices = railProviderChoices(capabilities);
  return [
    preference,
    capabilities?.defaultRailProvider,
    'railgo',
    'osm-local',
  ].find((id) => choices.some((item) => item.id === id));
}
export function originalRailProvider(trip) {
  return (
    trip?.routeProvider ||
    (String(trip?.routeSource || '').startsWith('RailGo')
      ? 'railgo'
      : undefined)
  );
}
export function fillRailProviderSelect(select, capabilities, preference, hint) {
  const choices = railProviderChoices(capabilities),
    selected = preferredRailProvider(capabilities, preference);
  const signature = JSON.stringify(choices.map(({ id, label }) => [id, label]));
  if (select.dataset.options !== signature) {
    select.replaceChildren(
      ...choices.map(({ id, label }) => new Option(label, id)),
    );
    if (!choices.length) select.append(new Option('来源能力暂不可用', ''));
    select.dataset.options = signature;
  }
  select.value = selected || '';
  select.disabled = !choices.length;
  if (hint)
    hint.textContent =
      choices.find((item) => item.id === selected)?.coverage ||
      '已有记录仍可查看，可保留输入稍后查询。';
  return selected;
}
export function switchRowProvider(row, provider, dataVersion) {
  if (!row?.draft || row.draft.mode !== 'train') return row;
  const providerChanged = row.draft.provider !== provider,
    knownVersion = provider === 'osm-local' && dataVersion !== undefined,
    previousVersion =
      row.route?.routeDataVersion !== undefined
        ? row.route.routeDataVersion
        : row.draft.providerDataVersion,
    versionChanged =
      knownVersion &&
      (previousVersion !== dataVersion ||
        (dataVersion === null && row.route?.quality === 'corridor'));
  if (!providerChanged && !versionChanged) {
    if (!knownVersion || row.draft.providerDataVersion === dataVersion)
      return row;
    const draft = { ...row.draft, providerDataVersion: dataVersion };
    // Upgrade a matching legacy cache key only when the route itself proves the version.
    return {
      ...row,
      draft,
      routeKey:
        row.routeKey === routeKey(row.draft, row.lookup)
          ? routeKey(draft, row.lookup)
          : row.routeKey,
    };
  }
  const draft = { ...row.draft, provider, routeConfirmed: false };
  if (knownVersion) draft.providerDataVersion = dataVersion;
  else if (providerChanged) delete draft.providerDataVersion;
  const routeWarnings = new Set(
    [
      row.route?.routeNote,
      ...(row.route?.warnings || []),
      ...(row.route?.issues || row.route?.resolution?.issues || []).map(
        (issue) => (typeof issue === 'string' ? issue : issue.message),
      ),
    ].filter(Boolean),
  );
  return {
    ...row,
    draft,
    route: null,
    routeKey: null,
    routeConfirmed: false,
    routeIsCandidate: false,
    routeCandidateAccepted: false,
    needsResolve: true,
    reviewed: false,
    routeError: '',
    error: '',
    warnings: (row.warnings || []).filter(
      (warning) => !routeWarnings.has(warning),
    ),
    message: providerChanged
      ? '线路来源已更换，请重新查询并核对候选；填写的地点和时刻已保留。'
      : '线路数据版本已变化，请重新查询并核对候选；已有主线、地点和时刻已保留。',
  };
}
