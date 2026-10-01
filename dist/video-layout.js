// Canvas labels use the 1280×720 layout; map fitting scales the same exclusions.
const blockers = [
  { left: 25, top: 25, right: 650, bottom: 125 },
  { left: 25, top: 600, right: 1255, bottom: 720 },
];
export function videoViewportBlockers(scale = 1) {
  return blockers.map((rect) =>
    Object.fromEntries(
      Object.entries(rect).map(([edge, value]) => [edge, value * scale]),
    ),
  );
}
