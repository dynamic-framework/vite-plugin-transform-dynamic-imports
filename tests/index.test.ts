import { describe, it, expect } from 'vitest';
import myPlugin from '../src';
import type { OutputBundle, OutputChunk } from 'rollup';

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
    plugin.generateBundle!.call({ warn: () => {} } as any, {}, bundle);

    const out = (bundle[fileName] as OutputChunk).code;
    expect(out).toMatch(/import\(\(\(typeof window !== 'undefined' && window\) \? .* \: ''\) \+ 'file.chunk.js'\)/);
  });

  it('transforms static import in chunk for entryFileName', () => {
    const plugin = myPlugin({ entryFileName: 'main.js', chunkFilePattern: '.chunk.js', staticImportUrlTemplate: 'X/{{widget.wid}}/Y.js' });
    const code = `import { a } from "./main.js"; // any content`;
    const [fileName, chunk] = makeChunk(code, 'something.chunk.js');
    const bundle: OutputBundle = { [fileName]: chunk } as unknown as OutputBundle;

    // @ts-expect-error using plugin context methods indirectly
    plugin.generateBundle!.call({ warn: () => {} } as any, {}, bundle);

    const out = (bundle[fileName] as OutputChunk).code;
    expect(out).toContain(`from "X/{{widget.wid}}/Y.js"`);
  });

  it('does not transform when there are no matches', () => {
    const plugin = myPlugin();
    const code = `console.log('no imports');`;
    const [fileName, chunk] = makeChunk(code, 'index.js');
    const bundle: OutputBundle = { [fileName]: chunk } as unknown as OutputBundle;

    // @ts-expect-error using plugin context methods indirectly
    plugin.generateBundle!.call({ warn: () => {} } as any, {}, bundle);

    const out = (bundle[fileName] as OutputChunk).code;
    expect(out).toBe(code);
  });
});
