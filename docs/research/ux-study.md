# Sixkey 体验调研（UX study）

> 调研日期：2026-10-16。性质：**只做调研、测量与设计**。没有改动 `extension/src`、测试、manifest、脚本、`docs/history/PLAN-zh.md`、`docs/SYNC-DESIGN.md`、`contract/`、`api/`。所有测量都在临时目录里的扩展副本上进行（附录 A）。
> 对照的现状：`docs/history/PLAN-zh.md`、`docs/security/local-vault.md`、`docs/PRIVACY.md`、`docs/SYNC-DESIGN.md`（§1 威胁模型、§6 界面清单、§9.1 H1–H8、§12 Q4、§13 不做清单）、`docs/research/fingerprint-browser-security-lessons.md`、`docs/research/mcp-feasibility.md`，以及 `extension/src/popup`、`options`、`ui`、`core/match.ts`、`core/service`、`core/storage` 的实际代码。
>
> **标记**（与前两份调研相同）：**[复核]** 我本人抓取原文核对过；**[转录]** 研究子代理抓取了原文（或源码），我没有逐条二次核对；**[摘要]** 只见搜索摘要；**[未核实]** 没找到可靠来源，属推断；**[实测]** 我在本机用附录 A 的脚本测得。来源编号（如 [C2]、[W4]、[E2]）见 §5。

---

## 1. 执行摘要

**测出来的事实（M3 Max，Chromium 156，真实工具栏弹窗，一般各 15 次、冷启动 4–8 次，取中位数，附录 A）**

1. **打开速度随账户数劣化很快。** 扩展进程还在运行（"热"）时，从弹窗开始导航到第一个验证码出现：10 个账户 46 ms，100 个 78 ms，**500 个 239 ms**；首帧画出：59 / 106 / **387 ms**。闲置 30 秒以上、扩展进程已停（"冷"，一小时只开几次的正常情况）时：10 个账户就要 104 ms，100 个 137 ms。CPU 降速 4 倍时，100 个账户要 288 ms，500 个要 969 ms。PLAN §9 的 "<100 ms 渲染完成" **只有"热、首个验证码、≤100 个账户"这一种情况达标**；冷启动或按首帧算，10–100 个账户就已超标。[E1]
2. **弹窗开着不动也在烧 CPU。** 主线程占用：10 个账户 36 ms/秒，100 个 231 ms/秒，**500 个 881 ms/秒（接近一个核）**。原因是每 250 ms 一次的刷新让每一行的倒计时圆环都在做过渡动画。[E1]
3. **存储读得太多。** 打开一次弹窗读 `storage.local` 18 次，读取量约为当前槽的 5 倍（500 个账户：1.04 MB）；**解锁一次读 36 次、约 13 倍（2.69 MB）**，因为每次解锁都扫描另一槽与全部快照找旧密钥。快照越多越慢。[E1]
4. **修起来不贵。** 在副本里做的原型（一行 CSS `content-visibility` + 一次读取 + 先算首屏验证码）：500 个账户首个验证码 239→119 ms、首帧 387→156 ms，闲置占用 881→142 ms/秒；100 个账户 78→60 ms。[E8]
5. **侧边栏的关键限制（实测）。** 用 `openPanelOnActionClick` 打开的侧边栏**拿不到 activeTab**，读不到当前网址、不能截图；改用 `action.onClicked` + `sidePanel.open()` 才有，而且只对点击时那个标签页有效，切换标签页后失效、切回来又有效。`action.openPopup()` 程序打开的弹窗也拿不到 activeTab。[E2][E3][C8][C9]
6. **Chrome 156 起，出现安全对话框（WebAuthn、屏幕选择器等）时弹窗被强制关闭。** 所以 WebAuthn 解锁（Touch ID / Windows Hello 之前，Chrome 会先显示自己的 WebAuthn 对话框）、屏幕区域取码、摄像头授权都**不能放在弹窗里**，只能放在标签页、侧边栏或独立窗口。[C7][C15][C16]
7. **MetaMask 先例不成立。** MetaMask 官方："There are only two forms of MetaMask wallet: browser extension and mobile app"；它的 Google/Apple 登录只是**在扩展和 App 里**备份和恢复助记词。反方向的先例倒是有：Dashlane 2025-10-01 关闭了网页直接登录，理由是"no guarantee that what you see in the browser was genuinely delivered by Dashlane"。[W1][W2][W4]
8. **"当前网站优先"会给钓鱼页面打上"此网站"标记。** 现有的名称匹配把 5 个仿冒域名（如 `google.evil-login.ru`、`github.com.attacker.io`）全部判为"此网站"；中文 issuer（如"阿里云"）永远匹配不上；`domains` 字段在任何界面都填不了。[E5]

**建议的体验决定**

| # | 题目 | 建议 | 权限 / 安全代价 | 工作量 | 优先级 |
|---|---|---|---|---|---|
| 1 | 弹窗形态 | 默认仍是工具栏弹窗。可选"侧边栏模式"，用 `onClicked`+`sidePanel.open()` 实现（不用 `openPanelOnActionClick`）。不做独立窗口模式。 | 新增 `sidePanel`（无安装警告）；侧边栏长驻会延长解锁窗口，所以加 15 分钟闲置上限，并在"共享/自动化"预设下关闭 | M | P1（M8 之后） |
| 2 | 列表密度 | 两档密度（标准 / 紧凑）+"隐藏验证码"开关 + 排序（手动 / 名称）；最后 5 秒只让圆环变红 | 无 | S | P1 |
| 3 | 打开速度 | 一次读取、先算首屏、`content-visibility`、停掉逐行动画、解锁不再扫描快照；CI 用"读取次数/字节"做硬门槛 | 无 | S–M | **P0** |
| 4 | Chromium 兼容 | 最低版本保持 120；Chrome / Edge / Brave 为一等支持，Opera / Vivaldi 尽力支持，Arc 与国产浏览器不承诺；Firefox / Safari 不做 | 无 | S（CI） | P1 |
| 5 | 网页版 | **不做完整网页版**。推迟到 Phase 3 之后，届时最多评估"受限的只读应急查看页" | 做了就会把 A1（恶意服务器）从"只能离线猜密码"变成"一次恶意页面加载即拿走整个库"，与"无远程代码"冲突 | L | P2（推迟） |
| 6 | 解锁 | 阶梯：每次都锁 / 闲置 N 分钟（默认 15）/ 浏览器会话，锁屏即锁默认开；Phase 3 的 PRF 只作附加方式，且必须在窗口或标签页里调用；不做 PIN 和"记住我"；主密码自动填充技术上做不到 | PRF：RP ID `sixkey.app` 也能被宽权限扩展声明，需要每个安装各用随机 salt | M（Phase 3） | P2 |
| 7 | 深色模式 | 增加"跟随系统 / 浅 / 深"手动切换和 `color-scheme` meta；修复 `--faint` 文本与输入框边框的对比度 | 无 | S | P1 |
| 8 | 安全模式 | **两个预设**（标准 / 共享·自动化），改动任一项后显示"自定义"；首次运行复用 H5 那一问 | 无 | S | **P0**（随 H5） |
| 9 | 添加账户 | 弹窗内"粘贴任何东西"（链接、密钥、截图）+ 扫描本页作为主路径；确认页做去重并提供"添加并复制验证码"；导入所有明文格式，以及 WebCrypto 能解的加密格式（2FAS、andOTP、Bitwarden-PBKDF2）；摄像头和屏幕区域放到设置页，列 P2 | 无新增 manifest 权限 | M | **P0**（粘贴 + 确认页），P1（导入），P2（摄像头 / 区域） |
| 10 | 当前网站优先 | "此网站"只给已登记的域名，名称猜测降为"可能相关"；增加域名编辑与一键"记住此网站"；添加时用内置 issuer→域名表做建议；加快捷键 `_execute_action`；**不做工具栏角标** | `commands` 不算权限；角标需要 `tabs`（警告"Read your browsing history"）或把域名明文写进配置文件 → 不做 | S–M | **P0**（分级 + 编辑），P1（快捷键、建议表） |
| 11 | 自动填码 | 不做全自动填码。"点按填入"（`scripting`+activeTab，按 `documentId` 锁定文档，只在已登记域名上）交所有者决定，建议暂缓 | 新增 `scripting`（无警告），但要改 PRIVACY 的"never changes the web pages"，并重新解释 §13 F20 | M | P2（待所有者决定，建议暂缓） |
| 12 | 其他 | 错误文案、首次运行顺序（H1 在前）、读屏可用性、同步指示不拖慢首帧、zh-TW 提示 | 无 | S | P1–P2 |

---

## 2. 分题

### 2.1 弹窗形态：工具栏弹窗、侧边栏、独立窗口、整页

**现状。** 工具栏弹窗宽 376 px，高 440–600 px（`popup.css`）。点击工具栏图标时 Chrome 授予 activeTab，弹窗靠它读当前网址、截取可见区域（本次实测：真实弹窗里 `tabs.query` 能拿到网址，`captureVisibleTab` 成功）[E2]。"每次都锁定"模式完全依赖"弹窗一关、页面内存就没了"（`platform/session.ts`）。

**会让弹窗关闭或失效的操作**（决定哪些流程不能放在弹窗里）：

| 操作 | 在弹窗里的结果 | 来源 |
|---|---|---|
| `chrome.permissions.request()`（例如剪贴板清空的可选权限） | 弹出授权框后弹窗关闭（2019 年至今未修） | [C15] [转录] |
| `getUserMedia` 摄像头 | 弹窗和侧边栏里都弹不出授权提示，请求直接失败；要先在扩展的标签页里授权一次 | [C16] [转录] |
| `getDisplayMedia` / 视频捕获 | "attempting to capture video from the popup causes focus to move and the popup to close." | [C6] [复核] |
| Chrome 自己的 WebAuthn 对话框 | Chrome 133–155 期间弹窗保持打开（该测试在 Windows 上被禁用）；**Chrome 156 起，出现安全对话框时弹窗被强制关闭**："Extension popups are now force-closed under all circumstances when a security dialog is present." | [C17][转录]；[C7] 提交内容 [复核]，版本号 [转录] |
| 系统级的 Touch ID / Windows Hello 窗口 | 会不会关闭弹窗**未知**，没有找到测试或报告 | [未核实] |
| 文件选择框 | 旧报告说 macOS 上会关闭弹窗，当前版本未验证 | [未核实]（只见旧摘要，见 C17） |
| 用户去点网页里的输入框 | 弹窗关闭。这正是"边看验证码边输入"的痛点 | 众所周知的行为，未逐版本核实 |

**四种形态对比**

| 形态 | 新增权限 | 能否知道"当前网站" | 生命周期与锁定 | 适合 | 不适合 |
|---|---|---|---|---|---|
| 工具栏弹窗（现状） | 无 | 能：每次点击都授予 activeTab [E2] | 关闭即销毁，"每次都锁定"的基础 | 一键复制、当前网站置顶、扫描本页二维码 | 边看边输；任何需要系统对话框的流程 |
| 侧边栏 `chrome.sidePanel` | `sidePanel`：无安装警告 [C3][复核]；Chrome 114+；`open()` 需 116+ 且"may only be called in response to a user action" [C2][复核] | **取决于打开方式。** 用 `openPanelOnActionClick` 打开：没有 activeTab，读不到网址，截图报错 [E2][C8]。用 `action.onClicked` + `sidePanel.open()` 打开：被点击的那个标签页有 activeTab。切到别的标签页后读不到；切回原标签页（期间只有同源导航）又能读；在新标签页上再点一次图标即可授予该页 [E2] | **长驻**：解锁后 VK 留在页面内存里的时间 = 侧边栏开着的时间，A10（调试端口进程）的窗口随之变长 | 边看边输、长列表、批量添加、在网页上反复操作 | 共享 / 被脚本控制的配置文件 |
| 独立窗口 `windows.create({type:"popup"})` | 无 [C11][转录] | 不能：它不是用户在标签页上的调用 | 同侧边栏 | 摄像头、PRF 解锁这类必须离开弹窗的单个流程 | 日常使用（多一个窗口，焦点乱） |
| 整页标签（现有设置页） | 无 | 不能 | 已有"闲置 15 分钟锁定"上限 | 导入导出、批量、摄像头授权、PRF 设置 | 日常复制 |

**各浏览器的侧边栏支持**：Edge 支持（Edge 侧边栏就是 `chrome.sidePanel`；已知问题：切回原标签页时侧边栏不会自动重新显示）[F1][转录]；Opera 135（2026-09）起支持 [F2][复核]；Brave 中 API 可用，但它自己的侧边栏里没有入口按钮 [F4][转录]；Vivaldi 7.x 的 `setOptions` 有 bug [F5][转录]；Firefox 和 Safari 没有这个 API [F9][转录]。所以**弹窗必须一直是默认形态**，侧边栏只能是增强。

**建议**
- **默认：工具栏弹窗。** 它快，用完即走，activeTab 每次都有，与"每次都锁定"天然一致。
- **开关：设置 › 外观 › "点击图标时打开：弹窗 / 侧边栏"**，另在弹窗页头放一个"在侧边栏中打开"按钮。
  - 侧边栏模式的实现方式：`action.setPopup({popup: ""})`，然后在 `action.onClicked` 里调用 `sidePanel.open({windowId})`。**不要用 `openPanelOnActionClick`**，否则"当前网站"和"扫描本页"在侧边栏里都失效 [E2]。
  - 快捷键 `_execute_action` 在没有弹窗时会触发 `onClicked`，同样授予 activeTab [C1][复核]；由此能打开侧边栏，属推断，未测。
  - 从弹窗按钮调用 `sidePanel.open()` 算不算"user action"：未核实，实现前要测。
