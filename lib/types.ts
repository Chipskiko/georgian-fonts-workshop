export type FontEntry = {
  id: string;
  name: string;
  designer?: string;
  file: string;
  filename: string;
  format: "truetype" | "opentype" | "woff" | "woff2";
};
