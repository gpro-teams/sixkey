# Sixkey 的 YubiKey 支持：设计（YUBIKEY-DESIGN）

> **Proposal, not implemented.** A design for optional YubiKey support (in Chinese). Nothing in this repository
> implements it, and the shipped extension has no `nativeMessaging` permission. Its review,
> `docs/audit/internal-reviews/YUBIKEY-REVIEW.md`, was an AI-model review session (called "独立评审", independent
> review, in the text below), not a third-party audit. 设计提案，尚未实现；下文所说的"独立评审"是另一个 AI 模型会话
> 所做的评审，不是第三方审计。

日期：2026-10-16。状态：**设计稿 · 修订 1（采纳独立评审 `docs/audit/internal-reviews/YUBIKEY-REVIEW.md`）· 所有者问题全部已决（§0.00），未实现**。本文只写设计，不改 `src/`、测试、清单、脚本、`docs/history/PLAN-zh.md`、`docs/SYNC-DESIGN.md` 或其他文档；凡是要改别的文档的地方，都写成"要改什么"的清单，由那份文档的负责人去改。

依据：所有者 2026-10-16 的决定（读过 `docs/research/yubikey-oath-feasibility.md` 之后）：

- **A**：在 Sixkey 里显示 YubiKey 的 OATH 应用算出的 TOTP/HOTP 码。所有者接受代价：一个**可选**的 `nativeMessaging` 权限，加一个单独安装的本机程序（下文叫"助手"，host）。这一点**推翻** SYNC-DESIGN §13 的"只是一个扩展"，但只为这一个功能。
- **C**：用 YubiKey 当 Sixkey 保险库的解锁因子（WebAuthn PRF / hmac-secret，PLAN Phase 3）。
- **B**（把种子写进钥匙）：没有决定，本文按"范围外"处理，理由见 §7.5。

标记沿用调研报告：**[复核]** 我取回原文自己读过；**[转录]** 只经 WebFetch 转述或别的文档转引（含"评审已复核"：评审 YUBIKEY-REVIEW 读过原文、我没有重读的）；**[摘要]** 只有搜索摘要；**[推断]** 我的推理；**[未核实]**；**[估计]** 未测量的数字。Chromium 源码读的是 GitHub 镜像 `main`（2026-10-16），标"源码 main"，不一定等于稳定版二进制。

---

## 0.00 所有者决定（2026-10-16）

读过修订 1 之后，所有者对 §7.4 的问题与新增的 D24 作了决定。这些不再讨论；决策表与 §7.4 已相应标注。

| 决定 | 内容 | 本文对应 |
|---|---|---|
| **D24 采纳**（作为纵深防御） | 父浏览器带 `--remote-debugging-port` / `--remote-debugging-pipe` 启动时助手拒绝服务；按文中写明的局限对外说明（运行时开启的调试、改名的开关、操作系统层面的代理挡不住） | D24、§3.3、§4.5 A11、§4.6 |
| **Q5：第一版不含 HOTP** | 助手对 HOTP 凭据一律 `unsupported`；schema 仍接受 HOTP 钥匙条目；"记住应用密码"保留、默认关、带警告 | D21、§2.1、§2.8、§1.1.5 |
| **Q3 采纳原文** | Rust；源码以 MIT 或 Apache-2.0 公开；只做系统级安装；购买 Apple Developer ID 与 Windows 代码签名；Linux 动态 glibc 构建；扩展侧停用开关随商店更新；A 的工作量约 8–10 周；**A 只能在商店 ID 存在之后发布** | §3.1、§3.9–§3.12、D18、D22、D23、§7.1 |
| **Q1 采纳** | C 的 RP ID 用扩展自己的 origin（`chrome-extension://<id>`，不设 `rp.id`），以 G1 通过为前提 | D14、§1.2.6、§7.3 G1 |
| **Q2 采纳** | C 第一版只支持插在电脑上的安全密钥，由代码强制（BE 位、传输方式、附着方式）。**2026-10-19 所有者修订**：这条只约束安全密钥；平台认证器另按 `QUICK-UNLOCK.md` §0.5 Q2——Windows Hello 可用；会同步的通行密钥跨重启解锁只作用户自选、默认关闭，并先给出白话说明 | D25、§1.2.2 |
| **Q4 采纳** | A 的数据模型进第一个商店版本，不等 G2 | §2.2、Y5a |

---

## 0.0 修订 1：独立评审（`docs/audit/internal-reviews/YUBIKEY-REVIEW.md`，31 条）

每一条都先对照本文、代码与引用的来源核实过。我自己重新取回原文核实的：YR-1（`permissions_updater.h` 的 `kSoft`/`kHard`、`permissions_api.cc` 的"不为已授予的权限提示"）、YR-3（ykman `_cli/oath.py` 把 `SECURITY_CONDITION_NOT_SATISFIED` 当作触碰超时；yubioath-flutter `time() - start > 5`；YKOATH 规范各指令的状态字）、YR-4（ykneo-oath 的 `CLEAR_ON_DESELECT`）、YR-26（`~NativeMessageProcessHost` → `EnsureProcessTerminated`；`kill_posix.cc`/`kill_mac.cc` 等 2 秒后 SIGKILL，没有 SIGTERM）、YR-28（libfido2 `winhello.c`："webauthn.dll ignores requests to enable hmac-secret unless a discoverable credential is also requested"）、YR-30（`chrome_web_authentication_delegate.cc` 的 `MaybeGetRelyingPartyIdOverride` 返回 `caller_origin.Serialize()`），以及 YR-13、YR-14、YR-24、YR-25 与 R1–R8 引用的全部代码行（`service.ts:582/834–840/858`、`FirstRun.tsx:29`、`Rail.tsx:36`、`Backup.tsx:300`、`Security.tsx:53`、`ui/otp.ts:9–18`、`ui/hooks.ts:11`、`importer.ts:206`、`keybundle.ts:56`、`security-log.ts:147`、`store.ts:303`、`read-budget.test.ts`、`smoke.spec.ts:53`）。评审的其余外部事实（Chromium 提交、FIDO MDS3、`webauthn.h`、策略定义）按 [转录] 处理。

**结果：31 条全部采纳（2 条部分采纳，见 YR-15、YR-25 的说明），0 条拒绝，0 条推迟。** 没有需要重新设计的地方。YR-25 与评审的那处分歧已在下表裁定（回收站里的钥匙条目让库保持 v2）。

| 编号 | 级别 | 裁定 | 改了什么 |
|---|---|---|---|
| YR-1 | High | 采纳 | 预设**不再声称**关掉 A：`permissions.remove` 是软移除，A10 能无提示地申请回来。D20、§1.1.1、§4.5 A11、§4.6、§5.3、§5.4 重写；真正的控制写成：这台电脑不装助手、钥匙不常插、重要账户用触碰或应用密码。新增一道**助手侧**控制：父浏览器以 `--remote-debugging-port/pipe` 启动时助手拒绝服务（D24，诚实写明是启发式）。`permissions.onAdded` 写安全记录（只是事后痕迹）。预设下扩展不连接（只防误用） |
| YR-2 | Medium | 采纳 | **第一版不计算 HOTP**：助手对 HOTP 凭据一律回 `unsupported`（D21）；schema 仍接受 HOTP 钥匙条目，免得以后放开时让旧客户端把库当损坏。§0、D5、§3.3、A11、§4.6、N4/N5、Q5 改正"只有当前码"的说法 |
| YR-3 | Medium | 采纳 | §3.3 增加按指令的状态字表；`6982` 在触碰凭据的 CALCULATE 上按耗时判为 `touch_timeout`；从不自动重试触碰 |
| YR-4 | Medium | 采纳 | 验证状态属于**卡**：每个操作在**一个** PC/SC 事务里 SELECT →（需要时）向扩展要应答 → VALIDATE → 指令 → 再 SELECT 清掉验证状态。取消单独的 `unlock` 操作；`SCARD_E_SHARING_VIOLATION` 有专门的错误与文字；设置页不轮询 |
| YR-5 | Medium | 采纳 | §3.10b 新增事故响应：扩展内置的停用开关（随商店更新）、为什么版本黑名单不够、撤销证书的有限效果、公告、`--version` |
| YR-6 | Medium | 采纳 | 注册后检查 BE 标志位、`getTransports()`、`authenticatorAttachment`，任何一项像同步/手机通行密钥就拒绝且什么都不存；加入 G1 与 e2e |
| YR-7 | Low | 采纳 | A17/P4 的上界改为"已经知道 VK"；改密码界面列出已登记的安全密钥并提示"要赶走见过解锁库的人，请轮换密钥" |
| YR-8 | Low | 采纳 | 移除丢失的钥匙时提供"同时轮换密钥"，PIN 可能泄露时默认勾选 |
| YR-9 | Low | 采纳 | 改为"经过 Sixkey 助手的调用方拿不到当前与下一个时间步以外的 TOTP 码" |
| YR-10 | Low | 采纳 | §3.3：周期只从凭据名解析（严格：纯数字、无前导零、1–86400）；请求里没有 `p`/`t`/挑战；测试覆盖每种名字形式 |
| YR-11 | Low | 采纳 | §3.2：唯一的发送函数在 `SCardTransmit` 之前做结构化运行时检查（CLA、无链接、短 APDU、三元组、精确的数据边界）；卡侧应答解析也做模糊测试；YK 4.2.0–4.2.6 的触碰不支持 |
| YR-12 | Low | 采纳 | Linux 改为**动态 glibc 构建**（镜像按摘要固定），依赖发行版的 `libpcsclite`；检查 `DT_NEEDED` 与未定义符号；去掉 musl |
| YR-13 | Low | 采纳 | §2.11 按评审列出的每个位置写出决定（`importBackup` 的 added 模式、计数、残留警告、`verdictOf` 的"重新绑定"、`ui/otp.ts`、`ui/hooks.ts`、`importer.ts:206` 等） |
| YR-14 | Low | 采纳 | 14 天规则明确是**提醒**；在服务层的 PRF 解锁里执行；`lastPasswordAt` 只在有登记时、每天最多写一次；读写预算显式调整 |
| YR-15 | Low | 部分采纳 | 锁定（`sk_lock_epoch` 变化）与页面隐藏时立即断开端口；"每个助手会话以 SELECT 开始"写成不变量。"N 秒无请求后重新 SELECT"不需要了：YR-4 之后每个事务结束时都重新 SELECT |
| YR-16 | Low | 采纳 | Edge 只在"从 Chrome 应用商店安装的 Sixkey"上可用；不加 Edge 商店 ID |
| YR-17 | Low | 采纳 | A11、N2 与 SECURITY 草稿加上"触碰不告诉你是哪个程序要的"，以及与网站 WebAuthn 同时触碰的时机攻击；硬件检查表加并发用例 |
| YR-18 | Low | 采纳 | 每把钥匙显示读卡器名、标出 NFC 读卡器；不只凭 deviceId 提示就优先某张卡；同名在多张卡上时让用户选 |
| YR-19 | Low | 采纳 | §1.1.5、§4.5 写明"副本 + 主密码 + 钥匙"能拿到记住的访问密钥；`sk_oath` 加 AAD `sixkey-oath|1|{vaultId}|{vkId}` |
| YR-20 | Low | 采纳 | 从钥匙添加时若有同名的软件条目，提示"这是你的备份，请保留"；删除这样一对里的软件条目时警告 |
| YR-21 | Info | 采纳 | PRIVACY 草稿写明操作系统可能在安装或首次运行时在线检查签名；§3.5 写明 macOS 会创建沙箱容器目录 |
| YR-22 | Info | 采纳 | A14 收窄：用户级目录在 `Default/` 旁边而不是里面，还需要接收方机器上有可执行文件；可能性降低，仍保留 [推断] |
| YR-23 | Info | 采纳 | 估算上调（A 约 8–10 周）；Y5a 的解析/合并/校验不再等 G2 |
| YR-24 | Info | 采纳 | 引入 `sk_prf` 的那次改动里把 `webauthn-prf` 从 `keyring.ts` 的 `METHODS` 删掉 |
| YR-25 | Low | 部分采纳 | `schemaVersion` 在 `serializeVault` 里计算，`parseVault` 读到的值不被信任；类型放宽为 `1 \| 2`；"v2 但没有钥匙条目"读时接受、写时不产生。与评审的一处分歧已裁定（2026-10-16）：**回收站里的钥匙条目也让库保持 v2**，评审写的"没有存活的钥匙条目就写 v1"不采用。理由（对照代码）：回收站里的钥匙条目仍是带 `kind/ref`、没有 `secret` 的完整内容寄存器，"从回收站恢复"与"编辑胜过删除"的合并都要靠它。若写成 v1：旧客户端的 `parseEntry` 要求 `secret` 是字符串（`validate.ts:44` `str(o.secret, …)`），见到没有 `secret` 的条目就把**整个库**判为 `invalid_vault`，`openVault` 随即回退到更旧的副本——这正是要避免的丢数据路径；新客户端按 §2.2 也拒绝"v1 里有 `kind`"。若为了写 v1 而在删除时去掉 `kind/ref`，条目就无法从回收站恢复，与另一台设备上较新的编辑合并时还会得到半个条目。写成 v2 时，旧客户端得到的是 `newer_schema`：停下、不回退、提示更新、同步 `paused_newer`，安全。所以只有**永久删除**（变成 v1 清除标记）才让库回到 v1。"v2 但一个钥匙条目都没有"仍是读时接受、写时不产生 |
| YR-26 | Low | 采纳 | 去掉 SIGTERM 与控制台事件的说法：Chrome 关掉管道，2 秒后 SIGKILL / `TerminateProcess`。助手用专门的线程读 stdin，EOF 时在 2 秒内清理退出；触碰等待中被杀的残余写明 |
| YR-27 | Low | 采纳 | A12 与 §3.13：用户级位置上**任何**同名文件都会遮蔽助手（包括 A10 用下载放进去的）；给 `host_missing`/`host_forbidden` 加第三个原因；帮助页指向 `NativeMessagingUserLevelHosts=false` |
| YR-28 | Medium | 采纳 | G1 在 Windows 上比较 `residentKey` discouraged 与 required；以验证用的 `get()` 是否返回 `results.first` 为准，不看 `prf.enabled`；Windows 若需要常驻凭据，就在 Windows 上用 required 并写清移除步骤；没有 webauthn.dll API v4 的 Windows 不提供 C |
| YR-29 | Info | 采纳 | D16 的理由改正（弹窗自己的 WebAuthn 对话框不一定会关弹窗）；G1 改为"测量，然后无论结果都用小窗口" |
| YR-30 | Info | 采纳 | RP ID 实际是 origin 字符串 `chrome-extension://<id>`（不设 `rp.id`）；唯一性由浏览器保证、不由认证器保证；对话框大概只显示 "chrome-extension"，小窗口先告诉用户 |
| YR-31 | Low | 采纳 | 注册时 Chrome 要求设新 PIN 之前先显示一行：记住它，8 次错误会锁住钥匙，解锁会删除钥匙上的网站登录 |

另外按评审 §5 的一致性意见改了：显示名改为"YubiKey · 5.7.1"（序列号与型号要管理应用，不在白名单）；`ref.touch` 只对 TOTP 有意义；Chrome for Testing 也是 Chromium 品牌、先读 `SOFTWARE\Chromium`；`NativeMessagingUserLevelHosts` 由评审核实；权限"重新申请不提示"是永久的 `kSoft` 行为而不只是"usually"；启动参数只检查 `argv[1]`；Security Key 系列的 hmac-secret 由 FIDO MDS3 确认（评审）；CDP 的 `hasHmacSecret` 要 Chrome 148+；Playwright 捆绑的是 Chrome for Testing 156（体验调研附录 A）。

---

## 0. 摘要（先看这一段）

1. **A 的形态**：一个除握手外只做四件事的小助手（列出钥匙、列出账户、算当前的 TOTP 码、算单个 TOTP 码；设了应用密码时，每个操作在同一个卡事务里向扩展要一次应答），Rust 写，系统级安装、已签名，**没有网络代码、没有日志、没有持久状态**。浏览器只在 Sixkey 的弹窗或设置页打开时启动它，页面一关它就被 Chrome 杀掉。助手**不实现** `PUT/DELETE/SET CODE/RESET/RENAME`，也不提供任意 APDU。**挑战值由助手按自己的时钟计算**，周期只从凭据名读出，扩展不能指定时间，所以**经过 Sixkey 助手的调用方**拿不到当前与下一个时间步以外的 TOTP 码（直接用 PC/SC 的本机进程不受此限）。**第一版不计算 HOTP**：一个 HOTP 码在用掉之前一直有效，又无法知道它是否需要触碰（D21）。**应用密码的 HMAC 在扩展里算**，助手只转发，访问密钥从不进入助手。父浏览器开着远程调试端口时，助手拒绝服务（D24，启发式）。
2. **A 的数据**：保险库里存的是**引用**（issuer/label、钥匙上的凭据名、见过的钥匙 deviceId 提示、是否需触碰），不是种子。条目新增一种 `kind: "ykoath"`，**不用** `secret === ""`。`schemaVersion` 改为**按内容派生**：只有存在未清除的钥匙条目时才写 2，不用这个功能的人永远是 v1，旧客户端照常同步。引用可以同步、可以进备份；钥匙不能。没有钥匙的设备上显示"需要 YubiKey"。
3. **C 的形态**：每把认证器一份 PRF 包裹，放在**本机记录 `sk_prf`**（不在 keyring 里、不同步、不进备份），每把一个随机 salt；`userVerification: "required"`（WebAuthn 规范本来就要求 PRF 用"已做用户验证"的那个值）；`residentKey: "discouraged"`（不占钥匙上的 25 个常驻凭据位）；**RP ID 用扩展自己的 ID**，不用 `sixkey.app`（实际是 origin 字符串 `chrome-extension://<id>`；这是对 PLAN Phase 3 的变更，§1.2.6）。注册时拒绝同步型或手机上的通行密钥（BE 标志位、传输方式、附着方式）。解锁在**单独的扩展窗口**里进行，不在工具栏弹窗里。主密码永远保留，所有敏感操作仍要主密码；作为**提醒**，PRF 解锁每 14 天至少要求输一次主密码，防止忘记。
4. **M2 要预留的很少**（§5.1）：不改 envelope、KeyBundle、服务器、契约向量；只要求 M2/M3 保住 `newer_schema` 不回退的规则（包括 F6a 回溯）并加测试、只经 `emptyVault`/`parseVault`/`mergeVaults`/`ops.ts` 构造保险库对象、按 `secret` 判断身份的地方走具名函数、保留 `sk_prf`/`sk_oath` 两个键名、安全记录只升一次版本。
5. **顺序**：C 先做（不依赖同步，也不依赖商店 ID）；A 的助手在 Phase 2 有了商店 ID 之后才能发布（`allowed_origins` 要钉死它）。建议把 A 的**数据模型**（只会解析和显示"需要 YubiKey"，没有任何新权限）放进第一个商店版本，这样任何公开客户端都不会因为 v2 而暂停同步。
6. **诚实的残余**：插着钥匙、本机装了助手、这个配置文件**曾经**授权过 `nativeMessaging` 时，能在 Sixkey 页面里执行代码的东西（A10：CDP、驱动浏览器的代理、局域网上连调试端口的机器）**即使 Sixkey 锁着、即使预设已"关闭"A**，也能读到不需要触碰、没设应用密码的钥匙凭据的**当前**码——权限移除是软的，能被无提示地申请回来；D24 的调试端口检查挡住最常见的那条路，但只是启发式。真正的控制是：被共享或被自动化的电脑上**不装助手**、钥匙不常插、重要账户开触碰或设应用密码。扩展**无法核实**启动的是不是真助手；一个被篡改的助手版本就是以用户身份运行的恶意程序，事故响应见 §3.10b。§4.5–§4.6 逐条写明。

### 决策表

| # | 问题 | 决定 | 主要理由 | 放弃的方案 |
|---|---|---|---|---|
| D1 | 扩展怎样够到 OATH | 可选 `nativeMessaging` + 单独安装的助手（所有者已决） | 纯扩展无路（调研 §2） | WebUSB/WebHID/Smart Card API（被封）、localhost 桥（要 host 权限与网络） |
| D2 | 权限何时申请 | 只在设置页标签里、用户点"开启"时 `permissions.request`；关闭时 `permissions.remove` | 弹窗里申请会关掉弹窗；可选权限不会在更新时停用扩展 | 必需权限 |
| D3 | 原生端口放哪 | **页面**（弹窗或设置页）持有端口；**SW 从不调用** `connectNative` | 助手只在用户看着的时候活着；SW 不被端口保活 | SW（Chrome 105 起端口会让 SW 一直活着）、offscreen |
| D4 | 助手能做什么 | 只有 `hello / keys / list / codes / code` 五个操作（外加同一事务内的 `auth` 应答）；APDU 层白名单只含 SELECT(OATH AID)、VALIDATE、LIST、CALCULATE、CALCULATE ALL、SEND REMAINING，在唯一的发送函数里做结构化运行时检查 | `RESET` 无需鉴权，任何能说话的进程一条指令就清空钥匙 | 通用 APDU 透传、写入、管理 |
| D5 | 时间由谁定 | **助手按系统时钟算挑战**，周期只从凭据名解析；扩展只能要"当前"或"下一"个时间步 | 钥匙对任意挑战都应答；扩展能指定时间或周期就能批量取未来的码。只约束经过真助手的调用方（YR-9） | 扩展传时间戳或周期 |
| D6 | 应用密码 | 扩展用 WebCrypto 派生访问密钥并计算 VALIDATE 的 HMAC；助手在**一个**卡事务里 SELECT → 向扩展要应答 → VALIDATE → 指令 → 再 SELECT；"在这台电脑上记住"可选、默认关，存 VK 加密（带 AAD）的本机记录 `sk_oath` | 访问密钥不进入助手；验证状态属于卡，SELECT 与 VALIDATE 必须原子；事务结束后不留下已验证的会话 | 把密码或访问密钥交给助手；存进同步的保险库；跨事务保持验证 |
| D7 | 条目表示 | `kind: "ykoath"` + `ref: {name, keys, touch}`；无 `secret` 字段；`ref.name` 不可编辑 | 不复用"空 secret = 已清除" | 空 secret、哨兵值 |
| D8 | schema 版本 | `schemaVersion` 由 `serializeVault` 按内容计算：有未清除的钥匙条目（**含回收站里的**，YR-25 已裁定）才是 2；钥匙条目被永久删除后变成普通 v1 清除标记 | 不用 A 的人保持 v1 互通；用了也不需要迁移旧数据 | 一律升到 2；在 v1 里加"保留未知字段"的通用机制 |
| D9 | 引用怎样对上钥匙 | 按**凭据名**匹配任何插着的钥匙；`keys`（deviceId 列表）只作提示与显示 | Yubico 官方备份建议就是同一凭据放两把钥匙；钥匙 RESET 后 deviceId 会变 | 以 deviceId 为主键 |
| D10 | 备份与导出 | 加密备份含引用；明文导出不含钥匙条目并说明；子集导出（H2）不能选钥匙条目 | 种子读不出来；deviceId 是硬件标识，会让子集文件可关联 | 导出时报错 |
| D11 | B（写入钥匙） | 不做 | 二选一困境、`PUT` 静默覆盖、种子要经过助手、白名单要放开写指令 | — |
| D12 | PRF 包裹放哪 | 本机记录 `sk_prf`，每把认证器一份，包裹 VK；不进 keyring、不同步、不进备份 | 同步 bundle 规定 keyring 只有 password + recovery；keyring 必须逐字节稳定（A4R-11） | keyring 里的 `webauthn-prf` 包裹（keyring.ts 里那个预留值不用） |
| D13 | VK 变了以后 | 清理入口把旧 VK 的 PRF 包裹删掉、保留凭据 ID，标"需要重新启用"；下次用密码解锁后**一次触碰**重新启用；界面一定提示，不静默 | 没有认证器时无法重新包裹 | 间接密钥（会让一次见过 VK 的人永远能解开以后的 VK） |
| D14 | RP ID（**所有者已决**，Q1，以 G1 通过为前提） | 扩展自己的 origin（不设 `rp.id`；Chrome 把它改写成 `chrome-extension://<id>` 交给认证器） | 浏览器里只有 Sixkey 能用这个 RP ID；不依赖 host 权限与 Chrome 122；不依赖域名永远在我们手里 | `sixkey.app`（任何有 `<all_urls>` 的扩展、该网站或其子域都能用同一个 RP ID） |
| D15 | 用户验证与凭据类型 | `userVerification: "required"`；`residentKey: "discouraged"`（若 G1 证明 Windows 需要，Windows 上用 `required`）；`attestation: "none"`；每把认证器随机 32 字节 salt；以验证用 `get()` 是否返回 PRF 结果为准 | PRF 只定义"做了 UV"的那一个输出；不占常驻凭据位；webauthn.dll 可能对非常驻凭据忽略 hmac-secret（YR-28） | `preferred`（输出会随有无 PIN 变化）；只看 `prf.enabled` |
| D16 | PRF 在哪里调用 | 注册在设置页标签；解锁在 `chrome.windows.create` 打开的小窗口 | 一个稳定、不会因失焦或别的安全对话框而关闭的界面：PIN 输入、最长 60 秒的等待、Chrome 156 起别的安全对话框会强关工具栏弹窗、Windows 的安全密钥界面是系统对话框（弹窗自己的 WebAuthn 对话框不一定关弹窗，YR-29） | 弹窗 |
| D17 | PRF 能替代什么 | 只替代"解锁时输主密码"；导出、改密码、轮换、`pw_auth` 仍要主密码；作为**提醒**，每 14 天至少要一次主密码（在服务层执行，不是安全控制） | `pw_auth` 由密码派生，PRF 给不出来；防止用户忘记密码 | PRF 重设密码 |
| D18 | 助手安装范围（**所有者已决**，Q3） | **只支持系统级安装**（需要管理员） | macOS/Linux 的用户级位置在每个配置文件的用户数据目录里，指纹浏览器看不到；用户级还是被遮蔽的位置 | 用户级安装 |
| D19 | 助手更新 | 不回连。扩展每个版本内置"推荐的助手版本"，旧了就在设置页提示下载；也可用用户自己选的包管理器 | 零追踪 | 助手自动更新、扩展联网查版本 |
| D20 | 共享/自动化预设 | 移除权限（**软移除**：曾授权过的配置文件里，A10 能不经提示申请回来）；该预设下设置页不提供 A，YubiKey 模块不连接（**只防误用**）；显示"在有共享或自动化配置文件的电脑上不要安装助手"与卸载步骤；C 照常可用 | 预设挡不住在 Sixkey 页面里执行代码的东西；真正的控制在本机（不装助手、不插钥匙、触碰/应用密码）与 D24 | 声称预设"关闭"了 A |
| D21 | HOTP（**所有者已决**，Q5） | 第一版**不计算** HOTP：助手对 HOTP 凭据回 `unsupported`；添加流程里 HOTP 凭据显示但不能选；schema 接受 HOTP 钥匙条目 | 一个 HOTP 码在用掉之前一直有效，A10 能攒着用；HOTP 是否需要触碰无从得知（CALCULATE ALL 总是回 `0x77`） | 按条目选择开启（可作为以后的版本） |
| D22 | 有问题的助手版本（**所有者已决**，Q3） | 扩展内置停用开关，随商店更新生效：开启后从不调用 `connectNative`，弹窗与设置页常驻提示与卸载步骤；另有撤销证书、公告、`--version`（§3.10b） | 助手不自动更新；Chrome 一连接就启动它，`hello` 之后再看版本已经太晚 | 版本黑名单、助手自更新 |
| D23 | Linux 构建（**所有者已决**，Q3） | 动态链接 glibc，在按摘要固定的容器里构建；依赖发行版的 `libpcsclite` | 用发行版自己的 PC/SC 客户端库，协议兼容由发行版保证；导入表与符号可检查 | musl 静态构建（加载不了发行版的 libpcsclite） |
| D24 | 调试端口（**所有者已决**：采纳为纵深防御，按文中局限对外说明） | 助手启动时读父浏览器进程的命令行；含 `--remote-debugging-port` 或 `--remote-debugging-pipe` 就回 `debugging_enabled` 并拒绝一切操作。开发/e2e 构建可在构建时关掉，发布构建不可 | 这是 A10 最常见的那条路（厂商本地 API、Playwright/Puppeteer 启动的浏览器），而浏览器的命令行是页面里的代码改不了的 | 只靠预设或扩展侧检查（A10 能绕过） |
| D25 | 同步型、手机上的通行密钥（**所有者已决**，Q2；**2026-10-19 修订**：下列三项检查只用于 `kind: "security-key"` 的登记；平台认证器（Touch ID、Windows Hello）的登记按 `QUICK-UNLOCK.md` §5.3：设备绑定的可用，BE=1 的只有用户在登记时勾选"允许会同步的通行密钥"（默认不勾）才做持久包裹，否则只作会话门禁） | 注册后检查：认证器数据的 BE 位（`0x08`）、`getTransports()` 含 `hybrid`/`internal`、`authenticatorAttachment !== "cross-platform"`，任一成立就拒绝、不保存 | `hints` 只是提示；手机通行密钥随 Google/Apple 账户同步，会让"副本 + 云账户"就能解锁 | 只靠 `hints: ["security-key"]` |

