/**
 * Default resource base variable generator
 * Creates a window-based accessor with SSR safety
 */
export const defaultResourceBaseVar = (widPlaceholder: string): string => {
  return `window['resourceBasePath-${widPlaceholder}']`;
};

/**
 * Default entry name predicate
 * Uses Rollup's isEntry property to identify entry chunks
 */
import type { OutputChunk } from 'rollup';
export const defaultEntryNamePredicate = (chunk: OutputChunk): boolean => {
  return chunk.isEntry || false;
};
