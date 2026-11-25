import { DEFAULT_FAVICON_CONFIG } from '../shared/defaults';
import { loadImageElement, renderFaviconWithBadges } from '../shared/favicon-composer';
import type {
  BadgeShape,
  ControllerStatusSnapshot,
  FaviconOverlayConfig,
  RuntimeMessage,
  TabRouteSnapshot,
} from '../shared/types';

const ctrlStatusLineEl = document.getElementById('ctrlStatusLine') as HTMLDivElement;
const openOptionsBtnEl = document.getElementById('openOptionsBtn') as HTMLButtonElement;
const popupFaviconCanvas = document.getElementById('popupFaviconCanvas') as HTMLCanvasElement;
const tabDomainEl = document.getElementById('tabDomain') as HTMLSpanElement;
const overallStatusBadgeEl = document.getElementById('overallStatusBadge') as HTMLSpanElement;
const tabUrlTextEl = document.getElementById('tabUrlText') as HTMLDivElement;
const tabStatsLineEl = document.getElementById('tabStatsLine') as HTMLDivElement;
const groupsListEl = document.getElementById('groupsList') as HTMLDivElement;
const connectionsListEl = document.getElementById('connectionsList') as HTMLDivElement;
const limitationNoticeEl = document.getElementById('limitationNotice') as HTMLDivElement;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function createShapeSvg(shape: BadgeShape, color: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'shape-glyph');

  if (shape === 'circle') {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', '8');
    c.setAttribute('cy', '8');
    c.setAttribute('r', '6');
    c.setAttribute('fill', color);
    svg.appendChild(c);
  } else if (shape === 'square') {
    const r = document.createElementNS(ns, 'rect');
    r.setAttribute('x', '2');
    r.setAttribute('y', '2');
    r.setAttribute('width', '12');
    r.setAttribute('height', '12');
    r.setAttribute('rx', '2');
    r.setAttribute('fill', color);
    svg.appendChild(r);
  } else {
    const p = document.createElementNS(ns, 'polygon');
    p.setAttribute('points', '8,2 14,13 2,13');
    p.setAttribute('fill', color);
    svg.appendChild(p);
  }
  return svg;
}

function renderControllerStatus(status: ControllerStatusSnapshot | undefined): void {
  if (!status) {
    ctrlStatusLineEl.className = 'ctrl-status err';
    ctrlStatusLineEl.textContent = 'Controller: 未连接';
    return;
  }

  if (status.state === 'connected_ws') {
    ctrlStatusLineEl.className = 'ctrl-status ok';
    ctrlStatusLineEl.textContent = `WS 已连接 · ${status.activeConnectionsCount} 活跃连接`;
  } else if (status.state === 'connected_http') {
    ctrlStatusLineEl.className = 'ctrl-status warn';
    ctrlStatusLineEl.textContent = `HTTP 备用轮询 · ${status.activeConnectionsCount} 活跃连接`;
  } else {
    ctrlStatusLineEl.className = 'ctrl-status err';
    ctrlStatusLineEl.textContent = `未连接${status.lastError ? ` (${status.lastError})` : ''}`;
  }
}

async function resolveCleanFaviconUrl(tab: chrome.tabs.Tab): Promise<string | null> {
  if (tab.id !== undefined) {
    try {
      const res = (await chrome.tabs.sendMessage(tab.id, {
        type: 'GET_ORIGINAL_FAVICON',
      } satisfies RuntimeMessage)) as { originalFaviconUrl?: string } | undefined;
      if (res?.originalFaviconUrl) {
        return res.originalFaviconUrl;
      }
    } catch {
      // Content script unavailable on restricted pages
    }
  }
  if (tab.favIconUrl && !tab.favIconUrl.startsWith('data:image/png')) {
    return tab.favIconUrl;
  }
  if (tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
    try {
      return `${new URL(tab.url).origin}/favicon.ico`;
    } catch {
      return null;
    }
  }
  return null;
}

async function renderPopupFaviconPreview(
  tab: chrome.tabs.Tab,
  snapshot: TabRouteSnapshot | null,
  faviconConfig: FaviconOverlayConfig,
): Promise<void> {
  const ctx = popupFaviconCanvas.getContext('2d');
  if (!ctx) return;

  const cleanUrl = await resolveCleanFaviconUrl(tab);
  let baseImg: HTMLImageElement | null = null;

  if (cleanUrl) {
    try {
      const fetched = (await chrome.runtime.sendMessage({
        type: 'FETCH_FAVICON_DATA_URL',
        url: cleanUrl,
      } satisfies RuntimeMessage)) as { dataUrl?: string | null } | undefined;
      if (fetched?.dataUrl) {
        baseImg = await loadImageElement(fetched.dataUrl);
      }
    } catch {
      baseImg = null;
    }
  }

  renderFaviconWithBadges(
    ctx,
    popupFaviconCanvas.width,
    baseImg,
    snapshot?.activeBadges ?? [],
    faviconConfig,
    baseImg === null,
  );
}