---

## 1. 产品形态

### 1.1 A：YubiKey 来源的账户

#### 1.1.1 开启（只在设置页）

设置 › YubiKey（新面板）。四步，全在一个设置页标签里：

1. **说明**（一屏）："Sixkey 可以显示你 YubiKey 里的验证码。为此需要一个小助手程序，它只和你的 YubiKey 通信，不联网、不记日志。账户的密钥一直留在钥匙里，Sixkey 只保存名字。" 下面一行小字："如果这个浏览器配置文件会被别人用、被厂商同步，或由脚本控制，不要开启。"
2. **开启** 按钮 → 点击处理函数里 `chrome.permissions.request({permissions: ["nativeMessaging"]})`。Chrome 显示 "Communicate with cooperating native applications"（权限警告文字，MCP 调研 B3 [复核]）。拒绝 → 停在第 1 步，不再追问。
3. **安装助手**：按 `navigator.userAgentData.platform`（不需要权限）显示对应平台的下载说明和一个普通链接（用户点击后在新标签打开，扩展自己不发请求）。"我已安装 → 测试连接"。
4. **测试连接** → `connectNative` + `hello` → 显示助手版本与安装范围；失败按 §3.13 的错误表给出下一步。成功后进入"从 YubiKey 添加账户"。

共享/自动化预设下，这一面板只显示说明，不提供开启（§5.4）。文字必须说实话，不写"已关闭、安全了"：

> 当前安全模式是"共享 / 自动化"，Sixkey 不会读取 YubiKey 验证码。但这挡不住控制这个浏览器的程序：如果这个配置文件以前开启过 YubiKey 验证码，它能不经提示重新开启。在会被他人使用、被厂商同步或被脚本控制的电脑上，**不要安装 YubiKey 助手**（卸载步骤 ›），不用时把钥匙拔下，重要账户在 Yubico Authenticator 里开启"需要触碰"或设置密码。

第 2 步之前，如果助手发现浏览器开着远程调试端口（D24），第 4 步的测试连接会直接报"这个浏览器开启了远程调试（常见于指纹浏览器的自动化接口和测试工具），YubiKey 验证码在这里不可用"。

#### 1.1.2 从 YubiKey 添加（弹窗的"添加"菜单或设置页）

没有任何浏览器对话框（触碰是物理动作），所以弹窗里也能做。

1. 列出插着的钥匙（多把就分组；每把显示读卡器名，经 NFC 读卡器读到的标"NFC"，YR-18），每把下面是钥匙里的凭据：名字、算法、周期、"需要触碰"（从 `codes` 结果得知，§3.3）。已经在 Sixkey 里的标"已添加"，同名但来自另一把钥匙的标"已添加（另一把钥匙）"。**HOTP 凭据显示但不能选**："这个版本不支持 HOTP"（D21）。
2. 钥匙有应用密码：先显示密码框（§1.1.5）。
2b. **与软件条目同名**（issuer/label 与一个存活的软件条目相同，YR-20）：该行写"你在 Sixkey 里也有这个账户（带密钥）。请保留它：它是这个账户的备份。"添加后两条都在；以后删除这样一对里的**软件条目**时，确认框加一句"这是你在 Sixkey 里唯一带密钥的副本。钥匙丢了，就只能用网站的恢复码。"
3. 用户勾选（默认全选未添加的）→ **一次性提示**（每个保险库第一次添加时必须勾选确认，以后不再弹）：

   > **这些账户的密钥只在 YubiKey 里。** Sixkey 只保存名字，备份里也只有名字。钥匙丢失、损坏或被重置后，Sixkey 无法帮你找回这些账户，只能用各网站的恢复码，或你当初同时设置的第二把钥匙。☐ 我明白
4. 写入保险库：每个凭据一条 `kind: "ykoath"` 条目（§2.1），`issuer/label` 由凭据名解析（`period/issuer:name`），`keys` = [这把钥匙的 deviceId]。追加到列表末尾。
5. 同名凭据已作为引用存在、但这把钥匙的 deviceId 不在提示里：问"这把钥匙上也有这个账户。记下这把钥匙？"→ 只更新 `ref.keys`（§2.7）。

**不自动添加**：插入一把有未添加凭据的钥匙时，列表底部只出现一行"这把 YubiKey 上还有 3 个账户 · 添加"，可以"不再提示这把钥匙"（本机设置，按 deviceId）。保险库写入一律由用户发起，助手返回的数据**永远不直接触发保险库写入**（防止被篡改的助手制造写入，§4.5）。

#### 1.1.3 列表里的样子

钥匙条目与软件条目**混排**，按同一个 `order` 排序，可以拖动、放进分组。行的左侧多一个小钥匙图标。右侧码区的状态：

| 状态 | 显示 | 点击 |
|---|---|---|
| 功能未开启（本机没授权，或预设不允许） | 灰色"YubiKey" | 弹出说明："这个账户的密钥在 YubiKey 里。在 设置 › YubiKey 开启后可在这里看到验证码。" |
| 助手未安装 / 无法启动 | 灰色"YubiKey"；列表顶部一行状态（只一行，不弹窗） | 同上，链接到设置页的安装步骤 |
| 钥匙未插入 | 灰色"插入 YubiKey"（若 `keys` 有提示，显示钥匙短标识，如 `·· a1b2`） | 无 |
| 钥匙已锁（应用密码） | 顶部一行"YubiKey 已锁定"+ 密码框 | — |
| 读取中 | `••• •••` 占位 | — |
| 有码（不需触碰的 TOTP） | 与软件条目相同：码、倒计时环 | 复制（与软件条目同一套剪贴板清空） |
| 需触碰 | "点一下 · 触碰" | 发 `code` → 显示"请触碰你的 YubiKey"与等待动画 → 出码后自动复制（失败则显示码与"复制"按钮，见下）；超时（`touch_timeout`）显示"没有检测到触碰"和"再试一次"按钮。**从不自动重试**（YR-3）：钥匙每闪一次灯，都必须对应用户刚刚的一次点击 |
| HOTP（只会来自以后的版本或别的设备） | 灰色"HOTP" | 说明："这个版本不能生成 YubiKey 上的 HOTP 码，请用 Yubico Authenticator。"（D21） |
| 浏览器开着远程调试 | 灰色"YubiKey"；顶部一行 | 说明 D24 的原因 |
| 出错 | "无法读取" | 显示错误原因（§3.3 错误表） |

细节：

- **出码后复制**：触碰要等几秒，复制发生在异步等待之后。Chrome 的 `navigator.clipboard.writeText` 是否要求瞬时用户激活，我没有核实 [未核实]。设计：先尝试写；失败就让码停在屏幕上，焦点移到"复制"按钮，按回车即复制。
- **钥匙拔出**：已经算出的码保留到它的周期结束，然后变"插入 YubiKey"。条目永远不会因为钥匙不在而被隐藏或删除。
- **多把钥匙**：顶部状态行列出插着的钥匙（"YubiKey · 5.7.1 · 读卡器名"：OATH 的 SELECT 只给出应用版本，型号与序列号要管理应用，不在白名单，§3.2）。一条引用的名字只在一张卡上 → 用它，行上写读卡器名。**在多张卡上** → 行上出现一个小切换（"2 把钥匙"），默认 USB 读卡器上的那张，用户可以切换；**不凭 deviceId 提示悄悄优先**某张卡，因为任何能应答 OATH AID 的卡（例如 NFC 读卡器上的可编程卡）都能自称任何盐（YR-18）。
- **搜索**：钥匙条目有同样的 `issuer/label`，搜索不变。
- **隐藏验证码**（`hideCodes`）：钥匙条目同样隐藏，点击即复制；需触碰的条目点击后先触碰再复制。
- **此网站**（`domains`）：钥匙条目同样可以"记住此网站"，写的是条目的 `domains`，不碰钥匙。"此网站"里的钥匙条目在钥匙未插入时也显示（"插入 YubiKey"），因为用户最需要知道"这个网站的码在钥匙上"。
- **分组与排序**：放置寄存器（`group/order`）与软件条目完全相同。
- **重命名**：只改 Sixkey 里的 `issuer/label`（显示用），钥匙上的凭据名不变。编辑框里显示"钥匙上的名字：…"只读。
- **删除**：确认框写"只从 Sixkey 中移除。它仍在你的 YubiKey 上。" 回收站、永久删除与软件条目相同（§2.3）。Sixkey 从不删除钥匙上的任何东西。
- **复制下一个码**：现有"剩余 <3 秒时复制下一周期"的规则对钥匙条目也成立：扩展请求 `step: 1`（§3.3），助手只允许当前与下一个时间步。

#### 1.1.4 同步

- 引用随保险库同步（§2，§5.1）：在另一台设备上同样出现，同样可以搜索、排序、记住网站。
- 那台设备没有钥匙、没有助手或没开启 A → 显示上表前三行之一。**这不是错误，也不是空白**。
- 钥匙不随任何东西移动。钥匙里的计数器（HOTP）也不同步——它本来就在钥匙里。

#### 1.1.5 应用密码

- 钥匙设了 OATH 应用密码时，`keys` 返回 `locked: true`、盐与算法（§3.3）。之后每个操作在助手的同一个卡事务里先 SELECT，钥匙给出新挑战，助手发 `auth` 事件，扩展在 2 秒内回答（§3.3）。扩展手里没有访问密钥时就回"没有"，助手回 `locked`；弹窗顶部状态行出现密码框："这把 YubiKey 设了密码"，下面 ☐"在这台电脑上记住（加密保存，只在 Sixkey 解锁时可用）"，默认不勾。页面在生命期内保留访问密钥，之后的操作静默完成验证。
- 扩展做：`访问密钥 = PBKDF2-HMAC-SHA1(密码的 UTF-8, 盐 = SELECT 返回的 ID, 1000 次, 16 字节)`；`应答 = HMAC-SHA1(访问密钥, 钥匙的挑战)`；再生成 8 字节随机挑战，要求钥匙回 `HMAC-SHA1(访问密钥, 我们的挑战)`，扩展用常数时间比较核对（YKOATH 规范 SET CODE/VALIDATE 两节 [转录]；yubikit `_derive_key`、`validate` 用的正是这些参数 [复核]）。SELECT 的算法标签 `0x7B` 若不是 SHA1，按标签选 HMAC 算法。助手只把 `{应答, 我们的挑战}` 装进 VALIDATE 发给钥匙，把钥匙的应答原样返回。
- **密码不做 NFKC 规范化**（与 Sixkey 主密码不同）：yubikit 直接 `passphrase.encode()`，规范化会让 Yubico Authenticator 设的密码在 Sixkey 里对不上。
- 密码明文派生后立即丢弃。访问密钥只在打开着的页面内存里（不进 `storage.session`）。勾了"记住"→ 写入 `sk_oath`（§2.10），用 VK 加密；锁定时用不了，所以**Sixkey 锁着时，设了密码的钥匙凭据对 A10 仍是锁着的**。
- **"记住"存的是完整的密码等价物**（YR-19）：访问密钥就是 VALIDATE 需要的全部，验证之后的会话能 PUT、DELETE、SET CODE（Sixkey 的助手不发这些，但别的程序会）。能读到它的：解锁期间的 A10；**配置文件副本 + 主密码**（A3）——再加上实体钥匙，就能读取并改写设了密码的那些账户。所以默认不勾，勾选框旁写"拿到这个浏览器配置文件和你的主密码的人，也就拿到了这把钥匙的密码"。
- 错误密码：只有当 VALIDATE 紧跟在**同一事务里助手自己的** SELECT 之后、并回 `6A80` 时，才显示"密码不对"（§3.3），不会因为别的程序在中间选了应用而误报。OATH 应用没有错误次数锁定（规范与 NEO 源码里都没有 [推断]），但 PBKDF2 只有 1000 次，所以界面建议用长密码。
- Sixkey **不提供**设置、修改、取消应用密码（那是 `SET CODE`，不在白名单里，§3.2），指向 Yubico Authenticator。

#### 1.1.6 什么时候和钥匙说话

- 只在弹窗打开、或设置页的 YubiKey 面板/添加流程打开时；页面关了端口就没了，Chrome 杀掉助手进程（`~NativeMessageProcessHost` 调用 `EnsureProcessTerminated`，源码 main [复核]）。
- 弹窗（或 PRF 小窗口）：保险库解密后若有钥匙条目、已授权、且当前预设不是"共享/自动化" → 懒加载 YubiKey 模块（不进弹窗首屏预算）→ `hello` → `keys` → `codes`（需要时在事务内完成验证）。之后在每个 30 秒边界再要一次 `codes`；周期不是 30 秒的凭据由助手各自计算（§3.3）。**不需要触碰的 TOTP 自动刷新；需要触碰的只在用户点击时计算；HOTP 不计算**。
- **只有弹窗与小窗口自动刷新**。设置页的 YubiKey 面板只在用户操作时 `keys`/`list`（添加流程），从不轮询，这样两个页面同时打开时也不会互相打断（YR-4）。
- **锁定与隐藏时立即断开**（YR-15）：YubiKey 模块订阅 `chrome.storage.session.onChanged` 里 `sk_lock_epoch` 的变化（`options/Backup.tsx:71–75` 已有同样的写法）与 `visibilitychange`，任何一个发生就断开端口、清掉内存里的访问密钥与码；不等到"下一次使用时"才发现锁定。
- 首屏：软件条目的 <100 ms 路径不受影响；钥匙条目先画占位，码稍后出现。助手启动加 PC/SC 往返的额外时间预计 100–300 ms [估计]，由 §7.3 的探针实测。
- 后台什么也不做：SW 不碰助手，没有轮询，没有闹钟。

### 1.2 C：用 YubiKey 解锁

#### 1.2.1 包裹的是什么

PRF 输出派生出一个 KEK，包裹**当前 VK**。每把认证器一份包裹，互相独立；任意一把都能解开。主密码包裹与恢复密钥包裹照旧在 keyring 里，一点不变。

```ts
// chrome.storage.local 键 sk_prf（本机，明文元数据 + 密文包裹；锁定时必须可读）
type PrfRecord = {
  v: 1;
  vaultId: string;
  creds: PrfCred[];          // ≤ 10
  lastPasswordAt?: number;   // 最近一次用主密码解锁或验证的时间（14 天提醒，D17）；只在有登记时写，每天最多一次
};
type PrfCred = {
  id: string;                // credential ID，base64url，≤ 1023 字节解码后
  name: string;              // 用户起的名字，≤ 40 码点，默认"安全密钥 1"
  transports?: string[];     // getTransports() 的结果，只用于 allowCredentials 提示
  salt: string;              // 32 随机字节，base64；每把认证器一个
  createdAt: number;
  wrap: { vkId: string; iv: string; wrapped: string } | null;  // null = 需要重新启用（D13）
};
```

- `KEK = HKDF-SHA256(ikm = PRF 输出 32 字节, salt = ∅, info = "sixkey/v1/kek-prf")`，AES-256-GCM，不可导出。
- `wrapped = AES-GCM(KEK, iv, VK 原始 32 字节, AAD = "sixkey-prf|1|{vaultId}|{vkId}|{credId}")`。AAD 绑住保险库、VK 与凭据，换任何一项都解不开。
- 新 HKDF 标签 `sixkey/v1/kek-prf` 加入标签两两不同的测试。

**为什么不放进 keyring**（keyring.ts 里已经预留了 `WrapMethod "webauthn-prf"` 与 `credentialId` 字段，本设计**不用**它们）：

1. 同步时 KeyBundle 规定 keyring 的 `wraps` 恰好是 `{password, recovery}`（SYNC-DESIGN §2.3）；本地 keyring 在采用时就是 `bundle.keyring` 本身，而且必须逐字节稳定（§0.0i 第 12 条，A4R-11）。PRF 包裹放进去，要么被同步上去（变成每台设备都要知道的东西），要么在每次采用时被冲掉、又让"本地 keyring 与 bundle 相同"的判断失效。
2. keyring 的每次变化都写换密钥标记、触发一次完整清理（A2）；注册或移除一把钥匙不应该触发这些。
3. `find(keyring, method)` 只取第一个同类包裹，多把认证器要另写查找；不如放在独立记录里。

那个预留的 `webauthn-prf` 值**在引入 `sk_prf` 的同一次改动里从 `keyring.ts` 的 `METHODS` 删掉**（YR-24）：今天 `validateKeyring` 会接受一个没有 `kdf` 的 `webauthn-prf` 包裹，而这样一个垃圾包裹会被 `removeMethod` 当作"还有一种解锁方式"。没有任何 keyring 写过它，删掉是安全的。同步代码已经拒绝含它的 bundle（`keybundle.ts:56`："wraps must be exactly password and recovery"，§5.1 R4）。

#### 1.2.2 注册（设置 › 安全 › 用安全密钥解锁）

前提：已解锁，并且库有主密码（H1 之后的新库都有；旧的设备密钥库要先设主密码——设备密钥库本来就不用密码能开，加 PRF 没有意义）。

1. 点"添加安全密钥" → 先**重新输入主密码**（与 H3 的导出前验证同一个调用）。添加一种进门方式是敏感操作。
2. `navigator.credentials.create`，在设置页标签里调用：
   - `rp: {name: "Sixkey"}`，**不设 `rp.id`**（D14：Chrome 把它改写成扩展的 origin 字符串）；
   - `user: {id: 16 随机字节, name: "Sixkey", displayName: "Sixkey"}`（不放邮箱或任何个人信息）；
   - `pubKeyCredParams: [{type: "public-key", alg: -7}, {type: "public-key", alg: -257}]`；
   - `authenticatorSelection: {residentKey: "discouraged", requireResidentKey: false, userVerification: "required", authenticatorAttachment: "cross-platform"}`，`hints: ["security-key"]`。**Windows 例外**：若 G1 证明 webauthn.dll 对非常驻凭据忽略 hmac-secret（libfido2 `winhello.c` 的注释是这样说的 [复核]，YR-28），Windows 上改用 `residentKey: "required"`，占钥匙上的一个常驻凭据位，移除时要多一步（§1.2.4）；
   - `excludeCredentials`：本机已登记的凭据（防止同一把钥匙登记两次）；
   - `attestation: "none"`；`extensions: {prf: {}}`；`timeout: 120000`。
   - 钥匙还没有 FIDO2 PIN 时，Chrome 会引导用户设置一个 [推断，原型确认]。**在调用 `create` 之前**，界面先说一句（YR-31）："如果浏览器要你给这把安全密钥设一个 PIN，请记住它：连续输错 8 次会锁住钥匙，解锁的唯一办法是重置，那会删除钥匙上所有网站的登录凭据（Sixkey 不受影响，主密码照常可用）。"
3. **拒绝同步型与手机上的通行密钥**（D25，YR-6；2026-10-19 起只适用于安全密钥的登记，平台认证器见 `QUICK-UNLOCK.md` §5.3）：`create` 返回后，下面任何一项成立就拒绝，什么也不保存，并说明"请用插在电脑上的安全密钥（例如 YubiKey）；手机或同步的通行密钥不支持"：
   - `response.getAuthenticatorData()` 的标志字节里 BE（backup eligible，`0x08`）为 1；
   - `response.getTransports()` 含 `"hybrid"` 或 `"internal"`；
   - `credential.authenticatorAttachment !== "cross-platform"`。
   `getTransports()` 为空时不据此拒绝（有的安全密钥不报告）。
4. **验证一次，并以它为准**（YR-28）：立即 `navigator.credentials.get({allowCredentials: [新 ID], userVerification: "required", extensions: {prf: {eval: {first: salt}}}})`。**只有它返回了 `results.first` 才算支持**；不看 `create` 的 `prf.enabled`（Windows 上它可能是假的否定）。没有结果 → "这把钥匙（或这台电脑的 Windows）不支持"，什么也不保存（Windows 上用了常驻凭据时，提示用户去 Windows 设置 › 通行密钥 删掉刚建的那个）。不管固件是否支持创建时就返回结果（5.8 的 hmac-secret-mc），都走这一步：逻辑统一，也证明了存下的包裹真能解开。所以注册总是**两次触碰**（加一次 PIN）。Windows 的 webauthn.dll 低于 API v4 时 get() 传不了 salt（Chrome 会标为未求值，评审引 `webauthn_api.cc` [转录]），C 在那台电脑上就不提供。
5. 在 `webLock("sixkey-vault")` 里：确认活动 VK 仍是刚才那个，写入 `sk_prf` 的新条目。记安全记录 `prf_enrolled`（§5.1 R8）。
6. 列表显示：名字、添加时间、"移除"。

#### 1.2.3 解锁

