import {
  canReplay,
  isReadOnlyTrip,
  prepareReadOnlyTrip,
  routeLabel,
  tripIssues,
} from './domain.js';
import { cityFor } from './map-labels.js';
import { buildTimeline } from './replay.js';
export const VIDEO_MAX_SECONDS = 300;
export const VIDEO_MAX_BYTES = 250 * 1024 * 1024;
export const VIDEO_SPEEDS = [1, 2, 4, 8, 16, 32];
const presentationFields = [
  'id',
  'mode',
  'number',
  'date',
  'travelDate',
  'departure',
  'arrival',
  'from',
  'to',
  'stops',
  'legs',
  'routeCoordinates',
  'routeTiming',
  'routeRevision',
  'routeState',
  'routeConfirmed',
  'referenceAccepted',
  'requiresConfirmation',
  'quality',
  'distance',
  'routeSource',
  'routeProvider',
  'routeDataVersion',
  'isReference',
  'referenceDate',
  'scheduleWarning',
  'routeFrozen',
  'issues',
  'warningDetails',
  'warnings',
  'routeNote',
];
export function videoBudget(trips, resolution = 1080, speed = 1) {
  const usable = trips.filter(canReplay),
    seconds = buildTimeline(usable).duration / Number(speed) + 4;
  const bitrate = Number(resolution) === 1080 ? 6000000 : 3500000,
    bytes = Math.ceil((seconds * bitrate) / 8);
  return {
    seconds,
    bytes,
    bitrate,
    omitted: trips.length - usable.length,
    count: usable.length,
    allowed:
      usable.length > 0 &&
      VIDEO_SPEEDS.includes(Number(speed)) &&
      seconds <= VIDEO_MAX_SECONDS &&
      bytes <= VIDEO_MAX_BYTES,
  };
}
export function recommendedSpeed(trips) {
  return (
    VIDEO_SPEEDS.find(
      (speed) => videoBudget(trips, 1080, speed).seconds <= 120,
    ) || 32
  );
}
export function videoSnapshot(trips) {
  return trips.map((trip) => {
    // Share only values that crossed our recursive read-only boundary. For
    // external records, clone recording inputs without archived/candidate paths.
    const fields = Object.fromEntries(
      presentationFields
        .filter((key) => trip[key] !== undefined)
        .map((key) => [key, trip[key]]),
    );
    const snapshot = isReadOnlyTrip(trip) ? fields : structuredClone(fields);
    if (trip.routeCandidate) snapshot.routeCandidate = {};
    if (trip.resolution?.requiresConfirmation)
      snapshot.resolution = { requiresConfirmation: true };
    return prepareReadOnlyTrip(snapshot);
  });
}
export function videoPresentation(
  trips,
  { hideNumbers = false, citiesOnly = false, cityIndex = {} } = {},
) {
  return videoSnapshot(trips.filter(canReplay)).map((trip) => {
    const t = { ...trip, from: { ...trip.from }, to: { ...trip.to } };
    if (hideNumbers) t.number = t.mode === 'train' ? '火车旅程' : '飞机旅程';
    if (citiesOnly)
      for (const key of ['from', 'to'])
        t[key].name =
          cityFor({ ...trip[key], kind: trip.mode }, cityIndex)?.name ||
          (key === 'from' ? '出发城市' : '到达城市');
    return prepareReadOnlyTrip(t);
  });
}
export function videoRouteNote(trip) {
  const labels = [routeLabel(trip)];
  if (trip.isReference) labels.push('时刻参考');
  if (
    tripIssues(trip).some(
      (i) =>
        ![
          'schematic-route',
          'reference-schedule',
          'corridor-route',
          'frozen-route',
        ].includes(i.code),
    )
  )
    labels.push('来源差异详见行程');
  labels.push('非实时定位');
  return labels.join(' · ');
}
export function videoFilename(
  trips,
  { hideDates = false } = {},
  extension = 'mp4',
) {
  return `途映-${hideDates ? '旅程视频' : trips[0]?.travelDate || trips[0]?.departure?.slice(0, 10) || '旅程'}.${extension === 'mp4' ? 'mp4' : 'webm'}`;
}
