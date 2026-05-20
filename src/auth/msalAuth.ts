/**
 * MSAL public-client wiring.
 *
 * Primary auth flow: device code. Reason: stdio MCP servers are
 * launched as child processes and we cannot rely on `open browser`
 * UX from inside that context (no controlled terminal, no guarantee
 * that the parent surfaces stderr promptly, no guaranteed loopback
 * port). Device code returns a URL+code that the tool surfaces in
 * its structured result; the assistant relays it to the user.
 *
 * Interactive flow is gated behind `AUTH_MODE=interactive` and is
 * intended for direct (non-MCP) runs.
 */
import {
  PublicClientApplication,
  type AuthenticationResult,
  type Configuration,
  type AccountInfo,
} from "@azure/msal-node";
import { TokenStore } from "./tokenStore.js";
import { createMsalCachePlugin } from "./tokenCache.js";
import type {
  EngageError} from "../utils/errors.js";
import {
  EngageAuthError,
  EngagePermissionError
} from "../utils/errors.js";
import { logger, sanitizeError } from "../utils/logger.js";

export interface MsalAuthOptions {
  clientId: string;
  tenantId: string;
  scopes: string[];
  cacheDir: string;
  authMode: "device_code" | "interactive";
}

export interface DeviceCodeChallenge {
  userCode: string;
  verificationUri: string;
  message: string;
  expiresInSeconds: number;
}

export interface AuthSnapshot {
  account: {
    username: string;
    tenantId?: string;
    homeAccountId: string;
  } | null;
  scopes: string[];
  authMode: "device_code" | "interactive";
  cacheDir: string;
}

export class MsalAuth {
  private readonly pca: PublicClientApplication;
  private readonly opts: MsalAuthOptions;
  private readonly store: TokenStore;
  /** Set during a device-code login so `auth_status` can surface progress. */
  private pendingDeviceCode: DeviceCodeChallenge | null = null;
  /** Last cached account for fast silent-refresh attempts. */
  private cachedAccount: AccountInfo | null = null;

  constructor(opts: MsalAuthOptions) {
    this.opts = opts;
    this.store = new TokenStore({ cacheDir: opts.cacheDir });
    const config: Configuration = {
      auth: {
        clientId: opts.clientId,
        authority: `https://login.microsoftonline.com/${opts.tenantId}`,
      },
      cache: {
        cachePlugin: createMsalCachePlugin(this.store),
      },
    };
    this.pca = new PublicClientApplication(config);
  }

  /**
   * Returns a valid access token. Tries silent acquisition first; if
   * that fails, throws `EngageAuthError` to signal that the user must
   * call `auth_login` to begin device-code flow.
   *
   * This is the function passed to the HttpClient's `getBearerToken`.
   */
  async getAccessToken(): Promise<string> {
    const account = await this.resolveAccount();
    if (account) {
      try {
        const result = await this.pca.acquireTokenSilent({
          account,
          scopes: this.opts.scopes,
        });
        if (result?.accessToken) return result.accessToken;
      } catch (err) {
        logger.info(
          { err: sanitizeError(err) },
          "silent token acquisition failed; user must re-authenticate",
        );
      }
    }
    throw new EngageAuthError(
      "Not signed in. Call the `auth_login` tool to start device-code authentication.",
    );
  }

  /**
   * Begin (or continue) interactive login. For device_code mode this
   * returns the device challenge synchronously and resolves the
   * promise to `null` once the user completes the flow in their
   * browser. For interactive mode, returns null immediately when the
   * browser flow completes.
   *
   * The challenge is also surfaced via `getPendingDeviceCode()` so
   * `auth_status` can show it without re-triggering login.
   */
  async login(
    onChallenge: (c: DeviceCodeChallenge) => void = () => {},
  ): Promise<AuthenticationResult | null> {
    if (this.opts.authMode === "interactive") {
      return this.loginInteractive();
    }
    return this.loginDeviceCode(onChallenge);
  }

