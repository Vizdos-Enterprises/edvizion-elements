import { AnalysisPipeline } from './pipeline.js';

import type {
  Analyzer,
  AnalysisReport,
  CaptureProcessor,
  Rectangle,
} from './types.js';

export interface ImageProcessingOptions {
  analyzers: readonly Analyzer[];
  processor?: CaptureProcessor;
  analysisResolution?: number;
  boundingBox?: Rectangle;
  signal?: AbortSignal;
}

export type ImageProcessingResult =
  | {
      passed: true;
      analysis: AnalysisReport;
      output: Blob;
    }
  | {
      passed: false;
      analysis: AnalysisReport;
      output: undefined;
    };

export class ImageProcessingPipeline {
  private readonly pipeline = new AnalysisPipeline();

  async process(
    input: Blob,
    options: ImageProcessingOptions,
  ): Promise<ImageProcessingResult> {
    const signal =
      options.signal ?? new AbortController().signal;

    signal.throwIfAborted();

    const bitmap = await createImageBitmap(input);

    let analysisBitmap: ImageBitmap | undefined;

    try {
      const resolution = options.analysisResolution ?? 640;

      if (!Number.isFinite(resolution) || resolution <= 0) {
        throw new Error('Invalid analysis resolution');
      }

      const scale = Math.min(
        1,
        resolution / Math.max(bitmap.width, bitmap.height),
      );

      analysisBitmap = await createImageBitmap(bitmap, {
        resizeWidth: Math.max(
          1,
          Math.round(bitmap.width * scale),
        ),
        resizeHeight: Math.max(
          1,
          Math.round(bitmap.height * scale),
        ),
        resizeQuality: 'medium',
      });

      signal.throwIfAborted();

      const scaleX = analysisBitmap.width / bitmap.width;
      const scaleY = analysisBitmap.height / bitmap.height;

      const boundingBox = options.boundingBox
        ? {
            x: options.boundingBox.x * scaleX,
            y: options.boundingBox.y * scaleY,
            width: options.boundingBox.width * scaleX,
            height: options.boundingBox.height * scaleY,
          }
        : undefined;

      const analysis = await this.pipeline.analyze(
        {
          bitmap: analysisBitmap,
          timestamp: performance.now(),
          sourceWidth: bitmap.width,
          sourceHeight: bitmap.height,
          boundingBox,
          signal,
        },
        options.analyzers,
      );

      signal.throwIfAborted();

      // Never invoke the processor if any analyzer fails.
      if (!analysis.ready) {
        return {
          passed: false,
          analysis,
          output: undefined,
        };
      }

      const output = options.processor
        ? await options.processor.process({
            bitmap,
            boundingBox: options.boundingBox,
            analysis,
            analysisWidth: analysisBitmap.width,
            analysisHeight: analysisBitmap.height,
          })
        : input;

      signal.throwIfAborted();

      return {
        passed: true,
        analysis,
        output,
      };
    } finally {
      analysisBitmap?.close();
      bitmap.close();
    }
  }
}
