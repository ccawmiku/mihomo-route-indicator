import type { ConnectionTransportKind, RouteGroupConfig } from './types';

export interface CompiledRouteGroupRule {
  group: RouteGroupConfig;
  regex: RegExp | null;
  compileError: string | null;
}

export interface RouteMatchResult {
  matchedGroup: RouteGroupConfig | null;
  matchedChainMember: string | null;
  transportKind: ConnectionTransportKind;
}

/**
 * 预编译用户配置的分流组规则，按优先级从高到低排序。
 */
export function compileRouteGroupRules(groups: RouteGroupConfig[]): CompiledRouteGroupRule[] {
  const sorted = [...groups]
    .filter((g) => g.enabled && g.pattern.trim().length > 0)
    .sort((a, b) => a.priority - b.priority);

  return sorted.map((group) => {
    if (group.matchMode !== 'regex') {
      return { group, regex: null, compileError: null };
    }
    try {
      const regex = new RegExp(group.pattern);
      return { group, regex, compileError: null };
    } catch (err) {
      return {
        group,
        regex: null,
        compileError: err instanceof Error ? err.message : 'Invalid regular expression',
      };
    }
  });
}

export function validateRegexPattern(pattern: string): { valid: boolean; error?: string } {
  try {
    new RegExp(pattern);
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : '正则表达式语法错误',
    };
  }
}

function matchesChainMember(member: string, compiled: CompiledRouteGroupRule): boolean {
  const trimmedMember = member.trim();
  const pattern = compiled.group.pattern.trim();
  if (!trimmedMember || !pattern) return false;

  switch (compiled.group.matchMode) {
    case 'exact':
      return trimmedMember === pattern;
    case 'contains':
      return trimmedMember.toLowerCase().includes(pattern.toLowerCase());
    case 'regex':
      if (!compiled.regex) return false;
      compiled.regex.lastIndex = 0;
      return compiled.regex.test(trimmedMember);
    default:
      return false;
  }
}

/**
 * 依据 Mihomo 实际代理链路 chains 识别底层传输分类（不依赖 rule/rulePayload）。
 */
export function classifyConnectionTransport(chains: readonly string[]): ConnectionTransportKind {
  if (!Array.isArray(chains) || chains.length === 0) {
    return 'UNKNOWN';
  }
  const normalized = chains.map((item) => item.trim().toUpperCase()).filter(Boolean);
  if (normalized.length === 0) {
    return 'UNKNOWN';
  }
  if (normalized.some((item) => item === 'REJECT' || item === 'REJECT-DROP')) {
    return 'REJECT';
  }
  if (normalized.every((item) => item === 'DIRECT')) {
    return 'DIRECT';
  }
  return 'PROXY';
}

/**
 * 基于 Mihomo 的 chains 识别单个连接所属的唯一分流组。
 * 注意：仅依据 chains 识别，不直接将 rule / rulePayload 当作分流组；
 * 一旦最高优先级的规则命中 chains 中任一策略组/节点，即确定该连接的归属，避免把底层节点拆成多个独立分流组。
 */
export function matchChainsToRouteGroup(
  chains: readonly string[],
  compiledRules: readonly CompiledRouteGroupRule[],
): RouteMatchResult {
  const transportKind = classifyConnectionTransport(chains);
  if (!Array.isArray(chains) || chains.length === 0) {
    return { matchedGroup: null, matchedChainMember: null, transportKind };
  }

  for (const compiled of compiledRules) {
    for (const member of chains) {
      if (matchesChainMember(member, compiled)) {
        return {
          matchedGroup: compiled.group,
          matchedChainMember: member,
          transportKind,
        };
      }
    }
  }

  return {
    matchedGroup: null,
    matchedChainMember: null,
    transportKind,
  };
}
