# SXSEditor-Pad 代码审查报告（Pad 版交互专项）

- 审查对象：`Henley04/SXSEditor-Pad`，分支 `master`，基线提交 `69485d3f`
- 审查维度：窗口按钮操作性 / UI 显示完整性 / 滑动操作可及性 / 性能 / 逻辑
- 结论：共发现 **16 项**问题（严重 6、中 7、轻 3），**全部已直接修复**；`vite build` 通过，`npm test` 1347 项全部通过。
- 修复原则：只改交互/布局/性能相关代码，不触碰推理管线、模型与音频算法。

---

## 一、问题总览

| # | 维度 | 严重度 | 问题 | 状态 |
|---|------|--------|------|------|
| A1 | 按钮操作性 | 严重 | 平板（≥1024px）上「设置 / 资源管理器 / 关于」入口完全不可达 | 已修 |
| A2 | 按钮操作性 | 严重 | 启动即强制全屏，且无任何退出全屏入口 | 已修 |
| A3 | 按钮操作性 | 中 | 分片上下文菜单项仅约 28px 高，手指点不中 | 已修 |
| A4 | 按钮操作性 | 轻 | 溢出菜单新增项后无高度上限、不可滚动 | 已修 |
| B1 | UI 完整性 | 严重 | `pad.css` 规则被窗口样式表成片覆盖，安全区/触摸尺寸/滚动全部失效 | 已修 |
| B2 | UI 完整性 | 严重 | 工具栏在 900–1180px 既不换行也不能滚动，右侧按钮被裁出视口 | 已修 |
| B3 | UI 完整性 | 中 | 6 个窗口缺少状态栏安全区，顶部内容被遮挡 | 已修 |
| B4 | UI 完整性 | 轻 | 上下文菜单在屏幕边缘弹出时被裁到视口外 | 已修 |
| C1 | 滑动可及性 | 严重 | 主窗口画布只有鼠标事件：触屏无法拖拽分片、无法滚动/缩放时间轴 | 已修 |
| C2 | 滑动可及性 | 中 | 分片编辑器双指手势缺 `touchcancel`，中断后画布"卡死" | 已修 |
| D1 | 性能 | 严重 | 时间轴 canvas 尺寸无上限，长工程下显存/填充爆炸 | 已修 |
| D2 | 性能 | 中 | 每帧整幅 `drawImage` 网格缓存，拖拽帧率随工程长度下降 | 已修 |
| D3 | 性能 | 中 | 平移/滚动未做 rAF 合并，pointermove 高频触发重绘 | 已修 |
| E1 | 逻辑 | 中 | `safeArea.js` 卸载时移除 `orientationchange` 失败 → 监听器泄漏 | 已修 |
| E2 | 逻辑 | 中 | 触屏长按弹出的菜单被补发的 click 立刻关闭（"长按没反应"） | 已修 |
| E3 | 逻辑 | 中 | 触摸双击 + 合成 `dblclick` 会打开两个分片编辑窗口 | 已修 |
| E4 | 逻辑 | 轻 | `tauri.conf.json` 同时 `fullscreen: true` 与 `maximized: true` | 已修 |

---

## 二、窗口按钮操作性

### A1 平板上设置/资源管理器/关于不可达（严重）
- 现象：溢出按钮 `#btn-toolbar-overflow` 在 `index.css:670` 默认 `display: none`，仅由 `pad.css` 的 `@media (max-width: 900px)` 打开。
- 影响：平板常见宽度 1024–1280px 不命中该断点，而移动端又没有桌面那样的 OS 菜单栏 → **这三个功能在平板上彻底不可达**。这正好是本仓库（Pad 版）的主战场。
- 修复：改为「平台判定」而非「宽度判定」——`MainWindowApp.vue` 中 `detectTouchPlatform()` 在移动端 UA 或「粗指针 + 支持多点触控」时给 `<body>` 加 `.platform-touch`，`pad.css` 用 `body.platform-touch #btn-toolbar-overflow { display: inline-flex }` 常驻显示。桌面端行为不变。

