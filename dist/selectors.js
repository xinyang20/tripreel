import { tripMetadata, tripSummary, actualTravelDate } from './domain.js';

export const tripDate = actualTravelDate;
export function filterTrips(trips, filters = {}, groups = new Map()) {
  const search = String(filters.search || '')
    .trim()
    .toLocaleLowerCase();
  return trips
    .map((trip) => ({ trip, metadata: tripMetadata(trip) }))
    .filter(({ trip, metadata }) => {
      const date = metadata.date;
      return (
        (!filters.group ||
          (filters.group === 'ungrouped'
            ? !trip.groupId
            : trip.groupId === filters.group)) &&
        (!filters.year || date.startsWith(filters.year + '-')) &&
        (!filters.from || date >= filters.from) &&
        (!filters.to || date <= filters.to) &&
        (!filters.mode || trip.mode === filters.mode) &&
        (!search ||
          metadata.search.some((value) => value.includes(search)) ||
          String(groups.get(trip.groupId) || trip.groupName || '')
            .toLocaleLowerCase()
            .includes(search))
      );
    })
    .sort(
      (a, b) =>
        a.metadata.sortTime - b.metadata.sortTime ||
        String(a.trip.id).localeCompare(String(b.trip.id)),
    )
    .map(({ trip }) => trip);
}
export function scopeSummary(trips) {
  const distance = { rail: 0, schematic: 0, flight: 0, unknown: 0 };
  let playable = 0;
  const places = new Set();
  for (const trip of trips) {
    const summary = tripSummary(trip);
    playable += Number(summary.playable);
    for (const name of [trip.from?.name, trip.to?.name])
      if (name) places.add(name);
    if (!summary.renderable || !Number.isFinite(trip.distance)) {
      distance.unknown++;
      continue;
    }
    const key =
      trip.mode === 'flight'
        ? 'flight'
        : ['station-schematic', 'manual-schematic'].includes(trip.quality)
          ? 'schematic'
          : 'rail';
    distance[key] += trip.distance;
  }
  return {
    count: trips.length,
    playable,
    places: places.size,
    distance,
    totalDistance: distance.rail + distance.schematic + distance.flight,
  };
}
export function selectedScope(trips, selected = new Set()) {
  return selected.size ? trips.filter((trip) => selected.has(trip.id)) : trips;
}
