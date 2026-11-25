import { matchChainsToRouteGroup, type CompiledRouteGroupRule } from '../shared/route-matcher';
import type {
  BrowserRequestRecord,
  MihomoConnection,
  TrackedMihomoConnection,
} from '../shared/types';
import { normalizeHostname } from '../shared/url-utils';

export type CorrelationOutcome =
  | {
      status: 'matched';
      tracked: TrackedMihomoConnection;
      reason: string;
    }
  | {
      status: 'unknown';
      reason: string;
    }
  | {
      status: 'ambiguous';
      reason: string;
    };

const RECENT_CLOSED_TTL_MS = 45_000;
const REQUEST_CLOSE_GRACE_MS = 5_000;
const FUTURE_START_TOLERANCE_MS = 3_500;
const STRICT_NEW_CONN_WINDOW_MS = 2_500;

function isLocalProxyLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return true;
  const normalized = ip.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === 'localhost' ||
    normalized === '0.0.0.0'
  );
}

function parseStartMs(startIso: string, fallbackNow: number): number {
  const parsed = Date.parse(startIso);
  return Number.isFinite(parsed) ? parsed : fallbackNow;
}

function extractConnectionHosts(conn: MihomoConnection): string[] {
  const hosts = new Set<string>();
  const sniff = conn.metadata?.sniffHost ? normalizeHostname(conn.metadata.sniffHost) : '';
  const host = conn.metadata?.host ? normalizeHostname(conn.metadata.host) : '';
  const destIp = conn.metadata?.destinationIP ? normalizeHostname(conn.metadata.destinationIP) : '';
  if (sniff) hosts.add(sniff);
  if (host) hosts.add(host);
  if (destIp && hosts.size === 0) hosts.add(destIp);
  return [...hosts];
}

export class ConnectionCorrelator {
  private tracked = new Map<string, TrackedMihomoConnection>();
  private hostIndex = new Map<string, Set<string>>();

  updateSnapshot(
    connections: readonly MihomoConnection[],
    compiledRules: readonly CompiledRouteGroupRule[],
    now = Date.now(),
  ): void {
    const activeIds = new Set<string>();

    for (const conn of connections) {
      if (!conn || !conn.id) continue;
      activeIds.add(conn.id);

      const existing = this.tracked.get(conn.id);
      const match = matchChainsToRouteGroup(conn.chains ?? [], compiledRules);
      const normalizedHosts = extractConnectionHosts(conn);
      const startMs = parseStartMs(conn.start, existing?.firstSeenAt ?? now);

      if (existing) {
        if (existing.normalizedHosts.join('|') !== normalizedHosts.join('|')) {
          this.removeFromIndex(conn.id, existing.normalizedHosts);
          this.addToIndex(conn.id, normalizedHosts);
        }
        existing.connection = conn;
        existing.normalizedHosts = normalizedHosts;
        existing.startMs = startMs;
        existing.lastSeenAt = now;
        existing.closedAt = null;
        existing.isActive = true;
        existing.matchedGroup = match.matchedGroup;
        existing.transportKind = match.transportKind;
      } else {
        const entry: TrackedMihomoConnection = {
          connection: conn,
          normalizedHosts,
          startMs,
          firstSeenAt: now,
          lastSeenAt: now,
          closedAt: null,
          isActive: true,
          matchedGroup: match.matchedGroup,
          transportKind: match.transportKind,
        };
        this.tracked.set(conn.id, entry);
        this.addToIndex(conn.id, normalizedHosts);
      }
    }

    for (const [id, entry] of this.tracked.entries()) {
      if (!activeIds.has(id)) {
        if (entry.isActive) {
          entry.isActive = false;
          entry.closedAt = now;
        } else if (entry.closedAt !== null && now - entry.closedAt > RECENT_CLOSED_TTL_MS) {
          this.removeFromIndex(id, entry.normalizedHosts);
          this.tracked.delete(id);
        }
      }
    }
  }

  recomputeRoutes(compiledRules: readonly CompiledRouteGroupRule[]): void {
    for (const entry of this.tracked.values()) {
      const match = matchChainsToRouteGroup(entry.connection.chains ?? [], compiledRules);
      entry.matchedGroup = match.matchedGroup;
      entry.transportKind = match.transportKind;
    }
  }

  getActiveConnectionIds(): Set<string> {
    const ids = new Set<string>();
    for (const [id, entry] of this.tracked.entries()) {
      if (entry.isActive) ids.add(id);
    }
    return ids;
  }

  getTrackedConnection(id: string): TrackedMihomoConnection | undefined {
    return this.tracked.get(id);
  }

  clear(): void {
    this.tracked.clear();
    this.hostIndex.clear();
  }

