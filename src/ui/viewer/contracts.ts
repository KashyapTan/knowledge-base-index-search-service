import type { FileFormat } from "../../discovery/index.ts";

export type RendererKind = "markdown" | "html" | "code" | "text";

export interface RendererMetadata {
  readonly kind: RendererKind;
  readonly label: string;
  readonly language?: string;
  readonly supportsPreview: boolean;
}

const CODE_LANGUAGES: Readonly<Partial<Record<FileFormat, string>>> = {
  python: "python",
  javascript: "javascript",
  typescript: "typescript",
  json: "json",
  yaml: "yaml",
  toml: "ini",
  stylesheet: "css",
  shell: "shell",
  sql: "sql",
  xml: "xml",
};

export function rendererForFormat(format: string): RendererMetadata {
  if (format === "markdown") {
    return { kind: "markdown", label: "Markdown preview", supportsPreview: true };
  }
  if (format === "html") {
    return { kind: "html", label: "HTML preview", language: "xml", supportsPreview: true };
  }
  const language = CODE_LANGUAGES[format as FileFormat];
  if (language) return { kind: "code", label: "Code", language, supportsPreview: false };
  return {
    kind: "text",
    label: format === "csv" ? "CSV text" : "Plain text",
    supportsPreview: false,
  };
}

export interface ViewerSelection {
  readonly fileId: string;
  readonly filename: string;
  readonly relativePath: string;
  readonly format: string;
  readonly line?: number;
}

export type ViewerMode = "preview" | "source";

export const MAX_PREVIEW_CHARACTERS = 1_000_000;

export function previewAllowed(format: string, characterCount: number): boolean {
  return rendererForFormat(format).supportsPreview && characterCount <= MAX_PREVIEW_CHARACTERS;
}
