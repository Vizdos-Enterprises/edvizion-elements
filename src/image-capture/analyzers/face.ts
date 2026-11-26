import type { FaceDetector } from '@mediapipe/tasks-vision';

import type {
  Analyzer,
  AnalysisFrame,
  AnalysisResult,
  Rectangle,
} from '../analysis/types.js';

export interface FaceAnalyzerOptions {
  detector: FaceDetector;
  minConfidence?: number;
  minCoverage?: number;
  maxCoverage?: number;
  centerTolerance?: number;
}

export class FaceAnalyzer implements Analyzer {
  readonly id = 'face';

  private readonly detector: FaceDetector;
  private readonly minConfidence: number;
  private readonly minCoverage: number;
  private readonly maxCoverage: number;
  private readonly centerTolerance: number;

  constructor(options: FaceAnalyzerOptions) {
    this.detector = options.detector;
    this.minConfidence = options.minConfidence ?? 0.7;
    this.minCoverage = options.minCoverage ?? 0.15;
    this.maxCoverage = options.maxCoverage ?? 0.65;
    this.centerTolerance = options.centerTolerance ?? 0.15;
  }

  analyze(frame: AnalysisFrame): AnalysisResult {
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

    const { detections } = this.detector.detect(bitmap);

    frame.signal.throwIfAborted();

    const faces = detections.filter(
      detection =>
        (detection.categories[0]?.score ?? 0) >=
        this.minConfidence,
    );

    if (faces.length === 0) {
      return {
        passed: false,
        message: 'No face detected',
        metadata: { faceCount: 0 },
      };
    }

    if (faces.length > 1) {
      return {
        passed: false,
        message: 'Only one person should be visible',
        metadata: { faceCount: faces.length },
      };
    }

    const detection = faces[0];
    const bounds = detection.boundingBox;

    if (!bounds) {
      return {
        passed: false,
        message: 'Unable to locate face',
      };
    }

    const face: Rectangle = {
      x: bounds.originX,
      y: bounds.originY,
      width: bounds.width,
      height: bounds.height,
    };

    const confidence = detection.categories[0]?.score ?? 0;

    const withinBounds =
      face.x >= region.x &&
      face.y >= region.y &&
      face.x + face.width <= region.x + region.width &&
      face.y + face.height <= region.y + region.height;

    const coverage =
      (face.width * face.height) /
      (region.width * region.height);

    const faceCenterX = face.x + face.width / 2;
    const faceCenterY = face.y + face.height / 2;

    const regionCenterX = region.x + region.width / 2;
    const regionCenterY = region.y + region.height / 2;

    const offsetX =
      Math.abs(faceCenterX - regionCenterX) / region.width;

    const offsetY =
      Math.abs(faceCenterY - regionCenterY) / region.height;

    const centered =
      offsetX <= this.centerTolerance &&
      offsetY <= this.centerTolerance;

    let message: string | undefined;

    if (!withinBounds) {
      message = 'Position your face inside the frame';
    } else if (coverage < this.minCoverage) {
      message = 'Move closer';
    } else if (coverage > this.maxCoverage) {
      message = 'Move farther away';
    } else if (!centered) {
      message = 'Center your face';
    }

    return {
      passed: message === undefined,
      score: confidence,
      message,
      metadata: {
        faceCount: faces.length,
        face,
        confidence,
        coverage,
        withinBounds,
        centered,
        offsetX,
        offsetY,
        keypoints: detection.keypoints,
      },
    };
  }
}