- **侧边栏里"当前网站"的做法**：`tabs.onActivated` 在没有 `tabs` 权限时照常触发，只是不给网址 [E2]。切换标签页时就把顶部的网站卡片置灰，提示"点图标或按快捷键重新识别"；切回原标签页时，`tabs.get` 又能读到网址，卡片自动恢复（示意图 `mock-sidepanel-*.png` 的 A/B 两栏）。**不申请 `tabs` 权限。**
- **锁定语义**：侧边栏按"一直开着的页面"处理，与设置页一样受 15 分钟闲置上限约束，关闭即丢弃 VK。"共享/自动化"预设（§2.8）下不提供侧边栏模式。
- **不做独立窗口模式。** 独立窗口只作为单个流程的容器（PRF 解锁、摄像头），不作为常驻形态。
- **与承诺的冲突**：`sidePanel` 是新权限。它没有安装警告，按文档推断更新时不会让扩展被停用（文档只写了"有警告的新权限会停用扩展"[C4][复核]）。但它破坏了 Phase 0.x"不新增任何权限"的预算，也要改 `check-dist.mjs` 的白名单，所以排在 M8 之后（§3）。

### 2.2 列表密度、排序与隐藏验证码

**竞品。** 所有者截图里的应用（style classic/modern、view normal/compact/hidden、sort manual/service/name）**没能确认是哪一款**；Aegis、ente、2FAS、Proton Authenticator、Stratum、Authenticator.cc 的字符串都对过，都不是 [A14][转录]。同类设置的现状 [A14][转录]：

| 应用 | 视图 | 隐藏验证码 | 排序 |
|---|---|---|---|
| Aegis | Normal / Compact / Small / Tiles | "Tap to reveal"，带超时 | Issuer、Account、使用次数、最近使用、Custom |
| 2FAS | Default / Compact | "Hide tokens"（点按显示） | A-Z / Z-A / Manual |
| ente Auth | compactMode | shouldHideCode（双击查看） | issuer / account / 常用 / 最近 / manual / 最新 |
| Stratum | Default / Compact / Tile | Tap to Reveal（几秒后再隐藏） | a-z / z-a / 复制次数 / custom |

**现状截图**（`popup-main-light-pw-10.png`）：每行 54 px，弹窗里约 8 行可见。最后 5 秒时，同一周期的**所有**验证码同时变红（`.row.low .code`），一整屏红字，比警示的信息量大得多。

**建议（选项最少的一套）**
- **密度：标准 / 紧凑两档。** 紧凑为 38 px 单行，issuer 与 label 并排，约 12 行可见（`mock-density-*.png`）。不做 classic/modern 两种"风格"：一个设计系统维护两套外观，每个新界面的成本都会翻倍。
- **"隐藏验证码"做成独立开关**，不作为第三种视图。
  - 隐藏时点击行照样直接复制，不显示数字；按空格或按住才显示选中行，5 秒后自动隐藏。
  - 当前网站那一行也隐藏。
- **排序：手动（拖动，现有）/ 按名称。** 在 Sixkey 里 issuer 就是服务名，所以"按服务"和"按名称"是一回事，合并成一项。
  - 当前网站的账户永远排在最前，不受排序影响。
  - 不做"最近使用 / 使用次数"：要在库里记录每次使用的时间，收益小。
- **最后 5 秒只把圆环和秒数变红**，数字保持原色。
- **隐藏验证码的安全价值，如实说明：**
  - 防的是：肩窥、屏幕共享、录屏、直播截图。
  - 不防：能读 DOM、剪贴板或内存的东西（A10 调试端口进程、恶意软件）。
  - 也不防：坐到已解锁电脑前的人，他照样能点复制。
  - 适合放进"共享/自动化"预设（§2.8），也适合经常开会或直播的用户手动打开。
- 无新权限、无格式变化，S，P1。

### 2.3 轻量与打开速度（实测）

**测法要点**（细节和复现命令见附录 A）。
- **触发方式**：用 CDP 的 `Extensions.triggerAction` 模拟点击工具栏图标。打开的是**真实的工具栏弹窗**，并且拿到了 activeTab。
- **计时**：每个弹窗在第一行脚本执行前，先用调试器暂停并注入一个 MutationObserver。"首个验证码"指从弹窗文档开始导航，到第一个非"•••"的验证码进入 DOM；"首帧"取其后一帧。
- **对照组**：一个空白弹窗扩展，在同一套工具下从"点击"到页面有内容要 287 ms，其中约 272 ms 发生在弹窗文档开始导航之前，属于浏览器和工具本身的开销，**不计入 Sixkey**。
- **插桩没有改变结果**：生产构建（未插桩）的 100 账户数据为 79.8 / 104.1 ms，与插桩版的 78.4 / 106.3 ms 一致。

**结果（中位数，括号内为 p95；单位 ms）**

| 场景 | 10 个账户 | 100 个账户 | 500 个账户 |
|---|---|---|---|
| 已解锁、扩展进程已在运行：首个验证码 / 首帧 | 46 / 59 | 78 (88) / 106 (114) | 239 (250) / 387 (398) |
| 已解锁、SW 已停止 ≥30 s（进程冷启动） | 104 / 109 | 137 (153) / 162 (179) | 311 / 455 |
| 浏览器重启后：锁屏页出现 | 44 | 43 | 63 |
| 输入主密码 → 首个验证码 / 首帧 | 89 / 95 | 153 (174) / 179 (199) | 445 (459) / 591 (605) |
| CPU 降速 4×，已解锁：首个验证码 / 首帧 | — | 288 / 404 | 969 / 1666 |
| CPU 降速 4×，解锁 → 首个验证码 | — | 479 | — |
| 效率核（`taskpolicy -b`），已解锁 | — | 444 (905) / 567 (1270) | — |
| 效率核，解锁 → 首个验证码 | — | 773 (2119) | — |
| 旧的设备密钥模式（无主密码），浏览器重启后：首个验证码 | — | 95 | — |
| 弹窗开着不动，主线程占用（ms/秒） | 36 | 231 | 881 |
| 每次打开：`storage.local` 读取次数 / 读取量（当前槽大小） | 18 / 26 KB（5.3 KB） | 18 / 217 KB（43 KB） | 18 / 1.04 MB（207 KB） |
| 每次解锁：读取次数 / 读取量 | 36 / 67 KB | 36 / 561 KB | 36 / 2.69 MB |

关于这张表的口径：
- **PBKDF2-SHA256 600k 单独计时**：性能核 47.7 ms；效率核中位数 925 ms，范围 414–2777 ms [E7]。
- **CPU 降速**：降速只作用于渲染主线程，PBKDF2 不在主线程上跑 [未核实]，所以降速后的解锁数字**低估**了慢机上 KDF 的耗时。效率核那一行是整个进程都变慢。
- **"效率核"**：指用 `taskpolicy -b` 把整个浏览器压到 Apple 芯片的效率核上，只作为慢 CPU 的代理，不代表任何具体机型。

**分阶段拆开看（已解锁，中位数）。** 脚本在 18 ms 时就已加载执行完毕，字体在约 21 ms 时就绪。之后各阶段（100 个 / 500 个账户）：

| 阶段 | 100 个 | 500 个 |
|---|---|---|
| `status()` | 7 ms | 22 ms |
| `read()` | 21 ms | 90 ms |
| 算全部验证码并渲染 | 25 ms | 102 ms |
| 布局与绘制 | 28 ms | 148 ms |

**体积与请求**：一次打开 10 个请求，包括 HTML、2 个 JS、2 个 CSS、5 个字体（只有 3 个预加载）。JS 117 KB（gzip 40 KB），CSS 24 KB（gzip 6.8 KB），字体 72 KB。`check-dist` 现有的 60 KB gzip 门槛仍满足。**体积和字体都不是瓶颈。**

**瓶颈，按影响排序**
1. **500 个账户时每一行都被渲染，而且倒计时圆环一直在动画。** 布局和绘制占 148 ms，弹窗闲置时每秒烧 881 ms 主线程。圆环的 `transition: stroke-dashoffset .25s` 加上每 250 ms 一次的刷新，相当于每一行都在持续动画（样式重算 101 ms/秒，而脚本不到 1 ms/秒）。
2. **算完全部验证码才显示第一个。** `ui/hooks.ts` 用 `Promise.all` 一次算完全部，500 个账户时要做 500 次 `importKey` 加 500 次 HMAC。
3. **重复读存储。**
   - `status()`、`read()`、`openVault()` 各自 `load()` 一次槽（共 3 次），`scrubStaleDeviceKey()` 再读两个槽。
   - 每次打开要从 `storage.local` 结构化克隆约 5 倍的密文。
4. **解锁时扫描所有快照。** `hasStaleKeyMaterial()` 每次解锁都读另一槽和两个存储里的**每一个快照**（`core/storage/store.ts`）。
   - 快照满额是 10 个滚动 + 7 个每日，乘以两个存储。
   - 500 个账户时，最坏情况每次解锁要读约 7 MB [估算：34 × 207 KB]。
   - 上表的 2.69 MB 只是 2 个快照时的数值。IndexedDB 镜像的读取没有计入。
5. **PBKDF2：性能核 48 ms，效率核约 0.4–2.8 s。** 这是设计上不能省的成本（600k 下限），只能在等待时给出"正在解锁…"的反馈（锁屏页已有转动的表盘）。
6. **进程冷启动固定多出约 58 ms。** 这时 SW 已停、没有扩展页面开着，扩展进程要重新启动（推断）。**弹窗的关键路径不经过 SW**：首个验证码出现之前没有任何 SW 消息，`touch()` 发生在渲染之后，所以"唤醒 SW"不是瓶颈。

**优化建议，按收益与工作量排序**

| # | 改动 | 实测或估算的收益 | 工作量 |
|---|---|---|---|
| O1 | `.row { content-visibility: auto; contain-intrinsic-size: auto 54px }` | **实测**：500 个账户首帧 387→230 ms；闲置占用 881→145 ms/秒（100 个：231→74）。**代价**：100 个账户的首个验证码 78→89 ms（首帧反而 106→97 ms），可能是首次布局多了一步，噪声与真实成本难分；与 O2 叠加后降到 60 ms，抵消有余 | S（一行 CSS） |
| O2 | 打开时只 `load()` 一次：状态、事件、VK、解密合成一个服务调用，失败时回落到现有的完整路径；验证码先算首屏 16 个，其余随后 | **实测**（与 O1 叠加）：100 个账户首个验证码 78→60 ms、首帧 106→74 ms；500 个 239→119 / 387→156 ms | S–M |
| O3 | 不再用 JS 每 250 ms 驱动圆环：改为每个周期一段 CSS 动画（负的 `animation-delay` 对齐当前秒数），每秒最多刷新一次数字；最后 5 秒只让圆环变红 | 估算：剩余的 70–140 ms/秒闲置占用降到 10 ms/秒以下（未实测） | S |
| O4 | 解锁时不再扫描全部快照：在"换密钥"的那次事务里写一个"旧密钥材料待清理"标记，只在标记存在时运行 `rewriteForKeyChange`；`scrubStaleDeviceKey` 同理 | 估算：500 个账户的解锁从 445 ms 降到约 150 ms，而且不再随快照数增长 | S（但涉及 `core/storage`，见 §3 的协调） |
| O5 | 只加载当前语言的文案（两份语言文件共 35 KB，现在都打进了共享包） | 小（解析时间少几毫秒） | S |
| O6 | 字体从 5 个文件减到 3 个（只保留 400/600 正文与 500 数字） | 小 | S |

**性能预算，建议放进 CI。** 计数类指标是确定性的，做**硬门槛**；计时类指标会有噪声，只做**告警**，并且都与同一次运行里的空白弹窗对照相减。**计时一律测"冷"的情况**（CI 里等扩展 SW 被停掉，或用 CDP 强制停止它之后再打开），因为这才是用户日常遇到的情况；"热"的数字只作参考。
- **体积**：弹窗首屏 JS ≤ 120 KB（≤ 45 KB gzip）；CSS ≤ 30 KB；请求 ≤ 10 个；字体 ≤ 80 KB。
- **存储（硬门槛）**：
  - 已解锁打开一次：`storage.local` 读取 ≤ 4 次，读取字节 ≤ 当前槽的 1.5 倍。现在是 18 次、5 倍。
  - 解锁一次：读取 ≤ 8 次，≤ 3 倍。现在是 36 次、13 倍。
- **时间（告警）**：
  - 已解锁、100 个账户：导航到首个验证码 ≤ 对照 + 60 ms；500 个账户 ≤ 对照 + 120 ms。
  - 解锁减去 PBKDF2 之后：100 个账户 ≤ 80 ms。
- **闲置 CPU（告警）**：100 个账户时，弹窗打开 10 秒内 `TaskDuration` ≤ 20 ms/秒。
- 实现方式：把附录 A 的 `bench.mjs` 收进 `extension/scripts/`，作为 e2e 的一部分运行。本次没有改动仓库，只在临时目录里。

### 2.4 Chromium 兼容

**Sixkey 用到和计划要用的 API**

