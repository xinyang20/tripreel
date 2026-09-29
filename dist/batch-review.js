// A duplicate is the same transport, service, requested day and actual endpoints.
// Times may have changed in today's reference schedule; do not add it again.
const name = (value) =>
  String(value?.name || value || '')
    .trim()
    .replace(/站$/, '')
    .replace(/国际机场$|机场$/, '');
export function sameJourney(draft, trip) {
  return (
    draft.mode === trip.mode &&
    String(draft.number).toUpperCase() === String(trip.number).toUpperCase() &&
    (trip.travelDate ||
      trip.departure?.slice(0, 10) ||
      trip.date ||
      trip.queryDate) ===
      (draft.travelDate || draft.departure?.slice(0, 10) || draft.date) &&
    name(draft.from) === name(trip.from) &&
    name(draft.to) === name(trip.to)
  );
}
export function routeRequest(draft, lookup) {
  let via = draft.via || '';
  const viaSource =
    typeof draft.fieldSources?.via === 'string'
      ? draft.fieldSources.via
      : draft.fieldSources?.via?.source;
  if (
    draft.mode === 'train' &&
    lookup?.stops &&
    !draft.explicitVia &&
    !['manual', 'text'].includes(viaSource)
  ) {
    const a =
        draft.fromStopIndex ??
        lookup.stops.findIndex((s) => s.name === draft.from),
      b =
        draft.toStopIndex ?? lookup.stops.findIndex((s) => s.name === draft.to);
    if (a >= 0 && b > a)
      via = lookup.stops
        .slice(a + 1, b)
        .map((s) => s.name)
        .join('、');
  }
  return {
    mode: draft.mode,
    number: draft.number,
    date: draft.queryDate || lookup?.date || draft.date,
    from: draft.from,
    to: draft.to,
    via,
    fromCoord: draft.fromCoord || undefined,
    toCoord: draft.toCoord || undefined,
    ...(Number.isInteger(draft.fromStopIndex)
      ? { fromStopIndex: draft.fromStopIndex }
      : {}),
    ...(Number.isInteger(draft.toStopIndex)
      ? { toStopIndex: draft.toStopIndex }
      : {}),
  };
}
export const routeKey = (draft, lookup) =>
  JSON.stringify({ requestedDate: draft.date, ...routeRequest(draft, lookup) });
