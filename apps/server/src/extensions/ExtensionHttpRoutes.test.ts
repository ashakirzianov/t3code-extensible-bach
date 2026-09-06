import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  EXTENSION_HTTP_BODY_MAX_CHARS,
  ExtensionNotFoundError,
  ExtensionUnavailableError,
  type ExtensionHttpRequest,
  type ExtensionHttpResponse,
  type ExtensionStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  proxyExtensionRequest,
  serveExtensionAsset,
  type ExtensionHttpRegistry,
} from "./ExtensionHttpRoutes.ts";
import { extensionAssetPath, mintExtensionAssetToken } from "./ExtensionAssetAccess.ts";

const environmentId = EnvironmentId.make("env-1");
const decode = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

/** An in-memory secret store: signing only needs a stable key. */
const secretStoreLayer = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const secrets = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) =>
      Effect.succeed(
        secrets.has(name)
          ? ({ _tag: "Some", value: secrets.get(name)! } as never)
          : ({ _tag: "None" } as never),
      ),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = secrets.get(name);
        if (existing) return existing;
        const created = new Uint8Array(bytes).fill(7);
        secrets.set(name, created);
        return created;
      }),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  });
});

const testLayer = Layer.mergeAll(NodeServices.layer, secretStoreLayer);

interface FakeRegistryOptions {
  readonly respond?: (request: Omit<ExtensionHttpRequest, "requestId">) => ExtensionHttpResponse;
  readonly proxyError?: ExtensionUnavailableError | ExtensionNotFoundError;
  readonly status?: Partial<ExtensionStatus> | null;
}

const makeRegistry = (options: FakeRegistryOptions = {}) => {
  const seen: Array<Omit<ExtensionHttpRequest, "requestId">> = [];
  const registry: ExtensionHttpRegistry = {
    proxyHttp: (input) => {
      seen.push(input.request);
      if (options.proxyError) return Effect.fail(options.proxyError) as never;
      const response =
        options.respond?.(input.request) ??
        ({
          connectionId: "c1",
          requestId: "r1",
          status: 200,
          headers: { "content-type": "text/plain" },
          body: { encoding: "utf8", data: "ok" },
        } satisfies ExtensionHttpResponse);
      return Effect.succeed(response);
    },
    get: (name) =>
      options.status === null || options.status === undefined
        ? (Effect.fail(new ExtensionNotFoundError({ extensionName: name })) as never)
        : Effect.succeed({
            name,
            path: "/ext/reference",
            source: { kind: "settings" },
            enabled: true,
            state: "running",
            changed: false,
            tools: [],
            restartCount: 0,
            ...options.status,
          } as ExtensionStatus),
  };
  return { registry, seen };
};

const proxy = (
  registry: ExtensionHttpRegistry,
  overrides: Partial<Parameters<typeof proxyExtensionRequest>[0]> = {},
) =>
  proxyExtensionRequest({
    registry,
    environmentId,
    method: "GET",
    pathname: `/ext-api/${environmentId}/reference/status`,
    search: "",
    headers: {},
    bodyBytes: new Uint8Array(),
    ...overrides,
  });

