export type BadgeShape = 'circle' | 'triangle' | 'square';

export type MatchMode = 'exact' | 'contains' | 'regex';

export type ConnectionTransportKind = 'DIRECT' | 'PROXY' | 'REJECT' | 'UNKNOWN';

export type PageOverallStatus = 'DIRECT' | 'PROXY' | 'MIXED' | 'UNKNOWN';

export type ControllerConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected_ws'
  | 'connected_http'
  | 'error';

export interface RouteGroupConfig {
  id: string;
  name: string;
  matchMode: MatchMode;
  pattern: string;
  shape: BadgeShape;
  color: string;
  priority: number;
  enabled: boolean;
}

export interface ControllerConfig {
  host: string;
  port: number;
  secret: string;
  useTls: boolean;
}

export interface FaviconOverlayConfig {
  enabled: boolean;
  markerSize: number;
  strokeWidth: number;
  strokeColor: string;
  retentionMs: number;
}

export interface ExtensionConfig {
  controller: ControllerConfig;
  routeGroups: RouteGroupConfig[];
  favicon: FaviconOverlayConfig;
}

export interface MihomoConnectionMetadata {
  network?: string;
  type: string;
  sourceIP?: string;
  destinationIP: string;
  sourcePort?: string;
  destinationPort?: string;
  host: string;
  dnsMode?: string;
  processPath?: string;
  sniffHost: string;
}

export interface MihomoConnection {
  id: string;
  metadata: MihomoConnectionMetadata;
  upload: number;
  download: number;
  start: string;
  chains: string[];
  rule: string;
  rulePayload: string;
}

export interface MihomoConnectionsPayload {
  downloadTotal?: number;
  uploadTotal?: number;
  connections: MihomoConnection[] | null;
}

export interface TrackedMihomoConnection {
  connection: MihomoConnection;
  normalizedHosts: string[];
  startMs: number;
  firstSeenAt: number;
  lastSeenAt: number;
  closedAt: number | null;
  isActive: boolean;
  matchedGroup: RouteGroupConfig | null;
  transportKind: ConnectionTransportKind;
}

export interface BrowserRequestRecord {
  requestId: string;
  tabId: number;
  url: string;
  hostname: string;
  type: chrome.webRequest.ResourceType;
  timeStamp: number;
  ip?: string;
  completedAt?: number;
}

export interface BadgeDescriptor {
  groupId: string;
  name: string;
  shape: BadgeShape;
  color: string;
  priority: number;
}

export interface TabGroupStats {
  groupId: string;
  name: string;
  shape: BadgeShape;
  color: string;
  priority: number;
  requestCount: number;
  activeConnectionIds: string[];
  lastActiveAt: number;
  sampleRule: string;
  sampleRulePayload: string;
  sampleChains: string[];
  transportKind: ConnectionTransportKind;
}

export interface RecentMatchedConnectionInfo {
  requestId: string;
  hostname: string;
  requestType: string;
  timestamp: number;
  groupId: string | null;
  groupName: string | null;
  transportKind: ConnectionTransportKind;
  rule: string;
  rulePayload: string;
  chains: string[];
  destinationIP: string;
  mihomoType: string;
  upload: number;
  download: number;
  status: 'matched' | 'unknown' | 'ambiguous';
  reason?: string;
}

export interface TabRouteSnapshot {
  tabId: number;
  url: string;
  hostname: string;
  overallStatus: PageOverallStatus;
  totalRequests: number;
  matchedRequests: number;
  unknownRequests: number;
  activeBadges: BadgeDescriptor[];
  allGroups: TabGroupStats[];
  recentConnections: RecentMatchedConnectionInfo[];
  updatedAt: number;
}

export interface ControllerStatusSnapshot {
  state: ControllerConnectionState;
  mode: 'ws' | 'http' | 'none';
  endpoint: string;
  version: string | null;
  activeConnectionsCount: number;
  lastMessageAt: number | null;
  lastError: string | null;
}

export interface ControllerTestResult {
  ok: boolean;
  version?: string;
  activeConnections?: number;
  latencyMs: number;
  error?: string;
}

export interface MihomoProxyGroupInfo {
  name: string;
  type: string;
  now: string;
  memberCount: number;
  isGlobal: boolean;
}

export interface FetchProxyGroupsResult {
  ok: boolean;
  groups: MihomoProxyGroupInfo[];
  error?: string;
}

export type RuntimeMessage =
  | { type: 'GET_TAB_SNAPSHOT'; tabId: number }
  | { type: 'GET_CONTROLLER_STATUS' }
  | { type: 'TEST_CONTROLLER_CONNECTION'; controller: ControllerConfig }
  | { type: 'FETCH_PROXY_GROUPS'; controller: ControllerConfig }
  | { type: 'RECONNECT_CONTROLLER' }
  | { type: 'FETCH_FAVICON_DATA_URL'; url: string }
  | { type: 'CONTENT_READY'; url: string; originalFaviconUrl: string | null }
  | { type: 'CONTENT_FAVICON_CHANGED'; originalFaviconUrl: string | null }
  | { type: 'GET_ORIGINAL_FAVICON' }
  | {
      type: 'APPLY_TAB_BADGES';
      badges: BadgeDescriptor[];
      faviconConfig: FaviconOverlayConfig;
      overallStatus: PageOverallStatus;
    };
