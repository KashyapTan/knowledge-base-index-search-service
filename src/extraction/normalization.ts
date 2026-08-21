import type {
  ExtractionWarning,
  NormalizedLine,
  NormalizedSource,
  SourceRange,
} from "./contracts.ts";

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function normalizeSourceText(input: string): NormalizedSource {
  let text = "";
  const boundaries: number[] = [0];
  let invalidUnicode = false;
  let lineEndingsChanged = false;

  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 0x0d) {
      const width = input.charCodeAt(index + 1) === 0x0a ? 2 : 1;
      text += "\n";
      index += width - 1;
      boundaries.push(index + 1);
      lineEndingsChanged = true;
      continue;
    }
    if (isHighSurrogate(code)) {
      if (isLowSurrogate(input.charCodeAt(index + 1))) {
        text += input.slice(index, index + 2);
        boundaries.push(index + 1, index + 2);
        index += 1;
      } else {
        text += "\ufffd";
        boundaries.push(index + 1);
        invalidUnicode = true;
      }
      continue;
    }
    if (isLowSurrogate(code)) {
      text += "\ufffd";
      boundaries.push(index + 1);
      invalidUnicode = true;
      continue;
    }
    text += input[index];
    boundaries.push(index + 1);
  }

  const lines: NormalizedLine[] = [];
  let lineStart = 0;
  let lineNumber = 1;
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && text[index] !== "\n") continue;
    lines.push({
      number: lineNumber,
      text: text.slice(lineStart, index),
      start: lineStart,
      end: index,
      endIncludingBreak: index < text.length ? index + 1 : index,
    });
    lineStart = index + 1;
    lineNumber += 1;
  }

  const warnings: ExtractionWarning[] = [];
  if (invalidUnicode) {
    warnings.push({
      code: "INVALID_UNICODE_REPLACED",
      message: "Unpaired Unicode surrogate code units were replaced with U+FFFD.",
    });
  }
  if (lineEndingsChanged) {
    warnings.push({
      code: "LINE_ENDINGS_NORMALIZED",
      message: "CRLF or CR line endings were normalized to LF for extraction.",
    });
  }

  function toOriginalOffset(normalizedOffset: number): number {
    const safeOffset = Math.max(0, Math.min(text.length, Math.floor(normalizedOffset)));
    return boundaries[safeOffset] ?? input.length;
  }

  function range(start: number, end: number): SourceRange {
    const safeStart = Math.max(0, Math.min(text.length, Math.floor(start)));
    const safeEnd = Math.max(safeStart, Math.min(text.length, Math.floor(end)));
    let startLine = 1;
    let endLine = 1;
    for (const line of lines) {
      if (line.start <= safeStart) startLine = line.number;
      if (line.start < safeEnd || (safeEnd === 0 && line.number === 1)) endLine = line.number;
    }
    return {
      startLine,
      endLine,
      startOffset: toOriginalOffset(safeStart),
      endOffset: toOriginalOffset(safeEnd),
    };
  }

  return {
    text,
    originalLength: input.length,
    lines,
    warnings,
    toOriginalOffset,
    range,
  };
}
