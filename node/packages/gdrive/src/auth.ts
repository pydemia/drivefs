import { AuthenticationError } from "@pydemia/drivefs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleToken {
  access_token: string;
  refresh_token?: string | null;
  /** UTC epoch milliseconds. */
  expires_at?: number | null;
}

export interface GoogleCredentialStore {
  load(): GoogleToken | null | Promise<GoogleToken | null>;
  save(token: GoogleToken): void | Promise<void>;
}

export class MemoryCredentialStore implements GoogleCredentialStore {
  #token: GoogleToken | null;

  constructor(token: GoogleToken | null = null) {
    this.#token = token;
  }

  load(): GoogleToken | null {
    return this.#token;
  }

  save(token: GoogleToken): void {
    this.#token = token;
  }
}

export interface GoogleAuthOptions {
  store: GoogleCredentialStore;
  client_id?: string;
  client_secret?: string;
}

export class GoogleAuth {
  readonly #store: GoogleCredentialStore;
  readonly #client_id: string | undefined;
  readonly #client_secret: string | undefined;
  #pending: Promise<string> | null = null;

  constructor(options: GoogleAuthOptions) {
    this.#store = options.store;
    this.#client_id = options.client_id;
    this.#client_secret = options.client_secret;
  }

  async access_token(
    fetcher: typeof fetch,
    force_refresh = false,
    failed_token?: string,
  ): Promise<string> {
    let token: GoogleToken | null;
    try {
      token = await this.#store.load();
    } catch {
      throw new AuthenticationError("credential load failed");
    }
    if (!token?.access_token) {
      throw new AuthenticationError("no Google access token is available");
    }
    if (force_refresh && failed_token && token.access_token !== failed_token) {
      return token.access_token;
    }
    if (!force_refresh && !this.#expires_soon(token)) {
      return token.access_token;
    }
    if (!token.refresh_token || !this.#client_id || !this.#client_secret) {
      throw new AuthenticationError("Google token refresh is unavailable");
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

  #expires_soon(token: GoogleToken): boolean {
    return (
      token.expires_at !== null &&
      token.expires_at !== undefined &&
      token.expires_at <= Date.now() + 60_000
    );
  }

  async #refresh(fetcher: typeof fetch, token: GoogleToken): Promise<string> {
    let payload: unknown;
    try {
      const body = new URLSearchParams({
        client_id: this.#client_id!,
        client_secret: this.#client_secret!,
        refresh_token: token.refresh_token!,
        grant_type: "refresh_token",
      });
      const response = await fetcher(TOKEN_URL, { method: "POST", body });
      if (!response.ok) {
        throw new AuthenticationError("Google token refresh was rejected");
      }
      payload = await response.json();
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError("Google token refresh failed");
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      !("access_token" in payload) ||
      typeof payload.access_token !== "string" ||
      !payload.access_token
    ) {
      throw new AuthenticationError("Google token refresh was invalid");
    }
    const body = payload as {
      access_token: string;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
    const seconds = Number(body.expires_in);
    const updated: GoogleToken = {
      access_token: body.access_token,
      refresh_token:
        typeof body.refresh_token === "string"
          ? body.refresh_token
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
