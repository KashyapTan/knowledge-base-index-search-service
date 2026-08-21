import type { FileFormat } from "../discovery/index.ts";
import type { ExtractedDocument, Extractor, ExtractorContext } from "./contracts.ts";
import { javascriptExtractor, otherSourceExtractor, pythonExtractor } from "./extractors/code.ts";
import { htmlExtractor } from "./extractors/html.ts";
import { markdownExtractor } from "./extractors/markdown.ts";
import { plainTextExtractor } from "./extractors/plain.ts";
import { structuredDataExtractor } from "./extractors/structured.ts";

export class ExtractorRegistry {
  readonly #extractors = new Map<FileFormat, Extractor>();
  readonly #fallback: Extractor;

  constructor(extractors: readonly Extractor[], fallback: Extractor = plainTextExtractor) {
    this.#fallback = fallback;
    for (const extractor of extractors) {
      for (const format of extractor.formats) {
        if (this.#extractors.has(format)) {
          throw new Error(`An extractor is already registered for ${format}.`);
        }
        this.#extractors.set(format, extractor);
      }
    }
  }

  get(format: FileFormat): Extractor | undefined {
    return this.#extractors.get(format);
  }

  extract(context: ExtractorContext): ExtractedDocument {
    const extractor = this.get(context.file.format);
    if (!extractor) throw new Error(`No extractor is registered for ${context.file.format}.`);
    try {
      return extractor.extract(context);
    } catch {
      const fallback = this.#fallback.extract(context);
      return {
        ...fallback,
        warnings: [
          ...fallback.warnings,
          {
            code: "PARSER_FALLBACK",
            message: `${extractor.name} failed; safe plain-text extraction was used.`,
          },
        ],
      };
    }
  }
}

export function createDefaultExtractorRegistry(): ExtractorRegistry {
  return new ExtractorRegistry([
    markdownExtractor,
    htmlExtractor,
    pythonExtractor,
    javascriptExtractor,
    structuredDataExtractor,
    otherSourceExtractor,
    plainTextExtractor,
  ]);
}
