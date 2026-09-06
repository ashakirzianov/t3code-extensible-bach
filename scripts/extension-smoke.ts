#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone CI script, no Effect runtime.
/**
 * End-to-end smoke test for the extension seam (design §7).
 *
 * Starts a real server against a scratch home with the built reference
 * extension registered, then asserts the three things that can be checked
 * without an agent or a browser:
 *
 *   1. the supervisor spawned it and it completed the handshake,
 *   2. `extensions.admin.list` reports it running with its tool, prefix and
 *      web entry,
 *   3. its HTTP prefix answers through the host's own auth.
 *
 * The full run — a real thread calling the tool, deploy, resources — is in
 * docs/internals/extensions/spikes/e2e-server-2026-09-06.md and needs a
 * provider credential, so it stays out of CI.
 *
 * Deliberately dependency-free: it authenticates the WebSocket with a ticket
 * from `/api/auth/websocket-ticket` rather than an `Authorization` header,
 * because Node's global WebSocket cannot set handshake headers and pulling in
 * `ws` for a CI script is not worth it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const argOf = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const homeDir = NodePath.resolve(argOf("home-dir") ?? NodePath.join(repoRoot, ".t3-smoke"));
const port = Number(argOf("port") ?? 17533);
const extensionDist = NodePath.join(repoRoot, "extensions/reference/dist");

const fail = (message: string): never => {
  console.error(`[smoke] FAIL ${message}`);
  process.exit(1);
};
const ok = (message: string) => console.log(`[smoke] ok — ${message}`);

if (!NodeFS.existsSync(NodePath.join(extensionDist, "extension.json"))) {
  fail(`no built extension at ${extensionDist}. Run \`pnpm build\` in extensions/reference first.`);
}

NodeFS.mkdirSync(homeDir, { recursive: true });

// The `--extension name=path` launch flag rather than a settings entry: it is
// the shape the desktop uses for a shipped extension, and it saves this script
// from writing a settings file it would then have to keep valid.
const server = NodeChildProcess.spawn(
  process.execPath,
  [
    NodePath.join(repoRoot, "apps/server/src/bin.ts"),
    "--port",
    String(port),
    "--base-dir",
    homeDir,
    "--no-browser",
    "--extension",
    `reference=${extensionDist}`,
  ],
  {
    cwd: repoRoot,
    env: { ...process.env, T3CODE_HOME: homeDir },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let serverOutput = "";
const capture = (chunk: Buffer) => (serverOutput += chunk.toString());
server.stdout.on("data", capture);
server.stderr.on("data", capture);

// Always take the server down, however this exits.
const stopServer = () => {
  if (!server.killed) server.kill("SIGTERM");
};
process.on("exit", stopServer);
process.on("SIGINT", () => process.exit(130));

const base = `http://127.0.0.1:${String(port)}`;
const deadline = Date.now() + 90_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  // 1. Wait for the server, then for the extension to finish its handshake.
  while (Date.now() < deadline) {
    if (server.exitCode !== null)
      fail(`server exited early (${String(server.exitCode)}):\n${serverOutput}`);
    try {
      // Any answer means the HTTP router is live. Status is deliberately not
      // checked: without a built web client the static fallback answers 503,
      // and an authenticated route answers 401 — both mean "up".
      await fetch(`${base}/api/auth/pairing-links`);
      break;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  if (Date.now() >= deadline) fail(`server did not start within 90s:\n${serverOutput}`);
  ok(`server listening on ${base}`);

  const pairOutput = NodeChildProcess.execFileSync(
    process.execPath,
    [NodePath.join(repoRoot, "apps/server/src/bin.ts"), "pair"],
    { cwd: repoRoot, env: { ...process.env, T3CODE_HOME: homeDir }, encoding: "utf8" },
  );
  const pairingToken = /^Token: (\S+)$/m.exec(pairOutput)?.[1];
  if (!pairingToken) fail(`could not read a pairing token from:\n${pairOutput}`);

  const tokenResponse = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: pairingToken,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "extension-smoke",
    }),
  });
  if (!tokenResponse.ok)
    fail(`token exchange failed ${String(tokenResponse.status)}: ${await tokenResponse.text()}`);
  const accessToken = ((await tokenResponse.json()) as { access_token: string }).access_token;
  ok("paired");

  // 2. The registry's view. Poll: the handshake races the first request.
  const listExtensions = async () => {
    const ticketResponse = await fetch(`${base}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!ticketResponse.ok) fail(`websocket ticket failed ${String(ticketResponse.status)}`);
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    const socket = new WebSocket(
      `${base.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}`,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("socket error")), { once: true });
      });
      return await new Promise<{ extensions: ReadonlyArray<Record<string, unknown>> }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("admin.list timed out")), 20_000);
          socket.addEventListener("message", (event) => {
            const parsed = JSON.parse(String(event.data)) as unknown;
            for (const message of (Array.isArray(parsed) ? parsed : [parsed]) as Array<
              Record<string, any>
            >) {
              if (message._tag !== "Exit") continue;
              clearTimeout(timer);
              if (message.exit._tag !== "Success")
                reject(new Error(JSON.stringify(message.exit.cause)));
              else resolve(message.exit.value);
            }
          });
          socket.send(
            JSON.stringify({
              _tag: "Request",
              id: 1,
              tag: "extensions.admin.list",
              payload: {},
              headers: [],
            }),
          );
        },
      );
    } finally {
      socket.close();
    }
  };

  let listed: Record<string, unknown> | undefined;
  const listDeadline = Date.now() + 60_000;
  while (Date.now() < listDeadline) {
    const found = (await listExtensions()).extensions.find((entry) => entry.name === "reference");
    if (found?.state === "running") {
      listed = found;
      break;
    }
    await sleep(1000);
  }
  if (!listed) fail("the reference extension never reached `running`");
  if (!(listed.tools as ReadonlyArray<string>).includes("reference_echo")) {
    fail(`tool not registered: ${JSON.stringify(listed.tools)}`);
  }
  if (listed.httpPrefix !== "reference")
    fail(`http prefix not registered: ${String(listed.httpPrefix)}`);
  if (!listed.web) fail("web entry not registered");
  if (!listed.folderHash) fail("folder hash missing");
  ok("admin.list reports it running with its tool, prefix, web entry and hash");

  // 3. The HTTP prefix, through the host's own auth.
  const environmentId = String(
    listed.environmentId ??
      NodeFS.readFileSync(NodePath.join(homeDir, "userdata", "environment-id"), "utf8").trim(),
  );
  const statusUrl = `${base}/ext-api/${environmentId}/reference/status`;

  const unauthorized = await fetch(statusUrl);
  if (unauthorized.status !== 401)
    fail(`unauthenticated request should be 401, got ${String(unauthorized.status)}`);

  const status = await fetch(statusUrl, { headers: { authorization: `Bearer ${accessToken}` } });
  if (status.status !== 200)
    fail(`status route returned ${String(status.status)}: ${await status.text()}`);
  const payload = (await status.json()) as { name?: string };
  if (payload.name !== "reference") fail(`unexpected status body: ${JSON.stringify(payload)}`);
  ok(
    "the extension's HTTP prefix answers under the host's auth, and rejects an unauthenticated caller",
  );

  console.log("[smoke] PASS");
  process.exit(0);
} catch (error) {
  console.error(serverOutput);
  fail(String(error));
}
