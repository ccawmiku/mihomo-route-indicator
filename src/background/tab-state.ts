import { MAX_FAVICON_BADGES } from '../shared/defaults';
import type {
  BadgeDescriptor,
  BrowserRequestRecord,
  ConnectionTransportKind,
  PageOverallStatus,
  RecentMatchedConnectionInfo,
  RouteGroupConfig,
  TabGroupStats,
  TabRouteSnapshot,
  TrackedMihomoConnection,
} from '../shared/types';
import type { CorrelationOutcome } from './correlator';

const MAX_RECENT_CONNECTIONS = 30;
const PENDING_REQUEST_TIMEOUT_MS = 3_500;

interface PendingRequestEntry {
  record: BrowserRequestRecord;
  enqueuedAt: number;
}

interface TabInternalState {
  tabId: number;
  url: string;
  hostname: string;
  totalRequests: number;
  matchedRequests: number;
  unknownRequests: number;
  transportCounts: Record<ConnectionTransportKind, number>;
  groups: Map<string, TabGroupStats>;
  resolvedRequestIds: Set<string>;
  pendingRequests: Map<string, PendingRequestEntry>;
  recentConnections: RecentMatchedConnectionInfo[];
  updatedAt: number;
}

export class TabStateManager {
  private tabs = new Map<number, TabInternalState>();