| API | 用途 | 最低版本 / 限制 |
|---|---|---|
| MV3、`action` 弹窗、`storage.local`、`unlimitedStorage`、IndexedDB、`navigator.locks`、WebCrypto（PBKDF2、HKDF、AES-GCM、HMAC） | 全部现有功能 | `minimum_chrome_version` 为 120 |
| `storage.session` | 解锁会话 | Chrome 102；浏览器重启、扩展更新或重载时清空 [C5][复核] |
| `alarms` | 每日快照、闲置锁定 | — |
| `idle` 的 `locked` 状态 | 锁屏即锁 | Windows、macOS、ChromeOS 正常；Linux 取决于桌面环境是否通过 D-Bus 提供屏保服务 [C22][转录] |
| `offscreen`（理由 `CLIPBOARD`） | 剪贴板 30 秒清空 | Chrome 109；Firefox 不做 [F9][转录] |
| activeTab + `captureVisibleTab` | 扫描当前页二维码 | 每秒最多 2 次 [C11][转录] |
| `BarcodeDetector` | 二维码快速识别 | 文档写明只在 macOS、ChromeOS、Android 可用；Google 品牌的 Chrome 在 Linux（M140）和 Windows（M141）编进了支持，但运行效果未测；其他分支大概率只有空壳 [C18][转录]。**保留纯 JS 解码作为兜底。** |
| 计划：`host_permissions` api.sixkey.app + SW 中的 fetch | 同步 | — |
| 计划：`sidePanel` | 侧边栏模式 | 114；`open()` 116 |
| 计划：`commands` | 快捷键 | 最多 4 个建议快捷键，必须包含 Ctrl 或 Alt [C12][转录] |
| 计划：WebAuthn PRF + 以 host 权限声明 RP ID | Phase 3 解锁 | PRF：Chrome 116 [U1][转录]；RP ID 规则：Chrome 122 [C23][复核] |

**最低版本**：保持 120。PRF 解锁做成"检测到支持才出现"的功能，不要为它把最低版本提到 122。指纹浏览器的内核版本：
- Multilogin Mimic 154、GoLogin Orbita 148、AdsPower SunBrowser 约 150–151、Dolphin 138 [F8][转录/摘要]；BitBrowser 134。
- VMLogin 109 低于 120，装不上（指纹浏览器调研）。

**各浏览器**（"一等"= 发布前必须冒烟测试；"尽力"= 收到问题再修；"不承诺"= 帮助页写明）

| 浏览器 | 内核 | 能否装商店扩展 | 侧边栏 | 定位 |
|---|---|---|---|---|
| Chrome | 155 稳定版，156 于 2026-10-20 推出 | 是 | 是 | 一等 |
| Edge 155 | 155 | 需在设置里打开"允许来自其他商店的扩展" | 是；已知问题：切回原标签页时不自动重新显示 [F1] | 一等。另外，在 Edge 里关闭浏览器不一定结束进程（启动加速），"浏览器会话"锁定会一直有效 [U9][转录] |
| Brave 1.97 | 155 | 是 | API 可用，Brave 侧边栏里没有入口 [F4] | 一等 |
| Opera 137 | 153 | 第三方资料说需借助 Opera 的辅助扩展 [未核实] | 135 起支持 [F2][复核] | 尽力 |
| Vivaldi 8.2 | 152 | 是 [未复核] | 7.x 的 `setOptions` 有 bug [F5] | 尽力 |
| Arc | 维护状态，最后见到的内核是 148 [F6][摘要] | 是 | 未知 | 不承诺 |
| Yandex | 未知；从 Opera 扩展站安装 | — | 未知 | 不承诺 |
| 360 安全浏览器 16 / 360 极速浏览器 13 | 132 / 86（极速版太旧，不支持 MV3） | 自有扩展中心 | 未知 | 不承诺；安全浏览器上架中国市场前人工测一次 |
| QQ、搜狗 | 未知 | 自有应用中心 | 未知 | 不承诺 |
| Firefox / Safari | — | — | 没有 sidePanel；Firefox 没有 offscreen（WONTFIX）；Safari 没有 `idle` [F9][转录] | 不做（PLAN 原则 3） |

**便宜的测试方法**
1. **CI 加旧内核**：SYNC-DESIGN 的 d8 已计划用 Chrome for Testing 120 与 134（CfT 可下载 113 以后的任何版本）。建议再加一个约 150 的版本，覆盖 Orbita / SunBrowser 一档。
2. **品牌浏览器不能自动化**：品牌版 Chrome 137+ 与 Edge 已不接受 `--load-extension` [C19][转录]，只能人工测。
   - 发布前用一份 10 步清单（解锁、复制、扫描本页、导出、锁屏即锁）在 Edge、Brave 上各走一遍，约 15 分钟。
   - Opera、Vivaldi 每个大版本走一遍。
3. **弹窗关闭行为随版本变过三次**（M126、M133、M156）[C7][C17]。设计上不要让任何流程依赖"弹窗在系统对话框出现时保持打开"。

### 2.5 网页版：先核实先例，再看信任模型

**所有者的先例不成立。**
- MetaMask 官方："There are only two forms of MetaMask wallet: browser extension and mobile app."[W1][复核]
- 它的社交登录（2025-08）是这样工作的 [W2][复核]：
  - 设备生成一把随机密钥，用 Shamir 秘密分享拆成几份，交给多个"key share holders"保管。
  - Google/Apple 登录只决定"能不能取回这些份额"；用户自己的密码是唯一不在服务器上的因素。
  - 服务器限制密码猜测次数。
  - "The only instance where a full SRP exists is on your device"。
  - 恢复在**扩展或 App 里**进行。
- 所以它是**跟随身份的云备份 / 恢复**，不是"在网页里打开钱包"。
- MetaMask 唯一的"无需扩展"产品是 Embedded Wallets（原 Web3Auth），那是给第三方应用嵌入的开发者套件 [W3][转录]。

**同类产品实际怎么做**

| 产品 | 网页端 | 厂商对"服务器下发代码"的说法 |
|---|---|---|
| Bitwarden | 完整网页库 | "The authenticity and integrity of the Bitwarden web client depend on the integrity of the HTTPS TLS connection"；缓解手段是 CSP、HSTS [W6][转录] |
| 1Password | 完整网页客户端 | 白皮书："An attacker capable of changing the web client on the server could deliver a malicious client to the user."；建议"Use (code signed) native clients as much as possible."；并承认网页客户端让用户更容易被钓鱼 [W5][复核] |
| Proton Pass | 完整网页应用，可导出 | 2019 年承认"web apps provide fewer security guarantees"，计划将来给网页代码签名 [W7][转录] |
| ente Auth | auth.ente.com，只能查看 | 源码显示只读：列出、搜索、显示，不能增删改 [W8][转录]；FAQ 把它定位为"确认你的验证码还在不在"[W8][复核] |
| Dashlane | **2025-10-01 关闭了网页直接登录**，网页界面只能从扩展打开 | "there is no guarantee that what you see in the browser was genuinely delivered by Dashlane"[W4][复核] |
| Google Authenticator | 没有网页查看页 | 同步到 Google 账户；帮助页只说"encrypts … in transit and at rest"[W18][转录] |
| Microsoft Authenticator | 没有网页端；备份不能跨平台 | [W19][转录] |
| Authy | 桌面版 2024-03-19 停止；没找到网页端 | [W20][转录] |
| 2FAS | 浏览器扩展本身不存库，验证码由手机发过来 | [A8][转录] |
| Aegis | 只有 Android，不联网 | Aegis README [转录] |

**信任模型会怎样变化。** 对照 SYNC-DESIGN §1.2：
- **A1（恶意或被攻破的服务器）。** 今天它最多能对密码包裹做离线爆破（≥50 bit 加 PBKDF2 600k），或者拒绝服务、冻结版本。有了网页客户端，**一次被篡改的页面加载**就能把用户输入的主密码，连同服务器本来就存着的 KeyBundle 一起拿走，等于整个库和 30 天历史。
  - 这样的篡改可以只针对一个用户，事后也查不出来。1Password 员工在论坛上说过"We have no way to detect that"[W5][摘要]。
  - 能做到这一点的不只是服务器本身，还有 CDN、构建流水线、域名注册商与 DNS、内部人员，以及针对单个用户的法律强制。
- **钓鱼**：用户会被训练成"在网站上输入主密码或恢复码"。2026-01 就有冒充 LastPass 的仿冒域名，伪造"保险库备份"页 [W17][转录]。
- **使用环境更差**：网页版瞄准的用户恰好是"锁定的、共享的、不能装扩展的电脑"。这类机器上更可能有管理员的代理、键盘记录或别的扩展。
- **规避管理员策略**：在被管理员用策略禁止装扩展的电脑上，网页版实际上是绕开了这条策略。

**缓解手段逐项看**

| 手段 | 能挡什么 | 挡不住什么 |
|---|---|---|
| 子资源完整性（SRI） | CDN 篡改子资源 | HTML 本身来自同一台服务器，哈希写在 HTML 里："the whole page is defined by just its HTML"[W9][转录] |
| 严格 CSP、独立域名 | XSS、第三方脚本 | 服务器本身被攻破 |
| 可复现构建 + 公布哈希 | 事后审计 | 每次加载都没有人去核对 |
| Meta Code Verify / WEBCAT | 用另一个扩展核对页面哈希 | **前提是装了扩展**，对"装不了扩展"的场景是循环论证。WEBCAT 目前是 Firefox 上的 alpha 版 [W10][W11][转录] |
| WAICT（浏览器原生透明日志） | 将来可能有效 | 只是 Firefox Nightly 里的原型，"still very early"[W9][转录] |
| Chrome Isolated Web Apps | 打包签名的网页应用 | "IWAs are supported only on ChromeOS"[W12][复核]，需要进白名单，而且排除扩展能做到的用途 [W12][转录] |
| Service Worker 锁定代码 | 很弱 | 超过 24 小时会绕过缓存检查更新，旧 SW 拦不住；服务器还能用 `Clear-Site-Data` 注销它 [W13][转录] |
| 引导页用固定公钥验证应用包签名（WebCrypto 验签后再执行） | 应用包被 CDN 或存储篡改 | **循环论证**：引导页和公钥本身也由同一台服务器下发，服务器被攻破时可以换掉引导页。只有把引导页固定在服务器之外（本地文件或扩展里）才有意义，而那又回到了"装不了扩展"的问题 |
| Signed Exchanges | 证明内容来自某个 origin，与传输途径无关 [W21][转录] | 证明的是 origin，不是代码：持有该 origin 签名密钥的一方给什么就签什么；只有 Chromium 支持，签名最长有效 7 天 |
| 可安装的 PWA | 不锁定代码 | 同上 |
| "下载 HTML 到本地运行"（file://） | 代码不随每次访问变化 | file:// 是安全上下文，WebCrypto 能用；但 ES 模块被 CORS 拦截，而且**所有 file:// 页面共用同一份 localStorage**，下载的任何别的 HTML 都能读到 [W14][转录，子代理在 Chrome 155 上实测]；下载本身仍来自服务器；锁定的电脑往往也禁止下载 |

**同步设计对"浏览器作为设备"意味着什么**
- **入网**：必须走批准（SAS 加 CC，D2），**不应在网页上接受恢复码**。恢复码绕过批准，在一台不受信任的电脑上输入它，等于交出最高权限的秘密，之后必须立刻换新码。
- **不留持久密钥**：DSK 只放内存，用完即弃。后果是每次访问都是一台"新设备"；Bitwarden 的网页端在清 cookie 后也会被当成新设备 [W15][转录]。这就需要服务器支持"临时设备"：到期自动吊销，不进设备列表，或者以独立的灰显形式出现。这是新的协议工作，L 级。
- **只读模式只是客户端自觉**：网页客户端解出 VK 之后什么都能做，写入证明也挡不住持有 VK 的一方。只读能减少误操作，但**不降低主要风险**，即密钥和密码暴露。

**建议：现在不做完整网页版，推迟。** 分阶段：
1. **现在**：帮助页写明替代方案。
   - 在能装扩展的另一台电脑或另一个浏览器里，用加密备份导入。
   - 在设计上不鼓励绕开管理员策略。
2. **M8 之后**：通过客服邮件统计这类需求的数量，不做埋点。
3. **Phase 3 之后**：如果需求确实存在，再单独做安全评审，设计"受限的应急查看页"：
   - 独立域名；
   - 不落盘（不用 IndexedDB 或 localStorage）；
   - 只能通过已有设备批准入网，到期自动吊销；
   - 只能查看和复制，不能导出、编辑、改设置；
   - 严格 CSP、SRI，公布可复现构建的哈希；
   - 页面明说"这是我们服务器每次加载时下发的代码"。
4. **评审通过才做。**

**与承诺的冲突**：网页版本质上就是"远程代码"，与"无远程代码"的承诺直接冲突。这个承诺对扩展仍然成立，但品牌层面的说法要改成"扩展无远程代码"。

### 2.6 最方便的解锁方式

**事实**
- `storage.session`："The storage is cleared if the extension is disabled, reloaded, updated, and when the browser restarts."[C5][复核]
- **"浏览器会话"锁定会漏**：
  - macOS 上关掉最后一个窗口，Chrome 仍在运行 [U11][转录]；
  - Edge 开着启动加速时，关闭窗口不结束进程 [U9][转录]；
  - ChromeOS 无法完全关闭浏览器。
- **主密码不可能被密码管理器自动填充**：
  - Chrome 自带的密码管理器不在 `chrome-extension://` 页面上保存或填充（源码排除了扩展 scheme）[C24][转录]；
  - 其他扩展不能在别的扩展页面上运行内容脚本 [C24][转录]；
  - 1Password 员工也说扩展不能在别的扩展页面里填充 [摘要]；
  - 系统级填充（如 macOS 上 1Password 的 Universal Autofill）能不能输入，未核实。
- **WebAuthn PRF（Phase 3）**：
  - Chrome 116 起支持 PRF [U1][转录]。
  - Google 密码管理器里的通行密钥支持 PRF；**Chrome 本地配置文件里的通行密钥不支持**[U2][复核，厂商说法][U3][转录]。
  - macOS 15 的 iCloud 钥匙串：Chrome 132+ 可用 [U2]。
  - Windows Hello：要装 2026-02 的系统更新，并且 Chrome / Edge 147+ 才能在创建时用 PRF [U2][复核，厂商说法]；创建时不传 PRF 输入，Windows Hello 不会报告支持 [U4][转录]。
  - 安全密钥：YubiKey 5 系列固件 5.2+ [U13][转录]。