### A2 启动即全屏、无退出入口（严重）
- 现象：`tauri.conf.json` 窗口 `fullscreen: true`，且 `MainWindowApp.vue` 的 `onMounted` 无条件 `win.setFullscreen(true)`。
- 影响：桌面端一启动就全屏，标题栏的最小化/最大化/关闭被隐藏，而应用内**没有任何退出全屏的入口**，窗口控制完全不可达。
- 修复：
  - `tauri.conf.json` 移除 `fullscreen`（保留 `maximized: true`、`decorations: true`），桌面端保持装饰窗口；
  - 仅在触屏平台请求全屏；
  - 溢出菜单新增「进入全屏 / 退出全屏」（新增图标 `maximize` / `minimize`，新增 i18n 键 `main.enterFullscreen` / `main.exitFullscreen`，中英双语）。

### A3 / A4 菜单项触摸目标与滚动
- `.fragment-ctx-item` 原为 `padding: var(--space-2) var(--space-4)`（约 28px 高）→ 统一 `min-height: 44px` + flex 居中。
- `#toolbar-overflow-menu` 增加 `max-height: calc(100vh - 80px)` 与 `overflow-y: auto`，菜单项变多时不会顶出屏幕。

---

## 三、UI 显示完整性

### B1 `pad.css` 规则被成片覆盖（严重，根因）
- 根因：`pad.css` 由 `common.css` **顶部** `@import` 引入，因此它先于各窗口样式表（`index.css` / `settings.css` / `fragmentEditor.css` …）加载。原规则多为元素/类选择器（特异性 0-0-1 / 0-1-0），被后加载的带 ID 规则压掉。
- 实测失效链条：
  | pad.css 规则 | 被谁覆盖 | 实际后果 |
  |---|---|---|
  | `#toolbar { padding-top: var(--safe-area-top) }` | `index.css:15` `#toolbar { padding: 0 12px }`（同特异性、后加载） | padding-top 归零 → **状态栏压住工具栏** |
  | `.toolbar-group button { padding: 10px 18px; font-size: 16px }`（≥768px） | `index.css:61` `#toolbar button`（ID 特异性更高） | Pad 上按钮仍是桌面尺寸 |
  | `button { min-height: 44px }` | `index.css:90` `#toolbar button { min-height: 32px }` | **触摸目标只有 32px**，低于 44dp 标准 |
  | `#singer-list { overflow-y: auto }` | `index.css:262` `#singer-list { overflow: hidden }` | **歌手列表在触屏滚不动** |
  | `#main-content { overflow-y: auto }`（≤700px） | `index.css:173` `#main-content { overflow: hidden }` | 手机上主区内容被裁剪且无法滚动 |
  | `#toolbar input[type=number] { width: 44px }` 等 | `index.css` 同名 ID 规则 | 窄屏压缩失效，加剧溢出 |
- 修复：`pad.css` 中所有关键规则统一提升特异性（`body …` / `#toolbar …` 前缀），使其在任何加载顺序下都生效；`@media (max-width: 1024px)` 的状态栏兜底同样提升。

### B2 工具栏在 900–1180px 被裁剪（严重）
- 现象：工具栏内容宽约 1300px（12 个按钮 + BPM/拍号/复选框 + 时间显示 + 版本徽章），而 `#toolbar` 只在 ≤900px 才 `flex-wrap: wrap`，`#main-content` 又是 `overflow: hidden` 且工具栏刻意不能横向滚动 → **1024/1080/1180px 平板上右侧按钮（歌手市场、版本、更多）直接消失**。
- 修复：换行断点 900px → 1180px（含按钮压缩、分隔线隐藏、输入框压缩一整套），Pad 上自动变为两行且全部按钮可见可点。

### B3 多窗口缺状态栏安全区（中）
- 现象：只有 `settings.css` 与 `modelDownload.css` 处理了 safe-area；分片编辑器、歌手创建、歌手市场、资源管理器、音频预处理、启动页均未处理。
- 修复：
  - `body #toolbar` 的 `padding-top: var(--safe-area-top)` 覆盖所有窗口（这几个窗口的根节点就是 `#toolbar`）；
  - `pad.css` 为 `.rm-container` / `#splash-root` 等容器补齐四向安全区；
  - 同时保留 ≤1024px 的 28px 兜底（Android 全屏下 `env()` 常返回 0）。

