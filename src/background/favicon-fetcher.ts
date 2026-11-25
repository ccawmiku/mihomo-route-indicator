interface CachedFaviconEntry {
  dataUrl: string;
  fetchedAt: number;
}

const MAX_CACHE_SIZE = 120;
const CACHE_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function inferMimeType(url: string, contentType: string | null): string | null {
  if (contentType) {
    const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (base.startsWith('image/')) {
      return base;
    }
    if (base === 'application/octet-stream' || base === 'binary/octet-stream') {
      // fall through to URL extension guess
    } else if (base.startsWith('text/html') || base.startsWith('application/json')) {
      return null;
    }
  }

  const lower = url.toLowerCase().split('?')[0] ?? '';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  return 'image/png';
}

export class FaviconFetcher {
  private cache = new Map<string, CachedFaviconEntry>();
  private inFlight = new Map<string, Promise<string | null>>();

  async getAsDataUrl(rawUrl: string): Promise<string | null> {
    if (!rawUrl) return null;
    if (rawUrl.startsWith('data:image/')) {
      return rawUrl;
    }
    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
      return null;
    }

    const now = Date.now();
    const cached = this.cache.get(rawUrl);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      // refresh LRU order
      this.cache.delete(rawUrl);
      this.cache.set(rawUrl, cached);
      return cached.dataUrl;
    }

    const existing = this.inFlight.get(rawUrl);
    if (existing) {
      return existing;
    }

    const task = this.fetchAndCache(rawUrl).finally(() => {
      this.inFlight.delete(rawUrl);
    });
    this.inFlight.set(rawUrl, task);
    return task;
  }

  private async fetchAndCache(rawUrl: string): Promise<string | null> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(rawUrl, {
        method: 'GET',
        credentials: 'omit',
        signal: ac.signal,
      });
      if (!res.ok) return null;

      const mime = inferMimeType(rawUrl, res.headers.get('content-type'));
      if (!mime) return null;

      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0 || buf.byteLength > 2 * 1024 * 1024) {
        return null;
      }

      const dataUrl = `data:${mime};base64,${arrayBufferToBase64(buf)}`;
      if (this.cache.size >= MAX_CACHE_SIZE) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey !== undefined) {
          this.cache.delete(oldestKey);
        }
      }
      this.cache.set(rawUrl, { dataUrl, fetchedAt: Date.now() });
      return dataUrl;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