function renderSnapshot(tab: chrome.tabs.Tab, snapshot: TabRouteSnapshot | null): void {
  const rawUrl = tab.url ?? '';
  let hostname = snapshot?.hostname ?? '';
  if (!hostname && rawUrl) {
    try {
      hostname = new URL(rawUrl).hostname || rawUrl;
    } catch {
      hostname = rawUrl;
    }
  }

  tabDomainEl.textContent = hostname || '当前标签页';
  tabUrlTextEl.textContent = rawUrl || '无可用 URL';

  const status = snapshot?.overallStatus ?? 'UNKNOWN';
  overallStatusBadgeEl.className = `overall-badge overall-${status}`;
  overallStatusBadgeEl.textContent = status;

  if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
    limitationNoticeEl.hidden = false;
    limitationNoticeEl.textContent =
      '受 Chromium 安全限制，内部页面（如 chrome://、扩展页）不支持注入脚本修改标签页 Favicon。';
  } else {
    limitationNoticeEl.hidden = true;
  }

  if (!snapshot) {
    tabStatsLineEl.textContent = '请求 0 · 尚未捕获网络请求（刷新页面或等待请求发出）';
    groupsListEl.textContent = '';
    const emptyGroup = document.createElement('div');
    emptyGroup.className = 'empty-state';
    emptyGroup.textContent = '当前页面暂无已识别的分流组。';
    groupsListEl.appendChild(emptyGroup);

    connectionsListEl.textContent = '';
    const emptyConn = document.createElement('div');
    emptyConn.className = 'empty-state';
    emptyConn.textContent = '暂无最近关联记录。';
    connectionsListEl.appendChild(emptyConn);
    return;
  }

  tabStatsLineEl.textContent = `请求 ${snapshot.totalRequests} · 已关联 ${snapshot.matchedRequests} · 未知/歧义 ${snapshot.unknownRequests}`;

  // 渲染分流组列表
  groupsListEl.textContent = '';
  if (snapshot.allGroups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '当前标签页尚未命中已配置的分流组规则。';
    groupsListEl.appendChild(empty);
  } else {
    const activeIds = new Set(snapshot.activeBadges.map((b) => b.groupId));
    for (const g of snapshot.allGroups) {
      const card = document.createElement('div');
      card.className = 'group-item';

      const top = document.createElement('div');
      top.className = 'group-top';

      const nameWrap = document.createElement('div');
      nameWrap.className = 'group-name-wrap';
      nameWrap.appendChild(createShapeSvg(g.shape, g.color));
      const nameSpan = document.createElement('span');
      nameSpan.textContent = g.name + (activeIds.has(g.groupId) ? '' : '（已静默）');
      nameWrap.appendChild(nameSpan);

      const countSpan = document.createElement('span');
      countSpan.className = 'group-count';
      countSpan.textContent = `${g.requestCount} 次请求`;

      top.append(nameWrap, countSpan);
      card.appendChild(top);

      const ruleText = g.sampleRule
        ? `命中规则: ${g.sampleRule}${g.sampleRulePayload ? ` (${g.sampleRulePayload})` : ''}`
        : '命中规则: 无';
      const sub = document.createElement('div');
      sub.className = 'group-sub';
      sub.textContent = ruleText;
      card.appendChild(sub);

      if (g.sampleChains.length > 0) {
        const chainsWrap = document.createElement('div');
        chainsWrap.className = 'chain-pills';
        for (const member of g.sampleChains) {
          const pill = document.createElement('span');
          pill.className = 'chain-pill';
          pill.textContent = member;
          chainsWrap.appendChild(pill);
        }
        card.appendChild(chainsWrap);
      }

      groupsListEl.appendChild(card);
    }
  }

  // 渲染最近连接
  connectionsListEl.textContent = '';
  if (snapshot.recentConnections.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '暂无最近关联记录。';
    connectionsListEl.appendChild(empty);
  } else {
    for (const item of snapshot.recentConnections.slice(0, 12)) {
      const row = document.createElement('div');
      row.className = 'conn-item';

      const top = document.createElement('div');
      top.className = 'conn-top';

      const host = document.createElement('span');
      host.className = 'conn-host';
      host.textContent = `${item.hostname} (${item.requestType})`;

      const tag = document.createElement('span');
      tag.className = `conn-tag ${item.status}`;
      tag.textContent =
        item.status === 'matched'
          ? item.groupName ?? item.transportKind
          : item.status === 'ambiguous'
            ? '歧义(未猜测)'
            : '未知';

      top.append(host, tag);
      row.appendChild(top);

      const meta = document.createElement('div');
      meta.className = 'conn-meta';
      if (item.status === 'matched') {
        const chainStr = item.chains.length > 0 ? item.chains.join(' ← ') : '-';
        const ruleStr = item.rule ? `${item.rule}${item.rulePayload ? `(${item.rulePayload})` : ''}` : '-';
        const ipStr = item.destinationIP || '-';
        meta.textContent = `链路: ${chainStr} · 规则: ${ruleStr} · IP: ${ipStr} · ↑${formatBytes(
          item.upload,
        )} ↓${formatBytes(item.download)}`;
      } else {
        meta.textContent = `未归属原因: ${item.reason ?? '未匹配到明确 Mihomo 连接'}`;
      }
      row.appendChild(meta);
      connectionsListEl.appendChild(row);
    }
  }
}

async function init(): Promise<void> {
  openOptionsBtnEl.addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
  });

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const statusRes = (await chrome.runtime.sendMessage({
    type: 'GET_CONTROLLER_STATUS',
  } satisfies RuntimeMessage)) as { status?: ControllerStatusSnapshot } | undefined;
  renderControllerStatus(statusRes?.status);

  if (!activeTab || activeTab.id === undefined) {
    tabDomainEl.textContent = '无活动标签页';
    return;
  }

  const snapRes = (await chrome.runtime.sendMessage({
    type: 'GET_TAB_SNAPSHOT',
    tabId: activeTab.id,
  } satisfies RuntimeMessage)) as
    | { snapshot?: TabRouteSnapshot | null; faviconConfig?: FaviconOverlayConfig }
    | undefined;

  const snapshot = snapRes?.snapshot ?? null;
  const faviconConfig = snapRes?.faviconConfig ?? DEFAULT_FAVICON_CONFIG;

  renderSnapshot(activeTab, snapshot);
  void renderPopupFaviconPreview(activeTab, snapshot, faviconConfig);
}

void init();
