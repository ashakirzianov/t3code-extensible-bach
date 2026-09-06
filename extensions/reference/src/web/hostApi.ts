/**
 * The slice of the host's web API this extension uses.
 *
 * Typed here rather than imported: the web bundle is standalone too, and
 * importing host types would be a workspace link through the back door.
 */
export interface HostEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly current: boolean;
}

export interface HostApi {
  /** The environment this mount belongs to; the usual argument to `fetch`. */
  readonly environmentId: string;
  /**
   * Authenticated request to this extension's own HTTP prefix on one
   * environment. Naming the environment is what lets a mount reach the sibling
   * instance running on another one; for its own, pass `hostApi.environmentId`.
   */
  readonly fetch: (environmentId: string, path: string, init?: RequestInit) => Promise<Response>;
  readonly environments: ReadonlyArray<HostEnvironment>;
  readonly navigateToThread: (threadId: string, environmentId?: string) => void;
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
