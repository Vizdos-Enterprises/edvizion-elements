import { LitElement, html, css, nothing } from 'lit';
import {
  customElement,
  property,
  query,
} from 'lit/decorators.js';

import { styleMap } from 'lit/directives/style-map.js';

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
} from './analysis/types.js';

@customElement('guided-capture')
export class GuidedCapture extends LitElement {
  @property({ type: String, attribute: 'facing-mode' })
  accessor facingMode: 'user' | 'environment' = 'environment';

  @property({ attribute: false })
  accessor boundingBox: BoundingBox | undefined = undefined;;

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

  private pipeline = new AnalysisPipeline();

  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private observer?: MutationObserver;
  private resizeObserver?: ResizeObserver;

  private analyzedFrame?: {
    bitmap: ImageBitmap;
    analysis: AnalysisReport;
    analysisWidth: number;
    analysisHeight: number;
    boundingBox?: Rectangle;
  };

  private revision = 0;

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

    this.invalidateAnalysis();
  }

  protected updated(
    changed: Map<PropertyKey, unknown>,
  ): void {
    if (
      changed.has('analyzers') ||
      changed.has('boundingBox') ||
      changed.has('analysisResolution') ||
      changed.has('analysisEnabled')
    ) {
      this.invalidateAnalysis();
    }
  }

  private invalidateAnalysis(): void {
    this.revision++;
    this.ready = false;
    this.analysis = undefined;

    this.releaseAnalyzedFrame();
  }

  private observeGeometry(): void {
    this.resizeObserver = new ResizeObserver(() => {
      this.invalidateAnalysis();
    });

    this.resizeObserver.observe(this.stage);
  }

  private observeCamera(): void {
    const sync = () => {
      this.torchSupported = this.camera.torchSupported;
      this.torchEnabled = this.camera.torchEnabled;
    };

    this.observer = new MutationObserver(sync);

    this.observer.observe(this.camera, {
      attributes: true,
      attributeFilter: [
        'capturing',
        'torch-supported',
        'torch-enabled',
      ],
    });

    sync();
  }

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

  private async analyzeLoop(
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;

    const started = performance.now();

    try {
      if (
        this.analysisEnabled &&
        !this.capturing &&
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

  private async analyzeFrame(signal: AbortSignal): Promise<void> {
    const revision = this.revision;
    const analyzers = [...this.analyzers];

    const resolution = Number.isFinite(this.analysisResolution)
      ? Math.max(1, this.analysisResolution)
      : 640;

    const bitmap = await this.camera.getFullResolutionFrame();

    let analysisBitmap: ImageBitmap | undefined;
    let retained = false;

    try {
      const scale = Math.min(
        1,
        resolution / Math.max(bitmap.width, bitmap.height),
      );

      analysisBitmap = await createImageBitmap(bitmap, {
        resizeWidth: Math.max(1, Math.round(bitmap.width * scale)),
        resizeHeight: Math.max(1, Math.round(bitmap.height * scale)),
        resizeQuality: 'medium',
      });

      signal.throwIfAborted();

      if (revision !== this.revision) return;

      const report = await this.pipeline.analyze(
        {
          bitmap: analysisBitmap,
          timestamp: performance.now(),
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
        !this.analysisEnabled
      ) {
        return;
      }

      this.releaseAnalyzedFrame();

      if (report.ready) {
        this.analyzedFrame = {
          bitmap,
          analysis: report,
          analysisWidth: analysisBitmap.width,
          analysisHeight: analysisBitmap.height,
          boundingBox: this.getImageBoundingBox(
            bitmap.width,
            bitmap.height,
          ),
        };

        retained = true;
      }

      this.analysis = report;
      this.ready = report.ready;

      this.dispatchEvent(
        new CustomEvent<AnalysisReport>('analysis', {
          detail: report,
          bubbles: true,
          composed: true,
        }),
      );
    } finally {
      analysisBitmap?.close();

      if (!retained) {
        bitmap.close();
      }
    }
  }

  private releaseAnalyzedFrame(): void {
    this.analyzedFrame?.bitmap.close();
    this.analyzedFrame = undefined;
  }

  async start(): Promise<void> {
    await this.updateComplete;

    this.invalidateAnalysis();

    await this.camera.start();
  }

  stop(): void {
    this.camera?.stop();
    this.invalidateAnalysis();
  }

  async capture(): Promise<Blob> {
    if (this.capturing) {
      throw new Error('Capture already in progress');
    }

    const processor = this.captureProcessor;

    if (processor && !this.analyzedFrame) {
      throw new Error('No validated frame available');
    }

    this.capturing = true;

    // Transfer ownership before invalidating analysis.
    const frame = this.analyzedFrame;
    this.analyzedFrame = undefined;

    this.invalidateAnalysis();

    try {
      if (!processor) {
        return await this.camera.capture();
      }

      if (!frame) {
        throw new Error('No validated frame available');
      }

      return await processor.process(frame);
    } finally {
      frame?.bitmap.close();
      this.capturing = false;
    }
  }

  async setTorch(enabled: boolean): Promise<void> {
    await this.camera.setTorch(enabled);
  }

  async toggleTorch(): Promise<void> {
    await this.camera.toggleTorch();
  }

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