- 锁屏（弹窗）上，若 `sk_prf` 里有可用条目、且距 `lastPasswordAt` 不足 14 天：主按钮"用安全密钥解锁"，下面是密码框。超过 14 天：只有密码框，并说明"Sixkey 每 14 天要你输一次主密码，免得忘记"。
- **14 天规则是提醒，不是安全控制**（YR-14）：任何能写 `chrome.storage.local` 的东西（A10、副本持有者）或能把时钟往回拨的人都能延长它。它在**服务层的 PRF 解锁**里执行（不只靠锁屏显示哪个按钮），这样直接打开 `?mode=window` 也绕不过：`lastPasswordAt` 早于 14 天、或比现在晚 1 天以上 → 拒绝 PRF 解锁，要求主密码。预算：锁屏本来就要读 `sk_prf` 才知道显示哪个按钮（读的是锁屏的打开预算，`read-budget.test.ts` 里显式加一次读）；它把读到的"有没有登记、`lastPasswordAt` 是哪天"交给密码解锁调用，所以**没有登记时密码解锁不多读也不多写**；有登记、且 `lastPasswordAt` 不是今天时，多写一次 `sk_prf`。`read-budget.test.ts` 的解锁预算与 `service.ts` `unlockWith` 的"密码解锁不多读多写"不变量要显式改成"有安全密钥登记时，每天最多多一次写"，并在注释里写明原因。
- 点按钮 → `chrome.windows.create({url: "popup/index.html?mode=window", type: "popup", width: 360, height: 600})`（`chrome.windows` 不需要权限，评审核实 `_api_features.json` [转录]）。工具栏弹窗随之关闭（这是我们想要的）。
- 小窗口先说一句（YR-30）："接下来浏览器会请你使用安全密钥。对话框里请求方可能只写着 'chrome-extension'，那就是 Sixkey。" 然后 `navigator.credentials.get({allowCredentials: 全部可用条目, userVerification: "required", extensions: {prf: {evalByCredential: {[id]: {first: salt}}}}, timeout: 60000})`。
- 按 `rawId` 找到条目 → 若 `record.vaultId !== 本地 keyring.vaultId`，或 `wrap` 为空，或 `wrap.vkId !== 本地 keyring.vkId` → **不尝试解密**，按"需要重新启用"处理（§1.2.5），不记 `prf_failed` → 否则派生 KEK、解包、核对 VK id → 与密码解锁走**同一个** `startSession(vk)`（记下当时的 `lockEpoch`）。
- **标准模式**：VK 进 `storage.session`；小窗口直接显示列表（它就是弹窗页面），用户也可以关掉它再点工具栏图标。
- **每次都锁定模式**：VK 只在这个小窗口的内存里；小窗口就是本次会话的界面，关掉即锁定；与设置页一样受 15 分钟闲置上限约束。
- 用户取消或超时（`NotAllowedError`）：什么都不记，回到密码框。解包失败（不应发生：意味着记录被改或损坏）：显示"安全密钥解锁失败，请用主密码"，记 `prf_failed`；**不**计入 `unlock_failed`（那是"主密码错误"的计数）。
- PRF 解锁**不改变**自动锁定时间，也不改变锁屏即锁（体验调研 §2.6 的阶梯原则）。

#### 1.2.4 回退、多把、移除、丢失

- **回退**：主密码永远可用；忘记主密码 → 恢复密钥重设（现有的 `prepareReset/commitReset`）。PRF 从不参与重设。
- **多把**：最多 10 把；每把单独登记、单独移除。Yubico 也建议登记不止一把（PRF 开发指南 [转录]）。
- **移除**：重新输入主密码 → 删除该条目 → 记 `prf_removed`。非常驻凭据在钥匙上没有可删的东西；Windows 上若用了常驻凭据（§1.2.2），提示用户在 Windows 设置 › 通行密钥（或 `ykman fido credentials delete`）里删掉它；若将来支持平台认证器，同样提示去对应的密码管理器里删除。
- **钥匙丢了**：在每个登记过它的 Sixkey 安装里移除它（登记按安装区分，列表只显示本机的）。因为要求 UV，拾到钥匙的人还需要 FIDO2 PIN（连续 8 次错误锁定 FIDO2 应用，YubiKey 技术手册 [转录]）。**但移除并不从磁盘上抹掉它**（YR-8）：LevelDB 在压缩之前会留着被覆盖的旧值（docs/security/local-vault.md "Limits"），几天后拿到的配置文件副本里可能还有旧的 `sk_prf` 字节；没有轮换 VK，那份副本 + 钥匙 + PIN 就能得到**当前** VK。所以"移除"丢失的钥匙时提供 ☐"同时轮换密钥"，用户选"PIN 可能被别人看到过"时默认勾选；文字与 docs/security/local-vault.md 的残留一段一致。
- **改主密码不会移除已登记的安全密钥**（YR-7）：改密码界面列出已登记的安全密钥，并写"改密码不会移除它们。如果你担心有人在 Sixkey 解锁时动过这台电脑，请'轮换密钥'：它同时让所有安全密钥解锁失效（之后各触碰一次即可恢复）。"
- **全部钥匙都丢了** → 用主密码；不影响任何数据。

#### 1.2.5 VK 变化（轮换、开启主密码、采用远端新 VK）

- `sk_prf` 是 `ServiceDeps.vkRecords` 里的一个 `VkRecord`。它的 `reencrypt(current, held)`：在 `webLock("sixkey-vault")` 的一个临界区内，读记录与活动 keyring、确认活动 VK 仍是 `current`、把 `wrap.vkId !== current.id` 的条目置 `wrap: null`（保留 `id/name/transports`，换新 salt 的工作留给重新启用）；活动 keyring 的 vaultId 与记录不同（`startOver`、恢复到新库之后）时，同时把记录的 `vaultId` 改成当前的、全部包裹置空；返回 `"rewritten"`；没有条目时 `"absent"`；都已是当前的 `"current"`。这符合现有契约（`service.ts` 第 74–97 行的 A4R-4 注释："The record decides what that means"），**M2 不用改接口**。
- 之后第一次用主密码解锁时，弹窗与设置页出现横幅："密钥已更换，安全密钥解锁暂停了。触碰一次即可恢复。"→ 设置页里 `get()`（已有凭据 + **新 salt**）→ 重新包裹。**一次触碰，不重新注册。**
- 为什么不用"间接密钥"（PRF 包一把长期的设备密钥 DK，DK 再包 VK，VK 变化时用 VK 重包）：那样任何一次见过 VK 的人（解锁期间的 A10、被吊销前的设备）就拿到了 DK，以后再拿到一份配置文件副本，就能不用密码、不用钥匙解开**新的** VK，"轮换密钥"就失效了。宁可多一次触碰。
- 同步（Phase 1）里另一台设备轮换了 VK：本机用 PRF 解开的是本地旧 VK，能打开本地旧数据；同步引擎发现密钥变了 → `needs_password`（采用新 keyring 需要密码，SYNC-DESIGN §3.9）。用户输密码 → 采用 → 清理把 PRF 包裹置空 → 横幅 → 一次触碰。与现在"输密码"的路径一致，没有新状态。

#### 1.2.6 RP ID：用扩展自己的 origin，不用 `sixkey.app`

**实际是什么**（YR-30）：扩展页面不设 `rp.id` 时，Blink 填入扩展 ID，Chrome 的 `MaybeGetRelyingPartyIdOverride` 再把它改写成 `caller_origin.Serialize()`，即 `chrome-extension://<id>`，注释说"we use the whole origin to avoid collisions with the RP ID space for HTTPS origins"（`chrome_web_authentication_delegate.cc`，源码 main [复核]）。认证器哈希的就是这个字符串；把完整字符串作为 `rp.id` 传入反而会被拒绝（评审 [转录]）。所以：**永远不设 `rp.id`**。

| | 扩展 origin（默认） | `sixkey.app` |
|---|---|---|
| 浏览器里谁能对这个 RP ID 发起断言 | **只有 Sixkey**。Chrome 团队原文："Extensions will not be allowed to claim an RP ID that is unique to another extension, even if they have host permissions over them"（2023-12-13，W1 [转录]）；代码里同一条规则（同上文件 [复核]） | `https://sixkey.app` 及其任何子域（子域接管、XSS），以及任何有 `sixkey.app` 或 `<all_urls>` host 权限的扩展（W1：host 权限覆盖的 origin 可以向上声明到 eTLD+1） |
| 浏览器之外 | 唯一性由**浏览器**保证，不由认证器保证：一个本机程序拿着钥匙、PIN、一次触碰、`sk_prf` 里的凭据 ID 与 salt，可以用 libfido2 或 `WebAuthNAuthenticatorGetAssertion` 以同一个 RP 字符串得到同一个 PRF 输出（评审 [转录]）。这就是 A16 的"副本 + 钥匙 + PIN"，没有更多 | 同左 |
| 依赖 | 无。Chrome 81 起扩展页面就能用 WebAuthn（评审引提交 5f3963f128 [转录]），覆盖最低版本 120 | Phase 1 的 host 权限（用户可以在扩展设置里收回站点访问权限）；Chrome 122+；域名永远续费且不被劫持 |
| 换 ID 的后果 | 从 zip/解压目录安装的副本 ID 不同（d6），登记的钥匙在那里不能用 → 回退到密码。没有数据风险 | 跨 ID 可用 |
| 显示 | Chrome 的对话框用 `RpIdToElidedHost(GURL("https://" + rp_id))` 生成名字，大概只显示 "chrome-extension" [推断，评审]；Windows 系统对话框显示什么 [未核实]。小窗口先告诉用户（§1.2.3） | "sixkey.app" |

结论：**用扩展 origin**。理由：浏览器里的唯一性是浏览器保证的，不再只靠 salt 保密；PRF 包裹本来就是每个安装各一份（不同步），共享 RP ID 带来的"跨安装可用"没有用处；还去掉了对 Phase 1 host 权限与 122 的依赖，所以 C 可以早于同步上线。**这改变了 PLAN Phase 3 的"RP ID `sixkey.app`"**，列为所有者问题 Q1。原型（§7.3 Y1）必须确认：Windows 上 Chrome 经 `webauthn.dll` 用这个非域名的 RP 字符串加 PRF 能工作（并比较常驻与非常驻凭据，YR-28）；Chromium 120（最低版本）上能工作。任一不成立 → 退回 `sixkey.app` 方案，并把 salt 保密与 `allowCredentials` 写成硬要求。

#### 1.2.7 用户验证（UV）

- **必须 `required`**。CTAP 2.1 的 hmac-secret 为每个凭据保存 CredRandomWithUV 与 CredRandomWithoutUV 两个值，所以"做了 UV"与"没做 UV"给出不同输出；hmac-secret 还**必须**有用户在场（`up=false` → `CTAP2_ERR_UNSUPPORTED_OPTION`）；Bio 的指纹与它的 PIN 后备给出同一个输出（评审读了 CTAP 2.1 勘误版 [转录]）。WebAuthn 规范原文："that PRF MUST be the one used for when user verification is performed. This overrides the UserVerificationRequirement if necessary."（评审 [转录]）。所以 `preferred` 只会带来"有时要 PIN、有时不要"的混乱；`required` 把它说清楚。
- 好处：钥匙 + PIN（或 Bio 的指纹）= 持有 + 知道，比单独的主密码不弱；单拿到钥匙的人解不开。
- 代价：钥匙要有 FIDO2 PIN；YubiKey 出厂没有 PIN（技术手册："By default, no PIN is set." [转录]），首次注册时 Chrome 会要求设置。

#### 1.2.8 平台、版本与固件

| 项目 | 情况 | 标记 |
|---|---|---|
| Chrome 的 PRF | 116 起（体验调研 U1） | [转录] |
| 扩展最低版本 | 120（`minimum_chrome_version`），不必抬高 | [复核 manifest] |
| Windows + YubiKey | Yubico：Windows 11 上漫游认证器支持，Windows Hello 不支持 hmac-secret（指南"as of mid-2025"）。Chrome 在 Windows 上经 `webauthn.dll` 访问安全密钥：get() 传 salt 要 API v4（`pHmacSecretSaltValues`）；webauthn.dll 可能只对常驻凭据启用 hmac-secret（libfido2 注释 [复核]，YR-28）；创建时就出 PRF 结果要 Chrome 147 + API v8。Windows 10 是否有 v4 | [转录]；libfido2 [复核]；Win10 [未核实]，G1 |
| macOS + YubiKey | Chrome 支持，Safari 不支持（同上） | [转录] |
| Linux + YubiKey | Yubico 指南没写。Chrome 在 Linux 上直接走 CTAP（hidraw），理应支持 hmac-secret；systemd 的 `60-fido-id.rules` 与 `70-uaccess.rules` 给座席用户访问权限，精简系统要自己加规则（评审 [转录]） | [推断]，原型必测 |
| 平台认证器 | iCloud 钥匙串 Chrome 132+；Windows Hello 要 2026-02 系统更新 + Chrome 147+；GPM 通行密钥支持但随 Google 账户同步；Chrome 本地配置文件里的通行密钥不支持（体验调研 U2–U4） | [转录]；**v1 不做**（Q2）。2026-10-19 修订：平台认证器改由 `QUICK-UNLOCK.md` 承接（Windows Hello 可用；会同步的通行密钥跨重启解锁只作用户自选、默认关闭） |
| YubiKey 5 系列 | `hmac-secret` 固件 5.2.x–5.8.x；`hmac-secret-mc`（创建时就出结果）只有 5.8.x（技术手册 FIDO 一节） | [转录] |
| YubiKey Bio | Yubico 指南列为支持（指纹作 UV） | [转录] |
| Security Key 系列（蓝色）、Bio FIDO 版 | FIDO MDS3 里列有 hmac-secret；MDS 对一些 5.2 之前的 AAGUID 也列了它，所以仍按运行时结果判断（评审 [转录]） | [转录]，特性检测 |
| YubiKey 4 / NEO | 没有 FIDO2，不能用于 C（但有 OATH，能用于 A） | [推断] |
| 常驻凭据容量 | 5 系列 25 个（技术手册）；本设计用非常驻凭据，不占 | [转录] |
| 指纹浏览器内核 | 都 ≥ 120 才能装 Sixkey；它们对 WebAuthn 界面的改动未知 | [未核实] |

#### 1.2.9 与 H1、每次都锁定、会话的关系

- **H1（首个账户前必须设主密码）**：不变。PRF 是附加方式，不能是唯一方式；`keyring.removeMethod` 的"不能移除最后一种"规则照旧只看 keyring，PRF 根本不在里面，所以不可能出现"只剩 PRF"。
- **每次都锁定**：见 §1.2.3（小窗口就是会话界面）。
- **`lockEpoch`**：PRF 解锁与密码解锁共用 `startSession`，记录当时的 epoch；锁屏、闲置、手动锁定照样 bump epoch，持有 VK 的页面（包括小窗口）在下一次使用时失效。
- **A 的会话**：YubiKey 模块订阅 `sk_lock_epoch` 的变化与 `visibilitychange`，锁定或隐藏时**立即**关闭原生端口、清掉内存里的访问密钥和码（§1.1.6，YR-15），不等"下一次使用时"。

---

## 2. 数据模型

### 2.1 条目：在现有模型上加一种

现有 `Entry`（`core/vault/model.ts`）的 `secret: string` 必填、`secret === ""` 表示已清除，`isAlive()` 对它返回 false。钥匙条目**不能**有空 `secret`。改成判别联合：

```ts
type EntryBase = {
  id: string; createdAt: number;
  // content 寄存器 (hlc)
  type: OtpType; issuer: string; label: string; algorithm: Algorithm; digits: Digits; period: number;
  domains?: string[]; hlc: Hlc;
  // placement 寄存器 (phlc)
  group?: string; order: string; phlc: Hlc;
  // deletion 寄存器 (dhlc)
  deleted?: boolean; dhlc?: Hlc;
  counter?: number;           // 独立的"取最大值"寄存器，任何种类上都可能出现（见 §2.3）
};
export type SoftEntry = EntryBase & { kind?: undefined; secret: string };      // 现有条目，序列化形式不变
export type KeyEntry  = EntryBase & { kind: "ykoath"; ref: OathRef };          // 没有 secret 字段
export type OathRef = {
  name: string;     // 钥匙上的凭据名，原样（含 "60/" 周期前缀），UTF-8 1–64 字节；不可编辑
  keys: string[];   // 见过它的钥匙的 deviceId：base64url(SHA-256(SELECT 的 ID)[0..16])，22 字符；1–8 个；只作提示
  touch?: boolean;  // 只对 TOTP：添加时得知是否需要触碰；只用于显示，实际以钥匙为准。HOTP 无从得知，不写
};
export type Entry = SoftEntry | KeyEntry;
```

- `type/algorithm/digits/period` 对钥匙条目是**显示用的副本**（钥匙说了算）：`type` 与算法来自 LIST，周期从凭据名解析，位数来自第一次计算的应答。没有钥匙时，界面靠它们画倒计时环和"HOTP/TOTP"标签。
- **HOTP 钥匙条目**：schema 接受（`type: "hotp"`、没有 `touch`），第一版的产品不创建、不计算它们（D21）。这样以后的版本放开 HOTP 时，第一版的客户端读到它也只会显示"这个版本不支持"，而不会把整个库判成 `invalid_vault`、触发恢复回退。
- `deviceId` 的定义有意与 ykman 一致（`_get_device_id`：SHA-256 前 16 字节，yubikit [复核]），只是编码用 base64url，这样测试时可以和 ykman 直接对照。
- 用 TypeScript 的判别联合，让编译器找出所有直接用 `e.secret` 的地方（§2.11 的清单）。

### 2.2 schemaVersion：按内容派生

- **规则**：**由 `serializeVault` 计算**（YR-25）：若存在任一 `kind === "ykoath"` 的条目（存活的或在回收站里的——它们仍带 `kind/ref`），写 `schemaVersion: 2`；否则写 1。回收站里的也算，理由见 §0.0 的 YR-25 一行：写成 v1 会让旧客户端的 `parseEntry`（`validate.ts:44` 要求 `secret` 是字符串）把整个库判为损坏并回退，而 v2 只会让它停下并提示更新。`schemaVersion` 不再是一个独立保存、可信的值，而是内容的函数，所以合并天然满足交换律与结合律（合并结果的版本由合并后的条目决定）。`Vault.schemaVersion` 的类型放宽为 `1 | 2`；`parseVault` 照样返回读到的值，但**没有任何代码信任它**。原因：`ops.ts` 用展开构造新库（`{...v, entries}`，`addEntry`、`replace`、`clampVault`），`mutate` 每次保存都做 `deserializeVault(serializeVault(next))` 往返检查（`service.ts:582`）；版本若是存下来的字段，加第一个钥匙条目时会以 v1 加 `kind` 写出（往返检查失败，添加安全地失败，是 bug 不是丢数据），清除最后一个时又会一直停在 v2。
- **解析**：v1 里出现 `kind` 字段 → `invalid_vault`；v2 里条目可以没有 `kind`（就是软件条目）；**"v2 但一个钥匙条目都没有"读时接受**（可能来自较早的 v2 写入者或清除中途的快照），下次保存写成 v1，但永远不产生；`> 2` → `newer_schema`（现有规则：较新版本写的数据永不为写入而打开）。
- **为什么不在 v1 里加"保留未知字段"的通用机制**：SYNC-DESIGN 已经定了相反的规则（I11：新增条目字段必须升 schemaVersion，旧客户端 `paused_newer`，`parseEntry` 只重建已知字段）。通用的"未知字段原样保留"会削弱"读回来的东西都先校验"这一原则（`validate.ts` 对每个字段限长），也会让旧客户端把它不理解的条目拿去做合并、显示、导出。按内容派生的版本号已经把代价降到"只有真的用了钥匙条目的库，才让没更新的旧客户端暂停同步"。
- **迁移**：没有。现有的库一字节不变。第一次添加钥匙条目就是一次普通保存（`transact` 前照常有快照，PLAN §4.6）。
- **回到 v1**：钥匙条目全部被永久删除后（§2.3），保险库重新序列化为 v1，旧客户端恢复同步。回收站里还有钥匙条目时仍是 v2。
- **旧客户端**：读到 v2 → `newer_schema`：本地打开显示"请更新 Sixkey"（`popup/load.ts`、`options/App.tsx` 已有）；备份恢复报 `newer_format`（`backup.ts` 第 75 行已有）；同步 `paused_newer`（SYNC-DESIGN §4.3），什么都不写，outbox 保留到更新以后。
- **最省事的顺序**：在第一个公开（商店）版本里就带上 v2 的解析、合并、校验和"需要 YubiKey"的显示（没有任何新权限，没有助手），那么**任何公开客户端都不会遇到 `paused_newer`**（Q4）。这部分不需要真钥匙，不必等 G2（YR-23）；只有"从 YubiKey 添加"的映射要等 G2 用真钥匙检验。

### 2.3 合并（三个 LWW 寄存器）

- `contentOf(e)` 加入 `kind` 与 `ref`：内容寄存器整体 LWW（按 `hlc`，平局比 `canonicalJson`），**种类随内容一起取胜方的**。所以"软件条目 ↔ 钥匙条目"只会作为整个内容寄存器的值被替换，不会出现半个软件半个钥匙的条目。
- `placement`、`deletion` 寄存器不变。
- `ref.keys` 是内容寄存器的一部分：一台设备上改名、另一台设备上同时"记下这把钥匙"，合并后只留一方（与今天"改名"对"记住此网站"的结果相同，体验调研 U1 的既有取舍）。丢掉的只是一个提示，下次添加流程会再问。
- `counter`：现有规则是"不论哪边写的内容，计数取最大，类型变了也保留，好让合并满足结合律"（`merge.ts` 第 49–52 行）。钥匙条目不用计数，但为了结合律**照样携带**；校验允许钥匙条目带 `counter`，界面忽略它。
- **永久删除**（purge）钥匙条目：变成**现有的 v1 清除标记**：`{id, createdAt, type, issuer: "", label: "", secret: "", algorithm, digits, period, hlc: 新戳, order, phlc, deleted, dhlc}`，**去掉 `kind` 与 `ref`**。这里复用"空 secret = 已清除"是对的：它表示的正是"已清除"，而不是"种子在钥匙里"；清除标记什么也不携带，所以保险库可以回到 v1。`isPurged()` 不用改。
- 与软件条目的清除完全同样的语义（包括"另一台设备上更新的编辑会让它回来"的那些既有性质），不引入新规则。
- **守卫**（SYNC-DESIGN §4.4，I8：同一 id 的 secret 从一个非空值变成另一个非空值必为异常）：对钥匙条目对应为"同一 id 的 `ref.name` 改变"与"同一 id 在两个未清除的种类之间切换"，都是阻塞条件。因为 `ref.name` 不可编辑（`ops.ts` 的 `editEntry` 拒绝改它，就像拒绝改 secret），诚实的客户端从不产生这两种变化。

### 2.4 校验上限

| 字段 | 规则 | 依据 |
|---|---|---|
| `kind` | 只能是 `"ykoath"`；只在 v2 出现 | — |
| `ref.name` | 字符串，UTF-8 编码 1–64 字节；不能含 U+0000 | YKOATH 规范：名字 "max 64 bytes" [转录] |
| `ref.keys` | 数组 1–8 项，每项 `/^[A-Za-z0-9_-]{22}$/`，不重复 | — |
| `ref.touch` | 布尔；只能出现在 `type: "totp"` 的钥匙条目上 | HOTP 的触碰属性无从得知（D21） |
| `issuer/label/domains/group` | 与软件条目相同（`LIMITS`） | `validate.ts` |
| `type/algorithm/digits/period` | 与软件条目相同 | 同上 |
| 不得出现 | `secret`（钥匙条目上出现即 `invalid_vault`） | — |
| 条目总数 | 钥匙条目计入 5000（新增时检查，C13） | SYNC-DESIGN C13 |

钥匙上名字不是合法 UTF-8 的凭据：助手照样以 base64 返回原始字节，扩展拒绝添加并说明"名字格式不受支持，请在 Yubico Authenticator 里改名"。`fitsLimits` 增加对 `ref` 的检查，保证"保存的东西都能读回"。

### 2.5 导出与备份

| 出口 | 钥匙条目 | 界面文字 |
|---|---|---|
| 加密备份（`sixkey-backup` v1 文件格式不变，里面的保险库是 v2） | 包含引用 | 备份页："N 个账户在 YubiKey 上：备份里只有它们的名字，没有密钥。" |
| 从备份恢复到没有钥匙的机器 | 显示"需要 YubiKey" | — |
| 恢复到旧版 Sixkey | `newer_format`："请更新 Sixkey" | 已有 |
| 明文导出（otpauth 行） | **不包含**（没有密钥可写） | "N 个 YubiKey 上的账户没有导出：它们的密钥无法从钥匙里读出。" |
| 选择性加密导出（H2，子集） | **不能选**（勾选框禁用并说明） | "在 YubiKey 上的账户无法分享：请把钥匙本身交给对方。" 另一个理由：`ref.keys` 是硬件标识，会让不同的子集文件关联到同一把钥匙，违背 H-d 的不可关联要求 |
| 导入去重（`import/dedupe.ts`） | 不参与按密钥字节的去重；单独按 `ref.name` 去重（再看 `keys` 是否有交集） | — |
| 导入**另一个库**的完整备份（`service.ts:834–840` `importBackup` 的 added 模式，YR-13） | 作为引用加入，按 `ref.name`（+ `keys` 交集）去重；回收站与已清除的照旧跳过 | 导入摘要里分开计数："N 个账户，其中 M 个在 YubiKey 上" |
| 同一库的备份（merged 模式） | `mergeVaults` 照常合并，无需特别处理 | — |

### 2.6 "永不丢数据"

钥匙里的种子**不能被 Sixkey 备份**，这是硬件的性质，不是我们能修的。设计能做的：

1. 第一次添加时必须勾选确认（§1.1.2 的文字）。
2. 每条钥匙条目都带钥匙图标；编辑框写明"密钥在 YubiKey 上"。
3. 设置页的"本机存了什么"（H6，Z4）增加一行："N 个账户的密钥在 YubiKey 上（不在 Sixkey 的备份里）"。
4. 备份页与 7 天备份提醒里带同样的一句。
5. **Sixkey 从不删除、覆盖、重置钥匙上的任何东西**——助手根本没有那些指令（§3.2）。从 Sixkey 删除一个钥匙条目，钥匙上的凭据不受影响。
6. 帮助页写 Yubico 的官方建议：添加时把同一个二维码也加到第二把钥匙上，或保存好网站的恢复码（调研 S3 [转录]）。

### 2.7 钥匙 RESET 之后、重名、PUT

