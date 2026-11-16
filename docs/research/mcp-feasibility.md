# Sixkey 作为 MCP 服务：可行性与设计调研

调研日期：2026-10-15。性质：**只做调研与设计**，没有改动 `extension/src/`、测试、`docs/history/PLAN-zh.md`、`docs/SYNC-DESIGN.md` 或其他文档，没有写实现代码。
对照的 Sixkey 现状：`docs/history/PLAN-zh.md`、`docs/security/local-vault.md`、`docs/PRIVACY.md`、`docs/SYNC-DESIGN.md`（含 §1 威胁模型、§13 不做清单）、`extension/manifest.base.json`、`extension/scripts/check-dist.mjs`、`docs/research/fingerprint-browser-security-lessons.md`。
外部来源编号（如 [M2]、[V6]、[R8]、[B3]；能力表的 C0–C10 不是来源编号）对应文末 §9 的来源表。

**引用标记**（与指纹浏览器调研相同）
- **[复核]**：我本人抓取了原文（或下载了源码 / 协议文件）并核对过。
- **[转录]**：研究子代理抓取了原文，我没有逐条二次核对。
- **[摘要]**：只看到搜索摘要，或页面打不开。
- **[未核实]**：没有找到可靠来源，属推断。

---

## 结论（先看这一段）

**一句话：永不向模型返回验证码或种子；现在什么 MCP 都不建；唯一站得住的变体是"交接"（代理只能请求，用户在 Sixkey 弹窗里亲手完成），推迟到触发条件出现再评估。**

1. **"把验证码交给模型"的任何形式都不应该发布**，包括"只返回指定网站的验证码"和"每次用户批准后再返回给模型"。TOTP 作为第二因素的价值，是"只有持有设备的人才能在 30 秒内拿出这串数字"。代理一旦能按需取码，第二因素就变成"任何能操纵这个代理的东西"——网页、邮件、工具输出里的提示注入。OpenAI、Anthropic、OWASP 都公开承认提示注入没有可靠解法 [R7][R9][R12]；已经有公开的 PoC 让浏览器代理读出 OTP 并贴到网上 [R8]；而 NIST 明说手输 OTP 不防钓鱼，中继工具会在有效期内用掉它 [R10][R11]。"30 秒有效期"不构成保护。
2. **现在什么都不做（§2 的选项 f），并把理由写下来**。Sixkey 今天不接收任何来自扩展之外的消息（SW 只认 `sender.id === chrome.runtime.id`）。任何 MCP 架构都至少需要以下之一——
   - `nativeMessaging` 加本机程序（SYNC-DESIGN §13 已经以"破坏'只是一个扩展'的定位"否决过一次）；
   - 对 `localhost` 的 CSP 放开（可能还要 host 权限），破坏"只连一个 API origin"；
   - 经我们的服务器中转（服务器会得到"谁、何时、为哪个代理请求了验证码"的使用记录，违背 D3 零追踪）；
   - **扩展之间的消息**（§2 选项 g）：不声明 `externally_connectable` 时"all extensions can connect, but no web pages can connect" [B18][复核]，所以只要 Sixkey 注册一个按扩展 ID 白名单过滤的 `onMessageExternal` 监听，像 Claude in Chrome 这样已经接好 MCP 的代理扩展就能把"交接"请求递过来——**不需要任何新权限、本机程序或网络**。代价是：新的外部消息攻击面；要信任第三方扩展的 ID（旁加载副本的 ID 会变，SYNC-DESIGN d6）；而且 Sixkey 一家做不成，要对方愿意集成。
3. **唯一说得过去的变体是"交接"**：代理只能说"我卡在 X 网站的 2FA 这一步"，由用户亲手点 Sixkey 图标、在 Sixkey 自己的弹窗里确认，验证码进剪贴板（或输入框），**从不出现在 MCP 返回值里**。这正是 1Password 与 Anthropic 在 2026-07 上线的模式 [V2]。但对 Sixkey 来说，它在不加权限的前提下**就等于今天的弹窗**（点图标 → 当前网站的账户排第一 → 回车复制）；唯一多出来的"代理能把请求送到 Sixkey"，要么需要上面被否决的通道，要么（选项 g）依赖某个代理扩展厂商愿意集成。增量价值小，代价是一条新攻击面（以及选项 a 的新权限和本机程序）。**建议现在不做，列为"条件满足后再评估"的备选**（触发条件见 §6）。
4. **三类目标用户里两类已经不需要它**：
   - 指纹浏览器：AdsPower 官方 MCP 已经能让模型写入、读回配置文件里的 2FA 密钥字段 `fakey`，还带"在页面里执行任意脚本"的工具（我下载源码核对过，[V22]）。
   - QA 自动化：标准做法是把**测试账号**的密钥放进 CI 环境变量，用 otpauth/otplib 现场算码 [V24]；Skyvern、Browser Use 这类代理框架自己保存种子 [V17][V18]。
   - 个人代理用户：主流代理产品在登录与 2FA 处本来就停下来交给人，或者走 1Password 的注入通道 [V19][V20][V2]。
5. **对以信任为卖点的品牌是减分**。头部厂商的公开原则是"原始凭据永不进入 LLM 上下文"（1Password [V1][V5]、Dashlane [V9]）；会把验证码交给模型的，是 Bitwarden MCP、社区 TOTP 服务器和一家小验证器厂商 [V6][V12][V13]。Sixkey 若做"返回验证码"，就站到了后一阵营。零代码能做的是：一页《在 AI 代理与自动化环境中使用 Sixkey》（并入 §9.1 H8 的指南），以及把"向模型或代理返回验证码、种子、账户清单"写进 SYNC-DESIGN §13（需所有者决定，§7 Q1）。

---

## 0. 现有设计里已经定下、本报告直接沿用的事

这些不是新结论，而是已有文档里的决定；任何 MCP 方案都必须先面对它们。

| 已有决定 | 出处 | 对 MCP 的含义 |
|---|---|---|
| 不用 native messaging 保存设备密钥："需要 `nativeMessaging` 权限和本机安装程序，破坏'只是一个扩展'的定位" | SYNC-DESIGN §13 | 当时否决的是"用它存设备密钥"，但否决理由（新权限 + 本机安装程序 + 不再"只是一个扩展"）原样适用于架构 (a) |
| 不做内容脚本自动填码（F20）："会让 Sixkey 变成网页可以接触的攻击面" | SYNC-DESIGN §13 | "替代理填码"不能走内容脚本 |
| 不做"能用码不能看种子"的权限："能生成验证码的客户端必然持有种子……只能客户端强制，给的是虚假的安全感" | SYNC-DESIGN §1.3、§13 | "只给码不给种子"同理，对一个能读页面的代理不构成边界 |
| A10：能连上配置文件调试端口（CDP）的本机进程，**在解锁期间几乎不设防**：能读走 `storage.session` 里的 VK 与全部种子 | SYNC-DESIGN §1.2 | **用 Playwright / Puppeteer / chrome-devtools-mcp / 指纹浏览器本地 API 驱动浏览器的代理，今天就已经能在解锁期间拿走一切**（Puppeteer 可以 `worker.evaluate()` 进扩展 SW；chrome-devtools-mcp 的 `evaluate_script` 接受 `serviceWorkerId` [B13][B14]）。而且这已不限于指纹浏览器：Chrome 144 起，用户先在 `chrome://inspect` 里打开远程调试之后，chrome-devtools-mcp 的 `--autoConnect` 就能连上用户**日常使用的** Chrome，每次连接弹一次许可框 [B14][复核]。**MCP 通道对这类代理不增加能力，只是给它一条"官方认可"的路** |
| 只做 Chrome 扩展【已决】 | PLAN §0 原则 3 | 架构 (e)（CLI/桌面伴侣）是产品范围的变更，不是一个功能 |
| 权限白名单：`storage, unlimitedStorage, activeTab, alarms, idle, offscreen` + 可选剪贴板；禁止 host 权限（Phase 1 只许 API origin）、`content_scripts`、`externally_connectable`；CSP `connect-src 'none'` | `check-dist.mjs`；SYNC-DESIGN §7 | 除选项 (g) 外，每个架构选项都要改这份白名单；(g) 只在需要清单层面限定扩展 ID 时才碰 `externally_connectable` 的禁令 |
| "No content scripts: it never reads or changes the web pages you visit." | PRIVACY.md | "填进输入框"即"改动网页"，要改这句承诺 |
| 被脚本控制的配置文件预设"每次都锁定"（H5）；指南（H8） | SYNC-DESIGN §9.1 | 现成的缓解与文档落点 |

