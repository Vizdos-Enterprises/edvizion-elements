import type {
  Analyzer,
  AnalysisFrame,
  AnalysisResult,
} from '../analysis/types.js';

export interface ReadabilityAnalyzerOptions {
  minBrightness?: number;
  maxBrightness?: number;

  minLocalContrast?: number;
  minDynamicRange?: number;
  minSharpness?: number;

  maxUnderexposedRatio?: number;
  maxOverexposedRatio?: number;

  underexposedThreshold?: number;
  overexposedThreshold?: number;

  tileSize?: number;
  analysisResolution?: number;

  advisory?: boolean;
}

export interface ReadabilityMetrics {
  brightness: number;
  localContrast: number;
  dynamicRange: number;
  sharpness: number;

  underexposedRatio: number;
  overexposedRatio: number;

  p05: number;
  p50: number;
  p95: number;
}

export interface ReadabilityIssue {
  code:
    | 'too_dark'
    | 'too_bright'
    | 'low_contrast'
    | 'low_dynamic_range'
    | 'blurry'
    | 'underexposed'
    | 'overexposed';

  message: string;
  value: number;
  threshold: number;
}

export class ReadabilityAnalyzer implements Analyzer {
  readonly id = 'readability';

  private readonly options: Required<ReadabilityAnalyzerOptions>;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(options: ReadabilityAnalyzerOptions = {}) {
    this.options = {
      minBrightness: 40,
      maxBrightness: 235,

      minLocalContrast: 0.06,
      minDynamicRange: 0.25,
      minSharpness: 0.025,

      maxUnderexposedRatio: 0.4,
      maxOverexposedRatio: 0.4,

      underexposedThreshold: 15,
      overexposedThreshold: 245,

      tileSize: 32,
      analysisResolution: 640,

      advisory: false,

      ...options,
    };

    if (
      !Number.isFinite(this.options.tileSize) ||
      this.options.tileSize < 2 ||
      !Number.isFinite(this.options.analysisResolution) ||
      this.options.analysisResolution < 3
    ) {
      throw new Error('Invalid readability analyzer configuration');
    }

    this.canvas = document.createElement('canvas');

    const ctx = this.canvas.getContext('2d', {
      willReadFrequently: true,
    });

    if (!ctx) {
      throw new Error('Unable to create canvas context');
    }

    this.ctx = ctx;
  }

