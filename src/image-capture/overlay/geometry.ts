import type { Rectangle } from '../analysis/types.js';

export function mapPreviewToImage(
  box: Rectangle,
  previewWidth: number,
  previewHeight: number,
  imageWidth: number,
  imageHeight: number,
): Rectangle {
  const scale = Math.max(
    previewWidth / imageWidth,
    previewHeight / imageHeight,
  );

  const renderedWidth = imageWidth * scale;
  const renderedHeight = imageHeight * scale;

  const offsetX = (previewWidth - renderedWidth) / 2;
  const offsetY = (previewHeight - renderedHeight) / 2;

  const x = Math.max(
    0,
    (box.x - offsetX) / scale,
  );

  const y = Math.max(
    0,
    (box.y - offsetY) / scale,
  );

  return {
    x,
    y,
    width: Math.max(0, Math.min(
      box.width / scale,
      imageWidth - x,
    )),
    height: Math.max(0, Math.min(
      box.height / scale,
      imageHeight - y,
    )),
  };
}
