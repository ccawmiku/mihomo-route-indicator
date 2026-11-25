import { DEFAULT_EXTENSION_CONFIG } from '../shared/defaults';
import { compileRouteGroupRules, type CompiledRouteGroupRule } from '../shared/route-matcher';
import { loadExtensionConfig, onConfigChanged } from '../shared/storage';
import type {
  BadgeDescriptor,
  BrowserRequestRecord,
  ExtensionConfig,
  RuntimeMessage,
} from '../shared/types';
import {
  extractHostnameFromUrl,
  isControllerRequest,
  isTrackablePageUrl,
} from '../shared/url-utils';
import { ConnectionCorrelator } from './correlator';
import { FaviconFetcher } from './favicon-fetcher';
import {
  fetchControllerProxyGroups,
  MihomoClient,
  testControllerConnection,
} from './mihomo-client';
import { TabStateManager } from './tab-state';

const KEEPALIVE_ALARM_NAME = 'mri-keepalive-prune';

let currentConfig: ExtensionConfig = {
  controller: { ...DEFAULT_EXTENSION_CONFIG.controller },
  routeGroups: DEFAULT_EXTENSION_CONFIG.routeGroups.map((g) => ({ ...g })),
  favicon: { ...DEFAULT_EXTENSION_CONFIG.favicon },
};
let compiledRules: CompiledRouteGroupRule[] = compileRouteGroupRules(currentConfig.routeGroups);

const correlator = new ConnectionCorrelator();
const tabStateManager = new TabStateManager();
const faviconFetcher = new FaviconFetcher();
const lastSentBadgeSignature = new Map<number, string>();
const contentReadyTabs = new Set<number>();

let initPromise: Promise<void> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;

const mihomoClient = new MihomoClient(currentConfig.controller, {
  onConnections(connections) {
    const now = Date.now();
    correlator.updateSnapshot(connections, compiledRules, now);
    const activeIds = correlator.getActiveConnectionIds();
    tabStateManager.refreshActiveState(activeIds, currentConfig.favicon.retentionMs, now);
    const resolvedTabIds = tabStateManager.reprocessPendingRequests(
      (req) => correlator.correlateRequest(req),
      now,
    );
    syncChangedTabs(resolvedTabIds);
  },
  onStatusChange() {
    // status snapshot is read on demand by popup/options via GET_CONTROLLER_STATUS
  },
});

function buildBadgeSignature(badges: readonly BadgeDescriptor[], config: ExtensionConfig['favicon']): string {
  const badgePart = badges.map((b) => `${b.groupId}:${b.shape}:${b.color}`).join('|');
  return `${config.enabled ? 1 : 0}:${config.markerSize}:${config.strokeWidth}:${config.strokeColor}#${badgePart}`;
}

function pushBadgesToTab(tabId: number, force = false): void {
  if (!contentReadyTabs.has(tabId)) return;
  const snapshot = tabStateManager.getSnapshot(tabId, currentConfig.favicon.retentionMs);
  const badges = snapshot?.activeBadges ?? [];
  const overallStatus = snapshot?.overallStatus ?? 'UNKNOWN';
  const signature = buildBadgeSignature(badges, currentConfig.favicon);

  if (!force && lastSentBadgeSignature.get(tabId) === signature) {
    return;
  }
  lastSentBadgeSignature.set(tabId, signature);

  const msg: RuntimeMessage = {
    type: 'APPLY_TAB_BADGES',
    badges,
    faviconConfig: currentConfig.favicon,
    overallStatus,
  };
  chrome.tabs.sendMessage(tabId, msg).catch(() => {
    // Tab may have closed or navigated to non-scriptable URL
  });
}

function syncChangedTabs(specificTabIds?: readonly number[]): void {
  const targets = specificTabIds && specificTabIds.length > 0 ? specificTabIds : tabStateManager.getAllTabIds();
  const seen = new Set<number>();
  for (const tabId of targets) {
    if (seen.has(tabId)) continue;
    seen.add(tabId);
    pushBadgesToTab(tabId, false);
  }
}

function startPruneLoop(): void {
  if (pruneTimer !== null) return;
  pruneTimer = setInterval(() => {
    const now = Date.now();
    const activeIds = correlator.getActiveConnectionIds();
    tabStateManager.refreshActiveState(activeIds, currentConfig.favicon.retentionMs, now);
    const resolvedTabs = tabStateManager.reprocessPendingRequests(
      (req) => correlator.correlateRequest(req),
      now,
    );
    syncChangedTabs();
  }, 2000);
}

async function ensureInitialized(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    currentConfig = await loadExtensionConfig();
    compiledRules = compileRouteGroupRules(currentConfig.routeGroups);
    mihomoClient.updateConfig(currentConfig.controller);
    mihomoClient.start();
    startPruneLoop();

    try {
      const existingTabs = await chrome.tabs.query({});
      for (const tab of existingTabs) {
        if (typeof tab.id === 'number' && tab.id >= 0 && isTrackablePageUrl(tab.url)) {
          const hostname = tab.url ? extractHostnameFromUrl(tab.url) ?? '' : '';
          tabStateManager.ensureTab(tab.id, tab.url ?? '', hostname);
        }
      }
    } catch {
      // ignore startup tab query failure
    }
  })();

  return initPromise;
}

