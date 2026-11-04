import type { AccountContext } from './contracts.ts';

/** Source-pixel coordinates. Stroke caps and joins are round. */
export interface AnnotationPoint { x: number; y: number }
export interface AnnotationRect extends AnnotationPoint { width: number; height: number }
export interface AnnotationColor { red: number; green: number; blue: number; alpha: number }
export interface AnnotationStroke { color: AnnotationColor; width: number }
export type Annotation =
  | { type: 'rectangle'; bounds: AnnotationRect; stroke: AnnotationStroke }
  | { type: 'ellipse'; bounds: AnnotationRect; stroke: AnnotationStroke }
  | { type: 'arrow'; from: AnnotationPoint; to: AnnotationPoint; head_length: number; stroke: AnnotationStroke }
  | { type: 'pen'; points: AnnotationPoint[]; stroke: AnnotationStroke }
  | { type: 'text'; bounds: AnnotationRect; text: string; font_size: number; color: AnnotationColor }
  | { type: 'mosaic'; bounds: AnnotationRect; block_size: number };

export interface AnnotationSource {
  source_hash: string;
  mime: 'image/png';
  width: number;
  height: number;
  /** Raw base64, without a data URI prefix. */
  data_base64: string;
}

/** Host also enforces these bounds before allocating decoded pixels. */
export const ANNOTATION_MAX_DIMENSION = 8192;
export const ANNOTATION_MAX_PIXELS = 16 * 1024 * 1024;
export const ANNOTATION_MAX_PNG_BYTES = 10 * 1024 * 1024;
export const ANNOTATION_MAX_SHAPES = 512;

export interface AnnotationSourceRequest {
  account: AccountContext;
  gid: string;
  attachment_id: string;
}
export interface AnnotationApplyRequest extends AnnotationSourceRequest {
  source_hash: string;
  annotations: Annotation[];
  png_base64: string;
  width: number;
  height: number;
}
