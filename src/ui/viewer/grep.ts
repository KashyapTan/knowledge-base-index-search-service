export interface GrepOptions {
  readonly query: string;
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  readonly maximumMatches?: number;
}

export interface GrepMatch {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export interface GrepResult {
  readonly matches: readonly GrepMatch[];
  readonly error?: string;
  readonly limited: boolean;
}

const DEFAULT_MAXIMUM_MATCHES = 20_000;
const MAXIMUM_REGEX_LENGTH = 512;
const nestedQuantifier = /\((?:[^()\\]|\\.)*[*+{](?:[^()\\]|\\.)*\)\s*[*+{]/u;
const numericBackreference = /(^|[^\\])(?:\\\\)*\\[1-9]/u;

function regexSafetyError(pattern: string): string | undefined {
  if (pattern.length > MAXIMUM_REGEX_LENGTH) {
    return "The regular expression is too long to run safely.";
  }
  if (nestedQuantifier.test(pattern) || numericBackreference.test(pattern)) {
    return "The regular expression uses a potentially unsafe backtracking construct.";
  }
  return undefined;
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function sourcePosition(
  starts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((starts[middle] ?? 0) <= offset) low = middle + 1;
    else high = middle;
  }
  const lineIndex = Math.max(0, low - 1);
  return { line: lineIndex + 1, column: offset - (starts[lineIndex] ?? 0) + 1 };
}

function appendMatch(
  matches: GrepMatch[],
  starts: readonly number[],
  start: number,
  end: number,
): void {
  matches.push({ start, end, ...sourcePosition(starts, start) });
}

function nextCodePointOffset(content: string, offset: number): number {
  if (offset >= content.length) return content.length + 1;
  const point = content.codePointAt(offset);
  return offset + (point !== undefined && point > 0xffff ? 2 : 1);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function runGrep(content: string, options: GrepOptions): GrepResult {
  if (options.query.length === 0) return { matches: [], limited: false };
  const maximum = Math.max(1, options.maximumMatches ?? DEFAULT_MAXIMUM_MATCHES);
  const starts = lineStarts(content);
  const matches: GrepMatch[] = [];
  let limited = false;

  if (!options.regex) {
    if (!options.caseSensitive) {
      const expression = new RegExp(`(?=(${escapeRegularExpression(options.query)}))`, "giu");
      while (true) {
        const match = expression.exec(content);
        if (!match) break;
        const value = match[1] ?? "";
        appendMatch(matches, starts, match.index, match.index + value.length);
        if (matches.length >= maximum) {
          limited = true;
          break;
        }
        expression.lastIndex = nextCodePointOffset(content, match.index);
      }
      return { matches, limited };
    }
    const haystack = content;
    const needle = options.query;
    let offset = 0;
    while (offset <= haystack.length - needle.length) {
      const found = haystack.indexOf(needle, offset);
      if (found < 0) break;
      appendMatch(matches, starts, found, found + needle.length);
      if (matches.length >= maximum) {
        limited = haystack.indexOf(needle, found + 1) >= 0;
        break;
      }
      // Advancing one UTF-16 unit deliberately permits overlapping literal matches.
      offset = found + 1;
    }
    return { matches, limited };
  }

  let expression: RegExp;
  const safetyError = regexSafetyError(options.query);
  if (safetyError) return { matches: [], error: safetyError, limited: false };
  try {
    expression = new RegExp(options.query, options.caseSensitive ? "gu" : "giu");
  } catch {
    return { matches: [], error: "The regular expression is invalid.", limited: false };
  }
  while (true) {
    const match = expression.exec(content);
    if (!match) break;
    appendMatch(matches, starts, match.index, match.index + match[0].length);
    if (matches.length >= maximum) {
      limited = true;
      break;
    }
    if (match[0].length === 0) expression.lastIndex = nextCodePointOffset(content, match.index);
  }
  return { matches, limited };
}

export function wrappedMatchIndex(current: number, count: number, delta: -1 | 1): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

export function matchIndexNearestLine(matches: readonly GrepMatch[], line: number): number {
  if (matches.length === 0) return -1;
  const found = matches.findIndex((match) => match.line >= line);
  return found < 0 ? matches.length - 1 : found;
}

export type GrepExecutor = (
  content: string,
  options: GrepOptions,
  signal: AbortSignal,
) => Promise<GrepResult>;

export class GrepCoordinator {
  readonly #executor: GrepExecutor;
  #controller: AbortController | undefined;
  #generation = 0;

  constructor(executor: GrepExecutor) {
    this.#executor = executor;
  }

  async search(content: string, options: GrepOptions): Promise<GrepResult | undefined> {
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    const generation = ++this.#generation;
    try {
      const result = await this.#executor(content, options, controller.signal);
      return controller.signal.aborted || generation !== this.#generation ? undefined : result;
    } catch (error) {
      if (controller.signal.aborted || generation !== this.#generation) return undefined;
      throw error;
    }
  }

  cancel(): void {
    this.#generation += 1;
    this.#controller?.abort();
  }
}