onConfigChanged((nextConfig) => {
  const prevRetention = currentConfig.favicon.retentionMs;
  currentConfig = nextConfig;
  compiledRules = compileRouteGroupRules(currentConfig.routeGroups);

  mihomoClient.updateConfig(currentConfig.controller);
  correlator.recomputeRoutes(compiledRules);
  tabStateManager.syncRouteGroupConfigs(currentConfig.routeGroups);

  const now = Date.now();
  const activeIds = correlator.getActiveConnectionIds();
  tabStateManager.refreshActiveState(activeIds, currentConfig.favicon.retentionMs || prevRetention, now);

  for (const tabId of contentReadyTabs) {
    pushBadgesToTab(tabId, true);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 1 });
  void ensureInitialized();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 1 });
  void ensureInitialized();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM_NAME) return;
  void ensureInitialized().then(() => {
    mihomoClient.ensureConnected();
    const now = Date.now();
    tabStateManager.refreshActiveState(
      correlator.getActiveConnectionIds(),
      currentConfig.favicon.retentionMs,
      now,
    );
    syncChangedTabs();
  });
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (isControllerRequest(details.url, currentConfig.controller)) return;

    const hostname = extractHostnameFromUrl(details.url);
    if (!hostname) return;

    void ensureInitialized().then(() => {
      mihomoClient.ensureConnected();

      if (details.type === 'main_frame' && details.frameId === 0) {
        tabStateManager.resetTabForNavigation(details.tabId, details.url, hostname, details.timeStamp);
        lastSentBadgeSignature.delete(details.tabId);
      }

      const record: BrowserRequestRecord = {
        requestId: details.requestId,
        tabId: details.tabId,
        url: details.url,
        hostname,
        type: details.type,
        timeStamp: details.timeStamp,
      };
      const outcome = correlator.correlateRequest(record);
      const { changed } = tabStateManager.recordRequestOutcome(record, outcome);
      if (changed) {
        pushBadgesToTab(details.tabId, false);
      }
    });
  },
  { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
);

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0 || !details.ip) return;
    if (isControllerRequest(details.url, currentConfig.controller)) return;

    const hostname = extractHostnameFromUrl(details.url);
    if (!hostname) return;

    void ensureInitialized().then(() => {
      const record: BrowserRequestRecord = {
        requestId: details.requestId,
        tabId: details.tabId,
        url: details.url,
        hostname,
        type: details.type,
        timeStamp: details.timeStamp,
        ip: details.ip,
      };
      const outcome = correlator.correlateRequest(record);
      const { changed } = tabStateManager.recordRequestOutcome(record, outcome);
      if (changed) {
        pushBadgesToTab(details.tabId, false);
      }
    });
  },
  { urls: ['http://*/*', 'https://*/*'] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStateManager.removeTab(tabId);
  lastSentBadgeSignature.delete(tabId);
  contentReadyTabs.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url && isTrackablePageUrl(tab.url)) {
    const hostname = extractHostnameFromUrl(tab.url) ?? '';
    tabStateManager.ensureTab(tabId, tab.url, hostname);
  }
});

chrome.tabs.onActivated.addListener(() => {
  void ensureInitialized().then(() => {
    mihomoClient.ensureConnected();
  });
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  void (async () => {
    await ensureInitialized();

    switch (message.type) {
      case 'GET_TAB_SNAPSHOT': {
        const snapshot = tabStateManager.getSnapshot(message.tabId, currentConfig.favicon.retentionMs);
        sendResponse({
          snapshot,
          faviconConfig: currentConfig.favicon,
        });
        break;
      }

      case 'GET_CONTROLLER_STATUS': {
        sendResponse({ status: mihomoClient.getStatus() });
        break;
      }

      case 'TEST_CONTROLLER_CONNECTION': {
        const result = await testControllerConnection(message.controller);
        sendResponse({ result });
        break;
      }

      case 'FETCH_PROXY_GROUPS': {
        const result = await fetchControllerProxyGroups(message.controller);
        sendResponse({ result });
        break;
      }

      case 'RECONNECT_CONTROLLER': {
        mihomoClient.start();
        sendResponse({ ok: true });
        break;
      }

      case 'FETCH_FAVICON_DATA_URL': {
        const dataUrl = await faviconFetcher.getAsDataUrl(message.url);
        sendResponse({ dataUrl });
        break;
      }

      case 'CONTENT_READY': {
        const tabId = sender.tab?.id;
        if (typeof tabId === 'number' && tabId >= 0) {
          contentReadyTabs.add(tabId);
          const hostname = extractHostnameFromUrl(message.url) ?? '';
          tabStateManager.ensureTab(tabId, message.url, hostname);
          const snapshot = tabStateManager.getSnapshot(tabId, currentConfig.favicon.retentionMs);
          const badges = snapshot?.activeBadges ?? [];
          lastSentBadgeSignature.set(tabId, buildBadgeSignature(badges, currentConfig.favicon));
          sendResponse({
            badges,
            faviconConfig: currentConfig.favicon,
            overallStatus: snapshot?.overallStatus ?? 'UNKNOWN',
          });
        } else {
          sendResponse(null);
        }
        break;
      }

      case 'CONTENT_FAVICON_CHANGED': {
        const tabId = sender.tab?.id;
        if (typeof tabId === 'number' && tabId >= 0) {
          contentReadyTabs.add(tabId);
          const snapshot = tabStateManager.getSnapshot(tabId, currentConfig.favicon.retentionMs);
          sendResponse({
            badges: snapshot?.activeBadges ?? [],
            faviconConfig: currentConfig.favicon,
            overallStatus: snapshot?.overallStatus ?? 'UNKNOWN',
          });
        } else {
          sendResponse(null);
        }
        break;
      }

      default:
        sendResponse(null);
    }
  })();

  return true;
});

void ensureInitialized();
