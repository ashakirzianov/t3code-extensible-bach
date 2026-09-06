/**
 * Signing and verification for extension web-asset URLs.
 *
 * Deliberately the same shape as `assets/AssetAccess.ts`: an HMAC over a claims
 * blob, carried as a path segment, with a bounded lifetime. The reason is the
 * same too — the client loads the bundle with a same-origin `import()`, and a
 * dynamic import cannot set an `Authorization` header, so the only place a
 * credential can travel is the URL itself.
 *
 * A separate signing key from `AssetAccess`, so a token minted for one surface
 * can never be replayed against the other.
 */
import {
  ExtensionNotFoundError,
  type ExtensionAssetUrlsResult,
  type ExtensionName,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  assetExpiryFrom,
  decodeAssetClaims,
  encodeAssetClaims,
  EXT_ASSETS_ROUTE_PREFIX,
  type ExtensionAssetClaims,
} from "./ExtensionHttp.ts";

const SIGNING_SECRET_NAME = "extension-asset-signing-key";

const signingSecret = ServerSecretStore.ServerSecretStore.pipe(
  Effect.flatMap((store) => store.getOrCreateRandom(SIGNING_SECRET_NAME, 32)),
);

/** Mints `<base64url(claims)>.<hmac>`, the same token shape `AssetAccess` uses. */
export const mintExtensionAssetToken = Effect.fn("extensions.assets.mint")(function* (
  name: ExtensionName,
) {
  const secret = yield* signingSecret;
  const expiresAt = assetExpiryFrom(yield* Clock.currentTimeMillis);
  const payload = base64UrlEncode(encodeAssetClaims({ version: 1, name, expiresAt }));
  return { token: `${payload}.${signPayload(payload, secret)}`, expiresAt };
});

/**
 * Builds the absolute path the client loads.
 *
 * The extension name appears in the path as well as inside the signed claims:
 * the claims are what authorise, and the path segment is what makes a URL
 * readable in a network panel.
 */
export function extensionAssetPath(input: {
  readonly token: string;
  readonly name: ExtensionName;
  readonly relativePath: string;
}): string {
  const encodedPath = input.relativePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${EXT_ASSETS_ROUTE_PREFIX}/${input.token}/${encodeURIComponent(input.name)}/${encodedPath}`;
}

/**
 * Verifies a token and returns its claims, or null.
 *
 * Null for every failure — bad shape, bad signature, expired — because the
 * caller answers all of them with the same 404. Telling an unauthenticated
 * caller which one it was only helps them.
 */
export const verifyExtensionAssetToken = Effect.fn("extensions.assets.verify")(function* (
  token: string,
): Effect.fn.Return<ExtensionAssetClaims | null, never, ServerSecretStore.ServerSecretStore> {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const secret = yield* signingSecret.pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to load the extension asset signing key.", { cause }),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (!secret) return null;
  if (!timingSafeEqualBase64Url(signature, signPayload(payload, secret))) return null;

  let decoded: string;
  try {
    decoded = base64UrlDecodeUtf8(payload);
  } catch {
    return null;
  }
  const claims = decodeAssetClaims(decoded);
  if (!claims) return null;
  return claims.expiresAt > (yield* Clock.currentTimeMillis) ? claims : null;
});

/**
 * Answers `extensions.admin.assetUrls`: one token, three paths.
 *
 * All the entries share a single token because they are one extension's assets
 * with one lifetime — minting three would triple the work and expire them at
 * three different moments for no benefit.
 */
export const mintExtensionAssetUrls = Effect.fn("extensions.assets.urls")(function* (
  registry: {
    readonly get: (
      name: ExtensionName,
    ) => Effect.Effect<
      { readonly web?: { readonly entry: string; readonly css?: string; readonly icon?: string } },
      ExtensionNotFoundError
    >;
  },
  name: ExtensionName,
): Effect.fn.Return<
  ExtensionAssetUrlsResult,
  ExtensionNotFoundError,
  ServerSecretStore.ServerSecretStore
> {
  const status = yield* registry.get(name);
  // No web entry is the same answer as no extension: there is nothing to mount,
  // and the client should not be handed URLs that cannot resolve.
  if (!status.web) return yield* new ExtensionNotFoundError({ extensionName: name });

  // A secret-store failure is an internal fault, not something the caller can
  // act on, and the RPC's error union is the admin errors only.
  const { token, expiresAt } = yield* mintExtensionAssetToken(name).pipe(Effect.orDie);
  const pathFor = (relativePath: string) => extensionAssetPath({ token, name, relativePath });

  return {
    name,
    entry: pathFor(status.web.entry),
    ...(status.web.css !== undefined ? { css: pathFor(status.web.css) } : {}),
    ...(status.web.icon !== undefined ? { icon: pathFor(status.web.icon) } : {}),
    expiresAt,
  };
});
