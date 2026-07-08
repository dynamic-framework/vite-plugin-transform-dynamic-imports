import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import myPlugin from '../src';
import type { OutputBundle, OutputChunk } from 'rollup';

// writeBundle needs a real output directory to write transformed files back to
// (Rollup has already written the untransformed files to disk by the time
// writeBundle runs, so the plugin must overwrite them itself).
function makeOutputOptions() {
  return { dir: mkdtempSync(join(tmpdir(), 'transform-dynamic-imports-test-')) } as any;
}

function makeChunk(code: string, fileName: string, extra: Partial<OutputChunk> = {}): [string, OutputChunk] {
  const chunk: OutputChunk = {
    type: 'chunk',
    fileName,
    code,
    isEntry: !!extra.isEntry,
    modules: {},
    dynamicImports: [],
    facadeModuleId: extra.facadeModuleId,
    implicitlyLoadedBefore: [],
    imports: [],
    referencedFiles: [],
    exports: [],
    moduleIds: [],
    preliminaryFileName: undefined,
    name: fileName,
    sourcemapFileName: undefined,
    map: undefined,
    ...extra,
  } as unknown as OutputChunk;
  return [fileName, chunk];
}

describe('myPlugin', () => {
  it('initializes correctly', () => {
    const plugin = myPlugin();
    expect(plugin.name).toBe('transform-dynamic-imports');
  });

  it('transforms dynamic import in entry chunk', () => {
    const plugin = myPlugin({ widgetPlaceholder: '{{widget.wid}}' });
    const code = `const x = 1; const mod = import('./file.chunk.js');`;
    const [fileName, chunk] = makeChunk(code, 'main.js', { isEntry: true });
    const bundle: OutputBundle = { [fileName]: chunk } as unknown as OutputBundle;

    // @ts-expect-error using plugin context methods indirectly
    plugin.writeBundle!.call({ warn: () => {} } as any, makeOutputOptions(), bundle);

    const out = (bundle[fileName] as OutputChunk).code;
    expect(out).toMatch(/import\(\(\(typeof window !== 'undefined' && window\) \? .* \: ''\) \+ 'file.chunk.js'\)/);
  });

  it('transforms static import in chunk for entryFileName', () => {
    const plugin = myPlugin({ entryFileName: 'main.js', chunkFilePattern: '.chunk.js', staticImportUrlTemplate: 'X/{{widget.wid}}/Y.js' });
    const code = `import { a } from "./main.js"; // any content`;
    const [fileName, chunk] = makeChunk(code, 'something.chunk.js');
    const bundle: OutputBundle = { [fileName]: chunk } as unknown as OutputBundle;

    // @ts-expect-error using plugin context methods indirectly
    plugin.writeBundle!.call({ warn: () => {} } as any, makeOutputOptions(), bundle);

    const out = (bundle[fileName] as OutputChunk).code;
    expect(out).toContain(`from "X/{{widget.wid}}/Y.js"`);
  });

  it('does not transform when there are no matches', () => {
    const plugin = myPlugin();
    const code = `console.log('no imports');`;
    const [fileName, chunk] = makeChunk(code, 'index.js');
    const bundle: OutputBundle = { [fileName]: chunk } as unknown as OutputBundle;

    // @ts-expect-error using plugin context methods indirectly
    plugin.writeBundle!.call({ warn: () => {} } as any, makeOutputOptions(), bundle);

    const out = (bundle[fileName] as OutputChunk).code;
    expect(out).toBe(code);
  });

  it('transforms assetsURL in entry chunk to use resourceBasePath', () => {
    const plugin = myPlugin({ widgetPlaceholder: '{{widget.wid}}' });
    const code = `assetsURL = function(B) { return "/" + B }`;
    const [fileName, chunk] = makeChunk(code, 'main.js', { isEntry: true });
    const bundle: OutputBundle = { [fileName]: chunk } as unknown as OutputBundle;

    // @ts-expect-error using plugin context methods indirectly
    plugin.writeBundle!.call({ warn: () => { } } as any, makeOutputOptions(), bundle);

    const out = (bundle[fileName] as OutputChunk).code;
    expect(out).toMatch(/typeof window !== 'undefined'/);
    expect(out).toMatch(/resourceBasePath-{{widget.wid}}/);
    expect(out).not.toContain(`return "/" + B`);
    expect(out).toContain("assetsURL = function(B) {");
  });

  it('removes entry JS/CSS files from __vite__mapDeps and remaps call-site indices', () => {
    const plugin = myPlugin({ widgetPlaceholder: '{{widget.wid}}' });

    // Create an entry chunk (fileName "main.js") that imports "main.css"
    const [entryName, entryChunk] = makeChunk('console.log("entry");', 'main.js', {
      isEntry: true,
      viteMetadata: { importedCss: ['main.css'] },
    } as any);

    // Create a chunk with __vite__mapDeps that includes entry CSS (main.css, idx 0),
    // non-entry CSS (main2.css, idx 1), and the entry JS file itself (main.js, idx 2).
    // The call site references all three by index, mimicking real Vite output.
    const chunkCode = [
      `const __vite__mapDeps=(i,m=__vite__mapDeps,`,
      `d=(m.f||(m.f=["main.css","main2.css","main.js"])))=>i.map(i=>d[i]);`,
      `o(()=>import("./Other.chunk.js"), __vite__mapDeps([0,1,2]));`,
    ].join('');
    const [chunkName, chunk] = makeChunk(chunkCode, 'something.chunk.js');

    const bundle: OutputBundle = {
      [entryName]: entryChunk,
      [chunkName]: chunk,
    } as unknown as OutputBundle;

    // @ts-expect-error using plugin context methods indirectly
    plugin.writeBundle!.call({ warn: () => { } } as any, makeOutputOptions(), bundle);

    const out = (bundle[chunkName] as OutputChunk).code;
    // Non-entry CSS should remain
    expect(out).toContain('"main2.css"');
    // Entry CSS and entry JS should be removed
    expect(out).not.toContain('"main.css"');
    expect(out).not.toMatch(/\[.*"main\.js".*\]/);
    // The array should still be valid
    expect(out).toMatch(/m\.f=\[\[?/);
    // The call site must be remapped to only reference the surviving entry (new index 0),
    // not the original indices 0/1/2 which would now point at the wrong/missing positions.
    expect(out).toContain('__vite__mapDeps([0])');
  });

  it('transforms chunks with default Vite hashed names (no chunkFileNames/.chunk.js convention configured)', () => {
    // Regression test: a consuming project may not set a custom `chunkFileNames`
    // in its Vite config, in which case Vite emits chunk files with its default
    // naming, e.g. "Primary-dU_amVVv.js" instead of "Primary.<hash>.chunk.js".
    // The plugin must still detect and transform these using `chunk.isEntry`
    // rather than a filename suffix.
    const plugin = myPlugin({ widgetPlaceholder: '{{widget.wid}}' });

    const entryCode = [
      `const mod = () => import('./Primary-dU_amVVv.js');`,
      `assetsURL = function(B) { return "/" + B }`,
    ].join('\n');
    const [entryName, entryChunk] = makeChunk(entryCode, 'main.js', {
      isEntry: true,
      viteMetadata: { importedCss: ['main.css'] },
    } as any);

    const chunkCode = [
      `import { a } from "./main.js";`,
      `const __vite__mapDeps=(i,m=__vite__mapDeps,`,
      `d=(m.f||(m.f=["main.css","Secondary-abc123.js"])))=>i.map(i=>d[i]);`,
      `o(()=>import("./Secondary-abc123.js"), __vite__mapDeps([0,1]));`,
    ].join('');
    const [chunkName, chunk] = makeChunk(chunkCode, 'Primary-dU_amVVv.js');

    const bundle: OutputBundle = {
      [entryName]: entryChunk,
      [chunkName]: chunk,
    } as unknown as OutputBundle;

    // @ts-expect-error using plugin context methods indirectly
    plugin.writeBundle!.call({ warn: () => { } } as any, makeOutputOptions(), bundle);

    const entryOut = (bundle[entryName] as OutputChunk).code;
    const chunkOut = (bundle[chunkName] as OutputChunk).code;

    // Pattern 1: dynamic import in entry chunk rewritten despite no ".chunk.js" suffix
    expect(entryOut).toMatch(/import\(\(\(typeof window !== 'undefined' && window\) \? .* \: ''\) \+ 'Primary-dU_amVVv\.js'\)/);
    // Pattern 3: assetsURL still rewritten
    expect(entryOut).toMatch(/resourceBasePath-{{widget\.wid}}/);
    // Pattern 2: static import from entry file rewritten in the non-suffixed chunk file
    expect(chunkOut).toContain(`from "{{site.url}}/widget_manager/{{widget.wid}}/{{widget.version}}.js"`);
    // Pattern 4: entry CSS removed from mapDeps and call site remapped
    expect(chunkOut).not.toContain('"main.css"');
    expect(chunkOut).toContain('"Secondary-abc123.js"');
    expect(chunkOut).toContain('__vite__mapDeps([0])');
  });

  it('rewrites hardcoded static asset URLs (images/fonts) to use the resource base path', () => {
    // Regression test: `import img from './img.avif'` compiles to a plain string
    // constant like `const R = "/img-Hash.avif"`. Unlike chunk/CSS preload deps, this
    // isn't routed through the runtime `assetsURL` helper, so it always resolves from
    // the domain root and 404s under Modyo's subfolder deployment.
    const plugin = myPlugin({ widgetPlaceholder: '{{widget.wid}}' });

    const [entryName, entryChunk] = makeChunk('console.log("entry");', 'main.js', { isEntry: true });

    // Chunk that imports an image asset, compiled to a hardcoded root-relative string
    const chunkCode = `const R="/jaguar-Hash123.avif";function Third(){return R;}export{Third as default};`;
    const [chunkName, chunk] = makeChunk(chunkCode, 'Third-CuHIPEeV.js');

    // The emitted asset itself, as it would appear in the Rollup output bundle
    const assetFileName = 'jaguar-Hash123.avif';
    const asset = { type: 'asset', fileName: assetFileName, source: Buffer.from('') };

    const bundle: OutputBundle = {
      [entryName]: entryChunk,
      [chunkName]: chunk,
      [assetFileName]: asset,
    } as unknown as OutputBundle;

    // @ts-expect-error using plugin context methods indirectly
    plugin.writeBundle!.call({ warn: () => { } } as any, makeOutputOptions(), bundle);

    const out = (bundle[chunkName] as OutputChunk).code;
    expect(out).not.toContain('"/jaguar-Hash123.avif"');
    expect(out).toContain(`"jaguar-Hash123.avif"`);
    expect(out).toMatch(/resourceBasePath-{{widget\.wid}}/);
    expect(out).toMatch(/typeof window !== 'undefined'/);
  });
});