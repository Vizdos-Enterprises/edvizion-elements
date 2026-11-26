import { LitElement, html, css, nothing } from 'lit';
import {
  customElement,
  property,
  query,
} from 'lit/decorators.js';

import { styleMap } from 'lit/directives/style-map.js';

import {
  BoundingBoxCaptureProcessor,
} from './processors/bounding-box.js';

import './image-capture.js';
import type { ImageCapture } from './image-capture.js';

import { AnalysisPipeline } from './analysis/pipeline.js';
import { mapPreviewToImage } from './overlay/geometry.js';

import type {
  Analyzer,
  AnalysisReport,
  BoundingBox,
  Rectangle,
  CaptureProcessor,
  DetailedCaptureResult,
} from './analysis/types.js';

type TorchSource = 'manual' | 'automatic';

@customElement('guided-capture')
export class GuidedCapture extends LitElement {
  @property({ type: String, attribute: 'facing-mode' })
  accessor facingMode: 'user' | 'environment' = 'environment';

  @property({ attribute: false })
  accessor boundingBox: BoundingBox | undefined = undefined;

  @property({ attribute: false })
  accessor analyzers: Analyzer[] = [];

  @property({ type: Number, attribute: 'analysis-fps' })
  accessor analysisFPS = 5;

  @property({ type: Number, attribute: 'analysis-resolution' })
  accessor analysisResolution = 640;

  @property({ type: Boolean, attribute: 'analysis-enabled' })
  accessor analysisEnabled = true;

  @property({ type: Boolean, reflect: true })
  accessor ready = false;

  @property({ type: Boolean, reflect: true })
  accessor capturing = false;

  @property({
    type: Boolean,
    reflect: true,
    attribute: 'torch-supported',
  })
  accessor torchSupported = false;

  @property({
    type: Boolean,
    reflect: true,
    attribute: 'torch-enabled',
  })
  accessor torchEnabled = false;

  @property({
    type: Boolean,
    attribute: 'auto-torch',
  })
  accessor autoTorch = false;

  @property({
    type: Number,
    attribute: 'auto-torch-delay',
  })
  accessor autoTorchDelay = 1500;

  @property({
    type: Boolean,
    reflect: true,
    attribute: 'auto-torch-activated',
  })
  accessor autoTorchActivated = false;

  @property({
    type: Number,
    attribute: 'auto-torch-luminance-threshold',
  })
  accessor autoTorchLuminanceThreshold = 120;

  @property({
    type: Number,
    attribute: 'capture-cache-duration',
  })
  accessor captureCacheDuration = 1500;

  @property({ attribute: false })
  accessor boundingBoxProcessor: CaptureProcessor =
    new BoundingBoxCaptureProcessor();

  @property({ attribute: false })
  accessor analysis: AnalysisReport | undefined = undefined;

  @property({ attribute: false })
  accessor captureProcessor: CaptureProcessor | undefined = undefined;

  @query('image-capture')
  accessor camera!: ImageCapture;

  @query('.stage')
  private accessor stage!: HTMLElement;

  @query('.bounding-box')
  private accessor guide!: HTMLElement | null;

  private poorLightingSince?: number;
  private autoTorchSuppressed = false;

  private torchChanging = false;
  private torchOperation: Promise<void> = Promise.resolve();

  private pipeline = new AnalysisPipeline();

  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private observer?: MutationObserver;
  private resizeObserver?: ResizeObserver;

  private analyzedFrame?: {
    bitmap: ImageBitmap;
    analysis?: AnalysisReport;
    analysisWidth: number;
    analysisHeight: number;
    boundingBox?: Rectangle;
    timestamp: number;
  };

  private revision = 0;

