/**
 * Default resource base variable generator
 * Creates a window-based accessor with SSR safety
 */
export const defaultResourceBaseVar = (widPlaceholder) => {
    return `window['resourceBasePath-${widPlaceholder}']`;
};
export const defaultEntryNamePredicate = (chunk) => {
    return chunk.isEntry || false;
};
