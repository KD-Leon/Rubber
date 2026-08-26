/**
 * Office module barrel exports.
 *
 * PPTX generation types and engines are in ./pptx/ subdirectory.
 * This file re-exports shared utilities used across the module.
 */

export { renderPptxToImages } from './pptxRenderer';
export type { RenderedSlide, RenderResult } from './pptxRenderer';
