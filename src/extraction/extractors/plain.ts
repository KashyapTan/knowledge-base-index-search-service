import type { ExtractedUnit, Extractor } from "../contracts.ts";
import { buildDocument, fallbackLineUnits, lineSpan, makeUnit } from "./shared.ts";

export const plainTextExtractor: Extractor = {
  name: "plain-text",
  formats: ["text", "csv", "unknown"],
  extract(context) {
    if (context.file.format !== "csv") {
      const units = fallbackLineUnits(context, { linesPerUnit: 50 });
      return buildDocument(context, units, {
        language: "text",
        headings: [],
        symbols: [],
      });
    }

    const units: ExtractedUnit[] = [];
    const lines = context.source.lines;
    const header = lines[0]?.text ?? "";
    for (let index = 0; index < lines.length; index += 25) {
      const end = Math.min(lines.length - 1, index + 24);
      const span = lineSpan(context, index, end);
      const displayText = context.source.text.slice(span.start, span.end).trim();
      const searchText = index === 0 ? displayText : `${header}\n${displayText}`;
      const unit = makeUnit(context, {
        kind: "record",
        ...span,
        displayText,
        searchText,
      });
      if (unit) units.push(unit);
    }
    return buildDocument(context, units, {
      language: "csv",
      headings: [],
      symbols: [],
    });
  },
};