---

## 1. "Sixkey 作为 MCP"可能指什么：能力表

评分：风险 = 被提示注入或恶意客户端利用时的后果；有用 = 对真实用户的价值；兼容 = 与"永不丢数据 / 零追踪 / 最小权限 / 零知识 / 主密码 / 自动锁定"的冲突程度。所有能力都还需要一个通道（§2），表中不重复计入通道的代价。

| # | 能力 | 典型工具 | 风险 | 有用 | 与承诺的兼容 | 判断 |
|---|---|---|---|---|---|---|
| C0 | 保险库状态（是否锁定、同步是否正常） | `vault_status` | 低。会告诉代理"此刻已解锁"，帮攻击者挑时机 | 低 | 兼容 | 没有人需要它；不单独做 |
| C1 | 立即锁定 | `lock_now` | 低。最坏是把用户锁住（拒绝服务） | 低–中（代理收尾时锁上） | 兼容 | 唯一"无害"的工具；单独做不值得建通道 |
| C2 | 列出账户（issuer、label、域名，无种子） | `list_accounts` | **中**。"用户在哪些网站开了 2FA"是隐私数据，会进入模型提供商的上下文与日志；也给注入提供目标清单（"你有某交易所账户"） | 中 | **冲突零追踪**：等于 Sixkey 把账户清单交给第三方 | 不做。连 `has_account(domain)` 这种布尔值也会被逐个探测 |
| C3 | 取任意账户的当前验证码 | `get_code(account)` | **致命**。完整的"致命三要素"（§3.1） | 对代理最方便 | 违背第二因素的本意 | **永不发布** |
| C4 | 只返回"指定网站"的验证码 | `get_code(domain)` | **致命**。网站名由代理提供，注入可以随意指定；Sixkey 自己无法核实代理此刻在哪个网站（无 `tabs`/host 权限，§4.1） | 同 C3 | 同 C3 | **永不发布** |
| C5 | "请求验证码"：用户在 Sixkey 里批准后**返回给模型** | `request_code` | **高**。批准疲劳；能操作屏幕的代理可以自己点"批准"（§3.3）；批准之后验证码进入模型上下文、对话记录与日志 | 中 | 同 C3 | **永不发布**（问题出在"返回"本身） |
| C6 | "完成 2FA 这一步"：用户在 Sixkey 里批准，Sixkey 把码复制到剪贴板或填进当前页，**不进 MCP 返回值**，代理只得到 `done/denied/expired/locked` | `handoff_2fa(site_hint)` | **中**。会操作浏览器的代理仍能从 DOM、截图或剪贴板读到码（§3.4） | 中–低（相比今天的弹窗只省一次"想起来去点图标"） | 复制：兼容；填入：需 `scripting` 权限并改 PRIVACY 承诺 | **唯一可考虑的窄子集；现在不做**（§4、§6） |
| C7 | 添加账户（代理把 `otpauth://` 交给 Sixkey） | `add_account(uri)` | **中–高**。种子已经过模型上下文，提供商日志里有它——这个 2FA 从第一天起就不是秘密；注入也可以塞进攻击者控制的种子 | 中（代理帮用户开启 2FA） | 冲突"种子不离开本机"的精神 | 不做。正确做法是用户在 Sixkey 里扫码 |
| C8 | 改名、排序、编辑、删除 | `edit_account` 等 | 中–高。删除是破坏性的（回收站兜底） | 低 | 冲突"永不丢数据"的精神 | 不做 |
| C9 | 导出（明文或加密备份） | `export` | **致命** | 低 | H3 刚规定导出前必须重输主密码 | **永不发布** |
| C10 | 读取种子 | `get_secret` | **致命** | — | §1.3 | **永不发布** |

---

## 2. 架构选项对比

| 方案 | 新权限 / 新组件 | 新攻击面 | 对零追踪、最小权限的影响 | 工作量 | 可复用的现有设计 | 判断 |
|---|---|---|---|---|---|---|
| **(a)** 本机 MCP 服务器（stdio）+ **native messaging** 宿主，扩展用 `connectNative` 与它通信 | `nativeMessaging`（安装警告"Communicate with cooperating native applications"[B3][复核]）。它**可以设为可选权限**（不在不可选清单里 [B6][复核]）；对已安装用户也只能走可选权限，因为更新时新增带警告的权限会让扩展被停用直到用户接受 [B7]。外加每个平台一个已签名的本机程序、安装器、宿主清单（Windows 还要注册表项）、更新渠道 | ① Chrome **每次连接都新启动一个宿主进程** [B7]，而 MCP 服务器是由 MCP 客户端另行启动的进程，两者之间还需要一跳本机 IPC（套接字或命名管道），这一跳必须认证。反面教材：Claude in Chrome 的同一跳在 Windows 上是"Everyone"可访问、无客户端认证的命名管道，任何本机进程都能借它在任意标签页执行脚本；厂商以"需要本地代码执行"为由关闭报告 [B8][复核]。② 用户级宿主清单优先于系统级，同用户的任何进程都能注册一个同名清单抢先；扩展无法核验被启动的二进制 [B7][转录]。③ 同一 MCP 客户端里其他服务器的工具投毒与遮蔽（§3.1）；客户端的自动批准（§3.2） | 推翻 §13 的"只是一个扩展"；商店政策没有专门针对本机程序的条款，但要为每项权限写理由 [B15]；不需要网络，不影响零追踪 | **L** | §3.2 的承诺式配对思路（扩展与本机程序首次配对时互相确认一个数字，防其他进程冒充）；H6 安全记录做本地审计 | 需要本机程序的方案里最"正"的一个；1Password、Claude in Chrome 也都靠桌面侧程序 [V2][B9]。但要推翻已定决策，且 IPC 那一跳是已被证明容易做错的地方；代价高于 (g) |
| **(b)** 本机桥接进程，扩展经 **localhost** WebSocket/HTTP 连接 | CSP `connect-src` 必须放开 localhost（现在是 `'none'`），`check-dist` 的 `localhost` 禁令要改；HTTP 请求没有 host 权限就受 CORS 约束，WebSocket 可能不需要 host 权限 [B10][未核实，需实测]；若加 host 权限，大概率出现针对该主机的"读取和更改数据"警告 [未核实]。Chrome 目前不打算对有 host 权限的扩展施加本地网络访问（LNA）限制 [B10][转录]。仍要用户安装桥接程序 | 端口抢占（任何本机进程都能先监听这个端口冒充桥）；DNS rebinding 与 CSRF（MCP Inspector CVE-2025-49596；官方 TS/Python SDK 曾默认关闭防护，CVE-2025-66414/66416；Playwright MCP CVE-2025-9611 [R3][R4]）；MCP 官方指南："Binding to 127.0.0.1 is not an authentication boundary" [M4][复核]，规范要求本地 HTTP 服务器校验 `Origin` [M11]。现有同类桥（Playwright MCP Bridge 只认回环地址 + 每配置文件令牌；Browser MCP 连 `ws://localhost:9009`）都同时带 `<all_urls>` 与 `debugger` 权限 [B11][转录] | 破坏"只连一个 API origin"（SYNC-DESIGN D1 与网络白名单 e2e 测试） | **L** | 同 (a) 的配对 | **比 (a) 更差**：同样要装程序，还多一个网络面 |
| **(c)** 扩展作为用户自己运行的本地 MCP 服务器的客户端 | 同 (b) | 同 (b)，外加：服务器是第三方或用户自建的，Sixkey 无法审查（postmark-mcp 式恶意包 [R2]） | 同 (b) | 扩展侧 M，安全取决于第三方 | — | **最差**：把信任交给一个我们不审查的程序 |
| **(d)** 我们后端上的远程 MCP 服务 | OAuth 2.1 授权服务器、受保护资源元数据（RFC 9728）、资源指示（RFC 8707）、CIMD 客户端注册等 [M5]；扩展要常驻连接或轮询 | 授权码与 token 被盗、混淆代理（confused deputy）、会话劫持 [M6][R5]；云端代理来自厂商云（Claude 的自定义连接器从 Anthropic 云端连过来 [M8]），验证码必然进入那边的模型 | **冲突零知识与零追踪**，见下方三种子方案 | **L+** | 设备签名（扩展侧认证）、`pw_auth`（授权委托）、吊销（撤销代理授权） | **不做** |
| **(e)** 独立 CLI / 桌面伴侣，持有自己的库副本，作为新的"设备"经同步入网 | 第二套客户端（加密、存储、合并、同步引擎）；系统钥匙串；OS 级用户在场验证（Touch ID / Windows Hello） | 同一用户下运行的代理（Claude Code 有 shell）能直接调用它、读它的文件、驱动它的提示——**终端里的"确认"毫无意义**，批准必须是 OS 级生物识别；种子离开浏览器配置文件，落到一个新位置 | 不需要新的扩展权限；但违背"只做 Chrome 扩展"；新设备持有**全部**种子（一个库 = 一个人，没有按条目的密钥；多库是 §13 的 L 级不做项） | **L** | 几乎全部：§3.2 批准入网（SAS/CC 在终端显示与输入）或 §3.3 恢复码入网；DSK 签名；`pw_auth`；§3.10 吊销 + §3.8 轮换可以把它踢出；`min_client_version` | 若将来要做"给人用的命令行"，这是唯一与零知识相容的路径；但它是产品扩张，不是"MCP 功能" |
| **(f)** 不做，写清理由 | 无 | 无 | 无 | **S**（文档） | H8 指南、§13 | **推荐** |
| **(g)** **扩展之间的消息**：已经接好 MCP 的代理扩展（如 Claude in Chrome，它自带 native messaging 与云端中继 [B9]）用 `chrome.runtime.sendMessage(sixkeyId, …)` 把交接请求递给 Sixkey | **无新权限**。不声明 `externally_connectable` 时所有扩展都能连进来、网页不能 [B18][复核]；若要在清单层面只放行某几个 ID，就要声明 `externally_connectable: {ids: [...]}`（只含 `ids` 不会放行任何网页 [B18]），这需要改 `check-dist` 对该键的一刀切禁令 | 新的外部消息入口：任何已安装的扩展都能发请求，只能靠代码里的 `sender.id` 白名单过滤；ID 白名单很脆弱（旁加载或 zip 安装的副本 ID 由路径决定，SYNC-DESIGN d6）；对方扩展被攻破或被注入时，它就是"恶意 MCP 客户端" | 不改权限、不触网，不影响零追踪；但要在隐私与安全文档里写明"接受某某扩展的请求" | **M**（Sixkey 侧：监听器、白名单、弹窗请求界面、G1–G12） | 现有的 `sender.id` 校验写法；G1–G12 原样适用 | **代价最小的通道**，但 Sixkey 一家做不成：要对方厂商愿意定义并维护这条消息接口。若将来要做交接，应先评估它，再考虑 (a) |

