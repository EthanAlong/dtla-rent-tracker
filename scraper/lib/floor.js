// Best-effort floor number from a unit label. Every building we track that
// encodes the floor uses "<floor><2-digit line>", possibly behind a tower
// prefix: 201 -> 2, 3012 -> 30, 0707 -> 7, "B-3814" -> 38, "W3208" -> 32.
//
// Some buildings don't encode it at all — Eighth & Grand is 7 storeys but
// numbers units "0-2077", which would decode to a nonexistent floor 20. So
// pass the building's storey count from config and anything above it is
// rejected as "this label isn't a floor". No `floors` in config => no guess.
//
// Derived, not scraped: treat as a hint, and drop the config entry rather than
// invent a number if a building's scheme turns out to be something else.
export function deriveFloor(unit, maxFloors) {
  if (!maxFloors) return null;
  const m = String(unit ?? "").match(/(\d{3,4})\s*$/);
  if (!m) return null;
  const floor = parseInt(m[1].slice(0, -2), 10);
  return Number.isFinite(floor) && floor > 0 && floor <= maxFloors ? floor : null;
}
