# YubiKey TOTP（OATH）支持：可行性调研

日期：2026-10-16。范围：只做调研，不改代码、清单、PLAN、SYNC-DESIGN。
Chromium 源码读的是 GitHub 镜像 `main` 分支（2026-10-16 拉取），不一定等于当前稳定版的二进制；凡依赖此处的结论都标了"源码 main"。

---

## 0. 结论

**所有者给的链接（yubioath-flutter）是 YubiKey 的 OATH 应用的客户端。把它做进 Chrome MV3 扩展，在不违背现有产品承诺的前提下做不到。**

1. **OATH 应用只走智能卡（CCID）通道。** 官方技术手册原话："can only be accessed through the CCID channel"（S2）。Yubico 自己的 Python 库里，`OathSession` 的构造参数只收 `SmartCardConnection`（S4）。
2. **Chrome 桌面稳定版里，扩展碰不到这个通道，而且有三道独立的拦：**
   - **WebUSB 设备黑名单**：Chrome 的 `chrome/browser/usb/usb_blocklist.cc` 把 VID `0x1050`（Yubico）的 `0x0010、0x0018、0x0030、0x0110–0x0116、0x0120、0x0200、0x0211、0x0401–0x0407、0x0410` 逐个列入（S14，已读全表）。选择器里根本不会出现这把钥匙。
   - **受保护接口类**：CCID 的接口类是 `0x0B`（Smart Card），在 WebUSB 的受保护类表里（S11、S12）。`ChromeUsbDelegate` 只给 Chrome Apps（`is_platform_app`）和少数 ChromeOS 的 HID 白名单扩展开了口子，普通 MV3 扩展没有（S13）。
   - **操作系统的 CCID 驱动 / pcscd 已占着接口** [推断]。
3. **Web Smart Card API 不是出路**：Chromium 里只暴露给 `IsolatedContext`（隔离 Web 应用，IWA），运行时特性在源码 main 里默认值是 `"test"`，仅 ChromeOS 为 `"stable"`（S17）。chromestatus 上桌面端是"开发中，Chrome 143"，该条 2026-01 更新过（S19）。Google 管理员文档说 IWA 只在 ChromeOS 支持（S22）。**扩展页面不是 IWA。**
4. **WebHID 也不行**：FIDO 用途页的顶层集合整体被封，Yubico 的若干产品号被点名封（S16）。而且 OATH 本来就不在 HID 通道上。
5. **唯一可行的路是"可选 `nativeMessaging` + 本机程序"**（和 USB/PC-SC 打交道的是本机程序）。这正是 SYNC-DESIGN §13 已经否决过的形态（"需要 `nativeMessaging` 权限和本机安装程序，破坏'只是一个扩展'的定位"），MCP 调研 Q4 也倾向不推翻它（S28）。

**所以：A、B 目前都不建议做；真正与产品承诺相容的 "YubiKey 支持" 只有 C（WebAuthn PRF 解锁），那本来就在 PLAN Phase 3。**

另外三个要让所有者知道的事实：

- **密钥里的种子读不出来。** 协议里没有任何指令会返回密钥（S1）；Yubico 文档原话："The OATH secrets (account credentials) always stay within the YubiKey."（S3）。所以**不存在"从 YubiKey 导入到 Sixkey"**。反方向（Sixkey 的种子手动写进 YubiKey）可行，但只能写入、不能取回。
- **YubiKey 的 OATH 应用没有鉴权就能被重置**：`RESET (0x04)` 的 "Require Auth" 列是 N（S1）。任何能和这个应用说话的进程，一条指令就能清空钥匙里所有账户。这是对"永不丢数据"最直接的威胁（任何本机程序或被 CDP 驱动的页面一旦能连上钥匙，都能清空它）。
- **B 有一个绕不开的二选一**：种子既留在 Sixkey 又写进钥匙，硬件保管的好处就没了（保险库里还有明文种子的密文副本）；只留在钥匙里，则违反"永不丢数据"（钥匙丢了或被重置，种子无从恢复）。

### 决策表

| | 是什么 | 浏览器路径 | 权限 / 安装形态 | 工作量 | 主要风险 | 建议 |
|---|---|---|---|---|---|---|
| **A 读码** | 在 Sixkey 里显示 YubiKey OATH 应用算出的码 | 无纯浏览器路径。只剩可选 `nativeMessaging` + 本机程序（用系统 PC/SC：Windows WinSCard、macOS PCSC.framework、Linux pcsc-lite） | 新增可选权限 `nativeMessaging`（警告 "Communicate with cooperating native applications" [S28 引 B3]）；三平台已签名安装包；与 §13 冲突 | **L**（三平台本机程序、签名与公证、安装器、配对、UI、数据模型、测试），之后长期维护 | 推翻 §13；IPC 与 CDP（A10）；RESET 暴露面；指纹浏览器各自的宿主清单位置 [推断] | **现在不做。** 触发条件见 §4.2 |
| **B 写入** | 添加账户时把种子也写进 YubiKey | 同 A，另需 `PUT` | 同 A | **L+**（A 之上再加写入、重复名覆盖保护、恢复路径） | 二选一困境（上）；`PUT` 会静默覆盖同名凭据；种子要经过本机程序 | **不做。** 只做文档："想把种子放进硬件，请在建立账户时同时加进 Yubico Authenticator" |
| **C 解锁因子** | 用 YubiKey 当 Sixkey 保险库的附加解锁因子（WebAuthn PRF / hmac-secret），与 OATH 无关 | 纯浏览器：`navigator.credentials` + PRF 扩展，Chrome 116+ | 无新权限（Phase 1 的 host 权限 `https://api.sixkey.app/*` 已够声明 RP ID `sixkey.app`，Chrome 122+ [S28 引 C23]） | **M**（PLAN 已排 Phase 3） | 必须在标签页/窗口里调用（Chrome 156 起安全对话框会强关弹窗 [S28 引 C7]）；丢钥匙必须有主密码兜底；PRF 在各平台的差异 | **按计划在 Phase 3 做**，先做 §5 的一天原型 |

所有者最可能指的是 **A（也许连带 B）**：他引的是 Yubico Authenticator，而它就是 OATH 客户端。但 PLAN 里写的 "YubiKey / WebAuthn PRF" 是 C。两者可能被混在一起了，见 §6 问题 1。

---

## 1. YubiKey 的 OATH 应用到底做什么（问题 1）

### 1.1 存储与协议