- **RESET 之后**：钥匙会生成新的 ID，`deviceId` 随之改变（yubikit `reset` 之后重新算 `_device_id` [复核]）。用户把账户重新加进钥匙后，Sixkey 按凭据名匹配（D9），所以引用照常工作；`ref.keys` 里的旧提示失效，只影响"插入 YubiKey ·· a1b2"这类显示。下次"从 YubiKey 添加"时会问是否记下新钥匙。
- **按名字匹配的风险**：两把钥匙上同名、但种子不同的凭据（例如两个都叫 `GitHub:alice` 的不同账户）会让 Sixkey 显示另一把钥匙的码。码只会登录失败，不泄露任何东西；行上始终显示是哪把钥匙（哪个读卡器）出的码，同时插着两把时让用户切换（§1.1.3），不凭 `keys` 提示悄悄选。这是为"同一凭据放两把钥匙"这一官方备份方式付出的代价。
- **同一把钥匙上**：名字唯一（钥匙的 `PUT` 是"新增或覆盖"，S1）。
- **PUT 静默覆盖**：只和 B 有关；Sixkey 不实现写入，所以不存在。若将来做 B，这是第一个要解决的数据丢失陷阱（§7.5）。

### 2.8 HOTP

钥匙上的 HOTP 计数器在钥匙里，每次 CALCULATE 加一（调研 §1.1）。Sixkey 不保存、不合并它。现有的 `counter` 取最大值寄存器对钥匙条目没有意义（§2.3）。

**第一版不计算钥匙上的 HOTP**（D21，YR-2）。理由：(1) 一个 HOTP 码在服务端接受更大的计数之前一直有效（RFC 4226 的预读窗口），所以任何能让助手算一次 HOTP 的东西（A10，即使 Sixkey 锁着）都能攒下可以以后使用的第二因素，而不是 30 秒内作废的码；(2) CALCULATE ALL 对每个 HOTP 凭据都回 `0x77`，不论它是否需要触碰，ykman 的命令行自己也写"HOTP might require touch, we don't know"（评审 [转录]）——没法只放开"需要触碰的 HOTP"。助手对 HOTP 凭据的 `code` 一律回 `unsupported`，这是助手侧的硬规则，不靠扩展。以后若要支持，做成"按条目明确开启"，开启时写"控制这个浏览器的任何东西都能生成并保留这个账户的码"。

### 2.9 同步体积与隐私

一条引用约 200 字节 [估计]，对 8 MiB 上限无影响。`deviceId` 在端到端加密的保险库里，服务器看不到；只有用户自己的设备能看到。PRIVACY.md 要写明（§5.2）。

### 2.10 两个本机记录

| 键 | 内容 | 加密 | 同步 | 备份/镜像 | VK 变化时 |
|---|---|---|---|---|---|
| `sk_prf` | §1.2.1 | 包裹由 PRF 派生的 KEK 加密；元数据明文（锁定时必须可读） | 否 | 否（丢了重新登记即可） | `VkRecord`：旧 VK 的包裹置空，提示一次触碰重新启用 |
| `sk_oath` | `{v: 1, enc: {vkId, iv, ct}}`，`ct = AES-GCM(HKDF(VK, "sixkey/v1/oath-access"), canonicalJson({keys: [{deviceId, access}]}), AAD = "sixkey-oath|1|{vaultId}|{vkId}")`（AAD 按 YR-19 补上） | VK | 否 | 否 | `VkRecord`：用 `held` 里的旧 VK 打开，重新加密到当前 VK；另一个 vaultId 下的记录删除 |

两者都不在 `sk_sync_*` 名下，所以"关闭同步 / 移除同步身份"的一步删除（D11）不碰它们；也都**不是** `store.ts` `hasAnyData()` 意义上的"保险库数据"（它只认槽位、keyring 副本、镜像与快照的键，`store.ts:303`），所以只剩这两个键时仍算"空"，首次运行照常；配置文件克隆分身（§4.10）也不需要处理它们（克隆本来就是同一个人的同一份数据）。

### 2.11 要改的代码（凡是用 `secret` 判断身份或生成码的地方）

| 位置 | 现在 | 改为 |
|---|---|---|
判别联合会让编译器标出每一处读 `e.secret` 的地方，但**标不出展开**（`{...e, secret: ""}`，`ops.ts` 的 `purgeEntry`、`clampVault`），而且每一处都要有一个决定。逐处（按评审 YR-13 补全，代码行已核实）：

| 位置 | 现在 | 决定 |
|---|---|---|
| `model.ts` `isAlive/isPurged` | `secret === ""` | `isPurged`：`kind` 不存在且 `secret === ""`；`isAlive` 对钥匙条目只看删除寄存器 |
| `validate.ts` `parseEntry/parseVault/serializeVault` | 只认 v1 | §2.2（版本在 `serializeVault` 里算）、§2.4 |
| `merge.ts` `contentOf`、`mergeVaults` | 写死 `schemaVersion: 1`（`merge.ts:77`） | 加 `kind/ref`；不再写版本字面量 |
| `ops.ts` `addEntry` / `editEntry` | — | 新增 `addKeyEntry`；`editEntry` 拒绝改 `ref.name` 与 `kind` |
| `ops.ts:116` `purgeEntry`（展开 `{...e, secret: ""}`） | 展开会把 `kind/ref` 带进清除标记 | 显式构造 v1 清除标记，去掉 `kind/ref`；测试：清除最后一个钥匙条目后整库序列化为 v1 |
| `ops.ts:111` `restoreEntry` 的守卫（`e.secret === ""`） | 认空 secret | 改用 `isPurged(e)` |
| `ops.ts:133` `clampVault`（展开） | — | 不碰版本；测试覆盖钥匙条目 |
| `service.ts:858` `purgeForever` 过滤（`e.secret !== ""`） | 钥匙条目会被跳过（它没有 secret） | 改用 `!isPurged(e)` |
| `service.ts:834–840` `importBackup` added 模式 | 按 `secret+issuer+label` 去重，`addEntry({secret})` | 钥匙条目作为引用加入，按 `ref.name`（+ `keys` 交集）去重（§2.5） |
| 计数：`FirstRun.tsx:29`、`Rail.tsx:36`、`Backup.tsx:300`（`secret !== ""`） | 只数软件条目 | 改用 `!isPurged(e)`，钥匙条目计入 |
| `Security.tsx:53` 残留警告（"到各网站重新签发 2FA 密钥"） | 任何非空 secret | 只看软件条目：钥匙条目的密钥不在磁盘上，没有可重新签发的 |
| `popup/main/AddConfirm.tsx` + `dedupe.ts` `verdictOf` | 与某条目同 issuer/label 的软件账户 → "重新绑定"→ `addOrReplace` 把旧条目放进回收站 | 钥匙条目**不作为**重新绑定的对象：同名时显示"你的 YubiKey 上也有这个账户"，两条并存（这正是 YR-20 想要的备份） |
| `import/dedupe.ts` `keyBytes` | 按密钥字节 | 钥匙条目不参与；单独按名字 |
| `ui/otp.ts:9–18` `codeFor`/`canGenerate` | 用 secret | 只处理软件条目；钥匙条目在调用前就分流到 YubiKey 模块 |
| `ui/hooks.ts:11` `keyOf`（`e.id + e.secret`） | — | 钥匙条目用 `e.id + ref.name` |
| `backup/subset.ts` | 复制 secret | 排除钥匙条目 |
| `importer.ts:206` 明文导出 | 写 otpauth | 跳过钥匙条目，界面说明（§2.5） |
| `migration.ts:212` | 只处理导入的候选（来自二维码） | 不变：候选永远是软件账户 |
| SYNC-DESIGN §4.4 守卫（I8） | 比较 secret | 加 `ref.name`/种类（§2.3） |
| A4R-12（永久删除按 secret 清除另一 vaultId 的副本） | 按 secret 认 | 钥匙条目按 `ref.name` + `keys` 交集认 |
| SYNC-DESIGN §3.5 入网 added 模式、§4.6 "找回账户" | 按 secret 去重/认 | 同 `importBackup` |

---

## 3. 本机助手（native host）架构

### 3.1 语言与打包

| 选项 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **Rust**，`pcsc` crate（MIT，绑定系统 PC/SC） | 单个原生二进制，启动 <10 ms [估计]；内存安全；依赖可以压到很少；三平台都能交叉/原生构建 | 要维护 Rust 工具链 | **采用** |
| Go | 单二进制 | macOS/Linux 的 PC/SC 要 cgo，交叉编译与可复现构建更麻烦 | 不选 |
| Python + pyscard | 有现成例子 | pyscard 是 LGPL（调研 §4.4，具体条款未核实）；要打包解释器；启动慢几百毫秒，直接拖慢弹窗 | 不选 |
| Node + 原生插件 | 与扩展同语言 | 运行时巨大，原生插件签名麻烦 | 不选 |

- **运行时不依赖 ykman**。按公开的 YKOATH 规范（S1）自己实现（clean-room）；指令码、标签、AID 是接口事实，不照抄规范页的文字，更不碰 GPL 的 `ykneo-oath`、`yubioath-desktop-dpkg`。ykman（BSD-2）只在测试里当**对照**（§6.1），不链接、不复制代码。
- 依赖白名单（`cargo-deny`）：`pcsc`、`serde`/`serde_json`、`zeroize`，Linux 上 `libc`（seccomp）。**助手里没有任何密码学**：应用密码的派生与 HMAC 在扩展里（D6），deviceId 也由扩展从 SELECT 返回的 ID 算出；RustCrypto 的 `hmac`/`sha1`/`sha2` 只作为测试依赖（模拟应用要用）。**禁止**任何网络、异步运行时、HTTP、TLS、DNS 相关的 crate。
- 系统 PC/SC：Windows WinSCard（Smart Card 服务）、macOS PCSC.framework、Linux pcsc-lite（需要 `pcscd` 与 CCID 驱动在运行，Yubico 的 README 也这样要求，调研 S8 [转录]）。

### 3.2 能力：一个很小的白名单

**助手对外的操作**（§3.3 给出消息格式）：`hello`、`keys`、`list`、`codes`、`code`，外加只在某个操作进行中、用来回答助手 `auth` 事件的 `auth` 消息。没有别的。

**APDU 层白名单**（CLA 均为 `0x00`；发送 APDU 的唯一函数接收一个枚举，不接收原始字节）：

| 枚举 | INS | P1 P2 | 数据 | 备注 |
|---|---|---|---|---|
| `SelectOath` | `A4` | `04 00` | 只能是 OATH AID `A0 00 00 05 27 21 01` | ISO SELECT |
| `Validate` | `A3` | `00 00` | 扩展给的应答（`0x75`）+ 挑战（`0x74`） | 助手不持有密钥 |
| `List` | `A1` | `00 00` | 无 | |
| `Calculate` | `A2` | `00 01`（截断） | 名字 + 助手自己算的挑战 | |
| `CalculateAll` | `A4` | `00 01` | 助手自己算的挑战 | 注意：与 SELECT 同为 `A4`，靠 P1 区分，白名单按三元组 (INS, P1, P2) 比对 |
| `SendRemaining` | `A5` | `00 00` | 无 | 响应 `61xx` 链；最多 32 段，超出即报错 |

**永远不发**：`PUT 01`、`DELETE 02`、`SET CODE 03`、`RESET 04`（`00 04 DE AD`）、`RENAME 05`，任何其他 AID（管理、PIV、OTP、OpenPGP），任何 FIDO/HID 通道。**HOTP 凭据永远不发 CALCULATE**（D21）。

**结构化的运行时检查**（YR-11；测试枚举不了"代码路径"，所以检查放在运行时）：唯一的发送函数在 `SCardTransmit` 之前断言：
- CLA = `00`；不用命令链接（CLA `0x10`）；只用短 APDU（我们最长的 CALCULATE 是 2 + 64 + 2 + 8 = 76 字节；应答超过 256 字节时走 `61xx` + SEND REMAINING）；
- (INS, P1, P2) 在上表里；
- 数据精确匹配：SELECT 只能是那 7 字节的 AID；VALIDATE 只能是 `0x75`（长度等于 SELECT 的 `0x7B` 所示算法的 HMAC 长度：SHA1 20、SHA256 32、SHA512 64）加 `0x74`（8 字节）；CALCULATE 只能是 `0x71`（1–64 字节）加 `0x74`（8 字节）；CALCULATE ALL 只能是 `0x74`（8 字节）；LIST 与 SEND REMAINING 没有数据；
- 任何一条不满足 → 不发送，回 `internal` 并退出。
测试通过一个**记录 APDU 的模拟传输层**：跑完全部操作和敌意输入后，断言记录里的每一条都满足上面的检查，而且没有 `01–05`。YK 4.2.0–4.2.6 需要的"触碰时插一条虚拟 APDU"的变通不实现，这几个固件上的触碰凭据不支持（评审 [转录]）。

**不读序列号**：序列号与型号要选管理应用（另一个 AID），不在白名单里。钥匙的显示名只用 OATH 应用 SELECT 返回的版本号，加上读卡器名。

**探测**：助手对每个读卡器里的卡只发一条 SELECT OATH AID；别的智能卡（银行卡、证件卡）回 `6A82`，助手忽略它。NFC 读卡器上的 YubiKey 5 NFC 因此也能用。读卡器名以 "Yubico YubiKey" 开头的标 `usb: true`，其余标为外接读卡器（可能是 NFC）[推断，名字规则由 G2 确认]。**任何能应答 OATH AID 的卡都会被当作"钥匙"**（例如 NFC 读卡器上的可编程卡，它能自称任何盐、任何名字、任何码，YR-18），所以界面显示读卡器名、不凭 deviceId 提示悄悄优先某张卡，名字一律当不可信文本。

### 3.3 消息协议 v1

帧：Chrome 原生消息的标准帧（4 字节本机字节序长度 + UTF-8 JSON）。

**请求**（扩展 → 助手）：`{"v": 1, "id": <1..2^31-1 的整数>, "op": "...", ...参数}`
**应答**：`{"v": 1, "id": n, "ok": true, ...}` 或 `{"v": 1, "id": n, "ok": false, "err": "<错误码>", "sw"?: "6a82"}`
**事件**（助手主动）：`{"v": 1, "ev": "keys_changed"}`；`{"v": 1, "id": n, "ev": "touch"}`（某个请求正在等触碰）；`{"v": 1, "id": n, "ev": "auth", "ch": <钥匙挑战 base64>, "alg": "SHA1"|…}`（某个请求在它的卡事务里需要密码验证）。
**`auth` 消息**（扩展 → 助手，只用来回答同一 `id` 的 `auth` 事件）：`{"v": 1, "id": n, "op": "auth", "resp": <我们的应答>, "ch": <我们给钥匙的 8 字节挑战>}`，或 `{"v": 1, "id": n, "op": "auth", "none": true}`（手里没有访问密钥）。

| op | 参数 | 返回 | 说明 |
|---|---|---|---|
| `hello` | `ext`: 扩展版本 | `host: {name: "sixkey-oath-host", version, proto: 1, build: <git 提交>, scope: "system"\|"user"\|"unknown", dbg: "off"\|"unknown"}`、`ops: [...]` | **必须是第一条**；之前的任何请求 → `bad_request` 并退出。`scope` 由助手按自己可执行文件所在目录判断，只用于诊断（§3.8）。父浏览器开着远程调试 → 回 `debugging_enabled`（D24，见下） |
| `keys` | — | `keys: [{h, reader, usb, oath, ver?, id?, locked?, alg?}]` | `h` 是本进程内有效的句柄；`id` = SELECT 返回的 ID（盐，base64）；`locked` = SELECT 返回了挑战（设了密码）。不做验证 |
| `list` | `h` | `creds: [{n: <名字原始字节 base64>, t: "totp"\|"hotp", a: "SHA1"\|"SHA256"\|"SHA512", p: <从名字解析的周期>\|null}]`；设了密码时另有 `kr`（钥匙对我们挑战的应答） | 一个事务（见下） |
| `codes` | `h`、`step: 0\|1` | `t`（助手时间，ms）、`codes: [{n, k: "code", c, d, p, from, to} \| {n, k: "touch"} \| {n, k: "hotp"}]`，可有 `kr` | 一个事务。周期 30 的走一次 CALCULATE ALL；**周期不是 30 的不需触碰 TOTP 逐个 CALCULATE 重算**（CALCULATE ALL 只用一个 30 秒挑战，ykman 的 `calculate_all` 也这样处理 [复核]）；需要触碰的与 HOTP 只返回名字（规范："just name for HOTP and credentials requiring touch" [转录]） |
| `code` | `h`、`n`、`step: 0\|1` | `t`、`c`、`d`、`p`、`from`、`to`，可有 `kr` | 一个事务，单个 CALCULATE。需要触碰的（上一次 `codes` 里是 `0x7C`）先发 `touch` 事件；未知时 300 ms 没有应答也发。**HOTP → `unsupported`，不发 CALCULATE**（D21）；`p` 为 null → `unsupported` |

**一个操作 = 一个卡事务**（YR-4）。OATH 应用的验证状态属于**卡**，不属于哪个进程：每次 SELECT 都产生新挑战并清掉验证（ykneo-oath 把状态放在 `CLEAR_ON_DESELECT` 的内存里 [复核]；YubiKey 5 的固件不公开，同样行为是 [推断]，G2 确认）；Windows 的 CertPropSvc 在插入时会读所有智能卡上的证书（评审 [转录]），scdaemon 默认独占读卡器；所以 SELECT 与 VALIDATE 之间不能有缝。`list`、`codes`、`code` 都按这个顺序：
1. `SCardBeginTransaction`。
2. SELECT OATH AID——**每个操作都从 SELECT 开始，从不假定应用还被选着，也从不依赖别的进程做过的 VALIDATE**（YR-15 的不变量；它也保证经过真助手的 A10 搭不上别人的会话 [推断]）。
3. SELECT 返回了挑战 → 发 `auth` 事件 → 最多等 2 秒同一 `id` 的 `auth` 消息。`none` → 结束事务，回 `locked`；超时 → 结束事务，回 `auth_timeout`。
4. VALIDATE（扩展给的应答 + 扩展给的挑战）。`9000` → 把钥匙的应答作为 `kr` 放进最终应答，**扩展核对它之后才显示码**；`6A80` → `wrong_password`（此时可以确定：VALIDATE 紧跟在本事务自己的 SELECT 之后）。
5. 执行指令。
6. 本事务做过 VALIDATE → **结束前再 SELECT 一次**，清掉验证状态，不给别的 PC/SC 客户端留下已验证的会话。
7. `SCardEndTransaction(SCARD_LEAVE_CARD)`。
事务最多持有"2 秒的验证等待 + 指令时间"；等触碰时最多 30 秒，这段时间里别的程序（Yubico Authenticator 等）要等着。这是用户自己点了"触碰"的那几秒，可以接受。

**状态字表**（YR-3；每一行都在模拟应用上有测试）：

| 指令 | 状态字 | 映射 |
|---|---|---|
| SELECT | `9000` | 成功 |
| SELECT | `6A82` | `no_oath`（钥匙没有 OATH 应用，或 CCID 被关闭；ISO 7816 的"找不到"[推断]） |
| VALIDATE | `9000` | 成功（扩展再核对 `kr`） |
| VALIDATE | `6A80` | `wrong_password`（规范："Wrong syntax"；yubioath-flutter 把它当作密码错 [复核]） |
| VALIDATE | `6984` | `no_password_set`（规范："Auth not enabled"）：只会在 SELECT 之后密码被别的程序取消时出现；结束事务，扩展重试一次 |
| LIST / CALCULATE ALL / 不需触碰的 CALCULATE | `6982` | 本事务的 SELECT 返回过挑战而没有 VALIDATE → `locked`；否则 `card_error` |
| 需触碰的 CALCULATE | `6982`，且距发出 ≥ 2 秒 | `touch_timeout`。ykman 命令行把这里的 `6982` 一律当作触碰超时，yubioath-flutter 用"超过 5 秒"区分 [复核]；鉴权失败会在毫秒内返回，所以 2 秒足够区分 [推断]。**从不自动重试** |
| 需触碰的 CALCULATE | `6982`，不到 2 秒 | 按上一行"鉴权"规则处理 |
| CALCULATE | `6984` | `not_found`（规范："No such object"） |
| 任意 | `6A80`（VALIDATE 以外） | `internal`（我们发的格式错了：一个缺陷） |
| 任意 | `6581` | `card_error` |
| PC/SC | `SCARD_E_SHARING_VIOLATION` | `busy_other_app`："另一个程序（例如 gpg 的 scdaemon）正独占这把 YubiKey" |
| PC/SC | `SCARD_W_REMOVED_CARD`、`SCARD_E_NO_SMARTCARD` | `no_key` |

规则：

- **时间**：挑战 = `floor(助手系统时间 / p) + step`（8 字节大端），`step` 只能是 0 或 1。扩展**不能**传时间戳、周期或挑战（D5）。所以 SYNC-DESIGN C17 的"可选校正时间"对钥匙条目不适用；设置页的时钟说明里要写这一句。倒计时按助手返回的 `from/to` 画。这条只约束经过真助手的调用方（YR-9）：直接用 PC/SC 的本机进程、冒充的助手，都能对任意挑战取码。
- **周期只来自凭据名**（YR-10）：助手自己解析名字前缀，规则严格：`^([1-9][0-9]{0,4})/`，值在 1–86400；没有前缀 → 30；前缀不合规（`0/`、`030/`、超范围）→ `p: null`，助手拒绝计算这个凭据。请求的 schema 里**没有** `p`、`t` 或挑战字段（未知字段本来就拒绝）。否则一个 `p = 1, step = 1` 就等于 `floor(t/1) + 1`，即约 30·t 秒以后的那个 30 秒挑战，D5 就塌了。单元测试对每种名字形式断言挑战值。
- **长度**：请求 ≤ 4 KiB（Chrome 允许发 64 MiB [转录]，我们自己限）；超出 → `too_large` 并退出。应答 ≤ 64 KiB（Chrome 的上限是 1 MiB，`kMaximumNativeMessageSize`，源码 main [复核]；64 个凭据约 20 KB [估计]）。
- **JSON**：严格解析：重复键、未知字段、非整数数字、深度 > 3、非法 UTF-8 → `bad_request`；同一请求出错只回一次错误，帧错误（长度不符、截断）直接退出。
- **并发**：串行处理；队列最多 4 个，多了 → `busy`。**`auth` 消息不进队列**：它若是给正在卡事务里等待的那个 `id` 的，直接交给那个操作；给别的 `id` 的 → `bad_request`（否则排在队列后面会撞上 2 秒的 `auth_timeout`）。限速（每个进程内）：`codes` ≤ 2 次/秒 → `rate_limited`。（HOTP 不计算，所以没有计数器可刷。）
- **超时**：不需要触碰的 APDU 3 秒；触碰 30 秒（钥匙自己的触碰超时没有文档 [未核实]）。没有"取消"操作：用户在界面上取消只是不再理会结果，钥匙自己会超时。
- **PC/SC**：`SCARD_SHARE_SHARED`；连接在进程生命期内保持，但**验证从不跨事务保留**（上面第 6 步）。同时打开的两个 Sixkey 页面各有一个助手进程，各自的操作各自在事务里完成验证，不会互相把对方"踢成锁定"；设置页本来就不轮询（§1.1.6）。
- **插拔**：一个线程用 `SCardGetStatusChange` 监视读卡器变化 → `keys_changed` 事件；扩展收到后重新 `keys`。旧句柄失效 → `no_key`。

**错误码**：`bad_request`、`unsupported_version`、`unknown_op`、`unsupported`（HOTP、周期前缀不合规）、`too_large`、`busy`、`busy_other_app`、`rate_limited`、`debugging_enabled`（D24）、`no_service`（PC/SC 服务不可用，例如 Linux 上没有 pcscd）、`no_reader`、`no_key`、`no_oath`、`locked`、`auth_timeout`、`wrong_password`、`no_password_set`、`touch_timeout`、`not_found`、`card_error`（附 `sw`）、`internal`。错误信息里**不含**凭据名、码或任何密钥。

**版本**：`v` 是协议版本。扩展内置 `MIN_PROTO` 与 `RECOMMENDED_HOST_VERSION`；`hello` 的 `proto` 低于 `MIN_PROTO` → 设置页提示更新助手。扩展解析应答时，必需字段严格校验，未知字段忽略（应答从不原样存储）。助手收到 `v` 高于自己的请求 → `unsupported_version`。

**启动参数**：Chrome 把调用方 origin 作为第一个参数传入，Windows 上还有 `--parent-window`，开启原生发起连接时还可能有更多参数（源码 main [复核]；评审 N10）。助手**只看 `argv[1]`**：它必须属于**构建时传入**的 origin 列表、stdin 不能是终端，否则退出——**这只是防误用的健全性检查，不是安全措施**：任何本机进程都能伪造参数。开发构建的列表是开发 ID（§3.6，否则 Y2 探针一启动就会退出）；发布 CI 断言它恰好等于 `[商店 origin]`，与对 `allowed_origins` 的检查是同一条。唯一的例外是 `argv[1] == "--version"`：打印版本与构建号后退出（§3.10b），供用户自查。

