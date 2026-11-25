import {
  MAX_FAVICON_BADGES,
  PRESET_COLORS,
  sanitizeExtensionConfig,
} from '../shared/defaults';
import { renderFaviconWithBadges } from '../shared/favicon-composer';
import { validateRegexPattern } from '../shared/route-matcher';
import { loadExtensionConfig, saveExtensionConfig } from '../shared/storage';
import type {
  BadgeDescriptor,
  BadgeShape,
  ControllerStatusSnapshot,
  ControllerTestResult,
  ExtensionConfig,
  FetchProxyGroupsResult,
  MatchMode,
  MihomoProxyGroupInfo,
  RouteGroupConfig,
  RuntimeMessage,
} from '../shared/types';

const CORNER_LABELS = ['右下角', '左下角', '左上角', '右上角'];

let draftConfig: ExtensionConfig;

const ctrlHostEl = document.getElementById('ctrlHost') as HTMLInputElement;
const ctrlPortEl = document.getElementById('ctrlPort') as HTMLInputElement;
const ctrlSecretEl = document.getElementById('ctrlSecret') as HTMLInputElement;
const ctrlTlsEl = document.getElementById('ctrlTls') as HTMLInputElement;
const controllerStatusBadgeEl = document.getElementById('controllerStatusBadge') as HTMLDivElement;
const controllerDetailTextEl = document.getElementById('controllerDetailText') as HTMLDivElement;
const testConnBtnEl = document.getElementById('testConnBtn') as HTMLButtonElement;
const reconnectBtnEl = document.getElementById('reconnectBtn') as HTMLButtonElement;
const testResultBoxEl = document.getElementById('testResultBox') as HTMLDivElement;

const groupsTableBodyEl = document.getElementById('groupsTableBody') as HTMLTableSectionElement;
const groupsEmptyStateEl = document.getElementById('groupsEmptyState') as HTMLDivElement;
const importGroupsBtnEl = document.getElementById('importGroupsBtn') as HTMLButtonElement;
const importGroupsPanelEl = document.getElementById('importGroupsPanel') as HTMLDivElement;
const importPanelSummaryEl = document.getElementById('importPanelSummary') as HTMLSpanElement;
const importGroupsListEl = document.getElementById('importGroupsList') as HTMLDivElement;
const importSelectAllNewBtnEl = document.getElementById('importSelectAllNewBtn') as HTMLButtonElement;
const importApplyBtnEl = document.getElementById('importApplyBtn') as HTMLButtonElement;
const importCloseBtnEl = document.getElementById('importCloseBtn') as HTMLButtonElement;
const addGroupBtnEl = document.getElementById('addGroupBtn') as HTMLButtonElement;
const clearGroupsBtnEl = document.getElementById('clearGroupsBtn') as HTMLButtonElement;
const regexErrorBannerEl = document.getElementById('regexErrorBanner') as HTMLDivElement;

let fetchedProxyGroups: MihomoProxyGroupInfo[] = [];
const selectedImportNames = new Set<string>();

const favEnabledEl = document.getElementById('favEnabled') as HTMLInputElement;
const favSizeEl = document.getElementById('favSize') as HTMLInputElement;
const favSizeValEl = document.getElementById('favSizeVal') as HTMLElement;
const favStrokeEl = document.getElementById('favStroke') as HTMLInputElement;
const favStrokeValEl = document.getElementById('favStrokeVal') as HTMLElement;
const favStrokeColorEl = document.getElementById('favStrokeColor') as HTMLInputElement;
const favRetentionSecEl = document.getElementById('favRetentionSec') as HTMLInputElement;

const previewCanvas64 = document.getElementById('previewCanvas64') as HTMLCanvasElement;
const previewCanvas32 = document.getElementById('previewCanvas32') as HTMLCanvasElement;
const previewCanvas16 = document.getElementById('previewCanvas16') as HTMLCanvasElement;
const previewLegendEl = document.getElementById('previewLegend') as HTMLDivElement;

