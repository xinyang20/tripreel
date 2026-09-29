import { parseTime } from './core.js';
import { canRenderRoute, canReplay } from './domain.js';

export const tripDate = (trip) =>
  trip.travelDate ||
  trip.departure?.slice(0, 10) ||
  trip.date ||
  trip.queryDate ||
  '';
export function filterTrips(trips, filters = {}) {
  const search = String(filters.search || '')
    .trim()
    .toLocaleLowerCase();
  return trips
    .filter((trip) => {
      const date = tripDate(trip);
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
          [trip.number, trip.from?.name, trip.to?.name, trip.groupName].some(
            (value) =>
              String(value || '')
                .toLocaleLowerCase()
                .includes(search),
          ))
      );
    })
    .sort((a, b) => {
      const stamp = (t) =>
        Number.isFinite(parseTime(t.departure))
          ? parseTime(t.departure)
          : parseTime(tripDate(t) + 'T00:00');
      return stamp(a) - stamp(b) || String(a.id).localeCompare(String(b.id));
    });
}
export function scopeSummary(trips) {
  const distance = { rail: 0, schematic: 0, flight: 0, unknown: 0 };
  for (const trip of trips) {
    if (!canRenderRoute(trip) || !Number.isFinite(trip.distance)) {
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
    playable: trips.filter(canReplay).length,
    places: new Set(
      trips.flatMap((trip) => [trip.from?.name, trip.to?.name]).filter(Boolean),
    ).size,
    distance,
    totalDistance: distance.rail + distance.schematic + distance.flight,
  };
}
export function selectedScope(trips, selected = new Set()) {
  return selected.size ? trips.filter((trip) => selected.has(trip.id)) : trips;
}