**(d) 的三种子方案，都不可接受**：
- (d1) 服务器生成验证码 → 服务器必须持有种子 → 零知识破产。否决。
- (d2) 服务器只中转（云端代理 → api.sixkey.app → 用户在线的扩展 → 用户批准 → 加密回传）。内容可以端到端加密，但服务器必然看到"哪个账户、何时、哪个代理、多频繁"——这就是一份使用日志，D3（不收集使用数据）不允许；而且回传的验证码最终进入云端模型，即 C5。否决。
- (d3) 给代理委托一把用户持有的密钥，代理自己解开一部分种子 → 种子落在第三方云，吊销收不回（与 A4"吊销前见过的种子永久泄露"同理）。否决。

**Chrome 自己的代理功能不是 Sixkey 的出路（截至 2026-10）**：
- **WebMCP**（`document.modelContext.registerTool()`，W3C WebML 社区组草案；Chrome 149 起源试用）是**网页侧** API，由网页向浏览器内的代理暴露工具；文档提示"Chrome Extensions can query and execute WebMCP tools with content scripts" [B16][转录]。没有文档说明扩展页面能注册工具；Sixkey 要用它就得先有内容脚本或 host 权限。它与 Sixkey 的关系主要是反方向的：将来有网站可能把"提交 2FA 码"暴露成 WebMCP 工具，让代理更容易填码。
- 没有面向代理或 MCP 的 `chrome.*` 扩展 API；扩展的"What's new"截至 Chrome 153 没有此类条目 [B16][转录]。
- Gemini in Chrome 的 auto browse 在购买、发帖等操作前暂停确认，经用户许可可以使用 Google 密码管理器；Google 说"the model does not have direct access to stored passwords" [B17][R7][转录]。即浏览器厂商自己的代理也走"代填、不给模型看"的路线，而且只对接自家的密码管理器。

**(e) 怎样套用 SYNC-DESIGN 的设备体系**（只为说明可行性，不是推荐）：
- 入网：CLI 是一个普通的 N，§3.2 的 SAS 显示在终端、由已入网的扩展输入，CC 显示在扩展、输回终端；MUST 规则不变。或走 §3.3 恢复码。
- 每设备密钥：DSK 放系统钥匙串。§13 反对钥匙串的理由（"配置文件被同步到另一台机器时钥匙串不跟着走"）对 CLI 不成立。
- 吊销：§3.10 原样适用；它若写过当前 KeyBundle，按规则强制走"吊销并保护"。
- 但设备列表上它就是"一台能读全部种子的设备"。§1.2 A3/A10 的残余对它同样成立，只是换了位置。

---

## 3. 核心危险与护栏设计

### 3.1 为什么"代理能拿到验证码"本身就是问题

- **致命三要素**（Willison，2025-06-16 [R6][复核]）：私有数据 + 不可信内容 + 对外通信，三者同在一个代理里，就能被注入偷走数据；"we still don't know how to 100% reliably prevent this"。Meta 的"二选一规则"（Agents Rule of Two，2025-10-31 [R6]）：一个会话里三者最多占两个，否则必须有人工把关。会浏览网页、读邮件的代理天然有"不可信内容"和"对外通信"，**一个返回验证码的工具会让它凑齐第三个**。
- **注入至今没有可靠解法**：OpenAI CISO 2025-10："prompt injection remains a frontier, unsolved security problem" [R7][复核]；OWASP LLM01："it is unclear if there are fool-proof methods of prevention" [R12]；Anthropic 公布的浏览器代理注入成功率从 2025-08 的 23.6%（缓解后 11.2%）[R9]，到 2026-08 新评测上的 0%–17.6%（随模型与防护而变，且只在其自有评测上成立）[R7][复核]，同一篇文章还宣布 Claude 会"automatically approve actions it determines to be safe"（可关闭）；12 种已发表的防御被自适应攻击打穿，多数成功率超过 90% [R13]。能"证明安全"的只有架构手段（CaMeL、设计模式论文），而且只对受约束的代理成立 [R13]。
- **已有直接相关的 PoC**：Brave 2025-08-20：Reddit 评论里隐藏的指令让 Comet 读出用户邮箱、在 `perplexity.ai.`（末尾带点）发起 OTP 登录、打开 Gmail 读出 OTP，再把邮箱和 OTP 贴回 Reddit，可接管账户 [R8][复核]。DTap（2026-05）：伪造邮件让代理把 Google 两步验证码转发给外人 [R8]。Varonis SearchLeak（CVE-2026-42824，2026-06）把"MFA 码、OTP"列为窃取目标 [R8]。
- **泄露的 TOTP 是活凭据**：RFC 6238 推荐 30 秒步长、允许一步网络延迟；NIST SP 800-63B-4："SHALL NOT be considered phishing-resistant"，因为手输 OTP 不绑定会话 [R10][复核]；Evilginx 等 AiTM 工具实时中继凭据与验证码，无论用哪种验证器 [R11]。由此推出：泄露的码在它剩余的有效期内可被立即使用，"30 秒有效期"不构成保护；单次使用规则只在合法登录先到时才保护用户 [推断，来源未直接这样说]。
- **MCP 生态的特有问题**：同一客户端里的所有服务器共享一个模型上下文，一个被投毒的服务器可以改变代理怎样使用**别的**服务器的工具（"遮蔽"），工具定义也可以在批准后被悄悄改掉（rug pull）[R1][M4]；已有真实的恶意 MCP 包（postmark-mcp 偷抄全部邮件，2025-09；2026-05 一批伪装成"密钥校验"工具的 MCP 包）[R2]。也就是说，**即使用户只装了可信的代理和 Sixkey，另一个 MCP 服务器也能让代理去调 Sixkey**。