| 项目 | 事实 | 来源 |
|---|---|---|
| 应用 AID | `A0 00 00 05 27 21 01`；ISO 7816-4 APDU；USB 上需要 CCID 开启，或走 NFC | S1 [复核] |
| 类型 | HOTP（0x10）、TOTP（0x20） | S1 |
| 算法 | HMAC-SHA1 / SHA256 / SHA512（SHA512 需固件 4.3.1+） | S1 |
| 位数 | `PUT` 的 key 标签里带"类型\|算法"一个字节加位数一个字节，再接密钥字节 | S4 `put_credential` [复核]；允许的位数范围 [未核实] |
| 周期 | **不在钥匙里**。TOTP 的周期被编码在凭据名里：`"{period}/{issuer}:{name}"`（周期为 30 秒时省略前缀） | S4 `_format_cred_id` [复核] |
| 触碰 | 属性位 `0x02`："Require button press to generate OATH codes"（固件 4.2.4+）。触碰凭据在 CALCULATE ALL 里只返回名字，没有码 | S1 |
| 应用密码 | `SET CODE (0x03)`：UTF-8 密码经 **1000 轮 PBKDF2**，以 SELECT 返回的 ID 为盐，取 16 字节；之后每次会话先 `VALIDATE`（双向 HMAC-SHA1 挑战应答） | S1、S4 `validate` [复核] |
| 指令 | PUT 01、DELETE 02、SET CODE 03、RESET 04、LIST A1、CALCULATE A2、VALIDATE A3、CALCULATE ALL A4、SEND REMAINING A5；ykman 另有 RENAME 05（固件 5.3.1+） | S1、S4 |
| 哪些需要先 VALIDATE | 除 `RESET` 和 `VALIDATE` 外，其余都需要（**仅当设了密码时**）。没设密码时 PUT/DELETE 也是开放的 | S1 |
| 容量 | 固件 5.7.0 起 **64 个**，更早 32 个；Yubico Authenticator 的代码也是这样判断（`version >= 5.7 ? 64 : 32`；4.x 以下为 null） | S2 [转录]、S7 `models.dart` [复核]、S24 [摘要] |
| 凭据名长度 | issuer 与 name 共用一个字节预算，含 `period/` 前缀（`getRemainingKeySpace`）。我没找到常量 64 的原文，**具体上限未核实** | S7 [复核] |
| 通道 | "can only be accessed through the CCID channel"；与 OTP 应用里的槽位无关 | S2 [转录] |
| 没有时钟 | 钥匙不知道时间：主机把 `timestamp // period` 作为挑战发过去。`CALCULATE` 对**任意挑战**都会应答 | S4 `_get_challenge`、`calculate_code` [复核]；S6 `calculate(challenge)` [复核] |

补充几处在设计里有后果的细节：

- **`CALCULATE ALL` 不含 HOTP 和触碰凭据**（只返回名字），需要对每个这样的凭据单独 `CALCULATE`（S1、S4 `calculate_all` 注释 "This excludes credentials which require touch as well as HOTP credentials"）。
- **HOTP 的计数器在钥匙里**，每次 CALCULATE 就加一，不能"偷看"（`calculate_code` 对 HOTP 发空挑战，S4）。Sixkey 保险库里 HOTP 的 `counter` 是"取最大值合并"的，在钥匙凭据上没有意义。
- **`PUT` 的语义是"新增或覆盖"**（S1 的 PUT 说明）。同一个 `issuer:name` 再写一次会静默覆盖旧种子，这是写入功能里的数据丢失陷阱。
- **`device_id` 是 SELECT 返回的盐的 SHA-256 前 16 字节**（S4 `_get_device_id`），不是序列号；`RESET` 会重新生成盐（S4 `reset`）。所以任何"这个条目属于哪把钥匙"的引用，重置一次就失效。
- **SCP（安全通道）**：ykman 对 OATH 支持 SCP，要求固件 5.6.3+（S4 `__init__`）。默认路径不用。

### 1.2 种子能不能从钥匙里导出？

**不能。** 验证了三层：

1. 协议：S1 的指令表里，没有一条返回 `TAG_KEY(0x73)`；`LIST` 只回名字与类型/算法字节，`CALCULATE` 只回码。S1 本身没有明说"不可读"，这是从指令集推断的 [推断]。
2. 官方客户端库：`OathSession` 的方法只有 `reset / derive_key / validate / set_key / unset_key / put_credential / rename_credential / list_credentials / calculate / delete_credential / calculate_all / calculate_code`，没有读取种子的方法（S4）。
3. 官方文档：Authenticator 指南说 "The OATH secrets (account credentials) always stay within the YubiKey."，删除后 "there is no way to recover the account credentials"，备份建议是"为第二把钥匙保存 QR 码或密钥信息"（S3 [转录]）。

这是软件接口层面的结论，不是对安全芯片的物理攻击分析。

### 1.3 Yubico Authenticator 的用户流程

- 添加：扫 QR 或手动输入种子、类型、算法、周期、位数；可勾选"需要触碰"。Android 有 NFC 读卡流程（S3）。
- 查看：TOTP 凭据在应用打开时自动显示；触碰凭据和 HOTP 要点一下再触碰钥匙（S3）。
- 密码：强烈建议设；可"在受信任设备上记住"。忘记密码的唯一办法是重置，会删光所有账户（S3）。
- "记住"的实现（桌面）：helper 把 `derive` 出的 16 字节密钥（不是密码）通过 ykman 的 `AppData` + 系统钥匙串保存（S6 `_remember_key` / `_get_access_key`）[复核]。
- 触碰超时：`SECURITY_CONDITION_NOT_SATISFIED` 且等了超过 5 秒就当作超时（S6 `_do_with_touch`）。HOTP 在 0.5 秒后就提示"请触碰"（同上）。

### 1.4 yubioath-flutter 的结构（证明协议代码不在它的 Dart 里）

- 桌面：Flutter UI ↔ `helper/`（Python，PyInstaller 打包的 `authenticator-helper`）↔ `ykman`/`yubikit` ↔ `pyscard` ↔ 系统 PC/SC。`helper/helper/oath.py` 只做 RPC 封装，APDU 全在 `yubikit.oath.OathSession`（S6、S8 的 `helper/pyproject.toml` 依赖 `yubikey-manager`、`pyscard`）[复核]。
- Android：Kotlin 原生，依赖 `com.yubico.yubikit:oath/core/android`（S8 的 `android/app/build.gradle`）[复核]。iOS 是另一个仓库 `yubioath-ios`（Apache-2.0）（S10）。
- Linux 需要 `pcscd` 运行（S8 README）[转录，WebFetch]。
- 最新发布 7.4.2（2026-09-09）（S8 NEWS）；ykman 最新发布 5.9.2（2026-06-30）（S9）。

### 1.5 三种"YubiKey 支持"

| | 是什么 | 谁在要 |
|---|---|---|
| **A 读码** | Sixkey 里能看到存在 YubiKey OATH 应用里的账户的码 | 想让 2FA 种子留在硬件里、又想在浏览器里一键复制的人 |
| **B 写入** | 添加账户时把种子也写进钥匙 | 同上，另有"种子不进软件"的追求；但这与 Sixkey 作为保险库的角色矛盾 |
| **C 非 OATH** | 用 YubiKey（FIDO2 凭据的 hmac-secret，浏览器里叫 WebAuthn PRF）当解锁保险库的因子 | 想用硬件钥匙代替输入主密码的人 |

