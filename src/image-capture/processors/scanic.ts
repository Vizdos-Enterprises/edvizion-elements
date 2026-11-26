import { Scanner } from 'scanic';
import type { CornerPoints } from 'scanic';

import type {
  CaptureProcessor,
  CaptureFrame,
} from '../analysis/types.js';

import { padCorners } from '../overlay/padding.js';

export interface ScanicCaptureProcessorOptions {
  quality?: number;
  padding?: number;
}

export class ScanicCaptureProcessor implements CaptureProcessor {
  private readonly scanner = new Scanner({
    detector: 'classical',
  });

  private readonly quality: number;
  private readonly padding: number;

  constructor(options: ScanicCaptureProcessorOptions = {}) {
    this.quality = options.quality ?? 0.98;
    this.padding = options.padding ?? 0.03;
  }

  async process(frame: CaptureFrame): Promise<Blob> {
    const { bitmap, analysisWidth, analysisHeight } = frame;

    const result = frame.analysis?.results['document-bounds'];

    if (!result?.passed || !result.metadata?.corners) {
      throw new Error('No validated document available');
    }

    if (!analysisWidth || !analysisHeight) {
      throw new Error('Missing analysis dimensions');
    }

    const detected = result.metadata.corners as CornerPoints;

    const scaleX = bitmap.width / analysisWidth;
    const scaleY = bitmap.height / analysisHeight;

    const scale = (point: { x: number; y: number }) => ({
      x: point.x * scaleX,
      y: point.y * scaleY,
    });

    const corners = padCorners(
      {
        topLeft: scale(detected.topLeft),
        topRight: scale(detected.topRight),
        bottomLeft: scale(detected.bottomLeft),
        bottomRight: scale(detected.bottomRight),
      },
      this.padding,
      bitmap.width,
      bitmap.height,
    );

    const extracted = await this.scanner.extract(
      bitmap,
      corners,
      { output: 'canvas' },
    );

    if (
      !extracted.success ||
      !(extracted.output instanceof HTMLCanvasElement)
    ) {
      throw new Error('Failed to extract document');
    }

    const canvas = extracted.output;

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        blob => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to encode document'));
          }
        },
        'image/jpeg',
        this.quality,
      );
    });
  }
}