  ensureTab(tabId: number, url = '', hostname = '', now = Date.now()): TabInternalState {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = {
        tabId,
        url,
        hostname,
        totalRequests: 0,
        matchedRequests: 0,
        unknownRequests: 0,
        transportCounts: { DIRECT: 0, PROXY: 0, REJECT: 0, UNKNOWN: 0 },
        groups: new Map<string, TabGroupStats>(),
        resolvedRequestIds: new Set<string>(),
        pendingRequests: new Map<string, PendingRequestEntry>(),
        recentConnections: [],
        updatedAt: now,
      };
      this.tabs.set(tabId, tab);
    } else {
      if (url) tab.url = url;
      if (hostname) tab.hostname = hostname;
    }
    return tab;
  }

  resetTabForNavigation(tabId: number, url: string, hostname: string, now = Date.now()): void {
    this.tabs.set(tabId, {
      tabId,
      url,
      hostname,
      totalRequests: 0,
      matchedRequests: 0,
      unknownRequests: 0,
      transportCounts: { DIRECT: 0, PROXY: 0, REJECT: 0, UNKNOWN: 0 },
      groups: new Map<string, TabGroupStats>(),
      resolvedRequestIds: new Set<string>(),
      pendingRequests: new Map<string, PendingRequestEntry>(),
      recentConnections: [],
      updatedAt: now,
    });
  }

  removeTab(tabId: number): void {
    this.tabs.delete(tabId);
  }

  getAllTabIds(): number[] {
    return [...this.tabs.keys()];
  }

  recordRequestOutcome(
    req: BrowserRequestRecord,
    outcome: CorrelationOutcome,
    now = Date.now(),
  ): { resolved: boolean; changed: boolean } {
    const tab = this.ensureTab(req.tabId, '', '', now);

    if (tab.resolvedRequestIds.has(req.requestId)) {
      return { resolved: true, changed: false };
    }

    if (outcome.status === 'matched') {
      tab.pendingRequests.delete(req.requestId);
      tab.resolvedRequestIds.add(req.requestId);
      tab.totalRequests += 1;
      tab.matchedRequests += 1;
      this.applyMatchedConnection(tab, req, outcome.tracked, now);
      return { resolved: true, changed: true };
    }

    if (outcome.status === 'ambiguous') {
      // 明确冲突歧义，不猜测，直接记为未知/歧义
      tab.pendingRequests.delete(req.requestId);
      tab.resolvedRequestIds.add(req.requestId);
      tab.totalRequests += 1;
      tab.unknownRequests += 1;
      tab.transportCounts.UNKNOWN += 1;
      this.pushRecentConnection(tab, {
        requestId: req.requestId,
        hostname: req.hostname,
        requestType: req.type,
        timestamp: req.timeStamp,
        groupId: null,
        groupName: null,
        transportKind: 'UNKNOWN',
        rule: '',
        rulePayload: '',
        chains: [],
        destinationIP: '',
        mihomoType: '',
        upload: 0,
        download: 0,
        status: 'ambiguous',
        reason: outcome.reason,
      });
      tab.updatedAt = now;
      return { resolved: true, changed: true };
    }

    // status === 'unknown'：可能由于 Mihomo WS 1s 推送延迟尚未收到该连接，先入队列等待短暂窗口
    const existingPending = tab.pendingRequests.get(req.requestId);
    if (!existingPending) {
      tab.pendingRequests.set(req.requestId, { record: req, enqueuedAt: now });
      return { resolved: false, changed: false };
    }

    // 若已经入队但更新了 IP，则刷新记录
    if (req.ip && !existingPending.record.ip) {
      existingPending.record = { ...existingPending.record, ip: req.ip };
    }
    return { resolved: false, changed: false };
  }

  /**
   * 当收到新的 Mihomo 连接快照时，重新尝试匹配所有处于待定队列的请求，
   * 并清理超时仍未找到连接的请求（定性为 unknown，不猜测）。
   */
  reprocessPendingRequests(
    correlateFn: (req: BrowserRequestRecord) => CorrelationOutcome,
    now = Date.now(),
  ): number[] {
    const changedTabIds = new Set<number>();

    for (const [tabId, tab] of this.tabs.entries()) {
      for (const [reqId, pending] of [...tab.pendingRequests.entries()]) {
        const outcome = correlateFn(pending.record);
        if (outcome.status === 'matched') {
          tab.pendingRequests.delete(reqId);
          tab.resolvedRequestIds.add(reqId);
          tab.totalRequests += 1;
          tab.matchedRequests += 1;
          this.applyMatchedConnection(tab, pending.record, outcome.tracked, now);
          changedTabIds.add(tabId);
        } else if (outcome.status === 'ambiguous' || now - pending.enqueuedAt >= PENDING_REQUEST_TIMEOUT_MS) {
          tab.pendingRequests.delete(reqId);
          tab.resolvedRequestIds.add(reqId);
          tab.totalRequests += 1;
          tab.unknownRequests += 1;
          tab.transportCounts.UNKNOWN += 1;
          this.pushRecentConnection(tab, {
            requestId: pending.record.requestId,
            hostname: pending.record.hostname,
            requestType: pending.record.type,
            timestamp: pending.record.timeStamp,
            groupId: null,
            groupName: null,
            transportKind: 'UNKNOWN',
            rule: '',
            rulePayload: '',
            chains: [],
            destinationIP: '',
            mihomoType: '',
            upload: 0,
            download: 0,
            status: outcome.status === 'ambiguous' ? 'ambiguous' : 'unknown',
            reason: outcome.reason,
          });
          tab.updatedAt = now;
          changedTabIds.add(tabId);
        }
      }
    }

    return [...changedTabIds];
  }

  /**
   * 同步活跃连接状态，并依据短期保留机制更新各标签页分流组活跃状态，防止图标闪烁。
   */
  refreshActiveState(
    activeConnectionIds: ReadonlySet<string>,
    retentionMs: number,
    now = Date.now(),
  ): void {
    for (const tab of this.tabs.values()) {
      for (const group of tab.groups.values()) {
        const stillActive = group.activeConnectionIds.filter((id) => activeConnectionIds.has(id));
        group.activeConnectionIds = stillActive;
        if (stillActive.length > 0) {
          group.lastActiveAt = now;
        }
      }
    }
    void retentionMs;
  }

  /**
   * 配置变更时同步更新各标签页内缓存的分流组外观、优先级和启用状态。
   */
  syncRouteGroupConfigs(groups: readonly RouteGroupConfig[]): void {
    const byId = new Map(groups.map((g) => [g.id, g]));
    for (const tab of this.tabs.values()) {
      for (const [groupId, stats] of tab.groups.entries()) {
        const cfg = byId.get(groupId);
        if (!cfg || !cfg.enabled) {
          tab.groups.delete(groupId);
          continue;
        }
        stats.name = cfg.name;
        stats.shape = cfg.shape;
        stats.color = cfg.color;
        stats.priority = cfg.priority;
      }
    }
  }

  getSnapshot(
    tabId: number,
    retentionMs: number,
    now = Date.now(),
  ): TabRouteSnapshot | null {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;

    const allGroups = [...tab.groups.values()].sort((a, b) => a.priority - b.priority);
    const activeGroups = allGroups.filter(
      (g) => g.activeConnectionIds.length > 0 || now - g.lastActiveAt <= retentionMs,
    );

    const activeBadges: BadgeDescriptor[] = activeGroups
      .slice(0, MAX_FAVICON_BADGES)
      .map((g) => ({
        groupId: g.groupId,
        name: g.name,
        shape: g.shape,
        color: g.color,
        priority: g.priority,
      }));

    return {
      tabId: tab.tabId,
      url: tab.url,
      hostname: tab.hostname,
      overallStatus: this.computeOverallStatus(tab, activeGroups),
      totalRequests: tab.totalRequests,
      matchedRequests: tab.matchedRequests,
      unknownRequests: tab.unknownRequests,
      activeBadges,
      allGroups: allGroups.map((g) => ({
        ...g,
        activeConnectionIds: [...g.activeConnectionIds],
        sampleChains: [...g.sampleChains],
      })),
      recentConnections: [...tab.recentConnections],
      updatedAt: tab.updatedAt,
    };
  }

  private applyMatchedConnection(
    tab: TabInternalState,
    req: BrowserRequestRecord,
    tracked: TrackedMihomoConnection,
    now: number,
  ): void {
    tab.transportCounts[tracked.transportKind] += 1;

    const conn = tracked.connection;
    const group = tracked.matchedGroup;

    if (group) {
      let stats = tab.groups.get(group.id);
      if (!stats) {
        stats = {
          groupId: group.id,
          name: group.name,
          shape: group.shape,
          color: group.color,
          priority: group.priority,
          requestCount: 0,
          activeConnectionIds: [],
          lastActiveAt: now,
          sampleRule: conn.rule ?? '',
          sampleRulePayload: conn.rulePayload ?? '',
          sampleChains: [...(conn.chains ?? [])],
          transportKind: tracked.transportKind,
        };
        tab.groups.set(group.id, stats);
      }

      stats.requestCount += 1;
      stats.lastActiveAt = now;
      stats.sampleRule = conn.rule ?? stats.sampleRule;
      stats.sampleRulePayload = conn.rulePayload ?? stats.sampleRulePayload;
      if (Array.isArray(conn.chains) && conn.chains.length > 0) {
        stats.sampleChains = [...conn.chains];
      }
      if (tracked.isActive && !stats.activeConnectionIds.includes(conn.id)) {
        stats.activeConnectionIds.push(conn.id);
      }
    }

    this.pushRecentConnection(tab, {
      requestId: req.requestId,
      hostname: req.hostname,
      requestType: req.type,
      timestamp: req.timeStamp,
      groupId: group?.id ?? null,
      groupName: group?.name ?? null,
      transportKind: tracked.transportKind,
      rule: conn.rule ?? '',
      rulePayload: conn.rulePayload ?? '',
      chains: [...(conn.chains ?? [])],
      destinationIP: conn.metadata?.destinationIP ?? '',
      mihomoType: conn.metadata?.type ?? '',
      upload: conn.upload ?? 0,
      download: conn.download ?? 0,
      status: 'matched',
    });
    tab.updatedAt = now;
  }

  private pushRecentConnection(tab: TabInternalState, item: RecentMatchedConnectionInfo): void {
    tab.recentConnections.unshift(item);
    if (tab.recentConnections.length > MAX_RECENT_CONNECTIONS) {
      tab.recentConnections.length = MAX_RECENT_CONNECTIONS;
    }
  }

  private computeOverallStatus(
    tab: TabInternalState,
    activeGroups: readonly TabGroupStats[],
  ): PageOverallStatus {
    let hasProxy = false;
    let hasDirect = false;

    for (const g of activeGroups) {
      if (g.transportKind === 'PROXY') hasProxy = true;
      if (g.transportKind === 'DIRECT') hasDirect = true;
    }

    if (!hasProxy && !hasDirect) {
      if (tab.transportCounts.PROXY > 0) hasProxy = true;
      if (tab.transportCounts.DIRECT > 0) hasDirect = true;
    }

    if (hasProxy && hasDirect) return 'MIXED';
    if (hasProxy) return 'PROXY';
    if (hasDirect) return 'DIRECT';
    return 'UNKNOWN';
  }
}