C 还有两个变体，和 OATH 无关：

- **OTP 应用的挑战-应答槽位（HMAC-SHA1）**：KeePassium、PanicVault 等用它做保险库解锁（S26 [摘要]）。它在 OTP/HID 通道上，WebHID 够不到（S16），浏览器里等价的方案就是 PRF。
- **把 YubiKey 当 Sixkey 同步账户的二次验证**：已在 §13 里明确不做（"Sixkey 同步账户本身的 TOTP 二次验证"）。

---

## 2. 浏览器扩展怎样才能和钥匙说话（问题 2）

结论先行：**在稳定版 Chrome（Windows、macOS、Linux）里，没有一条纯扩展的路能到 OATH 应用。** 下表是逐条证据。

| 路径 | 能到 OATH 吗 | 证据 |
|---|---|---|
| **WebUSB**（扩展页面） | **不能** | 见 §2.1 |
| **WebHID** | **不能**，且 OATH 不在 HID 上 | 见 §2.2 |
| **Web Smart Card API** | **不能**（只给 IWA；桌面稳定版未发布） | 见 §2.3 |
| **chrome.usb** | 不适用：只属于 Chrome Apps（平台应用） | 见 §2.4 |
| **FIDO/CTAP 通道上做 OATH** | 没有这种东西 | `yubikit/management.py` 把 `CAPABILITY.OATH` 映射到 `USB_INTERFACE.CCID`；`OathSession` 只收 `SmartCardConnection`（S4、S5）[复核] |
| **WebAuthn 间接生成 TOTP** | 没有（WebAuthn 只有凭据与断言，不能执行 OATH 应用的指令） | 逻辑上；没有找到任何反例 |
| **可选 `nativeMessaging` + 本机程序** | **能**（唯一可行的路） | 见 §2.5 |
| **localhost 桥接 / 伴生应用** | 能，但违背承诺 | 见 §2.6 |

### 2.1 WebUSB：三道拦

**第一道：设备黑名单。**
Chrome 会过滤掉 `UsbBlocklist` 里的设备（`chrome_usb_delegate.cc` 第 343 行：`if (!is_usb_unrestricted && UsbBlocklist::Get().IsExcluded(device_info))`，S13）。`chrome/browser/usb/usb_blocklist.cc` 的静态表里，注释 "Yubikey devices. https://crbug.com/40090685" 之下列了 `1050:0010、0018、0030、0110–0116、0120、0200、0211、0401–0407、0410`；WICG 的 `blocklist.txt` 内容相同（"Yubikey devices. https://crbug.com/818807"）（S14）[复核]。这个黑名单的来源是 2018 年 YSA-2018-02：研究者用 WebUSB 访问 YubiKey NEO 的 CCID 接口，绕过 U2F 的源检查；Chrome 65 加了黑名单，Chrome 67 加了接口类过滤（CVE-2018-6125）（S21 [转录]）。**这是 Chrome 有意识封死的路径，不是实现缺口。**

**第二道：受保护接口类。**
规范的受保护类：`0x01` Audio、`0x03` HID、`0x08` Mass Storage、`0x09` Hub、`0x0B` Smart Card、`0x0E` Video、`0x10` Audio/Video、`0xE0` Wireless Controller（S11 [复核]，规范页下载到一半超时，但这一节已读到）。Chromium 的 `WebUsbServiceImpl::GetProtectedInterfaceClasses()` 的实际列表是 Audio、HID、MassStorage、SmartCard、Video、AudioVideo、Wireless（S12）；注意 `GetProtectedInterfaceClasses` 里**没有 Hub（0x09）**，与规范略有出入，对本题无影响。`DeviceImpl::ClaimInterface` 对这些类直接返回 `kProtectedClass`，Blink 抛 `SecurityError: The requested interface implements a protected class.`（S15、S12）。

`ChromeUsbDelegate::AdjustProtectedInterfaceClasses` 对扩展的处理：只放开两种，**Chrome Apps（`is_platform_app()`，因为 `chrome.usb` 没有这类限制）** 和 ChromeOS 上一批按扩展 ID 写死的 HID 白名单（Imprivata、Hotrod 等）（S13）。MV3 扩展不在其中。

**唯一的例外：** `UnrestrictedUsb` 特性。带 `usb-unrestricted` 权限策略的 **隔离 Web 应用（IWA）** 可以绕过黑名单和受保护类（S12、S13；chromestatus 条目 "Unrestricted WebUSB (available only to Isolated Web Apps)"，S19）。两处**有出入**需要说明：

- 源码 main 的 `runtime_enabled_features.json5` 里 `UnrestrictedUsb` 是 `status: "stable"`，而 chromestatus 的条目写 "In developer trial（Behind a flag）"、里程碑 129、最后更新 2025-08（S17、S19）。状态页可能没更新；
- Google 管理员文档说 "IWAs are supported only on ChromeOS"（S22 [转录]），但一条 2026 年的 CVE 摘要说 IWA 缺陷影响 Windows、macOS、Linux 桌面 Chrome（[摘要]，未核实）。

**两处出入都不改变结论：扩展不是 IWA。** IWA 要求签名的 Web Bundle 与专门的安装渠道，是一个完全不同的产品形态，而且在 Windows/macOS/Linux 的普通用户那里是否可安装还没核实。

**第三道：操作系统驱动**（[推断]，未找到官方文档逐条确认）。WebUSB 要求接口没被系统驱动占用。Windows 上 CCID 接口由系统自带的智能卡类驱动持有，没有 WinUSB；macOS、Linux 上由系统 CCID 驱动 / pcscd 占用。Chrome 的旧文档提到 Windows 要手动装 INF 才能让设备走 WinUSB，而 2018 年的类过滤变更说明"这类绕过之后不再可行"（S29 [摘要]）。这条即使前两道不存在也会拦住大多数用户。

另外，扩展里用 WebUSB 本身没问题：不需要任何 manifest 权限，Chrome 118+，`requestDevice()` 不能在扩展 service worker 里调用，要在别的扩展页面里调用（S20 [转录]，页面更新于 2024-02-14）。它对**非黑名单、非受保护类**的设备能用，对 YubiKey 的 OATH 不行。

### 2.2 WebHID

- Chromium 的 `hid_blocklist.cc` 第一条规则："Block all top-level collections with the FIDO usage page."；另外按 VID/PID 点名封了 `1050:0010、0018、0030、0110–0116、0120、0200、0211、0401–0407、0410` 这一整段 YubiKey 产品号（S16）[复核]。
- 就算能打开，OATH 也不走 HID：OTP 的 HID 接口是键盘，FIDO 的 HID 接口走 CTAPHID。ykman 里 `FidoConnection` 只用于 CTAP 与管理，不能承载 OATH（S5、S4）。