  analyze(frame: AnalysisFrame): AnalysisResult {
    frame.signal.throwIfAborted();

    const started = performance.now();

    const { bitmap } = frame;

    const region = frame.boundingBox ?? {
      x: 0,
      y: 0,
      width: bitmap.width,
      height: bitmap.height,
    };

    // Clamp the analysis region to the bitmap.

    const x = Math.max(0, Math.floor(region.x));
    const y = Math.max(0, Math.floor(region.y));

    const right = Math.min(
      bitmap.width,
      Math.ceil(region.x + region.width),
    );

    const bottom = Math.min(
      bitmap.height,
      Math.ceil(region.y + region.height),
    );

    const regionWidth = right - x;
    const regionHeight = bottom - y;

    if (regionWidth <= 0 || regionHeight <= 0) {
      return {
        passed: false,
        message: 'Invalid analysis region',
      };
    }

    // Normalize resolution so metrics remain reasonably
    // comparable across different camera resolutions.

    const scale = Math.min(
      1,
      this.options.analysisResolution /
        Math.max(regionWidth, regionHeight),
    );

    const width = Math.max(
      1,
      Math.round(regionWidth * scale),
    );

    const height = Math.max(
      1,
      Math.round(regionHeight * scale),
    );

    if (width < 3 || height < 3) {
      return {
        passed: false,
        message: 'Analysis region too small',
      };
    }

    if (
      this.canvas.width !== width ||
      this.canvas.height !== height
    ) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    this.ctx.clearRect(0, 0, width, height);

    this.ctx.drawImage(
      bitmap,
      x,
      y,
      regionWidth,
      regionHeight,
      0,
      0,
      width,
      height,
    );

    const imageData = this.ctx.getImageData(
      0,
      0,
      width,
      height,
    );

    const grayscale = new Uint8Array(width * height);
    const histogram = new Uint32Array(256);

    let luminanceSum = 0;
    let underexposedCount = 0;
    let overexposedCount = 0;

    // Grayscale conversion and histogram collection.

    for (
      let i = 0, p = 0;
      i < imageData.data.length;
      i += 4, p++
    ) {
      const luminance = Math.round(
        imageData.data[i] * 0.299 +
        imageData.data[i + 1] * 0.587 +
        imageData.data[i + 2] * 0.114,
      );

      grayscale[p] = luminance;

      histogram[luminance]++;
      luminanceSum += luminance;

      if (
        luminance <= this.options.underexposedThreshold
      ) {
        underexposedCount++;
      }

      if (
        luminance >= this.options.overexposedThreshold
      ) {
        overexposedCount++;
      }
    }

    frame.signal.throwIfAborted();

    const pixelCount = grayscale.length;

    const p05 = this.percentile(
      histogram,
      pixelCount,
      0.05,
    );

    const p50 = this.percentile(
      histogram,
      pixelCount,
      0.5,
    );

    const p95 = this.percentile(
      histogram,
      pixelCount,
      0.95,
    );

    const metrics: ReadabilityMetrics = {
      brightness: luminanceSum / pixelCount,

      localContrast: this.calculateLocalContrast(
        grayscale,
        width,
        height,
      ),

      dynamicRange: (p95 - p05) / 255,

      sharpness: this.calculateSharpness(
        grayscale,
        width,
        height,
      ),

      underexposedRatio:
        underexposedCount / pixelCount,

      overexposedRatio:
        overexposedCount / pixelCount,

      p05,
      p50,
      p95,
    };

    frame.signal.throwIfAborted();

    const issues = this.evaluate(metrics);

    const readable = issues.length === 0;

    const recommendation = this.getRecommendation(
      metrics,
      issues,
    );

    return {
      passed: this.options.advisory || readable,

      score: this.calculateScore(metrics),

      message: recommendation,

      metadata: {
        ...metrics,

        readable,
        advisory: this.options.advisory,

        issues,
        recommendation,

        analysisWidth: width,
        analysisHeight: height,

        durationMs: performance.now() - started,
      },
    };
  }

  private percentile(
    histogram: Uint32Array,
    total: number,
    percentile: number,
  ): number {
    const target = Math.max(
      1,
      Math.ceil(total * percentile),
    );

    let cumulative = 0;

    for (let i = 0; i < histogram.length; i++) {
      cumulative += histogram[i];

      if (cumulative >= target) {
        return i;
      }
    }

    return 255;
  }

  private calculateLocalContrast(
    pixels: Uint8Array,
    width: number,
    height: number,
  ): number {
    const tileSize = Math.floor(this.options.tileSize);

    let weightedContrast = 0;
    let totalPixels = 0;

    for (let y = 0; y < height; y += tileSize) {
      for (let x = 0; x < width; x += tileSize) {
        const right = Math.min(x + tileSize, width);
        const bottom = Math.min(y + tileSize, height);

        let sum = 0;
        let sumSquared = 0;
        let count = 0;

        for (let ty = y; ty < bottom; ty++) {
          const row = ty * width;

          for (let tx = x; tx < right; tx++) {
            const value = pixels[row + tx];

            sum += value;
            sumSquared += value * value;

            count++;
          }
        }

        if (count === 0) continue;

        const mean = sum / count;

        const variance = Math.max(
          0,
          sumSquared / count - mean * mean,
        );

        // Normalized RMS contrast: 0–1.

        const contrast = Math.sqrt(variance) / 127.5;

        weightedContrast += contrast * count;
        totalPixels += count;
      }
    }

    return totalPixels > 0
      ? weightedContrast / totalPixels
      : 0;
  }

