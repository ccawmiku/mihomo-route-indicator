import type {
  ControllerConfig,
  ControllerStatusSnapshot,
  ControllerTestResult,
  FetchProxyGroupsResult,
  MihomoConnection,
  MihomoConnectionsPayload,
  MihomoProxyGroupInfo,
} from '../shared/types';
import { buildControllerHttpBase, buildControllerWsUrl } from '../shared/url-utils';

export interface MihomoClientCallbacks {
  onConnections: (connections: MihomoConnection[], source: 'ws' | 'http') => void;
  onStatusChange: (status: ControllerStatusSnapshot) => void;
}

export interface MihomoClientDeps {
  createWebSocket?: (url: string) => WebSocket;
  fetchFn?: typeof fetch;
}

const WS_INTERVAL_MS = 1000;
const HTTP_POLL_INTERVAL_MS = 1500;
const WS_RETRY_BASE_MS = 2000;
const WS_RETRY_MAX_MS = 20000;
const WS_RECOVERY_IN_HTTP_MODE_MS = 15000;

export async function testControllerConnection(
  controller: ControllerConfig,
  fetchFn: typeof fetch = fetch,
): Promise<ControllerTestResult> {
  const base = buildControllerHttpBase(controller);
  const headers: Record<string, string> = {};
  if (controller.secret) {
    headers['Authorization'] = `Bearer ${controller.secret}`;
  }

  const startedAt = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);

  try {
    const versionRes = await fetchFn(`${base}/version`, {
      method: 'GET',
      headers,
      signal: ac.signal,
    });

    if (versionRes.status === 401 || versionRes.status === 403) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: `认证失败 (HTTP ${versionRes.status})，请检查 Secret 是否正确`,
      };
    }

    if (!versionRes.ok) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: `Controller 返回异常状态码 HTTP ${versionRes.status}`,
      };
    }

    const versionJson = (await versionRes.json()) as { version?: string; meta?: boolean };
    const connRes = await fetchFn(`${base}/connections`, {
      method: 'GET',
      headers,
      signal: ac.signal,
    });

    let activeConnections: number | undefined;
    if (connRes.ok) {
      const connJson = (await connRes.json()) as MihomoConnectionsPayload;
      activeConnections = Array.isArray(connJson.connections) ? connJson.connections.length : 0;
    }

    return {
      ok: true,
      version: versionJson.version ?? 'unknown',
      activeConnections,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? '连接超时 (4s)，请确认 Mihomo External Controller 已开启且地址端口正确'
          : err.message
        : '未知连接错误';
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface RawMihomoProxyEntry {
  name?: string;
  type?: string;
  now?: string;
  all?: unknown;
}

const PROXY_GROUP_TYPES = new Set([
  'Selector',
  'URLTest',
  'Fallback',
  'LoadBalance',
  'Relay',
]);

/**
 * 从 Mihomo / Clash Meta 的 GET /proxies 接口获取策略组列表（过滤掉底层节点）。
 */
export async function fetchControllerProxyGroups(
  controller: ControllerConfig,
  fetchFn: typeof fetch = fetch,
): Promise<FetchProxyGroupsResult> {
  const base = buildControllerHttpBase(controller);
  const headers: Record<string, string> = {};
  if (controller.secret) {
    headers['Authorization'] = `Bearer ${controller.secret}`;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);

  try {
    const res = await fetchFn(`${base}/proxies`, {
      method: 'GET',
      headers,
      signal: ac.signal,
    });

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        groups: [],
        error: `认证失败 (HTTP ${res.status})，请检查 Secret 是否正确`,
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        groups: [],
        error: `GET /proxies 返回异常状态码 HTTP ${res.status}`,
      };
    }

    const json = (await res.json()) as { proxies?: Record<string, RawMihomoProxyEntry> };
    const rawMap = json.proxies ?? {};
    const groups: MihomoProxyGroupInfo[] = [];

    // 若 GLOBAL 中存在有序的策略组列表，保留其定义顺序作参考
    const globalAll = Array.isArray(rawMap['GLOBAL']?.all)
      ? (rawMap['GLOBAL']!.all as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const globalOrderMap = new Map<string, number>();
    globalAll.forEach((name, idx) => globalOrderMap.set(name, idx));

    for (const [key, entry] of Object.entries(rawMap)) {
      if (!entry || typeof entry !== 'object') continue;
      const name = entry.name || key;
      const type = entry.type ?? '';
      const hasAll = Array.isArray(entry.all);
      const isBuiltInDirect = name === 'DIRECT' || type === 'Direct';
      const isGroupType = PROXY_GROUP_TYPES.has(type) || hasAll;

      if (!isGroupType && !isBuiltInDirect) {
        continue;
      }

      groups.push({
        name,
        type: type || (hasAll ? 'Group' : 'Direct'),
        now: typeof entry.now === 'string' ? entry.now : '',
        memberCount: hasAll ? (entry.all as unknown[]).length : 0,
        isGlobal: name === 'GLOBAL',
      });
    }

    groups.sort((a, b) => {
      if (a.isGlobal !== b.isGlobal) return a.isGlobal ? 1 : -1;
      if (a.name === 'DIRECT' && b.name !== 'DIRECT') return 1;
      if (b.name === 'DIRECT' && a.name !== 'DIRECT') return -1;
      const ordA = globalOrderMap.get(a.name) ?? Number.MAX_SAFE_INTEGER;
      const ordB = globalOrderMap.get(b.name) ?? Number.MAX_SAFE_INTEGER;
      if (ordA !== ordB) return ordA - ordB;
      return a.name.localeCompare(b.name);
    });

    return { ok: true, groups };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? '获取策略组超时 (5s)，请确认 Mihomo External Controller 已开启'
          : err.message
        : '获取策略组失败';
    return { ok: false, groups: [], error: message };
  } finally {
    clearTimeout(timer);
  }
}

