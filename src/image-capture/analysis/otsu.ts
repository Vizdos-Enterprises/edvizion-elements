export interface OtsuResult {
  bitmap: ImageBitmap;
  threshold: number;
}

export async function otsuThreshold(
  bitmap: ImageBitmap,
): Promise<OtsuResult> {
  const canvas = document.createElement('canvas');

  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  const ctx = canvas.getContext('2d', {
    willReadFrequently: true,
  });

  if (!ctx) {
    throw new Error('Unable to create canvas context');
  }

  ctx.drawImage(bitmap, 0, 0);

  const imageData = ctx.getImageData(
    0,
    0,
    canvas.width,
    canvas.height,
  );

  const { data } = imageData;

  const histogram = new Uint32Array(256);

  const total = data.length / 4;

  let sum = 0;

  // Convert to grayscale and build histogram.

  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(
      data[i] * 0.299 +
      data[i + 1] * 0.587 +
      data[i + 2] * 0.114,
    );

    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;

    histogram[gray]++;
    sum += gray;
  }

  // Calculate the optimal threshold.

  let backgroundWeight = 0;
  let backgroundSum = 0;
  let maxVariance = 0;
  let threshold = 127;

  for (let i = 0; i < 256; i++) {
    backgroundWeight += histogram[i];

    if (backgroundWeight === 0) continue;

    const foregroundWeight = total - backgroundWeight;

    if (foregroundWeight === 0) break;

    backgroundSum += i * histogram[i];

    const backgroundMean =
      backgroundSum / backgroundWeight;

    const foregroundMean =
      (sum - backgroundSum) / foregroundWeight;

    const diff = backgroundMean - foregroundMean;

    const variance =
      backgroundWeight *
      foregroundWeight *
      diff *
      diff;

    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = i;
    }
  }

  // Convert to binary black and white.

  for (let i = 0; i < data.length; i += 4) {
    const value = data[i] <= threshold ? 0 : 255;

    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }

  return {
    bitmap: await createImageBitmap(imageData),
    threshold,
  };
}
