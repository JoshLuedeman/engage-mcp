/**
 * MSAL ICachePlugin backed by the encrypted TokenStore.
 *
 * Contract per MSAL docs:
 *  - `beforeCacheAccess`: deserialize whatever we've persisted into
 *    the MSAL cache. If nothing is stored, do nothing.
 *  - `afterCacheAccess`: re-serialize and persist, BUT ONLY IF
 *    `context.cacheHasChanged === true`. Persisting on every access
 *    would needlessly churn the disk.
 *
 * We never inspect or mutate the MSAL blob; it's opaque text.
 */
import type { ICachePlugin, TokenCacheContext } from "@azure/msal-node";
import type { TokenStore } from "./tokenStore.js";
import { logger, sanitizeError } from "../utils/logger.js";

export function createMsalCachePlugin(store: TokenStore): ICachePlugin {
  return {
    async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
      try {
        const data = await store.load();
        if (data !== null) {
          context.tokenCache.deserialize(data);
        }
      } catch (err) {
        // Don't fail auth on a corrupt cache; we already moved it
        // aside in TokenStore.load. Caller will need to re-auth.
        logger.warn(
          { err: sanitizeError(err) },
          "beforeCacheAccess: failed to load token cache; continuing with empty cache",
        );
      }
    },

    async afterCacheAccess(context: TokenCacheContext): Promise<void> {
      if (!context.cacheHasChanged) return;
      try {
        const serialized = context.tokenCache.serialize();
        await store.save(serialized);
      } catch (err) {
        logger.error(
          { err: sanitizeError(err) },
          "afterCacheAccess: failed to persist token cache",
        );
      }
    },
  };
}