  private calculateSharpness(
    pixels: Uint8Array,
    width: number,
    height: number,
  ): number {
    let gradientEnergy = 0;
    let count = 0;

    // Sobel gradient / Tenengrad.

    for (let y = 1; y < height - 1; y++) {
      const previous = (y - 1) * width;
      const current = y * width;
      const next = (y + 1) * width;

      for (let x = 1; x < width - 1; x++) {
        const tl = pixels[previous + x - 1];
        const tc = pixels[previous + x];
        const tr = pixels[previous + x + 1];

        const ml = pixels[current + x - 1];
        const mr = pixels[current + x + 1];

        const bl = pixels[next + x - 1];
        const bc = pixels[next + x];
        const br = pixels[next + x + 1];

        const gx =
          -tl + tr -
          2 * ml + 2 * mr -
          bl + br;

        const gy =
          -tl - 2 * tc - tr +
          bl + 2 * bc + br;

        gradientEnergy += gx * gx + gy * gy;

        count++;
      }
    }

    if (count === 0) return 0;

    // Normalize RMS Sobel gradient to approximately 0–1.

    return Math.min(
      1,
      Math.sqrt(gradientEnergy / count) /
        (4 * 255 * Math.SQRT2),
    );
  }

  private evaluate(
    metrics: ReadabilityMetrics,
  ): ReadabilityIssue[] {
    const issues: ReadabilityIssue[] = [];

    const options = this.options;

    if (metrics.brightness < options.minBrightness) {
      issues.push({
        code: 'too_dark',
        message: 'Not enough light',
        value: metrics.brightness,
        threshold: options.minBrightness,
      });
    }

    if (metrics.brightness > options.maxBrightness) {
      issues.push({
        code: 'too_bright',
        message: 'Too much light',
        value: metrics.brightness,
        threshold: options.maxBrightness,
      });
    }

    if (
      metrics.localContrast < options.minLocalContrast
    ) {
      issues.push({
        code: 'low_contrast',
        message: 'Details are difficult to distinguish',
        value: metrics.localContrast,
        threshold: options.minLocalContrast,
      });
    }

    if (
      metrics.dynamicRange < options.minDynamicRange
    ) {
      issues.push({
        code: 'low_dynamic_range',
        message: 'Insufficient contrast between light and dark areas',
        value: metrics.dynamicRange,
        threshold: options.minDynamicRange,
      });
    }

    if (metrics.sharpness < options.minSharpness) {
      issues.push({
        code: 'blurry',
        message: 'Image details are not sharp enough',
        value: metrics.sharpness,
        threshold: options.minSharpness,
      });
    }

    if (
      metrics.underexposedRatio >
      options.maxUnderexposedRatio
    ) {
      issues.push({
        code: 'underexposed',
        message: 'Too much of the image is dark',
        value: metrics.underexposedRatio,
        threshold: options.maxUnderexposedRatio,
      });
    }

    if (
      metrics.overexposedRatio >
      options.maxOverexposedRatio
    ) {
      issues.push({
        code: 'overexposed',
        message: 'Too much of the image is overexposed',
        value: metrics.overexposedRatio,
        threshold: options.maxOverexposedRatio,
      });
    }

    return issues;
  }

  private getRecommendation(
    metrics: ReadabilityMetrics,
    issues: ReadabilityIssue[],
  ): string | undefined {
    if (issues.length === 0) {
      return undefined;
    }

    const has = (code: ReadabilityIssue['code']) =>
      issues.some(issue => issue.code === code);

    if (has('too_bright') || has('overexposed')) {
      return 'Reduce lighting or tilt to avoid reflections';
    }

    if (has('too_dark') || has('underexposed')) {
      return 'Turn on your flashlight or improve lighting';
    }

    if (
      has('low_contrast') ||
      has('low_dynamic_range')
    ) {
      if (metrics.brightness < 120) {
        return 'Turn on your flashlight to improve detail';
      }

      return 'Adjust lighting to improve contrast';
    }

    if (has('blurry')) {
      return 'Hold steady and allow the camera to focus';
    }

    return issues[0].message;
  }

  private calculateScore(
    metrics: ReadabilityMetrics,
  ): number {
    const clamp = (value: number) =>
      Math.max(0, Math.min(1, value));

    const contrastScore = clamp(
      metrics.localContrast / 0.2,
    );

    const dynamicRangeScore = clamp(
      metrics.dynamicRange / 0.6,
    );

    const sharpnessScore = clamp(
      metrics.sharpness / 0.15,
    );

    const exposureScore = clamp(
      1 -
        metrics.underexposedRatio -
        metrics.overexposedRatio,
    );

    return (
      contrastScore * 0.35 +
      sharpnessScore * 0.35 +
      dynamicRangeScore * 0.2 +
      exposureScore * 0.1
    );
  }
}