### 2.3 Web Smart Card API

- 规范：WICG 孵化中，README 明说 PC/SC 太底层，"it is recommended that it is made available only to Isolated Web Apps"，并写明"Only isolated web apps may access this fingerprinting surface"（S18 [复核]）。
- Chromium 实现：`SmartCardService::Create` 要同时通过三项检查：特性 `kSmartCard` 开启、权限策略 `smart-card` 允许、`HasIsolatedContextCapability(frame)`（即 `WebExposedIsolationLevel::kIsolatedApplication`），否则 `ReportBadMessage`（S17 [复核]）。IDL 上标 `Exposed=Window, SecureContext, IsolatedContext`。**扩展页面不是 `kIsolatedApplication`**，这一点是我从这两处代码推断的 [推断]，没有找到官方明文。
- 发布状态：chromestatus "Web Smart Card API" 桌面里程碑 143，状态 "In development"，2026-01-13 更新；描述里提到管理员策略 `DefaultSmartCardConnectSetting`、`SmartCardConnectAllowedForUrls`（S19）。源码 main 的特性默认值 `"default": "test"`，只有 ChromeOS 是 `"stable"`（S17）。**所以 2026-10 的桌面稳定版没有发布，即便发布也只给 IWA。**
- ChromeOS 上的 "Smart Card Connector" 是 Google 的 ChromeOS 组件，不是桌面方案（S27 [摘要]）。

### 2.4 chrome.usb

只属于 Chrome Apps。`ChromeUsbDelegate` 里的注释就是证据："Don't enforce protected interface classes for Chrome Apps since the chrome.usb API has no such restriction."（S13）。Chrome Apps 不是 MV3 扩展，是已被淘汰的形态；它们在各桌面平台上的现状我没核实 [未核实]，无论如何不应作为新产品的基础。

### 2.5 可选 `nativeMessaging` + 本机程序（唯一能工作的）

这条路不受浏览器限制，因为通信由本机程序用系统 PC/SC 完成。但：

- **权限与警告**：`nativeMessaging` 的安装警告 "Communicate with cooperating native applications"；它**可以做成可选权限**（不在不可选清单里），对已安装用户也只能走可选权限，因为更新时新增带警告的权限会使扩展被停用（S28 引 mcp-feasibility B3、B6、B7）[转录]。
- **安装形态**：每个平台一个已签名的本机程序（Windows 还要注册表项）、宿主清单、更新渠道（同上 B7）。
- **与 §13 冲突**：SYNC-DESIGN §13 已因同样理由否决过一次（"需要 `nativeMessaging` 权限和本机安装程序，破坏'只是一个扩展'的定位"），MCP 调研 Q4 倾向"不推翻"（S28）。
- **指纹浏览器 / Chromium 分叉**：每个分叉查找宿主清单的位置可能不同（用户数据目录），Windows 注册表项也按浏览器区分 [推断，未逐个核实]。Sixkey 的目标用户里有大量指纹浏览器用户（FINGERPRINT-BROWSERS.md），这会让安装支持成本放大。
- **现有项目**：我只找到两个 Firefox 扩展，都靠 `ykman` + 本机消息传递：`Levitator1/oath-wallet`（约 6 年未更新）、`molecular/yubikey-otp-helper`（S25 [摘要]）。**没有找到任何基于 WebUSB/WebHID/WebAuthn 的浏览器内 OATH 实现。**

### 2.6 localhost 桥接 / 伴生应用

扩展连 `http://127.0.0.1:端口` 需要 host 权限，而且当前 CSP 是 `connect-src 'none'`、构建脚本 `check-dist.mjs` 在 `permissions` 与 `host_permissions` 上有白名单并检查 `connect-src`，PRIVACY.md 把 "No network requests of any kind" 写给了用户；SYNC-DESIGN 的立场是"只连一个 API origin"。**localhost 桥接要打破这三处**，而且任何本机进程都能连同一个端口，认证问题和 MCP 调研里的 Claude-in-Chrome 命名管道教训一样（S28 引 mcp-feasibility B8）。没有理由选它而不选 `nativeMessaging`。

### 2.7 Yubico 自己有没有 JS 库

我按名称（yubikit / js / web / oath / webauthn 等）筛了 Yubico 组织的仓库：有 `yubikit-android`、`yubikit-ios`、`yubikit-swift`（均 Apache-2.0）、`yubikey-manager`（BSD-2-Clause）、`python-fido2`，**没有 JS 版 yubikit，也没有 "yubikit-web"**（S10 [复核]；筛选是按名称做的，可能遗漏）。

---

## 3. 假设走通了，安全与产品模型（问题 3）

A、B 在浏览器里走不通，所以这一节分成两部分：**(a)** 若将来做"本机程序"形态的 A/B，必须满足什么；**(b)** C（PRF）的要点。

### 3.1 权限与安装警告

| 方案 | 新增权限 | 安装警告 | 备注 |
|---|---|---|---|
| WebUSB（若某设备可用） | 无 | 无（浏览器自己的设备选择器） | 对 YubiKey 无效 |
| 本机程序 | 可选 `nativeMessaging` | "Communicate with cooperating native applications" | 在设置页按钮里申请（需用户手势） |
| C（PRF） | 无新增 | 无 | 需要 host 权限声明 RP ID，Phase 1 已有 |

### 3.2 UX：弹窗、标签页、触碰

- **弹窗会被关**：Chrome 156 起，出现安全对话框时扩展弹窗被强制关闭（S28 引 ux-study C7、C17）。WebUSB 设备选择器算不算"安全对话框"，我**没有核实** [未核实]；WebAuthn 对话框算。结论不变：任何要用户在浏览器对话框里确认的步骤（设备选择、PRF、触碰提示）放在标签页（现有设置页）里，弹窗里只展示结果。本机程序形态的 A 没有浏览器对话框，可以在弹窗里工作，触碰时弹窗里显示"请触碰你的 YubiKey"。
- **触碰凭据的流程**：用户点击 → 发 `CALCULATE` → 钥匙闪灯等触碰 → 超过约 5 秒返回 `0x6985`（S6）。界面必须有：等待态、倒计时、取消、超时重试。
- **应用密码**：见 §3.4。
- **多把钥匙**：`device_id`（盐的哈希）区分钥匙；列表要按钥匙分组显示，各自可能被密码锁着。
- **拔出钥匙**：已计算出的码继续有效到周期结束；之后条目变"需要 YubiKey"状态，不要清除。
- **触碰之外的"用户在场"**：触碰是 YubiKey 提供的、CDP 脚本伪造不了的信号（和 WebAuthn 用户验证类似，mcp-feasibility 里讨论过 WebAuthn 不可伪造的性质 S28）。但不勾选"需要触碰"的凭据没有这个保护。

