import test from 'node:test';
import assert from 'node:assert/strict';
import {
  preferredRailProvider,
  railProviderDataVersion,
  railProviderChoices,
  switchRowProvider,
} from '../dist/rail-providers.js';
import { routeKey, routeRequest } from '../dist/batch-review.js';
import {
  draftFromTrip,
  tripFromDraft,
  chooseCandidate,
  restoreRouteReview,
  routeReviewAccepted,
} from '../dist/editor-draft.js';
import { validateDraft } from '../dist/draft-validation.js';

const local = {
  deployment: 'local',
  railgoEnabled: true,
  defaultRailProvider: 'railgo',
  railProviders: [
    { id: 'railgo', available: true },
    { id: 'osm-local', available: true },
  ],
};
const draft = {
  mode: 'train',
  number: 'G9001',
  date: '2030-01-01',
  from: '合成甲',
  to: '合成乙',
  departure: '2030-01-01T08:00',
  arrival: '2030-01-01T10:00',
  provider: 'railgo',
  fieldSources: { departure: { source: 'manual' } },
};
test('本地默认RailGo且允许偏好，公开能力不能被客户端RailGo偏好绕过', () => {
  assert.equal(preferredRailProvider(local), 'railgo');
  assert.equal(preferredRailProvider(local, 'osm-local'), 'osm-local');
  const publicCapabilities = {
    ...local,
    deployment: 'public',
    railgoEnabled: false,
    defaultRailProvider: 'osm-local',
  };
  assert.deepEqual(
    railProviderChoices(publicCapabilities).map((p) => p.id),
    ['osm-local'],
  );
  assert.equal(
    preferredRailProvider(publicCapabilities, 'railgo'),
    'osm-local',
  );
});
test('来源变化隔离线路缓存并撤销候选接受，但保留填写时刻和停站选择', () => {
  const row = {
    draft,
    route: { quality: 'corridor' },
    routeKey: 'old',
    routeCandidateAccepted: true,
    referenceAccepted: true,
    lookup: { stops: [] },
  };
  const next = switchRowProvider(row, 'osm-local');
  assert.notEqual(routeKey(next.draft), routeKey(draft));
  assert.equal(routeRequest(next.draft).provider, 'osm-local');
  assert.equal(next.draft.departure, draft.departure);
  assert.equal(next.draft.fieldSources.departure.source, 'manual');
  assert.equal(next.referenceAccepted, true);
  assert.equal(next.lookup, row.lookup);
  assert.equal(next.route, null);
  assert.equal(next.routeCandidateAccepted, false);
  assert.equal(row.routeCandidateAccepted, true);
  assert.equal(routeRequest({ ...draft, mode: 'flight' }).provider, undefined);
});
test('只切换来源或未接受新候选仍保留已有主线与出处', () => {
  const original = {
    id: 'original',
    mode: 'train',
    number: 'G9001',
    travelDate: draft.date,
    departure: draft.departure,
    arrival: draft.arrival,
    from: { name: draft.from, coord: [116, 39] },
    to: { name: draft.to, coord: [118, 32] },
    routeCoordinates: [
      [116, 39],
      [117, 35],
      [118, 32],
    ],
    quality: 'latest',
    routeState: 'ready',
    routeConfirmed: true,
    routeSource: 'RailGo',
    distance: 800,
  };
  const input = { ...draftFromTrip(original), provider: 'osm-local' };
  const unchanged = tripFromDraft(input, null, null, { original });
  assert.deepEqual(unchanged.routeCoordinates, original.routeCoordinates);
  assert.equal(unchanged.routeSource, 'RailGo');
  const candidate = {
    ...original,
    routeCoordinates: [
      [116, 39],
      [118, 32],
    ],
    quality: 'corridor',
    routeProvider: 'osm-local',
    routeDataVersion: 'fixture-1',
    routeSource: 'OpenStreetMap',
    requiresConfirmation: true,
  };
  const pending = tripFromDraft(input, null, candidate, { original });
  assert.equal(pending.routeProvider, 'railgo');
  assert.equal(pending.quality, 'latest');
  assert.equal(pending.routeCandidate.routeProvider, 'osm-local');
  const accepted = tripFromDraft(input, null, candidate, {
    original,
    routeConfirmed: true,
  });
  assert.equal(accepted.routeProvider, 'osm-local');
  assert.equal(accepted.quality, 'corridor');
  const missingFlag = { ...candidate };
  delete missingFlag.requiresConfirmation;
  const unconfirmed = tripFromDraft(
    { ...draft, provider: 'osm-local' },
    null,
    missingFlag,
    { routeConfirmed: false },
  );
  assert.equal(unconfirmed.routeState, 'pending');
  assert.equal(unconfirmed.routeConfirmed, false);
  const legacy = { ...original };
  delete legacy.routeSource;
  const retainedLegacy = tripFromDraft(
    { ...draftFromTrip(legacy), provider: 'osm-local' },
    null,
    candidate,
    { original: legacy },
  );
  assert.equal(
    retainedLegacy.routeProvider,
    undefined,
    '未知旧主线不继承未接受候选的来源',
  );
  assert.deepEqual(retainedLegacy.routeCoordinates, legacy.routeCoordinates);
});
test('恢复草稿验证未知来源，旧草稿仍可读取', () => {
  const saved = { id: 'draft-provider', kind: 'single', row: { draft } };
  assert.equal(validateDraft(saved).row.draft.provider, 'railgo');
  assert.throws(
    () =>
      validateDraft({
        ...saved,
        row: { draft: { ...draft, provider: 'https://arbitrary.invalid' } },
      }),
    /来源无效/,
  );
  const old = { ...draft };
  delete old.provider;
  assert.equal(
    validateDraft({ ...saved, row: { draft: old } }).row.draft.provider,
    undefined,
  );
});
test('切换来源后选择旧查询区间不能恢复旧provider', () => {
  const candidate = {
    draft: { ...draft, to: '合成丙' },
    lookup: { stops: [] },
  };
  const row = switchRowProvider(
    { draft, candidates: [candidate] },
    'osm-local',
  );
  const selected = chooseCandidate(row, candidate);
  assert.equal(selected.draft.provider, 'osm-local');
  assert.equal(
    routeRequest(selected.draft, selected.lookup).provider,
    'osm-local',
  );
});