const saveAllBtnEl = document.getElementById('saveAllBtn') as HTMLButtonElement;
const saveToastEl = document.getElementById('saveToast') as HTMLSpanElement;

function formatStatusText(status: ControllerStatusSnapshot): string {
  switch (status.state) {
    case 'connected_ws':
      return 'WebSocket 已连接';
    case 'connected_http':
      return 'HTTP 备用轮询中';
    case 'connecting':
      return '正在连接...';
    case 'error':
      return '连接异常';
    default:
      return '未连接';
  }
}

async function refreshControllerStatus(): Promise<void> {
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'GET_CONTROLLER_STATUS',
    } satisfies RuntimeMessage)) as { status?: ControllerStatusSnapshot } | undefined;

    const status = res?.status;
    if (!status) return;

    controllerStatusBadgeEl.className = `status-pill status-${status.state}`;
    controllerStatusBadgeEl.textContent = formatStatusText(status);

    const parts: string[] = [`端点: ${status.endpoint}`];
    if (status.version) parts.push(`Mihomo 版本: ${status.version}`);
    parts.push(`活跃连接: ${status.activeConnectionsCount}`);
    if (status.lastError) parts.push(`最近信息: ${status.lastError}`);
    controllerDetailTextEl.textContent = parts.join(' | ');
  } catch {
    controllerStatusBadgeEl.className = 'status-pill status-error';
    controllerStatusBadgeEl.textContent = '无法读取后台状态';
  }
}

function readControllerInputs(): void {
  draftConfig.controller = {
    host: ctrlHostEl.value.trim() || '127.0.0.1',
    port: Number(ctrlPortEl.value) || 9090,
    secret: ctrlSecretEl.value,
    useTls: ctrlTlsEl.checked,
  };
}

function readFaviconInputs(): void {
  draftConfig.favicon = {
    enabled: favEnabledEl.checked,
    markerSize: Number(favSizeEl.value) || 20,
    strokeWidth: Number(favStrokeEl.value) || 0,
    strokeColor: favStrokeColorEl.value || '#ffffff',
    retentionMs: Math.max(2, Math.min(120, Number(favRetentionSecEl.value) || 15)) * 1000,
  };
  favSizeValEl.textContent = String(draftConfig.favicon.markerSize);
  favStrokeValEl.textContent = String(draftConfig.favicon.strokeWidth);
}

function normalizePriorities(): void {
  draftConfig.routeGroups = draftConfig.routeGroups.map((g, idx) => ({
    ...g,
    priority: idx + 1,
  }));
}

function validateAllRegexes(): void {
  const errors: string[] = [];
  for (const g of draftConfig.routeGroups) {
    if (g.enabled && g.matchMode === 'regex') {
      const check = validateRegexPattern(g.pattern);
      if (!check.valid) {
        errors.push(`分流组「${g.name}」正则无效: ${check.error ?? '语法错误'}`);
      }
    }
  }
  if (errors.length > 0) {
    regexErrorBannerEl.hidden = false;
    regexErrorBannerEl.textContent = errors.join('；');
  } else {
    regexErrorBannerEl.hidden = true;
    regexErrorBannerEl.textContent = '';
  }
}

function renderFaviconPreviews(): void {
  const activeBadges: BadgeDescriptor[] = draftConfig.routeGroups
    .filter((g) => g.enabled)
    .slice(0, MAX_FAVICON_BADGES)
    .map((g) => ({
      groupId: g.id,
      name: g.name,
      shape: g.shape,
      color: g.color,
      priority: g.priority,
    }));

  const canvases = [previewCanvas64, previewCanvas32, previewCanvas16];
  for (const canvas of canvases) {
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    renderFaviconWithBadges(ctx, canvas.width, null, activeBadges, draftConfig.favicon, true);
  }

  previewLegendEl.textContent = '';
  if (!draftConfig.favicon.enabled) {
    previewLegendEl.textContent = '当前已禁用 Favicon 叠加，仅展示原始图标。';
    return;
  }
  if (activeBadges.length === 0) {
    previewLegendEl.textContent = '暂无已启用的分流组。';
    return;
  }
  activeBadges.forEach((badge, idx) => {
    const row = document.createElement('div');
    row.textContent = `${CORNER_LABELS[idx]}: ${badge.name} (${badge.shape}, ${badge.color})`;
    previewLegendEl.appendChild(row);
  });
}