### 3.3 数据模型

现有模型（`core/vault/model.ts`）要点：条目有 `secret`（规范 base32）、`type: "totp"|"hotp"`、`counter` 取最大值合并；**`secret === ""` 表示"已清除（purged）"，`isAlive()` 对它返回 false**。所以：

- **不能用空 `secret` 表示"种子在钥匙里"**，否则条目会被当作已删除。需要新的字段或种类，例如 `source: "software" | "yubikey"`，`yubikey` 条目带 `{ deviceId, credId, touch, type, algorithm, digits, period }` 作为**显示用**元数据，不带 `secret`。
- **引用是可移植的，钥匙不是。** 同步后，在没有这把钥匙的设备上，条目必须显示为"需要 YubiKey"，不是错误、不是空白；合并规则照旧（内容寄存器 LWW），HOTP 计数器不再参与合并。
- **`deviceId` 在钥匙 RESET 后改变**（§1.1），所以引用要允许"重新关联"（按凭据名匹配），不要把 `deviceId` 当永久主键。
- **去重**：导入的去重（`import/dedupe.ts`）要按 `(deviceId, credId)`，不能按种子。
- **备份/导出**：加密备份与明文导出里这些条目只有引用，**必须在文件里和界面上明确写"此条目的种子不在备份里"**；导入到没有这把钥匙的环境，条目显示为"需要 YubiKey"。
- **永不丢数据**：钥匙里的种子无法备份。设计上至少要：(1) B 的写入流程默认"同时保留软件副本"，把"只存钥匙"放在带明确确认（"钥匙丢失或重置后无法恢复，请确认你有网站的恢复码"）的高级选项里；(2) 如果用户选了只存钥匙，要求他先确认已保存网站的恢复码，Yubico 的官方备份建议是"为第二把钥匙保留 QR 或密钥"（S3）；(3) 永远不暴露 `DELETE` 与 `RESET`（见 §3.5）。

### 3.4 应用密码（VALIDATE）

- 密码从哪来：用户输入；`derive_key` = PBKDF2（1000 轮，盐为 SELECT 返回的 ID）→ 16 字节访问密钥（S1、S4）。**这个 KDF 很弱**（1000 轮），所以抓到一次 `VALIDATE` 的挑战应答的人可以离线猜密码。
- 怎么存：像 Yubico Authenticator 一样存的是**派生后的 16 字节访问密钥，不是密码**（S6）。在 Sixkey 里应该放进保险库里（和种子同级加密），不要放进 `storage.local` 明文。保险库锁着时不能自动解锁钥匙。
- 无密码的钥匙：任何本机进程都能 `PUT/DELETE/RESET`。界面应该提示用户设置应用密码，Yubico 也 "highly recommends" 设置（S3）。

### 3.5 威胁模型变化（针对本机程序形态）

| 威胁 | 后果 | 对策 |
|---|---|---|
| 页面脚本或 CDP 进程（A10）调用宿主 | 能对未设"需要触碰"的凭据算出**任意时间窗口**的码（钥匙对任意挑战应答，S4/S6）；能 `RESET` 清空钥匙 | 宿主只实现白名单指令：SELECT、VALIDATE、LIST、CALCULATE ALL、CALCULATE。**第一版不实现 PUT、DELETE、RESET、SET CODE、RENAME**；写入只在专门的设置标签页、每次都要用户确认的流程里加 |
| 本机其他进程伪装成宿主或抢占宿主清单 | 能骗扩展给假码（影响小）或截获 `VALIDATE` 的访问密钥 | 用户级清单优先于系统级的问题见 mcp-feasibility B7 [转录]；扩展无法核验被启动的二进制 |
| 种子传给钥匙（B）要经过宿主进程 | 种子以明文经过 stdio 和宿主的内存。**没有离开这台机器**，符合"不以明文离开机器"的字面，但新增了一个必须被信任的二进制 | 这就是 B 要最后做的原因之一 |
| 未锁的钥匙被别的程序读 | 与 Yubico Authenticator 同样的暴露面 | 设置应用密码 |

**CSP**：`connect-src 'none'` 不管 `connectNative`（[推断]，未实测），所以零网络承诺字面上仍成立，但 `check-dist.mjs` 的权限白名单（`PERMISSIONS_ALLOWED`、`OPTIONAL_ALLOWED`）要改，PRIVACY.md 与 SECURITY.md 的权限表也要加（本地检查）。

### 3.5b C（PRF）的要点

PLAN Phase 3 和 ux-study 已有详细设计（RP ID 共享、每个安装随机 salt、PRF 包裹放配置文件副本里没用的性质、主密码永远保留，S28）。这里补充本次核实到的：

- Yubico 的 PRF 开发指南（"as of mid-2025"）：任何 **YubiKey 5 系列或 YubiKey Bio 系列**支持（需 FIDO2）；Windows 11 上 Windows Hello 本身不支持 hmac-secret，但 YubiKey 可以；macOS 15+ 上 Chrome 可用 YubiKey 但 Safari 不行；强烈建议注册多把钥匙，每把钥匙各自包裹同一个数据密钥（S23 [转录]）。
- 固件：hmac-secret 从 5.2 起；5.8 起有 hmac-secret-mc，创建时一次触碰就返回（此前是创建 + 取值两次）（S24 [摘要]）。
- **CDP 能做什么**：脚本伪造不了真实认证器的 PRF 输出，但 CDP 的 WebAuthn 域可以在**注册（enrollment）时**换成虚拟认证器（S28 引 mcp-feasibility B5 [转录]）。注册只发生在已解锁状态，所以这属于 SYNC-DESIGN 的 A10（解锁期间几乎不设防），不改变 A10 一行的结论；PRF 解锁的价值在"锁定后"：配置文件副本和锁定状态下的 CDP 进程拿不到认证器。
- **分叉与旧内核**：PRF 需要 Chrome 116+，用 host 权限声明 RP ID 需要 122+（S28 引 ux-study U1、C23）。指纹浏览器内核版本见 ux-study "最低版本" 一节（Multilogin 154、Orbita 148、SunBrowser 约 150–151、Dolphin 138、BitBrowser 134，VMLogin 109 装不上），建议 PRF 做成"检测到才出现"，不抬高最低版本 120。**蓝色 Security Key 系列没有 OATH，也不能保证有 PRF**，我没核实 [未核实]，要做特性检测。
- 与 ux-study 一致：PRF 要在标签页/窗口里调用，Chrome 156 起对话框会强关弹窗（S28）。

---

## 4. 可行性与建议（问题 4）

### 4.1 谁真的需要