### 3.2 MCP 协议本身给不了的东西

以下按当前规范 2026-07-28 版 [M1][复核]。规范对"人在回路"本身也只写到 SHOULD："there **SHOULD** always be a human in the loop with the ability to deny tool invocations" [M12]。

- **批准界面归客户端，不归服务器**。MCP 的 elicitation（让服务器向用户要输入）由客户端渲染；客户端可以从"用户或其他来源"取得回答 [M3]；Claude Code 文档写明可以用 `Elicitation` 钩子"auto-respond … without showing a dialog" [M7][复核]。所以服务器收到的"accept"什么也证明不了。表单模式还**明令禁止**用来要密码一类的敏感信息 [M3][复核]。→ 用户在场的确认必须发生在 **Sixkey 自己的界面**里。
- **工具注解只是提示**：规范原文"all properties in `ToolAnnotations` are **hints**…Clients should never make tool use decisions based on `ToolAnnotations` received from untrusted servers" [M2][复核]。现实中 VS Code 对 `readOnlyHint` 的工具**不弹确认** [M9]。一个诚实标注为只读的 `get_code` 工具，在 VS Code 里会直接执行。
- **"只给用户看、不给模型看"没有保证**：内容注解 `audience: ["user"]` 是可选提示，路线图甚至考虑废弃它 [M10]。返回值应当一律视为进入模型上下文。
- **不能强制每次都确认**：唯一找到的"每次调用都弹确认、不提供不再询问"的开关，是 Claude Code 的厂商私有字段 `_meta["anthropic/requiresUserInteraction"]` [M7][复核]，仍由客户端执行，SDK 回调也能代为批准。

### 3.3 必要的护栏（若将来做 C6"交接"）

| # | 护栏 | 挡住什么 | 挡不住什么 |
|---|---|---|---|
| G1 | **结构上不返回验证码**：工具的输出 schema 只有 `{status: done \| denied \| expired \| locked \| busy}`；验证码、种子、账户名不出现在任何工具描述、返回值、错误信息、通知文字和日志里 | 码进入模型上下文、对话记录、提供商日志 | 浏览器代理从页面读到（G11 的残余） |
| G2 | **用户在场只认 Sixkey 自己的界面**：请求只让工具栏图标显示角标；用户必须**亲手点 Sixkey 图标**打开弹窗才能看到请求（点击图标是 activeTab 的用户手势 [B1][复核]）。不使用 MCP elicitation 做批准，不提供"总是允许" | 客户端自动批准、钩子代答、表单伪装；**浏览器内的扩展型代理**大概也点不到：`chrome.debugger` 的目标只有"a tab, an iframe or a worker" [B19][复核]，Chromium 源码还拒绝附加到其他扩展的 `chrome-extension://` 页面 [B19][转录]，所以它够不着工具栏和 Sixkey 的弹窗 [推断] | **操作系统层面的**屏幕操作代理（computer use）用真实鼠标点图标和"批准"——在操作系统看来那就是用户；CDP 代理（A10）直接绕过界面（§3.4） |
| G3 | **网站绑定由 Sixkey 核实，不信代理的说法**：弹窗用 activeTab 读到的当前标签页域名，与账户的 `domains` 做现有的后缀匹配（PLAN §9）；不匹配则不提供"批准"，只显示"代理说的是 X，当前页面是 Y"。代理给的 `site_hint` 只用来预选账户 | 让代理在钓鱼页（含 `perplexity.ai.` 这类末尾带点的变体）拿码 | 代理先打开真网站再请求；TOTP 不绑定会话，码在真网站上同样能被读走、转给攻击者 |
| G4 | **一次一用**：每次批准只针对一个账户、一个码、一次复制或填入；请求 60 秒过期；同时最多 1 个待处理请求；不批量 | 一次批准被反复利用 | — |
| G5 | **限速与熔断**：每 10 分钟最多 N 次（建议 3）；连续 3 次拒绝或过期，通道自动关闭，须在设置页输入主密码重新打开 | 刷请求造成的批准疲劳 | 低频、精心挑时机的单次请求 |
| G6 | **尊重锁定**：锁定时直接返回 `locked`，**绝不因代理请求而弹出解锁框**。用户自己解锁后再处理 | 训练用户"代理一要就输主密码"（CDP 代理可截获键入的密码，A10） | — |
| G7 | **默认关闭、按配置文件开启**：设置页开启时重输主密码（与 H3 相同的模式），写明风险；开启期间弹窗常驻提示"代理通道已开启"；开启了同步或被选为"会被脚本控制"（H5）的配置文件，开启前加一道警告 | 无意中开启；在高风险配置文件里开启 | — |
| G8 | **只显示结构化字段**：弹窗只显示请求来自哪个通道、预选的账户、当前页面域名；不显示代理提供的任何自由文本 | 代理用"紧急！请立即批准"之类的话做社会工程 | — |
| G9 | **配对与来源**：走 (a) 时，本机程序与扩展首次连接时用一个 6 位数字互相确认（§3.2 的承诺式思路），之后只接受配对过的那一个；走 (g) 时，只接受 `sender.id` 在白名单内、且用户在设置页逐个启用过的扩展。MCP 客户端或代理扩展的名字一律标为"自称" | 别的本机进程冒充 MCP 宿主；任意已安装扩展冒充代理 | 同一用户下的恶意软件（不在威胁模型内，与 Phase 0 相同）；白名单内的代理扩展本身被注入（它就是"被攻破的代理"，§3.4） |
| G10 | **本地审计，零追踪**：每次请求、批准、拒绝在 `sk_security_log`（H6）里记一条 `{at, kind}`，不记账户名、不记域名、不外传 | 事后发现异常频率 | 拿到配置文件副本的人能改它（H6 已如实说明） |
| G11 | **复制优先于填入**：默认只复制到剪贴板（无需权限，现有清空机制可用）；"填入"需要新增 `scripting` 权限（无安装警告 [B3]）并在用户点击后对该标签页执行，且要改写 PRIVACY 的"never changes the web pages" | 不必为填入改承诺 | 剪贴板对同机程序和能"粘贴再读"的代理都是可读的 |
| G12 | **工具定义固定、注解只做加法**：工具列表随扩展版本发布、不动态变化。注解设 `readOnlyHint: false`、`destructiveHint: false`、`openWorldHint: false`（让 VS Code 这类按注解决定是否确认的客户端弹确认 [M9]），Claude Code 另加 `_meta["anthropic/requiresUserInteraction"]: true` [M7]。这些只让客户端多一道确认，**不计入安全论证** | rug pull 式的定义变更；部分客户端的静默执行 | 客户端侧的投毒与自动批准（不在我们控制范围内） |

### 3.4 残余风险：能不能做到"可接受"

