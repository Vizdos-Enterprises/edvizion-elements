# Image Capture

A lightweight, framework-agnostic camera capture and guided image analysis library built with Lit and TypeScript.

## Features

- Native, real-time camera preview
- Full video-resolution image capture
- Front and rear camera selection
- Torch control
- Automatic camera lifecycle management
- Configurable bounding boxes and overlay masks
- Pluggable image analysis pipelines
- Real-time capture readiness feedback
- Customizable styling through CSS parts
- Native ESM and TypeScript declarations

## Installation

```bash
npm install image-capture
```

## Image Capture

`<image-capture>` provides a low-level camera abstraction without imposing any application-specific capture requirements.

```html
<image-capture facing-mode="environment"></image-capture>
<button id="capture">Capture</button>

<script type="module">
  import 'image-capture';

  const camera = document.querySelector('image-capture');

  document.querySelector('#capture').onclick = async () => {
    const photo = await camera.capture();
    console.log(photo);
  };
</script>
```

### Properties

| Property | Attribute | Type | Default |
|---|---|---|---|
| `facingMode` | `facing-mode` | `'user' \| 'environment'` | `'environment'` |
| `capturing` | `capturing` | `boolean` | `false` |
| `torchSupported` | `torch-supported` | `boolean` | `false` |
| `torchEnabled` | `torch-enabled` | `boolean` | `false` |

### Methods

| Method | Return Type | Description |
|---|---|---|
| `start()` | `Promise<void>` | Starts the camera |
| `stop()` | `void` | Releases the camera stream |
| `capture()` | `Promise<Blob>` | Captures a full-resolution JPEG |
| `getFrame(maxDimension?)` | `Promise<Frame>` | Extracts a downscaled analysis frame |
| `setTorch(enabled)` | `Promise<void>` | Enables or disables the torch |
| `toggleTorch()` | `Promise<void>` | Toggles the torch |

### Torch Control

```ts
if (camera.torchSupported) {
  await camera.setTorch(true);
  await camera.toggleTorch();
}
```

Torch availability depends on the device, camera, and browser.

### Capture State

The `capturing` property reflects to an HTML attribute, allowing CSS-driven loading indicators.

```css
body:has(image-capture[capturing]) .loading {
  display: block;
}
```

## Guided Capture

`<guided-capture>` extends the camera experience through configurable bounding boxes and composable image analyzers.

It is suitable for:

- Identity documents
- Passports
- Student headshots
- Receipts
- Proof of residency documents
- General document scanning

```html
<guided-capture
  analysis-fps="5"
  analysis-resolution="640"
></guided-capture>

<script type="module">
  import { BrightnessAnalyzer } from 'image-capture';

  const camera = document.querySelector('guided-capture');

  camera.boundingBox = {
    aspectRatio: 85.6 / 53.98,
    width: 0.85,
    maxHeight: 0.8,
    borderRadius: 12,
    maskOpacity: 0.65,
    borderWidth: 2,
    borderColor: 'white',
  };

  camera.analyzers = [
    new BrightnessAnalyzer(60, 220),
  ];

  camera.addEventListener('analysis', event => {
    console.log(event.detail);
  });
</script>
```

### Bounding Box

The bounding box provides a visual guide and defines a region of interest for image analyzers.

```ts
interface BoundingBox {
  aspectRatio: number;
  width?: number;
  maxHeight?: number;
  borderRadius?: number;
  maskOpacity?: number;
  borderColor?: string;
  borderWidth?: number;
}
```

| Property | Default | Description |
|---|---|---|
| `aspectRatio` | Required | Width divided by height |
| `width` | `0.85` | Fraction of available preview width |
| `maxHeight` | `0.8` | Maximum fraction of preview height |
| `borderRadius` | `12` | Corner radius in pixels |
| `maskOpacity` | `0.6` | Opacity outside the bounding box |
| `borderColor` | `'white'` | Default border color |
| `borderWidth` | `2` | Border thickness in pixels |

The bounding box automatically turns green when all configured analyzers pass.

Bounding boxes do not modify or crop the captured image.

### Example Bounding Boxes

#### Identification Card

```ts
camera.boundingBox = {
  aspectRatio: 85.6 / 53.98,
  width: 0.85,
};
```

#### Headshot

```ts
camera.boundingBox = {
  aspectRatio: 3 / 4,
  width: 0.8,
  borderRadius: 24,
};
```

#### US Letter Document

```ts
camera.boundingBox = {
  aspectRatio: 8.5 / 11,
  width: 0.9,
};
```

### Properties

Guided Capture exposes the camera properties alongside the following:

| Property | Type | Default |
|---|---|---|
| `boundingBox` | `BoundingBox \| undefined` | `undefined` |
| `analyzers` | `Analyzer[]` | `[]` |
| `analysisFPS` | `number` | `5` |
| `analysisResolution` | `number` | `640` |
| `analysisEnabled` | `boolean` | `true` |
| `analysis` | `AnalysisReport \| undefined` | `undefined` |
| `ready` | `boolean` | `false` |

The `ready`, `capturing`, `torchSupported`, and `torchEnabled`
properties reflect to HTML attributes.

### Methods

| Method | Description |
|---|---|
| `start()` | Starts the underlying camera |
| `stop()` | Stops the underlying camera |
| `capture()` | Captures a full-resolution JPEG |
| `setTorch(enabled)` | Controls the torch |
| `toggleTorch()` | Toggles the torch |
| `getPreviewBoundingBox()` | Returns bounding box coordinates in CSS pixels |
| `getImageBoundingBox(width, height)` | Maps the bounding box to image pixels |

## Image Analyzers

