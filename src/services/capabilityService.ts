/**
 * Capability probe: after first successful auth, lightly check which
 * Yammer endpoints the user can actually use. Results are cached for
 * the process lifetime and gate conditional tool registration in
 * Phase 4 (moderation).
 *
 * Phase 1 only populates `read` capabilities; write/moderation
 * probing is added in Phase 4.
 */
import type { YammerClient } from "../clients/yammerClient.js";
import { logger } from "../utils/logger.js";

export interface CapabilityMap {
  read: {
    networks: boolean;
    groups: boolean;
    myFeed: boolean;
    search: boolean;
  };
  /** True once a successful probe has run; until then, callers may assume nothing. */
  probedAt: string | null;
}

export function emptyCapabilityMap(): CapabilityMap {
  return {
    read: { networks: false, groups: false, myFeed: false, search: false },
    probedAt: null,
  };
}

export class CapabilityService {
  private map: CapabilityMap = emptyCapabilityMap();

  constructor(private readonly client: YammerClient) {}

  get(): CapabilityMap {
    return this.map;
  }

  /**
   * Run the probe. Errors are caught and recorded — the probe never
   * throws; an endpoint that fails just becomes `false` in the map.
   */
  async probe(): Promise<CapabilityMap> {
    const next = emptyCapabilityMap();

    next.read.networks = await this.tryProbe("networks", () => this.client.getCurrentNetworks());
    next.read.groups = await this.tryProbe("groups", () => this.client.listGroups({ page: 1 }));
    next.read.myFeed = await this.tryProbe("my_feed", () => this.client.getMyFeed({ limit: 1 }));
    next.read.search = await this.tryProbe("search", () =>
      this.client.search({ query: "test", numPerPage: 1 }),
    );

    next.probedAt = new Date().toISOString();
    this.map = next;
    logger.info({ capabilities: next.read }, "capability probe complete");
    return next;
  }

  private async tryProbe(name: string, fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      logger.info(
        { capability: name, code: (err as { code?: string })?.code },
        "capability probe failed for endpoint",
      );
      return false;
    }
  }
}