function createBadgePreviewSvg(
  shape: BadgeShape,
  fillColor: string,
  strokeColor = '#ffffff',
  strokeWidth = 1.6,
  size = 24,
): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));

  let node: SVGElement;
  if (shape === 'circle') {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', '12');
    c.setAttribute('cy', '12');
    c.setAttribute('r', '7.5');
    node = c;
  } else if (shape === 'square') {
    const r = document.createElementNS(ns, 'rect');
    r.setAttribute('x', '4.5');
    r.setAttribute('y', '4.5');
    r.setAttribute('width', '15');
    r.setAttribute('height', '15');
    r.setAttribute('rx', '2.2');
    node = r;
  } else {
    const p = document.createElementNS(ns, 'polygon');
    p.setAttribute('points', '12,4 20,19 4,19');
    node = p;
  }

  node.setAttribute('fill', fillColor);
  if (strokeWidth > 0) {
    node.setAttribute('stroke', strokeColor);
    node.setAttribute('stroke-width', String(strokeWidth));
    node.setAttribute('stroke-linejoin', 'round');
  }
  svg.appendChild(node);
  return svg;
}

function updateRowPreview(previewContainer: HTMLElement, group: RouteGroupConfig): void {
  previewContainer.textContent = '';
  const strokeW = Math.min(2.5, Math.max(0, draftConfig.favicon.strokeWidth * 0.65));
  previewContainer.appendChild(
    createBadgePreviewSvg(group.shape, group.color, draftConfig.favicon.strokeColor, strokeW, 24),
  );
}

function refreshAllRowPreviews(): void {
  const boxes = groupsTableBodyEl.querySelectorAll<HTMLElement>('.badge-preview-box');
  boxes.forEach((box, idx) => {
    const group = draftConfig.routeGroups[idx];
    if (group) {
      updateRowPreview(box, group);
    }
  });
}

