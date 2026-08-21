import type {
  ExtractedUnit,
  ExtractionWarning,
  Extractor,
  ExtractorContext,
} from "../contracts.ts";
import { buildDocument, fallbackLineUnits, makeUnit } from "./shared.ts";

function sanitizeJsonc(text: string): string {
  const characters = [...text];
  let quote = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < characters.length; index += 1) {
    const current = characters[index] ?? "";
    const next = characters[index + 1] ?? "";
    if (lineComment) {
      if (current === "\n") lineComment = false;
      else characters[index] = " ";
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        characters[index] = " ";
        characters[index + 1] = " ";
        blockComment = false;
        index += 1;
      } else if (current !== "\n") {
        characters[index] = " ";
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') quote = false;
      continue;
    }
    if (current === '"') quote = true;
    else if (current === "/" && next === "/") {
      characters[index] = " ";
      characters[index + 1] = " ";
      lineComment = true;
      index += 1;
    } else if (current === "/" && next === "*") {
      characters[index] = " ";
      characters[index + 1] = " ";
      blockComment = true;
      index += 1;
    }
  }

  quote = false;
  escaped = false;
  for (let index = 0; index < characters.length; index += 1) {
    const current = characters[index] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') quote = false;
      continue;
    }
    if (current === '"') {
      quote = true;
      continue;
    }
    if (current !== ",") continue;
    let next = index + 1;
    while (/\s/u.test(characters[next] ?? "")) next += 1;
    if (characters[next] === "}" || characters[next] === "]") characters[index] = " ";
  }
  return characters.join("");
}

function findLineRange(context: ExtractorContext, lineIndex: number) {
  const line = context.source.lines[lineIndex];
  return { start: line?.start ?? 0, end: line?.end ?? context.source.text.length };
}

function jsonRecords(context: ExtractorContext, value: unknown): ExtractedUnit[] {
  const records: Array<{ path: string; rawValue: unknown; value: string }> = [];
  function visit(current: unknown, path: string): void {
    if (Array.isArray(current)) {
      current.forEach((item, index) => {
        visit(item, `${path}[${index}]`);
      });
    } else if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current))
        visit(child, path ? `${path}.${key}` : key);
    } else {
      records.push({ path: path || "$", rawValue: current, value: String(current) });
    }
  }
  visit(value, "");
  let searchFrom = 0;
  return records.flatMap((record) => {
    const encoded = JSON.stringify(record.rawValue) ?? record.value;
    const found = context.source.text.indexOf(encoded, searchFrom);
    const valueStart = found >= 0 ? found : searchFrom;
    const precedingBreak = context.source.text.lastIndexOf("\n", Math.max(0, valueStart - 1));
    const start = precedingBreak < 0 ? 0 : precedingBreak + 1;
    const endOfLine = context.source.text.indexOf("\n", valueStart);
    const end = endOfLine >= 0 ? endOfLine : context.source.text.length;
    searchFrom = Math.min(context.source.text.length, valueStart + encoded.length);
    const unit = makeUnit(context, {
      kind: "record",
      start,
      end,
      searchText: `${record.path}: ${record.value}`,
      displayText:
        context.source.text.slice(start, end).trim() || `${record.path}: ${record.value}`,
      symbol: record.path,
    });
    return unit ? [unit] : [];
  });
}

function lineStructuredRecords(context: ExtractorContext): ExtractedUnit[] {
  const units: ExtractedUnit[] = [];
  const yamlPath: Array<{ indent: number; key: string }> = [];
  let tomlSection = "";
  for (let index = 0; index < context.source.lines.length; index += 1) {
    const line = context.source.lines[index];
    if (!line?.text.trim() || /^\s*[#;]/u.test(line.text)) continue;
    let searchText = line.text.trim();
    let symbol: string | undefined;
    if (context.file.format === "yaml") {
      const match = line.text.match(/^(\s*)(?:-\s*)?([^:#][^:]*):(?:\s*(.*))?$/u);
      if (match?.[2]) {
        const indent = match[1]?.length ?? 0;
        while (yamlPath.at(-1) && (yamlPath.at(-1)?.indent ?? 0) >= indent) yamlPath.pop();
        yamlPath.push({ indent, key: match[2].trim() });
        symbol = yamlPath.map((entry) => entry.key).join(".");
        searchText = `${symbol}: ${match[3]?.trim() ?? ""}`.trimEnd();
      } else {
        const item = line.text.match(/^\s*-\s+(.+)$/u)?.[1];
        symbol = yamlPath.map((entry) => entry.key).join(".");
        if (item && symbol) searchText = `${symbol}[]: ${item}`;
      }
    } else if (context.file.format === "toml") {
      const section = line.text.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/u)?.[1];
      if (section) {
        tomlSection = section.trim();
        symbol = tomlSection;
      } else {
        const key = line.text.match(/^\s*([^=]+?)\s*=/u)?.[1]?.trim();
        if (key) {
          symbol = tomlSection ? `${tomlSection}.${key}` : key;
          searchText = `${symbol}: ${line.text.slice(line.text.indexOf("=") + 1).trim()}`;
        }
      }
    }
    const unit = makeUnit(context, {
      kind: "record",
      ...findLineRange(context, index),
      searchText,
      ...(symbol ? { symbol } : {}),
    });
    if (unit) units.push(unit);
  }
  return units;
}

function xmlRecords(context: ExtractorContext): ExtractedUnit[] {
  const units: ExtractedUnit[] = [];
  const pattern = /<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>([^<]+)<\/\1\s*>/gu;
  for (const match of context.source.text.matchAll(pattern)) {
    const value = match[2]?.trim();
    const symbol = match[1];
    if (!value || !symbol) continue;
    const unit = makeUnit(context, {
      kind: "record",
      start: match.index,
      end: match.index + match[0].length,
      displayText: match[0],
      searchText: `${symbol}: ${value}`,
      symbol,
    });
    if (unit) units.push(unit);
  }
  return units;
}

export const structuredDataExtractor: Extractor = {
  name: "structured-data",
  formats: ["json", "yaml", "toml", "xml"],
  extract(context) {
    let units: ExtractedUnit[] = [];
    const warnings: ExtractionWarning[] = [];
    if (context.file.format === "json") {
      try {
        units = jsonRecords(context, JSON.parse(sanitizeJsonc(context.source.text)));
      } catch {
        warnings.push({ code: "MALFORMED_SYNTAX", message: "Malformed JSON; line fallback used." });
      }
    } else if (context.file.format === "xml") {
      units = xmlRecords(context);
      if (context.source.text.trim() && units.length === 0) {
        warnings.push({
          code: "PARSER_FALLBACK",
          message: "No XML text nodes found; line fallback used.",
        });
      }
    } else {
      units = lineStructuredRecords(context);
    }
    if (units.length === 0)
      units = fallbackLineUnits(context, { kind: "record", linesPerUnit: 30 });
    return buildDocument(
      context,
      units,
      {
        language: context.file.format,
        headings: [],
        symbols: units.flatMap((unit) => (unit.symbol ? [unit.symbol] : [])),
      },
      warnings,
    );
  },
};
