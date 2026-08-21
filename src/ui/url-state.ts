export const DEFAULT_FILE_COUNT = 10;
export const MIN_FILE_COUNT = 1;
export const MAX_FILE_COUNT = 50;
const FILE_ID_PATTERN = /^[a-f0-9]{64}$/u;

export interface BrowserUrlState {
  readonly query: string;
  readonly fileCount: number;
  readonly selectedFileId?: string;
  readonly selectedLine?: number;
}

export function readUrlState(url: URL): BrowserUrlState {
  const parsedCount = Number(url.searchParams.get("n"));
  const fileCount =
    Number.isInteger(parsedCount) && parsedCount >= MIN_FILE_COUNT && parsedCount <= MAX_FILE_COUNT
      ? parsedCount
      : DEFAULT_FILE_COUNT;
  const candidateFileId = url.searchParams.get("file") ?? "";
  const parsedLine = Number(url.searchParams.get("line"));
  return {
    query: url.searchParams.get("q") ?? "",
    fileCount,
    ...(FILE_ID_PATTERN.test(candidateFileId) ? { selectedFileId: candidateFileId } : {}),
    ...(Number.isInteger(parsedLine) && parsedLine > 0 ? { selectedLine: parsedLine } : {}),
  };
}

export function searchUrl(current: URL, query: string, fileCount: number): URL {
  const next = new URL(current);
  if (query.length > 0) next.searchParams.set("q", query);
  else next.searchParams.delete("q");
  if (fileCount === DEFAULT_FILE_COUNT) next.searchParams.delete("n");
  else next.searchParams.set("n", String(fileCount));
  return next;
}

export function selectedFileUrl(current: URL, fileId: string, line?: number): URL {
  const next = new URL(current);
  next.searchParams.set("file", fileId);
  if (line === undefined) next.searchParams.delete("line");
  else next.searchParams.set("line", String(line));
  return next;
}

export function withoutSelectedFile(current: URL): URL {
  const next = new URL(current);
  next.searchParams.delete("file");
  next.searchParams.delete("line");
  return next;
}