**调试端口检查**（D24，YR-1）：启动时、回答 `hello` 之前，助手找到启动它的浏览器进程（父进程；Windows 上若父进程是 `cmd.exe`——Chrome 未直接启动 exe 时会经它启动，`launch_context_win.cc` [复核]——就再往上一级），读它的命令行（Linux `/proc/<pid>/cmdline`；macOS `sysctl KERN_PROCARGS2`；Windows `NtQueryInformationProcess(ProcessCommandLineInformation)`）[推断，同用户进程可读，G2 确认]。含 `--remote-debugging-port` 或 `--remote-debugging-pipe` → 之后每个请求都回 `debugging_enabled`，不碰钥匙。读不到 → 照常服务，`hello` 里报 `dbg: "unknown"`。**助手只在命令行里查这两个开关名**：不保存、不记录、不返回命令行的任何内容，对外只有 `dbg: "off" | "unknown"` 与 `debugging_enabled` 这一个结果（零追踪不变）。
- **为什么值得**：A10 最常见的路——厂商的本地自动化接口、Playwright/Puppeteer 启动的浏览器——都靠这两个开关；浏览器的命令行是页面里的代码（包括已经重新拿到权限的 A10）改不了的。这是预设做不到的、真正在扩展之外执行的检查。
- **它挡不住的**（如实写进 SECURITY）：运行时开启的远程调试（Chrome 144 起的 `chrome://inspect#remote-debugging`，每个会话要用户批准 [摘要]）、用户自己打开的开发者工具、改了开关名字的分叉 [未核实]、操作系统层面的代理、恶意软件。
- **代价**：用调试端口跑日常浏览的用户（开发者）用不了 A；指纹浏览器里凡是由自动化接口启动的配置文件也用不了——这正是"不要在被脚本控制的配置文件里用 A"。开发与 e2e 构建用构建开关关掉它；发布 CI 断言发布构建里它是开着的。

**退出与清理**（YR-26）：Chrome 销毁端口时**关闭管道**，等 2 秒，然后 SIGKILL（POSIX/macOS）或 `TerminateProcess`（Windows）；**不发 SIGTERM，也没有控制台事件**（`native_message_process_host.cc`、`kill_posix.cc`、`kill_mac.cc`，源码 main [复核]）。所以：
- 一个专门的线程读 stdin；EOF 时若没有 APDU 在进行，立即退出——按上面的事务规则，此时不会留下已验证的会话。
- 若有 APDU 在进行（例如等触碰），设退出标志；APDU 一返回就再 SELECT（或以 `SCARD_RESET_CARD` 断开）然后退出。
- 残余：在设了密码的钥匙上**等触碰期间**关掉页面，助手可能在 APDU 返回前就被杀，应用保持已验证，直到别的程序选择应用或拔出钥匙 [推断]（§4.5 A12）。
- 测试：触碰等待中关掉页面，再用第二个 PC/SC 客户端检查 CALCULATE 是否要求 VALIDATE。

### 3.4 零网络：怎么保证，怎么核实

扩展的 CSP `connect-src 'none'` 不管原生消息，也管不到助手：助手不联网这件事**浏览器不强制**，要靠我们自己。注意 PC/SC 本身就是 IPC：Linux 上 pcsc-lite 客户端用 **AF_UNIX** 套接字连 pcscd，Windows 用 RPC，macOS 用 XPC [推断，以各平台实现为准]，所以"二进制里不许有 socket"这种规则是错的。规则是：**不得有 AF_INET/AF_INET6 套接字、不得做 DNS 解析、不得链接任何网络库**。

| 层 | 手段 | 平台 |
|---|---|---|
| 源码 | `clippy` 的 `disallowed-types`/`disallowed-methods` 禁 `std::net::*`、`ToSocketAddrs`；`#![forbid(unsafe_code)]`，例外只给 PC/SC 绑定与 seccomp 一个模块 | 全部 |
| 依赖 | `cargo-deny` 白名单（§3.1），禁网络类 crate；`Cargo.lock` 锁定；依赖源码 vendored | 全部 |
| 二进制 | CI 检查导入表：Windows 不得导入 `ws2_32.dll`、`winhttp.dll`、`wininet.dll`、`dnsapi.dll`；macOS 不得链接 `Network.framework`、`CFNetwork`，不得引用 `getaddrinfo`；Linux（动态 glibc 构建，D23）：`DT_NEEDED` 只能是 libc、libpcsclite、libgcc_s 与动态加载器，**剥离之前**检查未定义符号里没有 `getaddrinfo`、`gethostbyname`、`getnameinfo`（`socket`/`connect` 允许，因为 libpcsclite 需要；它们在 libpcsclite 里，不在我们的二进制里） | 全部 |
| 运行时 | 启动后自己装 seccomp-bpf：`socket()` 只允许 `AF_UNIX`。Chrome 在 Linux 上以 `allow_new_privs` 启动助手（源码 main [复核]），所以助手必须**自己**设 `PR_SET_NO_NEW_PRIVS` 再装过滤器 | Linux |
| 运行时 | App Sandbox：签名时带 `com.apple.security.app-sandbox` 与 `com.apple.security.smartcard`，**不带** `com.apple.security.network.client`；命令行工具在沙箱里经 stdio 工作、能否访问 PC/SC，要在探针里确认 [未核实] | macOS |
| 运行时 | 没有便宜的进程级办法。可选：MSI 为助手路径加一条 Windows 防火墙出站阻止规则 [推断可行] | Windows |
| 人工 | 每个发布的变更评审清单里有"网络"一项 | — |

### 3.5 无日志、无持久状态

- 不写文件，不读配置，不建目录，不用注册表（安装器写的除外）。唯一的例外不是助手做的：macOS 第一次运行沙箱化的程序时，系统会创建 `~/Library/Containers/<bundle id>`（YR-21 [推断]）；助手不往里写任何东西。
- stderr 只写固定的错误令牌（如 `E_FRAME`），不含名字、码、挑战、应答。Chrome 会把宿主的 stderr 写进自己的日志（Edge 文档的调试一节 [转录]），所以这一条很重要。
- `panic = "abort"`，固定信息；POSIX 上 `setrlimit(RLIMIT_CORE, 0)`；Windows 上用 `WerAddExcludedApplication` 把助手排除在错误报告之外 [推断可行]。
- 码、应答在发送后 `zeroize`；助手从不持有访问密钥（D6）。
- 进程退出条件：stdin 结束、帧错误、`hello` 之前的请求。Chrome 销毁端口时关管道、2 秒后强杀（§3.3"退出与清理"，源码 main [复核]）。

### 3.6 宿主清单

```json
{
  "name": "app.sixkey.oath",
  "description": "Sixkey YubiKey helper",
  "path": "<绝对路径>",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<STORE_ID>/"]
}
```

- `allowed_origins` 不能用通配符，Chrome 拒绝 `match_all_urls` 与子域模式（`native_messaging_host_manifest.cc`，源码 main [复核]）。发布版**只**列商店 ID；`scripts/store-id.mjs` 的 `STORE_ID` 在第一次提交商店之前为空，所以 **A 的助手在 Phase 2 之前不能发布**。（商店后台创建条目、上传第一个包时就分配 ID，不必等公开 [推断]。）
- 开发：`manifest.dev.json` 加一个开发用 `key`（公钥），开发构建因此有稳定的开发 ID；开发脚本把只含开发 ID 的宿主清单装到本机。发布打包的 CI 断言 `allowed_origins` 恰好等于 `[商店 origin]`，开发 ID 永远不进发布包。
- `path` 在 macOS/Linux 必须是绝对路径，Windows 可以相对清单所在目录（源码 main [复核]）。
- 不声明 `supports_native_initiated_connections`（那是只在 ChromeOS 上的特性）。
- **关于 `allowed_origins` 能挡住什么**：商店里装的其他扩展（它们的 ID 由商店分配，冒充不了 Sixkey 的）。**挡不住**：一个用 Sixkey 公钥做 `key` 的解压扩展会得到相同的 ID（扩展 ID 由公钥决定，而商店包里的公钥是公开的）[推断]；这需要开发者模式或本机文件写权限，而有这种能力的本机进程本来就能直接用 PC/SC。

### 3.7 各操作系统与浏览器的位置

**先说两条从源码读到、决定了安装方式的事实**（源码 main [复核]）：

1. macOS/Linux 的**用户级**位置是 `DIR_USER_DATA/NativeMessagingHosts`，即**当前用户数据目录**下、与 `Default/` 并列（不在 `Default/` 里面）（`chrome_paths.cc`），并且**先查用户级、再查系统级**（`launch_context_posix.cc`）；Chrome 启动时会创建这个目录（评审 [转录]）。指纹浏览器给每个配置文件一个自己的用户数据目录，所以：用户级安装对它们**不可见**；而一个被厂商同步过来的用户数据目录里，如果夹带了 `NativeMessagingHosts/app.sixkey.oath.json`，它就会**遮蔽**系统级的助手。这要求厂商同步的是用户数据目录这一层（已记录的 GoLogin SDK 只打包 `Default/`），还要求接收方机器上有清单 `path` 指向的可执行文件，所以可能性较低 [推断，YR-22]。
2. **系统级**位置由构建的品牌决定：Google Chrome、Chrome for Testing、Chromium 各不相同；Windows 上按品牌读注册表，Chromium 品牌的构建（Chrome for Testing 也是）先读 `SOFTWARE\Chromium\NativeMessagingHosts`、再回落到 `SOFTWARE\Google\Chrome\NativeMessagingHosts`，HKCU 先于 HKLM，32 位视图先于 64 位（`launch_context_win.cc`）。`FindManifestInDir` **只检查文件存在**：用户级位置上**任何**名为 `app.sixkey.oath.json` 的文件——哪怕是空的、无效的——都会让 Chrome 报"找不到"或"禁止"，**不会**再去找系统级（`launch_context.cc`、`launch_context_posix.cc` [复核]；YR-27）。

所以 **只支持系统级安装**（D18）。安装器写下面这些位置：

| 平台 | 浏览器 | 系统级位置 | 来源 |
|---|---|---|---|
| Windows | Chrome | `HKLM\SOFTWARE\Google\Chrome\NativeMessagingHosts\app.sixkey.oath`（默认值 = 清单路径） | Chrome 文档 [转录]；源码 [复核] |
| Windows | Chromium 品牌的构建（含多数指纹浏览器） | 先 `HKLM\SOFTWARE\Chromium\…`，回落到上一行 | 源码 [复核]；指纹浏览器是否改过这段代码 [未核实] |
| Windows | Edge | `HKLM\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\…`，找不到时回落到 Chromium、Google Chrome 的键。**只对从 Chrome 应用商店安装的 Sixkey 有效**：从 Edge Add-ons 安装的 ID 不同，会 `host_forbidden`；Sixkey 不在 Edge Add-ons 上架，不加第二个 ID（`store-id.mjs` 仍是唯一写着 ID 的地方，YR-16） | Edge 文档（2026-09-02 更新）[转录] |
| Windows | Brave | 我没找到文档；它若是 Chromium 品牌会回落到 Google Chrome 键 | [未核实] |
| macOS | Chrome | `/Library/Google/Chrome/NativeMessagingHosts/` | 源码 [复核]、文档 [转录] |
| macOS | Chrome for Testing | `/Library/Google/ChromeForTesting/NativeMessagingHosts/`（Chrome 146 之前与 Chrome 相同） | 源码 [复核]、文档 [转录] |
| macOS | Chromium 及 Chromium 品牌的分叉 | `/Library/Application Support/Chromium/NativeMessagingHosts/` | 源码 [复核]；分叉 [推断] |
| macOS | Edge | `/Library/Microsoft/Edge/NativeMessagingHosts/` | Edge 文档 [转录] |
| macOS | Brave | 用户级是 `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts`（用户数据目录规则）；系统级 | [未核实] |
| Linux | Chrome | `/etc/opt/chrome/native-messaging-hosts/` | 源码 [复核] |
| Linux | Chrome for Testing | `/etc/opt/chrome_for_testing/native-messaging-hosts/` | 源码 [复核] |
| Linux | Chromium 及分叉 | `/etc/chromium/native-messaging-hosts/` | 源码 [复核] |
| Linux | Edge | `/etc/opt/edge/native-messaging-hosts/` | Edge 文档 [转录] |
| Linux | Brave | | [未核实] |
| Linux | Flatpak / Snap 打包的浏览器 | **不支持**：沙箱里看不到宿主清单与二进制；Chromium 没有原生消息的代理或门户客户端（Firefox 有）；Snap 的严格限制挡住宿主启动——Ubuntu 默认的 Chromium 就是 snap；Google Chrome 的 `.deb` 没问题 | 社区报告 [摘要]；评审 N13 [转录] |

### 3.8 遮蔽，以及扩展到底能核实什么

| 扩展能核实 | 扩展不能核实 |
|---|---|
| 有一个程序在说协议 v1，自称某个版本与构建号 | 启动的是哪个二进制、来自哪个清单（Chrome 不告诉扩展） |
| 若设了应用密码：钥匙对我们挑战的应答正确（证明对面连着真钥匙、且没有人改动访问密钥）| 这个程序是不是我们签名的那一个（它可以如实转发给真助手，同时做别的事） |
| 助手自报的安装范围（`scope`）——只对"误配置"（例如残留的开发用用户级清单）有用 | 助手的自述是否真实 |

- **不做配对**（MCP 调研曾建议扩展与本机程序首次配对时互相确认一个数字）：助手没有持久状态，存不下配对结果；而且一个冒充者可以把配对转发给真助手。配对买不到什么。
- **"自己算自己的哈希"**也没用：冒充者会撒谎。
- **真正有效的控制**只有操作系统层面的：系统级安装到只有管理员能写的位置，加上企业策略 `NativeMessagingUserLevelHosts = false`。策略定义原文："Setting the policy to Disabled means Chrome can only use these hosts if installed at the system level"，它同时跳过用户目录与 HKCU（评审读了 `components/policy/.../NativeMessaging/` [转录]）。安装器**不**自动设这个策略：设了之后 Chrome 会显示"由你的组织管理"，还会影响用户别的扩展。帮助页的"加固"一节教高级用户自己设。
- 遮蔽的后果被设计限住了：扩展发给助手的只有操作名、句柄、凭据名、`step`，以及（设了应用密码时）一对挑战与应答。**从不发送**：种子、VK、主密码、恢复密钥、访问密钥。冒充者能做的事 ≤ 任何同用户本机进程用 PC/SC 能做的事，外加看到一对挑战/应答（可用来离线猜那个只有 1000 次 PBKDF2 的应用密码）、以及给 Sixkey 喂假码或畸形应答（扩展严格校验，§4.5）。

### 3.9 安装器与卸载器

| 平台 | 形式 | 内容 | 签名 |
|---|---|---|---|
| Windows | MSI（WiX），按机器安装，x64 与 ARM64 | `%ProgramFiles%\Sixkey\YubiKey Helper\sixkey-oath-host.exe` + 清单 JSON；写 §3.7 的 HKLM 键（64 位视图）；可选防火墙出站阻止规则；卸载删除键与文件；另提供 winget 清单 | exe 与 MSI 都 Authenticode 签名 |
| macOS | `.pkg`（productbuild），universal2 | `/Library/Application Support/Sixkey/sixkey-oath-host`（root 所有）+ §3.7 的清单；`/Library/Application Support/Sixkey/uninstall.sh`（pkg 没有卸载器）；另提供 Homebrew cask（带 `uninstall` 段） | Developer ID Application（Hardened Runtime + 沙箱权限）+ Developer ID Installer；notarize 并 staple |
| Linux | `.deb`、`.rpm` | `/usr/lib/sixkey/sixkey-oath-host`（动态链接 glibc，在按镜像摘要固定的最旧受支持发行版容器里构建，D23）+ §3.7 的清单；依赖 `pcscd`、`libpcsclite1`（或发行版对应名），用发行版自己的 PC/SC 客户端库，所以与 pcscd 的协议兼容由发行版保证；不装服务、不开端口 | 包签名 + 发布文件的独立签名（minisign 或 sigstore） |
| Linux | AppImage / tar | **不提供**：不能以 root 写系统级清单，自安装只能写用户级位置，而那正是指纹浏览器看不到、也是遮蔽发生的位置 | — |

签名只保护"下载与安装"这一步（SmartScreen、Gatekeeper 检查的是下载来的安装包）；Chrome 启动一个已安装的二进制时，操作系统一般不会再做这类评估 [推断]。所以签名不能代替 §3.8 的结论。签名也意味着**操作系统**会在安装或首次运行时联系 Apple 或 Microsoft（公证与吊销检查、SmartScreen 信誉）[推断，通用平台行为]：这不是 Sixkey 发的请求，但 PRIVACY 要写明（§5.2，YR-21）。

**卸载就是对 A 最硬的开关**：卸载后 Chrome 找不到助手，任何配置文件里的任何东西都够不到钥匙。在有共享、厂商同步或自动化配置文件的电脑上，帮助页与设置页都建议不要安装（§5.4）。

### 3.10 更新：不回连

- 助手**不检查更新**，扩展也**不联网查版本**（D19）。
- 每个扩展版本内置 `RECOMMENDED_HOST_VERSION` 与 `MIN_PROTO`。`hello` 报告的版本较旧 → **设置页**（不是弹窗）一行："有新的 YubiKey 助手（1.2.0），下载"；低于 `MIN_PROTO` → 钥匙条目显示"请更新 YubiKey 助手"。关于新版本的知识随扩展自己的更新而来，不产生任何请求。
- 用户可以用自己选择的包管理器（winget、Homebrew、发行版仓库）——那是用户的工具做的网络请求，不是 Sixkey 的。
- 下载页：放在 GitHub Releases（附 SHA-256 与签名）；`sixkey.app` 上若有说明页，必须是静态页、无分析脚本、服务器不记录 IP（与 SYNC-DESIGN D3 同一要求）。
- 好的副作用：一个被篡改的助手版本不会自动推送到所有人，扩展的恶意更新也**升级不了**助手的能力（助手没有的指令，扩展怎么改都发不出去）。

### 3.10b 事故响应：一个有问题的助手版本（YR-5，D22）

**为什么版本黑名单不够**：Chrome 在每次 `connectNative` 时启动助手——也就是开启了 A 且库里有钥匙条目时、每次打开弹窗——在 `hello` 之前。一个恶意的助手在被启动的那一刻就已经造成伤害；`hello` 之后再看版本号太晚了。

**计划**（G3 之前写好并演练一次）：
1. **扩展内置的停用开关**：每个扩展版本带一个编译进去的常量 `HELPER_KILL_SWITCH`。开启后，YubiKey 模块**从不调用** `connectNative`，弹窗与设置页常驻一行提示："Sixkey 暂停了 YubiKey 验证码：已发布的某个助手版本有问题。请按这些步骤卸载助手 ›"。它随商店自动更新送达，不需要任何网络请求或远程配置（零追踪不变）。**做不到的**：关了自动更新或旁加载的 Sixkey 收不到；已经装好的恶意助手仍在磁盘上，任何本机进程仍能运行它——真正的修复是卸载。
2. **撤销**：吊销 Apple Developer ID 证书或公证票据、Authenticode 证书，轮换 Linux 发布签名密钥。对**已经安装、未隔离标记**的二进制效果有限 [推断]，如实写在公告里。
3. **公告**：下载页与 GitHub Releases 顶部发公告，列出受影响版本与哈希、卸载步骤、修复版本。
4. **自查**：`sixkey-oath-host --version` 打印版本与构建号；公告里给出各平台的路径，用户可以对照哈希。
5. 修复版本发布后，下一个扩展版本关掉开关并把 `RECOMMENDED_HOST_VERSION` 指向修复版本。

### 3.11 供应链

- 与扩展同一套发布者账户加固（安全事件报告"高优先级 4"：硬件密钥或 passkey、不授权第三方 OAuth、至少两人能发布、发布前比对构建哈希）。代码签名证书的私钥放硬件令牌或云 HSM，只在发布时使用。
- **可复现构建**：`rust-toolchain.toml` 固定版本，`--locked`，vendored 依赖，`SOURCE_DATE_EPOCH`，`--remap-path-prefix`；Linux 在按摘要固定的容器镜像里做动态 glibc 构建（D23，不用 musl：静态 musl 二进制加载不了发行版的 glibc `libpcsclite.so`，也没有可检查的动态导入表，YR-12），CI 里两台独立机器构建后比对哈希。macOS 与 Windows 的签名会嵌进二进制：发布"签名前"的哈希，并写明怎样去掉签名后核对（`codesign --remove-signature`；Windows 用 `/Brepro` 构建）[推断，待探针确认]。
- 每个发布：变更日志、`SHA256SUMS`（签名）、SBOM、`cargo audit` 与 `cargo deny` 的结果。
- 助手的源码与扩展一起公开（建议宽松许可证，Q3），用户和第三方才能复现构建。

### 3.12 许可证

- 按公开规范自行实现，代码是我们自己的，许可证由所有者定（建议 MIT 或 Apache-2.0，与 `pcsc` 等依赖相容）。
- 不复制 yubikit、yubioath-flutter 的代码（它们是 BSD-2 / Apache-2.0，复制本身合法但要带声明；我们没有需要复制的东西）。绝不碰 GPL-3.0 的 `ykneo-oath`、`yubioath-desktop-dpkg`。
- "YubiKey""Yubico"只作指称性使用，不用其标志（品牌规范未核实，调研 §4.4）。
- 不是法律意见。

### 3.13 告诉用户安装；发现它不在；不打扰

`connectNative` 失败时，`port.onDisconnect` 里 `chrome.runtime.lastError.message` 是下列之一（Chrome 文档列出的文字 [转录]，Edge 文档相同 [转录]）：

| 文字 | 状态 | 界面 |
|---|---|---|
| "Specified native messaging host not found." | `host_missing` | "没有找到 YubiKey 助手" + 安装说明。已安装却仍出现时的第三个原因（YR-27）："这个浏览器的配置文件夹里有一个文件（`NativeMessagingHosts/app.sixkey.oath.json`）挡住了助手，删掉它" |
| "Access to the specified native messaging host is forbidden." | `host_forbidden` | "已安装的助手不接受这份 Sixkey"。原因依次是：这份 Sixkey 不是从 Chrome 应用商店安装的（与 H4 横幅同一原因，§5.5；包括从 Edge Add-ons 安装的）；配置文件夹里有一个同名文件挡住了它（同上一行）；有另一份清单遮蔽了它 |
| "Failed to start native messaging host." | `host_failed` | "助手无法启动（权限或文件损坏），请重新安装" |
| "Native host has exited." | `host_exited` | 自动重试一次；再失败显示"助手意外退出" |
| "Error when communicating with the native messaging host." | `host_protocol` | 同上 |
| "Invalid native messaging host name specified." | 不应出现（名字是常量） | 内部错误 |
| 其他 | `host_unknown` | 通用文字 |

**不打扰**：只有保险库里有钥匙条目、且 A 已开启时才会尝试连接；失败只在列表顶部显示一行（不弹窗、不开标签、不改角标）；同一个状态在一次浏览器会话里只显示一次横幅样式，之后只留行内的灰色"YubiKey"；"不再提示"存本机设置。功能关闭时什么都不显示，钥匙条目只显示灰色"YubiKey"。

---

## 4. 扩展侧

### 4.1 可选权限的申请

- `manifest.base.json` 的 `optional_permissions` 加 `"nativeMessaging"`；`permissions` 里**永远没有**它。可选权限在扩展更新时不弹警告、不停用扩展（MCP 调研 B7 [转录]）；`nativeMessaging` 不在"不能设为可选"的清单里（权限 API 文档，2026-09-11 [转录]）。
- 申请只在设置页标签、点击处理函数里（权限 API 要求用户手势 [转录]；弹窗里申请会关掉弹窗，体验调研 C15）。
- "开启" = 授权成功；"关闭" = `chrome.permissions.remove`。功能是否开启**只以权限为准**，不另存开关，免得两处不一致。
- **移除是软的，而且是永久的软**（YR-1）：`permissions.remove` 走 `RemoveType::kSoft`，"Permissions will be removed from the active set of permissions, but not the stored granted permissions. This allows the extension to re-add the permissions without further prompting"，`kHard` "is only exercised in unit tests"（`permissions_updater.h`，源码 main [复核]）；申请路径"don't prompt for already-granted permissions since these were … removed by the extension itself"（`permissions_api.cc` [复核]）。用户手势的检查能被 CDP 的 `Runtime.evaluate({userGesture: true})` 满足（评审 [转录]，在扩展页面里成立 [推断]）。所以：**一个配置文件只要曾经授权过，A10 就能不经任何提示把权限拿回来**；从没授权过的配置文件会弹 Chrome 的授权框，只用 CDP 的客户端大概点不了浏览器界面 [推断]，操作系统层面的代理能。授权记录存在配置文件里，复制或克隆配置文件会带着它 [推断]。真正的闸是 §3.2 的白名单、§3.3 的助手时钟、D24 的调试端口检查、触碰与应用密码，以及**这台电脑上根本不装助手**。
- **事后痕迹**：SW 监听 `chrome.permissions.onAdded`，`nativeMessaging` 被加回来时写安全记录 `oath_on`（R8），即使绕过了 Sixkey 的界面也留下记录。如实说明：能在 SW 里执行代码的攻击者可以压掉它。
- 授权之后，已经打开着的页面里 `chrome.runtime.connectNative` 是否立刻可用，我没有核实 [未核实]。设计：授权成功后设置页重新加载 YubiKey 面板（新的模块实例读取 API），探针确认。

### 4.2 端口放在哪里