- **扩展用 WebAuthn**：从 Chrome 122 起，有 `https://api.sixkey.app/*` host 权限就能使用 RP ID `sixkey.app`（可以声明父域名，最多到 eTLD+1），`clientDataJSON` 里的 origin 仍是扩展本身 [C23][复核]。Phase 1 计划的 host 权限正好够用，**不需要新权限**。
- **对话框会关掉弹窗**：Chrome 156 起，WebAuthn 对话框会强制关闭弹窗 [C7]。所以 PRF 解锁**必须在独立窗口、标签页或侧边栏里调用**。侧边栏会不会受影响，未核实。

**解锁阶梯（从默认到可选）与安全代价**

| 档位 | 行为 | 安全代价 | 设定 |
|---|---|---|---|
| 每次都锁定 | 每次打开都输密码；VK 只在打开着的页面内存里 | 最小（A10 只在页面开着时有机会）；摩擦最大：输入密码，加上解锁本身 0.1–0.5 s（慢机约 1 s） | "共享/自动化"预设 |
| 闲置 15 分钟 + 锁屏即锁 | 现有默认 | 最后一次使用后 15 分钟内，VK 在 `storage.session` 里 | **默认** |
| 闲置 N 分钟（1–1440） | 用户自选 | 窗口按比例变长 | 可选 |
| 浏览器会话 | 直到退出浏览器 | macOS / Edge / ChromeOS 上可能是几天；界面上要写明 | 可选，带警告 |
| PRF 解锁（Phase 3） | 用 Touch ID / Windows Hello / 安全密钥 / GPM 通行密钥代替输入密码；**不改变锁定时间** | 见下 | 可选附加方式，主密码永远保留（不会被锁在外面） |

**PRF 的两个设计要点**
1. **RP ID 是共享的。**
   - 任何拥有 `sixkey.app` 或 `<all_urls>` 权限的扩展、`sixkey.app` 网站本身，或者网站上的 XSS，都能对同一个 RP ID 发起断言 [推断，基于 C23]。
   - 如果 PRF 的 salt 是写死在代码里的常量，用户只要在系统框里按一下指纹，对方就能拿到同样的 PRF 输出。
   - **对策**：每个安装各用一个随机 salt，只存在 Sixkey 自己的存储里（别的扩展读不到），断言时带上 `allowCredentials` [推断]。
2. **配置文件副本（A3）。**
   - PRF 包裹放在配置文件里也没用，复制走配置文件的人拿不到认证器。这是 PIN 做不到的性质。
   - 但 GPM 通行密钥会跟随 Google 账户同步。同时持有 Google 账户和配置文件副本的人就能解锁。帮助页要写明。

**不做的，以及原因**
- **PIN**：已被 §13 F25 否决。
  - 6 位 PIN 只有 10⁶ 种。按 PLAN §5.1 的"单张 RTX 4090 每秒约 1.5 万次（600k 迭代）"，穷举约需 **67 秒**。
  - Bitwarden 自己写明"Using a PIN can weaken the level of encryption that protects your application's local vault database"[U5][复核]，网上也有公开的 PIN 爆破工具 [U12][转录]。
  - Proton Pass 的 PIN 能成立，是因为 PIN 交给服务器核对，错 3 次就要求重新登录 [U6][复核 3 次；服务器核对为转录]。Sixkey 若这样做，解锁就要依赖网络和服务器，与"验证码的生成不依赖服务器"（S3）和离线使用冲突。
- **"记住我"**：等于把设备密钥放回配置文件，已决不做（§13）。
- **"浏览器启动时自动弹出解锁"**：
  - 可以在 `onStartup` 时打开一个标签页（`openPopup` 需要有焦点的窗口，启动时是否可靠未核实），但打扰用户，而且并不减少输入。不建议。
  - 可以考虑的轻量替代：浏览器启动后，在工具栏图标上显示一个"已锁定"的小锁角标（`setBadgeText` 不需要权限）。
- **"系统闲置即锁"**：可以用 `chrome.idle` 的 `idle` 状态加一个可选项；现有的"距上次使用 Sixkey"计时已经覆盖了大部分需求。P2。

### 2.7 深色模式

**现状核查**
- **只跟随系统**：`styles.css` 用 `@media (prefers-color-scheme: dark)` 换一套 token。语言有手动切换，主题没有。
- **组件里还有 5 处单独的暗色规则**：`.btn.danger`、`.av`、`.mk-tile`、`.row.sel`、`.toast`。以后加手动切换时，这 5 处都要改，否则会出现局部不一致。
- **HTML 里没有 `<meta name="color-scheme" content="light dark">`**：`color-scheme` 只写在 CSS 里。CSS 生效前画布是白的，深色模式下可能闪一下白（未测，修起来很便宜）。
- **各页面一致**：弹窗和设置页共用同一套 token（截图 `popup-main-dark`、`options-security-dark`）；提示条的固定配色对比度够（16.5:1 / 12.3:1）。

**对比度（WCAG 2.x 计算值，[E6]）**
- 正文类文字都达到 AA：
  - `--muted`：5.1–7.2:1
  - 黄铜标签：5.4:1 / 8.6:1
  - 警告：4.88:1 / 7.37:1
  - 最后 5 秒的红字：5.66:1 / 6.72:1
- **不达标的地方**：
  - `--faint` 被当作文字用（"••• •••"占位）：2.34:1 / 2.47:1；
  - **输入框边框** `--line-2` 对表面色：1.51:1 / 1.59:1，低于 WCAG 1.4.11 要求的 3:1。深色设置页里输入框几乎看不见边（截图 `options-security-dark-pw-10.png`）；
  - 圆环里的秒数只有 8.5 px。

**建议**（S，P1）
1. 设置 › 外观：跟随系统 / 浅色 / 深色。选择存在 `localStorage`（与语言相同），首屏渲染前同步读取，避免闪烁。CSS 写成 `:root[data-theme=dark]` 加 `@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) }`，上面 5 处组件规则一起改。
2. 两个 HTML 都加 `color-scheme` meta。
3. 输入框边框提到 3:1，例如浅色 `#8E97A3`、深色 `#5A6370`，需要设计确认；占位文字改用 `--muted`；秒数字号 ≥ 9.5 px，或只在最后 10 秒显示。
4. 工具栏图标在深色浏览器主题下可能对比不足。Chrome 不能在 manifest 里按主题指定 action 图标 [未核实]，先观察，不做。

### 2.8 安全模式：用户怎么选

**原则**：不要再加一道首次运行问题。H5（SYNC-DESIGN §9.1、Z2）已经要问"这个配置文件会被他人使用、同步到厂商云，或由脚本/自动化工具控制吗？"，预设就是这一问的答案。

**两个预设，改动任一项后自动显示为"自定义"**（`mock-firstrun-*.png`）

| 项 | 标准（默认，H5 答"否"） | 共享 / 自动化（H5 答"是"） |
|---|---|---|
| 自动锁定 | 闲置 15 分钟 | **每次关闭 Sixkey 都锁定**（H5 原意） |
| 锁屏即锁 | 开 | 开 |
| 复制后 30 秒清除剪贴板 | 在设置页提示开启（要一次可选权限授权，**只能在设置页申请**：在弹窗里申请会关掉弹窗 [C15]） | 引导开启（H5 原意） |
| 验证码显示 | 显示 | **隐藏，点击直接复制**（§2.2） |
| 侧边栏模式（§2.1） | 可选 | 不提供 |
| 同步 | 可开启 | 开启前警告"不要在这类配置文件里开启"（H8、A3/A10） |
| 导出前重新输入主密码 | 始终开启（H3），**不属于预设** | 同左 |

- **不设"严格"档。** 它和"标准"的区别只在于闲置分钟数和剪贴板清除，用户单项调整即可（显示为"自定义"）。多一档就多一个要解释的选择。
- **首次运行的措辞**（在 H1 的设密码、确认恢复码之后，在添加第一个账户之前）：
  > **这个浏览器配置文件只有你在用吗？**
  > 会不会被别人使用、同步到指纹浏览器厂商的云端，或由脚本 / 自动化工具控制？
  > ◉ 只有我用（标准）：闲置 15 分钟或锁屏时锁定。
  > ○ 会被共享、云同步或脚本控制：每次关闭 Sixkey 都锁定，验证码默认隐藏，不建议在此开启同步。
  > ⓘ 以后可在 设置 › 安全 › 安全模式 中更改。
- 无新权限、无格式变化，**跟随 H5 一起做**，S，P0。

### 2.9 添加账户

**现状**
- 弹窗的"添加"页有 5 个入口，其中 4 个会跳到设置页（截图 `popup-add-light-pw-10.png`）。
- **弹窗里没有粘贴处理**：PLAN §9 写了"popup 支持 Ctrl+V 粘贴截图"，实际没实现。
- 设置页的文本框可以粘贴多条 `otpauth://`、迁移链接或图片，支持拖放和选文件。
- 去重按 secret + issuer + label，对重复项只显示一行计数。
- 添加后没有"去网站上验证"这一步。

**各种取码路径，按"方便程度 / 代价"排列**

| 路径 | 方便程度 | 权限 / 安全代价 | 能在哪里做 | 建议 |
|---|---|---|---|---|
| **粘贴**：链接、Base32 密钥，或剪贴板里的二维码截图 | 最高：网站上右键"复制图片"或系统截图，打开 Sixkey，按 Ctrl+V | 无。粘贴事件里的 `clipboardData` 来自用户手势，不需要 `clipboardRead`（Sixkey 现有代码已依赖这一点）[A-Q3][转录] | 弹窗、侧边栏、设置页 | **P0**：弹窗"添加"页顶部放粘贴区；列表页任意位置按 Ctrl+V 也直接进入确认页 |
| 扫描当前标签页可见区域（现有） | 高 | 无新增：靠 activeTab，只能看到可见部分，每秒最多 2 次 [C11] | 弹窗（点图标之后） | 保留为主按钮。改进：解码画面里**所有**二维码，不止第一个，多于一个时让用户选；找不到时提示"把二维码滚到可见区域再试，或改用粘贴、手动输入" |
| 拖放图片 / 选文件 | 中 | 无 | 设置页（弹窗里的文件选择框可能关掉弹窗 [未核实]） | 保持现状 |
| 手动输入 | 低，但必须有 | 无 | 弹窗、设置页 | 把算法、位数、周期收进"高级" |
| Google 身份验证器迁移码 | 批量时高 | 无 | 现有 | 保持 |
| 其他应用的导出文件 | 批量迁移时最高 | 不需要权限。加密格式的 KDF 决定能不能只用 WebCrypto 解开（PLAN §5"不引入第三方加密库"，CSP 不允许 wasm） | 设置页 | P1，见下表 |
| 屏幕区域（`getDisplayMedia`） | 低频：二维码在别的应用、视频会议或远程桌面里 | 不需要 manifest 权限 [未核实]；每次都弹系统选择器；在弹窗里会关掉弹窗 [C6][C7] | 设置页标签或侧边栏 | P2 |
| `desktopCapture` | 同上 | 安装警告"Capture content of your screen."[C3][复核] | — | 不做，`getDisplayMedia` 已够用 |
| 摄像头 | 低：纸质备份、手机屏幕 | 不需要 manifest 权限，但运行时要授权摄像头；在弹窗或侧边栏里请求会失败，必须先在扩展标签页里授权 [C16] | 设置页标签 | P2。注明"画面只在内存中解码" |
| 在页面上框选区域（Authenticator.cc 的做法：注入脚本画遮罩，再截图裁剪）[A8][转录] | 中 | 要 `scripting` 并改动网页，与"从不改动网页"冲突 | — | 不做。全可见区域解码加多码选择已经够用 |

**导入格式**（[A1–A7][A16–A17]，除 Aegis 一行为 [复核] 外，其余为 [转录]）

| 应用 | 明文导出（建议支持） | 加密导出 | 只用 WebCrypto 能否解开 |
|---|---|---|---|
| Aegis | JSON、TXT（otpauth）、HTML | scrypt N=2¹⁵ r=8 p=1，加 AES-256-GCM | **不能** |
| 2FAS | `.2fas` JSON | PBKDF2-SHA256 1 万次，加 AES-GCM（Android 源码；iOS 未核实） | **能** |
| ente Auth | TXT（otpauth 每行一条） | Argon2id，加 XChaCha20-Poly1305 | 不能 |
| Bitwarden（密码管理器） | JSON / CSV（`login.totp`） | 沿用账户 KDF；PBKDF2 型能解，Argon2id 型不能，绑定账户的导出不能 | 部分能（注意它只做 HKDF-expand，要手写一步 HMAC，未核实） |
| 1Password | CSV（"One-time password"列）、1PUX | 无（导出就是明文） | — |
| Proton Pass / Proton Authenticator | CSV、未加密 ZIP / JSON | OpenPGP 口令加密 / Argon2id，加 AES-GCM | 不能 |
| andOTP、FreeOTP+、Stratum（URI 列表）、Authenticator.cc（.txt / .json）、KeePassXC（CSV 的 TOTP 列）、Apple 密码（CSV 的 OTPAuth 列，列名未核实） | 有 | andOTP：PBKDF2，加 AES-GCM（能解）；Stratum 当前格式与 Authenticator.cc 用 Argon2id（不能解） | 见左 |
| Microsoft Authenticator、Authy | **没有导出** | — | 只能到各网站重新绑定（帮助页说明） |

