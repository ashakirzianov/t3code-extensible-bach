/**
 * A minimal client for the host's RPC-over-WebSocket protocol.
 *
 * The host serves Effect RPC with `RpcSerialization.layerJson`
 * (`apps/server/src/ws.ts`), which means: one JSON value per WebSocket frame,
 * and a frame may be either a single message or an array of them. This file is
 * the whole wire contract an extension needs — deliberately hand-written with
 * no Effect dependency, because an extension is a separate process that may be
 * written in any language and must not need the host's toolchain.
 *
 * Client -> host frames:
 *   {"_tag":"Request","id":<n>,"tag":"<method>","payload":<value>,"headers":[]}
 *   {"_tag":"Ack","requestId":<n>}          // request one more chunk of a stream
 *   {"_tag":"Interrupt","requestId":<n>}    // cancel a request or stream
 *   {"_tag":"Ping"}
 *
 * Host -> client frames:
 *   {"_tag":"Exit","requestId":<n>,"exit":{"_tag":"Success","value":<v>}}
 *   {"_tag":"Exit","requestId":<n>,"exit":{"_tag":"Failure","cause":[...]}}
 *   {"_tag":"Chunk","requestId":<n>,"values":[<v>, ...]}   // one stream batch
 *   {"_tag":"Defect","defect":<v>} | {"_tag":"Pong"} | {"_tag":"ClientProtocolError","error":<v>}
 *
 * Streams are pull-based: the host sends a `Chunk` only after the client has
 * acknowledged the previous one. Forgetting the `Ack` is the classic way to
 * make a stream look dead after exactly one event.
 */
import { WebSocket } from "ws";

export type RpcRequestId = number;

/** A `Failure` exit turned into a throwable, keeping the host's typed error intact. */
export class RpcCallError extends Error {
  constructor(
    readonly method: string,
    readonly cause: unknown,
  ) {
    super(`${method} failed: ${JSON.stringify(cause)}`);
    this.name = "RpcCallError";
  }
}

export class RpcConnectionClosedError extends Error {
  constructor(readonly code?: number) {
    super(`Host connection closed${code === undefined ? "" : ` (code ${String(code)})`}.`);
    this.name = "RpcConnectionClosedError";
  }
}

interface PendingCall {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface StreamSubscription {
  readonly onValue: (value: unknown) => void;
  readonly onEnd: (error: unknown) => void;
}

export interface RpcClientOptions {
  readonly url: string;
  readonly token: string;
  /** Called for every stream/connection failure; the caller decides whether to retry. */
  readonly onClose: (error: RpcConnectionClosedError) => void;
}

export class RpcClient {
  #socket: WebSocket;
  #nextId: RpcRequestId = 1;
  #calls = new Map<RpcRequestId, PendingCall>();
  #streams = new Map<RpcRequestId, StreamSubscription>();
  #closed = false;

  private constructor(
    socket: WebSocket,
    private readonly onClose: RpcClientOptions["onClose"],
  ) {
    this.#socket = socket;
    socket.on("message", (raw: Buffer | string) => this.#receive(raw.toString()));
    socket.on("close", (code: number) => this.#fail(new RpcConnectionClosedError(code)));
    socket.on("error", (error: Error) => this.#fail(error));
  }

  /**
   * The token rides as an `Authorization` header on the handshake. Browsers
   * cannot set handshake headers and use the host's ticket query parameter
   * instead; a spawned extension is not a browser, so it takes the simpler path.
   */
  static connect(options: RpcClientOptions): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(options.url, {
        headers: { authorization: `Bearer ${options.token}` },
      });
      const onError = (error: Error) => reject(error);
      socket.once("error", onError);
      socket.once("open", () => {
        socket.off("error", onError);
        resolve(new RpcClient(socket, options.onClose));
      });
    });
  }

  /** One request, one `Exit`. Rejects with `RpcCallError` on a typed failure. */
  call<Result>(method: string, payload: unknown): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      if (this.#closed) return reject(new RpcConnectionClosedError());
      const id = this.#nextId++;
      this.#calls.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      this.#send({ _tag: "Request", id, tag: method, payload, headers: [] });
    });
  }

  /**
   * Subscribes to a streaming method. Returns the request id so the caller can
   * `interrupt` it. Each delivered value is acknowledged immediately, which is
   * what keeps the host sending.
   */
  stream(
    method: string,
    payload: unknown,
    onValue: (value: unknown) => void,
    onEnd: (error: unknown) => void,
  ): RpcRequestId {
    const id = this.#nextId++;
    this.#streams.set(id, { onValue, onEnd });
    this.#send({ _tag: "Request", id, tag: method, payload, headers: [] });
    return id;
  }

  interrupt(requestId: RpcRequestId): void {
    this.#streams.delete(requestId);
    this.#send({ _tag: "Interrupt", requestId });
  }

  close(): void {
    this.#closed = true;
    this.#socket.close();
  }

  #send(message: unknown): void {
    if (this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(message));
    }
  }

  #receive(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // A frame we cannot parse is the host's problem, not a reason to die.
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      this.#handle(message as Record<string, unknown>);
    }
  }

  #handle(message: Record<string, unknown>): void {
    switch (message._tag) {
      case "Exit": {
        const id = message.requestId as RpcRequestId;
        const exit = message.exit as { _tag: string; value?: unknown; cause?: unknown };
        const call = this.#calls.get(id);
        if (call) {
          this.#calls.delete(id);
          if (exit._tag === "Success") call.resolve(exit.value);
          else call.reject(new RpcCallError(call.method, exit.cause));
          return;
        }
        // A stream's Exit is its end: clean for Success, an error otherwise.
        const stream = this.#streams.get(id);
        if (stream) {
          this.#streams.delete(id);
          stream.onEnd(
            exit._tag === "Success" ? undefined : new RpcCallError("stream", exit.cause),
          );
        }
        return;
      }
      case "Chunk": {
        const id = message.requestId as RpcRequestId;
        const stream = this.#streams.get(id);
        if (!stream) return;
        for (const value of message.values as ReadonlyArray<unknown>) stream.onValue(value);
        // Pull the next batch. Without this the stream stalls after one chunk.
        this.#send({ _tag: "Ack", requestId: id });
        return;
      }
      case "Ping":
        this.#send({ _tag: "Pong" });
        return;
      default:
        return; // Pong, Defect, ClientProtocolError: nothing useful to do here.
    }
  }

  #fail(error: unknown): void {
    const closed =
      error instanceof RpcConnectionClosedError ? error : new RpcConnectionClosedError();
    for (const [, call] of this.#calls) call.reject(closed);
    this.#calls.clear();
    for (const [, stream] of this.#streams) stream.onEnd(closed);
    this.#streams.clear();
    if (!this.#closed) {
      this.#closed = true;
      this.onClose(closed);
    }
  }
}
