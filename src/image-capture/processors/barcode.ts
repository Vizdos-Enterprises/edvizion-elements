import type {
  CaptureProcessor,
  CaptureFrame,
  Rectangle,
} from '../analysis/types.js';

import type {
  BarcodeDetection,
  BarcodeFormat,
} from '../analyzers/barcode.js';

export interface BarcodeCaptureProcessorOptions {
  format?: BarcodeFormat;
  padding?: number;
  quality?: number;
  maxDimension?: number;
  selection?: 'largest' | 'first' | 'all';
  mimeType?: 'image/jpeg' | 'image/png';
}

export class BarcodeCaptureProcessor implements CaptureProcessor {
  private readonly format: BarcodeFormat | undefined;
  private readonly padding: number;
  private readonly quality: number;
  private readonly maxDimension: number;
  private readonly selection: 'largest' | 'first' | 'all';
  private readonly mimeType: 'image/jpeg' | 'image/png';

  constructor(options: BarcodeCaptureProcessorOptions = {}) {
    this.format = options.format;
    this.padding = options.padding ?? 0.15;
    this.quality = options.quality ?? 0.98;
    this.maxDimension = options.maxDimension ?? Infinity;
    this.selection = options.selection ?? 'largest';
    this.mimeType = options.mimeType ?? 'image/png';

    if (
      !Number.isFinite(this.padding) ||
      this.padding < 0 ||
      !(this.maxDimension > 0)
    ) {
      throw new Error('Invalid barcode processor configuration');
    }
  }

  async process(frame: CaptureFrame): Promise<Blob> {
    const {
      bitmap,
      analysisWidth,
      analysisHeight,
    } = frame;

    const result = frame.analysis?.results['barcode'];

    if (!result?.passed || !result.metadata?.validBarcodes) {
      throw new Error('No validated barcode available');
    }

    if (!analysisWidth || !analysisHeight) {
      throw new Error('Missing analysis dimensions');
    }

    let barcodes =
      result.metadata.validBarcodes as BarcodeDetection[];

    if (this.format) {
      barcodes = barcodes.filter(
        barcode => barcode.format === this.format,
      );
    }

    if (barcodes.length === 0) {
      throw new Error('Requested barcode not found');
    }

    const bounds = this.selectBounds(barcodes);

    const scaleX = bitmap.width / analysisWidth;
    const scaleY = bitmap.height / analysisHeight;

    const scaled: Rectangle = {
      x: bounds.x * scaleX,
      y: bounds.y * scaleY,
      width: bounds.width * scaleX,
      height: bounds.height * scaleY,
    };

    const crop = this.calculateCrop(
      scaled,
      bitmap.width,
      bitmap.height,
    );

    const outputScale = Math.min(
      1,
      this.maxDimension / Math.max(
        crop.width,
        crop.height,
      ),
    );

    const canvas = document.createElement('canvas');

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
            reject(new Error('Failed to encode barcode image'));
          }
        },
        this.mimeType,
        this.quality,
      );
    });
  }

  private selectBounds(
    barcodes: BarcodeDetection[],
  ): Rectangle {
    if (this.selection === 'first') {
      return barcodes[0].boundingBox;
    }

    if (this.selection === 'all') {
      const boxes = barcodes.map(
        barcode => barcode.boundingBox,
      );

      const x = Math.min(...boxes.map(box => box.x));
      const y = Math.min(...boxes.map(box => box.y));

      const right = Math.max(
        ...boxes.map(box => box.x + box.width),
      );

      const bottom = Math.max(
        ...boxes.map(box => box.y + box.height),
      );

      return {
        x,
        y,
        width: right - x,
        height: bottom - y,
      };
    }

    return barcodes.reduce((largest, current) => {
      const a = largest.boundingBox;
      const b = current.boundingBox;

      return b.width * b.height > a.width * a.height
        ? current
        : largest;
    }).boundingBox;
  }

  private calculateCrop(
    bounds: Rectangle,
    imageWidth: number,
    imageHeight: number,
  ): Rectangle {
    const paddingX = bounds.width * this.padding;
    const paddingY = bounds.height * this.padding;

    const x = Math.max(
      0,
      Math.floor(bounds.x - paddingX),
    );

    const y = Math.max(
      0,
      Math.floor(bounds.y - paddingY),
    );

    const right = Math.min(
      imageWidth,
      Math.ceil(bounds.x + bounds.width + paddingX),
    );

    const bottom = Math.min(
      imageHeight,
      Math.ceil(bounds.y + bounds.height + paddingY),
    );

    if (right <= x || bottom <= y) {
      throw new Error('Invalid barcode crop');
    }

    return {
      x,
      y,
      width: right - x,
      height: bottom - y,
    };
  }
}
