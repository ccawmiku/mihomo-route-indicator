# Mihomo Route Indicator

Chrome / Chromium Manifest V3 浏览器扩展。联动本地或远端 Mihomo (Clash Meta) External Controller，识别各标签页请求实际经过的分流策略组，并将自定义形状与颜色的角标叠加显示在标签页原有 Favicon 上。

## 核心特性

- **保留原 Favicon 并精准叠加**：通过扩展后台拉取跨域图标规避页面 Canvas CORS 限制，在 64×64 画布上按 **右下角 → 左下角 → 左上角 → 右上角** 顺时针顺序叠加最多 4 个分流标记，并支持页面动态更换 Favicon 而不重复套娃叠加。
- **独立可配分流组样式与 Clash 一键导入**：支持从 Mihomo `GET /proxies` 自动拉取策略组（过滤底层物理节点、标注 `GLOBAL` 全局组）并一键勾选导入；支持 `circle`（圆形）、`triangle`（三角形）、`square`（方形），可自由配置颜色、描边、大小、启用开关及优先级。
- **基于 `chains` 的真实分流识别**：优先通过 WebSocket `/connections?interval=1000`（并在断开时自动降级为 HTTP `GET /connections` 轮询）获取活跃连接，严格依据代理链 `chains` 匹配用户规则（支持精确、包含、正则），不混淆 `rule` 规则名称与代理策略组，且一条连接只归属一个最匹配分流组，避免底层节点被拆成多个独立角标。
- **严谨的请求与连接关联**：结合 `chrome.webRequest` 监听、域名规范化、HTTP/2 & HTTP/3 复用连接活跃状态、短连接关闭宽限、WS 推送延迟待定重试队列以及目标 IP 辅助筛选；无法可靠归属或存在多路由歧义时明确标记为未知/歧义，绝不猜测。
- **防闪烁状态管理**：为分流组保留短期活跃窗口，避免短连接频繁开闭导致标签页图标闪烁；页面整体状态分类为 `DIRECT`、`PROXY`、`MIXED`、`UNKNOWN`。
- **完整设置页与 Popup**：设置页支持 Controller 地址/端口/Secret 测试与分流组增删改排及实时画布预览；Popup 展示当前标签页 Favicon 叠加预览、分流组请求统计、命中规则、代理链与最近连接详情。

## 目录结构

```text
mihomo-route-indicator/
├── public/
│   ├── manifest.json          # MV3 扩展清单
│   ├── options.html           # 独立设置页
│   ├── popup.html             # 扩展弹窗
│   └── icons/                 # 扩展自身图标 (16/48/128)
├── scripts/
│   ├── build.mjs              # esbuild 打包脚本 -> dist/
│   └── generate-icons.mjs     # 生成默认 PNG 图标
├── src/
│   ├── shared/
│   │   ├── types.ts           # 全量类型与消息协议
│   │   ├── defaults.ts        # 默认分流组与配置清洗校验
│   │   ├── storage.ts         # chrome.storage.local 读写监听
│   │   ├── url-utils.ts       # URL/hostname 规范化与地址构建
│   │   ├── route-matcher.ts   # 分流组匹配与传输分类引擎
│   │   └── favicon-composer.ts# Canvas Favicon 叠加绘制模块
│   ├── background/
│   │   ├── mihomo-client.ts   # WS 优先 + HTTP 回退客户端与连通测试
│   │   ├── correlator.ts      # webRequest 与 Mihomo 连接关联引擎
│   │   ├── tab-state.ts       # 标签页分流状态与短期保留管理
│   │   ├── favicon-fetcher.ts # 后台跨域 Favicon 拉取与 LRU 缓存
│   │   └── index.ts           # Service Worker 入口与生命周期管理
│   ├── content/
│   │   └── index.ts           # 页面 Favicon 监控与无重复叠加更新
│   ├── options/
│   │   ├── options.css
│   │   └── options.ts         # 设置页交互逻辑与实时预览
│   └── popup/
│       ├── popup.css
│       └── popup.ts           # Popup 状态与连接详情展示
└── tests/                     # Vitest 单元测试
```

## 构建与加载

1. 安装依赖并执行类型检查、单元测试与构建：

   ```bash
   npm install
   npm run typecheck
   npm test
   npm run build
   ```

2. 在 Chrome / Chromium / Edge 中加载扩展：
   - 打开 `chrome://extensions/`
   - 开启右上角 **开发者模式**
   - 点击 **加载已解压的扩展程序**，选择项目下的 `dist/` 目录

3. 配置 Mihomo：
   - 确保 Mihomo 配置文件开启了 External Controller（例如 `external-controller: 127.0.0.1:9090`，如有需要可配置 `secret`）。
   - 打开扩展设置页面，填写地址、端口与 Secret，点击 **测试连接** 确认连通后保存。

## 已知技术限制与设计边界

1. **无浏览器原生 `tabId` 映射**：Mihomo External Controller 仅掌握网络层连接信息（域名、SNI、目标 IP、来源进程），无法直接获得 Chrome 内部的 `tabId`。当多个标签页并发访问同一域名且该域名在 Mihomo 中被不同连接分配到不同代理链时，扩展无法凭空判断某条浏览器请求属于哪条连接，此时会将其标记为「歧义/未知」而不进行猜测。
2. **受限页面不可修改 Favicon**：受 Chromium 安全沙箱限制，`chrome://`、`edge://`、`about:`、Chrome Web Store 等页面不允许注入 Content Script，因此无法在这些页面叠加 Favicon（Popup 内会提示说明）。
3. **WS 推送间隔带来的短暂延迟**：WebSocket `/connections?interval=1000` 默认每秒推送一次快照，新连接建立后可能存在最长约 1 秒的关联延迟，扩展通过后台待定请求重试队列在下一帧快照到达时自动补全状态。
4. **本地 HTTP/WS 隐私与端口**：本扩展不修改 Mihomo 内核，也不接管浏览器系统代理，仅只读订阅 External Controller 的 `/connections` 与 `/version` 接口。