  correlateRequest(req: BrowserRequestRecord): CorrelationOutcome {
    const reqHost = normalizeHostname(req.hostname);
    if (!reqHost) {
      return { status: 'unknown', reason: 'empty_hostname' };
    }

    const candidateIds = this.hostIndex.get(reqHost);
    if (!candidateIds || candidateIds.size === 0) {
      return { status: 'unknown', reason: 'no_matching_host_connection' };
    }

    const candidates: TrackedMihomoConnection[] = [];
    for (const id of candidateIds) {
      const entry = this.tracked.get(id);
      if (!entry) continue;

      // 连接起始时间不能远晚于请求时间
      if (entry.startMs > req.timeStamp + FUTURE_START_TOLERANCE_MS) {
        continue;
      }

      // 只要当前仍然活跃（包括 HTTP/2、HTTP/3 长期复用连接），或者在请求之后/临近关闭，即纳入候选
      if (entry.isActive) {
        candidates.push(entry);
      } else if (entry.closedAt !== null && entry.closedAt >= req.timeStamp - REQUEST_CLOSE_GRACE_MS) {
        candidates.push(entry);
      }
    }

    if (candidates.length === 0) {
      return { status: 'unknown', reason: 'no_temporally_valid_connection' };
    }

    // 辅助筛选 1：若浏览器给出了远端非本地回环目标 IP，则优先精确匹配 destinationIP
    let narrowed = candidates;
    if (req.ip && !isLocalProxyLoopbackIp(req.ip)) {
      const reqIp = normalizeHostname(req.ip);
      const ipMatches = narrowed.filter(
        (c) => normalizeHostname(c.connection.metadata?.destinationIP ?? '') === reqIp,
      );
      if (ipMatches.length > 0) {
        narrowed = ipMatches;
      }
    }

    // 辅助筛选 2：检查剩余候选是否拥有一致的分流结论
    if (this.hasConsistentRoute(narrowed)) {
      const best = this.pickBestRepresentative(narrowed, req.timeStamp);
      return {
        status: 'matched',
        tracked: best,
        reason: narrowed.length > 1 ? 'consistent_multi_connection_route' : 'exact_host_match',
      };
    }

    // 存在多条同域名但不同分流组的连接：尝试用严格的新建连接时间窗口收窄
    const timeNear = narrowed.filter(
      (c) => Math.abs(c.startMs - req.timeStamp) <= STRICT_NEW_CONN_WINDOW_MS,
    );
    if (timeNear.length > 0) {
      if (this.hasConsistentRoute(timeNear)) {
        return {
          status: 'matched',
          tracked: this.pickBestRepresentative(timeNear, req.timeStamp),
          reason: 'narrowed_by_creation_time',
        };
      }

      // 若只有一条明显最接近且远近差距显著（< 500ms vs > 1500ms）
      const sorted = [...timeNear].sort(
        (a, b) => Math.abs(a.startMs - req.timeStamp) - Math.abs(b.startMs - req.timeStamp),
      );
      const first = sorted[0];
      const second = sorted[1];
      if (
        first &&
        second &&
        Math.abs(first.startMs - req.timeStamp) <= 400 &&
        Math.abs(second.startMs - req.timeStamp) >= 1500
      ) {
        return {
          status: 'matched',
          tracked: first,
          reason: 'distinct_nearest_creation_time',
        };
      }
    }

    // 多条不同分流组的复用或并发连接无法可靠区分到具体 tabId 请求：严禁猜测
    return {
      status: 'ambiguous',
      reason: 'conflicting_routes_for_same_host',
    };
  }

  private hasConsistentRoute(entries: readonly TrackedMihomoConnection[]): boolean {
    if (entries.length <= 1) return true;
    const first = entries[0]!;
    const firstKey = `${first.matchedGroup?.id ?? ''}::${first.transportKind}`;
    for (let i = 1; i < entries.length; i++) {
      const item = entries[i]!;
      const key = `${item.matchedGroup?.id ?? ''}::${item.transportKind}`;
      if (key !== firstKey) return false;
    }
    return true;
  }

  private pickBestRepresentative(
    entries: readonly TrackedMihomoConnection[],
    requestTs: number,
  ): TrackedMihomoConnection {
    return [...entries].sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      const diffA = Math.abs(a.startMs - requestTs);
      const diffB = Math.abs(b.startMs - requestTs);
      return diffA - diffB;
    })[0]!;
  }

  private addToIndex(id: string, hosts: readonly string[]): void {
    for (const h of hosts) {
      let set = this.hostIndex.get(h);
      if (!set) {
        set = new Set<string>();
        this.hostIndex.set(h, set);
      }
      set.add(id);
    }
  }

  private removeFromIndex(id: string, hosts: readonly string[]): void {
    for (const h of hosts) {
      const set = this.hostIndex.get(h);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) {
        this.hostIndex.delete(h);
      }
    }
  }
}