const versionedRow = (version = 'v1') => {
  const input = {
    ...draft,
    provider: 'osm-local',
    providerDataVersion: version,
  };
  return {
    draft: input,
    route: {
      quality: 'corridor',
      routeProvider: 'osm-local',
      routeDataVersion: version,
      requiresConfirmation: true,
    },
    routeKey: routeKey(input),
    routeIsCandidate: true,
    routeCandidateAccepted: true,
    routeConfirmed: false,
    needsResolve: false,
    referenceAccepted: true,
  };
};
const versionCapabilities = (dataVersion) => ({
  ...local,
  railProviders: local.railProviders.map((source) =>
    source.id === 'osm-local' ? { ...source, dataVersion } : source,
  ),
});
test('OSM 草稿同版本保留接受，版本变化清缓存及接受而不改时间', () => {
  const row = restoreRouteReview(versionedRow());
  const same = switchRowProvider(
    row,
    'osm-local',
    railProviderDataVersion(versionCapabilities('v1'), 'osm-local'),
  );
  assert.equal(same, row);
  assert.equal(routeReviewAccepted(same), true);
  const changed = switchRowProvider(
    row,
    'osm-local',
    railProviderDataVersion(versionCapabilities('v2'), 'osm-local'),
  );
  assert.equal(changed.route, null);
  assert.equal(changed.routeKey, null);
  assert.equal(changed.routeCandidateAccepted, false);
  assert.equal(changed.routeConfirmed, false);
  assert.equal(changed.needsResolve, true);
  assert.equal(changed.draft.providerDataVersion, 'v2');
  assert.equal(changed.draft.departure, row.draft.departure);
  assert.equal(changed.referenceAccepted, true);
  assert.notEqual(routeKey(row.draft), routeKey(changed.draft));
  assert.equal(row.routeCandidateAccepted, true);
  assert.equal(routeRequest(changed.draft).providerDataVersion, undefined);
});
test('能力未知与旧协议省略版本时保留草稿，显式 null 撤销轨道候选', () => {
  const row = versionedRow();
  for (const caps of [
    { ...versionCapabilities('v2'), deployment: 'unknown' },
    local,
  ]) {
    const version = railProviderDataVersion(caps, 'osm-local');
    assert.equal(version, undefined);
    assert.equal(switchRowProvider(row, 'osm-local', version), row);
  }
  const revoked = switchRowProvider(
    row,
    'osm-local',
    railProviderDataVersion(versionCapabilities(null), 'osm-local'),
  );
  assert.equal(revoked.route, null);
  assert.equal(revoked.routeCandidateAccepted, false);
  assert.equal(revoked.draft.providerDataVersion, null);
  const railgo = {
    ...row,
    draft: { ...draft },
    route: { routeProvider: 'railgo' },
  };
  assert.equal(switchRowProvider(railgo, 'railgo', 'v2'), railgo);
});
test('旧 OSM 草稿由路线版本升级缓存键，版本不符和缺失均撤销接受', () => {
  const old = versionedRow();
  delete old.draft.providerDataVersion;
  old.routeKey = routeKey(old.draft);
  const upgraded = switchRowProvider(old, 'osm-local', 'v1');
  assert.equal(upgraded.draft.providerDataVersion, 'v1');
  assert.equal(upgraded.routeKey, routeKey(upgraded.draft));
  assert.equal(routeReviewAccepted(upgraded), true);
  assert.equal(switchRowProvider(old, 'osm-local', 'v2').route, null);
  const unversioned = structuredClone(old);
  delete unversioned.route.routeDataVersion;
  assert.equal(switchRowProvider(unversioned, 'osm-local', 'v1').route, null);
  const selected = chooseCandidate(upgraded, {
    draft: { ...draft },
    lookup: { stops: [] },
  });
  assert.equal(selected.draft.providerDataVersion, 'v1');
});
test('版本失效后的保存保留正式旧主线版本，不把新版本标签贴到旧几何', () => {
  const original = {
    id: 'old-osm',
    mode: 'train',
    number: draft.number,
    travelDate: draft.date,
    departure: draft.departure,
    arrival: draft.arrival,
    from: { name: draft.from, coord: [116, 39] },
    to: { name: draft.to, coord: [118, 32] },
    routeCoordinates: [
      [116, 39],
      [118, 32],
    ],
    quality: 'corridor',
    routeState: 'ready',
    routeConfirmed: true,
    routeProvider: 'osm-local',
    routeDataVersion: 'v1',
    routeEvidence: { license: 'ODbL-1.0' },
    distance: 800,
  };
  const row = switchRowProvider(
    { ...versionedRow(), draft: draftFromTrip(original) },
    'osm-local',
    'v2',
  );
  const saved = tripFromDraft(row.draft, null, row.route, {
    original,
    routeConfirmed: routeReviewAccepted(row),
  });
  assert.equal(saved.routeDataVersion, 'v1');
  assert.equal(saved.routeConfirmed, true);
  assert.deepEqual(saved.routeCoordinates, original.routeCoordinates);
  assert.equal(saved.departure, original.departure);
  const savedDraft = { id: 'versioned', kind: 'single', row };
  assert.equal(validateDraft(savedDraft).row.draft.providerDataVersion, 'v2');
  assert.throws(
    () =>
      validateDraft({
        ...savedDraft,
        row: { ...row, draft: { ...row.draft, providerDataVersion: 2 } },
      }),
    /数据版本无效/,
  );
});
