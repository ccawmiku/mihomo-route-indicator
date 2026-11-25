import { describe, expect, it } from 'vitest';
import { ConnectionCorrelator } from '../src/background/correlator';
import { compileRouteGroupRules } from '../src/shared/route-matcher';
import type { BrowserRequestRecord, MihomoConnection, RouteGroupConfig } from '../src/shared/types';

const TEST_GROUPS: RouteGroupConfig[] = [
  { id: 'ai', name: 'AI', matchMode: 'exact', pattern: 'AI', shape: 'circle', color: '#3b82f6', priority: 1, enabled: true },
  { id: 'direct', name: 'DIRECT', matchMode: 'exact', pattern: 'DIRECT', shape: 'square', color: '#22c55e', priority: 2, enabled: true },
];

function makeConn(overrides: Partial<MihomoConnection> & { id: string }): MihomoConnection {
  return {
    id: overrides.id,
    metadata: {
      type: 'HTTPS',
      destinationIP: '104.18.0.1',
      host: 'api.openai.com',
      sniffHost: '',
      ...overrides.metadata,
    },
    upload: overrides.upload ?? 100,
    download: overrides.download ?? 200,
    start: overrides.start ?? new Date(10_000).toISOString(),
    chains: overrides.chains ?? ['东京节点', 'AI'],
    rule: overrides.rule ?? 'DOMAIN-SUFFIX',
    rulePayload: overrides.rulePayload ?? 'openai.com',
  };
}

function makeReq(overrides: Partial<BrowserRequestRecord> = {}): BrowserRequestRecord {
  return {
    requestId: overrides.requestId ?? 'req-1',
    tabId: overrides.tabId ?? 10,
    url: overrides.url ?? 'https://api.openai.com/v1/chat',
    hostname: overrides.hostname ?? 'api.openai.com',
    type: overrides.type ?? 'xmlhttprequest',
    timeStamp: overrides.timeStamp ?? 10_200,
    ip: overrides.ip,
  };
}

describe('ConnectionCorrelator', () => {
  const compiled = compileRouteGroupRules(TEST_GROUPS);

  it('matches active reused HTTP/2/HTTP/3 connections even when connection started much earlier', () => {
    const correlator = new ConnectionCorrelator();
    correlator.updateSnapshot(
      [
        makeConn({
          id: 'c1',
          start: new Date(1_000).toISOString(),
          chains: ['东京节点', 'AI'],
        }),
      ],
      compiled,
      120_000,
    );

    const outcome = correlator.correlateRequest(makeReq({ timeStamp: 120_500 }));
    expect(outcome.status).toBe('matched');
    if (outcome.status === 'matched') {
      expect(outcome.tracked.matchedGroup?.name).toBe('AI');
    }
  });

  it('returns unknown when no Mihomo connection matches hostname', () => {
    const correlator = new ConnectionCorrelator();
    correlator.updateSnapshot([makeConn({ id: 'c1' })], compiled, 10_000);

    const outcome = correlator.correlateRequest(
      makeReq({ hostname: 'unknown-example.org', url: 'https://unknown-example.org/' }),
    );
    expect(outcome.status).toBe('unknown');
  });

  it('matches recently closed short-lived connections within grace window', () => {
    const correlator = new ConnectionCorrelator();
    const conn = makeConn({
      id: 'c-short',
      start: new Date(10_000).toISOString(),
      metadata: { type: 'HTTP', destinationIP: '1.1.1.1', host: 'example.com', sniffHost: '' },
      chains: ['DIRECT'],
    });
    correlator.updateSnapshot([conn], compiled, 10_100);
    // Connection closes at 10_500
    correlator.updateSnapshot([], compiled, 10_500);

    const outcome = correlator.correlateRequest(
      makeReq({ hostname: 'example.com', url: 'https://example.com/', timeStamp: 10_200 }),
    );
    expect(outcome.status).toBe('matched');
    if (outcome.status === 'matched') {
      expect(outcome.tracked.matchedGroup?.name).toBe('DIRECT');
    }
  });

  it('marks conflicting multi-route connections as ambiguous instead of guessing', () => {
    const correlator = new ConnectionCorrelator();
    correlator.updateSnapshot(
      [
        makeConn({
          id: 'c-ai',
          start: new Date(5_000).toISOString(),
          metadata: { type: 'HTTPS', destinationIP: '1.2.3.4', host: 'shared.example.com', sniffHost: '' },
          chains: ['东京节点', 'AI'],
        }),
        makeConn({
          id: 'c-direct',
          start: new Date(5_100).toISOString(),
          metadata: { type: 'HTTPS', destinationIP: '1.2.3.5', host: 'shared.example.com', sniffHost: '' },
          chains: ['DIRECT'],
        }),
      ],
      compiled,
      20_000,
    );

    const outcome = correlator.correlateRequest(
      makeReq({
        hostname: 'shared.example.com',
        url: 'https://shared.example.com/',
        timeStamp: 20_100,
      }),
    );
    expect(outcome.status).toBe('ambiguous');
  });

  it('disambiguates conflicting connections when non-loopback destination IP matches', () => {
    const correlator = new ConnectionCorrelator();
    correlator.updateSnapshot(
      [
        makeConn({
          id: 'c-ai',
          start: new Date(5_000).toISOString(),
          metadata: { type: 'HTTPS', destinationIP: '1.2.3.4', host: 'shared.example.com', sniffHost: '' },
          chains: ['东京节点', 'AI'],
        }),
        makeConn({
          id: 'c-direct',
          start: new Date(5_100).toISOString(),
          metadata: { type: 'HTTPS', destinationIP: '1.2.3.5', host: 'shared.example.com', sniffHost: '' },
          chains: ['DIRECT'],
        }),
      ],
      compiled,
      20_000,
    );

    const outcome = correlator.correlateRequest(
      makeReq({
        hostname: 'shared.example.com',
        url: 'https://shared.example.com/',
        timeStamp: 20_100,
        ip: '1.2.3.5',
      }),
    );
    expect(outcome.status).toBe('matched');
    if (outcome.status === 'matched') {
      expect(outcome.tracked.matchedGroup?.name).toBe('DIRECT');
    }
  });
});
