import { Scanner } from 'scanic';
import type { CornerPoints } from 'scanic';

import type {
  Analyzer,
  AnalysisFrame,
  AnalysisResult,
  Rectangle,
} from '../analysis/types.js';

export interface ScanicAnalyzerOptions {
  minConfidence?: number;
  minCoverage?: number;
}

export function evaluateDocumentBounds(
  corners: CornerPoints,
  region: Rectangle,
  minCoverage: number,
): AnalysisResult {
  const points = [
    corners.topLeft,
    corners.topRight,
    corners.bottomRight,
    corners.bottomLeft,
  ];

  const withinBounds = points.every(point =>
    point.x >= region.x &&
    point.y >= region.y &&
    point.x <= region.x + region.width &&
    point.y <= region.y + region.height
  );

  // Shoelace formula for quadrilateral area.
  const area = Math.abs(
    points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];

      return sum +
        point.x * next.y -
        next.x * point.y;
    }, 0)
  ) / 2;

  const coverage = area / (region.width * region.height);

  const largeEnough = coverage >= minCoverage;

  return {
    passed: withinBounds && largeEnough,
    score: Math.min(1, coverage),
    message: !withinBounds
      ? 'Position document inside the frame'
      : !largeEnough
        ? 'Move closer'
        : undefined,
    metadata: {
      corners,
      coverage,
      withinBounds,
    },
  };
}

export class ScanicAnalyzer implements Analyzer {
  readonly id = 'document-bounds';

  private readonly scanner: Scanner;
  private readonly minCoverage: number;

  constructor(options: ScanicAnalyzerOptions = {}) {
    this.minCoverage = options.minCoverage ?? 0.5;

    this.scanner = new Scanner({
      mode: 'detect',
      detector: 'classical',
      minDetectionConfidence: options.minConfidence ?? 0.5,
    });
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

    const result = await this.scanner.scan(bitmap);

    frame.signal.throwIfAborted();

    if (!result.success || !result.corners) {
      return {
        passed: false,
        message: 'No document detected',
      };
    }

    const evaluation = evaluateDocumentBounds(
      result.corners,
      region,
      this.minCoverage,
    );

    return {
      ...evaluation,
      metadata: {
        ...evaluation.metadata,
        confidence: result.confidence,
      },
    };
  }
}