- **会操作浏览器的代理能看见码**。码填进输入框后，DOM 里有它；截图里有它；复制到剪贴板后，代理可以粘贴再读。Skyvern 自己的文档也承认填入的值"can still show up in later screenshots and page text" [V17][复核]。"不进 MCP 返回值"真正买到的是：码不进对话记录与提供商日志、代理不能为**当前页面以外**的网站取码。它买不到"被注入的代理拿不到这一个码"。
- **人的批准看不见代理的意图**。用户看到的是"github.com 的 2FA，当前页面就是 github.com"，于是批准；但代理此刻可能是在替攻击者操作这个已登录的会话（混淆代理）。批准绑定了网站，没有绑定目的。
- **操作系统层面的屏幕操作代理可以自己批准**。它用的是真实的鼠标事件，Sixkey 无法区分人和它。（浏览器内的扩展型代理大概做不到，见 G2 [推断]；这正是选项 g 配合的那一类代理。）唯一它伪造不了的，是带用户验证的 WebAuthn（硬件或平台认证器上的指纹/PIN）：CDP 的 WebAuthn 域只能"start intercepting credential storage and retrieval with a virtual authenticator"，造不出真实凭据的签名 [B5][复核]。这要等 Phase 3 的 WebAuthn，而且每次取码都按一次指纹，摩擦与"自己打开弹窗"相当。
- **CDP 代理已经拥有一切**（A10）。对用 Playwright/Puppeteer/指纹浏览器本地 API 驱动的配置文件，护栏全部无效：它可以直接在 Sixkey 的 SW 里执行代码，读出 VK 与全部种子。
- **恶意 MCP 客户端或被攻破的代理，在护栏下还能做什么**：刷请求（G4、G5 限住）；谎报网站（G3 让它无效）；用文字催促用户（G8 不显示自由文本）；**挑用户正停在目标网站 2FA 页的时机发请求**（挡不住，用户看到的一切都"对得上"）；在码填入或复制之后读走并转发（挡不住，见第一条）。它拿不到种子、拿不到其他网站的码、拿不到账户清单，也不能让 Sixkey 解锁。
- **与之对比，C3–C5 下的同一个代理**：随时、对任意账户、无须用户在场或只需一次可被代点的批准，就能拿到码并写进上下文——护栏无从下手。
- **结论**：C6 最多能做到"不比用户自己在代理控制的浏览器里复制粘贴更差"——那正是今天的现状。它不能被做成"对被攻破的代理安全"。C3、C4、C5、C7、C9、C10 **永远不应发布**：没有任何护栏能弥补"把第二因素交给一个会读不可信内容的模型"。

---

## 4. 更安全的变体："交接"能不能不加权限

### 4.1 逐步看每一步需要什么

| 步骤 | 需要的能力 | 现有权限够吗 | 不够时要让步的承诺 |
|---|---|---|---|
| ① 代理把"我在 X 的 2FA 这一步"送到 Sixkey | 一个从扩展外部进来的通道 | **权限上够，代码上没有**：其他扩展本来就能给 Sixkey 发消息（选项 g），只是 Sixkey 没有监听；本机程序和云端代理则联系不到 | 走 (g)：不让步权限，但要信任一个第三方扩展 ID、并等对方集成；否则 `nativeMessaging` + 本机程序（"只是一个扩展"），或 localhost（"只连一个 origin"），或服务器中转（零追踪） |
| ② 提示用户 | 工具栏角标 `action.setBadgeText` | 够（无需权限，SYNC-DESIGN §3.11 已用） | — |
| ③ 核实当前网站 | 当前标签页的 URL | 只有在用户**点击 Sixkey 图标**之后才够（activeTab）。没有 `tabs` 或 host 权限时，`tabs.Tab.url` 只对这两类权限可见 [B1][B2][复核] | 想不经点击就核实，必须加 `tabs`（警告"Read your browsing history"[B3][复核]）或 host 权限 |
| ④ 批准 | 弹窗 | 够 | — |
| ⑤a 复制 | 弹窗内 `navigator.clipboard.writeText` | 够（现有，无需权限） | — |
| ⑤b 填入 | `scripting.executeScript` + activeTab | **不够**：需新增 `scripting`（无安装警告）；只能在用户点击之后、对该标签页 | PRIVACY："never reads or changes the web pages you visit" |
| ⑥ 告诉代理结果（`done/denied`） | 同 ① 的通道 | 同 ① | 同 ① |

- 用户点击工具栏图标时，即使设置了弹窗，Chrome 也会授予 activeTab（Chromium 源码 `ExtensionActionRunner::RunAction` 先 `GrantTabPermissions` 再返回"显示弹窗"[B12][转录]）——这正是 Sixkey 今天"当前网站排第一"所依赖的。
- `action.openPopup()` 在 Chrome 127 起对所有扩展可用 [B4][复核]，但**由程序打开的弹窗是否获得 activeTab 授权，文档没有写**，也没找到可靠来源 [未核实]。设计应假定**不获得**，即第 ③ 步必须靠用户亲手点击。
- activeTab 授权**持续到该标签页导航离开或关闭** [B1][复核]。所以用户在某页打开过一次弹窗之后，一个由本机消息触发的 `executeScript` 很可能仍能在那一页执行 [转录，推断]。这意味着"填入需要用户手势"**不能**当作批准：G2/G4 的逐次批准必须由 Sixkey 自己强制。另一方面，从登录页跳到 2FA 页通常是一次导航，授权随之失效，用户需要在 2FA 页上再点一次图标——这对"交接"流程正合适。
- 跨源 iframe 里的 2FA 输入框大概不在授权范围内 [未核实]。
- 结论：**不加权限时，"交接"等于今天的弹窗**——用户点图标，当前网站的账户排第一，回车复制。差别只在第 ① 和 ⑥ 步。最小的让步是选项 (g)"只接受白名单内代理扩展的消息 + 只复制不填入"，它不需要新权限，但取决于对方；其次才是"可选 `nativeMessaging` + 本机程序 + 只复制不填入"。

### 4.2 与竞品的同类实现对照

1Password for Claude（2026-07-16）："The password and the MFA one-time code are never accessible to the model, its context, or Anthropic's systems"；每个任务一次生物识别批准，按会话授权、限定在一组已批准的条目；需要 1Password 桌面程序与浏览器扩展，以及 Claude 桌面程序与浏览器扩展，仅 Mac [V2][复核]。也就是说，**头部厂商做"交接"时同样依赖桌面程序**；它的批准是"每任务一次"而不是"每个码一次"。Sixkey 没有桌面组件，做同样的东西就要先接受架构 (a)。身份厂商的同类模式也是"先批准、后放行"：Auth0 的异步授权只在用户批准该笔操作后才给代理发 token [V21]。

另一个对照：Claude in Chrome 扩展本身声明了 `nativeMessaging`、`debugger`、`tabs`、`scripting`、`<all_urls>` 与全站内容脚本 [B9][转录]。代理扩展需要的权限与 Sixkey 的"最少权限"正好相反；"交接"让 Sixkey 与这样的扩展协作，而不必变成它。

---

## 5. 需求与定位

### 5.1 谁会用

| 人群 | 他们今天怎么做 | 需要 Sixkey-MCP 吗 | 对 Sixkey 的风险 |
|---|---|---|---|
| 指纹浏览器 + 脚本化配置文件 | 厂商把 2FA 密钥存进配置文件（AdsPower `fakey`、BitBrowser `faSecretKey`、MoreLogin `otpSecret`，见指纹浏览器调研 §摘要 5）。AdsPower 官方 MCP（官方博客 2025-11 介绍，仓库 2026-07 仍有提交）的建档/更新工具接受 `fakey`、账号、密码、cookie，其测试用例显示列表读回包含 `fakey`，还有 `evaluate-script`、`fill-input` 等页面操作工具 [V22][V23][复核]；GoLogin、Multilogin 也有 MCP（多为社区或第三方）[V25][摘要] | **不需要**：他们的模型已经能直接拿到种子 | Sixkey 对他们的价值是**把种子和配置文件、厂商云分开**（指纹浏览器调研的结论）。一个把码交给脚本的 MCP 会把两者重新合在一起；而且这些配置文件本来就被 CDP 控制（A10） |
| QA / 测试自动化 | 测试账号的密钥放在 CI 密钥库或环境变量，用 otpauth / otplib 现场生成 [V24][复核]；Skyvern、Browser Use 等框架自带 TOTP 支持，自己保存种子 [V17][V18] | **不需要**：测试账号的种子本来就该放在 CI 里，不该放在某个人的验证器里 | 鼓励用户把真实账户的 2FA 交给测试脚本 |
| 个人代理用户（Claude Desktop/Code、浏览器代理） | 代理在登录与 2FA 处停下，让用户接管（OpenAI 的代理 [V20]）；Claude in Chrome 在"输入敏感信息"前必须询问 [V19]；或用 1Password 的注入 [V2] | 少数人想要"让代理一路做完"，这正是危险的那部分（§3） | 最大的风险人群：他们的代理读网页、读邮件，正好凑齐致命三要素 |