- **建议**：支持所有明文格式，以及 2FAS、andOTP、Bitwarden-PBKDF2 三种加密格式。
- 对 Aegis、ente、Proton 的加密文件，给出"先在原应用导出未加密文件，导入 Sixkey 后删除该文件"的说明。
- **不要为 scrypt 或 Argon2 引入库**：这会与 PLAN §5 和"CSP 不加 `wasm-unsafe-eval`"冲突。

**添加流程设计**（`mock-add-*.png`）
1. **第 1 步（弹窗内）**：顶部是粘贴区，自动获得焦点，接受 Ctrl+V 粘贴图片、链接或密钥；下面依次是"扫描此页面上的二维码"（主按钮）、"上传图片"（跳设置页）、"手动输入"、"从其他应用导入"（跳设置页）。
2. **第 2 步（确认）**：
   - 显示 issuer、label、字母头像、位数 / 周期 / 算法，名称可以改；
   - 显示"在这些网站上排在最前"的域名建议，用户确认后写入 `domains`（§2.10）；
   - 显示去重结果；
   - 主按钮是"**添加并复制验证码**"。
3. **"验证码能用吗"这一步**：Sixkey 自己无法验证（不联网）。真正的验证是网站的绑定页要求输入当前验证码，"添加并复制"正好把这一步变成一次粘贴。确认页写明："下一步：在网站上输入这个验证码完成绑定。网站说验证码错误时，先检查电脑时间是否自动校准。"没有找到任何竞品有应用内的"测试验证码"步骤 [A-Q6][转录]。
4. **去重规则**：
   - 比较**解码后的密钥字节**（Aegis 的做法，不受大小写、填充、空格影响）[A15][转录]。
   - 同密钥、同 issuer：跳过，并提示"已存在"。
   - 同密钥、不同名称：提示"这个密钥已在 X 中，可能是重复扫描"。
   - 同 issuer + label、不同密钥：提示"可能是重新绑定"，让用户选"保留两个"或"替换（旧的进回收站）"。**永不自动替换**（永不丢数据）。
5. **错误状态**：
   - 没找到二维码（附上面的提示）；
   - 迁移码批次不全（现有，会列出缺第几张）；
   - HOTP（保存并标注）；
   - 密钥非法；
   - 位数或周期不支持；
   - 图片无法读取。
6. **图标**：
   - 保持现有的字母头像：零网络，零授权问题。
   - **永不去取网站图标**：Bitwarden 的图标服务会把主机名发给服务器，1Password 会带上 IP 和 UA [A13][转录]。
   - 想内置品牌图标的话：simple-icons 是 CC0，3466 个 SVG 共约 5 MB，但它的免责声明要求使用者自行取得商标许可 [A10][转录]；aegis-icons 只有部分是 CC0；2FAS 的图形不开源 [A11][A12][转录]。
   - 结论：P2，先做法律确认，最多只放约 100 个常用服务的子集，并且懒加载。

### 2.10 当前网站优先

**现状与问题**（`core/match.ts`，[E5] 用同一逻辑实测）
- **规则**：命中 `domains` 后缀，或者 issuer 规范化后等于主机名里的某一段，或者（5 个字符以上时）是主机名的子串。
- **误报，被标成"此网站"的仿冒域名**：
  - `google.evil-login.ru`
  - `secure-google-verify.com`
  - `paypal-account-check.xyz`
  - `github.com.attacker.io`
- **漏报**：
  - `x.com`（X / Twitter）
  - `login.live.com`（Microsoft）
  - `signin.aws.amazon.com`（issuer 写成"Amazon Web Services"时）
  - `signin.aliyun.com`（"阿里云"：规范化会去掉所有非 a-z0-9 字符，**中文 issuer 永远匹配不上**）
- **`domains` 实际上用不上**：模型里有这个字段（最多 16 个），但导入从不填，编辑框也没有这一项，所以现在所有匹配都靠猜。
- **"此网站"标签在钓鱼页上会强化用户的错误判断**。现在它只影响排序；以后要是做填入（§2.11），就会变成真正的风险。

**读取当前网址需要什么权限**
- `tab.url` "is only present if the extension has the "tabs" permission or has host permissions for the page"[C11][转录]。
- `tabs` 的警告是"Read your browsing history."[C3][复核]。
- activeTab 没有警告，点击图标或按扩展快捷键时授予 [C1][复核]。**现有做法是对的。**

**设计**
1. **两级匹配。**
   - **已登记**：主机名等于某个已登记域名，或是它的子域名。这时显示"此网站"标签、大号验证码，按 Enter 复制。
   - **名称猜测**：放进单独的"可能相关"小节，不带标签，旁边有一个按钮："记住：github.com 属于此账户"。
2. **登记域名时不打包完整的公共后缀列表**（335 KB，gzip 后 90 KB，每周变几次 [B11][转录]）。
   - 把当前主机名及其各级父域名作为选项给用户选（例如 `accounts.google.com` / `google.com`）。
   - 拒绝单段名称。
   - 用户选中的是常见的多段公共后缀（内置约 100 条，如 `co.uk`、`com.cn`、`github.io`、`vercel.app`）时给出警告。
3. **添加时建议域名**：内置一张 issuer→域名表。
   - 来源是 2fa.directory（MIT 协议，要署名；v3 的 `totp.json` 262 KB，1288 条）[B13][转录]。
   - 只保留 issuer、domain、additional-domains 三列，约 40 KB [估算]。
   - 只在确认页懒加载。
   - 它会顺带解决同一服务多个域名的情况，例如 Microsoft 的 `live.com` 和 `microsoftonline.com`（Bitwarden 也内置了 22 组等价域名 [B12][转录]）。
4. **中文 issuer**：规范化改为保留 Unicode 字母和数字（`\p{L}\p{N}`），并依靠已登记的域名。
5. **编辑框加一栏"网站"**（chips）。
6. **搜索**：已有"直接打字即搜"。扩展为同时匹配域名和分组。
7. **快捷键**：manifest 里加 `"commands": {"_execute_action": {"suggested_key": {"default": "Alt+Shift+K"}}}`。
   - `commands` 不是权限，`check-dist` 也不拦它。
   - 快捷键同样授予 activeTab [C1][复核]。
   - 建议的快捷键与别的扩展冲突时，Chrome 不会自动分配，用户需在 `chrome://extensions/shortcuts` 里自己设。
8. **一键复制**：
   - 已有：Enter 复制选中项。
   - 新增一个可选项（默认关）："打开时，如果当前网站恰好对应一个已登记账户，自动复制它的验证码"。打开后，快捷键 + 粘贴两下就完成。
9. **常用 / 置顶**：需要给 `Entry` 新增字段，而同步合并要给它一个 HLC 寄存器，涉及格式和同步。P2；在那之前用手动拖到最上面。
10. **工具栏角标"本网站有账户"：不做。**
    - 要知道网址，必须有 `tabs`（警告"读取浏览记录"）或 host 权限。
    - 或者用 `declarativeContent`：它没有警告，但只能换图标或显示图标，**不能设角标文字**，只匹配顶层 URL [C13][转录]。而且规则（也就是"用户在哪些网站开了 2FA"）会长期存放在配置文件的 `Extension Rules` 数据库里，在加密库之外，锁定时也能读到，复制走配置文件的人也能拿到 [C14][转录；是否明文未核实]。
    - 这与零追踪的精神冲突：账户清单本身就是隐私数据（MCP 调研 C2）。

**工作量与优先级**：S–M。两级匹配和域名编辑是 **P0**；快捷键和建议表是 P1。不改加密格式（`domains` 已在模型里）。

### 2.11 像 1Password 那样自动填码？

**三种做法**

| 做法 | 权限与安装警告 | 风险 | 与承诺 |
|---|---|---|---|
| 永不 | 无 | 无 | 全部保持 |
| **点按填入**：只在用户于 Sixkey 自己的界面里点"填入"时执行 | 新增 `scripting`，无警告 [C3][复核]；借用已有的 activeTab | 见下 | 要改 PRIVACY 的"No content scripts: it never reads or changes the web pages you visit"；要重新解释 §13 F20（F20 否决的是内容脚本 + host 权限的自动填码） |
| 全自动：内容脚本或 `<all_urls>` | 警告"Read and change all your data on all websites" | 页面内注入的填充菜单正是点击劫持攻击的对象；网页可以接触到的攻击面 | 违背"最少权限"和"不读网页"。**永不** |

**"点按填入"的最小做法**（如果所有者决定要做）
1. **触发**：只能来自 Sixkey 的弹窗或侧边栏按钮，不在页面里放任何界面。
   - DOM 式扩展点击劫持（Tóth，DEF CON 33）攻击的是扩展注入页面的填充菜单：11 款密码管理器里有 10 款中招，9 款连 TOTP 也泄露，作者说"The safest solution is to display a new popup window"[B1][复核]。
   - 截至 2026-01，他仍把 1Password 与 LastPass 列为未修复 [B1][复核]；1Password 称已提供可选的缓解措施 [B2][转录]。
2. **两步执行**：
   - 先用 `executeScript`（ISOLATED world）**探测**，拿回 `documentId` 和候选输入框；
   - 再用 `target.documentIds: [id]` **填入**（Chrome 106+）。文档已换时直接报错，不会写到别的页面 [C20][C21][转录]。
   - 注入的函数里再检查一次 `location.origin`。
3. **只在已登记域名上填**（§2.10 的第一级）：主机名必须等于或属于账户的 `domains`，从不凭名称猜测。
   - 这会带来复制粘贴给不了的**防钓鱼性质**：在仿冒域名上"填入"按钮不可用，用户会察觉不对。TOTP 本身仍不防钓鱼（NIST SP 800-63B-4 [B9]），用户仍可以手动复制。
4. **识别输入框**，按顺序：
   - `autocomplete="one-time-code"`（WHATWG 标准）[B8][转录]；
   - Bitwarden 那样的关键词表（`otp`、`totp`、`mfa`、`2fa`、`onetimecode`…）[B3][转录]；
   - 每格一位数字的拆分输入框，逐格填写；
   - 只填 `text`、`tel`、`number` 类型，不填 `password`；
   - 派发 `input` 和 `change` 事件，**不自动提交**。
5. **做不到的部分**：
   - **跨域 iframe**：activeTab 只授予主框架的 origin，源码表明子框架不会被授予 [C10][C21][转录]；有一位用户报告说在 Chrome 里可行，结论冲突，未实测。遇到时回落为复制。
   - **封闭的 shadow DOM**：需要 `chrome.dom`，在 `executeScript` 里能不能用，未核实。
   - **晚出现的输入框**（SPA）：需要用户再点一次。
   - **页面脚本能读到填进去的值**：与粘贴一样。
   - **浏览器 AI 代理也能从 DOM 读到**：与粘贴相同。Sixkey 没有外部请求通道，所以代理无法"请求填入"（MCP 调研的结论不变）。

**竞品**
- 1Password：要求"全部网站"权限，登录后自动填入一次性密码 [B6][转录]。
- Bitwarden：要求全部网站权限；默认在自动填充后把 TOTP 复制到剪贴板；用快捷键填 TOTP；TOTP 是付费功能 [B4][转录]。
- Proton Pass："Copy & fill in"，付费功能 [B5][转录]。
- Apple 密码与 iCloud 密码扩展：填入验证码 [B14][转录]。
- Google 密码管理器：帮助页只提密码和通行密钥 [未核实]。
- Microsoft Authenticator：2025-07 停止自动填充 [B15][转录]。
- Authy：没有浏览器端。
- **指纹浏览器厂商为什么推销自动填码**：AdsPower 原话是"By simulating human typing, this auto-fill feature mitigates the chances of arousing suspicions of antifraud systems"[B7][转录]。用途是规避风控，不在 Sixkey 的范围内。

**建议：不做全自动；"点按填入"交所有者决定，建议暂缓**（M8 之后，并且要等 §2.10 的域名登记先上线）。
- 理由：收益是每次登录少按一次 Ctrl+V，外加在已登记域名上的防钓鱼提示；代价是一个新权限、改写隐私承诺、要维护各种网站的兼容性，还有支持成本。
- 若做：设为可选项，默认关闭；必须有 `documentId` 锁定、已登记域名两项检查；`check-dist` 只为 `scripting` 放开白名单；PRIVACY 改为"只有你点'填入'时，Sixkey 才读取当前页面的输入框属性并写入验证码"。

### 2.12 其他（按优先级）

**P0**
- **首次运行顺序要跟上 H1**：欢迎页现在仍有"不设密码直接开始"（截图 `popup-welcome-*`）。
  - 顺序应为：设主密码 → 显示并确认恢复码 → H5 那一问（§2.8）→ 添加第一个账户。
  - 最后一步直接给出粘贴区和扫描按钮，总共不超过 4 屏。
- **错误文案**：弹窗出错页直接显示内部错误码（`errorBody` 里的 `TypeError` 等）。要改为"发生了什么 + 下一步"，例如"无法读取本机数据：点重试；仍失败请到 设置 › 备份 从备份恢复"。

**P1**
- **读屏与键盘**：
  - 倒计时圆环是 `aria-hidden`，剩余秒数不会被朗读；
  - 列表行是 `role="option"`，里面却嵌着按钮（交互元素嵌套）；
  - 输入框边框对比度见 §2.7；
  - 可以加一个 `?` 键打开快捷键说明。
- **同步指示**（SYNC §6 P1）：同步状态必须在首个验证码之后才读取或更新，不能拖慢首帧。§2.3 的预算会覆盖它。
- **空状态**：在空列表插图下面直接放"粘贴"和"扫描本页"两个按钮。
- **语言**：zh-TW、zh-HK 用户现在拿到的是简体（`resolveLang`）。语言菜单里注明"简体"；繁体等有需求再做。暂不需要 RTL，CSS 用的是 left/right 这类物理属性，以后真要支持再改。