### B4 上下文菜单越界（轻）
- 修复：`showFragmentContextMenu()` 插入 DOM 后读取尺寸，按视口边界收敛 `left/top`（原先直接用手指落点，边缘长按菜单会被裁掉一半）。

---

## 四、滑动操作可及性

### C1 主窗口画布对触屏基本不可用（严重）
- 现象：`src/renderer/eventHandlers.js` 只绑定 `mousedown / mousemove / mouseup / dblclick / contextmenu / wheel`。在 Android/iOS WebView 上：
  - 合成鼠标事件的 `move` 序列不完整 → 分片拖拽、播放头拖动时灵时不灵；
  - **触屏没有 `wheel`** → 时间轴既不能横向滚动、也不能纵向滚动、更不能缩放（`canvas` 还是 `touch-action: none`，浏览器也不代管）；
  - 长按不会触发 `contextmenu` → 删除分片入口不可及；
  - 双击打开分片编辑器不可靠。
- 修复（`src/renderer/eventHandlers.js` 重写画布交互层）：
  - 统一改用 **Pointer Events**（`pointerdown/move/up/cancel/leave` + `setPointerCapture`），鼠标、触摸、触控笔一套代码，桌面鼠标行为完全保持；
  - 抽出 `_hitTestFragment()` / `_isOnPlayhead()` 复用，命中逻辑与原先一致；
  - **双指手势**：`touchstart/move/end/cancel` 实现双指平移 + 捏合缩放（以双指中点为锚点，增量推进基准，支持"边缩边移"），rAF 合并；
  - **单指空白区拖拽平移**：超过 8px 阈值进入平移视图，之后抬手不改变选中状态；
  - **长按 500ms** 弹出分片上下文菜单（触屏替代右键）；
  - **双击 tap** 打开分片编辑器（320ms / 24px 判定）。

### C2 分片编辑器双指手势健壮性（中）
- 现象：`src/fragmentEditor/eventHandlers.js` 只在 `touchend` 复位手势状态：
  - 没有 `touchcancel` → 系统手势/来电打断后 `_twoFingerStart` 残留，之后所有 `touchmove` 都被 `preventDefault` 吞掉，**画布永久卡死**；
  - `_pendingTouch` 未清理 → rAF 里可能消费过期事件；
  - 缩放与平移互斥判定（`|distRatio-1| > 0.02` 相对起始距离）→ 一旦进入缩放就再也无法平移，且数值持续累积漂移。
- 修复：新增 `_resetTwoFingerGesture()` 统一复位并接入 `touchcancel`；缩放/平移改为**增量基准**、可同时进行。

---

## 五、性能

### D1 时间轴 canvas 尺寸无上限（严重）
- 现象：`renderFragmentTimeline()` 的画布宽度 = `totalBeats × beatWidth`，`totalBeats` 随分片长度按 64 拍递增；分片拖长时宽度可达数万 px，再乘 `dpr²`（Pad 常见 dpr=2~3）→ 单张 canvas 数百 MB，Chromium 上表现为重度卡顿甚至白屏；离屏网格缓存同尺寸，翻倍。
- 修复：`_ensureCanvasSize()` 增加 `MAX_CANVAS_PIXELS = 24e6` 上限，超限时按面积等比下调渲染缩放并返回 `renderScale`；主画布、`gridCache`、`setTransform` 全部改用该缩放（网格缓存 key 也纳入缩放，避免误命中）。

### D2 每帧整幅 blit 网格缓存（中）
- 现象：拖拽分片/滚动时每帧执行 `ctx.drawImage(_gridCache, 0, 0, canvasWidth, canvasHeight)`，填充量随工程长度线性增长。
- 修复：命中缓存时只 blit **可视区**（按 `scrollX/scrollY` 取源矩形），每帧填充量恒等于视口大小；缓存本身仍在失效重建时整幅绘制，保证任意滚动位置都能取到内容。配套：wheel、双指手势、单指平移在改变滚动后一律走 `renderFragmentTimeline()`（原实现只调 `syncFragmentScroll()`，会留下未绘制区域）。

