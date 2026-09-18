import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { handleMock, netFetchMock, unhandleMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  netFetchMock: vi.fn(),
  unhandleMock: vi.fn(),
}));

vi.mock("electron", () => ({
  net: { fetch: netFetchMock },
  protocol: { handle: handleMock, unhandle: unhandleMock },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";
import * as RemoteExtensionAssets from "../extensions/RemoteExtensionAssets.ts";

const protocolLayer = ElectronProtocol.layer.pipe(Layer.provide(NodeServices.layer));

describe("ElectronProtocol", () => {
  beforeEach(() => {
    handleMock.mockReset();
    netFetchMock.mockReset();
    unhandleMock.mockReset();
    RemoteExtensionAssets.forgetPrimaryBackend();
  });

  /*
   * The packaged renderer is a directory of static files, and a static
   * directory has no `/ext-assets` in it. Before this bridge existed the import
   * 404'd, Vite's preload helper turned that into `vite:preloadError`, and the
   * host reloaded itself about five times a second. So the one route an
   * extension's bundle travels has to reach the backend in *this* serving mode
   * too, and everything else about the route has to stay refused.
   */
  it.effect("serves the primary backend's extension assets from the packaged client", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(`${directory}/index.html`, "<html>app</html>");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(new Response("export default 1;"));
      RemoteExtensionAssets.rememberPrimaryBackend("http://127.0.0.1:3773/");

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "t3code",
        assetDirectory: directory,
        clerkFrontendApiHostname: undefined,
      });
      const request = (pathname: string, init?: RequestInit) =>
        Effect.promise(() => handler!(new Request(`t3code://app${pathname}`, init)));

      const entry = yield* request("/ext-assets/eyJhIjoxfQ.sig/bach/entry.js");
      assert.equal(yield* Effect.promise(() => entry.text()), "export default 1;");
      assert.include(entry.headers.get("content-security-policy") ?? "", "default-src 'self'");
      assert.equal(
        netFetchMock.mock.calls[0]?.[0],
        "http://127.0.0.1:3773/ext-assets/eyJhIjoxfQ.sig/bach/entry.js",
      );
      // The signed token in the path is the whole credential.
      assert.deepEqual(netFetchMock.mock.calls[0]?.[1], {
        method: "GET",
        redirect: "error",
        credentials: "omit",
      });

      // A write is not a read. It 404s rather than falling through to
      // index.html, which an `import()` would read as a syntax error instead of
      // a missing module. (Traversal is refused a layer down, where a pathname
      // arrives before the URL parser has collapsed `..` for us —
      // `../extensions/RemoteExtensionAssets.test.ts`.)
      netFetchMock.mockClear();
      const refused = yield* request("/ext-assets/eyJhIjoxfQ.sig/bach/entry.js", {
        method: "POST",
      });
      assert.equal(refused.status, 404);
      assert.equal(yield* Effect.promise(() => refused.text()), "");
      assert.include(refused.headers.get("content-security-policy") ?? "", "default-src 'self'");
      assert.equal(netFetchMock.mock.calls.length, 0);

      // `/api` is not the asset route, so it is still the static directory's
      // business — and a miss there is the SPA fallback, exactly as before.
      const api = yield* request("/api/environment");
      assert.equal(yield* Effect.promise(() => api.text()), "<html>app</html>");
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(Layer.merge(protocolLayer, NodeServices.layer)), Effect.scoped),
  );

  /*
   * Upstream can now boot a window with no local environment, and the protocol
   * handler is registered before the backend's endpoint is resolved either way.
   * Both are "no backend to forward to", and both must 404 rather than hand an
   * `import()` the client's index.html.
   */
  it.effect("404s the asset route while there is no local backend to forward to", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(`${directory}/index.html`, "<html>app</html>");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "t3code",
        assetDirectory: directory,
        clerkFrontendApiHostname: undefined,
      });
      const response = yield* Effect.promise(() =>
        handler!(new Request("t3code://app/ext-assets/sig/bach/entry.js")),
      );
      assert.equal(response.status, 404);
      assert.equal(yield* Effect.promise(() => response.text()), "");
      assert.include(response.headers.get("content-security-policy") ?? "", "default-src 'self'");
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(Layer.merge(protocolLayer, NodeServices.layer)), Effect.scoped),
  );

  /*
   * In development the renderer is a Vite server whose proxy happens to forward
   * `/ext-assets` to the backend. Leaning on that would make the two modes
   * differ exactly where the packaged one already broke once.
   */
  it.effect("takes the asset route to the backend in development too", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(new Response("export default 1;"));
      RemoteExtensionAssets.rememberPrimaryBackend("http://127.0.0.1:3773/");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code-dev",
            targetOrigin: new URL("http://127.0.0.1:5173/"),
            clerkFrontendApiHostname: undefined,
          });
          const response = yield* Effect.promise(() =>
            handler!(
              new Request("t3code-dev://app/ext-assets/sig/bach/entry.js", {
                headers: { cookie: "session=secret" },
              }),
            ),
          );
          assert.equal(yield* Effect.promise(() => response.text()), "export default 1;");
        }),
      );

      assert.equal(
        netFetchMock.mock.calls[0]?.[0],
        "http://127.0.0.1:3773/ext-assets/sig/bach/entry.js",
      );
      assert.isUndefined(
        (netFetchMock.mock.calls[0]?.[1] as { headers?: unknown } | undefined)?.headers,
      );
    }).pipe(Effect.provide(protocolLayer)),
  );

  it.effect("serves the bundled client from disk without a backend", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(`${directory}/index.html`, "<html>app</html>");
      yield* fileSystem.writeFileString(`${directory}/app.js`, "export default 1;");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "t3code",
        assetDirectory: directory,
        clerkFrontendApiHostname: undefined,
      });
      const request = (pathname: string, init?: RequestInit) =>
        Effect.promise(() => handler!(new Request(`t3code://app${pathname}`, init)));

      // SPA routes fall back to index.html, including ones containing dots.
      const page = yield* request("/settings/connections");
      assert.equal(yield* Effect.promise(() => page.text()), "<html>app</html>");
      assert.include(page.headers.get("content-security-policy") ?? "", "default-src 'self'");
      const dottedRoute = yield* request("/environment/thread.with.dots", {
        headers: { accept: "text/html" },
      });
      assert.equal(yield* Effect.promise(() => dottedRoute.text()), "<html>app</html>");

      const script = yield* request("/app.js?v=1");
      assert.equal(yield* Effect.promise(() => script.text()), "export default 1;");
      assert.include(script.headers.get("content-type") ?? "", "javascript");

      assert.equal((yield* request("/missing.js")).status, 404);
      assert.equal((yield* request("/%2e%2e%2fsecret.txt")).status, 404);
      assert.equal((yield* request("/%invalid")).status, 400);
      assert.equal((yield* request("/", { method: "POST" })).status, 405);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(Layer.merge(protocolLayer, NodeServices.layer)), Effect.scoped),
  );

  it.effect("proxies the stable renderer origin to the current app server", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(new Response("ok"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code-dev",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: "clerk.t3.codes",
          });
          assert.isDefined(handler);

          const response = yield* Effect.promise(() =>
            handler!(
              new Request("t3code-dev://app/api/health?verbose=1", {
                headers: {
                  accept: "application/json",
                  origin: "t3code-dev://app",
                  referer: "t3code-dev://app/",
                  "sec-fetch-site": "same-origin",
                },
              }),
            ),
          );
          assert.equal(yield* Effect.promise(() => response.text()), "ok");
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://clerk.t3.codes https://challenges.cloudflare.com",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "connect-src 'self' http: https: ws: wss:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "img-src 'self' t3code-dev: blob: data: http: https:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "font-src 'self' t3code-dev: data:",
          );
        }),
      );

      assert.deepEqual(
        handleMock.mock.calls.map((call) => call[0]),
        ["t3code-dev"],
      );
      assert.equal(netFetchMock.mock.calls[0]?.[0], "http://127.0.0.1:3773/api/health?verbose=1");
      const forwardedHeaders = new Headers(netFetchMock.mock.calls[0]?.[1]?.headers);
      assert.equal(forwardedHeaders.get("accept"), "application/json");
      assert.isNull(forwardedHeaders.get("origin"));
      assert.isNull(forwardedHeaders.get("referer"));
      assert.isNull(forwardedHeaders.get("sec-fetch-site"));
      assert.deepEqual(unhandleMock.mock.calls, [["t3code-dev"]]);
    }).pipe(Effect.provide(protocolLayer)),
  );

  it.effect("rejects custom protocol requests for another host", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          });
          return yield* Effect.promise(() => handler!(new Request("t3code://other/")));
        }),
      );

      assert.equal(response.status, 404);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(protocolLayer)),
  );

  it.effect("retries transient renderer target failures", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5733"))
        .mockResolvedValueOnce(new Response("ready"));

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code-dev",
            targetOrigin: new URL("http://127.0.0.1:5733/"),
            clerkFrontendApiHostname: undefined,
          });
          return yield* Effect.promise(() => handler!(new Request("t3code-dev://app/")));
        }),
      );

      assert.equal(yield* Effect.promise(() => response.text()), "ready");
      assert.equal(netFetchMock.mock.calls.length, 2);
    }).pipe(Effect.provide(protocolLayer)),
  );

  it.effect("preserves protocol registration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol registration failed");
      handleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const error = yield* Effect.scoped(
        protocol.registerDesktopProtocol({
          scheme: "t3code-dev",
          targetOrigin: new URL("http://127.0.0.1:3773/"),
          clerkFrontendApiHostname: undefined,
        }),
      ).pipe(Effect.flip);

      assert.instanceOf(error, ElectronProtocol.ElectronProtocolRegistrationError);
      assert.equal(error.scheme, "t3code-dev");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, 'Failed to register Electron protocol scheme "t3code-dev".');
    }).pipe(Effect.provide(protocolLayer)),
  );

  it.effect("preserves protocol unregistration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol unregistration failed");
      unhandleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const exit = yield* Effect.exit(
        Effect.scoped(
          protocol.registerDesktopProtocol({
            scheme: "t3code",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          }),
        ),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronProtocol.ElectronProtocolUnregistrationError);
        assert.equal(error.scheme, "t3code");
        assert.strictEqual(error.cause, cause);
        assert.equal(error.message, 'Failed to unregister Electron protocol scheme "t3code".');
      }
    }).pipe(Effect.provide(protocolLayer)),
  );

  it("keeps executable sources host-restricted while allowing runtime network resources", () => {
    const policy = ElectronProtocol.makeDesktopContentSecurityPolicy({
      scheme: "t3code",
      targetOrigin: new URL("http://127.0.0.1:3773/"),
      clerkFrontendApiHostname: "clerk.t3.codes",
    });
    const directives = Object.fromEntries(
      policy.split("; ").map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name, sources];
      }),
    );

    assert.deepEqual(directives["script-src"], [
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      "https://clerk.t3.codes",
      "https://challenges.cloudflare.com",
    ]);
    assert.deepEqual(directives["connect-src"], ["'self'", "http:", "https:", "ws:", "wss:"]);
    assert.deepEqual(directives["img-src"], [
      "'self'",
      "t3code:",
      "blob:",
      "data:",
      "http:",
      "https:",
    ]);
    assert.deepEqual(directives["media-src"], ["'self'", "t3code:", "blob:", "http:", "https:"]);
    assert.deepEqual(directives["frame-src"], ["'self'", "blob:", "http:", "https:"]);
    assert.deepEqual(directives["font-src"], ["'self'", "t3code:", "data:"]);
  });
});
