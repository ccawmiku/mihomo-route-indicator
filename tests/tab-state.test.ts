import { describe, expect, it } from 'vitest';
import { ConnectionCorrelator } from '../src/background/correlator';
import { TabStateManager } from '../src/background/tab-state';
import { compileRouteGroupRules } from '../src/shared/route-matcher';
import type { BrowserRequestRecord, MihomoConnection, RouteGroupConfig } from '../src/shared/types';

const TEST_GROUPS: RouteGroupConfig[] = [
  { id: 'ai', name: 'AI', matchMode: 'exact', pattern: 'AI', shape: 'circle', color: '#3b82f6', priority: 1, enabled: true },
  { id: 'direct', name: 'DIRECT', matchMode: 'exact', pattern: 'DIRECT', shape: 'square', color: '#22c55e', priority: 2, enabled: true },
];

function makeConn(id: string, host: string, chains: string[], startMs = 1000): MihomoConnection {
  return {
    id,
    metadata: {
      type: 'HTTPS',
      destinationIP: '8.8.8.8',
      host,
      sniffHost: '',
    },
    upload: 120,
    download: 340,
    start: new Date(startMs).toISOString(),
    chains,
    rule: 'MATCH',
    rulePayload: '',
  };
}

function makeReq(requestId: string, tabId: number, hostname: string, timeStamp: number): BrowserRequestRecord {
  return {
    requestId,
    tabId,
    url: `https://${hostname}/path`,
    hostname,
    type: 'xmlhttprequest',
    timeStamp,
  };
}

describe('TabStateManager', () => {
  it('deduplicates badges per group while counting requests and capping at 4 by priority', () => {
    const groups: RouteGroupConfig[] = [
      { id: 'g1', name: 'G1', matchMode: 'exact', pattern: 'G1', shape: 'circle', color: '#111111', priority: 1, enabled: true },
      { id: 'g2', name: 'G2', matchMode: 'exact', pattern: 'G2', shape: 'square', color: '#222222', priority: 2, enabled: true },
      { id: 'g3', name: 'G3', matchMode: 'exact', pattern: 'G3', shape: 'triangle', color: '#333333', priority: 3, enabled: true },
      { id: 'g4', name: 'G4', matchMode: 'exact', pattern: 'G4', shape: 'circle', color: '#444444', priority: 4, enabled: true },
      { id: 'g5', name: 'G5', matchMode: 'exact', pattern: 'G5', shape: 'square', color: '#555555', priority: 5, enabled: true },
    ];
    const compiled = compileRouteGroupRules(groups);
    const correlator = new ConnectionCorrelator();
    correlator.updateSnapshot(
      [
        makeConn('c5', 'h5.test', ['G5']),
        makeConn('c3', 'h3.test', ['G3']),
        makeConn('c1', 'h1.test', ['G1']),
        makeConn('c4', 'h4.test', ['G4']),
        makeConn('c2', 'h2.test', ['G2']),
      ],
      compiled,
      2000,
    );

    const manager = new TabStateManager();
    const requests = [
      makeReq('r1', 1, 'h5.test', 2100),
      makeReq('r2', 1, 'h1.test', 2110),
      makeReq('r3', 1, 'h1.test', 2120),
      makeReq('r4', 1, 'h3.test', 2130),
      makeReq('r5', 1, 'h2.test', 2140),
      makeReq('r6', 1, 'h4.test', 2150),
    ];
    for (const r of requests) {
      manager.recordRequestOutcome(r, correlator.correlateRequest(r), 2200);
    }

    const snapshot = manager.getSnapshot(1, 15_000, 2300)!;
    expect(snapshot.activeBadges.map((b) => b.name)).toEqual(['G1', 'G2', 'G3', 'G4']);
    expect(snapshot.allGroups.find((g) => g.name === 'G1')?.requestCount).toBe(2);
    expect(snapshot.overallStatus).toBe('PROXY');
  });

  it('computes MIXED status when both PROXY and DIRECT routes exist, and prunes inactive badges after retention window', () => {
    const compiled = compileRouteGroupRules(TEST_GROUPS);
    const correlator = new ConnectionCorrelator();
    correlator.updateSnapshot(
      [
        makeConn('c-ai', 'ai.test', ['东京节点', 'AI'], 1000),
        makeConn('c-dir', 'dir.test', ['DIRECT'], 1000),
      ],
      compiled,
      2000,
    );

    const manager = new TabStateManager();
    const r1 = makeReq('r1', 7, 'ai.test', 2100);
    const r2 = makeReq('r2', 7, 'dir.test', 2150);
    manager.recordRequestOutcome(r1, correlator.correlateRequest(r1), 2200);
    manager.recordRequestOutcome(r2, correlator.correlateRequest(r2), 2200);

    const snapMixed = manager.getSnapshot(7, 15_000, 3000)!;
    expect(snapMixed.overallStatus).toBe('MIXED');
    expect(snapMixed.activeBadges.map((b) => b.name)).toEqual(['AI', 'DIRECT']);

    // c-dir closes at t=4000, c-ai stays active
    correlator.updateSnapshot([makeConn('c-ai', 'ai.test', ['东京节点', 'AI'], 1000)], compiled, 4000);
    manager.refreshActiveState(correlator.getActiveConnectionIds(), 15_000, 4000);

    // Within retention window (t=10000): DIRECT badge still kept to avoid flicker
    const snapHeld = manager.getSnapshot(7, 15_000, 10_000)!;
    expect(snapHeld.activeBadges.map((b) => b.name)).toEqual(['AI', 'DIRECT']);

    // Past retention window (t=20000): DIRECT badge removed, AI stays active
    manager.refreshActiveState(correlator.getActiveConnectionIds(), 15_000, 20_000);
    const snapPruned = manager.getSnapshot(7, 15_000, 20_000)!;
    expect(snapPruned.activeBadges.map((b) => b.name)).toEqual(['AI']);
  });

  it('reprocesses pending requests when delayed Mihomo WS snapshot arrives and marks timed-out requests unknown', () => {
    const compiled = compileRouteGroupRules(TEST_GROUPS);
    const correlator = new ConnectionCorrelator();
    const manager = new TabStateManager();

    const rMatch = makeReq('r-late', 9, 'late.test', 10_000);
    const rMissing = makeReq('r-miss', 9, 'never.test', 10_000);

    manager.recordRequestOutcome(rMatch, correlator.correlateRequest(rMatch), 10_000);
    manager.recordRequestOutcome(rMissing, correlator.correlateRequest(rMissing), 10_000);

    // 800ms later WS pushes the connection for late.test
    correlator.updateSnapshot([makeConn('c-late', 'late.test', ['DIRECT'], 10_050)], compiled, 10_800);
    const changed = manager.reprocessPendingRequests((req) => correlator.correlateRequest(req), 10_800);
    expect(changed).toContain(9);

    const midSnap = manager.getSnapshot(9, 15_000, 10_800)!;
    expect(midSnap.matchedRequests).toBe(1);
    expect(midSnap.unknownRequests).toBe(0);

    // 4 seconds later, never.test times out and is recorded as unknown
    manager.reprocessPendingRequests((req) => correlator.correlateRequest(req), 14_000);
    const finalSnap = manager.getSnapshot(9, 15_000, 14_000)!;
    expect(finalSnap.unknownRequests).toBe(1);
    expect(finalSnap.recentConnections.find((c) => c.requestId === 'r-miss')?.status).toBe('unknown');
  });
});
