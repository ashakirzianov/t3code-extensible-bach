# An extension on a remote environment

How an extension that lives on another machine is reached, and how to check by hand that it
still is. The design is in [`protocol.md`](protocol.md) ("An extension on a remote
environment"); this page is the part that cannot be a unit test.

## What is reachable, and from where

| Client                                           | Environment              | Bundle                                                   |
| ------------------------------------------------ | ------------------------ | -------------------------------------------------------- |
| any                                              | same origin as the page  | direct, unchanged                                        |
| desktop                                          | the primary (local) one  | direct, through the `t3code://` bridge for `/ext-assets` |
| desktop                                          | reached over SSH         | through the app's own asset proxy                        |
| desktop                                          | LAN URL, relay, tunnel   | refused, with the message                                |
| browser (app.t3.codes, or served by a T3 server) | anything not same-origin | refused, with the message                                |

The browser has no backend of its own that knows the client's other environments — the
environment list is client state, and a T3 server knows nothing about the environments its
client is connected to — so there is nothing there to proxy through.

## The corollary

Connecting an environment over SSH means **that machine's extension web code runs inside the
desktop app, under the app's own origin**, with the same reach as the local environment's
extensions. Origin is all the CSP has, so it cannot tell them apart. Connect over SSH only to
a machine whose extensions you would be willing to install here.

## Manual verification

Nothing below is covered by the suite: it needs a real SSH environment, a real Electron
renderer, and a real Deploy.

**Setup.** A desktop build of this fork, and a remote machine with Bach installed and running
in its own T3 home. Connect to it over SSH from the app (Settings → environments → add an SSH
host). Keep the remote server's HTTP log where you can read it, and open the renderer's
devtools.

1. **It mounts.** Click the remote environment's Bach entry in the sidebar. The interface
   appears, styled, instead of "runs on a remote server, and its interface cannot be loaded
   from here yet".
2. **It came through the proxy.** In the Network tab, the bundle and the stylesheet were
   fetched from `t3code://app/__ext-remote/<port>/ext-assets/…`, where `<port>` is that
   environment's forwarded loopback port. No request went to `http://127.0.0.1:<port>` for a
   script.
3. **No credential rode along.** In the remote server's log, the `/ext-assets/…` requests
   carry **no `Cookie` and no `Authorization` header**. The signed token in the path is the
   only credential.
4. **A Deploy mid-session loads new bytes.** Change something visible in the remote Bach
   build, Deploy it there, and reopen the entry. The token in the asset URL is different and
   the new text is on screen — the old URL is not re-used from the module registry.
5. **Only the asset route travels, on a live port.** With the environment still connected,
   fetch these from the devtools console — the port is a real, open, forwarded one, so this
   is the allow-list being exercised by the real handler rather than by a unit test:

   ```js
   for (const path of [
     "/__ext-remote/<port>/api/environment",
     "/__ext-remote/<port>/ext-api/<environmentId>/bach/agents",
   ]) {
     console.log(path, (await fetch(path)).status);
   }
   ```

   Both must be **404**. Fetching `http://127.0.0.1:<port>/api/environment` directly still
   answers — the environment is up and the renderer may talk to it — which is the point: the
   proxy refuses it, not the network.

6. **A write is refused.** `await fetch("/__ext-remote/<port>/ext-assets/…", { method: "POST" })`
   on the same live URL that answers a `GET`: **404**. An asset is read, never written.

7. **A port this app did not open is refused, even with something listening.** Start any local
   server on a free port (`python3 -m http.server 8931`), then fetch
   `/__ext-remote/8931/ext-assets/anything.js`: **404**, and nothing appears in that server's
   log. This is the one that proves the port table is an allow-list and not just a lookup that
   falls back to "try it".

8. **After a disconnect the old URL is dead.** Note the `/__ext-remote/<port>/ext-assets/…`
   URL, disconnect the SSH environment, then paste that URL into the renderer's address bar
   or fetch it from the devtools console. It must answer **404, not index.html** — an SPA
   fallback here would answer an `import()` with HTML and turn a refusal into a syntax error.
   Reconnecting and reopening the entry must work again.
9. **Its tunnel dying is the same as disconnecting.** Kill the `ssh -N` process for that
   environment from a terminal (find it by the forwarded port, not by name), then repeat
   step 8's fetch: still 404. This is the case where a port could otherwise stay claimed and
   be answered for after an unrelated local service bound it.
10. **LAN and relay still refuse.** Add the same remote machine again as a plain URL
    (Tailscale/LAN address) and open its Bach entry: the message, not the interface. Same for
    a relay-managed environment.
11. **The browser still refuses.** Open the app at `app.t3.codes` (or a page served by a T3
    server) with the same environments connected: the remote one shows the message, and the
    same-origin one still mounts.
12. **The local environment is unchanged.** The primary environment's Bach entry mounts
    exactly as before, from `/ext-assets/…` with no `__ext-remote` prefix.
13. **The local environment's bundle comes from the backend, in a _packaged_ build.** This is
    the one that has to be checked on an installed app rather than a dev server, because the
    two serve the renderer differently and only the packaged one is a directory of static
    files. Open the primary environment's Bach entry: the interface appears, and the Network
    tab shows `t3code://app/ext-assets/…` answering with `text/javascript` rather than a 404
    or `index.html`. Then, in the devtools console,
    `(await fetch("/ext-assets/anything.js")).status` must be **404**, and
    `(await fetch("/api/environment")).status` must not be a proxied answer from the local
    backend — the bridge carries the asset route and nothing else.
14. **A broken bundle does not reload the app.** With devtools open on the extension page,
    `await fetch(...)` is not enough; make the import itself fail (rename the extension's
    `dist` entry file and reopen the page). The page must settle on "Could not load the bach
    extension." and stay there. A renderer that reloads on a loop instead is the regression
    this pair of checks exists for.

A bundle that imports an **absolute** `/ext-assets/...` path rather than a relative chunk
would not be re-based and would miss the proxy; Vite-built bundles emit relative chunks, so
this has not been seen, but it is the shape of failure to look for if a chunk 404s.
