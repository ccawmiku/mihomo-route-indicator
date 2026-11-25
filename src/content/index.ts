import { composeFaviconDataUrl } from '../shared/favicon-composer';
import type {
  BadgeDescriptor,
  FaviconOverlayConfig,
  PageOverallStatus,
  RuntimeMessage,
} from '../shared/types';

const ATTR_CREATED = 'data-mri-created';

let currentBadges: BadgeDescriptor[] = [];
let currentConfig: FaviconOverlayConfig | null = null;
let lastAppliedDataUrl: string | null = null;
let lastKnownOriginalUrl: string | null = null;
let cachedOriginalUrl: string | null = null;
let cachedBaseDataUrl: string | null = null;
let renderGeneration = 0;
let suppressObserver = false;

const originalHrefMap = new WeakMap<HTMLLinkElement, string>();

function isIconLinkElement(el: Element): el is HTMLLinkElement {
  if (el.tagName !== 'LINK') return false;
  const relAttr = (el.getAttribute('rel') ?? '').toLowerCase();
  if (!relAttr) return false;
  const tokens = relAttr.split(/\s+/).filter(Boolean);
  return tokens.includes('icon');
}

function getManagedIconLinks(): HTMLLinkElement[] {
  const allLinks = document.querySelectorAll('link[rel]');
  const result: HTMLLinkElement[] = [];
  for (const el of allLinks) {
    if (isIconLinkElement(el)) {
      result.push(el);
    }
  }
  return result;
}

function getDefaultFallbackIconUrl(): string {
  return `${window.location.origin}/favicon.ico`;
}

function resolveCurrentOriginalFaviconUrl(): { url: string; hasExplicitLink: boolean } {
  const links = getManagedIconLinks();
  const nonCreatedLinks = links.filter((l) => !l.hasAttribute(ATTR_CREATED));

  if (nonCreatedLinks.length === 0) {
    return { url: getDefaultFallbackIconUrl(), hasExplicitLink: false };
  }

  for (const link of nonCreatedLinks) {
    if (!originalHrefMap.has(link)) {
      const href = link.href || link.getAttribute('href') || '';
      if (href && href !== lastAppliedDataUrl) {
        originalHrefMap.set(link, href);
      }
    }
  }

  // 优先挑一个带有真实原链接的节点（通常最后一个优先级最高，或非 svg 优先）
  const candidates: string[] = [];
  for (const link of nonCreatedLinks) {
    const orig = originalHrefMap.get(link);
    if (orig) candidates.push(orig);
  }

  if (candidates.length === 0) {
    return { url: getDefaultFallbackIconUrl(), hasExplicitLink: true };
  }

  // 优先选 PNG / ICO 等位图或最后一个声明的图标
  const bitmap = [...candidates].reverse().find((u) => !u.toLowerCase().includes('.svg'));
  return {
    url: bitmap ?? candidates[candidates.length - 1]!,
    hasExplicitLink: true,
  };
}

function restoreOriginalFavicons(): void {
  suppressObserver = true;
  try {
    const links = getManagedIconLinks();
    for (const link of links) {
      if (link.hasAttribute(ATTR_CREATED)) {
        link.remove();
        continue;
      }
      const orig = originalHrefMap.get(link);
      if (orig && link.href !== orig) {
        link.href = orig;
      }
    }
    lastAppliedDataUrl = null;
  } finally {
    suppressObserver = false;
  }
}

function applyComposedFavicon(dataUrl: string): void {
  suppressObserver = true;
  try {
    const links = getManagedIconLinks();
    const nonCreated = links.filter((l) => !l.hasAttribute(ATTR_CREATED));

    if (nonCreated.length > 0) {
      for (const link of nonCreated) {
        if (!originalHrefMap.has(link) && link.href && link.href !== lastAppliedDataUrl) {
          originalHrefMap.set(link, link.href);
        }
        if (link.href !== dataUrl) {
          link.href = dataUrl;
        }
      }
      // 清理多余的扩展自建节点
      for (const link of links) {
        if (link.hasAttribute(ATTR_CREATED)) {
          link.remove();
        }
      }
    } else {
      let created = links.find((l) => l.hasAttribute(ATTR_CREATED));
      if (!created) {
        created = document.createElement('link');
        created.setAttribute(ATTR_CREATED, '1');
        created.rel = 'icon';
        created.type = 'image/png';
        (document.head || document.documentElement).appendChild(created);
      }
      if (created.href !== dataUrl) {
        created.href = dataUrl;
      }
    }

    lastAppliedDataUrl = dataUrl;
  } finally {
    suppressObserver = false;
  }
}

