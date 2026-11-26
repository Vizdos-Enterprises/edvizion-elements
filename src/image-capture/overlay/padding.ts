import type { CornerPoints } from 'scanic';

export function padCorners(
  corners: CornerPoints,
  padding: number,
  imageWidth: number,
  imageHeight: number,
): CornerPoints {
  const points = Object.values(corners);

  const center = {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };

  const expand = (point: { x: number; y: number }) => ({
    x: Math.max(0, Math.min(
      imageWidth - 1,
      center.x + (point.x - center.x) * (1 + padding * 2),
    )),
    y: Math.max(0, Math.min(
      imageHeight - 1,
      center.y + (point.y - center.y) * (1 + padding * 2),
    )),
  });

  return {
    topLeft: expand(corners.topLeft),
    topRight: expand(corners.topRight),
    bottomLeft: expand(corners.bottomLeft),
    bottomRight: expand(corners.bottomRight),
  };
}
