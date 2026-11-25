import { DEFAULT_EXTENSION_CONFIG, sanitizeExtensionConfig } from './defaults';
import type { ExtensionConfig } from './types';

export const CONFIG_STORAGE_KEY = 'mihomo_route_indicator_config';

export async function loadExtensionConfig(): Promise<ExtensionConfig> {
  const result = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
  const raw = result[CONFIG_STORAGE_KEY];
  if (!raw) {
    return sanitizeExtensionConfig(DEFAULT_EXTENSION_CONFIG);
  }
  return sanitizeExtensionConfig(raw);
}

export async function saveExtensionConfig(config: ExtensionConfig): Promise<ExtensionConfig> {
  const sanitized = sanitizeExtensionConfig(config);
  await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: sanitized });
  return sanitized;
}

export function onConfigChanged(callback: (config: ExtensionConfig) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: chrome.storage.AreaName,
  ) => {
    if (areaName !== 'local') return;
    const change = changes[CONFIG_STORAGE_KEY];
    if (!change) return;
    callback(sanitizeExtensionConfig(change.newValue));
  };

  chrome.storage.onChanged.addListener(listener);
  return () => {
    chrome.storage.onChanged.removeListener(listener);
  };
}
