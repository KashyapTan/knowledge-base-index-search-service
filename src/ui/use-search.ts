import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchResponse } from "../search/index.ts";
import type { KbissApi } from "./api.ts";
import { readUrlState, searchUrl } from "./url-state.ts";

export type SearchPhase = "idle" | "loading" | "success" | "error";

export interface SearchViewState {
  readonly draft: string;
  readonly fileCount: number;
  readonly phase: SearchPhase;
  readonly response: SearchResponse | undefined;
  readonly error: string | undefined;
}

export interface SearchController extends SearchViewState {
  setDraft(value: string): void;
  setFileCount(value: number): void;
  submitNow(): void;
}

export interface UseSearchOptions {
  readonly api: KbissApi;
  readonly enabled: boolean;
  readonly debounceMs?: number;
}

function initialState(): SearchViewState {
  const urlState = readUrlState(new URL(window.location.href));
  return {
    draft: urlState.query,
    fileCount: urlState.fileCount,
    phase: "idle",
    response: undefined,
    error: undefined,
  };
}

export function useSearch({ api, enabled, debounceMs = 250 }: UseSearchOptions): SearchController {
  const [state, setState] = useState<SearchViewState>(initialState);
  const stateRef = useRef(state);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const generationRef = useRef(0);
  const lastAutomaticKeyRef = useRef("");
  stateRef.current = state;
  const { draft, fileCount } = state;

  const updateUrl = useCallback((query: string, fileCount: number): void => {
    const next = searchUrl(new URL(window.location.href), query, fileCount);
    window.history.replaceState(window.history.state, "", next);
  }, []);

  const runSearch = useCallback(
    async (query: string, fileCount: number): Promise<void> => {
      if (!enabled || query.trim().length === 0) return;
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      const generation = ++generationRef.current;
      lastAutomaticKeyRef.current = `${query}\u0000${fileCount}`;
      updateUrl(query, fileCount);
      setState((current) => ({
        ...current,
        phase: "loading",
        error: undefined,
      }));
      try {
        const response = await api.search({ query, fileCount }, controller.signal);
        if (controller.signal.aborted || generation !== generationRef.current) return;
        setState((current) => ({ ...current, phase: "success", response, error: undefined }));
      } catch (error: unknown) {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        setState((current) => ({
          ...current,
          phase: "error",
          error: error instanceof Error ? error.message : "Search could not be completed.",
        }));
      }
    },
    [api, enabled, updateUrl],
  );

  useEffect(() => {
    const onPopState = (): void => {
      const urlState = readUrlState(new URL(window.location.href));
      setState((current) => ({
        ...current,
        draft: urlState.query,
        fileCount: urlState.fileCount,
      }));
      lastAutomaticKeyRef.current = "";
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (draft.trim().length === 0) {
      requestRef.current?.abort();
      generationRef.current += 1;
      lastAutomaticKeyRef.current = "";
      updateUrl("", fileCount);
      setState((current) =>
        current.phase === "idle" && current.response === undefined
          ? current
          : { ...current, phase: "idle", response: undefined, error: undefined },
      );
      return;
    }
    if (!enabled) {
      requestRef.current?.abort();
      generationRef.current += 1;
      return;
    }
    const key = `${draft}\u0000${fileCount}`;
    if (key === lastAutomaticKeyRef.current) return;
    timerRef.current = setTimeout(() => void runSearch(draft, fileCount), debounceMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [draft, fileCount, enabled, debounceMs, runSearch, updateUrl]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      requestRef.current?.abort();
    },
    [],
  );

  const setDraft = useCallback((draft: string) => {
    setState((current) => ({ ...current, draft }));
  }, []);
  const setFileCount = useCallback((fileCount: number) => {
    setState((current) => ({ ...current, fileCount }));
  }, []);
  const submitNow = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    void runSearch(stateRef.current.draft, stateRef.current.fileCount);
  }, [runSearch]);

  return { ...state, setDraft, setFileCount, submitNow };
}
