import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE_GROUPS } from '../src/shared/defaults';
import {
  classifyConnectionTransport,
  compileRouteGroupRules,
  matchChainsToRouteGroup,
} from '../src/shared/route-matcher';
import type { RouteGroupConfig } from '../src/shared/types';

const SAMPLE_GROUPS: RouteGroupConfig[] = [
  {
    id: 'group-ai',
    name: 'AI',
    matchMode: 'exact',
    pattern: 'AI',
    shape: 'circle',
    color: '#3b82f6',
    priority: 1,
    enabled: true,
  },
  {
    id: 'group-proxy',
    name: 'PROXY',
    matchMode: 'regex',
    pattern: '^(PROXY|节点选择)$',
    shape: 'triangle',
    color: '#a855f7',
    priority: 2,
    enabled: true,
  },
  {
    id: 'group-direct',
    name: 'DIRECT',
    matchMode: 'exact',
    pattern: 'DIRECT',
    shape: 'square',
    color: '#22c55e',
    priority: 3,
    enabled: true,
  },
];

describe('route-matcher', () => {
  it('keeps default route groups empty so users import or define their own', () => {
    expect(DEFAULT_ROUTE_GROUPS).toEqual([]);
  });

  it('matches group by chains only and does not treat underlying node as extra group', () => {
    const compiled = compileRouteGroupRules(SAMPLE_GROUPS);
    const result = matchChainsToRouteGroup(['东京节点-01', 'AI'], compiled);

    expect(result.matchedGroup?.name).toBe('AI');
    expect(result.matchedChainMember).toBe('AI');
    expect(result.transportKind).toBe('PROXY');
  });

  it('respects priority order when multiple groups appear in one chain', () => {
    const compiled = compileRouteGroupRules(SAMPLE_GROUPS);
    // AI priority=1, PROXY priority=2
    const result = matchChainsToRouteGroup(['东京节点', 'AI', '节点选择'], compiled);

    expect(result.matchedGroup?.name).toBe('AI');
  });

  it('supports exact, contains, and regex matching modes', () => {
    const groups: RouteGroupConfig[] = [
      {
        id: 'g1',
        name: 'ExactGroup',
        matchMode: 'exact',
        pattern: 'WorkVPN',
        shape: 'square',
        color: '#111111',
        priority: 1,
        enabled: true,
      },
      {
        id: 'g2',
        name: 'ContainsGroup',
        matchMode: 'contains',
        pattern: 'tailscale',
        shape: 'circle',
        color: '#222222',
        priority: 2,
        enabled: true,
      },
      {
        id: 'g3',
        name: 'RegexGroup',
        matchMode: 'regex',
        pattern: '^(HK|JP)-Node-\\d+$',
        shape: 'triangle',
        color: '#333333',
        priority: 3,
        enabled: true,
      },
    ];
    const compiled = compileRouteGroupRules(groups);

    expect(matchChainsToRouteGroup(['WorkVPN'], compiled).matchedGroup?.id).toBe('g1');
    expect(matchChainsToRouteGroup(['WorkVPN-Extra'], compiled).matchedGroup).toBeNull();
    expect(matchChainsToRouteGroup(['My-Tailscale-Exit'], compiled).matchedGroup?.id).toBe('g2');
    expect(matchChainsToRouteGroup(['JP-Node-12'], compiled).matchedGroup?.id).toBe('g3');
  });

  it('handles invalid regex gracefully without throwing', () => {
    const groups: RouteGroupConfig[] = [
      {
        id: 'bad',
        name: 'BrokenRegex',
        matchMode: 'regex',
        pattern: '[unclosed(',
        shape: 'circle',
        color: '#ff0000',
        priority: 1,
        enabled: true,
      },
    ];
    const compiled = compileRouteGroupRules(groups);
    expect(compiled[0]?.compileError).toBeTruthy();
    expect(matchChainsToRouteGroup(['anything'], compiled).matchedGroup).toBeNull();
  });

  it('classifies DIRECT, REJECT, PROXY, and UNKNOWN transports accurately', () => {
    expect(classifyConnectionTransport(['DIRECT'])).toBe('DIRECT');
    expect(classifyConnectionTransport(['REJECT'])).toBe('REJECT');
    expect(classifyConnectionTransport(['香港节点', 'PROXY'])).toBe('PROXY');
    expect(classifyConnectionTransport([])).toBe('UNKNOWN');
  });
});
