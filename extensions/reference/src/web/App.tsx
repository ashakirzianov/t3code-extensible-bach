/**
 * The extension's UI: current status and the last echo.
 *
 * Every class name is prefixed `t3ref-`, and the stylesheet sets no element
 * selectors at all. An extension's CSS lands in the host's document, so a
 * Tailwind preflight or a bare `button { }` here would restyle the host.
 */
import { useCallback, useEffect, useState } from "react";
import type { HostApi, StatusPayload } from "./hostApi.js";

interface AppProps {
  readonly hostApi: HostApi;
  readonly subPath: string;
}

export function App({ hostApi, subPath }: AppProps) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Relative to the prefix the host mounted for us; the host's authenticated
      // fetch supplies origin and credentials.
      const response = await hostApi.fetch(hostApi.environmentId, "/status");
      if (!response.ok) throw new Error(`Host returned ${String(response.status)}`);
      setStatus((await response.json()) as StatusPayload);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [hostApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="t3ref-root">
      <header className="t3ref-header">
        <h1 className="t3ref-title">Reference extension</h1>
        <button className="t3ref-button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {/* Colors come from the host's CSS variables, so the extension follows
          the user's theme without knowing which theme is active. */}
      {error !== null && <p className="t3ref-error">Could not reach the extension: {error}</p>}

      {status !== null && (
        <dl className="t3ref-grid">
          <dt className="t3ref-key">Environment</dt>
          <dd className="t3ref-value">{status.environmentId}</dd>
          <dt className="t3ref-key">Started</dt>
          <dd className="t3ref-value">{new Date(status.startedAt).toLocaleString()}</dd>
          <dt className="t3ref-key">Echoes</dt>
          <dd className="t3ref-value">{status.echoCount}</dd>
          <dt className="t3ref-key">Last echo</dt>
          <dd className="t3ref-value">
            {status.lastEcho === null ? (
              <span className="t3ref-muted">
                None yet — ask an agent to call <code className="t3ref-code">reference_echo</code>.
              </span>
            ) : (
              <>
                <span className="t3ref-echo">{status.lastEcho.message}</span>{" "}
                <button
                  className="t3ref-link"
                  onClick={() => hostApi.navigateToThread(status.lastEcho!.threadId)}
                >
                  open thread
                </button>
              </>
            )}
          </dd>
        </dl>
      )}

      {subPath !== "" && subPath !== "/" && (
        <p className="t3ref-muted">
          Sub-path <code className="t3ref-code">{subPath}</code> — the host owns
          <code className="t3ref-code"> /ext/&lt;env&gt;/reference/*</code> and hands the rest here.
        </p>
      )}
    </div>
  );
}
