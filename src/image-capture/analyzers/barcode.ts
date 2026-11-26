import { BarcodeDetector } from 'barcode-detector/ponyfill';

import { otsuThreshold } from '../analysis/otsu.js';

import type {
  Analyzer,
  AnalysisFrame,
  AnalysisResult,
  Rectangle,
} from '../analysis/types.js';

export type BarcodeFormat = NonNullable<
  NonNullable<
    ConstructorParameters<typeof BarcodeDetector>[0]
  >['formats']
>[number];

export interface BarcodePoint {
  x: number;
  y: number;
}

export interface BarcodeDetection {
  format: string;
  boundingBox: Rectangle;
  cornerPoints: BarcodePoint[];
}

export interface BarcodeDetectorLike {
  detect(bitmap: ImageBitmap): Promise<{
    format: string;
    rawValue: string;
    boundingBox: Rectangle;
    cornerPoints: readonly BarcodePoint[];
  }[]>;
}

export type BarcodePreprocessing =
  | 'none'
  | 'otsu'
  | 'otsu-fallback';

export interface BarcodeAnalyzerOptions {
  detector?: BarcodeDetectorLike;
  requiredFormats?: BarcodeFormat[];
  minCount?: number;
  maxCount?: number;
  minCoverage?: number;
  includeRawValue?: boolean;

  cropToRegion?: boolean;
  searchPadding?: number;

  boundsTolerance?: number;

  preprocessing?: BarcodePreprocessing;
}

export class BarcodeAnalyzer implements Analyzer {
  readonly id = 'barcode';

  private readonly detector: BarcodeDetectorLike;
  private readonly requiredFormats: readonly BarcodeFormat[];
  private readonly minCount: number;
  private readonly maxCount: number;
  private readonly minCoverage: number;
  private readonly includeRawValue: boolean;
  private readonly boundsTolerance: number;
  private readonly cropToRegion: boolean;
  private readonly searchPadding: number;
  private readonly preprocessing: BarcodePreprocessing;

  constructor(options: BarcodeAnalyzerOptions = {}) {
    this.requiredFormats = options.requiredFormats ?? [];
    this.minCount = options.minCount ?? 1;
    this.maxCount = options.maxCount ?? Infinity;
    this.minCoverage = options.minCoverage ?? 0;
    this.includeRawValue = options.includeRawValue ?? false;
    this.boundsTolerance = options.boundsTolerance ?? 0.05;
    this.cropToRegion = options.cropToRegion ?? true;
    this.searchPadding = options.searchPadding ?? 0.1;

    this.preprocessing =
      options.preprocessing ?? 'otsu-fallback';

    if (
      !Number.isFinite(this.searchPadding) ||
      this.searchPadding < 0
    ) {
      throw new Error('Invalid barcode search padding');
    }

    this.detector = options.detector ?? new BarcodeDetector(
      this.requiredFormats.length > 0
        ? { formats: [...this.requiredFormats] }
        : {},
    );
  }

