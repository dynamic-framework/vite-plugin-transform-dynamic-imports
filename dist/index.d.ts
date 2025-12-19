import type { Plugin } from 'rollup';
import type { TransformDynamicImportsOptions } from './types.js';
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
export declare function transformDynamicImports(options?: TransformDynamicImportsOptions): Plugin;
export default transformDynamicImports;