function renderGroupsTable(): void {
  normalizePriorities();
  groupsTableBodyEl.textContent = '';
  groupsEmptyStateEl.hidden = draftConfig.routeGroups.length > 0;

  draftConfig.routeGroups.forEach((group, index) => {
    const tr = document.createElement('tr');

    // 启用
    const tdEnabled = document.createElement('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = group.enabled;
    chk.addEventListener('change', () => {
      group.enabled = chk.checked;
      validateAllRegexes();
      renderFaviconPreviews();
    });
    tdEnabled.appendChild(chk);
    tr.appendChild(tdEnabled);

    // 优先级
    const tdPriority = document.createElement('td');
    const pWrap = document.createElement('div');
    pWrap.className = 'priority-cell';

    const pNum = document.createElement('span');
    pNum.className = 'priority-num';
    pNum.textContent = String(index + 1);

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'btn btn-ghost btn-icon';
    upBtn.textContent = '↑';
    upBtn.title = '上移优先级';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => {
      if (index === 0) return;
      const prev = draftConfig.routeGroups[index - 1]!;
      draftConfig.routeGroups[index - 1] = group;
      draftConfig.routeGroups[index] = prev;
      renderGroupsTable();
      renderFaviconPreviews();
    });

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'btn btn-ghost btn-icon';
    downBtn.textContent = '↓';
    downBtn.title = '下移优先级';
    downBtn.disabled = index === draftConfig.routeGroups.length - 1;
    downBtn.addEventListener('click', () => {
      if (index >= draftConfig.routeGroups.length - 1) return;
      const next = draftConfig.routeGroups[index + 1]!;
      draftConfig.routeGroups[index + 1] = group;
      draftConfig.routeGroups[index] = next;
      renderGroupsTable();
      renderFaviconPreviews();
    });

    pWrap.append(pNum, upBtn, downBtn);
    tdPriority.appendChild(pWrap);
    tr.appendChild(tdPriority);

    // 名称
    const tdName = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = group.name;
    nameInput.addEventListener('input', () => {
      group.name = nameInput.value;
      renderFaviconPreviews();
    });
    tdName.appendChild(nameInput);
    tr.appendChild(tdName);

    // 匹配模式
    const tdMode = document.createElement('td');
    const modeSelect = document.createElement('select');
    const modes: Array<[MatchMode, string]> = [
      ['exact', '精确匹配'],
      ['contains', '包含匹配'],
      ['regex', '正则匹配'],
    ];
    for (const [val, label] of modes) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      modeSelect.appendChild(opt);
    }
    modeSelect.value = group.matchMode;
    modeSelect.addEventListener('change', () => {
      group.matchMode = modeSelect.value as MatchMode;
      updatePatternValidityStyle(patternInput, group);
      validateAllRegexes();
    });
    tdMode.appendChild(modeSelect);
    tr.appendChild(tdMode);

    // 匹配内容
    const tdPattern = document.createElement('td');
    const patternInput = document.createElement('input');
    patternInput.type = 'text';
    patternInput.value = group.pattern;
    patternInput.placeholder = '策略组名称或表达式';
    updatePatternValidityStyle(patternInput, group);
    patternInput.addEventListener('input', () => {
      group.pattern = patternInput.value;
      updatePatternValidityStyle(patternInput, group);
      validateAllRegexes();
    });
    tdPattern.appendChild(patternInput);
    tr.appendChild(tdPattern);

    // 实时预览容器（提前创建供形状/预置颜色按钮实时刷新）
    const tdPreview = document.createElement('td');
    const previewBox = document.createElement('div');
    previewBox.className = 'badge-preview-box';
    previewBox.title = '当前形状与颜色预览';
    updateRowPreview(previewBox, group);
    tdPreview.appendChild(previewBox);

    // 形状（图形按钮三选一）
    const tdShape = document.createElement('td');
    const shapePicker = document.createElement('div');
    shapePicker.className = 'shape-picker';
    const shapes: Array<[BadgeShape, string]> = [
      ['circle', '圆形'],
      ['triangle', '三角形'],
      ['square', '方形'],
    ];
    const shapeButtons: HTMLButtonElement[] = [];
    for (const [val, label] of shapes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `shape-btn${group.shape === val ? ' active' : ''}`;
      btn.title = label;
      btn.appendChild(createBadgePreviewSvg(val, 'currentColor', 'none', 0, 16));
      btn.addEventListener('click', () => {
        group.shape = val;
        for (const b of shapeButtons) b.classList.remove('active');
        btn.classList.add('active');
        updateRowPreview(previewBox, group);
        renderFaviconPreviews();
      });
      shapeButtons.push(btn);
      shapePicker.appendChild(btn);
    }
    tdShape.appendChild(shapePicker);
    tr.appendChild(tdShape);

    // 预置颜色（高对比预置色板）
    const tdColor = document.createElement('td');
    const swatchGrid = document.createElement('div');
    swatchGrid.className = 'swatch-grid';
    const swatchButtons: HTMLButtonElement[] = [];
    for (const preset of PRESET_COLORS) {
      const sw = document.createElement('button');
      sw.type = 'button';
      const isSelected = group.color.toLowerCase() === preset.hex.toLowerCase();
      sw.className = `swatch-btn${isSelected ? ' active' : ''}`;
      sw.style.backgroundColor = preset.hex;
      sw.title = `${preset.label} (${preset.hex})`;
      sw.addEventListener('click', () => {
        group.color = preset.hex;
        for (const b of swatchButtons) b.classList.remove('active');
        sw.classList.add('active');
        updateRowPreview(previewBox, group);
        renderFaviconPreviews();
      });
      swatchButtons.push(sw);
      swatchGrid.appendChild(sw);
    }
    tdColor.appendChild(swatchGrid);
    tr.appendChild(tdColor);

    // 预览列
    tr.appendChild(tdPreview);

    // 删除
    const tdAction = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger btn-icon';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => {
      draftConfig.routeGroups.splice(index, 1);
      renderGroupsTable();
      validateAllRegexes();
      renderFaviconPreviews();
    });
    tdAction.appendChild(delBtn);
    tr.appendChild(tdAction);

    groupsTableBodyEl.appendChild(tr);
  });

  validateAllRegexes();
}