**P2**
- **锁定或异常的通知**：`notifications` 权限有警告"Display notifications"[C3][复核]，所以继续用角标加横幅（SYNC §3.11 已用角标显示待批准数）。
- **减少动态效果**：全局的 `prefers-reduced-motion` 规则已经覆盖，表盘动画也遵守。保持。

---

## 3. 与同步里程碑并行的排期

原则：
- 不占用 Phase 0.x 的预算（1 M + 7 S，不加权限）；
- 不阻塞 M1–M8；
- 新权限一律排在 M8 之后；
- 涉及 `core/storage` 的改动要和 M2 协调。

| 阶段 | 内容 | 与现有计划的关系 | 规模 |
|---|---|---|---|
| **U1（现在，与 H1–H8、M1–M4 并行）** | 性能 O1–O3、O5–O6 和 CI 预算（计数类做硬门槛）；匹配分级 + 域名编辑 + 中文 issuer 修正；安全模式预设；密度 / 隐藏验证码 / 按名称排序；主题手动切换 + `color-scheme` meta + 对比度；弹窗内粘贴；快捷键（`commands`）；错误文案 | **预设随 H5 一起做**，同一个界面；**首次运行顺序随 H1**。没有新权限，没有格式变化，主要改动在 `popup/`、`options/`、`ui/`、`core/match.ts` | 1 M + 若干 S |
| **U1b（与 M2 一起或在它之前）** | O4：解锁时不再扫描快照；O2 的单次读取服务调用 | M2 会改 `VaultStore`（钩子、`applyRemote`），**由 M2 的实现者一起做，或在 M2 开始前合入**，避免冲突 | S |
| U2（与 M6 界面一起） | 同步指示不阻塞首帧；把同步状态纳入 §2.3 的预算测试 | M6 | S |
| U3（M8 之后，Phase 2 上架前后） | 导入其他应用的文件（明文 + 2FAS / andOTP / Bitwarden-PBKDF2）；issuer→域名建议表（附 2fa.directory 署名） | 不需要权限 | M |
| U4（M8 之后，"新权限"组） | 侧边栏模式（`sidePanel`，`check-dist` 白名单改动）；设置页里的摄像头和屏幕区域取码 | 侧边栏没有安装警告；摄像头和屏幕是运行时授权 | M |
| U5（Phase 3） | PRF 解锁（在独立窗口里调用，每个安装各用随机 salt） | Phase 3 | M |
| 待决定 | "点按填入"（需要 U1 的域名登记已上线）；网页版（Phase 3 之后再评审） | §4 | M / L |

---

## 4. 需要所有者决定的事

| # | 问题 | 建议 |
|---|---|---|
| 1 | 网页版：做不做？ | **不做完整网页版**。MetaMask 不是先例；Dashlane 已因同一个问题关闭网页登录。推迟到 Phase 3 之后，届时最多评估"受限只读应急查看页"，并单独做安全评审。 |
| 2 | 侧边栏模式：接受新增 `sidePanel` 权限吗？ | **接受**。它没有安装警告，排在 M8 之后；默认仍是弹窗；"共享/自动化"预设下不提供。 |
| 3 | 点按填入：接受 `scripting` 权限、改 PRIVACY 文案、重新解释 §13 F20 吗？ | **暂不做**。如果要做：只在已登记域名上，默认关闭，按 `documentId` 锁定，排在 M8 和域名登记之后。 |
| 4 | "此网站"只给已登记的域名，名称猜测降为"可能相关"？ | **同意**。代价是第一次使用时要点一次"记住此网站"，换来的是钓鱼页不再被标为"此网站"。 |
| 5 | 安全模式只设两个预设（标准、共享·自动化），首次运行复用 H5，"共享"预设默认隐藏验证码、不提供侧边栏？ | **同意**。 |
| 6 | 加密导入只支持 WebCrypto 能解的格式，不为 scrypt / Argon2 引入库？ | **同意**。Aegis、ente、Proton 的加密文件请用户先导出明文。 |

---

## 5. 来源

抓取时间均为 2026-10-16。

### C：Chrome / Chromium
| 编号 | 来源 | 标记 |
|---|---|---|
| C1 | activeTab 文档（触发方式："Executing an action / … keyboard shortcut from the commands API"；"revoked when the user navigates away or closes the tab"） https://developer.chrome.com/docs/extensions/develop/concepts/activeTab | [复核] |
| C2 | sidePanel API 参考（"sidePanel" 权限；Chrome 114+；`open()` "may only be called in response to a user action"，Chrome 116） https://developer.chrome.com/docs/extensions/reference/api/sidePanel ；侧边栏指南 https://developer.chrome.com/docs/extensions/develop/ui/create-a-side-panel | [复核] / [转录] |
| C3 | 权限列表（tabs："Read your browsing history."；desktopCapture："Capture content of your screen."；clipboardRead / Write；nativeMessaging；notifications；scripting、sidePanel、declarativeContent、idle、offscreen 无警告） https://developer.chrome.com/docs/extensions/reference/permissions-list | [复核] |
| C4 | 权限警告（"the extension will be disabled until the user accepts the new permission"；activeTab "does not display a permission warning"） https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings | [复核] |
| C5 | storage API（session："cleared if the extension is disabled, reloaded, updated, and when the browser restarts"） https://developer.chrome.com/docs/extensions/reference/api/storage | [复核] |
| C6 | 屏幕捕获指南（"capture video from the popup causes focus to move and the popup to close"） https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture | [复核] |
| C7 | Chromium 提交 4b8e494ea3 "[Extensions] Dismiss extension popup when security dialog is shown"（"force-closed under all circumstances when a security dialog is present"） https://github.com/chromium/chromium/commit/4b8e494ea3 | 内容 [复核]；属于 M156 [转录] |
| C8 | `openPanelOnActionClick` 时不授予标签页权限：https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/extension_action_runner.cc ；跟踪问题 https://issues.chromium.org/issues/40904917 | [转录]，并经 [E2] 实测 |
| C9 | `openPopup()`"should never be considered a user action"：https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/ui/extensions/extension_action_view_model.cc | [转录]，并经 [E3] 实测 |
| C10 | 同源导航保留授权，"sub-frames don't get granted"：https://raw.githubusercontent.com/chromium/chromium/main/extensions/browser/permissions/active_tab_permission_granter.cc | [转录]；同源保留经 [E2] 实测 |
| C11 | tabs API（`url` 只在有 tabs 或 host 权限时出现；`captureVisibleTab` 需要 activeTab，每秒 2 次） https://developer.chrome.com/docs/extensions/reference/api/tabs ；windows API https://developer.chrome.com/docs/extensions/reference/api/windows | [转录] |
| C12 | commands API（`_execute_action`；最多 4 个；必须含 Ctrl 或 Alt） https://developer.chrome.com/docs/extensions/reference/api/commands | [转录] |
| C13 | declarativeContent（ShowAction / SetIcon，不能设角标文字；只匹配顶层 URL；无需 host 权限） https://developer.chrome.com/docs/extensions/reference/api/declarativeContent | [转录] |
| C14 | 规则存在 `<profile>/Extension Rules`：https://raw.githubusercontent.com/chromium/chromium/main/extensions/browser/api/declarative/rules_cache_delegate.cc | [转录]；"明文"[未核实] |
| C15 | 权限请求会关闭弹窗：https://issues.chromium.org/issues/41452827 ；https://issues.chromium.org/issues/40721470 | [转录] |
| C16 | "request web permission will also fail in the popup page and side panel page"（2024-01-09） https://groups.google.com/a/chromium.org/g/chromium-extensions/c/V09VMCLzvWM | [转录] |
| C17 | 弹窗关闭行为的两次变化：https://github.com/chromium/chromium/commit/ec62e3daab （M126）；https://github.com/chromium/chromium/commit/eb80440c5a （M133）。文件选择框关闭弹窗只见旧的 chromium-bugs 摘要（Issue 114898），没有可用链接 | [转录]；文件选择框 [未核实] |
| C18 | BarcodeDetector 只在 macOS、ChromeOS、Android：https://developer.chrome.com/docs/capabilities/shape-detection ；品牌版 Linux / Windows 编译开关：https://chromium.googlesource.com/chromium/src/+/refs/heads/main/services/shape_detection/features.gni | [转录] |
| C19 | 品牌版 Chrome 137+ 忽略 `--load-extension`：https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY ；Chrome for Testing：https://github.com/GoogleChromeLabs/chrome-for-testing ；https://playwright.dev/docs/chrome-extensions | [转录] |
| C20 | scripting API（`documentIds`、`world`，Chrome 106+ / 95+） https://developer.chrome.com/docs/extensions/reference/api/scripting | [转录] |
| C21 | allFrames 行为：https://raw.githubusercontent.com/chromium/chromium/main/extensions/browser/scripting_utils.cc ；https://raw.githubusercontent.com/chromium/chromium/main/extensions/renderer/extension_injection_host.cc ；与之矛盾的用户报告：https://bugzilla.mozilla.org/show_bug.cgi?id=1839200 | [转录] |
| C22 | idle API https://developer.chrome.com/docs/extensions/reference/api/idle ；Linux 实现 https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/base/idle/idle_linux.cc | [转录] |
| C23 | W3C public-webauthn 2023-12：Chrome M122 起扩展可按 host 权限声明父域名（直到 eTLD+1）为 RP ID；`clientDataJSON` 里是扩展的 origin https://lists.w3.org/Archives/Public/public-webauthn/2023Dec/0078.html | [复核] |
| C24 | 密码管理器排除扩展 scheme：https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/password_manager/chrome_password_manager_client.cc ；禁止访问其他扩展的页面：https://chromium.googlesource.com/chromium/src/+/main/extensions/common/permissions/permissions_data.cc | [转录] |
| C25 | action API：`openPopup` 从 Chrome 127 起对所有扩展开放 https://developer.chrome.com/docs/extensions/reference/api/action | [转录] |

### F：各浏览器
| 编号 | 来源 | 标记 |
|---|---|---|
| F1 | Edge 侧边栏（已知问题：切回原标签页不自动重新显示） https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/sidebar ；Edge 发布说明 https://learn.microsoft.com/en-us/deployedge/microsoft-edge-relnote-stable-channel | [转录] |
| F2 | Opera 135.0.5973.123（"Added support for the chrome.sidePanel API"） https://blogs.opera.com/desktop/2026/09/opera-135-0-5973-123-stable-update/ | [复核] |
| F3 | Opera 137，内核 Chromium 153.0.8010.55 https://blogs.opera.com/desktop/2026/10/opera-137-stable/ | [转录] |
| F4 | Brave 1.97.57，内核 Chromium 155 https://brave.com/latest/ ；侧边栏无入口 https://github.com/brave/brave-browser/issues/31334 | [转录] |
| F5 | Vivaldi 博客与快照更新日志（VB-120826） https://vivaldi.com/blog/desktop/ | [转录] |
| F6 | Atlassian 收购 The Browser Company https://www.atlassian.com/blog/announcements/atlassian-acquires-the-browser-company ；Arc 维护状态只见摘要 | [转录] / [摘要] |
| F7 | 360 安全浏览器（Chromium 132）https://browser.360.cn/se/ ；360 极速浏览器（Chromium 86）https://browser.360.cn/ee/ ；QQ https://appcenter.browser.qq.com ；搜狗 https://sogou.browser.qq.com | [转录] |
| F8 | Multilogin（Mimic 154）https://multilogin.com/release-notes/ ；GoLogin（Orbita 148）https://gologin.com/blog/product-and-company-updates/ ；AdsPower（约 150）https://www.adspower.com/tc/blog/686 ；Dolphin（138）https://dolphin-anty.com/blog/en/dolphin-anty-updates/ | [转录] / [摘要] |
| F9 | MDN BCD（sidebar_action、sidePanel、storage.session、idle）https://github.com/mdn/browser-compat-data/tree/main/webextensions/api ；Firefox offscreen WONTFIX https://bugzilla.mozilla.org/show_bug.cgi?id=1807830 ；Safari 打包 https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari | [转录] |

