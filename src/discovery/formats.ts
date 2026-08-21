import { extname } from "node:path";
import type { FileFormat, FileReadStatus } from "./contracts.ts";

export interface FormatDescriptor {
  readonly format: FileFormat;
  readonly mimeFamily: string;
}

const EXTENSION_FORMATS: Readonly<Record<string, FormatDescriptor>> = {
  ".md": { format: "markdown", mimeFamily: "text/markdown" },
  ".mdx": { format: "markdown", mimeFamily: "text/markdown" },
  ".markdown": { format: "markdown", mimeFamily: "text/markdown" },
  ".html": { format: "html", mimeFamily: "text/html" },
  ".htm": { format: "html", mimeFamily: "text/html" },
  ".py": { format: "python", mimeFamily: "text/x-python" },
  ".js": { format: "javascript", mimeFamily: "text/javascript" },
  ".jsx": { format: "javascript", mimeFamily: "text/javascript" },
  ".mjs": { format: "javascript", mimeFamily: "text/javascript" },
  ".cjs": { format: "javascript", mimeFamily: "text/javascript" },
  ".ts": { format: "typescript", mimeFamily: "text/typescript" },
  ".tsx": { format: "typescript", mimeFamily: "text/typescript" },
  ".mts": { format: "typescript", mimeFamily: "text/typescript" },
  ".cts": { format: "typescript", mimeFamily: "text/typescript" },
  ".json": { format: "json", mimeFamily: "application/json" },
  ".jsonc": { format: "json", mimeFamily: "application/json" },
  ".yaml": { format: "yaml", mimeFamily: "application/yaml" },
  ".yml": { format: "yaml", mimeFamily: "application/yaml" },
  ".toml": { format: "toml", mimeFamily: "application/toml" },
  ".css": { format: "stylesheet", mimeFamily: "text/css" },
  ".scss": { format: "stylesheet", mimeFamily: "text/x-scss" },
  ".sass": { format: "stylesheet", mimeFamily: "text/x-sass" },
  ".less": { format: "stylesheet", mimeFamily: "text/x-less" },
  ".sh": { format: "shell", mimeFamily: "text/x-shellscript" },
  ".bash": { format: "shell", mimeFamily: "text/x-shellscript" },
  ".zsh": { format: "shell", mimeFamily: "text/x-shellscript" },
  ".sql": { format: "sql", mimeFamily: "application/sql" },
  ".xml": { format: "xml", mimeFamily: "application/xml" },
  ".csv": { format: "csv", mimeFamily: "text/csv" },
  ".txt": { format: "text", mimeFamily: "text/plain" },
  ".log": { format: "text", mimeFamily: "text/plain" },
};

export function normalizedExtension(filename: string): string {
  return extname(filename).toLocaleLowerCase("en-US");
}

export function formatForExtension(extension: string): FormatDescriptor | undefined {
  return EXTENSION_FORMATS[extension];
}

export function inspectTextBytes(
  sample: Uint8Array,
  utf8Valid: boolean,
  knownFormat?: FormatDescriptor,
): {
  readonly descriptor: FormatDescriptor;
  readonly status: FileReadStatus;
  readonly error?: string;
} {
  if (!utf8Valid) {
    return {
      descriptor: knownFormat ?? { format: "unknown", mimeFamily: "application/octet-stream" },
      status: "malformed",
      error: "The file is not valid UTF-8 text.",
    };
  }

  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return {
        descriptor: knownFormat ?? { format: "unknown", mimeFamily: "application/octet-stream" },
        status: "unsupported",
        error: "The file contains binary NUL bytes.",
      };
    }
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) {
      suspicious += 1;
    }
  }
  if (!knownFormat && sample.length > 0 && suspicious / sample.length > 0.1) {
    return {
      descriptor: { format: "unknown", mimeFamily: "application/octet-stream" },
      status: "unsupported",
      error: "The file does not appear to contain ordinary text.",
    };
  }
  return {
    descriptor: knownFormat ?? { format: "text", mimeFamily: "text/plain" },
    status: "ready",
  };
}