  private cacheExpiryTimer?: ReturnType<typeof setTimeout>;

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }

    .stage {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: black;

      container-type: size;
      isolation: isolate;
    }

    image-capture {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }

    image-capture::part(preview) {
      width: 100%;
      height: 100%;
    }

    image-capture::part(video) {
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center;
    }

    .bounding-box {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      box-sizing: border-box;

      box-shadow: 0 0 0 200vmax var(--mask-color);

      pointer-events: none;
      z-index: 1;

      transition: border-color 150ms ease;
    }

    .overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 2;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();

    const controller = new AbortController();
    this.controller = controller;

    this.resetAutoTorch();

    void this.updateComplete.then(() => {
      if (
        controller.signal.aborted ||
        !this.isConnected
      ) return;

      this.observeCamera();
      this.observeGeometry();

      void this.analyzeLoop(controller.signal);
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();

    this.controller?.abort();
    this.controller = undefined;

    clearTimeout(this.timer);

    this.observer?.disconnect();
    this.resizeObserver?.disconnect();

    this.observer = undefined;
    this.resizeObserver = undefined;

    this.autoTorchActivated = false;
    this.torchEnabled = false;
    this.torchSupported = false;

    this.resetAutoTorch();
    this.invalidateAnalysis();
  }

  protected updated(
    changed: Map<PropertyKey, unknown>,
  ): void {
    if (
      changed.has('analyzers') ||
      changed.has('boundingBox') ||
      changed.has('analysisResolution') ||
      changed.has('analysisEnabled') ||
      changed.has('captureProcessor') ||
      changed.has('captureCacheDuration') ||
      changed.has('facingMode')
    ) {
      this.invalidateAnalysis();
    }

    if (
      changed.has('autoTorch') ||
      changed.has('autoTorchDelay') ||
      changed.has('autoTorchLuminanceThreshold') ||
      changed.has('analysisEnabled')
    ) {
      this.poorLightingSince = undefined;
    }

    if (changed.has('autoTorch') && this.autoTorch) {
      this.resetAutoTorch();
    }
  }

  // --------------------------------------------------
  // Analysis lifecycle
  // --------------------------------------------------

  private invalidateAnalysis(): void {
    this.revision++;

    this.ready = false;
    this.analysis = undefined;

    this.poorLightingSince = undefined;

    this.releaseAnalyzedFrame();
  }

  private observeGeometry(): void {
    this.resizeObserver = new ResizeObserver(() => {
      this.invalidateAnalysis();
    });

    this.resizeObserver.observe(this.stage);
  }

  private syncTorchState(): void {
    this.torchSupported = this.camera?.torchSupported ?? false;
    this.torchEnabled = this.camera?.torchEnabled ?? false;

    if (!this.torchEnabled) {
      this.autoTorchActivated = false;
    }
  }

  private observeCamera(): void {
    this.observer = new MutationObserver(() => {
      const previouslyEnabled = this.torchEnabled;

      this.syncTorchState();

      if (
        previouslyEnabled !== this.torchEnabled &&
        !this.torchChanging
      ) {
        this.invalidateAnalysis();
      }
    });

    this.observer.observe(this.camera, {
      attributes: true,
      attributeFilter: [
        'capturing',
        'torch-supported',
        'torch-enabled',
      ],
    });

    this.syncTorchState();
  }

  // --------------------------------------------------
  // Automatic torch
  // --------------------------------------------------

  resetAutoTorch(): void {
    this.autoTorchSuppressed = false;
    this.poorLightingSince = undefined;
  }

  private async evaluateAutoTorch(
    report: AnalysisReport,
  ): Promise<void> {
    if (
      !this.isConnected ||
      !this.autoTorch ||
      !this.analysisEnabled ||
      !this.torchSupported ||
      this.torchEnabled ||
      this.torchChanging ||
      this.autoTorchSuppressed ||
      this.capturing ||
      this.ready ||
      report.ready
    ) {
      this.poorLightingSince = undefined;
      return;
    }

    // Don't activate the torch if the barcode is already
    // readable, even if another analyzer is failing.

    if (report.results['barcode']?.passed) {
      this.poorLightingSince = undefined;
      return;
    }

    const brightness = report.results['brightness'];
    const readability = report.results['readability'];

    const rawIssues = readability?.metadata?.issues;

    const issues = Array.isArray(rawIssues)
      ? rawIssues as { code: string }[]
      : [];

    const hasIssue = (code: string): boolean =>
      issues.some(issue => issue.code === code);

    const luminance = readability?.metadata?.brightness;

    const insufficientLighting =
      (
        brightness?.passed === false &&
        brightness.message === 'Too dark'
      ) ||
      hasIssue('too_dark') ||
      hasIssue('underexposed') ||
      hasIssue('blurry') ||
      (
        typeof luminance === 'number' &&
        luminance < this.autoTorchLuminanceThreshold &&
        (
          hasIssue('low_contrast') ||
          hasIssue('low_dynamic_range')
        )
      );

    const excessiveLighting =
      (
        brightness?.passed === false &&
        brightness.message === 'Too bright'
      ) ||
      hasIssue('too_bright') ||
      hasIssue('overexposed');

    // Avoid turning on the torch for blur, positioning,
    // or excessive glare alone.

    if (!insufficientLighting || excessiveLighting) {
      this.poorLightingSince = undefined;
      return;
    }

    const now = performance.now();

    this.poorLightingSince ??= now;

    const elapsed = now - this.poorLightingSince;

    const delay = Number.isFinite(this.autoTorchDelay)
      ? Math.max(0, this.autoTorchDelay)
      : 1500;

    if (elapsed < delay) return;

    this.poorLightingSince = undefined;

    try {
      await this.setTorch(true, 'automatic');

      if (this.autoTorchActivated) {
        this.dispatchEvent(
          new CustomEvent('auto-torch-activated', {
            bubbles: true,
            composed: true,
            detail: {
              reason: 'insufficient_lighting',
              durationMs: elapsed,
            },
          }),
        );
      }
    } catch (error) {
      // Don't repeatedly retry a failed hardware operation.

      this.autoTorchSuppressed = true;

      this.dispatchEvent(
        new CustomEvent('auto-torch-error', {
          bubbles: true,
          composed: true,
          detail: error,
        }),
      );
    }
  }

  async setTorch(
    enabled: boolean,
    source: TorchSource = 'manual',
  ): Promise<void> {
    if (source === 'manual') {
      // Manual control takes precedence over automation.

      this.autoTorchSuppressed = true;
      this.autoTorchActivated = false;
      this.poorLightingSince = undefined;
    }

    // Serialize torch operations so manual and automatic
    // requests cannot race against one another.

    const operation = this.torchOperation.then(async () => {
      await this.updateComplete;

      if (!this.isConnected) return;

      this.syncTorchState();

      // Recheck automatic activation after waiting for any
      // previous hardware operation to finish.

      if (
        source === 'automatic' &&
        enabled &&
        (
          !this.autoTorch ||
          this.autoTorchSuppressed ||
          !this.analysisEnabled ||
          this.capturing ||
          this.ready
        )
      ) {
        return;
      }

      if (!this.torchSupported) {
        if (enabled) {
          throw new Error('Torch is not supported');
        }

        return;
      }

      if (this.torchEnabled === enabled) return;

      this.torchChanging = true;

      // A lighting change invalidates the cached frame.

      this.invalidateAnalysis();

      try {
        await this.camera.setTorch(enabled);

        this.syncTorchState();

        if (
          source === 'automatic' &&
          enabled &&
          !this.autoTorchSuppressed
        ) {
          this.autoTorchActivated = this.torchEnabled;
        } else {
          this.autoTorchActivated = false;
        }

        await this.updateComplete;
      } finally {
        this.torchChanging = false;
      }
    });

    // A rejected operation must not permanently break
    // the torch operation queue.

    this.torchOperation = operation.catch(() => {});

    await operation;
  }

  async toggleTorch(): Promise<void> {
    await this.setTorch(!this.torchEnabled, 'manual');
  }

  private async disableAutomaticTorch(): Promise<void> {
    if (!this.autoTorchActivated) return;

    try {
      await this.setTorch(false, 'automatic');
    } catch (error) {
      this.dispatchEvent(
        new CustomEvent('auto-torch-error', {
          bubbles: true,
          composed: true,
          detail: error,
        }),
      );
    }
  }

  // --------------------------------------------------
  // Bounding box geometry
  // --------------------------------------------------

  /**
   * Bounding box relative to the visible preview.
   * Coordinates are CSS pixels.
   */
  getPreviewBoundingBox(): Rectangle | undefined {
    if (!this.guide || !this.stage) return undefined;

    const stage = this.stage.getBoundingClientRect();
    const guide = this.guide.getBoundingClientRect();

    return {
      x: guide.x - stage.x,
      y: guide.y - stage.y,
      width: guide.width,
      height: guide.height,
    };
  }

  /**
   * Maps the visible guide into image pixel coordinates.
   */
  getImageBoundingBox(
    imageWidth: number,
    imageHeight: number,
  ): Rectangle | undefined {
    const box = this.getPreviewBoundingBox();

    if (!box) return undefined;

    const stage = this.stage.getBoundingClientRect();

    if (!stage.width || !stage.height) {
      return undefined;
    }

    return mapPreviewToImage(
      box,
      stage.width,
      stage.height,
      imageWidth,
      imageHeight,
    );
  }

  // --------------------------------------------------
  // Live analysis
  // --------------------------------------------------

  private async analyzeLoop(
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;

    const started = performance.now();

    try {
      if (
        this.analysisEnabled &&
        !this.capturing &&
        !this.torchChanging &&
        this.analyzers.length > 0 &&
        this.stage.clientWidth > 0 &&
        this.stage.clientHeight > 0
      ) {
        await this.analyzeFrame(signal);
      }
    } catch (error) {
      if (!signal.aborted) {
        this.invalidateAnalysis();
      }
    } finally {
      if (!signal.aborted) {
        const fps = Number.isFinite(this.analysisFPS)
          ? Math.max(1, Math.min(30, this.analysisFPS))
          : 5;

        const elapsed = performance.now() - started;

        this.timer = setTimeout(
          () => void this.analyzeLoop(signal),
          Math.max(0, 1000 / fps - elapsed),
        );
      }
    }
  }

  private async analyzeFrame(
    signal: AbortSignal,
  ): Promise<void> {
    const revision = this.revision;
    const analyzers = [...this.analyzers];

    const resolution = Number.isFinite(this.analysisResolution)
      ? Math.max(1, this.analysisResolution)
      : 640;

    const timestamp = performance.now();

    const bitmap = await this.camera.getFullResolutionFrame();

    let analysisBitmap: ImageBitmap | undefined;
    let retained = false;

    try {
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

      if (revision !== this.revision) return;

      const report = await this.pipeline.analyze(
        {
          bitmap: analysisBitmap,
          timestamp,

          sourceWidth: bitmap.width,
          sourceHeight: bitmap.height,

          boundingBox: this.getImageBoundingBox(
            analysisBitmap.width,
            analysisBitmap.height,
          ),

          signal,
        },
        analyzers,
      );

      if (
        signal.aborted ||
        revision !== this.revision ||
        this.capturing ||
        this.torchChanging ||
        !this.analysisEnabled
      ) {
        return;
      }

      // Only replace the cached frame when analysis passes.

      if (
        report.ready &&
        performance.now() - timestamp < this.captureCacheDuration
      ) {
        this.releaseAnalyzedFrame();

        this.analyzedFrame = {
          bitmap,
          analysis: report,

          analysisWidth: analysisBitmap.width,
          analysisHeight: analysisBitmap.height,

          boundingBox: this.getImageBoundingBox(
            bitmap.width,
            bitmap.height,
          ),

          timestamp,
        };

        retained = true;

        this.scheduleCacheExpiry();
      }

      // Failed analysis does not destroy an existing
      // valid cached frame.

      this.analysis = report;
      this.ready = this.hasValidCachedFrame();

      this.dispatchEvent(
        new CustomEvent<AnalysisReport>('analysis', {
          detail: report,
          bubbles: true,
          composed: true,
        }),
      );

      // Evaluate lighting after publishing the report.

      if (
        !signal.aborted &&
        revision === this.revision &&
        !this.capturing
      ) {
        await this.evaluateAutoTorch(report);
      }
    } finally {
      analysisBitmap?.close();

      if (!retained) {
        bitmap.close();
      }
    }
  }

  // --------------------------------------------------
  // Capture cache
  // --------------------------------------------------

  private hasValidCachedFrame(): boolean {
    return !!this.analyzedFrame &&
      performance.now() - this.analyzedFrame.timestamp
        < this.captureCacheDuration;
  }

  private scheduleCacheExpiry(): void {
    clearTimeout(this.cacheExpiryTimer);

    if (!this.analyzedFrame) return;

    const remaining = Math.max(
      0,
      this.captureCacheDuration -
        (performance.now() - this.analyzedFrame.timestamp),
    );

    this.cacheExpiryTimer = setTimeout(() => {
      this.releaseAnalyzedFrame();
      this.ready = false;
    }, remaining);
  }

  private releaseAnalyzedFrame(): void {
    clearTimeout(this.cacheExpiryTimer);

    this.cacheExpiryTimer = undefined;

    this.analyzedFrame?.bitmap.close();
    this.analyzedFrame = undefined;
  }

  // --------------------------------------------------
  // Camera lifecycle
  // --------------------------------------------------

  async start(): Promise<void> {
    await this.updateComplete;

    this.invalidateAnalysis();
    this.resetAutoTorch();

    this.autoTorchActivated = false;

    await this.camera.start();

    this.syncTorchState();
  }

  stop(): void {
    this.camera?.stop();

    this.autoTorchActivated = false;
    this.torchEnabled = false;
    this.torchSupported = false;

    this.resetAutoTorch();
    this.invalidateAnalysis();
  }

  // --------------------------------------------------
  // Image capture
  // --------------------------------------------------
  async capture(): Promise<Blob> {
    const result = await this.captureInternal(false);
    return result.processed;
  }

  async captureDetailed(): Promise<DetailedCaptureResult> {
    const result = await this.captureInternal(true);

    if (!result.boundingBox) {
      throw new Error('Bounding box image unavailable');
    }

    return {
      processed: result.processed,
      boundingBox: result.boundingBox,
      analysis: result.analysis,
      timestamp: result.timestamp,
    };
  }

  private async captureInternal(
    includeBoundingBox: boolean,
  ): Promise<{
    processed: Blob;
    boundingBox?: Blob;
    analysis?: AnalysisReport;
    timestamp: number;
  }> {
    if (this.capturing) {
      throw new Error('Capture already in progress');
    }

    if (this.torchChanging) {
      throw new Error('Camera lighting is adjusting');
    }

    const processor = this.captureProcessor;
    const boundingBoxProcessor = this.boundingBoxProcessor;

    if (processor && !this.hasValidCachedFrame()) {
      this.releaseAnalyzedFrame();
      this.ready = false;

      throw new Error('No recent validated frame available');
    }

    this.capturing = true;

    // Transfer ownership of the cached frame.

    let frame = this.hasValidCachedFrame()
      ? this.analyzedFrame
      : undefined;

    if (frame) {
      this.analyzedFrame = undefined;
    }

    this.invalidateAnalysis();

    try {
      let processed: Blob;
      let boundingBox: Blob | undefined;

      if (!processor && !includeBoundingBox) {
        // Preserve the existing unprocessed capture behavior.

        const timestamp = performance.now();

        processed = await this.camera.capture();

        await this.disableAutomaticTorch();

        this.autoTorchSuppressed = true;

        return {
          processed,
          timestamp,
        };
      }

      // If no processor requires a validated frame, allow
      // capturing a fresh frame when there is no valid cache.

      if (!frame) {
        if (processor) {
          throw new Error('No validated frame available');
        }

        const timestamp = performance.now();

        const bitmap =
          await this.camera.getFullResolutionFrame();

        frame = {
          bitmap,
          analysis: undefined,
          analysisWidth: bitmap.width,
          analysisHeight: bitmap.height,
          boundingBox: undefined,
          timestamp,
        };

        frame.boundingBox = this.getImageBoundingBox(
          bitmap.width,
          bitmap.height,
        );
      }

      // Generate both images before releasing the bitmap.

      if (includeBoundingBox) {
        boundingBox = await boundingBoxProcessor.process(frame);
      }

      if (processor) {
        processed = await processor.process(frame);
      } else {
        processed = boundingBox ??
          await boundingBoxProcessor.process(frame);
      }

      await this.disableAutomaticTorch();

      this.autoTorchSuppressed = true;

      return {
        processed,
        boundingBox,
        analysis: frame.analysis,
        timestamp: frame.timestamp,
      };
    } finally {
      frame?.bitmap.close();

      this.capturing = false;
    }
  }

  // --------------------------------------------------
  // Rendering
  // --------------------------------------------------

  private renderBoundingBox() {
    const box = this.boundingBox;

    if (!box) return nothing;

    const aspectRatio = box.aspectRatio;

    if (
      !Number.isFinite(aspectRatio) ||
      aspectRatio <= 0
    ) return nothing;

    const width = Math.min(
      1,
      Math.max(0, box.width ?? 0.85),
    );

    const maxHeight = Math.min(
      1,
      Math.max(0, box.maxHeight ?? 0.8),
    );

    const opacity = Math.min(
      1,
      Math.max(0, box.maskOpacity ?? 0.6),
    );

    return html`
      <div
        class="bounding-box"
        part="bounding-box"
        style=${styleMap({
          width: `min(
            ${width * 100}%,
            ${maxHeight * 100 * aspectRatio}cqh
          )`,

          aspectRatio: String(aspectRatio),

          borderRadius: `${box.borderRadius ?? 12}px`,
          borderWidth: `${box.borderWidth ?? 2}px`,
          borderStyle: 'solid',

          borderColor: this.ready
            ? '#22c55e'
            : box.borderColor ?? 'white',

          '--mask-color': `rgba(0, 0, 0, ${opacity})`,
        })}
      ></div>
    `;
  }

  render() {
    return html`
      <div class="stage" part="stage">
        <image-capture
          .facingMode=${this.facingMode}
          part="camera"
          exportparts="video, preview"
        ></image-capture>

        ${this.renderBoundingBox()}

        <div class="overlay" part="overlay">
          <slot name="overlay"></slot>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'guided-capture': GuidedCapture;
  }
}
