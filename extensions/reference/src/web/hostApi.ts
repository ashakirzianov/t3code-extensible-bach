/**
 * The slice of the host's web API this extension uses.
 *
 * Typed here rather than imported: the web bundle is standalone too, and
 * importing host types would be a workspace link through the back door.
 */
export interface HostApi {
  /** Authenticated fetch scoped to the environment this mount belongs to. */
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly navigateToThread?: (threadId: string) => void;
  readonly environmentId?: string;
}

export interface StatusPayload {
  readonly name: string;
  readonly startedAt: string;
  readonly environmentId: string;
  readonly echoCount: number;
  readonly lastEcho: {
    readonly id: number;
    readonly at: string;
    readonly threadId: string;
    readonly message: string;
  } | null;
}