需求信号：我找到的"给 AI 用的 TOTP MCP"都是个人项目或小厂商（FirstOrder.AI 46 星、mgcrea/mcp-totp 0 星、authn8 等），没有找到任何主流验证器（Google、Microsoft、Authy、2FAS、Ente、Aegis）提供 MCP [V12][V13][V14][摘要]。这说明"需求存在但小众"，不说明它值得做。

### 5.2 竞品怎么做

两种阵营（详见 §9 V 组来源）：
- **模型永远看不到值**：1Password 的全部代理产品（Environments MCP 不能返回密钥值、Secure Agentic Autofill、1Password for Claude）[V1][V2][V3][V4]；Dashlane 的 MCP 只读审计日志，明言"does not allow AI agents to autonomously access or operate on your vault" [V9]；Skyvern、Browser Use 用占位符 [V17][V18]。
- **介于两者之间或尚未成型**：Bitwarden Agent Access SDK（2026-03 预览，博客说代理看不到明文，但 `aac connect` 的 JSON 输出含密码与 TOTP 字段，README 自己劝人别把凭据喂给 LLM）[V7]；Proton Pass 给代理的是限定库、只读、可设期限、每次访问记理由的访问令牌 [V10]；LastPass 2026-08 说正在做 MCP [V11]。
- **值进入模型上下文**：Bitwarden 官方 MCP（"retrieve TOTP codes"，只有解锁这一道门，并建议用本地模型）[V6][复核]；Keeper KSM MCP（默认打码，确认后可取消打码）[V8]；Azure Key Vault MCP（默认 elicitation 确认，可关）[V15]；HashiCorp、Doppler、Infisical（默认不打码）[V16]；FirstOrder.AI 验证器（返回验证码**和密码**）[V12]；authn8、各类社区 TOTP 服务器 [V13][V14]。社区作者自己的评价是："automation on that machine is effectively single-factor" [V14]。

### 5.3 与品牌是否相容

Sixkey 的取舍原则是"信任 > 增长手段"（PLAN §0）。"把验证码交给 AI"在三处与它冲突：
1. 第二因素的意义：把码交给代理，等于把"你有的东西"变成"你的代理能拿到的东西"，双因素降为单因素。
2. 最少权限：每条通道都要新权限或新组件，"只是一个扩展、无 host 权限、无内容脚本"是现在商店页面上最好讲的一句话。
3. 零追踪：账户清单（C2）或请求记录（d2）都会离开本机。

反过来，**"我们不做，因为……"本身就是一个信任卖点**，与 1Password、Dashlane 的公开立场一致。

---

## 6. 建议与分阶段计划

**建议：不做（现在）。只做零代码的 S0；"交接"（C6）列为条件满足后再评估的备选；C3、C4、C5、C7、C9、C10 永不做；C0、C1、C2、C8 不做（没有需求，或冲突零追踪、永不丢数据）。**

理由排序：(1) 返回验证码的方案没有护栏能救（§3.4）；(2) 安全的变体在现有权限下等于现有弹窗，增量只来自通道，而通道要么被否决过、要么取决于第三方（§4.1）；(3) 三类用户里两类不需要它，第三类恰好是风险最高的（§5.1）；(4) 它会占用 Phase 1 同步的实施精力，而同步是"永不丢数据"的一部分。

| 阶段 | 内容 | 规模 | 时机 | 验收 |
|---|---|---|---|---|
| **S0（建议现在做）** | ① H8 指南加一节《AI 代理与自动化》：代理控制的配置文件 = A10，用"每次都锁定"、不开同步；不要把验证码贴进对话；QA 用测试账号、密钥放 CI；代理要登录时自己接管完成 2FA。② SECURITY.md 的威胁表里点明"被代理驱动的配置文件"属于 A10。③ 若所有者同意（§7 Q1），在 SYNC-DESIGN §13 增加一行"向模型或代理返回验证码、种子或账户清单"及理由。全部零代码 | S | 随 H8 一起，与 Phase 1 并行，不影响 M0–M8 | 人工审阅 |
| **S1（仅在触发条件满足后评估）** | 交接原型，**先评估选项 (g)**：只接受白名单内代理扩展的 `onMessageExternal` 请求；请求只有 `{site_hint}`，回复只有 `status`；只复制、不填入；G1–G12 全部；`check-dist` 只为 `externally_connectable.ids` 放开（若决定在清单层面限定 ID）。**(g) 不可行时**才考虑 (a)：可选 `nativeMessaging`（不在不可选清单里 [B6]；在设置页按钮里申请，满足"用户手势内申请"）+ 已签名的本机程序（stdio MCP 服务器；宿主与它之间的 IPC 必须认证，吸取 [B8] 的教训），工具只有 `handoff_2fa(site_hint)` 与 `lock_now` | (g)：1 M（监听与白名单、弹窗请求界面与限速）+ 文档，外加与对方的接口约定。(a)：1 L（三平台本机程序、安装与签名、商店说明）+ 2 M（配对、弹窗请求界面与限速）+ 文档 | 最早在 Phase 2 上架之后；最好在 Phase 3 WebAuthn 之后（批准可以要求用户验证） | 端到端：代理请求 → 角标 → 点图标 → 域名匹配才可批准 → 剪贴板有码、回复与 MCP 返回值里都没有；白名单外的扩展发来的请求被丢弃且不显示；锁定时返回 `locked` 且不弹解锁；连续 3 次拒绝后通道关闭；网络白名单测试仍过 |
| **永不** | C3、C4、C5、C7、C9、C10；架构 (c)、(d) | — | — | — |

**S1 的触发条件**（满足任意一条才值得重新评估，且仍需所有者批准）：
1. 真实用户（非指纹浏览器批量场景）提出的、明确的"交接"需求累积到所有者认为值得的程度。
2. Chrome 提供让扩展向浏览器内代理暴露能力、并由浏览器负责用户在场确认的正式 API（现状见 §2 末尾：WebMCP 是网页侧 API，没有扩展侧的代理 API）。
3. MCP 规范落地"human-presence attestation"（路线图上仍在讨论 [M10]），或 Sixkey 有了 WebAuthn 用户验证（Phase 3）。
4. 某个代理扩展厂商主动提出集成，愿意定义并维护选项 (g) 的消息接口，并接受"只拿到状态、拿不到码"。

**复杂度预算**：S0 不超过 1 个 S；S1 若启动，上限 1 L + 2 M，不许出现第二个 L；任何超出预算的需求（填入、账户列表、多客户端）先回到所有者。

---

## 7. 需要所有者决定的问题

| # | 问题 | 推荐 |
|---|---|---|
| Q1 | 是否把"向模型或代理返回验证码、种子或账户清单（C2–C5、C7、C9、C10）"正式写进 SYNC-DESIGN §13 不做清单？ | **是**。理由写成一句：第二因素交给会读不可信内容的模型就不再是第二因素；头部厂商的公开原则相同。 |
| Q2 | 现在是否建任何通道（扩展间消息、native messaging、localhost、服务器中转）？ | **否**。交接（C6）列为 §6 触发条件满足后再评估的备选。 |
| Q3 | 是否在 H8 指南里加《AI 代理与自动化》一节（S0）？ | **是**，零代码，与 H8 一起做。 |
| Q4 | 若将来做交接，通道选哪条？是否接受为它推翻 §13 的"只是一个扩展"（可选 `nativeMessaging` + 本机程序）？ | **倾向：不推翻**。触发条件出现时先评估选项 (g)（扩展间消息，无新权限）；只有 (g) 因对方不配合而不可行、且需求确实存在时，才把 (a) 拿回来重议。 |

---

## 8. 本报告没有做的事

- 没有实测任何 MCP 客户端与扩展的通信；Chrome 方面的结论来自文档。
- 没有评估 Firefox / Safari 的对应机制（PLAN 只做 Chrome）。
- 没有在 SYNC-DESIGN 或其他文档里做任何修改；需要改的地方都列在 §6 S0 和 §7。

---

## 9. 来源

日期为页面所示的发布或更新日期；规范页面没有页面日期，以修订版号代替。抓取时间均为 2026-10-15。

### M：MCP 规范与客户端

