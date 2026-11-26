import type {
  CaptureProcessor,
  CaptureFrame,
} from '../analysis/types.js';

export interface BoundingBoxCaptureProcessorOptions {
  quality?: number;
  mimeType?: 'image/jpeg' | 'image/png';
  maxDimension?: number;
}

export class BoundingBoxCaptureProcessor implements CaptureProcessor {
  private readonly quality: number;
  private readonly mimeType: 'image/jpeg' | 'image/png';
  private readonly maxDimension: number;

  constructor(options: BoundingBoxCaptureProcessorOptions = {}) {
    this.quality = options.quality ?? 0.98;
    this.mimeType = options.mimeType ?? 'image/jpeg';
    this.maxDimension = options.maxDimension ?? Infinity;

    if (!(this.maxDimension > 0)) {
      throw new Error('Invalid maximum image dimension');
    }
  }

  async process(frame: CaptureFrame): Promise<Blob> {
    const { bitmap } = frame;

    const bounds = frame.boundingBox ?? {
      x: 0,
      y: 0,
      width: bitmap.width,
      height: bitmap.height,
    };

    const x = Math.max(0, Math.floor(bounds.x));
    const y = Math.max(0, Math.floor(bounds.y));

    const right = Math.min(
      bitmap.width,
      Math.ceil(bounds.x + bounds.width),
    );

    const bottom = Math.min(
      bitmap.height,
      Math.ceil(bounds.y + bounds.height),
    );

    const width = right - x;
    const height = bottom - y;

    if (width <= 0 || height <= 0) {
      throw new Error('Invalid capture bounding box');
    }

    const scale = Math.min(
      1,
      this.maxDimension / Math.max(width, height),
    );

    const canvas = document.createElement('canvas');

    canvas.width = Math.max(
      1,
      Math.round(width * scale),
    );

    canvas.height = Math.max(
      1,
      Math.round(height * scale),
    );

    const ctx = canvas.getContext('2d');

    if (!ctx) {
      throw new Error('Unable to create canvas context');
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.drawImage(
      bitmap,
      x,
      y,
      width,
      height,
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
            reject(new Error('Failed to encode bounding box image'));
          }
        },
        this.mimeType,
        this.quality,
      );
    });
  }
}
