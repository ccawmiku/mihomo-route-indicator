import type { ControllerConfig } from './types';

const IGNORED_SCHEMES = new Set([
  'chrome:',
  'chrome-extension:',
  'edge:',
  'about:',
  'data:',
  'blob:',
  'file:',
  'javascript:',
  'devtools:',
]);

export function normalizeHostname(host: string): string {
  let cleaned = host.trim().toLowerCase();
  if (!cleaned) return '';
  if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
    cleaned = cleaned.slice(1, -1);
  }
  if (cleaned.endsWith('.')) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
}

export function extractHostnameFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (IGNORED_SCHEMES.has(parsed.protocol)) {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return null;
    }
    const host = normalizeHostname(parsed.hostname);
    return host || null;
  } catch {
    return null;
  }
}

export function isTrackablePageUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isControllerRequest(rawUrl: string, controller: ControllerConfig): boolean {
  try {
    const parsed = new URL(rawUrl);
    const reqHost = normalizeHostname(parsed.hostname);
    const ctrlHost = normalizeHostname(controller.host);
    const reqPort = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 443 : 80;
    return reqHost === ctrlHost && reqPort === controller.port;
  } catch {
    return false;
  }
}

export function buildControllerHttpBase(controller: ControllerConfig): string {
  const scheme = controller.useTls ? 'https' : 'http';
  const host = controller.host.includes(':') && !controller.host.startsWith('[')
    ? `[${controller.host}]`
    : controller.host;
  return `${scheme}://${host}:${controller.port}`;
}

export function buildControllerWsUrl(controller: ControllerConfig, intervalMs = 1000): string {
  const scheme = controller.useTls ? 'wss' : 'ws';
  const host = controller.host.includes(':') && !controller.host.startsWith('[')
    ? `[${controller.host}]`
    : controller.host;
  const params = new URLSearchParams();
  params.set('interval', String(intervalMs));
  if (controller.secret) {
    params.set('token', controller.secret);
  }
  return `${scheme}://${host}:${controller.port}/connections?${params.toString()}`;
}