async function fetchBaseFaviconDataUrl(url: string): Promise<string | null> {
  if (url.startsWith('data:image/')) {
    return url;
  }
  if (cachedOriginalUrl === url && cachedBaseDataUrl) {
    return cachedBaseDataUrl;
  }

  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'FETCH_FAVICON_DATA_URL',
      url,
    } satisfies RuntimeMessage)) as { dataUrl?: string | null } | undefined;

    const dataUrl = response?.dataUrl ?? null;
    if (dataUrl) {
      cachedOriginalUrl = url;
      cachedBaseDataUrl = dataUrl;
    }
    return dataUrl;
  } catch {
    return null;
  }
}

async function renderCurrentState(): Promise<void> {
  const gen = ++renderGeneration;
  const config = currentConfig;
  const badges = currentBadges;

  if (!config || !config.enabled || badges.length === 0) {
    restoreOriginalFavicons();
    return;
  }

  const { url: origUrl } = resolveCurrentOriginalFaviconUrl();
  lastKnownOriginalUrl = origUrl;

  const baseDataUrl = await fetchBaseFaviconDataUrl(origUrl);
  if (gen !== renderGeneration) return;

  // 若原图拉取失败且页面本身确实没图标，使用温和的默认底图叠加；
  // 若原图拉取成功，则在原图上叠加。
  const composed = await composeFaviconDataUrl(
    baseDataUrl,
    badges,
    config,
    baseDataUrl === null,
  );
  if (gen !== renderGeneration) return;

  if (composed) {
    applyComposedFavicon(composed);
  }
}

function handleDomMutation(mutations: MutationRecord[]): void {
  if (suppressObserver) return;

  let detectedRealChange = false;

  for (const mutation of mutations) {
    if (mutation.type === 'attributes') {
      const target = mutation.target;
      if (target instanceof Element && isIconLinkElement(target)) {
        if (target.hasAttribute(ATTR_CREATED)) continue;
        const link = target as HTMLLinkElement;
        const currentHref = link.href || link.getAttribute('href') || '';
        if (currentHref && currentHref !== lastAppliedDataUrl) {
          originalHrefMap.set(link, currentHref);
          detectedRealChange = true;
        }
      }
    } else if (mutation.type === 'childList') {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        const candidates = isIconLinkElement(node)
          ? [node]
          : Array.from(node.querySelectorAll?.('link[rel]') ?? []).filter(isIconLinkElement);

        for (const link of candidates) {
          if (link.hasAttribute(ATTR_CREATED)) continue;
          const href = link.href || link.getAttribute('href') || '';
          if (href && href !== lastAppliedDataUrl) {
            originalHrefMap.set(link, href);
            detectedRealChange = true;
          }
        }
      }
    }
  }

  if (detectedRealChange) {
    const { url } = resolveCurrentOriginalFaviconUrl();
    if (url !== lastKnownOriginalUrl) {
      cachedOriginalUrl = null;
      cachedBaseDataUrl = null;
      lastKnownOriginalUrl = url;
      void chrome.runtime
        .sendMessage({
          type: 'CONTENT_FAVICON_CHANGED',
          originalFaviconUrl: url,
        } satisfies RuntimeMessage)
        .catch(() => {});
    }
    void renderCurrentState();
  }
}

const observer = new MutationObserver(handleDomMutation);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['href', 'rel'],
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === 'APPLY_TAB_BADGES') {
    currentBadges = message.badges;
    currentConfig = message.faviconConfig;
    void renderCurrentState();
    return;
  }
  if (message.type === 'GET_ORIGINAL_FAVICON') {
    const { url } = resolveCurrentOriginalFaviconUrl();
    sendResponse({ originalFaviconUrl: url });
  }
});

function notifyReady(): void {
  const { url } = resolveCurrentOriginalFaviconUrl();
  lastKnownOriginalUrl = url;
  void chrome.runtime
    .sendMessage({
      type: 'CONTENT_READY',
      url: window.location.href,
      originalFaviconUrl: url,
    } satisfies RuntimeMessage)
    .then(
      (
        res:
          | {
              badges?: BadgeDescriptor[];
              faviconConfig?: FaviconOverlayConfig;
              overallStatus?: PageOverallStatus;
            }
          | null
          | undefined,
      ) => {
        if (res && res.faviconConfig) {
          currentBadges = res.badges ?? [];
          currentConfig = res.faviconConfig;
          void renderCurrentState();
        }
      },
    )
    .catch(() => {});
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', notifyReady, { once: true });
} else {
  notifyReady();
}
