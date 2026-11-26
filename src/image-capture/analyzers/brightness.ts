import type {
  Analyzer,
  AnalysisFrame,
  AnalysisResult,
} from '../analysis/types.js';

export class BrightnessAnalyzer implements Analyzer {
  readonly id = 'brightness';

  constructor(
    private readonly minBrightness = 60,
    private readonly maxBrightness = 220,
  ) {}

  analyze(frame: AnalysisFrame): AnalysisResult {
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

    const canvas = document.createElement('canvas');

    canvas.width = 64;
    canvas.height = 64;

    const ctx = canvas.getContext('2d', {
      willReadFrequently: true,
    })!;

    ctx.drawImage(
      bitmap,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );

    const { data } = ctx.getImageData(
      0, 0, canvas.width, canvas.height,
    );

    let brightness = 0;

    for (let i = 0; i < data.length; i += 4) {
      brightness +=
        data[i] * 0.2126 +
        data[i + 1] * 0.7152 +
        data[i + 2] * 0.0722;
    }

    brightness /= data.length / 4;

    const tooDark = brightness < this.minBrightness;
    const tooBright = brightness > this.maxBrightness;

    return {
      passed: !tooDark && !tooBright,
      score: brightness / 255,
      message: tooDark
        ? 'Too dark'
        : tooBright
          ? 'Too bright'
          : undefined,
      metadata: { brightness },
    };
  }
}