| 人群 | 需求 | 评论 |
|---|---|---|
| 已经在用 YubiKey OATH + Yubico Authenticator 的人 | 在浏览器里一键复制，不想打开另一个应用 | 真实存在，但这些人已有可用工具 |
| 安全敏感用户 | 种子不进软件 | 与 Sixkey 作为"保险库 + 同步"的定位冲突：同步需要种子在保险库里 |
| 企业 / 受管环境 | 强制硬件 | 企业用 FIDO2/智能卡登录，不是个人 2FA 管理器；也不是当前目标（"一个账户 = 一个人"） |
| 想用钥匙代替输入主密码的人（C） | 更方便也更安全 | 需求更宽，也是 PLAN 已定的方向 |

### 4.2 逐项建议

- **A：现在不做。** 工作量 L。重开的条件（满足任意一条）：(1) Chrome 桌面稳定版把 Web Smart Card API 开给扩展或普通页面（现在仅 IWA 且桌面未发布）；(2) 有明确需求证据（评分/反馈里反复出现），且所有者接受"可选 `nativeMessaging` + 单独下载的本机程序"这个形态；(3) 同时 MCP 调研的 Q4 也被重议（它们共享同一个形态和同一套安装成本，可以合并评估）。重开时先做只读（不含 PUT/DELETE/RESET）。
- **B：不做。** 两难（§0）+ `PUT` 静默覆盖 + `RESET` 无鉴权 + 种子要经过宿主。**文档替代**：帮助页写明"想让种子也放进 YubiKey，请在添加账户时用 Yubico Authenticator 扫同一个二维码"；Sixkey 里已有的导出能给出种子用于手动迁移 [未核实：现有导出是否含 `otpauth://` 行，没有读导出代码]。方向是单向的（Sixkey → YubiKey 可以，YubiKey → Sixkey 不可能）。
- **C：Phase 3 按计划做**，M。前置：Phase 1 的 host 权限（RP ID）、设置页做调用容器、主密码永远保留。先跑 §5 的原型。

### 4.3 竞品

| 产品 | 做法 | 来源 |
|---|---|---|
| Yubico Authenticator | 桌面（Windows/macOS/Linux）与 Android，iOS 是独立仓库；没有浏览器扩展 | S8（仓库描述 "for Desktop (Windows, macOS and Linux) and Android"）[复核]；浏览器扩展：没有找到 [摘要] |
| Bitwarden | YubiKey OTP 作为 **Bitwarden 账户的二次验证**（付费计划，最多五把）；不是 OATH 存储 | S26 [摘要] |
| 1Password | 安全密钥（U2F/FIDO）作为账户二次验证；另有一页教用户用 Yubico Authenticator 当 TOTP 验证器 | S26 [摘要] |
| Aegis、Authy | 我没有找到它们支持 YubiKey OATH 的证据 | [未核实] |
| KeePassium、PanicVault 等 | 用 OTP 槽位的 HMAC-SHA1 挑战应答做库解锁 | S26 [摘要] |
| 浏览器内 OATH | Firefox 上只有基于 `ykman` + 本机消息的小项目；Chrome 上没有找到 | S25 [摘要] |

**没有一个主流产品在浏览器里提供 YubiKey OATH。** 这与 §2 的结论吻合，也说明这不是一个"别人都有、我们缺"的功能。

### 4.4 许可证与复用

| 对象 | 许可证 | 依据 |
|---|---|---|
| yubioath-flutter | **Apache-2.0**（`LICENSE` 全文是 Apache 2.0；GitHub API 识别为 `apache-2.0`；`oath.py` 文件头也是 Apache 2.0） | S8 [复核] |
| yubikey-manager（ykman + yubikit Python） | **BSD-2-Clause**（`COPYING` 是 BSD 两条款） | S9 [复核] |
| yubikit-android、yubikit-ios、yubikit-swift、yubioath-ios | Apache-2.0 | S10 [复核] |
| **`ykneo-oath`（YubiKey NEO 上的 OATH applet 源码）** | **GPL-3.0**，已归档 | S10 [复核] |
| **`yubioath-desktop-dpkg`（旧桌面版的打包）** | **GPL-3.0**，已归档 | S10 [复核] |
| YKOATH 协议规范页（developers.yubico.com） | 仓库 `Yubico/developers.yubico.com` 在 GitHub 上没有声明许可证（API 返回 `license: None`），页面上也没有许可说明 | S10 [复核]；页面本身 [转录] |
| 依赖：`pyscard` | LGPL（我没有核实具体版本条款） | [未核实] |

**含义**：

- Apache-2.0 与 BSD-2 都是宽松许可证，可以用于 MIT 或专有项目；义务是保留版权/许可声明，Apache 还要求标注改动、附 NOTICE（若有）、并带专利终止条款。yubioath-flutter 顶层目录里没有 NOTICE 文件（S8 目录列表）。我不是律师，这是一般性说明，不构成法律意见。
- **危险的是 GPL-3.0 那几个仓库**，不能复制进去。
- 协议本身是公开文档，指令码、标签、AID 是接口事实；规范页没有许可证，**不要照搬页面文字**。
- 就体量而言，YKOATH 客户端的核心很小：S4 整个文件 566 行，其中真正的协议是 `SELECT/LIST/CALCULATE/CALCULATE ALL/VALIDATE` 几个 APDU 加 TLV 打包；难的不是 APDU，而是传输通道（§2）。

**推荐的安全路线**：**按公开规范自行实现（clean-room）**，把 ykman 只当**测试对照**（在测试里运行它、比较输出，不链接、不复制其代码）。如果将来做本机程序，宿主用 Rust/Go 直接调系统 PC/SC，避开 `pyscard`（LGPL）与 Python 运行时打包。直接引用 yubikit（BSD/Apache）在法律上可行，只是要带声明，但换来的东西很少。商标："YubiKey"、"Yubico"只作指称性使用，不用其标志 [Yubico 品牌规范未核实]。

---

## 5. 最小实验（问题 5）

### 5.1 给 A/B 的"确认性"探针（半天，预期全是否定结果）

**目的**：在真实机器上确认 §2 的源码结论，留下带 Chrome 版本号的截图，防止以后再有人重复提出。

**需要**：Chrome 稳定版（记下版本）、Windows/macOS/Linux 各一台、一把 YubiKey 5（固件 5.2 以上，最好 5.7+，里面存一个普通 TOTP 和一个触碰 TOTP，用 Yubico Authenticator 建好）、一把蓝色 Security Key（对照）、一个**不在黑名单、非受保护类**的 USB 设备（如 Arduino 或手机调试模式），用来证明探针代码本身没写错。

**做法**：在开发清单里加一个**不随发布包出货**的页面 `options/probe.html`（只在 `manifest.dev.json` 引用；`check-dist` 不放行它）。每个按钮在点击回调里执行（`requestDevice` 需要用户手势，不能放 service worker，S20）：

