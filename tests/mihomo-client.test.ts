import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchControllerProxyGroups,
  MihomoClient,
  testControllerConnection,
} from '../src/background/mihomo-client';
import type { ControllerConfig, ControllerStatusSnapshot, MihomoConnection } from '../src/shared/types';

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  constructor(public readonly url: string) {}
  close(): void {
    this.readyState = 3;
  }
  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  emitMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
  emitClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' } as CloseEvent);
  }
}

const BASE_CTRL: ControllerConfig = {
  host: '127.0.0.1',
  port: 9090,
  secret: 'my-secret',
  useTls: false,
};

describe('MihomoClient & testControllerConnection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects via WebSocket, receives connections, and falls back to HTTP when WS closes', async () => {
    vi.useFakeTimers();
    let fakeWs: FakeWebSocket | null = null;
    const received: MihomoConnection[][] = [];
    const statuses: ControllerStatusSnapshot[] = [];

    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/version')) {
        return new Response(JSON.stringify({ version: 'v1.18.0' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          connections: [
            {
              id: 'http-conn-1',
              metadata: { type: 'HTTP', destinationIP: '1.1.1.1', host: 'example.com', sniffHost: '' },
              upload: 10,
              download: 20,
              start: new Date().toISOString(),
              chains: ['DIRECT'],
              rule: 'MATCH',
              rulePayload: '',
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new MihomoClient(
      BASE_CTRL,
      {
        onConnections: (conns) => received.push(conns),
        onStatusChange: (status) => statuses.push(status),
      },
      {
        createWebSocket: (url) => {
          fakeWs = new FakeWebSocket(url);
          return fakeWs as unknown as WebSocket;
        },
        fetchFn: mockFetch,
      },
    );

    client.start();
    expect(fakeWs).not.toBeNull();
    expect(fakeWs!.url).toContain('token=my-secret');
    expect(fakeWs!.url).toContain('interval=1000');

    fakeWs!.emitOpen();
    fakeWs!.emitMessage({
      connections: [
        {
          id: 'ws-conn-1',
          metadata: { type: 'HTTPS', destinationIP: '8.8.8.8', host: 'openai.com', sniffHost: '' },
          upload: 1,
          download: 2,
          start: new Date().toISOString(),
          chains: ['AI'],
          rule: 'DOMAIN',
          rulePayload: 'openai.com',
        },
      ],
    });
    expect(received[0]?.[0]?.id).toBe('ws-conn-1');
    expect(client.getStatus().state).toBe('connected_ws');

    // Simulate WS drop -> immediate HTTP fallback poll
    fakeWs!.emitClose(1006);
    await vi.advanceTimersByTimeAsync(10);

    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(received[1]?.[0]?.id).toBe('http-conn-1');
    expect(client.getStatus().state).toBe('connected_http');
    client.stop();
  });

  it('reports auth failure cleanly in testControllerConnection', async () => {
    const mockFetch = vi.fn(async () => new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch;
    const res = await testControllerConnection(BASE_CTRL, mockFetch);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('401');
  });

  it('extracts proxy groups from GET /proxies while filtering out leaf nodes', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          proxies: {
            GLOBAL: { name: 'GLOBAL', type: 'Selector', all: ['PROXY', 'AI', 'DIRECT'], now: 'PROXY' },
            PROXY: { name: 'PROXY', type: 'Selector', all: ['HK-01', 'JP-01'], now: 'HK-01' },
            AI: { name: 'AI', type: 'URLTest', all: ['JP-01'], now: 'JP-01' },
            DIRECT: { name: 'DIRECT', type: 'Direct' },
            'HK-01': { name: 'HK-01', type: 'Shadowsocks' },
            'JP-01': { name: 'JP-01', type: 'Trojan' },
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const res = await fetchControllerProxyGroups(BASE_CTRL, mockFetch);
    expect(res.ok).toBe(true);
    expect(res.groups.map((g) => g.name)).toEqual(['PROXY', 'AI', 'DIRECT', 'GLOBAL']);
    expect(res.groups.find((g) => g.name === 'GLOBAL')?.isGlobal).toBe(true);
    expect(res.groups.find((g) => g.name === 'AI')?.now).toBe('JP-01');
  });
});