| # | 来源 | 内容 | 标记 |
|---|---|---|---|
| M1 | https://modelcontextprotocol.io/specification/versioning | 当前修订版 2026-07-28（"latest"）；changelog 见 https://modelcontextprotocol.io/specification/2026-07-28/changelog | [复核]；changelog [转录] |
| M2 | https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts | `ToolAnnotations` 全是 hints，"Clients should never make tool use decisions based on…untrusted servers" | [复核] |
| M3 | https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation ；https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr | 表单模式 MUST NOT 索要密码等敏感信息；URL 模式；客户端"from the user or other sources"取得回答 | MUST NOT 一句 [复核]；其余 [转录] |
| M4 | https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/local-server-security | "Binding to 127.0.0.1 is not an authentication boundary"；共享上下文、工具投毒、rug pull | 第一句 [复核]；其余 [转录] |
| M5 | https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/index | HTTP 传输用 OAuth 2.1、RFC 9728、RFC 8707、CIMD；stdio "SHOULD NOT follow this specification" | [转录] |
| M6 | https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices | 混淆代理、token 透传禁令、SSRF、状态句柄劫持、本地服务器被攻破等 11 节 | [转录] |
| M7 | https://code.claude.com/docs/en/mcp ；https://code.claude.com/docs/en/hooks | `Elicitation` 钩子可"auto-respond … without showing a dialog"；`_meta["anthropic/requiresUserInteraction"]` | [复核]（原文 grep） |
| M8 | https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp | 自定义连接器从 Anthropic 云端连接远程 MCP 服务器，localhost 不可达 | [转录] |
| M9 | https://code.visualstudio.com/api/extension-guides/ai/mcp （2026-10-14） | 未标 `readOnlyHint` 的工具才弹确认 | [转录] |
| M10 | https://modelcontextprotocol.io/development/roadmap （2026-08-22） | 内容注解可能废弃；"human-presence attestation"在讨论中 | [转录] |
| M11 | https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http | 服务器 MUST 校验 `Origin`；本地 SHOULD 只绑 127.0.0.1；SHOULD 认证 | [转录] |
| M12 | https://modelcontextprotocol.io/specification/2026-07-28/server/tools | "there SHOULD always be a human in the loop…" | [转录] |

### V：厂商与产品

| # | 来源 | 内容 | 标记 |
|---|---|---|---|
| V1 | https://1password.com/blog/where-mcp-fits-and-where-it-doesnt （2025-07-16） | "we will not use MCP to expose raw credentials or secrets" | [复核] |
| V2 | https://1password.com/press/2026/july/1password-for-claude （2026-07-16）；https://support.claude.com/en/articles/15936181 | 密码与一次性码"never accessible to the model"；单次生物识别批准、按会话、限定条目；需双方桌面程序与扩展；仅 Mac。Claude 帮助页称 beta、付费计划 | 新闻稿 [复核]；帮助页 [转录] |
| V3 | https://1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents （2025-10-08） | Secure Agentic Autofill：人批准后注入，代理与 LLM 看不到 | [转录] |
| V4 | https://1password.dev/environments/mcp-codex-server | Environments MCP 不能返回密钥值；授权持续到 1Password 锁定 | [转录] |
| V5 | https://1password.com/blog/security-principles-guiding-1passwords-approach-to-ai （2025-08-07） | "Raw credentials should never enter the LLM context" | [转录] |
| V6 | https://github.com/bitwarden/mcp-server | "retrieve TOTP codes"；仅限本机；解锁走系统密码框；建议本地模型 | [复核]；发布日期 2025-07-10 [摘要] |
| V7 | https://github.com/bitwarden/agent-access | Agent Access SDK，早期预览；`aac connect` 输出含密码与 TOTP | [转录] |
| V8 | https://github.com/Keeper-Security/keeper-mcp-golang-docker | `get_totp_code`；默认打码、确认后取消；`--auto-approve` | [转录] |
| V9 | https://www.dashlane.com/blog/mcp-server-audit-log-access （2026-02-12）；https://www.dashlane.com/blog/ai-browsers （2026-01-14） | 只读审计日志 MCP；"does not allow AI agents to autonomously access or operate on your vault" | [转录] |
| V10 | https://proton.me/blog/pass-access-tokens （2026-05-21） | 代理访问令牌：限定库、只读、期限、审计理由 | [转录] |
| V11 | https://blog.lastpass.com/posts/webinar-recap-minding-the-agents （2026-08-31） | 正在开发 MCP | [转录] |
| V12 | https://github.com/firstorderai/authenticator_mcp | 验证器厂商自己的 MCP，返回 2FA 码和密码 | [转录] |
| V13 | https://github.com/authn8/mcp-server | `get_otp` 返回码；令牌限定范围；未述批准 | [复核] |
| V14 | https://github.com/mgcrea/mcp-totp | "A code returned by `totp_get_code` enters the transcript"；"effectively single-factor" | [转录] |
| V15 | https://learn.microsoft.com/azure/developer/azure-mcp-server/tools/azure-key-vault （2026-05-26） | 取密钥值默认 elicitation 确认，可关闭 | [转录] |
| V16 | https://github.com/hashicorp/vault-mcp-server ；https://docs.doppler.com/docs/mcp ；https://github.com/Infisical/infisical-mcp-server | 密钥值进入模型；Infisical 打码默认关闭 | [转录] |
| V17 | https://www.skyvern.com/docs/cloud/managing-credentials/totp-setup | 自存 TOTP 密钥、自动生成；模型拿占位符；填入的值仍可能出现在截图与页面文字中 | [复核] |
| V18 | https://docs.browser-use.com/open-source/customize/browser/authentication | `sensitive_data` 占位符；`bu_2fa_code` 由种子生成；建议关视觉 | [转录] |
| V19 | https://support.claude.com/en/articles/12902428 ；https://support.claude.com/en/articles/12902446 | Claude in Chrome 输入敏感信息前必须询问；"The risk is not zero" | [转录] |
| V20 | https://help.openai.com/en/articles/11752874 | OpenAI 代理在登录处让用户接管 | [摘要]（页面 403） |
| V21 | https://auth0.com/blog/auth0-for-ai-agents-generally-available （2025-11-19） | 异步授权（CIBA）：用户批准该操作后才发 token | [转录] |
| V22 | https://github.com/AdsPower/adspower-browser （原 `local-api-mcp-typescript`，最后提交 2026-07-20）`packages/core/src/types/schemas.ts` | `createBrowser` 接受 `fakey`（"2FA key"）、`username`、`password`、`cookie`；`evaluateScript` 工具；列表读回含 `fakey`（测试用例） | [复核]（下载源码） |
| V23 | https://www.adspower.com/blog/adspower-local-api-mcp-server （2025-11-14，更新 2026-05-29） | AdsPower 官方 Local API MCP | [复核] |
| V24 | https://checklyhq.com/learn/playwright/bypass-totp | 测试中用 `otpauth` 与环境变量里的密钥生成 TOTP | [复核] |
| V25 | https://mcpservers.org/servers/gologinapp/gologin-mcp ；https://glama.ai/mcp/servers/qrzm3857tv | GoLogin 官方 MCP；Multilogin 社区 MCP | [摘要] |

### R：攻击与研究

