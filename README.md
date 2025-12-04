# Dynamic Imports Vite Plugin

A Vite/Rollup plugin that transforms dynamic and static imports in built chunks to use a runtime-configurable base path. Useful when widget assets are hosted under per-widget URLs and need to resolve chunk paths at runtime (e.g., window['resourceBasePath-{{widget.wid}}']).

Features:
- Rewrites import("./file.chunk.js") in entry chunks to prefix with a runtime base path.
- Rewrites `from "./main.js"` inside chunk files to a templated URL for widget manager delivery.
- SSR-safe window access using typeof guards.
- Optional source map regeneration via MagicString.
- Fully configurable via options.

## Installation

Install as a dev dependency alongside Vite:

```bash
npm install -D @dynamic-framework/dynamic-imports-vite-plugin
```

Peer dependency: vite ^7.2.6

## Quick Start

Add the plugin to your vite.config:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import transformDynamicImports from '@dynamic-framework/dynamic-imports-vite-plugin';

export default defineConfig({
  build: {
    // Ensure code-split chunks are produced
    rollupOptions: {
      // Your inputs/outputs as usual
    },
  },
  plugins: [
    transformDynamicImports({
      // optional configs shown below
    }),
  ],
});
```

## How it works

During generateBundle, the plugin scans built chunks and applies two transformations:
1) Entry chunks: `import("./file.chunk.js")` -> `import(((typeof window !== 'undefined' && window) ? window['resourceBasePath-{{widget.wid}}'] : '') + "file.chunk.js")`.
2) Chunk files: `from "./main.js"` -> `from "{{site.url}}/widget_manager/{{widget.wid}}/{{widget.version}}.js"`.

Both patterns respect single, double, or backtick quotes and whitespace. The default entry chunk detection uses Rollup's `chunk.isEntry`.

## Options

```ts
transformDynamicImports({
  // Builds window accessor for the runtime base path using the widget placeholder
  resourceBaseVar: (widPlaceholder) => `window['resourceBasePath-${widPlaceholder}']`,

  // Predicate to determine whether a chunk is treated as an entry (default: chunk.isEntry)
  entryNamePredicate: (chunk) => chunk.isEntry ?? false,

  // Regenerate source maps for transformed chunks
  enableSourceMap: false,

  // Placeholder inserted into resourceBaseVar
  widgetPlaceholder: '{{widget.wid}}',

  // Pattern to match code-split chunks (used in dynamic import detection)
  chunkFilePattern: '.chunk.js',

  // The entry file name referred by chunk files' static imports
  entryFileName: 'main.js',

  // URL template to replace static imports from main.js inside chunk files
  staticImportUrlTemplate: '{{site.url}}/widget_manager/{{widget.wid}}/{{widget.version}}.js',
});
```

## Simple Example

Assume your app produces an entry chunk containing:

```js
// in entry chunk
import('./users.chunk.js');
```

At runtime, define a global base path (e.g., per widget):

```html
<script>
  window['resourceBasePath-{{widget.wid}}'] = 'https://cdn.example.com/widgets/123/';
</script>
```

The plugin turns the import into:

```js
import(((typeof window !== 'undefined' && window) ? window['resourceBasePath-{{widget.wid}}'] : '') + 'users.chunk.js');
```

## Practical Use Cases

- Multi-tenant widgets: Serve chunks from tenant-specific base URLs or widget versions.
- CMS-delivered widgets: Main file resolved via `{{site.url}}/widget_manager/...` while chunks load from runtime base.
- SSR-capable builds: The plugin wraps `window` access with a typeof guard to avoid SSR crashes.

## Requirements and Considerations

- Code-splitting: Ensure Vite/Rollup generates chunk files (e.g., dynamic imports present and chunkFilePattern matches your chunk naming).
- Chunk naming: Default matcher expects names ending with `.chunk.js`. If your output differs (e.g., `-abc123.js`), adjust `chunkFilePattern`.
- Entry detection: Defaults to `chunk.isEntry`. If your build produces multiple entries or non-standard entries, provide `entryNamePredicate`.
- Global variable: You must set the runtime base path variable before the entry chunk executes. By default: `window['resourceBasePath-{{widget.wid}}']`.
- Static import rewrite: Only affects chunk files containing `from "./main.js"`. If your main file name or path differs, update `entryFileName`.
- Security: If the global base can be user-influenced, consider sanitization, path normalization, and CSP to prevent traversal/injection. The plugin includes a TODO comment for hardening.
- Source maps: Set `enableSourceMap: true` if you need maps after transformation.
- SSR: The transform uses `typeof window !== 'undefined'` to avoid errors, but on server-side it will prefix with an empty string, so dynamic chunk loading paths resolve to just the file name.

## Testing

Run unit tests (if present):

```bash
npm run test
```

## Build

```bash
npm run build
```

This produces the transformed plugin in `dist/` with types.

## License

MIT
