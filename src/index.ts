import MagicString from 'magic-string';
import type { Plugin, OutputBundle, OutputChunk } from 'rollup';
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
    chunkFilePattern = '.chunk.js',
    entryFileName = 'main.js',
    staticImportUrlTemplate = '{{site.url}}/widget_manager/{{widget.wid}}/{{widget.version}}.js',
  } = options;

  return {
    name: 'transform-dynamic-imports',
    
    generateBundle(_outputOptions, bundle: OutputBundle) {
      let totalTransformations = 0;

      // ---- PASS 1: Collect entry CSS file names from viteMetadata ----
      // Chunks import CSS that is already loaded via <link> in the entry page.
      // These entry-level CSS files must be removed from __vite__mapDeps arrays
      // so that the transformed assetsURL does not produce incorrect URLs for them.
      const entryCssFiles: Set<string> = new Set();
      for (const chunkOrAsset of Object.values(bundle)) {
        if (chunkOrAsset.type === 'chunk') {
          const c = chunkOrAsset as OutputChunk;
          if (c.isEntry) {
            // viteMetadata is attached by Vite's internal build-metadata plugin
            const importedCss: string[] | undefined = (c as any).viteMetadata?.importedCss;
            if (importedCss) {
              for (const css of importedCss) {
                entryCssFiles.add(css);
              }
            }
          }
        }
      }
      
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
          // Transform dynamic imports like import("./file.chunk.js")
          // This regex handles:
          // - Single quotes, double quotes, or backticks
          // - Optional whitespace around the path
          // - Captures the quote type to ensure matching pairs
          // Escape special regex characters in chunkFilePattern
          const escapedChunkPattern = chunkFilePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const dynamicImportRegex = new RegExp(
            `import\\(\\s*([\\x60'\"])(\\.\/[^\\x60'\"()]+?${escapedChunkPattern})\\1\\s*\\)`,
            'g'
          );
          
          let match: RegExpExecArray | null;
          while ((match = dynamicImportRegex.exec(chunk.code)) !== null) {
            const fullMatch = match[0];
            const quote = match[1];
            const chunkPath = match[2];
            const chunkName = chunkPath.replace('./', '');
            
            // Generate SSR-safe replacement
            // Uses typeof guard to prevent window access in SSR contexts
            // TODO: Add sanitization/validation for resourceBasePath at runtime to prevent 
            // path traversal attacks if the global variable can be user-influenced.
            // Consider implementing: path normalization, allowlist checking, or CSP headers.
            const resourceBaseRef = resourceBaseVar(widgetPlaceholder);
            const replacement = `import(((typeof window !== 'undefined' && window) ? ${resourceBaseRef} : '') + ${quote}${chunkName}${quote})`;
            
            s.overwrite(match.index, match.index + fullMatch.length, replacement);
            transformCount++;
          }
        }

        // Pattern 2: Transform static imports from entry file in chunk files
        // Process all chunk files (not just entry) to transform imports from main.js
        if (fileName.includes(chunkFilePattern)) {
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

        // Pattern 4: Remove entry-level CSS files from __vite__mapDeps arrays
        // Entry CSS files (e.g. "main.css") are already loaded via <link> in the HTML page.
        // After Pattern 3 transforms assetsURL to use resourceBasePath, keeping them in
        // the array would cause incorrect URL resolution (e.g. resourceBasePath + "main.css"
        // instead of the root-level CSS file). We filter them out entirely.
        if (entryCssFiles.size > 0 && fileName.includes(chunkFilePattern)) {
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
              const filtered = deps.filter(dep => !entryCssFiles.has(dep));
              if (filtered.length < deps.length) {
                const newArrayStr = JSON.stringify(filtered);
                const arrayStart = depsMatch.index + depsMatch[0].indexOf(arrayStr);
                s.overwrite(arrayStart, arrayStart + arrayStr.length, newArrayStr);
                transformCount++;
              }
            } catch {
              // Silently skip if the array is not parseable JSON (unlikely in Vite output)
            }
          }
        }

        // If we made any transformations, update the chunk
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
          }
          
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
