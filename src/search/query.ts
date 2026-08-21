import { err, ok, type Result } from "../shared/result.ts";
import type {
  NormalizedSearchRequest,
  SearchConfig,
  SearchError,
  SearchRequest,
} from "./contracts.ts";

const FORMAT_PATTERN = /^[a-z0-9][a-z0-9+._-]{0,63}$/u;

export function normalizeSearchRequest(
  request: SearchRequest,
  config: SearchConfig,
): Result<NormalizedSearchRequest, SearchError> {
  const query = request.query.trim();
  if (!query) {
    return err({ code: "SEARCH_QUERY_INVALID", message: "The search query must not be empty." });
  }
  if (query.length > config.maxQueryLength) {
    return err({
      code: "SEARCH_QUERY_INVALID",
      message: `The search query must contain at most ${config.maxQueryLength} characters.`,
    });
  }

  const fileCount = request.fileCount ?? config.defaultFileCount;
  if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > config.maxFileCount) {
    return err({
      code: "SEARCH_REQUEST_INVALID",
      message: `The requested file count must be an integer from 1 through ${config.maxFileCount}.`,
    });
  }

  const formats: string[] = [];
  for (const input of request.formats ?? []) {
    const format = input.trim().toLowerCase();
    if (!FORMAT_PATTERN.test(format)) {
      return err({
        code: "SEARCH_REQUEST_INVALID",
        message: "Every format filter must be a short format identifier.",
      });
    }
    if (!formats.includes(format)) formats.push(format);
    if (formats.length > config.maxFormatFilters) {
      return err({
        code: "SEARCH_REQUEST_INVALID",
        message: `At most ${config.maxFormatFilters} format filters may be supplied.`,
      });
    }
  }

  return ok({ query, fileCount, formats });
}

export function quotedPhrases(query: string): readonly string[] {
  const phrases: string[] = [];
  const pattern = /"([^"\r\n]+)"/gu;
  for (const match of query.matchAll(pattern)) {
    const phrase = match[1]?.trim();
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }
  return phrases;
}

export function queryTerms(query: string): readonly string[] {
  const terms: string[] = [];
  const add = (value: string) => {
    const trimmed = value.trim();
    if (
      trimmed.length >= 2 &&
      !terms.some((term) => term.toLowerCase() === trimmed.toLowerCase())
    ) {
      terms.push(trimmed);
    }
  };
  for (const phrase of quotedPhrases(query)) add(phrase);
  for (const match of query.matchAll(/[\p{L}\p{N}_./:@-]+/gu)) add(match[0]);
  return terms;
}