| 选项 | 生命期 | 结论 |
|---|---|---|
| Service worker | Chrome 105 起 `connectNative` 的端口会让 SW 一直活着（扩展 SW 生命周期文档 [转录]）；于是助手进程也一直活着，与"只在用户看着时活着"相反 | **不用**。`sw.js` 里不得出现 `connectNative` |
| Offscreen 文档 | 无生命期上限 | 没有好处 |
| **页面（弹窗、设置页、PRF 小窗口）** | 端口随页面消失；Chrome 终止助手（源码 main [复核]） | **采用**。码直接在显示它的页面里产生，不经过 SW 往返 |

弹窗与设置页同时打开时，会有两个助手进程；每个操作自己的卡事务内完成验证（§3.3），设置页不轮询，所以它们不会互相打断。

### 4.3 什么时候要码

- **自动**：只有"弹窗或小窗口可见 + 保险库已解锁 + A 已开启 + 预设不是共享/自动化 + 有钥匙条目 + 停用开关未开（D22）"同时成立时，对**不需触碰的 TOTP**，在打开时和每个 30 秒边界各要一次 `codes`；周期不同的由助手处理。`document.visibilityState` 变为 hidden 时断开端口（§1.1.6）。
- **手动**：需要触碰的，只在用户点击（或按回车）时 `code`。HOTP 不计算（D21）。
- **"复制下一个"**：剩余 <3 秒时复制，用 `step: 1`。
- 后台、锁定、页面隐藏时：一律不要码。

### 4.4 CSP 与 check-dist

- CSP 不变（`connect-src 'none'` 不管原生消息 [推断，调研 §3.5 已提出，探针确认]）。
- `scripts/check-dist.mjs`：
  1. `OPTIONAL_ALLOWED` 加 `nativeMessaging`；新增规则：`nativeMessaging` 出现在 `permissions` → 失败。
  2. `connectNative` 只能出现在 YubiKey 模块的懒加载块里；出现在 `sw.js` → 失败；`sendNativeMessage` 任何地方出现 → 失败（每条消息都新起一个进程，我们不用）。
  3. 宿主名常量 `app.sixkey.oath` 是唯一允许的宿主名字符串。
  4. `navigator.credentials` 只能出现在 PRF 模块的懒加载块里（设置页与小窗口加载它，弹窗主块不加载）；出现在 `sw.js` → 失败。PRF 模块在运行时断言自己不在工具栏弹窗里（用 `?mode=window` 或设置页 URL 判断）。
  5. 弹窗预算：YubiKey 与 PRF 模块都在懒加载块，不计入首屏 60 KB 预算；主块只多出"钥匙条目画成占位行"的少量代码。
- 网络绊线（`fetch(` 等）不变；Phase 1 的"只有 `sw.js` 可以 `fetch`"规则在 M5 改写时不要推广成"只有 SW 可以和外部说话"，否则会误伤页面里的 `connectNative`（§5.1 R7）。
- 清单测试：e2e 清单（`manifest.e2e.json`）把 `nativeMessaging` 列为必需权限（与现在的剪贴板权限一样，因为测试点不了授权气泡）；"只能是可选"的规则只检查生产 `dist/`；单元测试断言 `manifest.base.json` 里它只在 `optional_permissions`。`test/e2e/smoke.spec.ts:53` 现在精确断言 `m.permissions`（可选权限不影响它），再加一条对 `optional_permissions` 的精确断言。
- 构建常量：`HELPER_KILL_SWITCH`（D22）像 `STORE_ID` 一样只写在 `scripts/` 里的一个常量文件里，check-dist 打印它的值，发布清单里人工确认；助手的调试端口检查（D24）由助手的发布 CI 断言为开启。

### 4.5 威胁模型增补（接在 SYNC-DESIGN §1.2 之后）

| 攻击者 | 能拿到什么 | 我们保证什么 | 残余风险（如实） |
|---|---|---|---|
| **A11 能在 Sixkey 页面里执行代码的东西，本机装了助手、插着钥匙**（就是 A10：CDP、驱动浏览器的代理、厂商本地 API；包括**局域网上**连调试端口的机器） | 若这个配置文件**曾经**授权过 `nativeMessaging`：不经提示把权限拿回来（软移除，§4.1），然后自己 `connectNative`，**不管 Sixkey 是否锁定、不管预设是什么** | 父浏览器以调试端口/管道启动时，助手拒绝服务（D24，启发式）；经过真助手拿不到当前与下一个时间步以外的 TOTP 码（助手时钟、周期只来自名字）；拿不到任何 HOTP 码（D21）；不能重置、删除、覆盖、改名钥匙上的任何凭据，不能设或改应用密码，不能发任意 APDU（白名单）；需要触碰的凭据要真人触碰；设了应用密码的钥匙在 Sixkey 锁定时打不开（"记住"的访问密钥在 VK 加密的记录里）；搭不上别的进程的已验证会话（每个操作从 SELECT 开始）；拿不到种子（钥匙里读不出来） | D24 没挡住时（运行时开启的调试、改名的开关、操作系统层面的代理）：**能读到所有不需触碰、没设应用密码的 TOTP 凭据的当前码**（任意多次）；能让钥匙闪灯等人触碰——**触碰不告诉你是哪个程序要的**：它可以挑用户正要为某个网站的安全密钥提示触碰的那一刻发 `code`，一次触碰是否会同时完成两边、完成哪一边 [未核实]（YR-17）；Sixkey 解锁时还能读到"记住"的访问密钥。对本机进程来说这不是新能力（它们本来就能用 PC/SC）；**新的是局域网上的 CDP 客户端也能够到钥匙**。缓解：**这台电脑不装助手**（卸载是唯一的硬开关）、钥匙不常插、重要账户开"需要触碰"或设应用密码；预设只移除权限、只防误用（§5.4） |
| **A12 同用户的本机进程** | PC/SC 本身；能直接运行助手；能在用户级位置放一个同名文件遮蔽助手 | 扩展从不把种子、VK、主密码、恢复密钥、访问密钥发给助手 | 与"恶意软件以用户身份运行"同级（docs/security/local-vault.md 已说不防）。遮蔽者能看到一对 VALIDATE 挑战/应答（离线猜弱的应用密码）、能喂假码。用户级位置上的**任何**同名文件（哪怕无效）都会让 Chrome 报"找不到"或"禁止"、不回落——拒绝服务；A10 也许能用 CDP 的下载路径设置把这样一个文件放进去 [推断，YR-27]。在设了密码的钥匙上**等触碰期间**关掉页面，助手可能来不及重新 SELECT 就被强杀，应用保持已验证，别的 PC/SC 客户端能借用这个会话（不知道密码也能 CALCULATE、PUT、DELETE），直到别的程序选择应用或拔出钥匙（§3.3） |
| **A13 被篡改的助手版本**（供应链） | 每次打开 Sixkey 弹窗都以用户身份运行任意代码 | 不自动更新；签名、可复现构建、公开哈希；扩展的更新改变不了助手；**停用开关**随扩展更新送达，让 Sixkey 不再启动它（D22，§3.10b） | **它就是以用户身份运行的恶意程序**：能读配置文件、记录按键等。这是 A 带来的最大新风险。停用开关只能阻止 Sixkey 启动它，不能把它从磁盘上删掉；撤销证书对已安装的二进制效果有限 |
| **A14 被同步过来的用户数据目录里夹带的宿主清单**（macOS/Linux，指纹浏览器） | 遮蔽系统级助手 | 安装器从不往配置文件目录里写东西；共享/厂商同步的配置文件不建议开 A | 要求厂商同步的是用户数据目录这一层（`NativeMessagingHosts` 在 `Default/` 旁边，不在里面）、接收方机器上有清单指向的可执行文件 [推断]，所以可能性较低（YR-22）；企业策略可禁用户级宿主 |
| **A15 恶意网页 / 其他商店扩展** | — | 网页够不到原生消息；其他扩展的 ID 不在 `allowed_origins` 里；别的扩展的 `chrome.debugger` 附加不到 Sixkey 的页面（评审读了 `debugger_api.cc` [转录]）；RP ID 是 Sixkey 的 origin，浏览器里别的扩展与网页都不能对它发起断言（W1） | — |
| **A16 拿到配置文件副本（A3）+ PRF** | `sk_prf`（凭据 ID、salt、包裹） | 没有认证器解不开；要求 UV：没有 PIN 时钥匙给出的是"无 UV"的那个值，KEK 不对 | 副本 + 钥匙 + PIN = 能解锁那份副本（与副本 + 主密码同级）；也可以不经浏览器，用 libfido2 或 `webauthn.dll` 拿着 RP 字符串、凭据 ID、salt、PIN 与一次触碰取一次 PRF 输出，之后对每份更新的副本离线解开，**直到 VK 轮换**（改密码不够；YR-30、YR-8）。手机或同步的通行密钥在注册时就被拒绝（D25），所以"副本 + 云账户"不成立 |
| **A17 解锁期间的 A10 登记自己的认证器** | CDP 的 WebAuthn 域可以在注册时换上虚拟认证器（`hasPrf` 等选项，CDP 协议 [复核]） | 注册前要重新输入主密码（A10 也读得到）；安全记录写 `prf_enrolled`；设置页与改密码界面列出全部已登记的认证器与时间 | 这是一个持久后门：之后拿到的配置文件副本可以不用密码打开。**正确的上界是"已经知道 VK"**（YR-7）：解锁期间的 A10 本来就读到了 VK；VK 和这个后门一样挺得过改密码，只有"轮换密钥"同时让两者失效（轮换会把所有 PRF 包裹置空，§1.2.5）。所以改密码界面要说"改密码不会移除已登记的安全密钥，要赶走见过解锁库的人请轮换密钥" |
| **A18 "记住"的应用密码 + 配置文件副本**（A3） | `sk_oath` 的密文 | 没有主密码打不开（VK 加密，AAD 绑定 vaultId 与 vkId） | 副本 + 主密码 → 访问密钥；再加实体钥匙 → 能读取并改写设了密码的那些账户（YR-19）。默认不勾"记住" |
| **A19 能应答 OATH AID 的伪造卡**（NFC 读卡器上的可编程卡） | 自称任何盐（deviceId 提示）、名字与码 | 显示读卡器名、标出非 YubiKey 读卡器；不凭提示悄悄优先；名字当不可信文本；添加由用户确认 | 用户若在添加流程里确认了，伪造的名字会写进（同步的）保险库——只是名字，不含任何秘密（YR-18） |

### 4.6 docs/security/local-vault.md 要加的残余风险（英文草稿，实现时由文档负责人定稿）

> **YubiKey codes (optional).** Turning this on grants Sixkey the optional `nativeMessaging` permission and requires a separately installed helper program. The helper talks only to the YubiKey's OATH application through the operating system's smart-card service. It has no network code and keeps no logs or files. It can only list accounts and compute TOTP codes for the current or the next time step; it computes no HOTP codes, cannot reset, delete, overwrite or rename anything on the key, and never receives your vault key, master password, recovery key or the key's OATH password. It refuses to work when the browser was started with remote debugging turned on. What this changes:
> * Anything that can run code in Sixkey's pages (a process attached to the debugging port, an agent driving the browser, including from another machine on the network if the port is exposed) can read the current codes of accounts on an inserted YubiKey that do not require touch and are not behind the key's password, **even while Sixkey is locked**, unless the helper's remote-debugging check stops it. That check only sees debugging turned on when the browser starts; debugging turned on later, renamed switches in other browsers, and programs that control the whole computer get past it. Accounts that require touch still need a physical touch, but a touch does not tell you which program asked for it.
> * **The "shared / automated" mode does not turn this off for such a program.** It removes the permission, but a program that controls the browser can take it back without any prompt if it was ever granted in this profile. What actually protects you: do not install the helper on a computer whose browser profiles are shared, synced by an antidetect-browser vendor or controlled by scripts or agents (uninstalling the helper is the only switch that works for every profile on the computer); do not leave the YubiKey plugged in; and turn on touch, or set an OATH password, for important accounts in Yubico Authenticator.
> * Sixkey cannot check which program the browser started. Any program running as you can put a file for a helper of the same name in your browser's folder, which the browser prefers over the system-wide one. Such a program could stop the helper from working, show wrong codes, or see one challenge and response of the key's OATH password; it gets nothing from your vault. This is the same class of risk as malware running as you, which Sixkey does not protect against.
> * The helper is a second program from us that runs as you whenever a Sixkey page that shows YubiKey accounts is open. A tampered release would be malware. Releases are signed, reproducible, and never update themselves; check the published hashes (`sixkey-oath-host --version` shows yours). If a release is ever found to be bad, an update of the extension stops Sixkey from starting it and tells you how to uninstall it.
> * If you let Sixkey remember the key's OATH password, anyone with a copy of this browser profile and your master password also gets it.
> * The secrets of YubiKey accounts stay on the key. Sixkey's backups contain only their names. If the key is lost, broken or reset, Sixkey cannot recover those accounts.
>
> **Unlocking with a security key (optional).** A security key can replace typing the master password when unlocking this browser profile. It never replaces the master password or the recovery key, which are still needed for export, password changes, key rotation and on other computers, and Sixkey reminds you to type the password at least every 14 days. Only security keys plugged into the computer are accepted, not phones or synced passkeys. A copy of the profile cannot be unlocked with the security key's data alone; it also needs the key and its PIN. Changing the master password does not remove registered security keys; rotating the key does. While Sixkey is unlocked, a process attached to the debugging port could register its own authenticator; Settings lists every registered key with the date it was added. Removing a lost key does not erase old copies from the disk at once: if its PIN may be known, rotate the key too.

---

## 5. 与其他承诺和既有设计的关系

### 5.1 SYNC-DESIGN 与 M2：现在要预留什么

**不需要的**：envelope 格式、KeyBundle 格式、服务器表与 API、契约与向量、M2–M8 的内容与顺序，都不用改。A 的数据在加密载荷里（服务器看不到），C 的数据完全在本机。

**M2 现在就要做（都很小）**：

| # | 预留 | 为什么 | 验收 |
|---|---|---|---|
| R1 | `openVault` 的回退循环（M2 的 previous-VK 回退与 §0.0i 第 8 条是**同一个**循环）与 `applyRemote` 保住现有规则：`newer_schema` **停下并抛出**，不算"损坏"、不回退到旧副本、不写恢复事件（`store.ts:773/803/813` 现在就是这样，评审核实） | A 一旦让某些库变成 v2，旧代码路径若把 `newer_schema` 当损坏，会回退到旧快照 = 丢数据 | 故障测试：活动槽放一份合成的 `schemaVersion: 2` 世代 → 抛 `newer_schema`，没有任何写入与恢复事件；`applyRemote` 同样；previous-VK 回退下同样 |
| R2 | **（加强）** M2 只经 `emptyVault` / `parseVault` / `mergeVaults` / `ops.ts` 的操作构造 `Vault` 对象；**从不**用对象字面量，也不把一个库展开成新的带 `schemaVersion` 的对象 | 版本将由 `serializeVault` 按内容计算（§2.2，YR-25）；手写的 v1 一旦遇到钥匙条目，就过不了 `mutate` 的往返检查 | grep 测试：`schemaVersion:` 字面量只在 `model.ts`、`merge.ts`、`validate.ts` 与测试里 |
| R3 | M2/M3 里按 `secret` 判断条目身份的地方走具名函数（`entryIdentity(e)`、`isPurged(e)`），不直接比较 `e.secret`：§4.4 守卫（`secretChanged`）、A4R-12 的跨 vaultId 永久删除（§0.0i 第 13 条）、§3.5 入网的 added 模式去重、§4.6 "找回账户" | 钥匙条目没有 secret，A 要在一处插入"按 `ref.name` 认"。M2 之外已有同样的需要：`service.ts:834` `importBackup`（§2.11，YR-13） | 代码评审项；grep 测试 |
| R4 | **（已满足，保留测试）** KeyBundle 的"`wraps` 恰好 `{password, recovery}`"：`keybundle.ts:56` 已经拒绝其他组合 | PRF 包裹放 `sk_prf`（D12），keyring 逐字节稳定（A4R-11）不受影响 | 单元测试：含 `webauthn-prf` 包裹的 bundle 被拒绝。可选、不阻塞 M2：从本地 `METHODS` 删掉 `webauthn-prf`（YR-24，随 Y3） |
| R5 | 保留本机键名 `sk_prf`、`sk_oath`（不放在 `sk_sync_*` 下）；它们**不是** `hasAnyData()` 意义上的保险库数据（`store.ts:303`）；"关闭同步 / 移除同步身份"（D11）不碰它们；`ServiceDeps.vkRecords` 保持开放列表（现在就是），A4R-4 的交错测试工具可复用于第三、第四个记录 | C 与 A 各加一个 `VkRecord` | 命名约定；`hasAnyData` 的白名单不加这两个键 |
| R6 | **（扩展）** M3：`paused_newer` 用合成的 v2 远端做引擎测试；**F6a 回溯里**遇到 `newer_schema` 的版本也停下、置 `paused_newer`——引擎**绝不**跳过它去合并一个更旧的 v1 版本、再以 `if_version = 头版本` 上传覆盖头版本（SYNC-DESIGN §4.3 的表把 `newer_schema` 从回溯里排除了，测试要证明代码也是这样） | 否则一个没更新的客户端会用旧 v1 内容盖掉较新的 v2 头版本（服务器历史里还在，但客户端会把它当作过时） | 引擎测试：远端头版本 v2 → `paused_newer`，不上传、outbox 保留、本地不变；头版本损坏、上一版是 v2 → 同样停下，不继续往更旧的 v1 回溯 |
| R7 | M5 改写 `check-dist` 时，`OPTIONAL_ALLOWED` 仍是单独的列表；"只有 `sw.js` 能 `fetch`"不要推广到禁止页面里的 `connectNative` | A 的端口在页面里（§4.2） | 评审项 |
| R8 | 安全记录**只升一次版本**：M2 要加的种类与 `prf_enrolled`、`prf_removed`、`prf_failed`、`oath_on`、`oath_off` 一起进 v2。C7（安全记录界面）正在做；v1 的读者遇到 v2 记录会当作 `"newer"`、不再追加（`security-log.ts:147` [复核]），所以连升两次会让中间版本的客户端停记两次 | 避免连升两次 | `security-log.test.ts`：v2 记录被 v1 读者看作 newer，且一次升版覆盖全部新种类 |
| R9 | **（新增，只改文档）** SYNC-DESIGN §3.13 / I11 仍写"`Vault.schemaVersion` 仍为 1"：同步设计负责人现在就改成"按内容派生（YUBIKEY-DESIGN §2.2）；新增字段仍要升版本" | 免得 M2 的代码围绕一个存下来的常量来写 | 文档 |

> 2026-10-29（预算整理 3，`docs/design/notes/BUDGET3-NOTES.md` §3.2）：R8 预留的 `oath_on`、`oath_off` 已从种类表里去掉。SYNC-DESIGN 修订 25 之后，每个版本改写记录时都保留不认识的种类，新种类既不需要升版本，也不需要预留；这两个种类从没有代码记过。做本功能时，连同种类和标签一起加进 `extension/src/core/service/security-kinds.ts`。

**同步引擎不需要做的**：不需要认识钥匙条目；它只要正确对待 `newer_schema`。等 A 的数据模型合入后，同步自然携带引用。

**SYNC-DESIGN §13 要改的文字**（由同步设计负责人改）："用系统钥匙串或 native messaging 保存设备密钥"这一行**保持不做**；另加一行说明：所有者 2026-10-16 为 YubiKey OATH 读码这一个可选功能接受了可选 `nativeMessaging` 与单独安装的助手；它不用于保存任何密钥、不用于代理或 MCP、不提供写入。§1.2 增加 A11–A17（或引用本文 §4.5）。

### 5.2 PRIVACY.md 要改的（英文草稿）

现在的第一句"Sixkey does not collect, send, or share anything. It makes no network requests."对扩展仍然成立，对助手也成立。增加一节：