| # | 来源 | 内容 | 标记 |
|---|---|---|---|
| R1 | https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks （2025-04-01）；https://invariantlabs.ai/blog/whatsapp-mcp-exploited （2025-04-07）；https://invariantlabs.ai/blog/mcp-github-vulnerability （2025-05-26） | 工具投毒、rug pull、跨服务器遮蔽；GitHub MCP 注入泄露私库 | [转录] |
| R2 | Koi Security 关于 postmark-mcp 的报告（2025-09，经 web.archive.org 阅读）；https://osv.dev/vulnerability/MAL-2026-4206 （2026-05-20） | 首个在野恶意 MCP 服务器（BCC 偷抄邮件）；2026 年伪装成密钥校验工具的恶意 MCP 包 | [转录] |
| R3 | https://www.oligo.security/blog/critical-rce-vulnerability-in-anthropic-mcp-inspector-cve-2025-49596 （2025-06-27） | MCP Inspector 本机代理无认证 → RCE（CVE-2025-49596） | [转录] |
| R4 | https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-w48q-cv73-mx4w ；NVD CVE-2025-66416、CVE-2025-9611 | 官方 SDK 对本机 HTTP 服务器默认未开 DNS rebinding 防护；Playwright MCP 未校验 Origin | [转录] |
| R5 | https://www.obsidiansecurity.com/blog/when-mcp-meets-oauth-common-pitfalls-leading-to-one-click-account-takeover （2026-01-29） | 远程 MCP 的 OAuth 实现导致一键接管账户 | [转录] |
| R6 | https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/ （2025-06-16）；https://ai.meta.com/blog/practical-ai-agent-security/ （2025-10-31） | 致命三要素；Agents Rule of Two | 前者 [复核]；后者 [转录] |
| R7 | https://simonwillison.net/2025/Oct/22/openai-ciso-on-atlas/ （2025-10-22）；https://claude.com/blog/claude-in-chrome-generally-available （2026-08-26）；https://blog.google/security/architecting-security-for-agentic/ （2025-12-08） | "prompt injection remains a frontier, unsolved security problem"；Claude in Chrome 新评测的攻击成功率与自动批准；Google："the model does not have direct access to stored passwords" | 前两项 [复核]；Google [转录] |
| R8 | https://brave.com/blog/comet-prompt-injection/ （2025-08-20）；arXiv 2605.04808（DTap，2026-05-06）；https://www.varonis.com/blog/searchleak （2026-06-15，CVE-2026-42824） | 代理被注入后读出 OTP 并外泄；转发两步验证码；以 OTP 为目标的 Copilot 漏洞 | Brave [复核]；其余 [转录] |
| R9 | https://claude.com/blog/claude-for-chrome （2025-08-25）；https://www.anthropic.com/research/prompt-injection-defenses （2025-11-24） | 23.6% → 11.2%；自适应攻击下 1%，"No browser agent is immune" | [转录] |
| R10 | https://www.rfc-editor.org/rfc/rfc6238 §5.2；https://pages.nist.gov/800-63-4/sp800-63b.html | 30 秒步长；手输 OTP "SHALL NOT be considered phishing-resistant" | [复核] |
| R11 | https://breakdev.org/evilginx-2-next-generation-of-phishing-2fa-tokens/ （2018-07-26）；Microsoft Security 博客 AiTM 活动（2022-07-12）；CISA 防钓鱼 MFA 说明（2022-10） | 实时中继无视验证器类型；应用 OTP"Vulnerable to phishing attacks" | [转录] |
| R12 | https://genai.owasp.org/llmrisk/llm01-prompt-injection/ ；https://owasp.org/www-project-mcp-top-10/ | "unclear if there are fool-proof methods of prevention"；MCP01 密钥在上下文中泄露 | [转录] |
| R13 | arXiv 2510.09023（The Attacker Moves Second，2025-10-10）；arXiv 2503.18813（CaMeL）；arXiv 2506.08837（Design Patterns，2025-06-10） | 12 种防御被自适应攻击打穿；只有受约束的架构能给出可证明的性质 | [转录] |

### B：浏览器（Chrome）

| # | 来源 | 内容 | 标记 |
|---|---|---|---|
| B1 | https://developer.chrome.com/docs/extensions/develop/concepts/activeTab | 四种用户手势；授权到导航离开为止；无安装警告；`executeScript` 需同时声明 `scripting` | [复核] |
| B2 | https://developer.chrome.com/docs/extensions/reference/api/tabs （2026-09-24） | `url`/`title` 等只对 `tabs` 权限或 host 权限可见 | [复核] |
| B3 | https://developer.chrome.com/docs/extensions/reference/permissions-list （2026-09-09） | 警告文字：`tabs` "Read your browsing history"；`nativeMessaging` "Communicate with cooperating native applications"；`debugger` 两条；`scripting`/`activeTab` 无警告 | [复核] |
| B4 | https://developer.chrome.com/docs/extensions/reference/api/action （2026-09-11） | `openPopup()` Chrome 127+；未说明是否授予 activeTab | [复核] |
| B5 | https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json | CDP WebAuthn 域：虚拟认证器"intercepting credential storage and retrieval"；`addCredential` 需由调用方提供私钥 | [复核] |
| B6 | https://developer.chrome.com/docs/extensions/reference/api/permissions （2026-09-11） | 不可选权限清单不含 `nativeMessaging`；`permissions.request` 须在用户手势内 | [复核] |
| B7 | https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging （2026-09-16）；https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings | 每次连接新启宿主进程；宿主清单路径；用户级优先（Chromium `launch_context_*.cc`）；更新新增警告权限会停用扩展 | [转录] |
| B8 | https://www.originhq.com/research/claude-for-chrome-takeover （2026-03-30） | Claude 本机宿主的命名管道"accessible to the Everyone group"、无客户端认证；报告以"需要本地代码执行"关闭 | [复核] |
| B9 | Claude in Chrome CRX v1.0.100 的 manifest 与 JS；https://code.claude.com/docs/en/chrome ；https://code.claude.com/docs/en/network-config | 权限清单；两个 native messaging 宿主名；云端 WebSocket 中继 | [转录] |
| B10 | https://developer.chrome.com/docs/extensions/develop/concepts/network-requests ；https://developer.chrome.com/blog/local-network-access ；chromium-extensions 讨论 https://groups.google.com/a/chromium.org/g/chromium-extensions/c/pUDh8RiTjJk | 无 host 权限时跨源请求受 CORS 约束；LNA 不打算限制有 host 权限的扩展 | [转录]；WebSocket 无需 host 权限 [未核实] |
| B11 | Playwright MCP Bridge、Browser MCP 的 CRX；https://github.com/williamkapke/kapture ；https://github.com/hangwin/mcp-chrome | 现有桥的权限与传输方式 | [转录] |
| B12 | Chromium `chrome/browser/extensions/extension_action_runner.cc` | 点击图标即授予 activeTab，即使设置了弹窗 | [转录] |
| B13 | https://pptr.dev/guides/chrome-extensions | Puppeteer 可在扩展 SW 中 `evaluate` | [转录] |
| B14 | https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session （2025-12-11）；https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md | `--autoConnect` 连接用户现有会话（M144），每次弹许可框；`evaluate_script` 支持 `serviceWorkerId` | 博客 [复核]；工具参考 [转录] |
| B15 | https://developer.chrome.com/docs/webstore/program-policies/policies | 最窄权限、单一用途、Limited Use；无本机程序专门条款 | [转录] |
| B16 | https://developer.chrome.com/docs/ai/webmcp （2026-10-07）；https://github.com/webmachinelearning/webmcp | WebMCP 网页侧 API，Chrome 149 起源试用；扩展可经内容脚本调用 | [转录] |
| B17 | https://blog.google/products-and-platforms/products/chrome/gemini-3-auto-browse/ | auto browse 敏感操作前暂停；经许可使用 Google 密码管理器 | [转录] |
| B18 | https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable | 未声明时"all extensions can connect, but no web pages can connect"；`ids` 为空则无扩展可连；`matches` 为空则无网页可连 | [复核] |
| B19 | https://developer.chrome.com/docs/extensions/reference/api/debugger （2026-10-05）；Chromium `debugger_api.cc` | 目标只有"a tab, an iframe or a worker"；附加到扩展后台页需 `--silent-debugger-extension-api`；源码拒绝其他扩展的 `chrome-extension://` URL | 文档 [复核]；源码 [转录] |

### 未能核实的点

- 由 `action.openPopup()` 程序打开的弹窗是否获得 activeTab 授权。
- MV3 扩展不声明 host 权限、只改 CSP 时，能否向 `ws://127.0.0.1` 建立 WebSocket；对 `http://127.0.0.1/*` 的 host 权限的准确警告文字。
- 跨源 iframe 中的 2FA 输入框是否在 activeTab 授权范围内。
- 浏览器内的扩展型代理（经 `chrome.debugger`）是否确实无法点击工具栏图标或其他扩展的弹窗（G2 的推断）。
- OpenAI 代理产品的登录接管说明（help.openai.com 返回 403，只有摘要）。
- Bitwarden MCP 的发布日期（2025-07-10）只见于新闻稿摘要。
- 指纹浏览器的 Chromium 分支是否保留 Chrome 136 对默认配置文件远程调试的限制。
- 没有找到"代理在真实环境中泄露 2FA 码"的已确认事件；§3.1 引用的都是 PoC 或评测。
