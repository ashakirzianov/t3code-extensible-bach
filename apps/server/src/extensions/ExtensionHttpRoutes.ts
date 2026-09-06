/**
 * The two HTTP routes that put an extension on the host's own origin.
 *
 * Both sit under the host's auth rather than inventing their own, which is what
 * makes remote, relay, and tunnel clients work with no per-extension setup: an
 * extension never opens a port and never sees a client credential.
 *
 * The decision logic lives in `proxyExtensionRequest` and `serveExtensionAsset`,
 * which take plain values and answer with a plain outcome. The layers below are
 * only adapters. That split is what makes the interesting cases — a 503 from a
 * stopped extension, a traversal, an expired token — testable without standing
 * up an authenticated HTTP server.
 */
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ExtensionHttpResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";

import { authenticateRawRouteWithScope } from "../http.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ExtensionRegistryService from "./ExtensionRegistry.ts";
import { verifyExtensionAssetToken } from "./ExtensionAssetAccess.ts";
import {
  assetContentType,
  decodeResponseBody,
  encodeRequestBody,
  exceedsBodyCap,
  EXT_API_ROUTE_PREFIX,
  EXT_ASSETS_ROUTE_PREFIX,
  normalizeRequestHeaders,
  normalizeResponseHeaders,
  parseExtApiPath,
  parseExtAssetPath,
  resolveWebAssetPath,
  toExtensionHttpMethod,
} from "./ExtensionHttp.ts";

/** What a route decided, before it becomes an `HttpServerResponse`. */
export interface ExtensionHttpOutcome {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body?: Uint8Array;
}

const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8" };

const textOutcome = (status: number, body: string): ExtensionHttpOutcome => ({
  status,
  headers: TEXT_HEADERS,
  body: new TextEncoder().encode(body),
});

const NOT_FOUND = textOutcome(404, "Not Found");

/** The registry surface these handlers use; narrowed so tests can fake it. */
export type ExtensionHttpRegistry = Pick<
  ExtensionRegistryService.ExtensionRegistryShape,
  "proxyHttp" | "get"
>;

// ---------------------------------------------------------------------------
// /ext-api
// ---------------------------------------------------------------------------

export const proxyExtensionRequest = Effect.fn("extensions.http.proxy")(function* (input: {
  readonly registry: ExtensionHttpRegistry;
  readonly environmentId: EnvironmentId;
  readonly method: string;
  readonly pathname: string;
  /** Raw query string, with or without its leading `?`. */
  readonly search: string;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  readonly bodyBytes: Uint8Array;
}) {
  const parsed = parseExtApiPath(input.pathname);
  if (!parsed) return NOT_FOUND;

  // The path names an environment, but a server only ever *is* one. Compare
  // rather than trust: a URL minted for another environment must not resolve
  // here just because it reached this process.
  if (parsed.environmentId !== input.environmentId) return NOT_FOUND;

  const method = toExtensionHttpMethod(input.method);
  if (!method) return textOutcome(405, "Method Not Allowed");

  const contentType = input.headers["content-type"];
  const body =
    input.bodyBytes.byteLength === 0
      ? undefined
      : encodeRequestBody(
          input.bodyBytes,
          Array.isArray(contentType) ? contentType[0] : (contentType as string | undefined),
        );
  // Cap the encoded string, which is what actually crosses the wire — base64 is
  // a third larger than the bytes it carries, so a byte cap would let it past.
  if (body && exceedsBodyCap(body)) {
    return textOutcome(413, "Request body is too large for the extension protocol.");
  }

  const search = input.search.startsWith("?") ? input.search.slice(1) : input.search;

  return yield* input.registry
    .proxyHttp({
      prefix: parsed.prefix,
      request: {
        method,
        path: parsed.path,
        ...(search.length > 0 ? { query: search } : {}),
        headers: normalizeRequestHeaders(input.headers),
        ...(body ? { body } : {}),
        environmentId: input.environmentId,
      },
    })
    .pipe(
      Effect.map((response) => extensionResponseToOutcome(response, method === "HEAD")),
      // A timeout means the extension is up and stuck; anything else means it
      // is not there. The error's own message already reads as an explanation.
      Effect.catchTag("ExtensionUnavailableError", (error) =>
        Effect.succeed(textOutcome(error.reason === "timeout" ? 504 : 503, error.message)),
      ),
      // No prefix registered under that name: nothing here to find, same answer
      // a client gets for any unknown path.
      Effect.catchTag("ExtensionNotFoundError", () => Effect.succeed(NOT_FOUND)),
    );
});

function extensionResponseToOutcome(
  response: ExtensionHttpResponse,
  headOnly: boolean,
): ExtensionHttpOutcome {
  const headers = normalizeResponseHeaders(response.headers);
  if (!response.body || headOnly) return { status: response.status, headers };
  return { status: response.status, headers, body: decodeResponseBody(response.body) };
}

// ---------------------------------------------------------------------------
// /ext-assets
// ---------------------------------------------------------------------------