function updatePatternValidityStyle(input: HTMLInputElement, group: RouteGroupConfig): void {
  if (group.matchMode === 'regex' && !validateRegexPattern(group.pattern).valid) {
    input.classList.add('input-invalid');
  } else {
    input.classList.remove('input-invalid');
  }
}

function populateFormFromConfig(): void {
  ctrlHostEl.value = draftConfig.controller.host;
  ctrlPortEl.value = String(draftConfig.controller.port);
  ctrlSecretEl.value = draftConfig.controller.secret;
  ctrlTlsEl.checked = draftConfig.controller.useTls;

  favEnabledEl.checked = draftConfig.favicon.enabled;
  favSizeEl.value = String(draftConfig.favicon.markerSize);
  favSizeValEl.textContent = String(draftConfig.favicon.markerSize);
  favStrokeEl.value = String(draftConfig.favicon.strokeWidth);
  favStrokeValEl.textContent = String(draftConfig.favicon.strokeWidth);
  favStrokeColorEl.value = draftConfig.favicon.strokeColor;
  favRetentionSecEl.value = String(Math.round(draftConfig.favicon.retentionMs / 1000));

  renderGroupsTable();
  renderFaviconPreviews();
}

function showToast(text: string): void {
  saveToastEl.textContent = text;
  saveToastEl.hidden = false;
  setTimeout(() => {
    saveToastEl.hidden = true;
  }, 2200);
}

async function handleSaveAll(): Promise<void> {
  readControllerInputs();
  readFaviconInputs();
  draftConfig = sanitizeExtensionConfig(draftConfig);
  draftConfig = await saveExtensionConfig(draftConfig);
  populateFormFromConfig();
  showToast('设置已保存并生效');
  setTimeout(() => void refreshControllerStatus(), 400);
}

async function handleTestConnection(): Promise<void> {
  readControllerInputs();
  testResultBoxEl.className = 'test-result';
  testResultBoxEl.textContent = '正在测试连接...';
  testConnBtnEl.disabled = true;

  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'TEST_CONTROLLER_CONNECTION',
      controller: draftConfig.controller,
    } satisfies RuntimeMessage)) as { result?: ControllerTestResult } | undefined;

    const result = res?.result;
    if (!result) {
      testResultBoxEl.className = 'test-result err';
      testResultBoxEl.textContent = '未收到测试响应';
      return;
    }

    if (result.ok) {
      testResultBoxEl.className = 'test-result ok';
      testResultBoxEl.textContent = `连接成功 · 版本 ${result.version ?? 'unknown'} · 活跃连接 ${
        result.activeConnections ?? 0
      } · 延迟 ${result.latencyMs}ms`;
    } else {
      testResultBoxEl.className = 'test-result err';
      testResultBoxEl.textContent = `连接失败 (${result.latencyMs}ms): ${result.error ?? '未知错误'}`;
    }
  } catch (err) {
    testResultBoxEl.className = 'test-result err';
    testResultBoxEl.textContent = err instanceof Error ? err.message : '测试失败';
  } finally {
    testConnBtnEl.disabled = false;
  }
}

const IMPORT_SHAPES: readonly BadgeShape[] = ['circle', 'triangle', 'square'];

