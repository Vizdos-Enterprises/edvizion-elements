import type {
  CaptureProcessor,
  CaptureFrame,
  Rectangle,
} from '../analysis/types.js';

export interface FaceCaptureProcessorOptions {
  aspectRatio?: number;
  padding?: number;
  verticalOffset?: number;
  quality?: number;
  maxDimension?: number;
}

export class FaceCaptureProcessor implements CaptureProcessor {
  private readonly aspectRatio: number;
  private readonly padding: number;
  private readonly verticalOffset: number;
  private readonly quality: number;
  private readonly maxDimension: number;

  constructor(options: FaceCaptureProcessorOptions = {}) {
    this.aspectRatio = options.aspectRatio ?? 3 / 4;
    this.padding = options.padding ?? 0.5;
    this.verticalOffset = options.verticalOffset ?? 0.1;
    this.quality = options.quality ?? 0.98;
    this.maxDimension = options.maxDimension ?? Infinity;

    if (
      !Number.isFinite(this.aspectRatio) ||
      this.aspectRatio <= 0 ||
      !Number.isFinite(this.padding) ||
      this.padding < 0 ||
      !Number.isFinite(this.verticalOffset) ||
      !(this.maxDimension > 0)
    ) {
      throw new Error('Invalid face capture configuration');
    }
  }

  async process(frame: CaptureFrame): Promise<Blob> {
    const { bitmap, analysisWidth, analysisHeight } = frame;

    const result = frame.analysis?.results['face'];

    if (!result?.passed || !result.metadata?.face) {
      throw new Error('No validated face available');
    }

    if (!analysisWidth || !analysisHeight) {
      throw new Error('Missing analysis dimensions');
    }

    const detected = result.metadata.face as Rectangle;

    const scaleX = bitmap.width / analysisWidth;
    const scaleY = bitmap.height / analysisHeight;

    const face: Rectangle = {
      x: detected.x * scaleX,
      y: detected.y * scaleY,
      width: detected.width * scaleX,
      height: detected.height * scaleY,
    };

    const crop = this.calculateCrop(
      face,
      bitmap.width,
      bitmap.height,
    );

    const canvas = document.createElement('canvas');

    const outputScale = Math.min(
      1,
      this.maxDimension / Math.max(crop.width, crop.height),
    );

    canvas.width = Math.max(
      1,
      Math.round(crop.width * outputScale),
    );

    canvas.height = Math.max(
      1,
      Math.round(crop.height * outputScale),
    );

    const ctx = canvas.getContext('2d');

    if (!ctx) {
      throw new Error('Unable to create canvas context');
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.drawImage(
      bitmap,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        blob => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to encode portrait'));
          }
        },
        'image/jpeg',
        this.quality,
      );
    });
  }

  private calculateCrop(
    face: Rectangle,
    imageWidth: number,
    imageHeight: number,
  ): Rectangle {
    const centerX = face.x + face.width / 2;

    const centerY =
      face.y +
      face.height / 2 +
      face.height * this.verticalOffset;

    let width = face.width * (1 + this.padding * 2);
    let height = face.height * (1 + this.padding * 2);

    // Expand the crop to match the requested aspect ratio.
    if (width / height > this.aspectRatio) {
      height = width / this.aspectRatio;
    } else {
      width = height * this.aspectRatio;
    }

    // Fit the crop inside the source image.
    const scale = Math.min(
      1,
      imageWidth / width,
      imageHeight / height,
    );

    width *= scale;
    height *= scale;

    // Shift the crop instead of stretching the image.
    const x = Math.max(
      0,
      Math.min(imageWidth - width, centerX - width / 2),
    );

    const y = Math.max(
      0,
      Math.min(imageHeight - height, centerY - height / 2),
    );

    if (
      face.x < x ||
      face.y < y ||
      face.x + face.width > x + width ||
      face.y + face.height > y + height
    ) {
      throw new Error('Unable to crop the entire face');
    }

    return { x, y, width, height };
  }
}