export const serveExtensionAsset = Effect.fn("extensions.http.asset")(function* (input: {
  readonly registry: ExtensionHttpRegistry;
  readonly method: string;
  readonly pathname: string;
}) {
  if (input.method !== "GET" && input.method !== "HEAD") {
    return textOutcome(405, "Method Not Allowed");
  }

  const parsed = parseExtAssetPath(input.pathname);
  if (!parsed) return NOT_FOUND;

  const claims = yield* verifyExtensionAssetToken(parsed.token);
  // Forged, expired, or minted for a different extension: one answer. Telling
  // an unauthenticated caller which it was only helps them.
  if (!claims || claims.name !== parsed.name) return NOT_FOUND;

  const status = yield* input.registry.get(claims.name).pipe(Effect.orElseSucceed(() => null));
  // No web entry also covers "never started". `starting` is allowed because the
  // client mounts as soon as the nav entry appears, which can beat the process.
  if (!status?.web) return NOT_FOUND;
  if (status.state !== "running" && status.state !== "starting") return NOT_FOUND;

  const path = yield* Path.Path;
  let requestedPath: string;
  try {
    requestedPath = decodeURIComponent(parsed.path);
  } catch {
    return NOT_FOUND; // A malformed escape is not a path we should guess at.
  }
  const resolved = resolveWebAssetPath({
    extensionPath: status.path,
    web: status.web,
    requestedPath,
    join: path.join,
    normalize: path.normalize,
    isAbsolute: path.isAbsolute,
  });
  if (!resolved) return NOT_FOUND;

  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(resolved).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File") return NOT_FOUND;

  const headers = {
    "content-type": assetContentType(resolved),
    // The URL already expires; caching for the same window costs one request
    // per mount instead of one per module in a code-split bundle.
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
  };
  if (input.method === "HEAD") return { status: 200, headers };

  const contents = yield* fileSystem.readFile(resolved).pipe(Effect.option);
  if (Option.isNone(contents)) return NOT_FOUND;
  return { status: 200, headers, body: contents.value };
});

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const toResponse = (outcome: ExtensionHttpOutcome) =>
  outcome.body === undefined
    ? HttpServerResponse.empty({ status: outcome.status, headers: outcome.headers })
    : HttpServerResponse.uint8Array(outcome.body, {
        status: outcome.status,
        headers: outcome.headers,
      });

const collectRequestBody = Effect.fn("extensions.http.collectBody")(function* <E>(
  stream: Stream.Stream<Uint8Array, E>,
) {
  const chunks = yield* Stream.runFold(
    stream,
    (): Array<Uint8Array> => [],
    (accumulated: Array<Uint8Array>, chunk: Uint8Array) => {
      accumulated.push(chunk);
      return accumulated;
    },
  ).pipe(Effect.orDie);
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
});

/**
 * Services are captured when the layer is built, not read inside the handler.
 *
 * A service read inside a route handler becomes a *request* requirement, which
 * `Layer.provideMerge` cannot satisfy — it escapes to the process entry point
 * instead. `staticAndDevRouteLayer` solves the same problem the same way.
 */
const makeExtensionApiRoute = (registry: ExtensionHttpRegistry, environmentId: EnvironmentId) =>
  HttpRouter.add(
    "*",
    `${EXT_API_ROUTE_PREFIX}/*`,
    Effect.gen(function* () {
      // The same scope as the `/api` routes: reaching an extension is reaching
      // this environment, so this is no more permissive than the rest.
      yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);

      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      if (Option.isNone(url)) return toResponse(textOutcome(400, "Bad Request"));

      // Read the body even for GET: a client may send one, and leaving it
      // unread would strand the request stream.
      const bodyBytes = yield* collectRequestBody(request.stream);

      return toResponse(
        yield* proxyExtensionRequest({
          registry,
          environmentId,
          method: request.method,
          pathname: url.value.pathname,
          search: url.value.search,
          headers: request.headers,
          bodyBytes,
        }),
      );
    }).pipe(
      Effect.catchTags({
        EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
        EnvironmentInternalError: HttpServerRespondable.toResponse,
        EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      }),
    ),
  );

export const extensionApiRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* ExtensionRegistryService.ExtensionRegistry;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return makeExtensionApiRoute(registry, yield* serverEnvironment.getEnvironmentId);
  }),
);

/**
 * Authenticated by the signed path segment alone, because `import()` cannot
 * send a header. Everything else about it is deliberately narrow.
 */
const makeExtensionAssetRoute = (registry: ExtensionHttpRegistry) =>
  HttpRouter.add(
    "*",
    `${EXT_ASSETS_ROUTE_PREFIX}/*`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      if (Option.isNone(url)) return toResponse(textOutcome(400, "Bad Request"));
      return toResponse(
        yield* serveExtensionAsset({
          registry,
          method: request.method,
          pathname: url.value.pathname,
        }),
      );
    }),
  );

export const extensionAssetRouteLayer = Layer.unwrap(
  Effect.map(ExtensionRegistryService.ExtensionRegistry, makeExtensionAssetRoute),
);
