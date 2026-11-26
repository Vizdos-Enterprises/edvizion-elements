export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoundingBox {
  aspectRatio: number;

  /** Fraction of the available preview width. */
  width?: number;

  /** Maximum fraction of the available preview height. */
  maxHeight?: number;

  borderRadius?: number;
  maskOpacity?: number;
  borderColor?: string;
  borderWidth?: number;
}

export interface AnalysisFrame {
  bitmap: ImageBitmap;
  timestamp: number;

  /** Bounding box in bitmap pixel coordinates. */
  boundingBox?: Rectangle;

  /** Original camera resolution. */
  sourceWidth: number;
  sourceHeight: number;

  signal: AbortSignal;
}

export interface AnalysisResult {
  passed: boolean;
  score?: number;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface Analyzer {
  readonly id: string;

  analyze(
    frame: AnalysisFrame
  ): AnalysisResult | Promise<AnalysisResult>;
}

export interface AnalysisReport {
  ready: boolean;
  timestamp: number;
  results: Record<string, AnalysisResult>;
}