function guessAppearanceForGroup(name: string, index: number): { shape: BadgeShape; color: string } {
  const upper = name.toUpperCase();
  if (upper === 'DIRECT' || upper.includes('直连') || upper.includes('国内')) {
    return { shape: 'square', color: '#22c55e' };
  }
  if (upper.includes('广告') || upper.includes('REJECT') || upper.includes('拦截')) {
    return { shape: 'circle', color: '#ef4444' };
  }
  if (upper === 'AI' || upper.includes('AI') || upper.includes('OPENAI') || upper.includes('GPT')) {
    return { shape: 'circle', color: '#3b82f6' };
  }
  if (upper.includes('TAILSCALE') || upper.includes('私有')) {
    return { shape: 'circle', color: '#f97316' };
  }
  if (upper === 'PROXY' || upper.includes('节点选择')) {
    return { shape: 'triangle', color: '#a855f7' };
  }
  return {
    shape: IMPORT_SHAPES[index % IMPORT_SHAPES.length]!,
    color: PRESET_COLORS[index % PRESET_COLORS.length]!.hex,
  };
}

function isGroupAlreadyConfigured(name: string): boolean {
  const target = name.trim();
  return draftConfig.routeGroups.some(
    (g) => g.name.trim() === target || (g.matchMode === 'exact' && g.pattern.trim() === target),
  );
}

function renderImportPanelList(): void {
  importGroupsListEl.textContent = '';

  if (fetchedProxyGroups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted-note';
    empty.textContent = '未获取到任何策略组。';
    importGroupsListEl.appendChild(empty);
    return;
  }

  for (const pg of fetchedProxyGroups) {
    const exists = isGroupAlreadyConfigured(pg.name);
    const label = document.createElement('label');
    label.className = `import-item${exists ? ' exists' : ''}`;

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = selectedImportNames.has(pg.name);
    chk.addEventListener('change', () => {
      if (chk.checked) {
        selectedImportNames.add(pg.name);
      } else {
        selectedImportNames.delete(pg.name);
      }
    });

    const meta = document.createElement('div');
    meta.className = 'import-item-meta';

    const title = document.createElement('div');
    title.className = 'import-item-title';
    title.textContent = pg.name;

    if (exists) {
      const tag = document.createElement('span');
      tag.className = 'import-tag';
      tag.textContent = '已配置';
      title.appendChild(tag);
    }
    if (pg.isGlobal) {
      const tag = document.createElement('span');
      tag.className = 'import-tag warn';
      tag.textContent = '全局组(慎选)';
      title.appendChild(tag);
    }

    const sub = document.createElement('div');
    sub.className = 'import-item-sub';
    const nowText = pg.now ? ` · 当前: ${pg.now}` : '';
    const countText = pg.memberCount > 0 ? ` · ${pg.memberCount} 项` : '';
    sub.textContent = `${pg.type}${countText}${nowText}`;

    meta.append(title, sub);
    label.append(chk, meta);
    importGroupsListEl.appendChild(label);
  }
}

async function handleFetchProxyGroups(): Promise<void> {
  readControllerInputs();
  importGroupsPanelEl.hidden = false;
  importPanelSummaryEl.className = 'import-summary';
  importPanelSummaryEl.textContent = '正在从 Mihomo GET /proxies 拉取策略组...';
  importGroupsListEl.textContent = '';
  importGroupsBtnEl.disabled = true;

  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'FETCH_PROXY_GROUPS',
      controller: draftConfig.controller,
    } satisfies RuntimeMessage)) as { result?: FetchProxyGroupsResult } | undefined;

    const result = res?.result;
    if (!result || !result.ok) {
      fetchedProxyGroups = [];
      selectedImportNames.clear();
      importPanelSummaryEl.className = 'import-summary err';
      importPanelSummaryEl.textContent = `拉取失败: ${result?.error ?? '未收到响应'}`;
      return;
    }

    fetchedProxyGroups = result.groups;
    selectedImportNames.clear();
    for (const pg of fetchedProxyGroups) {
      if (!pg.isGlobal && !isGroupAlreadyConfigured(pg.name)) {
        selectedImportNames.add(pg.name);
      }
    }

    importPanelSummaryEl.className = 'import-summary';
    importPanelSummaryEl.textContent = `已从 Mihomo 获取 ${fetchedProxyGroups.length} 个策略组（默认已勾选未配置项，点击下方“导入所选策略组”加入列表）：`;
    renderImportPanelList();
  } catch (err) {
    importPanelSummaryEl.className = 'import-summary err';
    importPanelSummaryEl.textContent = err instanceof Error ? err.message : '拉取异常';
  } finally {
    importGroupsBtnEl.disabled = false;
  }
}

