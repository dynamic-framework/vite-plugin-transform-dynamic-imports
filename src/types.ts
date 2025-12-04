import type { OutputChunk } from 'rollup';

/**
 * Options for configuring the transformDynamicImports plugin
 */
export interface TransformDynamicImportsOptions {
  /**
   * Function that returns the resource base variable reference for a given widget placeholder
   * @param widPlaceholder - The widget placeholder string (e.g., '{{widget.wid}}')
   * @returns The variable reference string (e.g., 'window["resourceBasePath-{{widget.wid}}"]')
   */
  resourceBaseVar?: (widPlaceholder: string) => string;

  /**
   * Predicate to determine if a chunk should be processed as an entry chunk
   * @param chunk - The output chunk to test
   * @returns true if the chunk should be processed
   */
  entryNamePredicate?: (chunk: OutputChunk) => boolean;

  /** Enable source map generation for transformed code */
  enableSourceMap?: boolean;

  /** Widget placeholder used in resource base path */
  widgetPlaceholder?: string;

  /** Pattern for chunk file extension to match */
  chunkFilePattern?: string;

  /** Entry file name pattern to transform static imports from */
  entryFileName?: string;

  /** Template for static import URL replacement */
  staticImportUrlTemplate?: string;
}
