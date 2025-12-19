/**
 * Default resource base variable generator
 * Creates a window-based accessor with SSR safety
 */
export declare const defaultResourceBaseVar: (widPlaceholder: string) => string;
/**
 * Default entry name predicate
 * Uses Rollup's isEntry property to identify entry chunks
 */
import type { OutputChunk } from 'rollup';
export declare const defaultEntryNamePredicate: (chunk: OutputChunk) => boolean;
