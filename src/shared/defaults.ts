import type {
  BadgeShape,
  ControllerConfig,
  ExtensionConfig,
  FaviconOverlayConfig,
  MatchMode,
  RouteGroupConfig,
} from './types';

export const MAX_FAVICON_BADGES = 4;

export const DEFAULT_CONTROLLER_CONFIG: ControllerConfig = {
  host: '127.0.0.1',
  port: 9090,
  secret: '',
  useTls: false,
};

export const DEFAULT_FAVICON_CONFIG: FaviconOverlayConfig = {
  enabled: true,
  markerSize: 20,
  strokeWidth: 2.5,
  strokeColor: '#ffffff',
  retentionMs: 15_000,
};

export interface PresetColorOption {
  hex: string;
  label: string;
}

export const PRESET_COLORS: readonly PresetColorOption[] = [
  { hex: '#3b82f6', label: '蓝色' },
  { hex: '#a855f7', label: '紫色' },
  { hex: '#22c55e', label: '绿色' },
  { hex: '#f97316', label: '橙色' },
  { hex: '#ef4444', label: '红色' },
  { hex: '#06b6d4', label: '青色' },
  { hex: '#ec4899', label: '粉色' },
  { hex: '#eab308', label: '黄色' },
  { hex: '#6366f1', label: '靛蓝' },
  { hex: '#10b981', label: '翠绿' },
  { hex: '#f43f5e', label: '玫红' },
  { hex: '#64748b', label: '石板灰' },
];

export const DEFAULT_ROUTE_GROUPS: RouteGroupConfig[] = [];

export const DEFAULT_EXTENSION_CONFIG: ExtensionConfig = {
  controller: { ...DEFAULT_CONTROLLER_CONFIG },
  routeGroups: DEFAULT_ROUTE_GROUPS.map((g) => ({ ...g })),
  favicon: { ...DEFAULT_FAVICON_CONFIG },
};

const VALID_SHAPES: ReadonlySet<BadgeShape> = new Set(['circle', 'triangle', 'square']);
const VALID_MATCH_MODES: ReadonlySet<MatchMode> = new Set(['exact', 'contains', 'regex']);

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed) || /^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return trimmed;
  }
  return fallback;
}

export function sanitizeControllerConfig(raw: Partial<ControllerConfig> | undefined): ControllerConfig {
  const host = typeof raw?.host === 'string' && raw.host.trim() ? raw.host.trim() : DEFAULT_CONTROLLER_CONFIG.host;
  const port = Math.round(clampNumber(raw?.port, 1, 65535, DEFAULT_CONTROLLER_CONFIG.port));
  const secret = typeof raw?.secret === 'string' ? raw.secret : DEFAULT_CONTROLLER_CONFIG.secret;
  const useTls = typeof raw?.useTls === 'boolean' ? raw.useTls : DEFAULT_CONTROLLER_CONFIG.useTls;
  return { host, port, secret, useTls };
}

export function sanitizeFaviconConfig(raw: Partial<FaviconOverlayConfig> | undefined): FaviconOverlayConfig {
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : DEFAULT_FAVICON_CONFIG.enabled,
    markerSize: Math.round(clampNumber(raw?.markerSize, 12, 28, DEFAULT_FAVICON_CONFIG.markerSize)),
    strokeWidth: clampNumber(raw?.strokeWidth, 0, 6, DEFAULT_FAVICON_CONFIG.strokeWidth),
    strokeColor: normalizeHexColor(raw?.strokeColor, DEFAULT_FAVICON_CONFIG.strokeColor),
    retentionMs: Math.round(clampNumber(raw?.retentionMs, 2000, 120000, DEFAULT_FAVICON_CONFIG.retentionMs)),
  };
}

export function sanitizeRouteGroups(raw: unknown): RouteGroupConfig[] {
  if (!Array.isArray(raw)) {
    return DEFAULT_ROUTE_GROUPS.map((g) => ({ ...g }));
  }

  const sanitized: RouteGroupConfig[] = [];
  const seenIds = new Set<string>();

  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const obj = item as Partial<RouteGroupConfig>;
    let id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `group-${index + 1}`;
    while (seenIds.has(id)) {
      id = `${id}-${index + 1}`;
    }
    seenIds.add(id);

    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : `分流组 ${index + 1}`;
    const matchMode: MatchMode = obj.matchMode && VALID_MATCH_MODES.has(obj.matchMode) ? obj.matchMode : 'exact';
    const pattern = typeof obj.pattern === 'string' ? obj.pattern : '';
    const shape: BadgeShape = obj.shape && VALID_SHAPES.has(obj.shape) ? obj.shape : 'circle';
    const color = normalizeHexColor(obj.color, '#3b82f6');
    const priority =
      typeof obj.priority === 'number' && Number.isFinite(obj.priority) ? obj.priority : index + 1;
    const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : true;

    sanitized.push({
      id,
      name,
      matchMode,
      pattern,
      shape,
      color,
      priority,
      enabled,
    });
  });

  sanitized.sort((a, b) => a.priority - b.priority);
  return sanitized.map((g, idx) => ({ ...g, priority: idx + 1 }));
}

export function sanitizeExtensionConfig(raw: unknown): ExtensionConfig {
  if (!raw || typeof raw !== 'object') {
    return {
      controller: { ...DEFAULT_CONTROLLER_CONFIG },
      routeGroups: DEFAULT_ROUTE_GROUPS.map((g) => ({ ...g })),
      favicon: { ...DEFAULT_FAVICON_CONFIG },
    };
  }
  const obj = raw as Partial<ExtensionConfig>;
  return {
    controller: sanitizeControllerConfig(obj.controller),
    routeGroups: sanitizeRouteGroups(obj.routeGroups),
    favicon: sanitizeFaviconConfig(obj.favicon),
  };
}