### W：网页版相关
| 编号 | 来源 | 标记 |
|---|---|---|
| W1 | MetaMask："There are only two forms of MetaMask wallet: browser extension and mobile app." https://support.metamask.io/stay-safe/safety-in-web3/how-do-i-recognize-the-real-metamask-/ | [复核] |
| W2 | MetaMask 社交登录（Shamir 份额、密码、限速、"The only instance where a full SRP exists is on your device"） https://support.metamask.io/configure/wallet/social-login/ ；发布文章 https://metamask.io/news/introducing-metamask-social-login | [复核] / [转录] |
| W3 | MetaMask Embedded Wallets（2026-06-02） https://metamask.io/news/embedded-wallets-developer-platform ；Consensys 收购 Web3Auth 只见摘要 | [转录] / [摘要] |
| W4 | Dashlane：2025-10-01 起必须用扩展登录；"no guarantee that what you see in the browser was genuinely delivered by Dashlane"（更新于 2026-10-14） https://support.dashlane.com/hc/en-us/articles/26994895773842 | [复核] |
| W5 | 1Password 安全白皮书 A.1（网页客户端的风险、钓鱼、"Use (code signed) native clients"） https://agilebits.github.io/security-design/leopard.html ；员工论坛回复"We have no way to detect that" https://1password.community/discussion/comment/531737 | [复核] / [摘要] |
| W6 | Bitwarden 安全白皮书（网页客户端依赖 TLS）https://bitwarden.com/help/bitwarden-security-white-paper/ ；安全 FAQ https://bitwarden.com/help/security-faqs/ | [转录] |
| W7 | Proton 2019（"web apps provide fewer security guarantees"） https://proton.me/blog/cryptographic-architecture-response | [转录] |
| W8 | ente Auth FAQ（auth.ente.com 用于确认验证码是否存在） https://ente.com/help/auth/faq ；网页端只读（源码） https://github.com/ente-io/ente/tree/main/web/apps/auth/src | [复核] / [转录] |
| W9 | Cloudflare 2025-10-16（SRI 的局限、WAICT） https://blog.cloudflare.com/improving-the-trustworthiness-of-javascript-on-the-web/ ；WAICT 原型 https://hacks.mozilla.org/?p=48312 | [转录] |
| W10 | WEBCAT（Freedom of the Press Foundation，2026-08-06，Firefox alpha） https://freedom.press/tech/news/webcat-a-tamper-evident-seal-for-the-open-web/ ；https://webcat.tech | [转录] |
| W11 | Meta Code Verify（2022-03-10，2023-06 更新） https://engineering.fb.com/2022/03/10/security/code-verify/ | [转录] |
| W12 | Isolated Web Apps："IWAs are supported only on ChromeOS." https://support.google.com/chrome/a/answer/9367354 ；白名单政策 https://developer.chrome.com/docs/iwa/allowlist | [复核] / [转录] |
| W13 | Service Worker 规范（24 小时后绕过缓存检查更新）https://w3c.github.io/ServiceWorker/ ；Clear-Site-Data https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Clear-Site-Data | [转录] |
| W14 | file:// 是安全上下文 https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts ；file:// 下模块被 CORS 拦截 https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules ；共用 localStorage 等行为为子代理在 Chrome 155 上实测（测试页在临时目录 `…/scratchpad/ux/research/subagent-files/filetest/`） | [转录] |
| W15 | Bitwarden "Log in with device" https://bitwarden.com/help/log-in-with-device/ ；清除 cookie 后变成新设备 https://bitwarden.com/help/new-device-verification/ | [转录] |
| W16 | 1Password 白皮书：6 字符 CPace 设备配对 https://agilebits.github.io/security-design/passkeySSO.html | [转录] |
| W17 | LastPass 2026-01-20 钓鱼通告 https://blog.lastpass.com/posts/new-phishing-campaign-targeting-lastpass-customers | [转录] |
| W18 | Google 身份验证器帮助页（"encrypts … in transit and at rest"） https://support.google.com/accounts/answer/1066447 | [转录] |
| W19 | Microsoft Authenticator 备份（不能跨平台恢复） https://support.microsoft.com/en-us/account-billing/back-up-account-credentials-in-microsoft-authenticator-bb939936-7a8d-4e88-bc43-49bc1a700a40 | [转录] |
| W20 | Authy 桌面版 2024-03-19 停止服务 https://www.twilio.com/en-us/changelog/end-of-life--eol--of-twilio-authy-desktop-apps | [转录] |
| W21 | Signed Exchanges（证明来源而不论传输途径；最长有效 7 天） https://web.dev/articles/signed-exchanges | [转录] |

### U：解锁相关
| 编号 | 来源 | 标记 |
|---|---|---|
| U1 | MDN BCD：PRF 在 Chrome 116 加入 https://github.com/mdn/browser-compat-data/blob/main/api/CredentialsContainer.json | [转录] |
| U2 | Corbado "Passkeys PRF"（数据截至 2026-08；Windows Hello 要 KB5077181 + Chrome / Edge 147+；Chrome 配置文件通行密钥不支持 PRF；GPM 支持） https://www.corbado.com/blog/passkeys-prf-webauthn | [复核]，厂商说法 |
| U3 | Bitwarden "Log in with passkeys"（"Chrome profiles are not" PRF-capable；Linux 需弹出窗口） https://bitwarden.com/help/login-with-passkeys/ | [转录] |
| U4 | Windows Hello 在创建时不传 PRF 就不报告支持 https://github.com/bitwarden/clients/pull/21998 | [转录] |
| U5 | Bitwarden "Unlock with PIN"（"Using a PIN can weaken the level of encryption…"；5 次失败后登出；浏览器重启后要求主密码） https://bitwarden.com/help/unlock-with-pin/ | [复核] |
| U6 | Proton Pass PIN（"after three failed access attempts … log in again"） https://proton.me/support/proton-pass-pin ；PIN 由服务器核对（源码） https://github.com/ProtonMail/WebClients/tree/main/packages/pass/lib/auth/lock | [复核] / [转录] |
| U7 | Bitwarden 生物识别需要桌面应用 https://bitwarden.com/help/biometrics/ | [转录] |
| U8 | 1Password 浏览器扩展与桌面应用的关联 https://support.1password.com/connect-1password-browser-app/ | [转录] |
| U9 | Bitwarden vault timeout（Edge、ChromeOS 上"浏览器重启"的例外） https://bitwarden.com/help/vault-timeout/ ；浏览器端默认"浏览器重启时" https://raw.githubusercontent.com/bitwarden/clients/main/apps/browser/src/background/main.background.ts | [转录] |
| U10 | WECG secure-storage 提案 https://github.com/w3c/webextensions/blob/main/proposals/secure-storage.md | [转录] |
| U11 | macOS 上关掉最后一个窗口后 Chrome 继续运行 https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/app_controller_mac.mm | [转录] |
| U12 | 公开的 Bitwarden PIN 爆破工具 https://github.com/jorianwoltjer/bitwarden-pin-bruteforce | [转录] |
| U13 | YubiKey 5 的 hmac-secret 支持 https://docs.yubico.com/hardware/yubikey/yk-tech-manual/yk5-apps-fido.html | [转录] |

### A：添加与导入
| 编号 | 来源 | 标记 |
|---|---|---|
| A1 | Aegis `docs/vault.md`（scrypt N=2¹⁵ r=8 p=1；AES-256-GCM；可以明文保存） https://github.com/beemdevelopment/Aegis/blob/master/docs/vault.md ；Aegis README（只有 Android、不联网） https://github.com/beemdevelopment/Aegis | [复核] / [转录] |
| A2 | 2FAS：PBKDF2 1 万次 https://github.com/twofas/2fas-android/blob/main/core/cipher/src/main/java/com/twofasapp/cipher/backup/internal/BackupKeyGeneratorPbkdf.kt ；AES-GCM https://github.com/twofas/2fas-android/blob/main/core/cipher/src/main/java/com/twofasapp/cipher/internal/CipherAes.kt | [转录] |
| A3 | ente 导出（Argon2id + XChaCha20-Poly1305） https://ente.com/help/auth/migration/export | [转录] |
| A4 | Bitwarden 导出格式 https://bitwarden.com/help/export-your-data/ ；加密导出沿用账户 KDF https://github.com/bitwarden/clients/blob/main/libs/tools/export-vault-core/src/services/base-vault-export.service.ts | [转录] |
| A5 | 1Password 导出是明文 https://support.1password.com/export/ ；1PUX 里的 TOTP 字段 https://github.com/bitwarden/clients/blob/main/libs/importer/src/importers/onepassword/onepassword-1pux-importer.ts | [转录] |
| A6 | Proton Authenticator 加密导出（Argon2id） https://github.com/protonpass/proton-pass-common/blob/main/proton-authenticator/src/entry/password_exporter.rs ；Proton Pass（OpenPGP）https://github.com/ProtonMail/WebClients/blob/main/packages/pass/lib/crypto/utils/export.ts | [转录] |
| A7 | andOTP 加密格式 https://github.com/beemdevelopment/Aegis/blob/master/app/src/main/java/com/beemdevelopment/aegis/importers/AndOtpImporter.java ；官方 WebDecrypt 只用 crypto.subtle https://github.com/andOTP/WebDecrypt/blob/master/js/decrypt.js | [转录] |
| A8 | Authenticator.cc（scripting + 框选 + captureVisibleTab） https://github.com/Authenticator-Extension/Authenticator ；2FAS 扩展 https://github.com/twofas/2fas-browser-extension | [转录] |
| A9 | Bitwarden 扩展整页截图取码 https://github.com/bitwarden/clients/blob/main/apps/browser/src/vault/popup/services/browser-totp-capture.service.ts | [转录] |
| A10 | simple-icons（CC0 + 免责声明） https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md | [转录] |
| A11 | aegis-icons（部分 CC0） https://github.com/aegis-icons/aegis-icons | [转录] |
| A12 | 2FAS 图形不开源 https://github.com/twofas/2fas-android | [转录] |
| A13 | Bitwarden 网站图标服务 https://bitwarden.com/help/website-icons/ ；1Password rich icons https://support.1password.com/rich-icons-privacy/ | [转录] |
| A14 | 各家的视图、隐藏、排序设置：Aegis https://github.com/beemdevelopment/Aegis ；2FAS https://github.com/twofas/2fas-android ；ente https://github.com/ente-io/ente ；Proton Authenticator https://github.com/protonpass/android-authenticator ；Stratum https://github.com/stratumauth/app ；Authenticator.cc https://github.com/Authenticator-Extension/Authenticator 。所有者截图中的应用未能确认 | [转录] |
| A15 | 去重：Aegis https://github.com/beemdevelopment/Aegis/blob/master/app/src/main/java/com/beemdevelopment/aegis/ui/ImportEntriesActivity.java ；2FAS、ente 的去重代码在同上两个仓库中 | [转录] |
| A16 | Microsoft Authenticator 不支持导出 https://learn.microsoft.com/en-us/answers/questions/2282829 ；Authy 不支持导出 https://support.twilio.com/hc/en-us/articles/19753420684059 | [转录] / [摘要] |
| A17 | Google 身份验证器用二维码转移 https://support.google.com/accounts/answer/1066447 | [转录] |
| A-Q3 | 粘贴事件通过 `clipboardData` 读取 https://developer.mozilla.org/en-US/docs/Web/API/Element/paste_event | [转录] |
| A-Q6 | 没有找到任何竞品带"测试验证码"步骤（检索范围见 A14 各仓库） | [转录] |

### B：填码与匹配
| 编号 | 来源 | 标记 |
|---|---|---|
| B1 | Marek Tóth "DOM-based extension clickjacking"（2025-08-09，更新于 2026-01-14） https://marektoth.com/blog/dom-based-extension-clickjacking/ | [复核] |
| B2 | 1Password 可选缓解措施 https://support.1password.com/kb/202508 | [转录] |
| B3 | Bitwarden TOTP 字段关键词 https://raw.githubusercontent.com/bitwarden/clients/main/apps/browser/src/autofill/services/autofill-constants.ts ；字段条件与拆分输入框 https://raw.githubusercontent.com/bitwarden/clients/main/apps/browser/src/autofill/services/autofill.service.ts | [转录] |
| B4 | Bitwarden 自动复制 TOTP、快捷键 https://bitwarden.com/help/auto-fill-browser/ ；TOTP 付费 https://bitwarden.com/help/integrated-authenticator/ | [转录] |
| B5 | Proton Pass "Copy & fill in" https://proton.me/support/pass-2fa | [转录] |
| B6 | 1Password 一次性密码 https://support.1password.com/one-time-passwords/ ；浏览器权限 https://support.1password.com/browser-permissions/ | [转录] |
| B7 | AdsPower 2023-11-06 公告（规避风控的宣传） https://www.adspower.com/news/whats-new-what-we-launched-in-october-2023 | [转录]（指纹浏览器调研里为 [复核]） |
| B8 | WHATWG `one-time-code` https://html.spec.whatwg.org/multipage/form-control-infrastructure.html ；https://web.dev/articles/sms-otp-form | [转录] |
| B9 | NIST SP 800-63B-4（手动输入的 OTP 不算防钓鱼） https://pages.nist.gov/800-63-4/sp800-63b.html | MCP 调研 [R10] 中 [复核] |
| B10 | Brave 关于 Comet 提示注入（2025-08-20） https://brave.com/blog/comet-prompt-injection/ | MCP 调研 [R8] 中 [复核] |
| B11 | 公共后缀列表（335 KB / gzip 90 KB，约 10336 条规则） https://publicsuffix.org/list/public_suffix_list.dat ；更新频率 https://publicsuffix.org/list/ | [转录]（子代理测量） |
| B12 | Bitwarden URI 匹配方式 https://bitwarden.com/help/uri-match-detection/ ；22 组等价域名 https://raw.githubusercontent.com/bitwarden/server/main/src/Core/Utilities/StaticStore.cs | [转录] |
| B13 | 2fa.directory API（MIT 协议要求署名）https://2fa.directory/api/ ；v3 totp.json（262 KB / 1288 条）https://api.2fa.directory/v3/totp.json | [转录] |
| B14 | Apple 密码的验证码 https://support.apple.com/guide/passwords/verification-codes-mchl873a6e72/mac ；iCloud 密码扩展 https://support.apple.com/guide/icloud-windows/autofill-passwords-in-a-web-browser-icw76039ec0f/icloud | [转录] |
| B15 | Microsoft Authenticator 2025-07 停止自动填充 https://support.microsoft.com/en-us/authenticator/import-passwords-into-the-microsoft-authenticator-app | [转录] |

### E：本次实测（附录 A）
E1 弹窗基准；E2 侧边栏 activeTab 实验；E3 `openPopup` activeTab 实验；E4 弹窗视口（无头 vs 有头）；E5 匹配规则检查；E6 对比度计算；E7 浏览器内 PBKDF2；E8 优化原型；E9 请求计数。全部 [实测]。

