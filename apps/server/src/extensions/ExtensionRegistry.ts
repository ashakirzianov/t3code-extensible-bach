/**
 * The extension registry: what the host knows about every extension in this
 * environment, and the broker that carries calls to the running ones.
 *
 * One service rather than two because there is one piece of state. A tool
 * invocation has to find the connection, the connection has to find its
 * record, and Settings has to read both — splitting them would mean two
 * services sharing a ref, which is the same state with a seam through it.
 *
 * Three rules shape the design, all from the MCP spike
 * (`docs/internals/extensions/spikes/mcp-client-behaviour.md`):
 *
 * - **Registrations outlive the process.** A tool registered by an extension
 *   that later stops stays in the catalogue and answers with
 *   `ExtensionUnavailableError`. Removing it would be invisible to a live
 *   agent, whose provider cached the catalogue at connect; an error is legible.
 * - **A redeploy rebinds the same names.** Registering again replaces the
 *   previous set, and the tools the new build kept keep working mid-session.
 * - **The badge survives a reconnect**, so a restart does not blank the nav
 *   entry the user was reading. It is cleared when the extension stops.
 */
import {
  EXTENSION_LOG_BUFFER_LINES,
  ExtensionToolNameCollisionError,
  EXTENSION_SUPPORTED_PROTOCOL_VERSIONS,
  EXTENSION_WS_METHODS,
  extensionHttpBasePath,
  ExtensionHandshakeRequiredError,
  ExtensionHttpPrefixCollisionError,
  ExtensionNotFoundError,
  ExtensionProtocolMismatchError,
  ExtensionResourceUriCollisionError,
  ExtensionUnavailableError,
  ExtensionUnknownResourceError,
  ExtensionUnknownToolError,
  negotiateExtensionProtocolVersion,
  type EnvironmentId,
  type ExtensionBadge,
  type ExtensionHelloAck,
  type ExtensionHelloInput,
  type ExtensionHttpPrefix,
  type ExtensionHttpRequest,
  type ExtensionHttpResponse,
  type ExtensionListResult,
  type ExtensionLogEntry,
  type ExtensionLogsInput,
  type ExtensionLogsResult,
  type ExtensionManifest,
  type ExtensionName,
  type ExtensionReadResourceResult,
  type ExtensionRegisterHttpPrefixInput,
  type ExtensionRegisterHttpPrefixResult,
  type ExtensionRegisterResourcesInput,
  type ExtensionRegisterResourcesResult,
  type ExtensionRegisterToolsInput,
  type ExtensionRegisterToolsResult,
  type ExtensionRejection,
  type ExtensionRegisterWebEntryInput,
  type ExtensionResourceDefinition,
  type ExtensionResourceRegistration,
  type ExtensionResourceUri,
  type ExtensionRuntimeState,
  type ExtensionSetBadgeInput,
  type ExtensionSource,
  type ExtensionStatus,
  type ExtensionStreamEvent,
  type ExtensionToolCaller,
  type ExtensionToolContent,
  type ExtensionToolDefinition,
  type ExtensionToolName,
  type ExtensionToolRegistration,
  type ExtensionToolResult,
  type ExtensionToolsForThreadResult,
  type ExtensionWebEntry,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { EXTENSION_SUBJECT_PREFIX } from "./ExtensionIdentity.ts";
import type { ResolvedExtensionSource } from "./ExtensionSources.ts";

/** How long a brokered call waits before the caller is told the extension is silent. */
export const EXTENSION_CALL_TIMEOUT_MS = 30_000;

/** Names the host keeps for itself, so an extension cannot shadow a core route. */
const RESERVED_HTTP_PREFIXES = new Set(["api", "ws", "mcp", "oauth", "assets", "ext", "pair"]);

export interface ExtensionToolOwner {
  readonly extensionName: ExtensionName;
  readonly definition: ExtensionToolDefinition;
}

export interface ExtensionResourceOwner {
  readonly extensionName: ExtensionName;
  readonly definition: ExtensionResourceDefinition;
}

/** One extension's standing guidance, in the order the extensions started. */
export interface ExtensionInstructions {
  readonly extensionName: ExtensionName;
  readonly instructions: string;
}

export interface ExtensionConnectionInput {
  readonly name: ExtensionName;
  /** The authenticated session's subject, so a token cannot answer for another extension. */
  readonly subject?: string;
}

interface ExtensionConnection {
  readonly connectionId: string;
  readonly queue: Queue.Queue<ExtensionStreamEvent>;
}

/**
 * One in-flight host-to-extension call. Discriminated rather than generic so a
 * response can only settle a call of its own kind, with no cast anywhere.
 */
type PendingCall =
  | {
      readonly kind: "tool";
      readonly connectionId: string;
      readonly deferred: Deferred.Deferred<ExtensionToolResult, ExtensionUnavailableError>;
    }
  | {
      readonly kind: "http";
      readonly connectionId: string;
      readonly deferred: Deferred.Deferred<ExtensionHttpResponse, ExtensionUnavailableError>;
    }
  | {
      readonly kind: "tools";
      readonly connectionId: string;
      readonly deferred: Deferred.Deferred<
        ExtensionToolsForThreadResult,
        ExtensionUnavailableError
      >;
    }
  | {
      readonly kind: "resource";
      readonly connectionId: string;
      readonly deferred: Deferred.Deferred<ExtensionReadResourceResult, ExtensionUnavailableError>;
    };

interface ExtensionRecord {
  readonly name: ExtensionName;
  readonly path: string;
  readonly source: ExtensionSource;
  readonly enabled: boolean;
  readonly state: ExtensionRuntimeState;
  readonly manifest?: ExtensionManifest;
  readonly folderHash?: string;
  readonly runningHash?: string;
  readonly lastError?: string;
  readonly restartCount: number;
  readonly logs: ReadonlyArray<ExtensionLogEntry>;
  readonly tools: ReadonlyArray<ExtensionToolDefinition>;
  readonly resources: ReadonlyArray<ExtensionResourceDefinition>;
  /**
   * Standing guidance this registration declared, appended to the MCP server's
   * instructions. Absent when the registration carried none.
   */
  readonly instructions?: string;
  /** This registration asked to answer `toolsForThread` for every thread. */
  readonly filterToolsPerThread: boolean;
  /** What this registration asked for and did not get. Cleared on restart. */
  readonly rejections: ReadonlyArray<ExtensionRejection>;
  readonly httpPrefix?: ExtensionHttpPrefix;
  readonly web?: ExtensionWebEntry;
  readonly badge?: ExtensionBadge;
  readonly connection?: ExtensionConnection;
  readonly helloAcked: boolean;
}

interface RegistryState {
  /** Insertion-ordered: start order settles tool-name collisions (design §5.2). */
  readonly records: ReadonlyMap<ExtensionName, ExtensionRecord>;
  readonly pending: ReadonlyMap<string, PendingCall>;
  readonly callSequence: number;
  /** False until the supervisor has finished resolving settings and flags. */
  readonly sourcesResolved: boolean;
}

/**
 * Readiness for the MCP catalogue: every enabled extension has either
 * connected or given up. A crashed or stopped one counts as settled — waiting
 * on it would hold every agent session hostage to a broken build.
 */
const isReady = (state: RegistryState): boolean => {
  if (!state.sourcesResolved) return false;
  for (const record of state.records.values()) {
    if (!record.enabled) continue;
    if (record.connection !== undefined) continue;
    if (record.state === "crashed" || record.state === "stopped") continue;
    return false;
  }
  return true;
};

export interface ExtensionRegistryShape {
  // --- protocol, extension to host -----------------------------------------
  readonly hello: (
    input: ExtensionHelloInput & ExtensionConnectionInput,
  ) => Effect.Effect<ExtensionHelloAck, ExtensionProtocolMismatchError | ExtensionNotFoundError>;
  readonly registerTools: (
    input: ExtensionRegisterToolsInput & ExtensionConnectionInput,
  ) => Effect.Effect<ExtensionRegisterToolsResult, ExtensionHandshakeRequiredError>;
  readonly registerResources: (
    input: ExtensionRegisterResourcesInput & ExtensionConnectionInput,
  ) => Effect.Effect<ExtensionRegisterResourcesResult, ExtensionHandshakeRequiredError>;
  readonly registerHttpPrefix: (
    input: ExtensionRegisterHttpPrefixInput & ExtensionConnectionInput,
  ) => Effect.Effect<
    ExtensionRegisterHttpPrefixResult,
    ExtensionHandshakeRequiredError | ExtensionHttpPrefixCollisionError
  >;
  readonly registerWebEntry: (
    input: ExtensionRegisterWebEntryInput & ExtensionConnectionInput,
  ) => Effect.Effect<void, ExtensionHandshakeRequiredError>;
  readonly setBadge: (
    input: ExtensionSetBadgeInput & ExtensionConnectionInput,
  ) => Effect.Effect<void, ExtensionHandshakeRequiredError>;
  readonly connect: (
    input: ExtensionConnectionInput,
  ) => Effect.Effect<Stream.Stream<ExtensionStreamEvent>, ExtensionHandshakeRequiredError>;
  readonly respondTool: (response: ExtensionToolResult) => Effect.Effect<void>;
  readonly respondHttp: (response: ExtensionHttpResponse) => Effect.Effect<void>;
  readonly respondToolsForThread: (response: ExtensionToolsForThreadResult) => Effect.Effect<void>;
  readonly respondReadResource: (response: ExtensionReadResourceResult) => Effect.Effect<void>;

  // --- broker, host to extension -------------------------------------------
  readonly invokeTool: (input: {
    readonly name: ExtensionToolName;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly caller: ExtensionToolCaller;
  }) => Effect.Effect<ExtensionToolResult, ExtensionUnavailableError | ExtensionUnknownToolError>;
  readonly proxyHttp: (input: {
    readonly prefix: ExtensionHttpPrefix;
    readonly request: Omit<ExtensionHttpRequest, "requestId">;
  }) => Effect.Effect<ExtensionHttpResponse, ExtensionUnavailableError | ExtensionNotFoundError>;
  /**
   * Reads one registered resource from whoever owns its URI. The answer is the
   * extension's own; a silent or stopped extension is an
   * `ExtensionUnavailableError`, which the MCP broker turns into a protocol
   * error because `resources/read` has no error-result shape to carry it.
   */
  readonly readResource: (input: {
    readonly uri: ExtensionResourceUri;
  }) => Effect.Effect<
    ExtensionReadResourceResult,
    ExtensionUnavailableError | ExtensionUnknownResourceError
  >;
  /** Every tool the host should register with MCP, in start order. */
  readonly listTools: Effect.Effect<ReadonlyArray<ExtensionToolOwner>>;
  /** Every resource the host should register with MCP, in start order. */
  readonly listResources: Effect.Effect<ReadonlyArray<ExtensionResourceOwner>>;
  /**
   * The instructions of every *connected* extension, in start order.
   *
   * Connected rather than merely registered: instructions describe a working
   * extension, and a stopped one's guidance would tell an agent to reach for
   * tools that can only answer `ExtensionUnavailableError`. The tools stay in
   * the catalogue because a running agent already holds their names; nothing
   * holds a copy of the instructions, so there is nothing to keep honest.
   */
  readonly listInstructions: Effect.Effect<ReadonlyArray<ExtensionInstructions>>;
  /**
   * What each extension that filters per thread says this thread may see.
   *
   * One entry per extension that registered with `filterToolsPerThread` *and*
   * answered; an extension that is down, silent, or does not filter is absent,
   * which means "no restriction". Failing open is deliberate: visibility is a
   * smaller promise than authorization, and a silent extension must not take
   * away tools a running agent already has.
   */
  readonly toolsForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyMap<ExtensionName, ReadonlySet<ExtensionToolName>>>;
  /**
   * Completes once every enabled extension has either connected or reached a
   * terminal state — the condition the MCP catalogue has to be complete under,
   * since a provider caches it when its process connects. Never completes
   * before the source list is final, so a caller that arrives during startup
   * waits rather than seeing an empty registry and concluding "ready".
   */
  readonly awaitReady: Effect.Effect<void>;

  // --- lifecycle, called by the supervisor ---------------------------------
  readonly upsertSource: (
    source: ResolvedExtensionSource & {
      readonly manifest?: ExtensionManifest;
      readonly folderHash?: string;
      readonly loadError?: string;
    },
  ) => Effect.Effect<void>;
  readonly setState: (input: {
    readonly name: ExtensionName;
    readonly state: ExtensionRuntimeState;
    readonly runningHash?: string;
    readonly lastError?: string;
    readonly countRestart?: boolean;
  }) => Effect.Effect<void>;
  readonly setFolderHash: (input: {
    readonly name: ExtensionName;
    readonly folderHash: string;
    readonly manifest?: ExtensionManifest;
  }) => Effect.Effect<void>;
  readonly appendLog: (input: {
    readonly name: ExtensionName;
    readonly stream: ExtensionLogEntry["stream"];
    readonly line: string;
  }) => Effect.Effect<void>;
  readonly setEnabled: (input: {
    readonly name: ExtensionName;
    readonly enabled: boolean;
  }) => Effect.Effect<void, ExtensionNotFoundError>;
  /**
   * Forget an extension entirely, freeing its tool names and HTTP prefix for
   * whoever asks next. The caller stops the process first — this only drops the
   * record, and a record with a live connection would strand it.
   *
   * MCP tools cannot be withdrawn from a connected agent
   * (`spikes/mcp-client-behaviour.md`), so a removed extension's tools keep
   * answering until the agent's process restarts — with `ExtensionUnknownToolError`
   * rather than a stale result, which is the honest answer.
   */
  readonly removeSource: (name: ExtensionName) => Effect.Effect<void>;
  /** The supervisor has finished reading settings and flags; readiness can now resolve. */
  readonly markSourcesResolved: Effect.Effect<void>;

  // --- admin ----------------------------------------------------------------
  readonly list: Effect.Effect<ExtensionListResult>;
  /**
   * The same list, re-emitted whenever it moves. Starts with the current value,
   * so a subscriber never has to `list` first, and repeats are dropped, so a
   * write that leaves the list identical costs a subscriber nothing.
   */
  readonly changes: Stream.Stream<ExtensionListResult>;
  readonly logs: (input: ExtensionLogsInput) => Effect.Effect<ExtensionLogsResult>;
  readonly get: (name: ExtensionName) => Effect.Effect<ExtensionStatus, ExtensionNotFoundError>;
}

export class ExtensionRegistry extends Context.Service<ExtensionRegistry, ExtensionRegistryShape>()(
  "t3/extensions/ExtensionRegistry",
) {}

export interface ExtensionRegistryOptions {
  readonly environmentId: EnvironmentId;
  /**
   * Tool names the host itself serves over MCP. An extension that claims one
   * is rejected with a collision naming T3 Code as the owner, because the
   * catalogue is one flat namespace and the host's tools were there first.
   */
  readonly reservedToolNames?: ReadonlyArray<ExtensionToolName>;
  /**
   * Resource URIs the host itself serves over MCP. Same rule as the tool
   * names: one flat namespace, and the host's own resources were there first.
   */
  readonly reservedResourceUris?: ReadonlyArray<string>;
  readonly hostVersion: string;
  /** `<stateDir>/extensions`; each extension gets a directory named after it. */
  readonly dataRoot: string;
  readonly callTimeoutMs?: number;
}

const emptyRecord = (source: ResolvedExtensionSource): ExtensionRecord => ({
  name: source.name,
  path: source.path,
  source: source.source,
  enabled: source.enabled,
  state: source.enabled ? "stopped" : "disabled",
  restartCount: 0,
  logs: [],
  tools: [],
  resources: [],
  filterToolsPerThread: false,
  rejections: [],
  helloAcked: false,
});

const withRecord = (
  state: RegistryState,
  name: ExtensionName,
  update: (record: ExtensionRecord) => ExtensionRecord,
): RegistryState => {
  const record = state.records.get(name);
  if (!record) return state;
  const records = new Map(state.records);
  records.set(name, update(record));
  return { ...state, records };
};

/**
 * Who already owns `toolName`, or `undefined` if it is free. Names are
 * unprefixed and unique per environment (design §5.2), so the first extension
 * to register a name keeps it and later ones are told which one took it.
 */
const ownerOfTool = (
  state: RegistryState,
  toolName: ExtensionToolName,
  claimant: ExtensionName,
): ExtensionName | undefined => {
  for (const record of state.records.values()) {
    if (record.name === claimant) continue;
    if (record.tools.some((tool) => tool.name === toolName)) return record.name;
  }
  return undefined;
};

/** Who already owns `uri`, or `undefined` if it is free. Mirrors `ownerOfTool`. */
const ownerOfResource = (
  state: RegistryState,
  uri: ExtensionResourceUri,
  claimant: ExtensionName,
): ExtensionName | undefined => {
  for (const record of state.records.values()) {
    if (record.name === claimant) continue;
    if (record.resources.some((resource) => resource.uri === uri)) return record.name;
  }
  return undefined;
};

const toStatus = (record: ExtensionRecord): ExtensionStatus => ({
  name: record.name,
  path: record.path,
  source: record.source,
  enabled: record.enabled,
  state: record.state,
  ...(record.manifest === undefined
    ? {}
    : { version: record.manifest.version, protocolVersion: record.manifest.protocolVersion }),
  ...(record.folderHash === undefined ? {} : { folderHash: record.folderHash }),
  ...(record.runningHash === undefined ? {} : { runningHash: record.runningHash }),
  changed:
    record.runningHash !== undefined &&
    record.folderHash !== undefined &&
    record.runningHash !== record.folderHash,
  tools: record.tools.map((tool) => tool.name),
  resources: record.resources.map((resource) => resource.uri),
  hasInstructions: record.instructions !== undefined,
  rejections: record.rejections,
  ...(record.httpPrefix === undefined ? {} : { httpPrefix: record.httpPrefix }),
  ...(record.web === undefined ? {} : { web: record.web }),
  ...(record.badge === undefined ? {} : { badge: record.badge }),
  ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
  restartCount: record.restartCount,
});

const subjectMismatch = (input: ExtensionConnectionInput): boolean =>
  input.subject !== undefined &&
  input.subject.startsWith(EXTENSION_SUBJECT_PREFIX) &&
  input.subject.slice(EXTENSION_SUBJECT_PREFIX.length) !== input.name;

export const make = Effect.fnUntraced(function* (options: ExtensionRegistryOptions) {
  const crypto = yield* Crypto.Crypto;
  const callTimeoutMs = options.callTimeoutMs ?? EXTENSION_CALL_TIMEOUT_MS;
  const reservedToolNames = new Set<string>(options.reservedToolNames ?? []);
  const reservedResourceUris = new Set<string>(options.reservedResourceUris ?? []);
  const state = yield* SynchronizedRef.make<RegistryState>({
    records: new Map(),
    pending: new Map(),
    callSequence: 0,
    sourcesResolved: false,
  });
  const ready = yield* Deferred.make<void>();

  /** Completes readiness the first time the condition holds. */
  const checkReady = Effect.gen(function* () {
    const current = yield* SynchronizedRef.get(state);
    if (isReady(current)) yield* Deferred.succeed(ready, undefined);
  });
  /**
   * Bumped by every write to `state`, which is the whole change signal: the
   * derived list is rebuilt from the ref when a subscriber is woken, so this
   * only has to say "something moved". `changes` drops the writes that left the
   * list identical (a pending call taken, a log line appended), so publishing
   * on every write rather than only the interesting ones costs nothing.
   */
  const revision = yield* SubscriptionRef.make(0);
  const bumpRevision = SubscriptionRef.update(revision, (value) => value + 1);
  const updateState = (update: (current: RegistryState) => RegistryState): Effect.Effect<void> =>
    SynchronizedRef.update(state, update).pipe(Effect.andThen(bumpRevision));
  const modifyState = <A>(
    update: (current: RegistryState) => readonly [A, RegistryState],
  ): Effect.Effect<A> => SynchronizedRef.modify(state, update).pipe(Effect.tap(() => bumpRevision));

  const readRecord = (name: ExtensionName) =>
    SynchronizedRef.get(state).pipe(Effect.map((current) => current.records.get(name)));

  /** Every handshake-gated method answers the same way when there was no hello. */
  const requireHandshake = Effect.fn("ExtensionRegistry.requireHandshake")(function* (
    method: string,
    input: ExtensionConnectionInput,
  ) {
    const record = yield* readRecord(input.name);
    if (!record || !record.helloAcked || subjectMismatch(input)) {
      return yield* new ExtensionHandshakeRequiredError({ method });
    }
    return record;
  });

  // `Deferred` is invariant in its value type, so the two branches cannot be
  // collapsed even though their bodies are identical: narrowing on `kind` is
  // what gives each call a concrete deferred to fail.
  const abortPending = (entry: PendingCall, error: ExtensionUnavailableError) => {
    switch (entry.kind) {
      case "tool":
        return Deferred.fail(entry.deferred, error);
      case "http":
        return Deferred.fail(entry.deferred, error);
      case "tools":
        return Deferred.fail(entry.deferred, error);
      case "resource":
        return Deferred.fail(entry.deferred, error);
    }
  };

  const failPending = Effect.fn("ExtensionRegistry.failPending")(function* (
    entries: ReadonlyArray<PendingCall>,
    error: ExtensionUnavailableError,
  ) {
    yield* Effect.forEach(entries, (entry) => abortPending(entry, error), { discard: true });
  });

  /**
   * Drop a connection and fail everything that was waiting on it. Callers hold
   * the connection they are dropping so a reconnect that raced this cannot
   * have its own queue torn down.
   */
  const dropConnection = Effect.fn("ExtensionRegistry.dropConnection")(function* (
    name: ExtensionName,
    connection: ExtensionConnection,
    reason: ExtensionUnavailableError["reason"],
  ) {
    const abandoned = yield* modifyState((current) => {
      const record = current.records.get(name);
      const pending = new Map(current.pending);
      const failed: Array<PendingCall> = [];
      for (const [callId, entry] of pending) {
        if (entry.connectionId !== connection.connectionId) continue;
        pending.delete(callId);
        failed.push(entry);
      }
      const records = new Map(current.records);
      if (record && record.connection?.connectionId === connection.connectionId) {
        const { connection: _connection, ...withoutConnection } = record;
        records.set(name, { ...withoutConnection, helloAcked: false });
      }
      return [failed, { ...current, records, pending }] as const;
    });
    yield* failPending(abandoned, new ExtensionUnavailableError({ extensionName: name, reason }));
    yield* Queue.shutdown(connection.queue);
  });

  const hello: ExtensionRegistryShape["hello"] = Effect.fn("ExtensionRegistry.hello")(
    function* (input) {
      if (subjectMismatch(input)) {
        return yield* new ExtensionNotFoundError({ extensionName: input.name });
      }
      const record = yield* readRecord(input.manifest.name);
      if (!record) {
        return yield* new ExtensionNotFoundError({ extensionName: input.manifest.name });
      }
      const negotiated = negotiateExtensionProtocolVersion({
        requestedVersion: input.protocolVersion,
        supportedVersions: EXTENSION_SUPPORTED_PROTOCOL_VERSIONS,
        extensionName: input.manifest.name,
      });
      if (negotiated._tag === "Failure") return yield* negotiated.failure;
      yield* updateState((current) =>
        withRecord(current, record.name, (existing) => ({
          ...existing,
          manifest: input.manifest,
          helloAcked: true,
        })),
      );
      return {
        protocolVersion: negotiated.success,
        hostProtocolVersions: EXTENSION_SUPPORTED_PROTOCOL_VERSIONS,
        hostVersion: options.hostVersion,
        environmentId: options.environmentId,
        extensionPath: record.path,
        dataDirectory: `${options.dataRoot}/${record.name}`,
      } satisfies ExtensionHelloAck;
    },
  );

  /** Replace the rejection of this kind, so a re-register never accumulates. */
  const recordRejection = (name: ExtensionName, rejection: ExtensionRejection) =>
    updateState((current) =>
      withRecord(current, name, (record) => ({
        ...record,
        rejections: [
          ...record.rejections.filter((existing) => existing.kind !== rejection.kind),
          rejection,
        ],
      })),
    );

  const registerTools: ExtensionRegistryShape["registerTools"] = Effect.fn(
    "ExtensionRegistry.registerTools",
  )(function* (input) {
    yield* requireHandshake(EXTENSION_WS_METHODS.registerTools, input);
    const result = yield* modifyState((current) => {
      const accepted: ExtensionToolDefinition[] = [];
      const results: ExtensionToolRegistration[] = [];
      for (const tool of input.tools) {
        if (reservedToolNames.has(tool.name)) {
          results.push({
            status: "rejected",
            name: tool.name,
            reason: "name-collision",
            message: new ExtensionToolNameCollisionError({ toolName: tool.name }).message,
          });
          continue;
        }
        const owner = ownerOfTool(current, tool.name, input.name);
        if (owner !== undefined) {
          results.push({
            status: "rejected",
            name: tool.name,
            reason: "name-collision",
            message: new ExtensionToolNameCollisionError({ toolName: tool.name, owner }).message,
          });
          continue;
        }
        // A payload cannot collide with itself either: the first declaration
        // wins and a repeat is refused, or MCP would be handed both.
        if (accepted.some((kept) => kept.name === tool.name)) {
          results.push({
            status: "rejected",
            name: tool.name,
            reason: "name-collision",
            message: `Tool ${tool.name} is declared more than once in this registration; the first is kept.`,
          });
          continue;
        }
        accepted.push(tool);
        results.push({ status: "accepted", name: tool.name });
      }
      // The same refusals the extension is told, kept where a human can read
      // them: registration is idempotent, so this replaces the previous set
      // rather than accumulating one entry per reconnect.
      const rejections = results.flatMap((result) =>
        result.status === "rejected"
          ? [{ kind: "tool" as const, subject: result.name, message: result.message }]
          : [],
      );
      return [
        { tools: results } satisfies ExtensionRegisterToolsResult,
        withRecord(current, input.name, (record) => {
          // Dropped rather than kept when absent: registration is a complete
          // replacement, so a build that stopped declaring instructions must
          // not keep publishing the last build's.
          const { instructions: _previous, ...withoutInstructions } = record;
          return {
            ...withoutInstructions,
            ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
            tools: accepted,
            filterToolsPerThread: input.filterToolsPerThread === true,
            rejections: [
              ...record.rejections.filter((rejection) => rejection.kind !== "tool"),
              ...rejections,
            ],
          };
        }),
      ] as const;
    });
    return result;
  });

  const registerResources: ExtensionRegistryShape["registerResources"] = Effect.fn(
    "ExtensionRegistry.registerResources",
  )(function* (input) {
    yield* requireHandshake(EXTENSION_WS_METHODS.registerResources, input);
    return yield* modifyState((current) => {
      const accepted: ExtensionResourceDefinition[] = [];
      const results: ExtensionResourceRegistration[] = [];
      for (const resource of input.resources) {
        if (reservedResourceUris.has(resource.uri)) {
          results.push({
            status: "rejected",
            uri: resource.uri,
            reason: "uri-collision",
            message: new ExtensionResourceUriCollisionError({ uri: resource.uri }).message,
          });
          continue;
        }
        const owner = ownerOfResource(current, resource.uri, input.name);
        if (owner !== undefined) {
          results.push({
            status: "rejected",
            uri: resource.uri,
            reason: "uri-collision",
            message: new ExtensionResourceUriCollisionError({ uri: resource.uri, owner }).message,
          });
          continue;
        }
        // The same rule as a repeated tool name: the first declaration wins.
        if (accepted.some((kept) => kept.uri === resource.uri)) {
          results.push({
            status: "rejected",
            uri: resource.uri,
            reason: "uri-collision",
            message: `Resource ${resource.uri} is declared more than once in this registration; the first is kept.`,
          });
          continue;
        }
        accepted.push(resource);
        results.push({ status: "accepted", uri: resource.uri });
      }
      const rejections = results.flatMap((result) =>
        result.status === "rejected"
          ? [{ kind: "resource" as const, subject: result.uri, message: result.message }]
          : [],
      );
      return [
        { resources: results } satisfies ExtensionRegisterResourcesResult,
        withRecord(current, input.name, (record) => ({
          ...record,
          resources: accepted,
          rejections: [
            ...record.rejections.filter((rejection) => rejection.kind !== "resource"),
            ...rejections,
          ],
        })),
      ] as const;
    });
  });

  const registerHttpPrefix: ExtensionRegistryShape["registerHttpPrefix"] = Effect.fn(
    "ExtensionRegistry.registerHttpPrefix",
  )(function* (input) {
    yield* requireHandshake(EXTENSION_WS_METHODS.registerHttpPrefix, input);
    /** Answer the extension and leave the reason where Settings can show it. */
    const refuse = Effect.fn("ExtensionRegistry.registerHttpPrefix.refuse")(function* (
      error: ExtensionHttpPrefixCollisionError,
    ) {
      yield* recordRejection(input.name, {
        kind: "http-prefix",
        subject: input.prefix,
        message: error.message,
      });
      return yield* error;
    });
    if (RESERVED_HTTP_PREFIXES.has(input.prefix)) {
      return yield* refuse(new ExtensionHttpPrefixCollisionError({ prefix: input.prefix }));
    }
    const current = yield* SynchronizedRef.get(state);
    for (const record of current.records.values()) {
      if (record.name !== input.name && record.httpPrefix === input.prefix) {
        return yield* refuse(
          new ExtensionHttpPrefixCollisionError({ prefix: input.prefix, owner: record.name }),
        );
      }
    }
    yield* updateState((next) =>
      withRecord(next, input.name, (record) => ({
        ...record,
        httpPrefix: input.prefix,
        rejections: record.rejections.filter((rejection) => rejection.kind !== "http-prefix"),
      })),
    );
    return {
      prefix: input.prefix,
      basePath: extensionHttpBasePath(options.environmentId, input.prefix),
    } satisfies ExtensionRegisterHttpPrefixResult;
  });

  const registerWebEntry: ExtensionRegistryShape["registerWebEntry"] = Effect.fn(
    "ExtensionRegistry.registerWebEntry",
  )(function* (input) {
    yield* requireHandshake(EXTENSION_WS_METHODS.registerWebEntry, input);
    yield* updateState((current) =>
      withRecord(current, input.name, (record) => ({ ...record, web: input.web })),
    );
  });

  const setBadge: ExtensionRegistryShape["setBadge"] = Effect.fn("ExtensionRegistry.setBadge")(
    function* (input) {
      yield* requireHandshake(EXTENSION_WS_METHODS.setBadge, input);
      yield* updateState((current) =>
        withRecord(current, input.name, (record) =>
          input.badge.kind === "none"
            ? (({ badge: _badge, ...rest }) => rest)(record)
            : { ...record, badge: input.badge },
        ),
      );
    },
  );

  const connect: ExtensionRegistryShape["connect"] = Effect.fn("ExtensionRegistry.connect")(
    function* (input) {
      yield* requireHandshake(EXTENSION_WS_METHODS.connect, input);
      const acquire = Effect.gen(function* () {
        const queue = yield* Queue.unbounded<ExtensionStreamEvent>();
        const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const connection: ExtensionConnection = { connectionId, queue };
        yield* Queue.offer(queue, { type: "attached", connectionId });
        const previous = yield* modifyState((current) => {
          const record = current.records.get(input.name);
          if (!record) return [undefined, current] as const;
          const records = new Map(current.records);
          records.set(input.name, { ...record, connection });
          return [record.connection, { ...current, records }] as const;
        });
        if (previous) yield* dropConnection(input.name, previous, "restarting");
        yield* checkReady;
        return connection;
      });
      return Stream.unwrap(
        Effect.acquireRelease(acquire, (connection) =>
          dropConnection(input.name, connection, "not-connected"),
        ).pipe(Effect.map((connection) => Stream.fromQueue(connection.queue))),
      );
    },
  );

  /** Take one pending call, but only if the response names its kind and connection. */
  const takePending = (callId: string, connectionId: string, kind: PendingCall["kind"]) =>
    modifyState((current) => {
      const found = current.pending.get(callId);
      if (!found || found.kind !== kind || found.connectionId !== connectionId) {
        return [undefined, current] as const;
      }
      const pending = new Map(current.pending);
      pending.delete(callId);
      return [found, { ...current, pending }] as const;
    });

  const respondTool: ExtensionRegistryShape["respondTool"] = Effect.fn(
    "ExtensionRegistry.respondTool",
  )(function* (response) {
    const entry = yield* takePending(response.invocationId, response.connectionId, "tool");
    if (entry?.kind !== "tool") return;
    yield* Deferred.succeed(entry.deferred, response);
  });

  const respondHttp: ExtensionRegistryShape["respondHttp"] = Effect.fn(
    "ExtensionRegistry.respondHttp",
  )(function* (response) {
    const entry = yield* takePending(response.requestId, response.connectionId, "http");
    if (entry?.kind !== "http") return;
    yield* Deferred.succeed(entry.deferred, response);
  });

  const respondReadResource: ExtensionRegistryShape["respondReadResource"] = Effect.fn(
    "ExtensionRegistry.respondReadResource",
  )(function* (response) {
    const entry = yield* takePending(response.requestId, response.connectionId, "resource");
    if (entry?.kind !== "resource") return;
    yield* Deferred.succeed(entry.deferred, response);
  });

  const respondToolsForThread: ExtensionRegistryShape["respondToolsForThread"] = Effect.fn(
    "ExtensionRegistry.respondToolsForThread",
  )(function* (response) {
    const entry = yield* takePending(response.requestId, response.connectionId, "tools");
    if (entry?.kind !== "tools") return;
    yield* Deferred.succeed(entry.deferred, response);
  });

  /**
   * Push one event and wait for its answer. The pending entry is removed on
   * every exit — answered, timed out, or interrupted — so a caller that goes
   * away cannot leak an entry that a late response would then resolve.
   */
  const call = <A>(input: {
    readonly callId: string;
    readonly connection: ExtensionConnection;
    readonly event: ExtensionStreamEvent;
    readonly toPending: (deferred: Deferred.Deferred<A, ExtensionUnavailableError>) => PendingCall;
    readonly unavailable: (
      reason: ExtensionUnavailableError["reason"],
    ) => ExtensionUnavailableError;
  }): Effect.Effect<A, ExtensionUnavailableError> =>
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<A, ExtensionUnavailableError>();
      yield* updateState((current) => {
        const pending = new Map(current.pending);
        pending.set(input.callId, input.toPending(deferred));
        return { ...current, pending };
      });
      const removePending = updateState((current) => {
        if (!current.pending.has(input.callId)) return current;
        const pending = new Map(current.pending);
        pending.delete(input.callId);
        return { ...current, pending };
      });
      const awaitAnswer = Effect.gen(function* () {
        const offered = yield* Queue.offer(input.connection.queue, input.event);
        if (!offered) return yield* input.unavailable("not-connected");
        const answered = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(callTimeoutMs));
        return yield* Option.match(answered, {
          onNone: () => Effect.fail(input.unavailable("timeout")),
          onSome: (value) => Effect.succeed(value),
        });
      });
      return yield* awaitAnswer.pipe(Effect.ensuring(removePending));
    });

  const nextCallId = (prefix: string) =>
    modifyState((current) => [
      `${prefix}-${current.callSequence}`,
      { ...current, callSequence: current.callSequence + 1 },
    ]);

  const invokeTool: ExtensionRegistryShape["invokeTool"] = Effect.fn(
    "ExtensionRegistry.invokeTool",
  )(function* (input) {
    const current = yield* SynchronizedRef.get(state);
    const owner = [...current.records.values()].find((record) =>
      record.tools.some((tool) => tool.name === input.name),
    );
    if (!owner) return yield* new ExtensionUnknownToolError({ toolName: input.name });
    if (!owner.connection) {
      return yield* new ExtensionUnavailableError({
        extensionName: owner.name,
        toolName: input.name,
        reason: owner.enabled
          ? owner.state === "starting"
            ? "restarting"
            : "not-connected"
          : "stopped",
      });
    }
    const connection = owner.connection;
    const invocationId = yield* nextCallId("tool");
    return yield* call<ExtensionToolResult>({
      callId: invocationId,
      connection,
      toPending: (deferred) => ({
        kind: "tool",
        connectionId: connection.connectionId,
        deferred,
      }),
      event: {
        type: "invokeTool",
        connectionId: connection.connectionId,
        invocation: {
          invocationId,
          name: input.name,
          arguments: input.arguments,
          caller: input.caller,
        },
      },
      unavailable: (reason) =>
        new ExtensionUnavailableError({
          extensionName: owner.name,
          toolName: input.name,
          reason,
        }),
    });
  });

  const readResource: ExtensionRegistryShape["readResource"] = Effect.fn(
    "ExtensionRegistry.readResource",
  )(function* (input) {
    const current = yield* SynchronizedRef.get(state);
    const owner = [...current.records.values()].find((record) =>
      record.resources.some((resource) => resource.uri === input.uri),
    );
    if (!owner) return yield* new ExtensionUnknownResourceError({ uri: input.uri });
    if (!owner.connection) {
      return yield* new ExtensionUnavailableError({
        extensionName: owner.name,
        resourceUri: input.uri,
        reason: owner.enabled
          ? owner.state === "starting"
            ? "restarting"
            : "not-connected"
          : "stopped",
      });
    }
    const connection = owner.connection;
    const requestId = yield* nextCallId("resource");
    return yield* call<ExtensionReadResourceResult>({
      callId: requestId,
      connection,
      toPending: (deferred) => ({
        kind: "resource",
        connectionId: connection.connectionId,
        deferred,
      }),
      event: {
        type: "readResource",
        connectionId: connection.connectionId,
        request: { requestId, uri: input.uri },
      },
      unavailable: (reason) =>
        new ExtensionUnavailableError({
          extensionName: owner.name,
          resourceUri: input.uri,
          reason,
        }),
    });
  });

  const proxyHttp: ExtensionRegistryShape["proxyHttp"] = Effect.fn("ExtensionRegistry.proxyHttp")(
    function* (input) {
      const current = yield* SynchronizedRef.get(state);
      const owner = [...current.records.values()].find(
        (record) => record.httpPrefix === input.prefix,
      );
      if (!owner) {
        return yield* new ExtensionNotFoundError({ extensionName: input.prefix as ExtensionName });
      }
      if (!owner.connection) {
        return yield* new ExtensionUnavailableError({
          extensionName: owner.name,
          reason: owner.enabled ? "not-connected" : "stopped",
        });
      }
      const connection = owner.connection;
      const requestId = yield* nextCallId("http");
      return yield* call<ExtensionHttpResponse>({
        callId: requestId,
        connection,
        toPending: (deferred) => ({
          kind: "http",
          connectionId: connection.connectionId,
          deferred,
        }),
        event: {
          type: "proxyHttp",
          connectionId: connection.connectionId,
          request: { ...input.request, requestId },
        },
        unavailable: (reason) =>
          new ExtensionUnavailableError({ extensionName: owner.name, reason }),
      });
    },
  );

  const listTools: ExtensionRegistryShape["listTools"] = SynchronizedRef.get(state).pipe(
    Effect.map((current) =>
      [...current.records.values()].flatMap((record) =>
        record.tools.map((definition) => ({ extensionName: record.name, definition })),
      ),
    ),
  );

  const listResources: ExtensionRegistryShape["listResources"] = SynchronizedRef.get(state).pipe(
    Effect.map((current) =>
      [...current.records.values()].flatMap((record) =>
        record.resources.map((definition) => ({ extensionName: record.name, definition })),
      ),
    ),
  );

  const listInstructions: ExtensionRegistryShape["listInstructions"] = SynchronizedRef.get(
    state,
  ).pipe(
    Effect.map((current) =>
      [...current.records.values()].flatMap((record) =>
        record.instructions === undefined || record.connection === undefined
          ? []
          : [{ extensionName: record.name, instructions: record.instructions }],
      ),
    ),
  );

  const toolsForThread: ExtensionRegistryShape["toolsForThread"] = Effect.fn(
    "ExtensionRegistry.toolsForThread",
  )(function* (threadId) {
    const current = yield* SynchronizedRef.get(state);
    const filtering = [...current.records.values()].filter(
      (record) => record.filterToolsPerThread && record.connection !== undefined,
    );
    if (filtering.length === 0) {
      return new Map<ExtensionName, ReadonlySet<ExtensionToolName>>();
    }
    // Every extension is asked at once: this sits in front of a provider
    // process starting, and asking them in turn would add one timeout per
    // extension to the wait.
    const answers = yield* Effect.forEach(
      filtering,
      (record) =>
        Effect.gen(function* () {
          const connection = record.connection;
          if (!connection) return undefined;
          const requestId = yield* nextCallId("tools");
          const answer = yield* call<ExtensionToolsForThreadResult>({
            callId: requestId,
            connection,
            toPending: (deferred) => ({
              kind: "tools",
              connectionId: connection.connectionId,
              deferred,
            }),
            event: {
              type: "toolsForThread",
              connectionId: connection.connectionId,
              request: { requestId, threadId },
            },
            unavailable: (reason) =>
              new ExtensionUnavailableError({ extensionName: record.name, reason }),
          }).pipe(Effect.option);
          return answer._tag === "None"
            ? undefined
            : ([record.name, new Set(answer.value.tools)] as const);
        }),
      { concurrency: "unbounded" },
    );
    return new Map(
      answers.filter(
        (entry): entry is readonly [ExtensionName, Set<ExtensionToolName>] => entry !== undefined,
      ),
    );
  });

  const upsertSource: ExtensionRegistryShape["upsertSource"] = Effect.fn(
    "ExtensionRegistry.upsertSource",
  )(function* (source) {
    yield* updateState((current) => {
      const records = new Map(current.records);
      const existing = records.get(source.name);
      const base = existing ?? emptyRecord(source);
      records.set(source.name, {
        ...base,
        path: source.path,
        source: source.source,
        enabled: source.enabled,
        state: source.enabled ? (base.state === "disabled" ? "stopped" : base.state) : "disabled",
        ...(source.manifest === undefined ? {} : { manifest: source.manifest }),
        ...(source.folderHash === undefined ? {} : { folderHash: source.folderHash }),
        ...(source.loadError === undefined ? {} : { lastError: source.loadError }),
      });
      return { ...current, records };
    });
    yield* checkReady;
  });

  const setState: ExtensionRegistryShape["setState"] = Effect.fn("ExtensionRegistry.setState")(
    function* (input) {
      yield* updateState((current) =>
        withRecord(current, input.name, (record) => {
          // A stopped or crashed extension keeps its tools but loses its badge:
          // the nav entry must not keep claiming unread work nothing is
          // producing.
          const stopped = input.state === "stopped" || input.state === "crashed";
          const { lastError: _lastError, badge: _badge, ...cleaned } = record;
          return {
            ...cleaned,
            ...(stopped || record.badge === undefined ? {} : { badge: record.badge }),
            state: input.state,
            // A starting process re-registers everything from scratch, so last
            // run's refusals describe nothing that is true any more.
            rejections: input.state === "starting" ? [] : record.rejections,
            restartCount:
              input.countRestart === true ? record.restartCount + 1 : record.restartCount,
            ...(input.runningHash === undefined ? {} : { runningHash: input.runningHash }),
            ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
          } as ExtensionRecord;
        }),
      );
      yield* checkReady;
    },
  );

  const setFolderHash: ExtensionRegistryShape["setFolderHash"] = Effect.fn(
    "ExtensionRegistry.setFolderHash",
  )(function* (input) {
    yield* updateState((current) =>
      withRecord(current, input.name, (record) => ({
        ...record,
        folderHash: input.folderHash,
        ...(input.manifest === undefined ? {} : { manifest: input.manifest }),
      })),
    );
  });

  const appendLog: ExtensionRegistryShape["appendLog"] = Effect.fn("ExtensionRegistry.appendLog")(
    function* (input) {
      const at = yield* Clock.currentTimeMillis;
      yield* updateState((current) =>
        withRecord(current, input.name, (record) => {
          const entry: ExtensionLogEntry = {
            at,
            stream: input.stream,
            line: input.line.slice(0, 4096),
          };
          const logs = [...record.logs, entry];
          return {
            ...record,
            logs:
              logs.length > EXTENSION_LOG_BUFFER_LINES
                ? logs.slice(logs.length - EXTENSION_LOG_BUFFER_LINES)
                : logs,
          };
        }),
      );
    },
  );

  const setEnabled: ExtensionRegistryShape["setEnabled"] = Effect.fn(
    "ExtensionRegistry.setEnabled",
  )(function* (input) {
    const record = yield* readRecord(input.name);
    if (!record) return yield* new ExtensionNotFoundError({ extensionName: input.name });
    yield* updateState((current) =>
      withRecord(current, input.name, (existing) => ({
        ...existing,
        enabled: input.enabled,
        state: input.enabled
          ? existing.state === "disabled"
            ? "stopped"
            : existing.state
          : "disabled",
      })),
    );
  });

  const markSourcesResolved: ExtensionRegistryShape["markSourcesResolved"] = Effect.gen(
    function* () {
      yield* updateState((current) => ({ ...current, sourcesResolved: true }));
      yield* checkReady;
    },
  );

  const list: ExtensionRegistryShape["list"] = SynchronizedRef.get(state).pipe(
    Effect.map((current) => ({
      extensions: [...current.records.values()].map(toStatus),
    })),
  );

  /**
   * Compared by encoded value rather than by reference: every emission rebuilds
   * the statuses from the ref, so nothing structural survives to be `Equal`.
   */
  const sameList = (left: ExtensionListResult, right: ExtensionListResult) =>
    JSON.stringify(left) === JSON.stringify(right);

  const changes: ExtensionRegistryShape["changes"] = SubscriptionRef.changes(revision).pipe(
    Stream.mapEffect(() => list),
    Stream.changesWith(sameList),
  );

  const logs: ExtensionRegistryShape["logs"] = Effect.fn("ExtensionRegistry.logs")(
    function* (input) {
      const record = yield* readRecord(input.name);
      const entries = record?.logs ?? [];
      const limit = input.limit ?? EXTENSION_LOG_BUFFER_LINES;
      return {
        name: input.name,
        entries: entries.slice(Math.max(0, entries.length - limit)),
      } satisfies ExtensionLogsResult;
    },
  );

  const get: ExtensionRegistryShape["get"] = Effect.fn("ExtensionRegistry.get")(function* (name) {
    const record = yield* readRecord(name);
    if (!record) return yield* new ExtensionNotFoundError({ extensionName: name });
    return toStatus(record);
  });

  const removeSource: ExtensionRegistryShape["removeSource"] = Effect.fn(
    "ExtensionRegistry.removeSource",
  )(function* (name) {
    yield* updateState((current) => {
      if (!current.records.has(name)) return current;
      const records = new Map(current.records);
      records.delete(name);
      return { ...current, records };
    });
  });

  return ExtensionRegistry.of({
    hello,
    registerTools,
    registerResources,
    registerHttpPrefix,
    registerWebEntry,
    setBadge,
    connect,
    respondTool,
    respondToolsForThread,
    respondReadResource,
    respondHttp,
    invokeTool,
    readResource,
    proxyHttp,
    listTools,
    listResources,
    listInstructions,
    toolsForThread,
    awaitReady: Deferred.await(ready),
    markSourcesResolved,
    upsertSource,
    setState,
    setFolderHash,
    appendLog,
    setEnabled,
    removeSource,
    list,
    changes,
    logs,
    get,
  });
});

export const layer = (options: ExtensionRegistryOptions) =>
  Layer.effect(ExtensionRegistry, make(options));

/** Result content the host synthesises when a brokered tool cannot be reached. */
export const unavailableToolContent = (
  error: ExtensionUnavailableError,
): ReadonlyArray<ExtensionToolContent> => [{ type: "text", text: error.message }];
