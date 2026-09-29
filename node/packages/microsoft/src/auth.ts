import { AuthenticationError, InvalidArgumentError } from "@pydemia/drivefs";

export interface GraphToken {
  access_token: string;
  refresh_token?: string | null;
  /** UTC epoch milliseconds. */
  expires_at?: number | null;
}

export interface GraphCredentialStore {
  load(): GraphToken | null | Promise<GraphToken | null>;
  save(token: GraphToken): void | Promise<void>;
}

export class MemoryCredentialStore implements GraphCredentialStore {
  #token: GraphToken | null;

  constructor(token: GraphToken | null = null) {
    this.#token = token;
  }

  load(): GraphToken | null {
    return this.#token;
  }

  save(token: GraphToken): void {
    this.#token = token;
  }
}

export interface GraphAuthOptions {
  tenant_id: string;
  client_id: string;
  store: GraphCredentialStore;
  client_secret?: string;
  scopes?: string;
}

export class GraphAuth {
  readonly tenant_id: string;
  readonly #client_id: string;
  readonly #client_secret: string | undefined;
  readonly #scopes: string | undefined;
  readonly #store: GraphCredentialStore;
  #pending: Promise<string> | null = null;

  constructor(options: GraphAuthOptions) {
    if (!options.tenant_id || !options.client_id) {
      throw new InvalidArgumentError("tenant_id and client_id are required");
    }
    this.tenant_id = options.tenant_id;
    this.#client_id = options.client_id;
    this.#client_secret = options.client_secret;
    this.#scopes = options.scopes;
    this.#store = options.store;
  }

  async access_token(
    fetcher: typeof fetch,
    force_refresh = false,
    failed_token?: string,
  ): Promise<string> {
    let token: GraphToken | null;
    try {
      token = await this.#store.load();
    } catch {
      throw new AuthenticationError("credential load failed");
    }
    if (!token?.access_token) {
      throw new AuthenticationError("no Graph access token is available");
    }
    if (force_refresh && failed_token && token.access_token !== failed_token) {
      return token.access_token;
    }
    if (!force_refresh && !this.#expires_soon(token)) {
      return token.access_token;
    }
    if (!token.refresh_token) {
      throw new AuthenticationError("Graph token refresh is unavailable");
    }
    if (this.#pending) return this.#pending;
    const pending = this.#refresh(fetcher, token);
    this.#pending = pending;
    try {
      return await pending;
    } finally {
      this.#pending = null;
    }
  }

  #expires_soon(token: GraphToken): boolean {
    return (
      token.expires_at !== null &&
      token.expires_at !== undefined &&
      token.expires_at <= Date.now() + 60_000
    );
  }

  async #refresh(fetcher: typeof fetch, token: GraphToken): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.#client_id,
      refresh_token: token.refresh_token!,
      grant_type: "refresh_token",
    });
    if (this.#client_secret) body.set("client_secret", this.#client_secret);
    if (this.#scopes) body.set("scope", this.#scopes);
    let payload: unknown;
    try {
      const response = await fetcher(
        `https://login.microsoftonline.com/${encodeURIComponent(this.tenant_id)}/oauth2/v2.0/token`,
        { method: "POST", body },
      );
      if (!response.ok) {
        throw new AuthenticationError("Graph token refresh was rejected");
      }
      payload = await response.json();
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError("Graph token refresh failed");
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      !("access_token" in payload) ||
      typeof payload.access_token !== "string" ||
      !payload.access_token
    ) {
      throw new AuthenticationError("Graph token refresh was invalid");
    }
    const result = payload as {
      access_token: string;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
    const seconds = Number(result.expires_in);
    const updated: GraphToken = {
      access_token: result.access_token,
      refresh_token:
        typeof result.refresh_token === "string"
          ? result.refresh_token
          : (token.refresh_token ?? null),
      expires_at: Number.isFinite(seconds) ? Date.now() + seconds * 1000 : null,
    };
    try {
      await this.#store.save(updated);
    } catch {
      throw new AuthenticationError("credential save failed");
    }
    return updated.access_token;
  }
}
