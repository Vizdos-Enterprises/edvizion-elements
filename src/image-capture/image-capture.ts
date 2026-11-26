import { LitElement, html, css } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';

type TorchCapabilities = MediaTrackCapabilities & {
  torch?: boolean;
};

type TorchConstraints = MediaTrackConstraintSet & {
  torch?: boolean;
};

type TorchSettings = MediaTrackSettings & {
  torch?: boolean;
};

@customElement('image-capture')
export class ImageCapture extends LitElement {
  @property({ type: String, attribute: 'facing-mode' })
  accessor facingMode: 'user' | 'environment' = 'environment';

  @property({ type: Boolean, reflect: true })
  accessor capturing = false;

  @property({ type: Boolean, reflect: true, attribute: 'torch-supported' })
  accessor torchSupported = false;

  @property({ type: Boolean, reflect: true, attribute: 'torch-enabled' })
  accessor torchEnabled = false;

  @query('video')
  private accessor video!: HTMLVideoElement;

  @state()
  private accessor videoResolution = 'Waiting for camera…';

  private stream?: MediaStream;
  private generation = 0;

  static styles = css`
    :host {
      display: block;
    }

    .preview {
      position: relative;
      overflow: hidden;
    }

    video {
      display: block;
      width: 100%;
      height: auto;
    }

    .debug {
      position: absolute;
      top: 16px;
      left: 16px;
      z-index: 10;
      background: rgba(0, 0, 0, 0.75);
      color: white;
      padding: 8px 12px;
      border-radius: 6px;
      font: 14px monospace;
      pointer-events: none;
    }
  `;

  private updateResolution(): void {
    this.videoResolution =
      `${this.video.videoWidth} × ${this.video.videoHeight}`;
  }

  connectedCallback() {
    super.connectedCallback();

    void this.updateComplete.then(async () => {
      if (this.isConnected) {
        await this.start();
      }
    }).catch(error => {
      this.dispatchEvent(new CustomEvent('camera-error', {
        detail: error,
        bubbles: true,
        composed: true,
      }));
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stop();
  }

  async start(): Promise<void> {
    await this.updateComplete;

    this.stop();

    const generation = this.generation;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: this.facingMode },
        width: { ideal: 4096 },
        height: { ideal: 3072 },
      },
    });

    if (!this.isConnected || generation !== this.generation) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    this.stream = stream;
    this.video.srcObject = stream;

    await this.video.play();

    if (generation !== this.generation) return;

    const track = stream.getVideoTracks()[0];

    const capabilities = track.getCapabilities() as TorchCapabilities;
    const settings = track.getSettings() as TorchSettings;

    this.torchSupported = capabilities.torch === true;
    this.torchEnabled = settings.torch === true;
  }

  stop(): void {
    this.generation++;

    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = undefined;

    this.torchSupported = false;
    this.torchEnabled = false;
    this.videoResolution = 'Waiting for camera…';

    if (this.video) {
      this.video.srcObject = null;
    }
  }

  async setTorch(enabled: boolean): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];

    if (!track || track.readyState !== 'live') {
      throw new Error('Camera is not active');
    }

    if (!this.torchSupported) {
      throw new Error('Torch is not supported');
    }

    const generation = this.generation;

    const constraints = track.getConstraints();

    const torch: TorchConstraints = {
      torch: enabled,
    };

    await track.applyConstraints({
      ...constraints,
      advanced: [
        ...(constraints.advanced ?? []).map(constraint => {
          const { torch: _, ...rest } = constraint as TorchConstraints;
          return rest;
        }),
        torch,
      ],
    });

    if (generation !== this.generation) return;

    const settings = track.getSettings() as TorchSettings;

    this.torchEnabled = settings.torch ?? enabled;
  }

  async toggleTorch(): Promise<void> {
    await this.setTorch(!this.torchEnabled);
  }

  async getFrame(maxDimension = 640): Promise<{
    bitmap: ImageBitmap;
    sourceWidth: number;
    sourceHeight: number;
    timestamp: number;
  }> {
    const track = this.stream?.getVideoTracks()[0];

    const sourceWidth = this.video.videoWidth;
    const sourceHeight = this.video.videoHeight;

    if (
      !track ||
      track.readyState !== 'live' ||
      this.video.readyState < 2 ||
      !sourceWidth ||
      !sourceHeight
    ) {
      throw new Error('Camera frame is not ready');
    }

    const scale = Math.min(
      1,
      maxDimension / Math.max(sourceWidth, sourceHeight),
    );

    const canvas = document.createElement('canvas');

    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));

    const ctx = canvas.getContext('2d');

    if (!ctx) {
      throw new Error('Could not create canvas context');
    }

    const timestamp = performance.now();

    ctx.drawImage(
      this.video,
      0,
      0,
      canvas.width,
      canvas.height,
    );

    return {
      bitmap: await createImageBitmap(canvas),
      sourceWidth,
      sourceHeight,
      timestamp,
    };
  }

  async capture(): Promise<Blob> {
    if (this.capturing) {
      throw new Error('Capture already in progress');
    }

    const track = this.stream?.getVideoTracks()[0];

    if (!track || track.readyState !== 'live') {
      throw new Error('Camera is not active');
    }

    this.capturing = true;

    try {
      return await this.captureFrame();
    } finally {
      this.capturing = false;
    }
  }

  private async captureFrame(): Promise<Blob> {
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;

    if (!width || !height) {
      throw new Error('Camera frame is not ready');
    }

    const canvas = document.createElement('canvas');

    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');

    if (!ctx) {
      throw new Error('Could not create canvas context');
    }

    ctx.drawImage(this.video, 0, 0, width, height);

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        blob => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to encode image'));
          }
        },
        'image/jpeg',
        0.98,
      );
    });
  }

  render() {
    return html`
      <div class="preview" part="preview">
        <video
          autoplay
          muted
          playsinline
          part="video"
          @loadedmetadata=${this.updateResolution}
          @resize=${this.updateResolution}
        ></video>

        <div class="debug">
          Video: ${this.videoResolution}<br>
          Torch supported: ${this.torchSupported}<br>
          Torch enabled: ${this.torchEnabled}
        </div>

        <slot name="overlay"></slot>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'image-capture': ImageCapture;
  }
}
