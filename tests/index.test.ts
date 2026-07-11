import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import myPlugin from '../src';
import type { OutputBundle, OutputChunk } from 'rollup';

// writeBundle needs a real output directory to write transformed files back to
// (Rollup has already written the untransformed files to disk by the time
// writeBundle runs, so the plugin must overwrite them itself).
const createdTempDirs: string[] = [];
function makeOutputOptions() {
  const dir = mkdtempSync(join(tmpdir(), 'transform-dynamic-imports-test-'));
  createdTempDirs.push(dir);
  return { dir } as any;
}

afterAll(() => {
  for (const dir of createdTempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    expect(out).toMatch(/import\(\(typeof window !== 'undefined' && window\) \? \(.* \+ 'file\.chunk\.js'\) \: '\.\/file\.chunk\.js'\)/);
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

  it('transforms assetsURL when the Vite config uses a non-default base path', () => {
    // Regression test: Vite bakes `config.base` into the assetsURL string literal
    // (e.g. `return "/my-base/" + B` instead of `return "/" + B`). The regex used to
    // detect this pattern was hard-coded to only match a bare "/" prefix, silently
    // no-op'ing (and reintroducing 404s) for any consumer project with a custom `base`.
    const plugin = myPlugin({ widgetPlaceholder: '{{widget.wid}}' });

    // @ts-expect-error calling the configResolved hook directly to set a custom base
    plugin.configResolved!.call({} as any, { base: '/my-base/' } as any);

    const code = `assetsURL = function(B) { return "/my-base/" + B }`;
    const [fileName, chunk] = makeChunk(code, 'main.js', { isEntry: true });
    const bundle: OutputBundle = { [fileName]: chunk } as unknown as OutputBundle;

    // @ts-expect-error using plugin context methods indirectly
    plugin.writeBundle!.call({ warn: () => { } } as any, makeOutputOptions(), bundle);

    const out = (bundle[fileName] as OutputChunk).code;
    expect(out).toMatch(/typeof window !== 'undefined'/);
    expect(out).toMatch(/resourceBasePath-{{widget.wid}}/);
    expect(out).not.toContain(`return "/my-base/" + B`);
    expect(out).toContain("assetsURL = function(B) {");
    // SSR fallback should use the configured base (JSON.stringify-escaped), not a
    // hard-coded '/'
    expect(out).toContain(`: "/my-base/"`);
  });

  it('warns when build.write is false, since writeBundle never runs in that flow', () => {
    // Regression test: this plugin relies entirely on the `writeBundle` hook, which
    // Rollup/Vite skip for generate-only builds (`build.write: false` /
    // `bundle.generate()`). Without an explicit warning, consumers using that flow
    // would silently get untransformed output.
    const plugin = myPlugin({ widgetPlaceholder: '{{widget.wid}}' });
    const warnings: string[] = [];

    // @ts-expect-error calling the configResolved hook directly with build.write: false
    plugin.configResolved!.call({ warn: (msg: string) => warnings.push(msg) } as any, {
      base: '/',
      build: { write: false },
    } as any);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/build\.write.*false/);
    expect(warnings[0]).toMatch(/writeBundle/);
  });

  it('does not warn when build.write is left at its default (true)', () => {
    const plugin = myPlugin({ widgetPlaceholder: '{{widget.wid}}' });
    const warnings: string[] = [];

    // @ts-expect-error calling the configResolved hook directly with a default build config
    plugin.configResolved!.call({ warn: (msg: string) => warnings.push(msg) } as any, {
      base: '/',
      build: { write: true },
    } as any);

    expect(warnings).toHaveLength(0);
  });

  it('transforms assetsURL when Vite emits the base literal with single quotes', () => {
    // Regression test: assetsURLRegex previously only matched a double-quoted base
    // literal (`return "..." + param`). Some minifiers/emitters may use single quotes
    // or backticks instead, which would silently no-op the transform and reintroduce
    // incorrect preload URLs.
    const plugin = myPlugin({ widgetPlaceholder: '{{widget.wid}}' });

    const code = `assetsURL = function(B) { return '/' + B }`;
    const [fileName, chunk] = makeChunk(code, 'main.js', { isEntry: true });
    const bundle: OutputBundle = { [fileName]: chunk } as unknown as OutputBundle;

    // @ts-expect-error using plugin context methods indirectly
    plugin.writeBundle!.call({ warn: () => { } } as any, makeOutputOptions(), bundle);

    const out = (bundle[fileName] as OutputChunk).code;
    expect(out).toMatch(/typeof window !== 'undefined'/);
    expect(out).toMatch(/resourceBasePath-{{widget.wid}}/);
    expect(out).not.toContain(`return '/' + B`);
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
    expect(entryOut).toMatch(/import\(\(typeof window !== 'undefined' && window\) \? \(.* \+ 'Primary-dU_amVVv\.js'\) \: '\.\/Primary-dU_amVVv\.js'\)/);
    // Pattern 3: assetsURL still rewritten
    expect(entryOut).toMatch(/resourceBasePath-{{widget\.wid}}/);
    // Pattern 2: static import from entry file rewritten in the non-suffixed chunk file
    expect(chunkOut).toContain(`from "{{site.url}}/widget_manager/{{widget.wid}}/{{widget.version}}.js"`);
    // Pattern 4: entry CSS removed from mapDeps and call site remapped
    expect(chunkOut).not.toContain('"main.css"');
    expect(chunkOut).toContain('"Secondary-abc123.js"');
    expect(chunkOut).toContain('__vite__mapDeps([0])');
  });

  it('transforms static named-import of a manualChunks vendor chunk into a dynamic await import', () => {
    // Regression test: when the consuming project's Vite config uses
    // `build.rollupOptions.output.manualChunks` to split shared deps (react, etc.) out
    // of the entry, Rollup emits a static top-level import in the entry pointing at that
    // vendor chunk, e.g. `import{a as b,c}from"./vendor-Hash.js"`. Since a static import
    // specifier must be a string literal, this must be rewritten into an equivalent
    // `await import(...)` + destructuring so it resolves against the widget's resource
    // base path instead of the domain root.
    const plugin = myPlugin({ widgetPlaceholder: '{{widget.wid}}' });

    const entryCode = `import{r as reactExports,j as jsxRuntimeExports}from"./vendor-Hash123.js";console.log(reactExports);`;
    const [entryName, entryChunk] = makeChunk(entryCode, 'main.js', { isEntry: true });

    const [vendorName, vendorChunk] = makeChunk('export const r = 1, j = 2;', 'vendor-Hash123.js');

    const bundle: OutputBundle = {
      [entryName]: entryChunk,
      [vendorName]: vendorChunk,
    } as unknown as OutputBundle;

    // @ts-expect-error using plugin context methods indirectly
    plugin.writeBundle!.call({ warn: () => { } } as any, makeOutputOptions(), bundle);

    const out = (bundle[entryName] as OutputChunk).code;
    expect(out).not.toContain('import{r as reactExports,j as jsxRuntimeExports}from"./vendor-Hash123.js"');
    expect(out).toContain('const { r: reactExports, j: jsxRuntimeExports } = await import(');
    expect(out).toMatch(/typeof window !== 'undefined'/);
    expect(out).toMatch(/resourceBasePath-{{widget\.wid}}/);
    expect(out).toContain('vendor-Hash123.js');
  });

  it('transforms a side-effect-only static import of a manualChunks vendor chunk', () => {
    // Regression test: a manualChunks vendor split can be pulled into the entry purely
    // for its side effects, with no named bindings, e.g. `import"./vendor-i18next.js";`.
    // Pattern 6's named-import regex requires `{...}`, so this needs its own rewrite
    // (Pattern 6b) or the import silently resolves from the domain root and 404s.
    const plugin = myPlugin({ widgetPlaceholder: '{{widget.wid}}' });

    const entryCode = `import"./vendor-i18next.Hash456.js";console.log("after");`;
    const [entryName, entryChunk] = makeChunk(entryCode, 'main.js', { isEntry: true });

    const [vendorName, vendorChunk] = makeChunk('console.log("i18next side effect");', 'vendor-i18next.Hash456.js');

    const bundle: OutputBundle = {
      [entryName]: entryChunk,
      [vendorName]: vendorChunk,
    } as unknown as OutputBundle;

    // @ts-expect-error using plugin context methods indirectly
    plugin.writeBundle!.call({ warn: () => { } } as any, makeOutputOptions(), bundle);

    const out = (bundle[entryName] as OutputChunk).code;
    expect(out).not.toContain('import"./vendor-i18next.Hash456.js"');
    expect(out).toMatch(/^await import\(/);
    expect(out).toMatch(/typeof window !== 'undefined'/);
    expect(out).toMatch(/resourceBasePath-{{widget\.wid}}/);
    expect(out).toContain('vendor-i18next.Hash456.js');
  });

  it('transforms assetsURL when it lands in a non-entry chunk (manualChunks split)', () => {
    // Regression test: when manualChunks relocates Vite's internal preload-helper virtual
    // module (which defines/uses assetsURL) out of the entry into a separate vendor
    // chunk, Pattern 3 must still find and rewrite it there, not only in the entry.
    const plugin = myPlugin({ widgetPlaceholder: '{{widget.wid}}' });

    const [entryName, entryChunk] = makeChunk('console.log("entry, no assetsURL here");', 'main.js', { isEntry: true });

    const vendorCode = `assetsURL = function(B) { return "/" + B }`;
    const [vendorName, vendorChunk] = makeChunk(vendorCode, 'vendor-misc.Hash789.js');

    const bundle: OutputBundle = {
      [entryName]: entryChunk,
      [vendorName]: vendorChunk,
    } as unknown as OutputBundle;

    // @ts-expect-error using plugin context methods indirectly
    plugin.writeBundle!.call({ warn: () => { } } as any, makeOutputOptions(), bundle);

    const out = (bundle[vendorName] as OutputChunk).code;
    expect(out).toMatch(/typeof window !== 'undefined'/);
    expect(out).toMatch(/resourceBasePath-{{widget\.wid}}/);
    expect(out).not.toContain('return "/" + B');
    expect(out).toContain('assetsURL = function(B) {');
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