function handleApplyImportedGroups(): void {
  if (selectedImportNames.size === 0) {
    showToast('未勾选任何策略组');
    return;
  }

  let addedCount = 0;
  for (const pg of fetchedProxyGroups) {
    if (!selectedImportNames.has(pg.name)) continue;
    if (isGroupAlreadyConfigured(pg.name)) continue;

    const nextIdx = draftConfig.routeGroups.length + 1;
    const style = guessAppearanceForGroup(pg.name, nextIdx - 1);
    draftConfig.routeGroups.push({
      id: `group-import-${Date.now()}-${nextIdx}`,
      name: pg.name,
      matchMode: 'exact',
      pattern: pg.name,
      shape: style.shape,
      color: style.color,
      priority: nextIdx,
      enabled: true,
    });
    addedCount += 1;
  }

  renderGroupsTable();
  renderFaviconPreviews();
  renderImportPanelList();
  showToast(addedCount > 0 ? `已导入 ${addedCount} 个策略组，请点击“保存全部设置”` : '所选策略组均已存在');
}

async function init(): Promise<void> {
  draftConfig = await loadExtensionConfig();
  populateFormFromConfig();
  void refreshControllerStatus();
  setInterval(() => void refreshControllerStatus(), 3000);

  saveAllBtnEl.addEventListener('click', () => void handleSaveAll());
  testConnBtnEl.addEventListener('click', () => void handleTestConnection());
  reconnectBtnEl.addEventListener('click', () => {
    void chrome.runtime
      .sendMessage({ type: 'RECONNECT_CONTROLLER' } satisfies RuntimeMessage)
      .then(() => setTimeout(() => void refreshControllerStatus(), 500));
  });

  importGroupsBtnEl.addEventListener('click', () => void handleFetchProxyGroups());
  importSelectAllNewBtnEl.addEventListener('click', () => {
    selectedImportNames.clear();
    for (const pg of fetchedProxyGroups) {
      if (!pg.isGlobal && !isGroupAlreadyConfigured(pg.name)) {
        selectedImportNames.add(pg.name);
      }
    }
    renderImportPanelList();
  });
  importApplyBtnEl.addEventListener('click', handleApplyImportedGroups);
  importCloseBtnEl.addEventListener('click', () => {
    importGroupsPanelEl.hidden = true;
  });

  addGroupBtnEl.addEventListener('click', () => {
    const nextIdx = draftConfig.routeGroups.length + 1;
    const presetColor = PRESET_COLORS[(nextIdx - 1) % PRESET_COLORS.length]!.hex;
    const presetShape = IMPORT_SHAPES[(nextIdx - 1) % IMPORT_SHAPES.length]!;
    draftConfig.routeGroups.push({
      id: `group-${Date.now()}-${nextIdx}`,
      name: `自定义组 ${nextIdx}`,
      matchMode: 'exact',
      pattern: '',
      shape: presetShape,
      color: presetColor,
      priority: nextIdx,
      enabled: true,
    });
    renderGroupsTable();
    renderFaviconPreviews();
  });

  clearGroupsBtnEl.addEventListener('click', () => {
    draftConfig.routeGroups = [];
    renderGroupsTable();
    renderFaviconPreviews();
    renderImportPanelList();
  });

  for (const el of [favEnabledEl, favSizeEl, favStrokeEl, favStrokeColorEl, favRetentionSecEl]) {
    el.addEventListener('input', () => {
      readFaviconInputs();
      refreshAllRowPreviews();
      renderFaviconPreviews();
    });
  }
}

void init();
