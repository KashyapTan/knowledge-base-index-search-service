import type {
  ExtractedUnit,
  ExtractionWarning,
  Extractor,
  ExtractorContext,
} from "../contracts.ts";
import { buildDocument, fallbackLineUnits, lineSpan, makeUnit } from "./shared.ts";

interface Declaration {
  readonly line: number;
  readonly indent: number;
  readonly symbol: string;
}

function leadingIndent(line: string): number {
  return line.match(/^\s*/u)?.[0].replaceAll("\t", "    ").length ?? 0;
}

function pythonDeclarations(context: ExtractorContext): Declaration[] {
  const declarations: Declaration[] = [];
  for (let index = 0; index < context.source.lines.length; index += 1) {
    const text = context.source.lines[index]?.text ?? "";
    const match = text.match(/^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/u);
    if (match?.[1])
      declarations.push({ line: index, indent: leadingIndent(text), symbol: match[1] });
  }
  return declarations;
}

function javascriptDeclarations(context: ExtractorContext): Declaration[] {
  const declarations: Declaration[] = [];
  const declarationPattern =
    /^\s*(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function\s+|class\s+|interface\s+|type\s+|enum\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/u;
  for (let index = 0; index < context.source.lines.length; index += 1) {
    const text = context.source.lines[index]?.text ?? "";
    const match = text.match(declarationPattern);
    if (match?.[1] && leadingIndent(text) === 0)
      declarations.push({ line: index, indent: leadingIndent(text), symbol: match[1] });
  }
  return declarations;
}

function delimitersBalanced(text: string): boolean {
  const stack: string[] = [];
  const pairs: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (lineComment) {
      if (current === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (current === '"' || current === "'" || current === "`") {
      quote = current;
    } else if (current === "(" || current === "[" || current === "{") {
      stack.push(current);
    } else if (current in pairs && stack.pop() !== pairs[current]) {
      return false;
    }
  }
  return stack.length === 0 && !quote && !blockComment;
}

function declarationUnits(
  context: ExtractorContext,
  declarations: readonly Declaration[],
): ExtractedUnit[] {
  const units: ExtractedUnit[] = [];
  let preambleEnd = declarations[0]?.line ?? context.source.lines.length;
  while (preambleEnd > 0 && context.source.lines[preambleEnd - 1]?.text.trim() === "")
    preambleEnd -= 1;
  if (preambleEnd > 0) {
    const span = lineSpan(context, 0, preambleEnd - 1);
    const unit = makeUnit(context, { kind: "comment", ...span });
    if (unit) units.push(unit);
  }
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    if (!declaration) continue;
    let startLine = declaration.line;
    while (
      startLine > 0 &&
      /^\s*(?:@|\/\/|#)/u.test(context.source.lines[startLine - 1]?.text ?? "")
    ) {
      startLine -= 1;
    }
    const nextDeclaration = declarations[index + 1];
    let endLine = nextDeclaration ? nextDeclaration.line - 1 : context.source.lines.length - 1;
    while (endLine > startLine && context.source.lines[endLine]?.text.trim() === "") endLine -= 1;
    const span = lineSpan(context, startLine, endLine);
    const unit = makeUnit(context, {
      kind: "declaration",
      ...span,
      symbol: declaration.symbol,
    });
    if (unit) units.push(unit);
  }
  return units;
}

export const pythonExtractor: Extractor = {
  name: "python-structure",
  formats: ["python"],
  extract(context) {
    const tripleDouble = context.source.text.match(/"""/gu)?.length ?? 0;
    const tripleSingle = context.source.text.match(/'''/gu)?.length ?? 0;
    const malformed = tripleDouble % 2 !== 0 || tripleSingle % 2 !== 0;
    const declarations = malformed ? [] : pythonDeclarations(context);
    const warnings: ExtractionWarning[] = malformed
      ? [{ code: "MALFORMED_SYNTAX", message: "Unclosed Python string; line fallback used." }]
      : declarations.length === 0 && context.source.text.trim()
        ? [
            {
              code: "PARSER_FALLBACK",
              message: "No Python declarations found; line fallback used.",
            },
          ]
        : [];
    const units =
      declarations.length > 0
        ? declarationUnits(context, declarations)
        : fallbackLineUnits(context, { kind: "code", linesPerUnit: 40 });
    return buildDocument(
      context,
      units,
      {
        language: "python",
        headings: [],
        symbols: declarations.map((item) => item.symbol),
      },
      warnings,
    );
  },
};

export const javascriptExtractor: Extractor = {
  name: "javascript-typescript-structure",
  formats: ["javascript", "typescript"],
  extract(context) {
    const malformed = !delimitersBalanced(context.source.text);
    const declarations = malformed ? [] : javascriptDeclarations(context);
    const warnings: ExtractionWarning[] = malformed
      ? [
          {
            code: "MALFORMED_SYNTAX",
            message: "Unbalanced JavaScript/TypeScript syntax; line fallback used.",
          },
        ]
      : declarations.length === 0 && context.source.text.trim()
        ? [{ code: "PARSER_FALLBACK", message: "No declarations found; line fallback used." }]
        : [];
    const units =
      declarations.length > 0
        ? declarationUnits(context, declarations)
        : fallbackLineUnits(context, { kind: "code", linesPerUnit: 40 });
    return buildDocument(
      context,
      units,
      {
        language: context.file.extension.includes("ts") ? "typescript" : "javascript",
        headings: [],
        symbols: declarations.map((item) => item.symbol),
      },
      warnings,
    );
  },
};

function otherDeclarations(context: ExtractorContext): Declaration[] {
  const patterns =
    context.file.format === "shell"
      ? [/^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)\s*\{/u]
      : context.file.format === "sql"
        ? [
            /^\s*(?:create|alter)\s+(?:or\s+replace\s+)?(?:function|procedure|table|view)\s+([^\s(]+)/iu,
          ]
        : [/^\s*([^@/][^{]+)\s*\{/u, /^\s*@(?:media|supports|keyframes)\s+([^\s{]+)/u];
  const output: Declaration[] = [];
  for (let index = 0; index < context.source.lines.length; index += 1) {
    const text = context.source.lines[index]?.text ?? "";
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        output.push({ line: index, indent: leadingIndent(text), symbol: match[1].trim() });
        break;
      }
    }
  }
  return output;
}

export const otherSourceExtractor: Extractor = {
  name: "shell-sql-styles",
  formats: ["shell", "sql", "stylesheet"],
  extract(context) {
    const declarations = otherDeclarations(context);
    const units =
      declarations.length > 0
        ? declarationUnits(context, declarations)
        : fallbackLineUnits(context, { kind: "code", linesPerUnit: 40 });
    return buildDocument(context, units, {
      language: context.file.format,
      headings: [],
      symbols: declarations.map((item) => item.symbol),
    });
  },
};