  async analyze(frame: AnalysisFrame): Promise<AnalysisResult> {
    frame.signal.throwIfAborted();

    const { bitmap } = frame;

    const region = frame.boundingBox ?? {
      x: 0,
      y: 0,
      width: bitmap.width,
      height: bitmap.height,
    };

    if (region.width <= 0 || region.height <= 0) {
      return {
        passed: false,
        message: 'Invalid analysis region',
      };
    }

    let croppedBitmap: ImageBitmap | undefined;
    let thresholdedBitmap: ImageBitmap | undefined;

    let offsetX = 0;
    let offsetY = 0;

    let threshold: number | undefined;
    let preprocessingUsed: 'none' | 'otsu' = 'none';

    let originalScanDurationMs = 0;
    let preprocessingDurationMs = 0;
    let fallbackScanDurationMs = 0;

    const started = performance.now();

    try {
      // Crop to the search region.

      if (this.cropToRegion && frame.boundingBox) {
        const paddingX =
          region.width * this.searchPadding;

        const paddingY =
          region.height * this.searchPadding;

        const x = Math.max(
          0,
          Math.floor(region.x - paddingX),
        );

        const y = Math.max(
          0,
          Math.floor(region.y - paddingY),
        );

        const right = Math.min(
          bitmap.width,
          Math.ceil(
            region.x + region.width + paddingX,
          ),
        );

        const bottom = Math.min(
          bitmap.height,
          Math.ceil(
            region.y + region.height + paddingY,
          ),
        );

        const width = right - x;
        const height = bottom - y;

        if (width <= 0 || height <= 0) {
          return {
            passed: false,
            message: 'Invalid barcode search region',
          };
        }

        offsetX = x;
        offsetY = y;

        croppedBitmap = await createImageBitmap(
          bitmap,
          x,
          y,
          width,
          height,
        );
      }

      const source = croppedBitmap ?? bitmap;

      frame.signal.throwIfAborted();

      // Original image fast path.

      let detections: Awaited<
        ReturnType<BarcodeDetectorLike['detect']>
      > = [];

      if (this.preprocessing !== 'otsu') {
        const scanStarted = performance.now();

        detections = await this.detector.detect(source);

        originalScanDurationMs =
          performance.now() - scanStarted;
      }

      frame.signal.throwIfAborted();

      const hasRequiredFormats =
        this.requiredFormats.length === 0
          ? detections.length > 0
          : this.requiredFormats.every(format =>
              detections.some(
                detection => detection.format === format,
              ),
            );

      // Otsu preprocessing fallback.

      const shouldThreshold =
        this.preprocessing === 'otsu' ||
        (
          this.preprocessing === 'otsu-fallback' &&
          !hasRequiredFormats
        );

      if (shouldThreshold) {
        const preprocessingStarted = performance.now();

        const result = await otsuThreshold(source);

        thresholdedBitmap = result.bitmap;
        threshold = result.threshold;

        preprocessingDurationMs =
          performance.now() - preprocessingStarted;

        frame.signal.throwIfAborted();

        const scanStarted = performance.now();

        const fallbackDetections =
          await this.detector.detect(thresholdedBitmap);

        fallbackScanDurationMs =
          performance.now() - scanStarted;

        frame.signal.throwIfAborted();

        // Prefer the thresholded detections when they contain
        // every required format, or when the original found none.

        const fallbackHasRequiredFormats =
          this.requiredFormats.length === 0
            ? fallbackDetections.length > 0
            : this.requiredFormats.every(format =>
                fallbackDetections.some(
                  detection => detection.format === format,
                ),
              );

        if (
          this.preprocessing === 'otsu' ||
          fallbackHasRequiredFormats ||
          detections.length === 0
        ) {
          detections = fallbackDetections;
          preprocessingUsed = 'otsu';
        }
      }

      // Filter required formats.

      const matching = detections.filter(detection =>
        this.requiredFormats.length === 0 ||
        this.requiredFormats.some(
          format => format === detection.format,
        )
      );

      // Translate coordinates back to the analysis bitmap.

      const barcodes = matching.map(detection => {
        const bounds = detection.boundingBox;

        const boundingBox: Rectangle = {
          x: bounds.x + offsetX,
          y: bounds.y + offsetY,
          width: bounds.width,
          height: bounds.height,
        };

        const toleranceX = region.width * this.boundsTolerance;
        const toleranceY = region.height * this.boundsTolerance;

        const withinBounds =
          boundingBox.x >= region.x - toleranceX &&
          boundingBox.y >= region.y - toleranceY &&
          boundingBox.x + boundingBox.width <=
            region.x + region.width + toleranceX &&
          boundingBox.y + boundingBox.height <=
            region.y + region.height + toleranceY;

        const coverage =
          (boundingBox.width * boundingBox.height) /
          (region.width * region.height);

        return {
          format: detection.format,
          boundingBox,

          cornerPoints: detection.cornerPoints.map(point => ({
            x: point.x + offsetX,
            y: point.y + offsetY,
          })),

          withinBounds,
          coverage,

          ...(this.includeRawValue
            ? { rawValue: detection.rawValue }
            : {}),
        };
      });

      const valid = barcodes.filter(barcode =>
        barcode.withinBounds &&
        barcode.boundingBox.width > 0 &&
        barcode.boundingBox.height > 0 &&
        barcode.coverage >= this.minCoverage
      );

      const missingFormats = this.requiredFormats.filter(
        format =>
          !valid.some(barcode => barcode.format === format),
      );

      // Validate detections.

      let message: string | undefined;

      if (matching.length === 0) {
        message = this.requiredFormats.length
          ? `No ${this.requiredFormats.join(' / ')} barcode detected`
          : 'No barcode detected';
      } else if (matching.length > this.maxCount) {
        message = 'Too many barcodes detected';
      } else if (
        barcodes.some(barcode => !barcode.withinBounds)
      ) {
        message = 'Position barcode inside the frame';
      } else if (
        barcodes.some(
          barcode => barcode.coverage < this.minCoverage,
        )
      ) {
        message = 'Move closer';
      } else if (missingFormats.length > 0) {
        message =
          `Missing required barcode: ${missingFormats.join(', ')}`;
      } else if (valid.length < this.minCount) {
        message = 'Not enough barcodes detected';
      }

      return {
        passed: message === undefined,
        message,

        metadata: {
          barcodeCount: detections.length,
          matchingCount: matching.length,
          validCount: valid.length,

          requiredFormats: [...this.requiredFormats],
          missingFormats,

          barcodes,
          validBarcodes: valid,

          analysisWidth: bitmap.width,
          analysisHeight: bitmap.height,

          scanWidth: source.width,
          scanHeight: source.height,

          cropped: croppedBitmap !== undefined,

          preprocessing: preprocessingUsed,
          preprocessingAttempted:
            thresholdedBitmap !== undefined,
          threshold,

          originalScanDurationMs,
          preprocessingDurationMs,
          fallbackScanDurationMs,

          durationMs: performance.now() - started,
        },
      };
    } finally {
      thresholdedBitmap?.close();
      croppedBitmap?.close();
    }
  }
}