export class MihomoClient {
  private config: ControllerConfig;
  private readonly callbacks: MihomoClientCallbacks;
  private readonly createWebSocket: (url: string) => WebSocket;
  private readonly fetchFn: typeof fetch;

  private ws: WebSocket | null = null;
  private wsRetryCount = 0;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private httpPollTimer: ReturnType<typeof setInterval> | null = null;
  private httpInFlight = false;
  private stopped = true;

  private status: ControllerStatusSnapshot;

  constructor(
    config: ControllerConfig,
    callbacks: MihomoClientCallbacks,
    deps: MihomoClientDeps = {},
  ) {
    this.config = { ...config };
    this.callbacks = callbacks;
    this.createWebSocket = deps.createWebSocket ?? ((url) => new WebSocket(url));
    this.fetchFn = deps.fetchFn ?? fetch;

    this.status = {
      state: 'disconnected',
      mode: 'none',
      endpoint: buildControllerHttpBase(this.config),
      version: null,
      activeConnectionsCount: 0,
      lastMessageAt: null,
      lastError: null,
    };
  }

  getStatus(): ControllerStatusSnapshot {
    return { ...this.status };
  }

  start(): void {
    this.stopped = false;
    this.clearTimers();
    this.closeSocket();
    this.connectWebSocket();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.closeSocket();
    this.updateStatus({
      state: 'disconnected',
      mode: 'none',
    });
  }

  updateConfig(nextConfig: ControllerConfig): void {
    const changed =
      nextConfig.host !== this.config.host ||
      nextConfig.port !== this.config.port ||
      nextConfig.secret !== this.config.secret ||
      nextConfig.useTls !== this.config.useTls;
    this.config = { ...nextConfig };
    if (changed) {
      this.wsRetryCount = 0;
      this.updateStatus({
        endpoint: buildControllerHttpBase(this.config),
        version: null,
        lastError: null,
      });
      if (!this.stopped) {
        this.start();
      }
    }
  }