1. `'smartCard' in navigator`，预期 `false`。
2. `navigator.usb.getDevices()` 与 `navigator.usb.requestDevice({filters: []})`：预期 YubiKey 不出现在选择器里；对照设备出现。
3. 取消黑名单这一变量的办法：无法在稳定版里取消，所以只用上面两步把"设备黑名单"这一层定位清楚；**不要**去改 Chrome 标志位（`UnrestrictedUsb` 需要 IWA，改了也与扩展无关）。
4. `navigator.hid.requestDevice({filters: [{vendorId: 0x1050}]})`：预期选择器为空。
5. 记录每一步的错误名称与信息：预期 `NotFoundError`（选择器没有设备）、或 `SecurityError: The requested interface implements a protected class.`（若设备以某种方式出现）。

**判定**：
- 全部为否定 → **A、B 在扩展里 NO-GO**，结论定稿；
- 若 YubiKey 出现在 WebUSB 选择器、并且 `claimInterface(CCID 接口号)` 成功、`transferOut` 一条 `SELECT A0000005272101` 的 CCID 封装返回 `9000` → 重开 A，先做极小的 WebUSB 实现，再评估各操作系统的驱动占用情况（Windows 最可能失败）。我预计不会发生。

### 5.2 真正值得花一天的：C 的 PRF 原型（PLAN Phase 3 本来就要求先做）

**目的**：决定 Phase 3 的范围和最低要求。

**做法**：`options/probe-prf.html`（同样只在开发清单里）：

1. 在**标签页**里调用 `navigator.credentials.create({publicKey: {... extensions: {prf: {eval: {first: salt}}}}})`，RP ID 先用扩展默认的（扩展 ID），不需要 host 权限；然后再验证 Phase 1 计划的 `sixkey.app` + host 权限那条路（Chrome 122+，S28 引 C23）。
2. 读 `getClientExtensionResults().prf`：`enabled`、`results.first`（32 字节）。再用 `navigator.credentials.get` + `allowCredentials` 取一次，确认**同一个 salt 得到同一个输出**。
3. 记录：触碰次数（5.2–5.7 创建与取值各一次；5.8+ 的 hmac-secret-mc 可能创建时就返回）、是否要 PIN、选择器样式。
4. 用 PRF 输出做 HKDF → 包裹一个测试 VK，换一把钥匙重做，验证"每把钥匙一个独立包裹、任意一把都能解开"。
5. **UX 验证**：同样的调用分别从弹窗和标签页发起，确认弹窗被强关的版本（Chrome 156+，S28）。
6. 平台矩阵：Windows 11、macOS、Linux，各配 YubiKey 5（固件 5.2–5.7 与 5.8 各一把，若有）和蓝色 Security Key（预期失败，用来做特性检测）。

**判定（GO）**：至少在 Windows 与 macOS 上，YubiKey 5 的 `prf.results.first` 稳定可取；从扩展标签页调用成功；RP ID 声明方式可行。**NO-GO / 缩小范围**：任一主流平台取不到 PRF，则 C 只作为"检测到才出现"的可选项，不进入宣传。

---

## 6. 给所有者的问题

| # | 问题 | 建议 |
|---|---|---|
| 1 | 你要的是哪一个：A（在 Sixkey 里看 YubiKey OATH 里的码）、B（把种子写进 YubiKey）、还是 C（用 YubiKey 解锁保险库）？ | **C**。A/B 在 Chrome 里只能靠新权限加本机程序，与 §13 冲突；C 与现有承诺相容，PLAN 已列 Phase 3 |
| 2 | 如果将来需求证据充分，你是否愿意为 A（以及 MCP "交接"）接受**可选** `nativeMessaging` 加一个**单独下载**的本机程序，也就是推翻 §13 的"只是一个扩展"？ | **现在不推翻**。把 A 和 MCP 交接放在同一个"本机程序"决策里一并重议，触发条件见 §4.2 |
| 3 | 现在要不要写一页帮助文档（"Sixkey 与 YubiKey 怎么搭配"：Yubico Authenticator 管 OATH、Sixkey 的 PRF 解锁、种子单向迁移）？ | **要**，零代码、零权限，也让用户的期待和实际能力对齐 |
| 4 | Phase 3 之前，是否先做 §5.2 的 PRF 一天原型？ | **做**。它同时决定 Chrome 156 弹窗强关、RP ID、多钥匙包裹的最终设计 |

---

## 7. 来源

标记：**[复核]** 我取回了原文并自己读过；**[转录]** 只通过另一个来源看到（包括 WebFetch 的转述摘要，其内容由小模型根据原页面生成，不是我逐字读到的）；**[摘要]** 只有搜索结果摘要；**[未核实]** 没有找到可核对的来源。Chromium 源码读自 GitHub 镜像 main，取于 2026-10-16。