### D3 高频 pointermove 未节流（中）
- 修复：新增 `_scheduleTimelineRender()`，用 `state.renderPending` + rAF 合并同一帧内的多次重绘请求。

### D4 构建体积（建议，未改）
- `dist/main_window/index.js` 达 6.3 MB（gzip 4.68 MB），基准模型 base64（`src/assets/benchmark_model.js`，6.3 MB）与词典 JSON 被同步打进主窗口包。建议改为按需动态 `import()` 或运行时下载，可显著降低首屏解析时间。

---

## 六、逻辑

### E1 `safeArea.js` 监听器泄漏（中）
- `window.addEventListener('orientationchange', () => setTimeout(update, 200))` 注册匿名函数，而 `cleanup()` 里 `removeEventListener('orientationchange', update)` 移除的是另一个函数对象 → 移除失败。SPA 路由反复挂载会持续累积监听器。
- 修复：改为具名 `onOrientationChange` 并成对注册/移除。

### E2 长按菜单被自身 click 关闭（中）
- 触屏长按抬起后浏览器会补发一次 `click`，而菜单的"点击外部关闭"监听在 `setTimeout(0)` 后注册 → 菜单刚弹出就被关掉，表现为"长按没反应"。
- 修复：记录弹出时刻，300ms 内的 click 一律忽略；同时在 `hideFragmentContextMenu()` 中统一摘除监听（原先只有"点外部"分支会摘，其它关闭路径残留监听）。

### E3 双击打开两个编辑窗口（中）
- 触摸双击会先走 tap 检测打开编辑器，随后 WebView 补发 `dblclick` 再打开一次。
- 修复：`_suppressDblclickUntil` 时间窗内忽略 `dblclick`。

### E4 窗口配置语义冲突（轻）
- `tauri.conf.json` 同时 `fullscreen: true` 与 `maximized: true`（两者互斥，Tauri 会告警且行为不确定）。修复：移除 `fullscreen`，全屏改由运行时按平台决定。

---

## 七、修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `src/pad.css` | 关键规则特异性提升（安全区/触摸目标/滚动/换行断点 1180px）、触屏溢出菜单常驻、菜单项触摸尺寸、多窗口安全区 |
| `src/index.css` | 无需改动（问题根因已在 pad.css 侧修正，避免双写） |
| `src/vue/windows/main/MainWindowApp.vue` | 触屏平台检测 + `platform-touch` 类、按平台请求全屏、全屏切换菜单项 |
| `src/i18n/zh-CN.js`、`src/i18n/en.js` | 新增 `main.enterFullscreen` / `main.exitFullscreen` |
| `src/icons/iconRegistry.js` | 新增 `maximize` / `minimize` 图标 |
| `src/renderer/eventHandlers.js` | 画布交互改为 Pointer Events；双指 pan/zoom；单指平移；长按菜单；双击 tap；滚动后重绘；菜单防误关与视口收敛 |
| `src/renderer/timelineRenderer.js` | canvas 像素上限 + `renderScale` 贯通；网格缓存改为可视区 blit |
| `src/fragmentEditor/eventHandlers.js` | 双指手势统一复位、接入 `touchcancel`、增量基准、支持缩放+平移同时进行 |
| `src/utils/safeArea.js` | 修复 `orientationchange` 监听器泄漏 |
| `src-tauri/tauri.conf.json` | 移除 `fullscreen`（保留 `maximized` + `decorations`） |
| `docs/audit/pad-ui-audit.md` | 本报告 |

## 八、验证

- `npx vite build`：通过（10 个窗口入口全部产出，仅既有 chunk 体积告警）。
- `npm test`：1347 passing / 0 failing。
- `npx eslint`（改动文件范围）：无新增错误（既有 `src/utils/safeArea.js` 的 `no-undef` 与 `.vue` 解析器缺失属仓库既有配置问题，未纳入本次改动）。

## 九、遗留建议（未改，需产品决策）

1. 主窗口 bundle 拆分（见 D4）。
2. `renderFragmentTimeline()` 在网格缓存命中路径仍会全量绘制分片与文本，长工程下可再做视口裁剪（风险较高，本次未动）。
3. 平板竖屏（短边 <768px）下的分片编辑器布局建议单独走一版响应式（当前只到 600px 断点）。
