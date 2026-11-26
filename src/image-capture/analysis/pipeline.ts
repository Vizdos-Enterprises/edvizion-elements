import type {
  Analyzer,
  AnalysisFrame,
  AnalysisReport,
  AnalysisResult,
} from './types.js';

export class AnalysisPipeline {
  async analyze(
    frame: AnalysisFrame,
    analyzers: readonly Analyzer[],
  ): Promise<AnalysisReport> {
    const results: Record<string, AnalysisResult> =
      Object.create(null);

    for (const analyzer of analyzers) {
      frame.signal.throwIfAborted();

      try {
        results[analyzer.id] = await analyzer.analyze(frame);
      } catch (error) {
        frame.signal.throwIfAborted();

        results[analyzer.id] = {
          passed: false,
          message: 'Analysis failed',
          metadata: {
            error: String(error),
          },
        };
      }
    }

    frame.signal.throwIfAborted();

    return {
      ready: Object.values(results).every(result => result.passed),
      timestamp: frame.timestamp,
      results,
    };
  }
}