Analyzers are independent, composable implementations that evaluate
camera frames.

The analysis pipeline is independent of the camera's capture resolution.

### Analyzer Interface

```ts
interface Analyzer {
  readonly id: string;

  analyze(
    frame: AnalysisFrame
  ): AnalysisResult | Promise<AnalysisResult>;
}
```

### Analysis Frame

```ts
interface AnalysisFrame {
  bitmap: ImageBitmap;
  timestamp: number;
  boundingBox?: Rectangle;
  sourceWidth: number;
  sourceHeight: number;
  signal: AbortSignal;
}
```

The bounding box is expressed in the analysis bitmap's pixel
coordinates, accounting for the preview's cropping.

The pipeline owns the bitmap lifecycle. Analyzers should not close
or retain the bitmap after analysis completes.

### Analysis Result

```ts
interface AnalysisResult {
  passed: boolean;
  score?: number;
  message?: string;
  metadata?: Record<string, unknown>;
}
```

### Custom Analyzer

```ts
import type {
  Analyzer,
  AnalysisFrame,
  AnalysisResult,
} from 'image-capture';

export class ResolutionAnalyzer implements Analyzer {
  readonly id = 'resolution';

  analyze(frame: AnalysisFrame): AnalysisResult {
    const passed = frame.sourceWidth >= 1080;

    return {
      passed,
      message: passed ? undefined : 'Resolution too low',
      metadata: {
        width: frame.sourceWidth,
        height: frame.sourceHeight,
      },
    };
  }
}
```

Register the analyzer alongside other analyzers:

```ts
camera.analyzers = [
  new BrightnessAnalyzer(),
  new ResolutionAnalyzer(),
];
```

Analyzers may be synchronous or asynchronous and can integrate
with computer vision libraries or machine learning models.

Analyzer IDs should be unique.

### Built-in Analyzers

#### BrightnessAnalyzer

Evaluates average image brightness within the configured bounding
box, or the entire frame if no bounding box is configured.

```ts
new BrightnessAnalyzer(
  60,  // Minimum brightness
  220, // Maximum brightness
);
```

Brightness values range from 0 to 255.

This analyzer is a basic lighting heuristic, not a comprehensive
image quality assessment.

## Analysis Events

Guided Capture emits an `analysis` event after completing each
analysis cycle.

```ts
camera.addEventListener('analysis', event => {
  const { ready, results } = event.detail;

  console.log('Ready:', ready);
  console.log('Results:', results);
});
```

Example payload:

```json
{
  "ready": false,
  "timestamp": 1245.82,
  "results": {
    "brightness": {
      "passed": false,
      "score": 0.18,
      "message": "Too dark",
      "metadata": {
        "brightness": 46
      }
    }
  }
}
```

Analysis results are advisory. Applications decide whether to
disable capture, display warnings, or automatically capture.

Passing live analysis does not guarantee that the final captured
image will pass verification.

## Capture and Recapture

The camera can remain active while reviewing a captured image,
allowing instant recapture without restarting the camera stream.

```ts
const photo = await camera.capture();

camera.analysisEnabled = false;

// Display captured photo.

// When the user chooses to recapture:
camera.analysisEnabled = true;

// When the capture workflow is finished:
camera.stop();
```

Keeping the camera active during review consumes power and keeps
the device's camera privacy indicator active.

## Styling

Both components expose CSS parts for external customization.

### Image Capture

| Part | Description |
|---|---|
| `preview` | Preview container |
| `video` | Native video element |

### Guided Capture

| Part | Description |
|---|---|
| `stage` | Main preview container |
| `camera` | Underlying camera component |
| `preview` | Camera preview container |
| `video` | Native video element |
| `bounding-box` | Bounding box overlay |
| `overlay` | Custom overlay container |

### Fullscreen Preview

```css
guided-capture {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
}

guided-capture::part(video) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
```

For mobile safe-area support:

```html
<meta
  name="viewport"
  content="width=device-width, initial-scale=1, viewport-fit=cover"
>
```

Interactive controls should account for safe-area insets
independently of the camera preview.

### Custom Overlays

```html
<guided-capture>
  <div slot="overlay">
    Position your document inside the frame
  </div>
</guided-capture>
```

## Performance

The library separates preview rendering, image analysis, and
full-resolution capture.

- The live preview uses a native video element.
- Analysis frames are downscaled before processing.
- Analyzers share a single bitmap per analysis cycle.
- Analysis cycles do not overlap within the active analysis loop.
- Full-resolution captures use the video's intrinsic dimensions.
- Canvas processing occurs during frame extraction and capture,
  rather than continuously rendering the preview.

Analysis resolution and frequency can be adjusted independently:

```ts
camera.analysisFPS = 5;
camera.analysisResolution = 640;
```

Actual analysis frequency depends on analyzer execution time
and device performance.

## Browser Requirements

- Secure context (HTTPS or localhost)
- MediaDevices and `getUserMedia()`
- Custom Elements
- Shadow DOM
- Canvas API
- ImageBitmap support for guided analysis

Camera resolution and torch availability vary by browser and device.

Image capture uses video-frame extraction rather than the native
ImageCapture API to maintain consistent framing between the
live preview and captured image.

## Privacy

Camera frames and captured images are processed locally within
the browser by the core library and built-in analyzers.

The library does not upload captured images or make network
requests containing camera data.

Third-party analyzers may have their own privacy implications.

Applications are responsible for securely handling, transmitting,
and storing captured images.

## Development

```bash
npm run dev
```

### Production Build

```bash
npm run build
```

### Type Checking

```bash
npx tsc --noEmit
```

The production build generates native ES modules and TypeScript
declarations in `dist/`.