  private async loginDeviceCode(
    onChallenge: (c: DeviceCodeChallenge) => void,
  ): Promise<AuthenticationResult | null> {
    try {
      const result = await this.pca.acquireTokenByDeviceCode({
        scopes: this.opts.scopes,
        deviceCodeCallback: (info: {
          userCode: string;
          deviceCode?: string;
          verificationUri: string;
          expiresIn?: number;
          interval?: number;
          message: string;
        }) => {
          const challenge: DeviceCodeChallenge = {
            userCode: info.userCode,
            verificationUri: info.verificationUri,
            message: info.message,
            expiresInSeconds: Number(info.expiresIn ?? 0),
          };
          this.pendingDeviceCode = challenge;
          try {
            onChallenge(challenge);
          } catch (err) {
            logger.warn({ err: sanitizeError(err) }, "device-code challenge callback threw");
          }
        },
      });
      this.pendingDeviceCode = null;
      if (result?.account) this.cachedAccount = result.account;
      return result;
    } catch (err) {
      this.pendingDeviceCode = null;
      throw this.mapAuthError(err);
    }
  }

  private async loginInteractive(): Promise<AuthenticationResult | null> {
    try {
      const result = await this.pca.acquireTokenInteractive({
        scopes: this.opts.scopes,
        openBrowser: async (url: string) => {
          // Lazily import to avoid pulling open-style deps into the
          // device-code path. For now, just log the URL — the user
          // running interactive mode is at a terminal and can copy/paste.
          process.stderr.write(`\nOpen this URL to sign in:\n  ${url}\n\n`);
        },
      });
      if (result?.account) this.cachedAccount = result.account;
      return result;
    } catch (err) {
      throw this.mapAuthError(err);
    }
  }

  getPendingDeviceCode(): DeviceCodeChallenge | null {
    return this.pendingDeviceCode;
  }

  /**
   * Returns the signed-in account's stable `homeAccountId`, or throws
   * `EngageAuthError` if no account is signed in. Used to bind a
   * confirmation token to the issuing account so a re-auth as a
   * different user invalidates pending tokens.
   */
  async getCurrentAccountId(): Promise<string> {
    const account = await this.resolveAccount();
    if (!account) {
      throw new EngageAuthError(
        "Not signed in. Call `auth_login` to start device-code authentication.",
      );
    }
    return account.homeAccountId;
  }

  async snapshot(): Promise<AuthSnapshot> {
    const account = await this.resolveAccount();
    return {
      account: account
        ? {
            username: account.username,
            tenantId: account.tenantId,
            homeAccountId: account.homeAccountId,
          }
        : null,
      scopes: [...this.opts.scopes],
      authMode: this.opts.authMode,
      cacheDir: this.opts.cacheDir,
    };
  }

  async clearTokens(): Promise<void> {
    const cache = this.pca.getTokenCache();
    const accounts = await cache.getAllAccounts();
    for (const acct of accounts) {
      await cache.removeAccount(acct);
    }
    await this.store.clear();
    this.cachedAccount = null;
    this.pendingDeviceCode = null;
  }

  private async resolveAccount(): Promise<AccountInfo | null> {
    if (this.cachedAccount) return this.cachedAccount;
    const accounts = await this.pca.getTokenCache().getAllAccounts();
    if (accounts.length === 0) return null;
    // Prefer the account matching the configured tenant.
    const matchTenant = accounts.find((a) => a.tenantId === this.opts.tenantId);
    this.cachedAccount = matchTenant ?? accounts[0] ?? null;
    return this.cachedAccount;
  }

  private mapAuthError(err: unknown): EngageError {
    const msg = err instanceof Error ? err.message : String(err);
    if (/consent/i.test(msg) || /AADSTS65001/i.test(msg)) {
      return new EngagePermissionError(
        "Admin consent required for the configured Yammer permissions. Ask your tenant admin to grant consent.",
        { cause: err },
      );
    }
    if (/AADSTS70011/i.test(msg) || /invalid_scope/i.test(msg)) {
      return new EngageAuthError(
        "One or more configured scopes are invalid for this tenant. Check YAMMER_SCOPES.",
        { cause: err },
      );
    }
    if (/timeout/i.test(msg)) {
      return new EngageAuthError("Authentication timed out. Try `auth_login` again.", {
        cause: err,
      });
    }
    return new EngageAuthError(`Authentication failed: ${msg}`, { cause: err });
  }
}