describe("proxyExtensionRequest", () => {
  it.effect("round-trips a request onto the extension and its response back", () =>
    Effect.gen(function* () {
      const { registry, seen } = makeRegistry();
      const outcome = yield* proxy(registry, {
        method: "POST",
        search: "?a=1&b=two",
        headers: { "content-type": "application/json", Authorization: "Bearer secret" },
        bodyBytes: new TextEncoder().encode('{"x":1}'),
      });

      assert.equal(outcome.status, 200);
      assert.equal(decode(outcome.body), "ok");

      const forwarded = seen[0]!;
      assert.equal(forwarded.method, "POST");
      // The extension routes on the path below its prefix.
      assert.equal(forwarded.path, "/status");
      assert.equal(forwarded.query, "a=1&b=two");
      assert.deepEqual(forwarded.body, { encoding: "utf8", data: '{"x":1}' });
      // The caller's credential must never reach the extension.
      assert.isUndefined(forwarded.headers.authorization);
      assert.equal(forwarded.headers["content-type"], "application/json");
      assert.equal(forwarded.environmentId, environmentId);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("base64-encodes a binary body and decodes a binary response", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
      const { registry, seen } = makeRegistry({
        respond: () => ({
          connectionId: "c1",
          requestId: "r1",
          status: 200,
          headers: {},
          body: { encoding: "base64", data: Buffer.from(bytes).toString("base64") },
        }),
      });

      const outcome = yield* proxy(registry, {
        method: "PUT",
        headers: { "content-type": "image/png" },
        bodyBytes: bytes,
      });

      assert.equal(seen[0]!.body?.encoding, "base64");
      assert.deepEqual(Array.from(outcome.body!), Array.from(bytes));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("answers 404 when no extension owns the prefix", () =>
    Effect.gen(function* () {
      const { registry } = makeRegistry({
        proxyError: new ExtensionNotFoundError({ extensionName: "reference" }),
      });
      assert.equal((yield* proxy(registry)).status, 404);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("answers 503 when the extension is not connected, with its own message", () =>
    Effect.gen(function* () {
      const error = new ExtensionUnavailableError({
        extensionName: "reference",
        reason: "stopped",
      });
      const { registry } = makeRegistry({ proxyError: error });
      const outcome = yield* proxy(registry);
      assert.equal(outcome.status, 503);
      // The message reaches the caller verbatim: it already explains itself.
      assert.equal(decode(outcome.body), error.message);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("answers 504 when the extension is up but did not respond", () =>
    Effect.gen(function* () {
      const { registry } = makeRegistry({
        proxyError: new ExtensionUnavailableError({
          extensionName: "reference",
          reason: "timeout",
        }),
      });
      // A timeout is a different situation from "not there", and whoever reads
      // the status should be able to tell them apart.
      assert.equal((yield* proxy(registry)).status, 504);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("answers 413 for a body over the contract's cap", () =>
    Effect.gen(function* () {
      const { registry, seen } = makeRegistry();
      const outcome = yield* proxy(registry, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        bodyBytes: new TextEncoder().encode("x".repeat(EXTENSION_HTTP_BODY_MAX_CHARS + 1)),
      });
      assert.equal(outcome.status, 413);
      // Rejected before it reached the extension, which is the point of a cap.
      assert.equal(seen.length, 0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("answers 405 for a method outside the contract", () =>
    Effect.gen(function* () {
      const { registry } = makeRegistry();
      assert.equal((yield* proxy(registry, { method: "TRACE" })).status, 405);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses a URL minted for a different environment", () =>
    Effect.gen(function* () {
      const { registry, seen } = makeRegistry();
      const outcome = yield* proxy(registry, {
        pathname: "/ext-api/other-env/reference/status",
      });
      assert.equal(outcome.status, 404);
      assert.equal(seen.length, 0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("sends no body back for HEAD", () =>
    Effect.gen(function* () {
      const { registry } = makeRegistry();
      const outcome = yield* proxy(registry, { method: "HEAD" });
      assert.equal(outcome.status, 200);
      assert.isUndefined(outcome.body);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("serveExtensionAsset", () => {
  /** Writes a real extension folder so the file reads are not faked. */
  const withExtensionFolder = <A, E, R>(
    body: (root: string) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | never, R | FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.makeDirectory(path.join(root, "web"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(root, "web", "entry.js"), "export const a = 1;");
      yield* fileSystem.writeFileString(path.join(root, "web", "entry.css"), ".t3ref-a{}");
      yield* fileSystem.writeFileString(path.join(root, "server.mjs"), "secret");
      return yield* body(root);
    }).pipe(Effect.scoped) as never;

  const registryFor = (root: string, state: ExtensionStatus["state"] = "running") =>
    makeRegistry({
      status: {
        path: root,
        state,
        web: { entry: "web/entry.js", css: "web/entry.css", label: "Reference" },
      },
    }).registry;

  it.effect("serves the entry module as JavaScript", () =>
    withExtensionFolder((root) =>
      Effect.gen(function* () {
        const { token } = yield* mintExtensionAssetToken("reference");
        const outcome = yield* serveExtensionAsset({
          registry: registryFor(root),
          method: "GET",
          pathname: extensionAssetPath({ token, name: "reference", relativePath: "entry.js" }),
        });
        assert.equal(outcome.status, 200);
        // The browser refuses to execute a module served as anything else.
        assert.match(outcome.headers["content-type"]!, /^text\/javascript/);
        assert.equal(decode(outcome.body), "export const a = 1;");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a traversal out of the web directory", () =>
    withExtensionFolder((root) =>
      Effect.gen(function* () {
        const { token } = yield* mintExtensionAssetToken("reference");
        for (const attempt of ["../server.mjs", "..%2Fserver.mjs", "nested/../../server.mjs"]) {
          const outcome = yield* serveExtensionAsset({
            registry: registryFor(root),
            method: "GET",
            pathname: `/ext-assets/${token}/reference/${attempt}`,
          });
          assert.equal(outcome.status, 404, `expected "${attempt}" to be refused`);
        }
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("stops resolving once the token's window has passed", () =>
    withExtensionFolder((root) =>
      Effect.gen(function* () {
        const { token } = yield* mintExtensionAssetToken("reference");
        const pathname = extensionAssetPath({
          token,
          name: "reference",
          relativePath: "entry.js",
        });
        // It resolves now...
        assert.equal(
          (yield* serveExtensionAsset({ registry: registryFor(root), method: "GET", pathname }))
            .status,
          200,
        );
        // ...and stops once the one-hour window it was minted with has passed.
        yield* TestClock.adjust(Duration.hours(2));
        assert.equal(
          (yield* serveExtensionAsset({ registry: registryFor(root), method: "GET", pathname }))
            .status,
          404,
        );
      }),
    ).pipe(Effect.provide(Layer.mergeAll(testLayer, TestClock.layer()))),
  );

  it.effect("rejects a token minted for a different extension", () =>
    withExtensionFolder((root) =>
      Effect.gen(function* () {
        const { token } = yield* mintExtensionAssetToken("other");
        const outcome = yield* serveExtensionAsset({
          registry: registryFor(root),
          method: "GET",
          // The signed claims are what authorise; the path segment cannot lie.
          pathname: `/ext-assets/${token}/reference/entry.js`,
        });
        assert.equal(outcome.status, 404);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a forged signature", () =>
    withExtensionFolder((root) =>
      Effect.gen(function* () {
        const { token } = yield* mintExtensionAssetToken("reference");
        const forged = `${token.split(".")[0]}.not-the-signature`;
        const outcome = yield* serveExtensionAsset({
          registry: registryFor(root),
          method: "GET",
          pathname: `/ext-assets/${forged}/reference/entry.js`,
        });
        assert.equal(outcome.status, 404);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("serves nothing for a stopped extension", () =>
    withExtensionFolder((root) =>
      Effect.gen(function* () {
        const { token } = yield* mintExtensionAssetToken("reference");
        const outcome = yield* serveExtensionAsset({
          registry: registryFor(root, "stopped"),
          method: "GET",
          pathname: extensionAssetPath({ token, name: "reference", relativePath: "entry.js" }),
        });
        assert.equal(outcome.status, 404);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a write method", () =>
    withExtensionFolder((root) =>
      Effect.gen(function* () {
        const { token } = yield* mintExtensionAssetToken("reference");
        const outcome = yield* serveExtensionAsset({
          registry: registryFor(root),
          method: "POST",
          pathname: extensionAssetPath({ token, name: "reference", relativePath: "entry.js" }),
        });
        assert.equal(outcome.status, 405);
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