> **Optional YubiKey helper.** If you turn on "YubiKey codes", Sixkey asks for the optional permission to "communicate with cooperating native applications" and you install a small helper program. When a Sixkey page that shows YubiKey accounts is open, the browser starts the helper; it reads the account names and current codes from your YubiKey and stops when the page closes. The helper makes no network requests, writes no files or logs, and keeps nothing after it stops. Sixkey stores, encrypted in your vault, the names of the YubiKey accounts you add and an identifier of each key they were seen on (derived from a value the key reports; it is not the serial number). If sync is on, these travel end-to-end encrypted like your other accounts. Sixkey never checks for helper updates; you download new versions yourself. The helper is signed, so your operating system may check its signature online when you install it or first run it (Apple's notarization and revocation checks, Microsoft SmartScreen); those checks are made by the operating system, not by Sixkey. On macOS the system also creates an empty sandbox folder for the helper.
>
> **Unlocking with a security key.** The data needed to unlock with a security key (an identifier of the credential, a random value and the encrypted vault key) stays in this browser profile and is never synced or included in backups. Sixkey asks the key for no personal information and uses no attestation.

### 5.3 FINGERPRINT-BROWSERS.md 与 A10

要改的（由 H8 文档负责人改）：

- §7《AI 代理与自动化》里"no MCP server, no local server, no network access, and it does not listen to messages from other extensions"仍然成立；补一段（YR-1，不能写成"模式会关掉它"）："The optional YubiKey helper is not an interface for agents: the browser starts it for Sixkey's own pages only. But an agent or script that controls a profile can use it to read codes from an inserted YubiKey, and switching Sixkey to the 'shared / automated' mode does not stop that: the agent can turn the permission back on without a prompt. The helper refuses to work when the browser was started with a remote-debugging port, which is how most automation tools and vendor APIs connect, but it cannot detect every way of controlling a browser. The helper serves every profile on the computer. So on a computer that runs agent- or script-controlled profiles, do not install the helper at all, and keep YubiKey accounts behind touch."
- §4（共享与脚本控制的配置文件）：共享/自动化模式下 Sixkey 不读取 YubiKey 码，但这只防误用；授权记录跟着配置文件走，复制或克隆一个开启过 A 的配置文件，副本也带着授权 [推断]。配置文件被厂商同步或复制时，Sixkey 里的引用跟着走，助手不跟着走（它装在电脑上）。
- §2（安装）：指纹浏览器在 macOS/Linux 上只认系统级安装；Windows 上 Chromium 品牌的浏览器会回落到 Chrome 的注册表键；由自动化接口以调试端口启动的配置文件里助手会拒绝工作（D24）；具体浏览器能否找到助手，以 §6.3 的人工检查表结果为准（发布前补上逐个浏览器的结果）。
- 新增（YR-22）："浏览器的用户数据文件夹里（与 `Default` 文件夹并列，不在它里面）出现 `NativeMessagingHosts/app.sixkey.oath.json` 时，删掉它：它会挡住 YubiKey 助手"（A12、A14）。

### 5.4 安全预设

**先说清楚预设能做什么、不能做什么**（YR-1）。预设的对象是 A10，而 A10 就在 Sixkey 的 origin 里执行代码：扩展侧的任何检查它都能绕过（直接调用 `connectNative`），被移除的权限它能不经提示拿回来（§4.1）。所以预设对 A **只是防误用和说实话**，不是安全控制。真正的控制按强弱：
1. **这台电脑上不装助手**（卸载是唯一对本机所有配置文件都有效的开关）；
2. 钥匙不用时拔下；
3. 重要账户在 Yubico Authenticator 里开"需要触碰"或给钥匙设应用密码；
4. D24：助手在父浏览器带调试端口启动时拒绝服务（在扩展之外执行，但只是启发式）。

预设实际做的：
- 应用共享预设时（首次运行回答"会被共享/同步/脚本控制"，或之后在设置里选它）：若 A 已开启，显示 §1.1.1 那段实话与卸载步骤的链接，确认后 `permissions.remove`；安全记录写 `oath_off`。
- 预设是"共享"时：设置 › YubiKey 不提供开启（§1.1.1）；YubiKey 模块不连接（§1.1.6、§4.3）——**只防误用**；要开启必须先切换到"标准"或"自定义"。首次运行答了"共享/自动化"的配置文件，界面上也不主动推荐 A。
- SW 的 `permissions.onAdded` 监听在权限被加回来时写 `oath_on`（§4.1）：一条事后痕迹，能在 SW 里执行代码的攻击者可以压掉它。
- `detectPreset` 现在只看自动锁定、锁屏即锁、隐藏验证码（`presets.ts`）；权限不在 `Settings` 里。实现：预设检测额外接收"`nativeMessaging` 是否已授权"，授权了就不可能是"共享"。
- C（PRF 解锁）在两个预设下都可用：它不增加 A10 的能力（解锁期间 A10 本来就有 VK；锁定时它要真人触碰加 PIN）。

### 5.5 H4 安装来源横幅

助手的 `allowed_origins` 只有商店 ID。从 zip、`.crx` 或解压目录装的副本 ID 不同 → `host_forbidden`。YubiKey 面板此时显示："这份 Sixkey 不是从 Chrome 应用商店安装的，YubiKey 助手不会响应它"，并复用 H4 横幅已有的"显示两个 ID"。`STORE_ID` 为空时（商店提交之前）A 整个不可用，开发构建用开发 ID（§3.6）。

### 5.6 体验调研的约束：弹窗里不放选择器与授权

| 步骤 | 有浏览器对话框吗 | 放在哪 |
|---|---|---|
| 申请 `nativeMessaging` | 有（权限气泡） | 设置页标签 |
| A 的日常使用（列表、触碰、应用密码） | 没有（触碰是物理动作，密码是我们自己的输入框） | 弹窗可以 |
| A 的"从 YubiKey 添加" | 没有 | 弹窗或设置页 |
| C 的注册 | 有（WebAuthn、可能还有设 PIN） | 设置页标签 |
| C 的解锁 | 有（WebAuthn） | `chrome.windows.create` 的小窗口；工具栏弹窗只放一个打开窗口的按钮 |

理由要说准（YR-29）：Chrome 156 的提交在**别的**安全对话框出现时强关工具栏弹窗，但跳过从弹窗自己派生的对话框（"Don't close if a web modal dialog (e.g. webauthn security key dialog) is showing"）；M127 起有安全对话框时弹窗打不开；M142 起弹窗自己的 WebAuthn 模态框显示为桌面小部件（评审读了提交 4b8e494ea3 等 [转录]）。所以在 macOS/Linux 上，从弹窗里调用 WebAuthn 也许**不会**关掉弹窗。小窗口仍然是对的：Windows 上安全密钥界面是系统对话框，不是 Chrome 的小部件，弹窗大概会失焦关闭 [推断]；PIN 输入、最长 60 秒的等待、别的安全对话框在 M156 的行为，都需要一个稳定的界面。G1 里**测量**这一点，但无论结果如何都用小窗口——"弹窗没被关掉"不能被当作把 WebAuthn 搬进弹窗的理由。

### 5.7 与产品承诺的冲突（逐条）

| 承诺 | 冲突吗 | 说明与处理 |
|---|---|---|
| "只是一个扩展"（§13） | **冲突**（所有者已接受） | 只为 A；可选；功能关闭时 Sixkey 仍只是一个扩展。§13 加一行说明（§5.1） |
| 最小权限 | **部分冲突** | 新增一个带警告的**可选**权限；必需权限不变；没有 host 权限、没有内容脚本；C 不加任何权限 |
| 零网络（PRIVACY："No network requests of any kind"） | 不冲突，但**保证方式变了** | 扩展仍被 CSP 强制；助手不联网由源码规则、依赖白名单、二进制导入检查、Linux seccomp、macOS 沙箱保证，**浏览器不替我们强制**。docs/security/local-vault.md 要如实写 |
| 零追踪 | 不冲突 | 不回连更新；下载页无分析、不记 IP |
| 永不丢数据 | **结构性缺口**（硬件的性质） | 钥匙里的种子不能被 Sixkey 备份；用强制确认、处处标注、Sixkey 从不删钥匙上的东西来处理（§2.6）。C 不涉及数据，PRF 包裹丢了只是少一种解锁方式 |
| 无远程代码 | 不冲突 | 助手是本机代码，不下载、不加载插件、不自动更新；但它是**我们发布的第二个可执行程序**（A13），在信任上等同于扩展本身 |
| 密钥与码不离开机器 | 不冲突 | 钥匙里的密钥不离开钥匙；码只经过 stdio 在本机传递 |
| 不向 AI 代理提供码（§13） | 不冲突，但有**残余** | 助手不是代理通道；但被代理驱动的配置文件里，代理可以借它读钥匙的码（A11），预设挡不住（软移除）。处理：D24 的调试端口检查、"有代理驱动的配置文件的电脑上不装助手"的文档；任何能运行程序的本机代理本来就能用 ykman |
| 安全模式（预设）的说法 | **曾经冲突，已改**（YR-1） | 预设对 A 只防误用；所有界面文字、SECURITY、FINGERPRINT-BROWSERS 都不得写"共享模式关闭了 YubiKey 验证码"之类让人以为安全了的话 |
| "只读取当前码" | **曾经不准，已改**（YR-2、YR-9） | 只对经过真助手的 TOTP 成立；HOTP 第一版不计算；直接用 PC/SC 的本机进程不受此限 |
| H1 主密码必需 | 不冲突 | C 只是附加方式；A 的条目同样需要解锁 |
| "设置页之外不申请权限" | 不冲突 | §5.6 |
| 弹窗 <100 ms | 不冲突 | 钥匙条目异步出现，不进首屏路径 |
| "Sixkey 不监听其他扩展" | 不冲突 | 原生消息是 Sixkey 发起的出站连接；不声明 `externally_connectable` |

---

## 6. 测试

### 6.1 助手（不需要硬件）

- **协议单元测试**：TLV 编解码、`61xx` 链、截断码（位数字节 + 4 字节）的解释、名字里的周期前缀解析、挑战计算（8 字节大端时间步，含 `step`）、VALIDATE 数据的组装（助手只拼装，不计算 HMAC）。测试向量**我们自己生成**：用 RFC 4226/6238 的公开测试种子（如 `12345678901234567890`）在模拟应用里建凭据，按 RFC 的时间点算出期望码；不从任何 GPL 代码复制向量，也不复制规范页的文字。
- **模拟 OATH 应用**（测试专用的 Rust 结构）：按规范实现 SELECT、LIST、CALCULATE、CALCULATE ALL、VALIDATE、SEND REMAINING，支持触碰标志（返回 `0x7C`）、HOTP（`0x77`）、应用密码（挑战/应答）、32/64 个凭据、SHA1/256/512、6/8 位、非 30 秒周期。它**也实现** PUT、RESET 等——只为断言"助手从不发这些指令"。
- **敌意卡模式**：畸形 TLV、长度超界、无尽的 `61xx`、错误的 SW、对 VALIDATE 给错误的反向应答、在操作中途"拔卡"、自称任意盐与名字的"伪造卡"（YR-18）。
- **白名单测试**（YR-11）：经**记录 APDU 的模拟传输层**跑完全部操作与敌意输入，断言每一条都通过 §3.2 的结构化检查，记录里没有 `01–05`；另有测试直接调用发送函数构造越界 APDU，断言它拒绝发送。
- **状态字表**（YR-3）：§3.3 表里每一行一个测试，包括"需触碰的 CALCULATE 在 2 秒后回 `6982` → `touch_timeout`、不重试"与"不到 2 秒 → 鉴权规则"。
- **事务模型**（YR-4）：模拟应用在 SELECT 时清验证状态；测试"别的客户端在两个操作之间 SELECT"不会产生 `wrong_password`；"做过 VALIDATE 的事务以 SELECT 结束"；`auth` 2 秒超时；`SCARD_E_SHARING_VIOLATION` → `busy_other_app`。
- **周期**（YR-10）：每种名字形式（无前缀、`60/`、`0/`、`030/`、`86401/`、超长）的挑战值或 `p: null`；请求里出现 `p`/`t`/挑战字段 → `bad_request`。
- **HOTP**（D21）：`code` 对 HOTP 凭据回 `unsupported`，传输层记录里没有任何 CALCULATE。
- **退出**（YR-26）：stdin EOF 时空闲 → 立即退出；APDU 进行中 → 返回后再 SELECT 并退出；都在 2 秒内。
- **调试端口检查**（D24）：在三个平台上用带与不带 `--remote-debugging-port`/`--remote-debugging-pipe` 的父进程启动助手；Windows 上再经 `cmd.exe` 启动一次。
- **模糊测试**：`cargo-fuzz`（libFuzzer），两个目标：(1) 消息解析（原始字节流：长度前缀 + JSON）；(2) **卡侧应答解析**（TLV、`61xx` 链、截断码、`0x7B`，YR-11）。CI 每次各跑 60 秒冒烟，发布前各跑 1 小时；目标：不崩溃、不超时、不超内存、错误回复不含输入回显。
- **零网络**：§3.4 的导入表检查；Linux 上在 seccomp 下跑一遍测试，并有一条测试故意 `socket(AF_INET)` 期望被拒绝。
- **ykman 作对照**（只在有硬件的手工检查里）：同一把钥匙、同一时间窗，比较 `ykman oath accounts code` 与助手的输出；比较 `ykman oath info` 的 device ID 与我们算的 deviceId（只差编码）。不链接、不复制 ykman。

### 6.2 扩展（不需要硬件）

- **单元**：数据模型（v1/v2 解析、派生版本、清除变回 v1、合并的交换律/结合律/幂等，用 fast-check 混合两种条目）、校验上限、导出规则、去重、`sk_oath` 与 `sk_prf` 两个 `VkRecord` 与两次轮换交错（复用 `gm2-fixes.test.ts` 的 A4R-4 测试方式）、助手应答的严格校验（畸形、超长、类型错误、未知字段）、`lastError` 文字到状态的映射、PBKDF2-SHA1/HMAC 的双向验证（用模拟应用的已知值）。
- **e2e：假助手**。Playwright 的 `launchPersistentContext(userDataDir)` 给了用户数据目录，而 macOS/Linux 的用户级清单位置就是 `<userDataDir>/NativeMessagingHosts/`（源码 main [复核]），且 Chrome 每次连接时才查找清单（`LaunchInBackground` 里的 `FindManifest`）。所以：启动 → 从 SW 的 URL 得到扩展 ID（`harness.ts` 已经这样做）→ 写 `<userDataDir>/NativeMessagingHosts/app.sixkey.oath.json`，`allowed_origins` 用这个 ID，`path` 指向一个生成的可执行包装脚本（`#!/bin/sh` + `exec <node 绝对路径> fake-host.mjs "$@"`）→ 测试。Windows 上要写 HKCU 注册表，在测试前置里 `reg add`：Playwright 捆绑的是 Chrome for Testing（156.0.8078.4，缓存 `chromium-1248`，体验调研附录 A [复核]），它也是 Chromium 品牌，先读 `SOFTWARE\Chromium`、再读 `SOFTWARE\Google\Chrome`（评审 N7 [转录]），写后者两者都覆盖。
- **假助手**由脚本驱动：按"转录文件"回放（与 `contract/` 里共享向量同一思路），这些转录同时被助手仓库的测试校验，保证两边对协议的理解一致。场景：没装助手（不写清单）、`forbidden`（清单 ID 不对）、用户级位置上有一个无效的同名文件（YR-27）、助手崩溃、钥匙插拔事件、应用密码（`auth` 事件与 `kr` 核对，核对失败不显示码）、触碰等待与超时（不自动重试）、HOTP 回 `unsupported`、`debugging_enabled`、`busy_other_app`、64 个凭据、畸形应答。另有：共享预设下模块不连接；`permissions.onAdded` 写 `oath_on`；停用开关（D22）开启时从不调用 `connectNative`。
- **e2e：C**。用 CDP 的 WebAuthn 域：`WebAuthn.enable` + `addVirtualAuthenticator({protocol: "ctap2", transport: "usb", hasUserVerification: true, isUserVerified: true, hasPrf: true, hasHmacSecret: true})`（选项都在 CDP 协议里 [复核]；`hasHmacSecret`/`hasHmacSecretMc` 要 Chrome 148+，Playwright 的 Chrome for Testing 156 有，评审 [转录]），在设置页和小窗口里跑注册、解锁、取消、换 VK 后的"重新启用"、移除、14 天提醒（注入时钟；包括直接打开 `?mode=window` 也被服务层拒绝）。**拒绝同步型通行密钥**（YR-6）：用 `defaultBackupEligibility: true` 建虚拟认证器、以及 `transport: "hybrid"` / `"internal"` 的，注册后断言什么都没存。`hasPrf` 模拟的是 CTAP 的 "prf" 扩展，覆盖不到 UV/无 UV 的输出差别（评审 [转录]），那一点只能在真钥匙上测。同一机制也演示 A17：说明为什么注册前要验证密码、为什么要列出认证器。
- **源码规则测试**（`test/unit/source-rules.test.ts` 已有这类）：`connectNative`、`navigator.credentials` 只在规定模块；SW 不导入它们。
- **网络回归**（`network.spec.ts`）不变，并在开启 A 的状态下再跑一遍。

### 6.3 有硬件的手工检查表

| 型号 | OATH | FIDO2/PRF | 要测什么 |
|---|---|---|---|
| YubiKey 5 NFC（USB-A，固件 5.7） | 有（64 个） | 有 | A 全部场景；C；同时经 NFC 读卡器读 |
| YubiKey 5C / 5C Nano | 有 | 有 | 同上；macOS 与 Windows |
| 固件 5.8 的任一把（若能买到） | 有 | 有（hmac-secret-mc） | C 的注册触碰次数 |
| 固件 5.2–5.6 的任一把 | 有（32 个） | 有 | 32 个上限；C 的两次触碰 |
| YubiKey Bio | 无（FIDO 版） | 有（指纹 UV） | A 报 `no_oath`；C 用指纹 |
| Security Key（蓝色） | 无 | 有 FIDO2；MDS3 列有 hmac-secret（评审 [转录]） | A 报 `no_oath`；C 的特性检测 |
| YubiKey 4（若有） | 有 | 无 | A 可用；C 不出现；固件 4.2.0–4.2.6 的触碰凭据不支持（§3.2） |

每把在 Windows 11、macOS（当前版本）、Ubuntu LTS（Google Chrome 的 `.deb`，不是 snap 版 Chromium）上：普通 TOTP、需触碰 TOTP（含不触碰等到超时：显示 `touch_timeout`、不重试、钥匙不再闪）、60 秒周期、8 位、SHA256/512（SHA512 要固件 4.3.1+）、HOTP 显示"不支持"且计数器没有前进（用 Yubico Authenticator 核对）、应用密码（对/错/记住/锁定后不可用；验证后用第二个 PC/SC 客户端确认应用已回到未验证状态）、两把钥匙同时插、触碰等待中拔出、触碰等待中关掉页面（YR-26 的残余：之后另一个客户端能否不经密码 CALCULATE）、Yubico Authenticator 同时运行、gpg 的 scdaemon 运行（默认独占）、Windows 上插入时 CertPropSvc 的读取、Linux 上停掉 `pcscd`、用 `ykman config usb` 关掉 CCID 后的错误、弹窗与设置页同时打开、弹窗关闭后助手进程是否在 2 秒内消失、用 `--remote-debugging-port` 启动浏览器时助手拒绝服务、**网站的安全密钥提示与 OATH 触碰同时等待时一次触碰完成了哪一边**（YR-17）、助手安装/卸载、Chrome/Edge/Chromium/Chrome for Testing 与至少两个指纹浏览器（Windows 与 macOS 各一）能否找到助手。C 另测：Windows 上常驻与非常驻凭据的 PRF（YR-28）、第一次设 PIN 前的提示（YR-31）、手机通行密钥被拒绝（YR-6）、有无 PIN 时 PRF 输出不同。

### 6.4 CI 与预算

- 助手：GitHub Actions 三平台构建 + 单元 + 60 秒模糊冒烟 + 导入表检查 + Linux 可复现性比对。macOS 运行器在私有仓库按 10 倍分钟计费 [未核实当前价格]，所以 macOS 只在合并到主干与发布时跑。
- 签名只在发布时、在所有者控制的环境里做（证书私钥不进 CI 的普通密钥库）。
- 扩展：假助手 e2e 在现有 e2e 里，增加约 1 分钟 [估计]。
- 硬件：不进 CI。采购约 3–4 把钥匙（5C NFC、5 NFC、Security Key、Bio 可选），每把约 50–90 美元 [估计]。
- 年度费用：Apple Developer Program（99 美元/年）+ Windows 代码签名（OV 证书或云签名服务，几十到几百美元/年）[未核实当前价格]。

---

## 7. 分阶段计划

### 7.1 阶段

| # | 内容 | 规模 | 依赖 | 门槛 |
|---|---|---|---|---|
| Y0 | 把 §5.1 的 R1–R9 交给 M2/M3/M5 的负责人；SYNC-DESIGN §13 与 §3.13/I11 的文字由其负责人改 | 0.5 天（文档） | 无，**现在** | — |
| Y1 | C 的原型（调研 §5.2 的一天原型，按本文改：扩展 origin 作 RP ID、UV required、Windows 上**常驻与非常驻**两种凭据各试一次、以 `get()` 的结果为准、每把一个 salt、BE/传输方式/附着方式的拒绝、小窗口与弹窗的**测量**、`evalByCredential`、对话框里显示的请求方名字） | 1 天 + 1–2 天平台矩阵 | 无（开发清单里的探针页，不随发布） | **G1** |
| Y2 | A 的握手探针：Rust 助手骨架（`hello`、`keys`、`codes`，含事务内的 `auth`）+ 开发 `key` + 开发清单安装脚本 + 设置页探针（可选权限申请、`lastError` 文字、授权后 API 是否立刻可用、弹窗关闭后进程是否消失、首个码的耗时）+ macOS 沙箱与 Linux seccomp 能否与 PC/SC 共存 + 调试端口检查在三平台读得到父进程命令行 + 两个页面、Yubico Authenticator、scdaemon、Windows 插入时的并发 + 重新 SELECT 是否清掉验证 + 读卡器名规则 | 3–4 天 | 无 | **G2** |
| Y3 | C 实现：`core/crypto/prf.ts`、`sk_prf` 的 `VkRecord`、设置页注册/移除（含拒绝同步型凭据、PIN 提示、丢钥匙时的轮换选项）、小窗口解锁、服务层的 14 天提醒与预算调整、改密码界面列出安全密钥、从 `METHODS` 删 `webauthn-prf`、安全记录种类、文档 | **M**（约 2–3 周） | M2 合入（清理入口与 `vkRecords`）；与 M3–M6 并行 | G1 通过（含 YR-6、YR-28 两项） |
| Y4 | 助手 v1：完整协议（事务模型、状态字表、周期规则、调试端口检查、退出清理）、结构化白名单、模拟应用、敌意卡、两个模糊目标、零网络的各层、三平台安装器（MSI 两种架构、universal2 pkg 加公证、deb/rpm）、签名与公证、可复现构建、发布流程、§3.10b 的事故响应演练 | **L+**（约 5–6 周，留余量，YR-23） | G2 通过；独立目录或仓库 | **G3** |
| Y5a | A 的数据模型（解析、`serializeVault` 计算版本、合并、校验、"需要 YubiKey"显示、导出规则、§2.11 全部位置）——**没有新权限、没有助手** | S–M（约 1 周） | M2 合入；**不等 G2**（只有"从钥匙添加"的映射要真钥匙，YR-23）；**赶在第一次商店提交之前**（Q4） | — |
| Y5b | A 的界面与接线：设置面板（含如实的预设文字）、权限流程与 `onAdded` 记录、端口模块（锁定/隐藏时断开）、列表状态、添加流程（同名软件条目提示、多卡切换）、应用密码与 `sk_oath`、预设联动、停用开关、check-dist 规则、假助手 e2e | **M**（约 2–3 周） | Y5a；Y4 至少到协议冻结（YR-3、YR-4、YR-10 写进 §3.3 之后） | — |
| Y6 | 文档与发布：SECURITY、PRIVACY、FINGERPRINT-BROWSERS、帮助页（卸载、加固策略、"有自动化配置文件的电脑不要装助手"）、商店权限说明；A 的发布 | S | Phase 2 的商店 ID；G3 | **G4** |
| 持续 | 助手维护：操作系统更新、证书续期、新浏览器位置、依赖安全更新 | 每季度 S | — | — |

合计：C 约 M（2–3 周加原型）；A 约 L+ + M（**8–10 周**，评审认为原先的 5–7 周偏乐观，我同意），之后长期维护。

### 7.2 与同步里程碑和 Phase 0.x 的先后

- **Phase 0.x**：C7（安全记录界面，正在做）不受影响；A/C 以后要加的安全记录种类与 M2 要加的种类**一次**升到 v2（R8：v1 读者遇到 v2 会停止追加）。C8、D 收尾与本文无交集。Y1、Y2 是只在开发清单里的探针，可以和任何包并行。
- **M2**：Y0 的预留现在交给 M2；Y3、Y5a 等 M2 合入后开始（它们都要用 M2 的清理入口、`vkRecords` 与"只经 ops 构造库"的规则）。
- **M3–M6**：Y3 与之并行（改的是解锁路径与设置页，和同步界面不重叠，冲突时后合入的一方变基）。Y5a 最好在 M3 之后（引擎的 `paused_newer` 与 F6a 回溯的停止规则已经实现并测过，R6）。
- **M8 / Phase 2**：Y5a 进第一个商店版本；A 的发布（Y6）在商店 ID 之后。C 可以在 Phase 2 的任何版本里发布。
- 推荐的发布顺序：**C 先，A 后**。C 不需要新权限、不需要第二个程序，风险小，先给大多数 YubiKey 用户可用的东西。

### 7.3 原型顺序与 go/no-go

**G1（Y1 之后）**：
- GO：Windows 11 与 macOS 上，YubiKey 5（固件 ≥ 5.2）从扩展**标签页**与**小窗口**都能稳定取得同一 salt 的同一 PRF 输出，**以验证用 `get()` 返回 `results.first` 为准**；默认 RP ID（扩展 origin）在 Windows 的 `webauthn.dll` 路径与 Chromium 120 上都能用；Windows 上 `residentKey: "discouraged"` 与 `"required"` 各试一次，记录哪个能拿到 PRF（YR-28；只有 required 能用时，Windows 上改用它并接受占一个常驻位）；UV required 时能引导设 PIN；同步型/手机通行密钥被 BE 位、传输方式、附着方式拒绝（YR-6）；记录对话框里请求方显示成什么。**测量**工具栏弹窗里调用时弹窗是否被关，但无论结果如何都用小窗口（YR-29）。
- 部分 GO：扩展 origin 在某平台不行 → 改用 `sixkey.app` 作 RP ID（依赖 Phase 1 的 host 权限，C 推迟到 Phase 1 之后），salt 保密与 `allowCredentials` 成为硬要求。Windows 的 webauthn.dll 低于 API v4（get() 传不了 salt）→ 那些 Windows 上不提供 C。
- NO-GO：Windows 11 或 macOS 上取不到 PRF → C 只作为"检测到才出现"的选项，不宣传。

**G2（Y2 之后）**：
- GO：三平台握手与 `codes` 成功；弹窗关闭后助手进程在 2 秒内消失；首个钥匙码在弹窗打开后 ≤ 500 ms 出现 [目标值]；可选权限从设置页申请成功；Windows 上 Chrome、Edge 与至少一个 Chromium 品牌的指纹浏览器找到 HKLM 的注册；macOS 上 Chrome 找到系统级清单；设了密码的钥匙在"两个 Sixkey 页面 + Yubico Authenticator 同时开着"时不出现误报的"密码不对"、不互相打断（YR-4）；scdaemon 独占时显示 `busy_other_app`；验证过的事务结束后另一个 PC/SC 客户端看到应用是未验证的；调试端口检查在三平台都读得到父进程命令行。
- NO-GO 的信号：macOS 沙箱下 PC/SC 不可用（→ 去掉沙箱，零网络只靠其余各层，SECURITY 如实写）；指纹浏览器普遍找不到系统级清单（→ 在文档里列出不支持的浏览器，不为它们做用户级安装）；重新 SELECT 不清验证状态（→ 改为事务结束时以 `SCARD_RESET_CARD` 断开，并评估对其他程序的影响）；读不到父进程命令行（→ D24 只在读得到的平台上生效，SECURITY 如实写）。

**G3（Y4 发布候选）**：签名与公证通过；Linux 两次独立构建哈希一致；导入表检查通过；两个模糊目标各 1 小时无崩溃；§6.3 的检查表在至少两种型号 × 三平台通过；§3.10b 的事故响应演练过一次（开启停用开关的扩展构建能让弹窗不再启动助手，公告模板与 `--version` 可用）。

**G4（发布前）**：所有者审定 docs/security/local-vault.md 与 PRIVACY.md 的新段落和商店的权限说明。

### 7.4 要所有者决定的事（**全部已决**，2026-10-16，见 §0.00）

Q1–Q5 都按下表的建议采纳；D24 也已采纳。下表保留问题与理由，供以后查阅。

| # | 问题 | 建议（= 所有者决定） |
|---|---|---|
| Q1 | C 的 RP ID 用扩展自己的 origin（`chrome-extension://<id>`，不设 `rp.id`），而不是 PLAN Phase 3 写的 `sixkey.app`？ | **用扩展 origin**（§1.2.6），**不变**。评审确认浏览器里只有 Sixkey 能用它、Chrome 81 起扩展页面就能用 WebAuthn；代价是对话框大概只显示 "chrome-extension"，小窗口先告诉用户。G1（现在包括 Windows 常驻/非常驻凭据的比较）若发现平台不支持再退回 |
| Q2 | C 的第一版只支持插在电脑上的安全密钥（YubiKey 等），Touch ID、Windows Hello、手机与 Google 密码管理器的通行密钥以后再说？ | **是，不变；现在由代码强制**（D25：BE 位、传输方式、附着方式），不再只靠提示。**2026-10-19 所有者修订**：平台认证器由 `QUICK-UNLOCK.md` 接上——Windows Hello 可用；会同步的通行密钥跨重启解锁只作用户自选、默认关闭。平台认证器的 PRF 支持还在变，同步型通行密钥会让"副本 + 云账户"就能解锁 |
| Q3 | 助手用 Rust 写、源码公开（MIT 或 Apache-2.0）、只做系统级安装；并购买 Apple Developer ID 与 Windows 代码签名？ | **是，不变**，补充：Linux 用动态 glibc 构建（D23）；发布流程包括 §3.10b 的事故响应（停用开关随扩展更新）。不签名就过不了 Gatekeeper 与 SmartScreen；不公开源码，"可复现构建"对用户没有意义 |
| Q4 | 把 A 的数据模型（只会解析和显示"需要 YubiKey"，不加任何权限）放进第一个商店版本，即使助手晚些才发布？ | **是，并且不再等 G2**（YR-23）：解析、合并、校验不需要真钥匙。这样任何公开客户端都不会因为 v2 暂停同步，以后也不需要强制更新；也不会因为 G2 慢而拖住商店提交 |
| Q5 | A 第一版是否包含 HOTP？是否提供"在这台电脑上记住应用密码"（默认关）？ | **改变**：**第一版不包含 HOTP**（D21，YR-2）——一个 HOTP 码用掉之前一直有效，A10 能攒着用，而且无从知道它是否需要触碰；schema 照样接受 HOTP 钥匙条目，以后可按条目明确开启。"记住应用密码"**仍提供、默认关**，并在勾选框旁写明"拿到这个配置文件和你主密码的人也就拿到了它"（YR-19）：不提供，设了密码的用户每次打开弹窗都要输，等于逼他们不设密码 |

修订 1 新加的 **D24（父浏览器开着远程调试时助手拒绝服务）**：所有者 2026-10-16 **采纳为纵深防御**，对外按文中写明的局限说明。它让开发者和由自动化接口启动的指纹浏览器配置文件用不了 A——这与"不要在被脚本控制的配置文件里用 A"一致，也是对 YR-1 唯一在扩展之外执行的控制。

### 7.5 不做的（及原因）

| 不做 | 原因 |
|---|---|
| **B：把种子写进钥匙** | 二选一困境：种子同时留在 Sixkey 就失去硬件保管的意义，只留在钥匙里又违背"永不丢数据"；`PUT` 遇到同名凭据静默覆盖；种子要以明文经过助手；助手白名单必须放开写指令，A11/A13 就能破坏钥匙上的数据。从 A 里也"自然掉不出"一个安全子集：任何写入都需要 `PUT`。替代：帮助页写"添加账户时用 Yubico Authenticator 扫同一个二维码"（Sixkey → 钥匙单向可行，钥匙 → Sixkey 不可能） |
| 从扩展重置、删除、覆盖、改名钥匙上的凭据 | `RESET` 无需鉴权，一条指令清空钥匙；这些操作是 Yubico Authenticator 的事 |
| 任意 APDU 透传 | 等于把白名单拆掉 |
| 钥匙管理界面（设/改应用密码、开关 CCID/USB 接口、FIDO2 PIN 管理、读序列号） | 都需要白名单外的指令或别的应用；指向 Yubico Authenticator / ykman |
| 助手的自动更新、扩展联网查版本 | 零追踪；也让被篡改的版本无法自动扩散 |
| 用户级安装、AppImage、Flatpak/Snap 浏览器 | §3.7、§3.9 |
| 扩展与助手的配对 | 助手无持久状态；冒充者可以转发配对（§3.8） |
| 自动把钥匙上的所有凭据加进保险库 | 保险库写入由用户发起；助手数据不触发写入 |
| SW 里的后台轮询、角标显示钥匙状态 | 助手只在用户看着时运行 |
| OTP 应用的 HMAC-SHA1 挑战-应答槽位解锁 | 在 OTP/HID 通道上，扩展够不到（调研 §1.5）；PRF 就是浏览器里的等价物 |
| 用 PRF 代替主密码做敏感操作、用 PRF 重设密码 | `pw_auth` 由密码派生；会让人忘记密码 |
| PRF 包裹的同步（新设备用同一把钥匙直接解锁） | 要改 KeyBundle（§2.3 的包裹约束、未知字段规则）；每台设备登记一次就够了。将来要做时另写设计 |
| 证明（attestation）校验 | 要解析证书链、会弹隐私提示、排除非 Yubico 认证器；它防的 A17 并不比"解锁期间读到 VK"更糟 |
| 第一版计算钥匙上的 HOTP | D21：码可以被攒着以后用，触碰属性无从得知 |
| 声称共享/自动化预设"关闭"了 YubiKey 验证码 | YR-1：权限移除是软的；预设只防误用 |
| 版本黑名单、助手自更新作为事故响应 | §3.10b：Chrome 一连接就启动助手，看版本太晚；自更新违反零追踪 |
| 助手用于别的用途（保存设备密钥、MCP/代理交接、本机服务） | §13 原样适用；助手只做 OATH 读码 |

---

## 8. 自我攻击复查

### 8.1 本机助手通道

| # | 攻击 | 设计的回答 | 剩下的 |
|---|---|---|---|
| N1 | A10 在 Sixkey 页面里 `connectNative`，批量读码 | 父浏览器带调试端口启动时助手拒绝（D24）；否则经真助手只能读 TOTP 的当前/下一个码（助手时钟，周期只来自名字）；不需触碰、无应用密码的凭据才读得到 | 能读当前码（§4.5 A11）；D24 是启发式 |
| N2 | A10 让用户替它触碰，或挑用户正要为网站触碰的那一刻发请求（YR-17） | 只有 Sixkey 自己的界面会显示"请触碰"；从不自动重试，所以钥匙闪灯总对应用户的一次点击；SECURITY 写"触碰不告诉你是哪个程序要的" | 用户可能还是会碰；一次触碰是否同时完成两边 [未核实]，§6.3 实测 |
| N3 | A10 用 `RESET` 清空钥匙 | 助手没有这条指令；结构化运行时检查拒绝发出白名单外的 APDU | — |
| N4 | A10 申请未来的码，留着以后用 | 扩展不能指定时间或周期；`step` 只能 0/1；HOTP 不计算（D21） | 下一个时间步的 TOTP 码。直接用 PC/SC 的本机进程不受此限（YR-9） |
| N5 | A10 攒 HOTP 码或推进 HOTP 计数器 | 第一版助手对 HOTP 一律 `unsupported`（D21） | — |
| N6 | 移除权限后 A10 再申请回来 | 移除是永久的软移除（`kSoft`），重新申请不提示；所以不把移除或预设当闸；`onAdded` 留痕迹；真正的闸见 §5.4 | 曾授权过的配置文件里，A10 总能拿回来（§4.1） |
| N7 | 别的商店扩展连助手 | `allowed_origins` 只有商店 ID | — |
| N8 | 解压扩展用 Sixkey 的公钥冒充 ID | 需要开发者模式或本机写权限；那样的进程本来就能用 PC/SC | 同 A12 |
| N9 | 本机进程（或用 CDP 下载路径的 A10，YR-27）在用户级位置放同名文件遮蔽助手 | 扩展不把任何保险库秘密发给助手；遮蔽者最多拿到一对 VALIDATE 挑战/应答、喂假码；`host_missing`/`host_forbidden` 的文字告诉用户去删那个文件；帮助页指向 `NativeMessagingUserLevelHosts=false` | 离线猜弱的应用密码；拒绝服务 |
| N10 | 同步过来的用户数据目录夹带清单（macOS/Linux 指纹浏览器） | 不往配置文件里写；共享/同步配置文件不建议开 A；文档提醒；需要厂商同步那一层并有可执行文件（YR-22） | §4.5 A14，可能性较低 |
| N11 | 恶意助手版本（供应链） | 签名、可复现、公开哈希、不自动更新、两人发布；停用开关随扩展更新（D22）；撤销、公告、`--version`（§3.10b） | 它就是恶意程序（A13）；停用开关删不掉它 |
| N12 | 扩展的恶意更新借助手破坏钥匙 | 助手的白名单由已安装的助手决定，扩展更新改不了 | 恶意扩展本来就能拿走 VK 与种子 |
| N13 | 畸形请求攻击助手（A10 发的） | Rust、严格解析、4 KiB 上限、模糊测试、出错即退出 | — |
| N14 | 畸形应答攻击扩展（冒充的助手发的） | 必需字段严格校验、长度上限、文本只作为文本渲染、应答从不触发保险库写入 | 假码 |
| N15 | 码出现在日志或崩溃转储里 | stderr 只有固定令牌；关闭核心转储与 WER；发送后 zeroize | 操作系统的换页 |
| N16 | 局域网上的机器经暴露的调试端口够到钥匙 | 与 N1 相同的边界 | 这是 A 带来的**新**暴露面，SECURITY 如实写 |
| N17 | 另一个程序独占钥匙（`SCARD_SHARE_EXCLUSIVE`，例如默认设置的 scdaemon），Sixkey 一直"读取中" | `busy_other_app` 显示原因（§3.3） | 拒绝服务 |
| N18 | 两把钥匙上同名不同种子，Sixkey 显示错误的码 | 行上显示是哪把钥匙、哪个读卡器；多张卡时让用户切换 | 登录失败（无泄露） |
| N19 | 被篡改的配置文件改写钥匙条目（换 `ref.name`） | 这要求能写入加密保险库，即已持有 VK | — |
| N20 | 助手在 macOS/Windows 上被悄悄换掉 | 系统级安装在只有管理员能写的位置 | 有管理员权限的恶意程序 |
| N21 | 别的本机程序借用 Sixkey 已验证的应用会话（不知道应用密码也能写钥匙） | 验证只在一个事务内存在，事务结束前再 SELECT 清掉（§3.3，YR-4）；EOF 时 2 秒内清理（YR-26） | 设了密码的钥匙在等触碰时页面被关、助手被强杀 |
| N22 | 别的程序在 SELECT 与 VALIDATE 之间选了应用，让用户看到"密码不对"（YR-4） | SELECT 与 VALIDATE 在同一个事务里；`wrong_password` 只在本事务自己的 SELECT 之后才报 | — |
| N23 | 触碰超时被当成"需要密码"，弹出不存在的密码框或循环闪灯（YR-3） | 状态字表按指令与耗时区分；从不自动重试触碰 | 2 秒阈值是推断，G2 用真钥匙确认 |
| N24 | NFC 读卡器上的伪造卡冒充钥匙（YR-18） | 显示读卡器名、标出非 YubiKey 读卡器；不凭提示优先；添加要用户确认 | 用户确认后伪造的名字进保险库（只是名字） |
| N25 | 用 `p = 1` 之类的周期取未来很远的码（YR-10） | 周期只由助手从名字解析，请求里没有这个字段；前缀不合规就拒绝计算 | — |
| N26 | 停用开关之后仍在用的旧扩展（关了自动更新、旁加载） | §3.10b 写明做不到；公告与卸载步骤 | 这些用户仍会启动有问题的助手 |

### 8.2 PRF 解锁路径

| # | 攻击 | 设计的回答 | 剩下的 |
|---|---|---|---|
| P1 | 别的扩展或网站对同一 RP ID 发起断言，拿到 PRF 输出 | RP ID 是 Sixkey 的 origin 字符串，浏览器不让别人用（W1，`chrome_web_authentication_delegate.cc` [复核]）；salt 也只在本机 | 若 G1 迫使退回 `sixkey.app`：靠 salt 与凭据 ID 保密。浏览器之外的本机程序见 P2 |
| P2 | 拿到配置文件副本（A3）离线解锁 | 需要认证器 + PIN（没有 PIN 时钥匙给出"无 UV"的输出，KEK 不对）；PRF 输出 256 位，没有可爆破的东西 | 副本 + 钥匙 + PIN，可以不经浏览器用 libfido2 取一次输出，之后对每份更新的副本都有效，直到轮换 VK（YR-30、YR-8） |
| P3 | 锁定时的 A10 发起断言 | 需要真人触碰 + PIN；虚拟认证器造不出这把钥匙的 PRF 输出 | 用户被骗着触碰 + 输 PIN（YR-17 的时机攻击同样适用） |
| P4 | 解锁期间的 A10 登记自己的虚拟认证器（持久后门） | 注册前验证密码（A10 也读得到）；安全记录；设置页与改密码界面列表 | 见 A17：上界是"已经知道 VK"；改密码不能赶走它，轮换能（YR-7） |
| P5 | UV 有时做有时不做，导致输出不同、解锁失败 | `userVerification: "required"`；规范本来就要求 PRF 用 UV 那一个 | — |
| P6 | 篡改 `sk_prf`（换凭据 ID、换 salt、换包裹） | AAD 绑 vaultId、vkId、凭据 ID；改了只会解不开 | 拒绝服务（回退到密码） |
| P7 | 删掉 `sk_prf` | 回退到密码 | 拒绝服务 |
| P8 | 轮换 VK 后旧包裹仍能打开旧 VK | 清理入口把旧包裹置空；没有长期的间接密钥 | 清理之前的短暂窗口（与其他旧密钥材料相同，A2 标记管着） |
| P9 | 用户因为不再输密码而忘了密码 | 每 14 天的**提醒**在服务层执行（直接开 `?mode=window` 也绕不过）；敏感操作仍要密码 | 能写 `storage.local` 或拨时钟的人能延长它——它不是安全控制（YR-14）；恢复密钥兜底 |
| P10 | 在工具栏弹窗里调用 WebAuthn，弹窗被关、状态丢失 | 解锁只在小窗口，注册只在设置页；源码规则测试；即使 G1 测得弹窗没被关也不搬进弹窗（YR-29） | — |
| P11 | 钥匙丢失后被人拾到 | 要 PIN；8 次错误锁定 FIDO2；移除；PIN 可能泄露时默认同时轮换（YR-8） | 移除不立刻抹掉磁盘上的旧字节，所以没轮换时，之后的副本 + 钥匙 + PIN 仍能解开 |
| P12 | 被拾到的钥匙在**别的**安装里还登记着 | 登记按安装区分，要在每个安装里分别移除；设置页写明 | 用户忘了某个配置文件 |
| P13 | 恶意服务器（A1）与 PRF | PRF 数据从不上传 | — |
| P14 | 克隆的配置文件共用 `sk_prf` | 克隆本来就是同一份数据；同一把钥匙能打开两份 | 与共用主密码相同 |
| P15 | 用户在注册对话框里选了"用手机"，存下一个随 Google/Apple 账户同步的通行密钥（YR-6） | 注册后检查 BE 位、传输方式、附着方式，任一不符就拒绝、不保存（D25） | `getTransports()` 为空且 BE 未置位的手机凭据 [推断，罕见] |
| P16 | Windows 上 webauthn.dll 对非常驻凭据忽略 hmac-secret，Sixkey 误报"不支持"（YR-28） | 以验证用 `get()` 的结果为准；G1 比较两种凭据；需要时 Windows 上用常驻凭据 | 占钥匙上的一个常驻位，移除要多一步 |
| P17 | 用户为 Sixkey 设了 FIDO2 PIN 后忘记，连错 8 次锁住钥匙，重置删掉了钥匙上所有网站登录（YR-31） | 设 PIN 之前的一句提示 | Sixkey 不受影响；网站登录要各自恢复 |
| P18 | 对话框只显示 "chrome-extension"，用户学会批准来历不明的提示（YR-30） | 小窗口先说明；只有 Sixkey 能在浏览器里用这个 RP ID | 用户习惯 |

---

## 9. 来源

| ID | 来源 | 用于 | 标记 |
|---|---|---|---|
| C1 | Chromium `chrome/common/chrome_paths.cc`（源码 main，2026-10-16） | `DIR_NATIVE_MESSAGING` 按品牌的系统级路径（含 Chrome for Testing）；`DIR_USER_NATIVE_MESSAGING = DIR_USER_DATA/NativeMessagingHosts` | [复核] |
| C2 | Chromium `chrome/browser/extensions/api/messaging/launch_context_posix.cc` | 先用户级后系统级；`allow_user_level_hosts`；Linux `allow_new_privs` | [复核] |
| C3 | Chromium `…/messaging/launch_context_win.cc` | HKCU 先于 HKLM；32 位视图先于 64 位；Chromium 品牌先读 `SOFTWARE\Chromium` 再回落 `SOFTWARE\Google\Chrome` | [复核] |
| C4 | Chromium `…/messaging/launch_context.cc` | 清单名校验、`allowed_origins` 不匹配即"禁止"、POSIX 要求绝对路径、origin 作第一个参数、Windows `--parent-window` | [复核] |
| C5 | Chromium `…/messaging/native_messaging_host_manifest.cc` | 禁止通配符与子域模式；只支持 `stdio` | [复核] |
| C6 | Chromium `…/messaging/native_message_process_host.cc` | 宿主→浏览器 1 MiB 上限；销毁时 `EnsureProcessTerminated` | [复核] |
| C7 | https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging （2026-09-16） | 各平台路径、Chrome for Testing 自 146 起不同、错误文字、`connectNative` 与 `sendNativeMessage` 的进程模型、64 MiB 上限 | [转录] |
| C8 | https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle （2023-05-02） | `connectNative` 让 SW 保活（Chrome 105） | [转录] |
| C9 | https://developer.chrome.com/docs/extensions/reference/api/permissions （2026-09-11） | 不可选权限清单（无 `nativeMessaging`）；用户手势；移除后再申请通常不提示 | [转录] |
| C11 | Chromium `extensions/browser/permissions/permissions_updater.h`、`extensions/browser/api/permissions/permissions_api.cc`（源码 main，2026-10-16） | `RemoveType::kSoft`（"re-add the permissions without further prompting"）、`kHard` 只在单元测试；"don't prompt for already-granted permissions … removed by the extension itself"；用户手势错误文字 | [复核] |
| C12 | Chromium `base/process/kill_posix.cc`、`kill_mac.cc` | `EnsureProcessTerminated`：等 2 秒后 SIGKILL，不发 SIGTERM | [复核] |
| C13 | Chromium `chrome/browser/webauthn/chrome_web_authentication_delegate.cc` | `MaybeGetRelyingPartyIdOverride` 返回 `caller_origin.Serialize()`；扩展不能声明别的扩展的 RP ID | [复核] |
| C14 | https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session （搜索摘要） | Chrome 144 起可在 `chrome://inspect#remote-debugging` 运行时开启远程调试，每个会话要用户批准 | [摘要] |
| L1 | https://github.com/Yubico/libfido2/blob/main/src/winhello.c | "webauthn.dll ignores requests to enable hmac-secret unless a discoverable credential is also requested" | [复核] |
| Y6 | https://raw.githubusercontent.com/Yubico/yubikey-manager/main/ykman/_cli/oath.py ；https://raw.githubusercontent.com/Yubico/yubioath-flutter/main/helper/helper/oath.py | 触碰凭据上的 `SECURITY_CONDITION_NOT_SATISFIED` = 触碰超时；`time() - start > 5` 的区分 | [复核] |
| Y7 | https://raw.githubusercontent.com/Yubico/ykneo-oath/master/applet/src/pkgYkneoOath/YkneoOath.java （GPL-3.0，只读以了解行为，不复制） | 状态放在 `CLEAR_ON_DESELECT` 的瞬态内存里 | [复核] |
| RV | `docs/audit/internal-reviews/YUBIKEY-REVIEW.md`（2026-10-16 独立评审） | 评审核实而我没有重读的：Chromium 提交 4b8e494ea3、5f3963f128、012c80d36f 等；FIDO MDS3；`webauthn.h` 与 `webauthn_api.cc`；策略定义 `NativeMessagingUserLevelHosts`；CTAP 2.1 勘误版；`debugger_api.cc`；`_api_features.json` | [转录] |
| C10 | https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging （更新于 2026-09-02） | Edge 的注册表查找顺序与回落、macOS/Linux 路径、stderr 进日志 | [转录] |
| W1 | https://lists.w3.org/Archives/Public/public-webauthn/2023Dec/0078.html （Nina Satragno，2023-12-13） | Chrome 122 起扩展可按 host 权限声明 RP ID；不能声明别的扩展的 RP ID；子域权限可声明父域 | [转录] |
| W2 | WebAuthn 规范 PRF 扩展一节（https://w3c.github.io/webauthn/#prf-extension），经 W3C 列表帖与搜索摘要 | PRF 必须用"做了 UV"的那个输出 | [摘要] |
| W3 | https://lists.w3.org/Archives/Public/public-webauthn/2025Oct/0027.html （John Bradley） | hmac-secret 对 UV 与非 UV 输出不同 | [摘要] |
| W4 | CDP `browser_protocol.json`（ChromeDevTools/devtools-protocol master，2026-10-16） | `VirtualAuthenticatorOptions` 的 `hasPrf`、`hasHmacSecret`、`hasHmacSecretMc`、`hasUserVerification`、`isUserVerified` | [复核] |
| W5 | https://www.corbado.com/blog/passkeys-prf-webauthn （2026-03 更新，搜索摘要） | Chrome 147 在 Windows 上支持创建时 PRF | [摘要] |
| Y1 | https://developers.yubico.com/OATH/YKOATH_Protocol.html | 名字最长 64 字节；CALCULATE ALL 对触碰与 HOTP 只回名字；SELECT 标签；RESET 无需鉴权；截断应答格式 | [转录]（调研时 [复核]） |
| Y2 | https://raw.githubusercontent.com/Yubico/yubikey-manager/main/yubikit/oath.py （BSD-2，只读作对照） | 指令与标签常量、`_get_device_id`、`calculate_all` 对非 30 秒周期重算、`set_key` 用 SHA1 | [复核] |
| Y3 | https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html （"as of mid-2025"） | 平台矩阵、支持型号、多钥匙与每凭据 salt 的建议 | [转录] |
| Y4 | https://docs.yubico.com/hardware/yubikey/yk-tech-manual/yk5-apps-fido.html | `hmac-secret` 5.2.x–5.8.x、`hmac-secret-mc` 5.8.x、25 个常驻凭据、出厂无 PIN、8 次错误锁定 | [转录] |
| Y5 | https://developers.yubico.com/Passkeys/Passkey_concepts/Security_key_capabilities/ | 5.8 上 PRF 创建时一次交互 | [转录] |
| P1 | 第三方的 Chrome 策略用法（UiPath、AODocs 文档，搜索摘要）；评审读了策略定义原文（RV） | `NativeMessagingUserLevelHosts` 的作用 | [摘要]；原文 [转录] |
| P2 | Flatpak/Snap 社区报告（KDE 论坛、keepassxc-browser #1267、GNOME issue 等，搜索摘要） | 沙箱浏览器的原生消息问题 | [摘要] |
| R1 | 本仓库：`docs/research/yubikey-oath-feasibility.md`、`docs/research/mcp-feasibility.md`（B3、B5–B8）、`docs/research/ux-study.md`（§2.6、§2.8，C7、C15、C23、U1–U4）、`docs/research/fingerprint-browser-security-lessons.md`、`docs/research/security-incidents-report.md`、`docs/SYNC-DESIGN.md`（§0.0i、§0.0j、§1.2、§2.3、§3.0、§4.3、§4.4、§13）、`docs/security/local-vault.md`、`docs/PRIVACY.md`、`docs/guides/FINGERPRINT-BROWSERS.md`、`docs/history/PLAN-zh.md`（§3、§5、Phase 3）、`extension/src/core/vault/{model,merge,validate}.ts`、`core/crypto/keyring.ts`、`core/service/{service,types,presets}.ts`、`core/storage/store.ts`、`core/backup/backup.ts`、`platform/session.ts`、`scripts/check-dist.mjs`、`scripts/store-id.mjs`、`manifest.*.json`、`test/e2e/harness.ts` | 既有承诺、决定与代码事实 | [复核]（本仓库）；其中转引的外部条目按 [转录] |

## 10. 没有核实的

由原型解决的（G1）：
- 扩展 origin 作 RP ID 在 Windows `webauthn.dll` 路径上能否配合 PRF，常驻与非常驻凭据哪个能拿到 PRF（YR-28）；在 Chromium 120 上能否工作；Chrome 与 Windows 的对话框里请求方显示成什么。
- Linux 上 Chrome + YubiKey 的 PRF；Windows 10 的 webauthn.dll 是否有 API v4。
- 工具栏弹窗里调用 WebAuthn 时弹窗在各平台是否被关（只测量，不改变决定）。

由探针解决的（G2）：
- 重新 SELECT 是否清掉 YubiKey 5 的已验证状态（NEO 源码是这样，YubiKey 5 固件不公开）；鉴权失败的 `6982` 是否总在 2 秒内返回（触碰超时阈值）；钥匙的触碰超时秒数。
- 授权可选权限后，已打开的页面里 `chrome.runtime.connectNative` 是否立即可用；`connect-src 'none'` 不影响 `connectNative`。
- 三个平台上能否读到父浏览器进程的命令行（D24）；Windows 上助手的父进程是浏览器还是 `cmd.exe`。
- 读卡器名规则（"Yubico YubiKey" 开头 = USB 上的 YubiKey）。
- macOS App Sandbox 下的命令行助手能否访问 PC/SC 并经 stdio 工作；Windows 防火墙规则与 WER 排除的可行性（G2/Y4）。
- 各指纹浏览器（AdsPower、BitBrowser、Multilogin、GoLogin、Dolphin、Kameleo 等）是否改过原生消息的查找代码或调试开关的名字。

要硬件或更多资料的：
- 一次触碰在网站的 FIDO 请求与 OATH CALCULATE 同时等待时完成哪一边（YR-17，§6.3）。
- YubiKey Bio 多协议版是否有 OATH。
- 触碰等待之后 `navigator.clipboard.writeText` 是否还能成功（需不需要瞬时用户激活）。
- Brave 的系统级清单位置与注册表键；厂商同步是否会带上用户数据目录这一层的 `NativeMessagingHosts` 与可执行位。
- 授权记录是否随复制或克隆的配置文件一起走（我推断会，在 Preferences 里）。
- 商店后台创建条目时是否立即分配扩展 ID（不必公开发布）。

已由评审或调研解决（不再列为未核实）：`NativeMessagingUserLevelHosts` 的原文（评审）；Playwright 捆绑 Chrome for Testing 156（体验调研附录 A）；Security Key 系列的 hmac-secret（FIDO MDS3，评审）；触碰超时的状态字是 `6982`（ykman、yubioath-flutter 源码，我已复核）。
- 签名后二进制的可复现性核对方法；Apple 与 Windows 签名的当前价格；GitHub macOS 运行器的计费倍率。
- 助手启动 + PC/SC 往返的实际耗时（目前只是估计）。
- 所有许可证结论都不是法律意见。