### 未能核实
- WebAuthn 系统对话框（Touch ID / Windows Hello）在 Chrome 133–155 期间是否会关闭弹窗；侧边栏是否也受 M156 强制关闭的影响。
- 从弹窗按钮里调用 `sidePanel.open()` 是否算"user action"。
- `getDisplayMedia` 在扩展页面上是否完全不需要 manifest 权限；文件选择框在当前版本里是否还会关闭弹窗。
- activeTab + `allFrames` 能否到达跨域 iframe（源码与一位用户的报告矛盾）。
- 无警告的新权限在更新时一定静默（文档只写了有警告的情况）。
- Windows Hello PRF 的微软官方文档；PRF 在 Linux 上的情况。
- declarativeContent 的规则在磁盘上是否明文。
- Google 密码管理器确实不存 TOTP；Opera 能否直接装 Chrome 商店扩展；Arc、Yandex、QQ、搜狗的内核版本。
- Proton Pass 的 PIN 次数是否由服务器计数（源码显示服务器核对 PIN）。
- 所有者截图中的竞品是哪一款。
- 真实点击（而不是 CDP 的 `triggerAction`）时，浏览器在弹窗导航之前的开销。

---

## 6. 附录 A：测量方法与复现

**环境**
- 机器：Apple M3 Max（16 核，12 个性能核 + 4 个效率核），128 GB，macOS 27.0（26A428）。
- 浏览器：Chrome for Testing 156.0.8078.4（Playwright 缓存 chromium-1248），新版无头模式。
- 工具：Node 22.21.1，Playwright 1.64.1。
- 有头模式只用于截图。无头模式下弹窗视口是 376×520（虚拟屏幕 800×600），有头模式下是 376×600 [E4]。所以无头数据里每屏少画一两行，对 500 个账户的场景影响很小。

**被测对象**
- 仓库 `extension/` 的副本，构建到临时目录，从未写入仓库的 `dist`、`dist-e2e`、`test-results`：
  - `…/scratchpad/ux/build/ext`：原样副本，生产构建；
  - `…/build/instr`：插桩副本（新增 `src/popup/instr.ts`，在 `App.tsx` 的 `load()` 里打三个 `performance.mark`，并包装 `chrome.storage.*.get` 来计数和计字节）；
  - `…/build/opt1`：在插桩副本上只加一行 `content-visibility` CSS；
  - `…/build/opt2`：opt1 + `openView()` 一次读取 + 首屏 16 个验证码优先（只为测量收益，**不是**给仓库的代码）。
- 数据：用 `seed.mjs` 在设置页粘贴 N 条随机 `otpauth://`，然后开启主密码。槽的大小：10 个账户 5.3 KB，100 个 43 KB，500 个 207 KB。

**驱动方式（`bench/cdp.mjs`）**
- 直接启动 CfT，带 `--enable-unsafe-extension-debugging`，通过 WebSocket 发 CDP 命令。
- 当前标签页打开 `http://github.localhost:<port>/`：带一个 `autocomplete=one-time-code` 输入框，其中 GitHub 账户会被识别为"此网站"。
- 每次运行：
  1. 用 `Extensions.triggerAction` 模拟点击图标，打开真实弹窗，并确认拿到了 activeTab。
  2. `Target.setAutoAttach` 让新弹窗在执行任何脚本前暂停（排除 service worker）。
  3. 暂停期间注入 MutationObserver，必要时用 `Emulation.setCPUThrottlingRate` 降速，然后放行。
- 指标定义：
  - "首个验证码"= 第一个 `.row .code:not(.wait)` 出现时的 `performance.now()`，从弹窗文档的导航开始算；"首帧"= 其后一次 rAF 加 setTimeout(0)。
  - "点击 → 首个验证码"= 调用 `triggerAction` 前的 `Date.now()` 与弹窗的 `timeOrigin + 标记` 之差。
  - 空白弹窗对照（`blank.mjs`）：导航前开销 272 ms，点击到有内容 287 ms。
  - 闲置 CPU：弹窗打开 1 秒后，取 10 秒内 `Performance.getMetrics` 的 `TaskDuration` / `ScriptDuration` / `LayoutDuration` / `RecalcStyleDuration` 增量。
- 场景：
  - `warm`：浏览器启动后先解锁一次，再连续开关 15 次；
  - `proccold`：每次都等到扩展的 SW 被浏览器停掉（实测 31–58 s），再多等 1.5 s 后打开；
  - `restart`：每次都重新启动浏览器（`storage.session` 已清空），打开弹窗，等锁屏页出现，填入主密码提交。
- 慢 CPU 的两种代理：CDP 4 倍降速（只作用于主线程）；`taskpolicy -b` 把整个浏览器放到效率核上。

**结果明细（中位数 / p95，n=15，另注者除外；单位 ms）**

| 场景 | 导航前（浏览器开销） | 点击 → 首个验证码 | 首个验证码 | 首帧 |
|---|---|---|---|---|
| 空白弹窗对照（n=8） | 272 | 287 | ≈15 | — |
| warm 10 | 272 | 318 / 329 | 46.1 / 48.1 | 59.4 / 60.5 |
| warm 100 | 276 | 356 / 364 | 78.4 / 87.9 | 106.3 / 114.4 |
| warm 100（生产构建，无插桩） | 273 | 355 / 362 | 79.8 / 86.1 | 104.1 / 113.8 |
| warm 500 | 274 | 514 / 522 | 239.4 / 249.9 | 387.4 / 397.5 |
| proccold 10（n=4） | 277 | 380 / 399 | 104.1 / 105.3 | 109.4 / 109.9 |
| proccold 100（n=8） | 274 | 410 / 426 | 137.2 / 152.6 | 161.9 / 179.0 |
| proccold 500（n=4） | 275 | 585 / 600 | 310.5 / 325.6 | 455.0 / 476.7 |
| warm 100，4× 降速 | 274 | 562 / 576 | 287.7 / 302.9 | 403.8 / 440.7 |
| warm 500，4× 降速 | 272 | 1245 / 1335 | 968.7 / 1055.7 | 1665.5 / 1810.8 |
| warm 100，效率核 | 357 | 770 / 1206 | 443.9 / 905.0 | 567.3 / 1270.0 |
| opt1 warm 100 / 500 | — | — | 88.7 / 208.7 | 97.3 / 230.1 |
| opt2 warm 100 / 500 | — | — | 59.8 / 118.6 | 73.9 / 155.7 |

| 解锁路径（浏览器重启后） | 锁屏页出现 | 提交 → 首个验证码 | 提交 → 首帧 |
|---|---|---|---|
| 10 | 43.5 / 62.2 | 88.6 / 91.2 | 94.6 / 96.7 |
| 100 | 43.1 / 53.6 | 152.7 / 173.5 | 178.6 / 199.1 |
| 100（生产构建，n=10） | 45.7 / 47.7 | 151.2 / 152.6 | 177.9 / 179.4 |
| 500 | 62.6 / 64.3 | 445.4 / 459.2 | 590.5 / 605.4 |
| 100，4× 降速（n=10） | 140.1 / 155.0 | 478.6 / 507.0 | 613.3 / 648.3 |
| 100，效率核（n=10） | 266.9 / 1652.2 | 773.2 / 2119.2 | 979.6 / 2383.2 |
| 旧设备密钥模式 100（直接出现验证码） | — | 首个验证码 94.8 / 104.7 | — |
| PBKDF2-SHA256 600k 单独计时（n=9） | 性能核 47.7（47.0–49.4） | 效率核 924.7（413.9–2777.1） | — |

| 闲置 CPU（n=3，ms/秒） | Task | 样式重算 | 布局 | 脚本 | JS 堆（MB） |
|---|---|---|---|---|---|
| 10 | 36.1 | 4.2 | 0.3 | 0.3 | 1.8 |
| 100 | 230.9 | 36.9 | 1.4 | 0.4 | 13.0 |
| 500 | 880.9 | 100.6 | 6.0 | 1.0 | 10.3 |
| opt1 / opt2 100 | 74.0 / 71.4 | — | — | — | — |
| opt1 / opt2 500 | 144.5 / 142.2 | — | — | — | — |

**存储计数**（插桩包装 `chrome.storage.local.get`；IndexedDB 镜像的读取未计入）

| 场景 | 10 个账户 | 100 个账户 | 500 个账户 |
|---|---|---|---|
| 已解锁打开 | 18 次 / 26 KB | 18 次 / 217 KB | 18 次 / 1.04 MB |
| `storage.session` 读取 | 5 次 | 5 次 | 5 次 |
| 解锁 | 36 次 / 67 KB | 36 次 / 561 KB | 36 次 / 2.69 MB |

**请求**（CDP Network，已解锁打开）：
- 共 10 个：`popup/index.html`、`popup-*.js`、`preload-helper-*.js`、两个 CSS、5 个 woff2；锁屏页只用到 4 个字体。
- 体积：首屏 JS 117 KB（gzip 40 KB），CSS 24 KB（gzip 6.8 KB），字体 72 KB；SW 58 KB（gzip 16 KB）。
- 懒加载的包：`qr` 41 KB，`strength` 1 KB，zxcvbn 字典 1.2 MB + 428 KB + 33 KB（只在设密码时加载）。

**行为实验**
- **E2 侧边栏**（`build/sp`、`build/sp2`、`bench/sptest*.mjs`）：
  - `openPanelOnActionClick: true` 时，侧边栏里 `tabs.query` 的 url 为 null，`captureVisibleTab` 报 "Either the '<all_urls>' or 'activeTab' permission is required."；
  - 改用 `onClicked` + `sidePanel.open` 后，被点击标签页的网址可读、截图成功；切到 B 标签页后不可读；回到 A 标签页（同源导航后）可读；在 B 上再点一次图标后 B 可读，侧边栏不关闭。
  - `tabs.onActivated` / `onUpdated` 照常触发，url 为 null。
- **E3**：从 SW 调用 `chrome.action.openPopup()` 打开的弹窗里，url 为 null，`captureVisibleTab` 报同样的错。
- **E5**：`bench/match-check.mjs`，22 个主机名逐一检查（结果见 §2.10）。
- **E6**：`bench/contrast.mjs`，按 WCAG 2.x 相对亮度公式计算。

**截图与示意图**（都在临时目录，不随仓库保存）
- `…/scratchpad/ux/shots/`：
  - 弹窗：`popup-welcome-{light,dark}`、`popup-locked-light-pw-10`、`popup-main-{light,dark}-pw-10`、`popup-copied-light-pw-10`、`popup-add-light-pw-10`、`popup-edit-dark-pw-10`；
  - 设置页：`options-{security,add}-{light,dark}-pw-10`；
  - 示意图：`mock-{sidepanel,density,add,firstrun}-{light,dark}`；
  - 请求列表：`requests-*.json`。
- 示意图的 HTML 在 `…/scratchpad/ux/mock/`，直接引用仓库副本里的真实 `styles.css` / `popup.css`，只作示意，不是产品代码。

**复现命令**（`S` 为临时目录 `…/scratchpad/ux`，仓库根目录下执行）
```bash
S=/path/to/scratch/ux
rsync -a --exclude node_modules --exclude dist --exclude dist-e2e --exclude test-results extension/ $S/build/ext/
ln -s "$PWD/extension/node_modules" $S/build/ext/node_modules
(cd $S/build/ext && node scripts/build.mjs)                 # 生产构建到副本的 dist/
# 插桩副本：复制 build/ext 为 build/instr，加入 src/popup/instr.ts 与三个 performance.mark 后同样构建
node $S/bench/seed.mjs $S/build/instr/dist $S/bench/profiles/pw-100 100           # 也可用 10 / 500，或加 --device
cd $S/bench && export S
node bench.mjs warm     pw-100 15
node bench.mjs restart  pw-100 15
node bench.mjs proccold pw-100 8
node bench.mjs idlecpu  pw-100 3
node bench.mjs warm     pw-100 15 --throttle=4
node bench.mjs warm     pw-100 15 --prefix=taskpolicy,-b
node blank.mjs                     # 空白弹窗对照
node sptest.mjs; node sptest2.mjs  # 侧边栏 activeTab
node openpopup.mjs                 # openPopup 的 activeTab
node kdf.mjs; node kdf.mjs taskpolicy,-b
node contrast.mjs; node match-check.mjs
node shots.mjs welcome; node shots.mjs pw-10   # 截图（脚本里固定为有头模式）
```
结果追加到 `$S/bench/results.jsonl`，完整日志在 `$S/bench/run-all.log`。临时目录随会话清理；如果要把 §2.3 的预算放进 CI，需要把 `cdp.mjs`、`bench.mjs`、`seed.mjs` 移进 `extension/scripts/`（本次没有改动仓库）。


---

## 7. 所有者决定（2026-10-16）

| 问题 | 决定 |
|---|---|
| §4 Q1 网页版 | 按推荐：不做完整网页版，推迟到 Phase 3 之后，最多评估受限只读应急页 |
| §4 Q2 侧边栏 | 按推荐：接受新增 `sidePanel` 权限，M8 之后，默认仍是弹窗，共享预设下不提供 |
| §4 Q3 点按填入 | 按推荐：暂不做 |
| §4 Q4 「此网站」 | 按推荐：只给已登记域名，名称猜测降为「可能相关」 |
| §4 Q5 安全预设 | 按推荐：标准 / 共享·自动化两个预设，首次运行复用 H5 |
| §4 Q6 加密导入 | 按推荐：只支持 WebCrypto 能解的格式，不引入 scrypt / Argon2 库 |
| H1–H8 | 按推荐全部采纳（含 H1：添加第一个账户前必须先设主密码） |
| U1 | 所有者授权由我安排实施顺序，拿不准时交 Opus 子代理 |
| MCP 报告 Q1 | 写入 SYNC-DESIGN §13 不做清单：不向 AI 代理返回验证码、种子或账户列表 |
| MCP 报告 Q3 | 在 H8 指南中加「AI 代理与自动化」一节 |
