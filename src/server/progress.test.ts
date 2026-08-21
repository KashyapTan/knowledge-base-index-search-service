import { describe, expect, test } from "bun:test";
import type { ApplicationStatus } from "./contracts.ts";
import { ApplicationEventHub, parseLastEventId } from "./progress.ts";

const status: ApplicationStatus = {
  startup: { phase: "ready", changedAt: 1, issues: [] },
  searchAvailable: true,
  actionInProgress: false,
  shuttingDown: false,
  csrfToken: "token",
};

async function nextText(reader: ReadableStreamDefaultReader): Promise<string> {
  const result = await reader.read();
  return new TextDecoder().decode(result.value);
}

describe("application SSE hub", () => {
  test("sends an initial snapshot and live ordered events", async () => {
    const hub = new ApplicationEventHub({ heartbeatMs: 60_000 });
    const reader = hub.stream(undefined, () => status).getReader();
    expect(await nextText(reader)).toContain("event: snapshot");
    const event = hub.publish({ type: "issue", issue: { code: "ONE", message: "first" } });
    const live = await nextText(reader);
    expect(live).toContain(`id: ${event.id}`);
    expect(live).toContain("first");
    await reader.cancel();
    hub.close();
    hub.close();
  });

  test("replays retained events and snapshots when a cursor is too old", async () => {
    const hub = new ApplicationEventHub({ historyLimit: 1, heartbeatMs: 60_000 });
    const first = hub.publish({ type: "issue", issue: { code: "ONE", message: "one" } });
    const second = hub.publish({ type: "issue", issue: { code: "TWO", message: "two" } });
    const replay = hub.stream(first.id, () => status).getReader();
    expect(await nextText(replay)).toContain(`id: ${second.id}`);
    await replay.cancel();
    const stale = hub.stream(0, () => status).getReader();
    expect(await nextText(stale)).toContain("event: snapshot");
    await stale.cancel();
    hub.close();
    const closed = hub.stream(undefined, () => status).getReader();
    expect((await closed.read()).done).toBe(true);
  });

  test("parses only safe non-negative event cursors", () => {
    expect(parseLastEventId("42")).toBe(42);
    expect(parseLastEventId(null)).toBeUndefined();
    expect(parseLastEventId("-1")).toBeUndefined();
    expect(parseLastEventId("1.5")).toBeUndefined();
    expect(parseLastEventId("999999999999999999999")).toBeUndefined();
  });

  test("keeps an idle connection alive without advancing event order", async () => {
    const hub = new ApplicationEventHub({ heartbeatMs: 10 });
    const reader = hub.stream(undefined, () => status).getReader();
    await reader.read();
    expect(await nextText(reader)).toBe(": keep-alive\n\n");
    await reader.cancel();
    hub.close();
  });
});
