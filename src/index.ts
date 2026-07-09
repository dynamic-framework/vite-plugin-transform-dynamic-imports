import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import MagicString from 'magic-string';
import type { OutputBundle, OutputChunk } from 'rollup';
import type { Plugin } from 'vite';
import type { TransformDynamicImportsOptions } from './types.js';
import { defaultResourceBaseVar, defaultEntryNamePredicate } from './utils.js';

/**
 * Vite plugin that transforms dynamic imports to use runtime-configurable base paths
 * 
 * This plugin addresses several issues with naive string-based import path rewriting:
 * - Robust regex patterns that handle single/double/backtick quotes and whitespace
 * - Entry chunk detection using chunk.isEntry rather than hardcoded filenames
 * - SSR-safe window access with typeof guards
 * - Optional source map preservation using MagicString
 * - Configurable resource base path variable names
 * - Logging and warnings for observability
 * 
 * @param options - Configuration options for the plugin
 * @returns A Rollup/Vite plugin
 */
export function transformDynamicImports(
  options: TransformDynamicImportsOptions = {}
): Plugin {
  const {
    resourceBaseVar = defaultResourceBaseVar,
    entryNamePredicate = defaultEntryNamePredicate,
    enableSourceMap = false,
    widgetPlaceholder = '{{widget.wid}}',
    // Kept for backward compatibility with existing configs. No longer used to detect
    // chunk files internally (see `isChunkFile` below) since relying on a filename
    // suffix is fragile: it silently breaks if the consuming project's Vite
    // `chunkFileNames` option changes or is removed.
    chunkFilePattern = '.chunk.js',
    entryFileName = 'main.js',
    staticImportUrlTemplate = '{{site.url}}/widget_manager/{{widget.wid}}/{{widget.version}}.js',
  } = options;
  // Referenced only to keep the destructured binding intentional (see comment above).
  void chunkFilePattern;

  // Captured from Vite's resolved config so Pattern 5 knows the exact literal prefix
  // Vite uses when emitting root-relative asset URLs (e.g. "/jaguar.avif"), which
  // depends on the `base` config option (defaults to '/').
  let resolvedBase = '/';

  return {
    name: 'transform-dynamic-imports',

    configResolved(config) {
      resolvedBase = config.base ?? '/';
    },

    // Vite's internal `vite:build-import-analysis` plugin resolves the `__VITE_PRELOAD__`
    // placeholder into the real `__vite__mapDeps` array inside its own `generateBundle`
    // hook. That internal plugin is appended to the plugin pipeline after all user
    // plugins (regardless of `enforce`), so our `generateBundle` hook would always run
    // too early and see the array before it's populated (Pattern 4 would have nothing
    // to filter). We use `writeBundle` instead, which runs strictly after every
    // `generateBundle` hook has completed, guaranteeing the deps array already contains
    // its final values. Since Rollup has already written the original files to disk by
    // the time `writeBundle` runs, we write the transformed content back out ourselves.
    writeBundle(outputOptions, bundle: OutputBundle) {
      let totalTransformations = 0;
      // Rollup/Vite normally set `outputOptions.dir` for code-split builds (which is the
      // only scenario where this plugin is useful, since dynamic-import/mapDeps rewriting
      // requires multiple emitted chunks). `outputOptions.file` (single-file output) is
      // mutually exclusive with code-splitting in Rollup, so it shouldn't occur in
      // practice here, but we fall back to its directory defensively rather than
      // silently no-op'ing.
      const outDir = outputOptions.dir ?? (outputOptions.file ? dirname(outputOptions.file) : undefined);
      if (!outDir) {
        this.warn(
          'transform-dynamic-imports: could not determine output directory ' +
          '(outputOptions.dir and outputOptions.file are both unset); skipping post-build transformations.'
        );
        return;
      }

      // ---- PASS 1: Collect entry-level file names (JS + CSS) ----
      // Chunks reference the entry's own JS file and CSS via __vite__mapDeps, but both
      // are already loaded on the page before any dynamic import runs (the entry JS/CSS
      // is injected directly into the HTML, renamed to a content hash at the Modyo root,
      // outside the widget's resource subfolder). These entries must be removed from
      // __vite__mapDeps arrays so the transformed assetsURL doesn't try to (re)fetch them
      // from the wrong location.
      const entryAssetFiles: Set<string> = new Set();
      for (const chunkOrAsset of Object.values(bundle)) {
        if (chunkOrAsset.type === 'chunk') {
          const c = chunkOrAsset as OutputChunk;
          if (c.isEntry) {
            entryAssetFiles.add(c.fileName);
            // viteMetadata is attached by Vite's internal build-metadata plugin
            const importedCss: string[] | undefined = (c as any).viteMetadata?.importedCss;
            if (importedCss) {
              for (const css of importedCss) {
                entryAssetFiles.add(css);
              }
            }
          }
        }
      }

      // ---- PASS 2: Collect statically-emitted asset file names (images, fonts, etc.) ----
      // Regular `import img from './img.png'` (as opposed to CSS/JS handled above) gets
      // compiled by Vite into a plain string constant like `const R = "/img-Hash.png"`,
      // hardcoded with the configured `base` (default '/') at build time. Unlike chunk
      // preload deps, this string is NOT routed through a runtime-configurable helper
      // like `assetsURL`, so it always resolves from the domain root — wrong for Modyo's
      // subfolder deployment. We rewrite these literals to use the resource base path too.
      const staticAssetFiles: Set<string> = new Set();
      for (const [assetFileName, chunkOrAsset] of Object.entries(bundle)) {
        if (chunkOrAsset.type === 'asset' && !assetFileName.endsWith('.css')) {
          staticAssetFiles.add(assetFileName);
        }
      }
      const escapedBase = resolvedBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Process each chunk in the bundle
      for (const [fileName, chunkOrAsset] of Object.entries(bundle)) {
        // Only process JavaScript chunks, not assets
        if (chunkOrAsset.type !== 'chunk') {
          continue;
        }

        const chunk = chunkOrAsset as OutputChunk;
        let transformCount = 0;
        const s = new MagicString(chunk.code);
        
        // Pattern 1: Transform dynamic imports in entry chunks
        // Only process entry chunks for dynamic import transformation
        if (entryNamePredicate(chunk)) {
          // Transform dynamic imports like import("./file-xyz123.js")
          // This regex handles:
          // - Single quotes, double quotes, or backticks
          // - Optional whitespace around the path
          // - Captures the quote type to ensure matching pairs
          // NOTE: we intentionally match ANY relative (`./...`) dynamic import ending in
          // `.js`, rather than requiring `chunkFilePattern` (e.g. `.chunk.js`) as a suffix.
          // Relying on a specific `chunkFileNames` naming convention is fragile: if the
          // consuming project's Vite config doesn't emit that suffix (or changes/removes
          // its `chunkFileNames` option), chunk files silently stop matching and the
          // plugin becomes a no-op, reintroducing the original bug. Every local relative
          // dynamic import in Rollup output is, by definition, a separate emitted chunk,
          // so no suffix-based filtering is actually needed here.
          const dynamicImportRegex = /import\(\s*([\x60'"])(\.\/[^\x60'"()]+?\.js)\1\s*\)/g;
          
          let match: RegExpExecArray | null;
          while ((match = dynamicImportRegex.exec(chunk.code)) !== null) {
            const fullMatch = match[0];
            const quote = match[1];
            const chunkPath = match[2];
            const chunkName = chunkPath.replace('./', '');
            
            // Generate SSR-safe replacement
            // Uses typeof guard to prevent window access in SSR contexts. When `window`
            // isn't available we fall back to the original relative specifier
            // (`./chunkName`) rather than a bare filename, since `import('foo.js')` is not
            // equivalent to `import('./foo.js')` and can fail to resolve relative to the
            // importing module.
            // TODO: Add sanitization/validation for resourceBasePath at runtime to prevent 
            // path traversal attacks if the global variable can be user-influenced.
            // Consider implementing: path normalization, allowlist checking, or CSP headers.
            const resourceBaseRef = resourceBaseVar(widgetPlaceholder);
            const replacement = `import((typeof window !== 'undefined' && window) ? (${resourceBaseRef} + ${quote}${chunkName}${quote}) : ${quote}${chunkPath}${quote})`;
            
            s.overwrite(match.index, match.index + fullMatch.length, replacement);
            transformCount++;
          }
        }

        // A "chunk file" here means any non-entry JS chunk emitted by Rollup/Vite, i.e.
        // a lazily-loaded code-split file. We rely on `chunk.isEntry` (structural data
        // Rollup always provides) rather than filename patterns like `chunkFilePattern`,
        // since custom `chunkFileNames` naming conventions in the consuming project's
        // Vite config can change or disappear independently of this plugin.
        const isChunkFile = !entryNamePredicate(chunk);

        // Pattern 2: Transform static imports from entry file in chunk files
        // Process all chunk files (not just entry) to transform imports from main.js
        if (isChunkFile) {
          // Matches: from "./main.js", from './main.js', from `./main.js`
          // Handles optional whitespace between 'from' and the quote
          // Escape special regex characters in entryFileName
          const escapedEntryFile = entryFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const staticImportRegex = new RegExp(
            `from\\s*([\\x60'\"])\\.\/${escapedEntryFile}\\1`,
            'g'
          );
          
          let match: RegExpExecArray | null;
          while ((match = staticImportRegex.exec(chunk.code)) !== null) {
            const fullMatch = match[0];
            const quote = match[1];
            
            // Replace with templated URL for widget versioning
            const replacement = `from ${quote}${staticImportUrlTemplate}${quote}`;
            
            s.overwrite(match.index, match.index + fullMatch.length, replacement);
            transformCount++;
          }
        }

        // Pattern 3: Transform assetsURL in entry chunks
        // Vite generates: assetsURL = function(B) { return "/" + B }
        // This function is used by __vitePreload to resolve asset paths in __vite__mapDeps.
        // In Modyo/other subfolder deployments, the "/" prefix resolves to the domain root
        // instead of the widget subfolder. We override it to use the resource base path.
        if (entryNamePredicate(chunk)) {
          const assetsURLRegex = /assetsURL\s*=\s*function\s*\(\s*(\w+)\s*\)\s*\{\s*return\s*"\/"\s*\+\s*\1\s*;?\s*\}/g;
          let assetsMatch: RegExpExecArray | null;
          while ((assetsMatch = assetsURLRegex.exec(chunk.code)) !== null) {
            const param = assetsMatch[1];
            const resourceBaseRef = resourceBaseVar(widgetPlaceholder);
            const replacement = `assetsURL = function(${param}) { return ((typeof window !== 'undefined' && window) ? ${resourceBaseRef} : '/') + ${param}; }`;
            s.overwrite(assetsMatch.index, assetsMatch.index + assetsMatch[0].length, replacement);
            transformCount++;
          }
        }

        // Pattern 4: Remove entry-level JS/CSS files from __vite__mapDeps arrays
        // Entry files (e.g. "main.js", "main.css") are already loaded on the page before
        // any chunk runs. After Pattern 3 transforms assetsURL to use resourceBasePath,
        // keeping them in the array would cause incorrect URL resolution/404s. We filter
        // them out entirely.
        //
        // IMPORTANT: removing entries shifts array indices. Every call site that indexes
        // into this array (e.g. `__vite__mapDeps([0,1,2])`) must have its indices remapped
        // to the new positions (and dropped if they pointed at a removed entry), otherwise
        // `d[i]` resolves to `undefined` for shifted/removed positions, producing bogus
        // "undefined" requests at runtime.
        if (entryAssetFiles.size > 0 && isChunkFile) {
          // Match the m.f initialization part of __vite__mapDeps:
          //   const __vite__mapDeps=(..., d=(m.f||(m.f=["a.css","b.css"])))=>...
          // Or multi-line variant:
          //   const __vite__mapDeps=(..., d=(m.f||(m.f=[
          //     "a.css",
          //     "b.css"
          //   ])))=>...
          const depsArrayRegex = /m\.f\s*\|\|\s*\(m\.f\s*=\s*(\[[\s\S]*?\])\s*\)/g;
          let depsMatch: RegExpExecArray | null;
          while ((depsMatch = depsArrayRegex.exec(chunk.code)) !== null) {
            const arrayStr = depsMatch[1];
            try {
              const deps: string[] = JSON.parse(arrayStr);
              const keepFlags = deps.map(dep => !entryAssetFiles.has(dep));
              if (keepFlags.some(keep => !keep)) {
                const filtered = deps.filter((_, i) => keepFlags[i]);
                const newArrayStr = JSON.stringify(filtered);
                const arrayStart = depsMatch.index + depsMatch[0].indexOf(arrayStr);
                s.overwrite(arrayStart, arrayStart + arrayStr.length, newArrayStr);
                transformCount++;

                // Build old-index -> new-index map (removed entries are simply absent)
                const indexMap = new Map<number, number>();
                let newIdx = 0;
                keepFlags.forEach((keep, oldIdx) => {
                  if (keep) {
                    indexMap.set(oldIdx, newIdx);
                    newIdx++;
                  }
                });

                // Remap every call site that indexes into this deps array, e.g.
                // `__vite__mapDeps([0,1,2])` -> `__vite__mapDeps([0,1])`
                const callSiteRegex = /__vite__mapDeps\(\[\s*([\d\s,]*)\s*\]\)/g;
                let callMatch: RegExpExecArray | null;
                while ((callMatch = callSiteRegex.exec(chunk.code)) !== null) {
                  const idxListStr = callMatch[1];
                  const oldIndices = idxListStr
                    .split(',')
                    .map(v => v.trim())
                    .filter(v => v.length > 0)
                    .map(Number);
                  const newIndices = oldIndices
                    .map(i => indexMap.get(i))
                    .filter((i): i is number => i !== undefined);
                  const newIdxListStr = newIndices.join(',');
                  const listStart = callMatch.index + callMatch[0].indexOf(idxListStr);
                  s.overwrite(listStart, listStart + idxListStr.length, newIdxListStr);
                  transformCount++;
                }
              }
            } catch {
              // Silently skip if the array is not parseable JSON (unlikely in Vite output)
            }
          }
        }

        // Pattern 5: Rewrite hardcoded static asset URLs (images, fonts, etc.)
        // Vite emits these as plain string literals like `"/jaguar-Hash.avif"` (prefixed
        // with the configured `base`), baked in at build time for any regular
        // `import img from './img.png'`. Since this isn't routed through the runtime
        // `assetsURL` helper (that's only used for chunk/CSS preload deps), it always
        // resolves from the domain root. We rewrite each known emitted asset filename to
        // use the resource base path at runtime instead, falling back to the original
        // base when `window` isn't available (SSR).
        if (staticAssetFiles.size > 0) {
          for (const assetFileName of staticAssetFiles) {
            const escapedAssetFileName = assetFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const assetUrlRegex = new RegExp(
              `([\\x60'"])${escapedBase}${escapedAssetFileName}\\1`,
              'g'
            );
            let assetUrlMatch: RegExpExecArray | null;
            while ((assetUrlMatch = assetUrlRegex.exec(chunk.code)) !== null) {
              const fullMatch = assetUrlMatch[0];
              const quote = assetUrlMatch[1];
              const resourceBaseRef = resourceBaseVar(widgetPlaceholder);
              const replacement = `(((typeof window !== 'undefined' && window) ? ${resourceBaseRef} : ${quote}${resolvedBase}${quote}) + ${quote}${assetFileName}${quote})`;
              s.overwrite(assetUrlMatch.index, assetUrlMatch.index + fullMatch.length, replacement);
              transformCount++;
            }
          }
        }

        // If we made any transformations, update the chunk and flush it to disk.
        // Rollup already wrote the original (untransformed) file by this point since
        // `writeBundle` runs after the write phase, so we must overwrite it ourselves.
        if (transformCount > 0) {
          chunk.code = s.toString();
          totalTransformations += transformCount;
          
          // Optionally regenerate source map
          if (enableSourceMap && chunk.map) {
            const map = s.generateMap({
              source: fileName,
              includeContent: true,
              hires: true,
            });
            // MagicString's SourceMap is compatible with Rollup's SourceMap
            chunk.map = map as unknown as typeof chunk.map;

            // Rollup already wrote the stale `.map` file (matching the pre-transform code)
            // to disk during the write phase. Flush the regenerated map too, or the
            // sourceMappingURL comment left in `chunk.code` will point to an out-of-sync
            // source map.
            writeFileSync(join(outDir, `${fileName}.map`), map.toString(), 'utf-8');
          }

          writeFileSync(join(outDir, fileName), chunk.code, 'utf-8');
          
          this.warn(
            `Transformed ${transformCount} import(s) in ${fileName}`
          );
        }
      }
      
      if (totalTransformations === 0) {
        this.warn(
          'No dynamic imports were transformed. This may be expected if there are no code-split chunks, ' +
          'or it could indicate that the regex patterns do not match the generated code.'
        );
      } else {
        this.warn(
          `Total transformations applied: ${totalTransformations}`
        );
      }
    },
  };
}

export default transformDynamicImports;