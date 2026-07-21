export type FontEntry = {
  id: string;
  name: string;
  designer?: string;
  file: string;
  filename: string;
  format: "truetype" | "opentype" | "woff" | "woff2";
  /** Public URL of the baked alphabet-preview SVG sidecar (plan doc
   *  §8). Present when the sidecar exists; rows without it fall back
   *  to @font-face text rendering. */
  previewSvg?: string;
};
