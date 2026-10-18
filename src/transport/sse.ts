/** Shared WHATWG-stream decoder; this module also runs in browsers. */
export interface ServerEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

interface StreamOptions {
  signal?: AbortSignal;
  maxFrameChars: number;
  maxBytes?: number;
  maxFrameBytes?: number;
  emitEmptyFrames?: boolean;
  error?: (message: string) => Error;
}

/** Scan each chunk once, retaining fragments instead of rescanning growing frames. */
class EventDecoder {
  private fragments: string[] = [];
  private lineChars = 0;
  private frameChars = 0;
  private lineBytes = 0;
  private frameBytes = 0;
  private readonly encoder = new TextEncoder();
  private skipLF = false;
  private data: string[] = [];
  private event: ServerEvent = { data: "" };

  constructor(private readonly options: StreamOptions) {}

  private append(text: string): void {
    if (!text) return;
    this.lineChars += text.length;
    if (this.options.maxFrameBytes !== undefined)
      this.lineBytes += this.encoder.encode(text).length;
    if (
      this.frameChars + this.lineChars > this.options.maxFrameChars ||
      (this.options.maxFrameBytes !== undefined &&
        this.frameBytes + this.lineBytes > this.options.maxFrameBytes)
    )
      throw (this.options.error ?? ((message) => new Error(message)))(
        "SSE frame exceeds limit",
      );
    this.fragments.push(text);
  }

  private line(): ServerEvent | undefined {
    const line = this.fragments.join("");
    this.fragments = [];
    this.lineChars = 0;
    if (!line) {
      const event = this.event;
      event.data = this.data.join("\n");
      this.data = [];
      this.event = { data: "" };
      this.frameChars = 0;
      this.frameBytes = 0;
      return event.data || this.options.emitEmptyFrames ? event : undefined;
    }
    this.frameChars += line.length + 1;
    this.frameBytes += this.lineBytes + 1;
    this.lineBytes = 0;
    const colon = line.indexOf(":"),
      key = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (key === "data") this.data.push(value);
    else if (key === "event") this.event.event = value;
    else if (key === "id" && !value.includes("\0")) this.event.id = value;
    else if (key === "retry" && /^\d+$/.test(value))
      this.event.retry = Math.min(Number(value), 30000);
    return undefined;
  }

  *push(text: string): Generator<ServerEvent> {
    if (!text) return;
    let start = this.skipLF && text[0] === "\n" ? 1 : 0;
    this.skipLF = false;
    const endings = /\r\n?|\n/g;
    endings.lastIndex = start;
    for (let match = endings.exec(text); match; match = endings.exec(text)) {
      this.append(text.slice(start, match.index));
      const event = this.line();
      start = endings.lastIndex;
      this.skipLF = match[0] === "\r" && start === text.length;
      if (event) yield event;
    }
    this.append(text.slice(start));
  }

  finish(): ServerEvent | undefined {
    // Keep the existing SDK/provider contract: accept a final unterminated event.
    if (this.lineChars) this.line();
    return this.frameChars ? this.line() : undefined;
  }
}

export async function* decodeEventStream(
  body: ReadableStream<Uint8Array>,
  options: StreamOptions,
): AsyncGenerator<ServerEvent> {
  const reader = body.getReader(),
    decoder = new TextDecoder(),
    events = new EventDecoder(options),
    abort = () => {
      void reader.cancel(options.signal?.reason).catch(() => undefined);
    };
  options.signal?.addEventListener("abort", abort, { once: true });
  let bytes = 0;
  try {
    while (true) {
      options.signal?.throwIfAborted();
      const { value, done } = await reader.read();
      options.signal?.throwIfAborted();
      if (done) {
        for (const event of events.push(decoder.decode())) {
          options.signal?.throwIfAborted();
          yield event;
        }
        options.signal?.throwIfAborted();
        const last = events.finish();
        if (last) yield last;
        return;
      }
      bytes += value.byteLength;
      if (options.maxBytes !== undefined && bytes > options.maxBytes)
        throw (options.error ?? ((message) => new Error(message)))(
          "SSE stream exceeds byte limit",
        );
      for (const event of events.push(
        decoder.decode(value, { stream: true }),
      )) {
        options.signal?.throwIfAborted();
        yield event;
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