  /**
   * 当 Service Worker 被 alarm 或浏览器事件唤醒时调用，若未正常连接则触发重连。
   */
  ensureConnected(): void {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.httpPollTimer !== null) {
      return;
    }
    this.connectWebSocket();
  }

  private clearTimers(): void {
    if (this.wsReconnectTimer !== null) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.httpPollTimer !== null) {
      clearInterval(this.httpPollTimer);
      this.httpPollTimer = null;
    }
  }

  private closeSocket(): void {
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }
  }

  private updateStatus(patch: Partial<ControllerStatusSnapshot>): void {
    this.status = {
      ...this.status,
      ...patch,
      endpoint: buildControllerHttpBase(this.config),
    };
    this.callbacks.onStatusChange(this.getStatus());
  }

  private connectWebSocket(): void {
    if (this.stopped) return;
    this.closeSocket();

    const wsUrl = buildControllerWsUrl(this.config, WS_INTERVAL_MS);
    this.updateStatus({
      state: this.status.mode === 'http' ? 'connected_http' : 'connecting',
    });

    let socket: WebSocket;
    try {
      socket = this.createWebSocket(wsUrl);
    } catch (err) {
      this.handleWsFailure(err instanceof Error ? err.message : 'WebSocket 创建失败');
      return;
    }

    this.ws = socket;

    socket.onopen = () => {
      if (this.stopped || this.ws !== socket) return;
      this.wsRetryCount = 0;
      this.stopHttpFallback();
      this.updateStatus({
        state: 'connected_ws',
        mode: 'ws',
        lastError: null,
      });
      void this.refreshVersion();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (this.stopped || this.ws !== socket) return;
      try {
        const raw = typeof event.data === 'string' ? event.data : String(event.data);
        const payload = JSON.parse(raw) as MihomoConnectionsPayload;
        const connections = Array.isArray(payload.connections) ? payload.connections : [];
        this.updateStatus({
          state: 'connected_ws',
          mode: 'ws',
          activeConnectionsCount: connections.length,
          lastMessageAt: Date.now(),
          lastError: null,
        });
        this.callbacks.onConnections(connections, 'ws');
      } catch (err) {
        this.updateStatus({
          lastError: err instanceof Error ? `WS 数据解析失败: ${err.message}` : 'WS 数据解析失败',
        });
      }
    };

    socket.onerror = () => {
      if (this.stopped || this.ws !== socket) return;
      // onclose usually follows onerror; keep status informative
      this.updateStatus({
        lastError: 'WebSocket 连接异常，准备切换/重试',
      });
    };

    socket.onclose = (event: CloseEvent) => {
      if (this.stopped || this.ws !== socket) return;
      this.ws = null;
      const reason = event.reason ? ` (${event.reason})` : '';
      this.handleWsFailure(`WebSocket 已断开 [code ${event.code}]${reason}`);
    };
  }

  private handleWsFailure(errorMsg: string): void {
    if (this.stopped) return;
    this.wsRetryCount += 1;

    // 立即启用 HTTP 轮询作为备用方案
    this.startHttpFallback();

    const delay =
      this.httpPollTimer !== null
        ? WS_RECOVERY_IN_HTTP_MODE_MS
        : Math.min(WS_RETRY_MAX_MS, WS_RETRY_BASE_MS * Math.pow(2, this.wsRetryCount - 1));

    this.updateStatus({
      state: this.status.mode === 'http' ? 'connected_http' : 'error',
      lastError: errorMsg,
    });

    if (this.wsReconnectTimer !== null) {
      clearTimeout(this.wsReconnectTimer);
    }
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      this.connectWebSocket();
    }, delay);
  }

  private startHttpFallback(): void {
    if (this.httpPollTimer !== null || this.stopped) return;
    void this.pollHttpOnce();
    this.httpPollTimer = setInterval(() => {
      void this.pollHttpOnce();
    }, HTTP_POLL_INTERVAL_MS);
  }

  private stopHttpFallback(): void {
    if (this.httpPollTimer !== null) {
      clearInterval(this.httpPollTimer);
      this.httpPollTimer = null;
    }
  }

  private async pollHttpOnce(): Promise<void> {
    if (this.stopped || this.httpInFlight) return;
    this.httpInFlight = true;

    const base = buildControllerHttpBase(this.config);
    const headers: Record<string, string> = {};
    if (this.config.secret) {
      headers['Authorization'] = `Bearer ${this.config.secret}`;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);

    try {
      const res = await this.fetchFn(`${base}/connections`, {
        method: 'GET',
        headers,
        signal: ac.signal,
      });

      if (!res.ok) {
        this.updateStatus({
          state: 'error',
          mode: 'none',
          lastError:
            res.status === 401 || res.status === 403
              ? `HTTP 备用连接鉴权失败 (${res.status})，请检查 Secret`
              : `HTTP /connections 请求失败 (${res.status})`,
        });
        return;
      }

      const payload = (await res.json()) as MihomoConnectionsPayload;
      const connections = Array.isArray(payload.connections) ? payload.connections : [];
      this.updateStatus({
        state: 'connected_http',
        mode: 'http',
        activeConnectionsCount: connections.length,
        lastMessageAt: Date.now(),
        lastError: null,
      });
      if (!this.status.version) {
        void this.refreshVersion();
      }
      this.callbacks.onConnections(connections, 'http');
    } catch (err) {
      this.updateStatus({
        state: 'error',
        mode: 'none',
        lastError: err instanceof Error ? err.message : '无法连接到 Mihomo Controller',
      });
    } finally {
      clearTimeout(timer);
      this.httpInFlight = false;
    }
  }

  private async refreshVersion(): Promise<void> {
    const base = buildControllerHttpBase(this.config);
    const headers: Record<string, string> = {};
    if (this.config.secret) {
      headers['Authorization'] = `Bearer ${this.config.secret}`;
    }
    try {
      const res = await this.fetchFn(`${base}/version`, { method: 'GET', headers });
      if (!res.ok) return;
      const json = (await res.json()) as { version?: string };
      if (json.version) {
        this.updateStatus({ version: json.version });
      }
    } catch {
      // ignore non-critical version fetch error
    }
  }
}
