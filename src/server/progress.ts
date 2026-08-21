import type {
  ApplicationEventData,
  ApplicationStatus,
  SequencedApplicationEvent,
} from "./contracts.ts";

const encoder = new TextEncoder();

function encodeEvent(event: SequencedApplicationEvent): Uint8Array {
  return encoder.encode(
    `id: ${event.id}\nevent: ${event.data.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
  );
}

interface Subscriber {
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
}

/** A bounded replay log plus live SSE fan-out for startup and indexing state. */
export class ApplicationEventHub {
  readonly #historyLimit: number;
  readonly #heartbeatMs: number;
  readonly #history: SequencedApplicationEvent[] = [];
  readonly #subscribers = new Set<Subscriber>();
  #nextId = 1;
  #closed = false;

  constructor(options: { readonly historyLimit?: number; readonly heartbeatMs?: number } = {}) {
    this.#historyLimit = Math.max(1, options.historyLimit ?? 128);
    this.#heartbeatMs = Math.max(10, options.heartbeatMs ?? 15_000);
  }

  publish(data: ApplicationEventData): SequencedApplicationEvent {
    const event = { id: this.#nextId, data } as const;
    this.#nextId += 1;
    this.#history.push(event);
    if (this.#history.length > this.#historyLimit) this.#history.shift();
    for (const subscriber of this.#subscribers) subscriber.controller.enqueue(encodeEvent(event));
    return event;
  }

  stream(lastEventId: number | undefined, snapshot: () => ApplicationStatus): ReadableStream {
    let active: Subscriber | undefined;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (this.#closed) {
          controller.close();
          return;
        }
        const oldest = this.#history[0]?.id;
        const canReplay =
          lastEventId !== undefined && oldest !== undefined && lastEventId >= oldest - 1;
        const replay = canReplay
          ? this.#history.filter((event) => event.id > lastEventId)
          : [
              {
                id: this.#nextId,
                data: { type: "snapshot", status: snapshot() } as const,
              },
            ];
        if (!canReplay) this.#nextId += 1;
        for (const event of replay) controller.enqueue(encodeEvent(event));
        active = {
          controller,
          heartbeat: setInterval(
            () => controller.enqueue(encoder.encode(": keep-alive\n\n")),
            this.#heartbeatMs,
          ),
        };
        this.#subscribers.add(active);
      },
      cancel: () => {
        if (!active) return;
        clearInterval(active.heartbeat);
        this.#subscribers.delete(active);
      },
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscriber of this.#subscribers) {
      clearInterval(subscriber.heartbeat);
      subscriber.controller.close();
    }
    this.#subscribers.clear();
  }
}

export function parseLastEventId(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
