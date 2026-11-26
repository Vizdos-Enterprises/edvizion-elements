# @edvizion/elements

A shared collection of reusable web components for the Edvizion platform, built with Lit and TypeScript.

## Available Components

### Image Capture

Provides low-level camera capture primitives (`<image-capture>`) and higher-level guided capture functionality (`<guided-capture>`), including configurable bounding boxes, pluggable image analyzers, and torch control.

```ts
import {
  ImageCapture,
  GuidedCapture,
} from '@edvizion/elements/image-capture';
```

To register the components without importing their classes:

```ts
import '@edvizion/elements/image-capture';
```

[Documentation](./src/image-capture/README.md)