| ID | 来源 | 用于 | 标记 |
|---|---|---|---|
| S1 | https://developers.yubico.com/OATH/YKOATH_Protocol.html | 指令、标签、触碰/只增属性、SET CODE、AID、"USB（CCID）或 NFC"、PUT 语义 | [复核]（原页面取回并解析） |
| S2 | https://docs.yubico.com/hardware/yubikey/yk-tech-manual/yk5-apps-oath.html | 容量 64/32、"only be accessed through the CCID channel" | [转录]（WebFetch 转述） |
| S3 | https://docs.yubico.com/software/yubikey/tools/authenticator/auth-guide/oath.html | 添加流程、触碰选项、密码、重置、"secrets always stay within the YubiKey"、备份建议 | [转录]（WebFetch 转述） |
| S4 | https://raw.githubusercontent.com/Yubico/yubikey-manager/main/yubikit/oath.py | OathSession API、凭据名格式、device_id、validate、calculate_all、SCP | [复核] |
| S5 | https://raw.githubusercontent.com/Yubico/yubikey-manager/main/yubikit/management.py | `CAPABILITY.OATH` → `USB_INTERFACE.CCID` | [复核] |
| S6 | https://raw.githubusercontent.com/Yubico/yubioath-flutter/main/helper/helper/oath.py | helper 结构、密钥记忆、触碰超时、任意挑战 | [复核] |
| S7 | https://raw.githubusercontent.com/Yubico/yubioath-flutter/main/lib/oath/models.dart 与 `lib/oath/views/add_account_page.dart` | 容量判断、触碰/算法选项 | [复核] |
| S8 | https://github.com/Yubico/yubioath-flutter（含 `LICENSE`、`NEWS`、`helper/pyproject.toml`、`android/app/build.gradle`、GitHub API 元数据） | Apache-2.0、发布 7.4.2（2026-09-09）、依赖与结构 | [复核] |
| S9 | https://github.com/Yubico/yubikey-manager（`COPYING`、`pyproject.toml`、API） | BSD-2-Clause、依赖、最新发布 5.9.2（2026-06-30） | [复核] |
| S10 | https://api.github.com/orgs/Yubico/repos | 各仓库许可证；`ykneo-oath`、`yubioath-desktop-dpkg` 为 GPL-3.0；`developers.yubico.com` 无许可证；无 JS 版 yubikit | [复核] |
| S11 | https://usb.spec.whatwg.org/ （原 wicg.github.io/webusb 重定向） | 受保护接口类表 | [复核]（下载到一半超时，受保护类一节已读到） |
| S12 | https://raw.githubusercontent.com/chromium/chromium/main/content/browser/usb/web_usb_service_impl.cc | `GetProtectedInterfaceClasses`、`UnrestrictedUsb` 条件 | [复核]（源码 main） |
| S13 | https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/usb/chrome_usb_delegate.cc | 扩展对受保护类的处理：Chrome Apps 与 ChromeOS HID 白名单；第 333–343 行：黑名单检查与 IWA `usb-unrestricted` 绕过 | [复核]（源码 main） |
| S14 | https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/usb/usb_blocklist.cc ；https://raw.githubusercontent.com/WICG/webusb/main/blocklist.txt | Yubico VID 0x1050 黑名单（两处内容一致，逐行读过） | [复核]（源码 main） |
| S15 | https://raw.githubusercontent.com/chromium/chromium/main/services/device/usb/mojo/device_impl.cc | `kProtectedClass` | [复核]（源码 main） |
| S16 | https://raw.githubusercontent.com/chromium/chromium/main/services/device/public/cpp/hid/hid_blocklist.cc | WebHID 黑名单 | [复核]（源码 main） |
| S17 | https://raw.githubusercontent.com/chromium/chromium/main/content/browser/smart_card/smart_card_service.cc ；`third_party/blink/renderer/modules/smart_card/navigator_smart_card.idl` ；`third_party/blink/renderer/platform/runtime_enabled_features.json5` ；`content/public/browser/isolated_context_util.cc` | Smart Card API 门槛与默认状态、`UnrestrictedUsb` | [复核]（源码 main） |
| S18 | https://github.com/WICG/web-smart-card （README） | "recommended ... only to Isolated Web Apps" | [复核] |
| S19 | https://chromestatus.com/api/v0/features （条目 6411735804674048、5141169477648384、5106506475503616、5200265459269632） | Smart Card API 桌面 143 开发中；Unrestricted WebUSB；扩展 SW 中的 WebUSB（Chrome 118） | [复核]（API 返回） |
| S20 | https://developer.chrome.com/docs/extensions/how-to/web-platform/webusb | 扩展用 WebUSB：无需权限、`requestDevice` 不能在 SW 中调用 | [转录]（WebFetch；页面更新于 2024-02-14） |
| S21 | https://www.yubico.com/support/issue-rating-system/security-advisories/ysa-2018-02/ | 2018 年 WebUSB 访问 CCID 的事件与修复时间线 | [转录]（WebFetch） |
| S22 | https://support.google.com/chrome/a/answer/9367354 | "IWAs are supported only on ChromeOS" | [转录]（WebFetch；页面日期未显示，与 CVE 摘要有出入，见 §2.1） |
| S23 | https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html | PRF 支持矩阵、多钥匙建议 | [转录]（WebFetch；页面标注 "as of mid-2025"） |
| S24 | https://docs.yubico.com/hardware/yubikey/yk-tech-manual/yk5-firmware-5.7.html 及 https://yubico.com/blog/now-available-for-purchase-yubikey-5-series-and-security-key-series-with-new-5-7-firmware | 64 个 OATH、hmac-secret 5.2、hmac-secret-mc 5.8 | [摘要] |
| S25 | https://github.com/Levitator1/oath-wallet ；https://github.com/molecular/yubikey-otp-helper | Firefox 上基于 `ykman` + 本机消息的项目 | [摘要] |
| S26 | https://bitwarden.com/help/setup-two-step-login-yubikey/ ；https://support.1password.com/security-key/ ；https://support.1password.com/cs/yubikey-totp ；https://support.keepassium.com/kb/yubikey-setup/ ；https://www.panicvault.org/help/hardware-keys/ | 竞品做法 | [摘要] |
| S27 | https://chrome.google.com/webstore/detail/khpfeaanjngmcnplbdlpegiifgpfgdco ；https://support.google.com/chrome/a/answer/7014689 | ChromeOS Smart Card Connector 只是 ChromeOS 组件 | [摘要] |
| S28 | 本仓库：`docs/history/PLAN-zh.md`（Phase 3）、`docs/security/local-vault.md`、`docs/PRIVACY.md`、`docs/SYNC-DESIGN.md` §1.2、§13、`docs/research/mcp-feasibility.md`（B3、B6、B7、B8、Q4）、`docs/research/ux-study.md`（C7、C17、C23、U2、U13）、`extension/scripts/check-dist.mjs`、`extension/src/core/vault/model.ts`、`extension/manifest.base.json` | 产品承诺、既有决定、既有引用 | [复核]（本仓库文件）；其中转引的外部条目（B3、B6、B7、B8、C7、C17、C23）在本报告里一律按 [转录] 对待 |
| S29 | https://groups.google.com/a/chromium.org/g/blink-dev/c/LZXocaeCwDw/m/GLfAffGLAAAJ （Intent to Implement and Ship: WebUSB Interface Class Filtering） | 类过滤的由来；Windows 上 INF 绕过不再可行 | [摘要] |

---

## 8. 没有核实的

- 在真实 Windows、macOS、Linux 上，Chrome 稳定版选择器是否真的不列出 YubiKey（只读了源码 main；没有硬件，没有跑）。这正是 §5.1 的探针要确认的。
- 操作系统 CCID 驱动占用接口这一层，没有找到官方文档，是推断。
- 扩展页面是否一定不满足 `kIsolatedApplication`：由源码推断，无官方明文。IWA 在桌面 Windows/macOS/Linux 上对普通用户是否可装，来源互相有出入（S22 与 CVE 摘要）。
- WebUSB 设备选择器是否被 Chrome 156 的"安全对话框强关弹窗"规则覆盖。
- 凭据名（issuer+name）的精确字节上限；位数 UI 的取值范围。
- `connectNative` 是否不受 CSP `connect-src` 约束（按我对 Chrome 的理解成立，没有实测）。
- 各 Chromium 分叉与指纹浏览器查找原生消息宿主清单的位置。
- 蓝色 Security Key 系列是否有 PRF；FIPS 系列的 OATH 容量。
- Aegis、Authy 是否支持 YubiKey OATH。
- 现有 Sixkey 导出文件是否含 `otpauth://` 行（没读导出代码）。
- Yubico 品牌使用规范；`pyscard` 的具体许可证条款；任何许可证结论都不是法律意见。
