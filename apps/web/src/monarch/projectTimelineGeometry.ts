export interface TimelineMarkerPoint {
  x: number;
  y: number;
  rowTop: number;
}

interface Point {
  x: number;
  y: number;
}

/** Marker gutters and the row's empty top padding stay clear of event captions. */
export function timelineConnectionPoints(
  source: TimelineMarkerPoint,
  destination: TimelineMarkerPoint,
): readonly Point[] {
  if (Math.abs(source.x - destination.x) < 0.5) return [source, destination];
  const sourceRail = source.x - 14;
  const destinationRail = destination.x - 14;
  const crossover = destination.rowTop + 4;
  return [
    source,
    { x: sourceRail, y: source.y },
    { x: sourceRail, y: crossover },
    { x: destinationRail, y: crossover },
    { x: destinationRail, y: destination.y },
    destination,
  ];
}
