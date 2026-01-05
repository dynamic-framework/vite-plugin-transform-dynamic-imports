import type { OutputChunk } from 'rollup';

export const defaultResourceBaseVar = (widPlaceholder: string): string => {
  return `window['resourceBasePath-${widPlaceholder}']`;
};

export const defaultEntryNamePredicate = (chunk: OutputChunk): boolean => {
  return chunk.isEntry || false;
};
