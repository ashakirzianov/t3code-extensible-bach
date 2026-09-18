# An extension on a remote environment

How an extension that lives on another machine is reached, and how to check by hand that it
still is. The design is in [`protocol.md`](protocol.md) ("An extension on a remote
environment"); this page is the part that cannot be a unit test.

## What is reachable, and from where

| Client                                           | Environment              | Bundle                                |
| ------------------------------------------------ | ------------------------ | ------------------------------------- |
| any                                              | same origin as the page  | direct, unchanged                     |
| desktop                                          | the primary (local) one  | direct, through the `t3code://` proxy |
| desktop                                          | reached over SSH         | through the app's own asset proxy     |
| desktop                                          | LAN URL, relay, tunnel   | refused, with the message             |
| browser (app.t3.codes, or served by a T3 server) | anything not same-origin | refused, with the message             |

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
5. **After a disconnect the old URL is dead.** Note the `/__ext-remote/<port>/ext-assets/…`
   URL, disconnect the SSH environment, then paste that URL into the renderer's address bar
   or fetch it from the devtools console. It must answer **404, not index.html** — an SPA
   fallback here would answer an `import()` with HTML and turn a refusal into a syntax error.
   Reconnecting and reopening the entry must work again.
6. **Its tunnel dying is the same as disconnecting.** Kill the `ssh -N` process for that
   environment from a terminal (find it by the forwarded port, not by name), then repeat
   step 5's fetch: still 404. This is the case where a port could otherwise stay claimed and
   be answered for after an unrelated local service bound it.
7. **LAN and relay still refuse.** Add the same remote machine again as a plain URL
   (Tailscale/LAN address) and open its Bach entry: the message, not the interface. Same for
   a relay-managed environment.
8. **The browser still refuses.** Open the app at `app.t3.codes` (or a page served by a T3
   server) with the same environments connected: the remote one shows the message, and the
   same-origin one still mounts.
9. **The local environment is unchanged.** The primary environment's Bach entry mounts
   exactly as before, from `/ext-assets/…` with no `__ext-remote` prefix.

A bundle that imports an **absolute** `/ext-assets/...` path rather than a relative chunk
would not be re-based and would miss the proxy; Vite-built bundles emit relative chunks, so
this has not been seen, but it is the shape of failure to look for if a chunk 404s.
