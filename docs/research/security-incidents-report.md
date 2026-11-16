# Sixkey 安全事件与研究调研报告（2019–2026）

调研日期：2026-10-15。范围：TOTP/2FA 被盗或绕过、密码管理器与验证器厂商事件、浏览器扩展安全、密码学实现与算法演进、同步与账号恢复。

**方法与约定**
- 每条案例均经 WebSearch/WebFetch 查证，附来源链接。日期只写来源中实际出现的年月（能到日则到日）。
- 标注「未核实」的条目：只有二手报道或摘要，未能看到一手来源，或来源内部互相矛盾。
- 没有查到可靠来源的类别或子项，明确写「未找到可靠来源」，不编造。
- 对 Sixkey 的判断依据：`docs/security/local-vault.md`（Phase 0 实际实现）与 `docs/history/PLAN-zh.md`（设计，含 Phase 1 同步）。两者只读，未修改。

---

## 摘要

1. **2FA 码本身越来越不是最后防线。** 2022 年起的 AiTM 钓鱼（Microsoft 报告超 1 万家机构）和会话 cookie 窃取可绕过 MFA，验证码和会话都不能只靠"有第二因子"来保护。
2. **服务端数据被拖库后，离线破解主密码是现实威胁。** LastPass 2022 年事件中，攻击者拿到加密金库备份，PBKDF2 迭代数被公开批评。Sixkey 的同步设计（服务器存密文、wrapped_keys、KDF 参数）面临同样的威胁模型。
3. **浏览器扩展供应链攻击反复发生。** Cyberhaven（2024-12）通过钓鱼 + 恶意 OAuth 应用拿到开发者账号，发布恶意更新；OX Security 报告 2025-12 有两个扩展偷聊天记录，约 90 万用户。Sixkey 的 CSP `connect-src 'none'` 能限制外传，但挡不住恶意更新本身。
4. **服务端可以替换公钥或丢弃/回放消息。** 2026 年 WOOT 论文证明 Session 协议缺少双向公钥认证。Sixkey 当前同步是对称加密，但若将来加入多设备配对，就会出现同样的问题。
5. **密码学基础本身稳定，实现错误才是高发点。** SHA-1 已被实际碰撞（2020），Java ECDSA 的零签名漏洞（CVE-2022-21449）和 Kyber 的时序泄露（KyberSlash，2024）都是实现问题。后量子标准 FIPS 203/204/205 已于 2024-08 发布，HQC 于 2025-03 入选。
6. **账号恢复与服务台是最便宜的攻击面。** MGM 与 Caesars 的服务台社工（2023）、Coinbase 的客服内鬼（2025）说明：只要恢复流程能重置凭据或转移 MFA，加密强度再高也没用。
7. **Sixkey 已有的缓解：** 本地 AES-256-GCM、600k PBKDF2、50 bit 密码强度门槛、无 host 权限、无内容脚本、零网络 CSP 强制、剪贴板自动清空。**主要暴露面：** 设备密钥模式（无主密码）、解锁后内存中的 VK、同步的邮箱 OTP 恢复链路、服务端可回滚或删除密文。
8. **需要立即决策的一项：** 是否要求"在添加第一个账户前设置主密码"（PLAN/SECURITY 都已列为未决项）。这是唯一能彻底关闭"旧设备密钥残留"的办法，但会增加首次使用门槛。

---

## 案例表

### A. TOTP/2FA 被盗或被绕过

| 日期 | 事件 | 攻击手法 | 影响 | 来源链接 | 对 Sixkey 的启示 |
|---|---|---|---|---|---|
| 2022-07-12（Microsoft 博文日期） | Microsoft 披露大规模 AiTM 钓鱼活动 | 反向代理（Evilginx2 类工具）在用户与真实登录页之间中转，同时截获密码和登录后的会话 cookie，无需再次通过 MFA | 微软称该活动试图攻击超过 1 万家机构，自 2021 年 9 月起；被用于邮箱访问与 BEC 诈骗 | https://www.microsoft.com/en-us/security/blog/2022/07/12/from-cookie-theft-to-bec-attackers-use-aitm-phishing-sites-as-entry-point-to-further-financial-fraud/ | 2FA 码只证明"此刻持有 Authenticator"，对 AiTM 无效。Sixkey 无法阻止用户在假站输入 6 位码；可做的是域名匹配提示（PLAN 第 9 节已有 domains 后缀匹配）与"不要在非匹配域名填码"的提示。 |
| 2022-09-19（Uber 8-K 附件日期） | Uber 内部系统被入侵 | 承包商的密码疑似在个人设备感染恶意软件后被购买；攻击者对其持续发送 2FA 推送直到其点击同意（MFA fatigue）；随后获取 G-Suite、Slack 等内部工具权限 | 内部系统被入侵，攻击者在公司 Slack 发消息、修改内部站点 DNS | https://www.sec.gov/Archives/edgar/data/1543151/000155278122000558/e22427_ex99-1.htm | 推送式 MFA 可被疲劳攻击。Sixkey 不依赖推送，但同步账号若采用邮箱 OTP，也要防止"邮件轰炸"式的 OTP 请求（见 E 类）。 |
| 2023-10（Okta 调查记录期 2023-09-28 至 2023-10-17） | Okta 客服系统被入侵，客户 HAR 文件被访问 | 攻击者使用客服系统中保存的服务账号凭据（该凭据被同步进员工个人 Google 账户）访问支持案件；HAR 文件含有 session token 可用于会话劫持 | 涉及 134 名客户（不到 1%）；5 名客户的会话被劫持（据 Okta 后续报告，未二次核实） | https://sec.okta.com/articles/2023/11/unauthorized-access-oktas-support-case-management-system-root-cause/ ；https://sec.okta.com/articles/2023/10/tracking-unauthorized-access-oktas-support-system/ | 用户为排障而分享的诊断文件（HAR、日志）可能含有会话令牌。Sixkey 的"导出诊断/反馈"功能若出现，必须自动剥离 cookie、token、secret。 |
| 2023-10-24（媒体报道日期） | 1Password 因 Okta 事件受影响 | 攻击者使用 1Password 员工在支持对话中上传的 HAR 文件（含会话 cookie）访问 Okta 管理后台 | 1Password 称未发现用户数据受访问（据其 CTO 表述，二手报道） | https://www.helpnetsecurity.com/2023/10/24/1password-okta-support-breach/ | 同上，且说明"第三方服务的支持流程本身就是攻击面"。 |
| 2024-07-01（Twilio 变更日志日期） | Twilio Authy 未认证 API 允许枚举手机号 | 未认证端点可对号码列表逐个查询，有效号码返回关联的 Authy 账户信息（枚举） | Twilio 确认修复端点；称账户未被入侵，但存在钓鱼/短信钓鱼风险。"3300 万号码"是威胁者在论坛上的声称，**未经证实** | https://www.twilio.com/en-us/changelog/Security_Alert_Authy_App_Android_iOS ；二手报道：https://www.malwarebytes.com/blog/news/2024/07/authy-phone-numbers-accessed-by-cybercriminals-warns-twilio | 验证器的"账户-手机号"关联是高价值的枚举目标。Sixkey 若同步需要手机号或邮箱，应避免提供可枚举的注册/找回接口（统一返回、限流）。 |
| 2025-05-21（Microsoft 博文日期） | Lumma 信息窃取木马被协同打击 | Lumma（MaaS，2022 起）窃取浏览器凭据、cookie、加密钱包，并把 2FA 扩展列为目标；Darktrace 报道其针对 Authenticator 类扩展 | 微软称 2025-03-16 至 05-16 期间识别出超过 39.4 万台 Windows 感染；约 2300 个域名被处置（Microsoft 博文原文） | https://blogs.microsoft.com/on-the-issues/2025/05/21/microsoft-leads-global-action-against-favored-cybercrime-tool/ ；Darktrace 报道：https://darktrace.com/blog/the-rise-of-the-lumma-info-stealer | 同机恶意软件能读取浏览器可见的数据。Sixkey 在"解锁状态"下对此无防护（SECURITY.md 已明确写出）。Lumma 被打击后又恢复（二手报道，未核实）。 |
| 2024-02（Krebs 报道） | 佛州男子因 SIM 换卡被控，报道关联 FTX 相关盗币 | SIM 换卡（SIM swap）：通过运营商或社工把受害者号码转移到攻击者 SIM | Krebs 报道的标题称涉及约 4 亿美元级盗窃（仅据标题，**具体金额未核实**） | https://krebsonsecurity.com/2024/02/arrests-in-400m-sim-swap-tied-to-heist-at-ftx/ | Sixkey 不依赖 SMS，SIM 换卡对本地 TOTP 无效。但若同步账号的找回依赖手机号，就会被 SIM 换卡打穿，因此同步不应以手机号为找回因子。 |

**A 类未找到可靠来源的子项：** 「验证器种子（secret）被泄露」的具体公开事件、Vidar/Raccoon 针对 2FA 扩展的专门报道、FBI 关于运营商账户接管的专门警告。

### B. 密码管理器与验证器厂商

| 日期 | 事件 | 攻击手法 | 影响 | 来源链接 | 对 Sixkey 的启示 |
|---|---|---|---|---|---|
| 2022-08（LastPass 2022-12-22 通告中引用的"8 月事件"） | LastPass 开发环境被入侵 | 开发环境源代码与技术信息被盗，随后对另一员工社工，获取凭据和密钥，进而解密云存储卷 | 进入云存储备份环境 | https://blog.lastpass.com/posts/notice-of-recent-security-incident | 攻击者拿到的是**密钥与备份**，而非直接入侵生产库。Sixkey 的服务端备份、运维密钥、CI 密钥应分层隔离。 |
| 2022-12-22（LastPass 通告日期） | 加密金库备份被拷贝 | 备份包含金库数据，字段中部分内容（如网站 URL）未加密；敏感字段用主密码派生密钥加密 | LastPass 同时引用 **PBKDF2 100,100 次迭代**说明离线破解很难；该迭代数被批评偏低；Palant 2022-12-28 指出 100,100 只是默认值，不少老账户实际仅 5,000、500 甚至 1 次（已核实） | https://blog.lastpass.com/posts/notice-of-recent-security-incident ；批评：https://palant.info/2022/12/28/lastpass-breach-the-significance-of-these-password-iterations/ | 这是 Sixkey 同步设计的直接威胁模型（服务器存密文 + wrapped_keys + KDF 参数，PLAN 5.5）。主密码强度门槛（≥50 bit）和 600k PBKDF2 是关键防线；明文 URL 等元数据要避免进入云端。 |
| 2023-03-01（LastPass 修订通告日期） | 修订：攻击者还获取了配置数据与 API/第三方集成密钥 | 同上 | 通告称自 2022-10-26 起未再发现威胁者活动（据二手转述） | https://blog.lastpass.com/posts/security-incident-update-recommended-actions | 事件初报常被修正。Sixkey 应假设"影响范围会扩大"，并在泄露应对流程里预留迭代与撤销能力。 |
| 2023-10-24（1Password 通告，同 A 类 Okta 事件） | 验证器/密码管理器厂商受 Okta 支持事件牵连 | 见 A 类 Okta 条目 | 1Password 称无用户数据被访问 | https://www.helpnetsecurity.com/2023/10/24/1password-okta-support-breach/ | 供应商的供应商风险同样需要评估。 |
| 2023（Bitwarden 文档称"2023.2.0"，未核实具体日期） | KDF 默认迭代数上调到 600,000 | 非攻击事件。Bitwarden 帮助页称按 OWASP 建议，PBKDF2 默认 600,000 次（英文页） | 对已有账户，较新版本要求最低值并自动升级（据葡萄牙语页面，**"2026.2.1"时间点未核实**） | https://bitwarden.com/help/kdf-algorithms/ | 行业基线的演进说明：Sixkey 的 600k 与行业默认值一致，但需要有"随 OWASP 调整迭代数"的升级路径（PLAN 5.1 已有 kdf 参数版本字段，这点是对的）。 |

**B 类说明：** 「Bitwarden 2024 年安全事件」在检索中未找到任何可靠来源，故不收录。「1Password/Bitwarden 自身的独立重大泄露」未找到可靠来源。

### C. 浏览器扩展安全

| 日期 | 事件 | 攻击手法 | 影响 | 来源链接 | 对 Sixkey 的启示 |
|---|---|---|---|---|---|
| 2020-06 起；2020-10 恶意版本；2021-02 Chrome 下架 | The Great Suspender 扩展被出售后投毒 | 原作者把扩展卖给未知买家；新版本经 Chrome 商店分发，远程加载代码执行跟踪与广告欺诈（据二手报道的描述） | 超过 200 万安装；Google 以"含恶意软件"为由在 2021-02 下架并禁用 | https://thehackernews.com/2021/02/warning-hugely-popular-great-suspender.html | 扩展所有权可以转手。Sixkey 应在开源协议和商店条款中约定"所有权变更须公告且保留可审计构建"，并在用户侧可验证版本哈希（PLAN 已有公布 SHA-256 的计划）。 |
| 2024-12-24（Cyberhaven 通告所述钓鱼日期） | Cyberhaven 扩展的开发者账号被钓鱼，恶意版本 24.10.4 上架 | 攻击者发送伪造的 Chrome 商店违规警告，诱导开发者授权名为 "Privacy Policy Extension" 的恶意 OAuth 应用；利用授权上传恶意版本；恶意版本窃取 cookie 和会话 token 并外传 | 据二手报道约 40 万用户（**未核实**）；Cyberhaven 称多家公司的扩展受影响。该员工开启了高级保护和 MFA，但 OAuth 授权仍被钓鱼 | https://www.cyberhaven.com/engineering-blog/cyberhavens-preliminary-analysis-of-the-recent-malicious-chrome-extension（该链接现已 301 跳转到支持站首页，原文细节本次未能复核）| 开发者账号 MFA 不足以挡住 OAuth 授权钓鱼。Sixkey 作为 Chrome 扩展，**发布者账号必须用硬件密钥或 passkey，禁止无必要的第三方 OAuth 授权**。 |
| 2025-12-30（OX Security 博文日期） | 两个扩展偷窃 ChatGPT/DeepSeek 对话和所有标签页 URL | 扩展包装成 AI 侧边栏，隐藏地每 30 分钟把对话与 tab URL（base64 编码）发到远程 C2 服务器 | 约 60 万 + 30 万用户；报告时两个扩展仍在商店中，Google 称"在审核中" | https://www.ox.security/blog/malicious-chrome-extensions-steal-chatgpt-deepseek-conversations | 扩展有 `tabs` 或内容脚本权限即可读取页面内容。Sixkey 没有 host 权限、无内容脚本、CSP 禁止网络（已由 check-dist 强制），这是本案例的直接对照优势。 |
| 2025-12（Koi Security 报告日期） | ShadyPanda：七年期的扩展投毒行动 | 早期合法扩展长期运营后，在 2024 年中被武器化，之后通过远程执行 JavaScript（据 Koi 报告）；其中一个扩展曾被 Google 标为"Featured/Verified"（据 Koi） | Koi 称涉及 430 万 Chrome/Edge 用户；后续 DarkSpectre 报告称该威胁者关联的规模更大（**二手转述，未独立核实**） | https://www.koi.ai/blog/4-million-browsers-infected-inside-shadypanda-7-year-malware-campaign | "审核一次"不等于"永久安全"。Sixkey 发布后的每次更新都要视为潜在攻击面；应做可复现构建与发布签名校验（PLAN §11 Phase 2 已有可复现构建与公布哈希的计划）。 |
| 长期（Chrome 官方文档） | `chrome.storage.local` 不加密 | Chrome 官方文档说明 local 与 sync 存储区**不加密**，不应存放机密数据；建议敏感数据放 session 存储。Chromium 有一条报告称网页可读取扩展存储（未确认为漏洞） | 同机其他进程或恶意软件，能读到扩展在磁盘上的存储文件（文件布局未核实） | https://developer.chrome.com/docs/extensions/reference/api/storage | 这正是 SECURITY.md 中"设备密钥模式"风险的来源。Sixkey 在有主密码时用 VK 加密，存储中是密文，但"无主密码"时磁盘上的设备密钥等同明文。 |

**C 类未找到可靠来源的子项：** 「扩展窃取剪贴板内容」的专门公开案例；「MV3 权限滥用」的一手研究（SquareX 在 DEF CON 32 的演示仅见二手报道，**未核实**）。

### D. 加密算法与实现

| 日期 | 事件 | 攻击手法 | 影响 | 来源链接 | 对 Sixkey 的启示 |
|---|---|---|---|---|---|
| 2016-08（WOOT '16 / Black Hat USA 2016，背景案例） | GCM nonce 误用的伪造攻击 | 扫描互联网发现 184 台 HTTPS 服务器重复使用 nonce；另有超过 7 万台服务器使用随机 nonce，在大量数据下有重用风险（据论文摘要） | 重复 nonce 会泄露 keystream 并暴露 GHASH 认证密钥，导致伪造 | https://eprint.iacr.org/2016/475 ；https://www.usenix.org/conference/woot16/workshop-program/presentation/bock | Sixkey 每次加密使用随机 96 bit IV（SECURITY.md）。在单个 VK 下加密次数过多时会有随机碰撞风险。应记录加密次数并设上限，超限时轮换 VK（PLAN 5.4 已有轮换机制）。 |
| 2020-01（论文与 USENIX Security 2020） | SHA-1 chosen-prefix 碰撞 | 首个 chosen-prefix 碰撞，可伪造 PGP 证书；作者估算成本约 4.5 万美元（"租用 GPU 的估算"，不是实测开销） | 证明 SHA-1 在签名场景已不安全；GnuPG 旧分支受影响（CVE-2019-14855 修复） | https://www.usenix.org/conference/usenixsecurity20/presentation/leurent ；https://eprint.iacr.org/2020/014 | Sixkey 不用 SHA-1 做完整性校验，但 **TOTP 默认算法是 HMAC-SHA1**。HMAC-SHA1 对碰撞并非致命（RFC 6238 仍允许），但不应把 SHA-1 用于签名、证书指纹或内容寻址。 |
| 2020（TCHES 2020 第 4 期；月份未核实） | Minerva：ECDSA nonce 时序泄露 | 库实现泄露标量位长（timing），配合格攻击恢复私钥；被测库包括 libgcrypt、wolfSSL、MatrixSSL、SunEC/OpenJDK、Crypto++ 等 | 无统一 CVE（检索中未找到）；需 500 至 2100 次签名即可恢复私钥（依数据集不同） | https://eprint.iacr.org/2020/728 | Sixkey 不使用 ECDSA。但它说明"库里的常量时间"是需要验证的，Sixkey 若将来引入签名，应选用经过验证的实现（如 Web Crypto 原生或已验证的库）。 |
| 2022-04-19（博文日期；Oracle 4 月 CPU 修复） | CVE-2022-21449 "Psychic Signatures"：Java 15–18 ECDSA 接受零值签名 | 重写后的 Java ECDSA 漏掉了对 r、s 为零的检查，攻击者可伪造签名 | 影响 TLS 证书、JWT、SAML、OIDC 与 WebAuthn 签名验证（据 Neil Madden 博文） | https://neilmadden.blog/2022/04/19/psychic-signatures-in-java/ | 实现错误比算法弱点更常见。Sixkey 应引入 Wycheproof 类测试向量（作者称 Wycheproof 可以发现此问题）覆盖 AES-GCM、HKDF、PBKDF2 的边界输入。 |
| 2024-06（ePrint 2024/1049；TCHES 2025 最佳论文） | KyberSlash：Kyber/ML-KEM 参考实现的秘密相关除法时序泄露 | 秘密相关的除法耗时可恢复私钥（Raspberry Pi 2 与 Cortex-M4 上演示，几分钟至几小时） | 多个实现已修补；Rust 的 pqc_kyber crate 有对应公告（GHSA-x5j2-g63m-f8g4） | https://eprint.iacr.org/2024/1049 ；https://kyberslash.cr.yp.to/papers.html | 后量子实现同样会犯侧信道错误。Sixkey 目前无 PQ 算法；若将来用 ML-KEM，必须用经过审计的实现，不要自己写。 |
| 2024-08-13（NIST 官方发布日期） | 后量子标准 FIPS 203（ML-KEM）、204（ML-DSA）、205（SLH-DSA）定稿 | 标准化本身，不是攻击。NIST 官方页称 FN-DSA（FIPS 206）草案计划于 2024 年底 | 形成后量子迁移的标准依据 | https://www.nist.gov/news-events/news/2024/08/nist-releases-first-3-finalized-post-quantum-encryption-standards | Sixkey 当前的对称加密（AES-256、SHA-256、HKDF、PBKDF2）在 Grover 攻击下仍有足够余量，**不存在紧迫的 PQ 迁移需求**。PQ 迁移的压力主要在 TLS 与服务器证书层。 |
| 2025-03-11（NIST 官方发布日期） | NIST 选定 HQC 作为 ML-KEM 的备份算法 | 标准化决定，不是攻击。草案标准约一年后发布，最终标准预计 2027 年 | — | https://www.nist.gov/news-events/news/2025/03/nist-selects-hqc-fifth-algorithm-post-quantum-encryption | 对 Sixkey 无即时影响。若将来做"长期保存的云端密文"，需关注 harvest-now-decrypt-later，但对称密文本身不受量子直接威胁。 |
| 2024-11（IR 8547 草案，日期据二手报道，**未核实**） | NIST IR 8547 草案：计划 2030 年后弃用、2035 年后禁用 RSA/ECC | 标准化草案，不是攻击 | — | 一手页面未能获取。二手参考：https://www.abiresearch.com/market-research/insight/7785443-nists-intention-to-deprecate-rsa-and-ecc-w | 同上，主要影响 TLS 与证书链。 |
| 2026-08-28（hol.org 收录，**未核实，分析待证据复核**） | wolfProvider（wolfSSL 的 provider）：TLS 1.2 的 AES-GCM 显式 nonce 在建立写密钥时生成一次，之后从不递增 | 固定计数器型 nonce 复用 | CVSS 7.4；据页面描述，1.2.2 修复（页面内部信息不一致） | https://hol.org/guard/security/cves/CVE-2026-81019-wolfprovider-reuses-the-aes-gcm-nonce-on-every | 说明"nonce 状态管理"仍是高发错误。Sixkey 不使用 TLS 之外的 AES-GCM 计数器，但同步的每次写入都要确保 IV 唯一；**此条未二次核实，仅作参考。** |

**D 类其他参考（已核实但非攻击案例）：**
- OWASP 密码存储速查表（已抓取原文）：Argon2id 最低 19 MiB 内存、2 次迭代、1 并行；PBKDF2-HMAC-SHA256 推荐 600,000 次，并说明 PBKDF2 主要为 FIPS-140 环境保留；scrypt 最低 CW=2^17，r=8，p=1；bcrypt 工作因子 10。来源：https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- RFC 9106（2021-09）给出 Argon2id 的两组推荐参数（2 GiB/1 次/4 并行，或 64 MiB/3 次/4 并行）。**仅据二手资料，未抓取原文**，引用前需核对。

**D 类未找到可靠来源的子项：**
- 「随机 96 bit nonce 在真实产品中碰撞导致的泄露」的公开事件（检索中只找到计数器型错误）。
- 「PBKDF2-600k 在 RTX 4090 上的实测速率」（检索中未找到可靠的 PBKDF2-SHA256 数据点，只有 WPA-PBKDF2 和原始 SHA-256 数据，不能直接套用）。
- 「HKDF/ECDH 误用导致的真实事件」（未找到可靠来源）。

### E. 同步、服务端与账号恢复

| 日期 | 事件 | 攻击手法 | 影响 | 来源链接 | 对 Sixkey 的启示 |
|---|---|---|---|---|---|
| 2023-09 至 2023-10（MGM 8-K 日期 2023-10-05，据二手报道）；CISA 通告 2023-11-16，2025-07-29 修订 | Scattered Spider 利用服务台重置密码和转移 MFA | 冒充员工致电服务台，要求重置密码并把 MFA 令牌转移到攻击者控制的设备（CISA AA23-320A 原文） | MGM 损失约 1 亿美元（据二手报道，8-K 估计的 EBITDAR 影响）。MGM 入口的具体方式以媒体为主，**8-K 本身未说明入口** | https://www.cisa.gov/news-events/cybersecurity-advisories/aa23-320a ；媒体：https://www.computing.co.uk/news/4126034/mgm-resorts-hackers-deceived-service-desk-phone | "账号恢复"就是攻击面。Sixkey 的同步恢复若允许"换绑邮箱/换设备"而无额外验证，就等同于服务台社工。恢复码 + 主密码应是唯一的完整恢复路径（PLAN 5.1、Q2）。 |
| 2025-05-15（Coinbase 8-K 日期）；The Register 2025-05-21 | Coinbase 客服人员被贿赂，导出客户数据 | 攻击者贿赂海外客服人员复制客户数据，并勒索 2000 万美元（据报道） | 据 Maine AG 文件约 69,461 人受影响（二手报道）；Coinbase 估计处置成本 1.8 亿–4 亿美元（二手报道）。Coinbase 称密码、私钥未泄露 | https://www.theregister.com/2025/05/21/coinbase_confirms_insider_breach_affects/ | 内部人员（含客服、运维）能看到的数据应最小化。Sixkey 服务端不应让运维人员能解出用户数据（零知识，PLAN 5.5），并应对管理员访问做审计。 |
| 2026（WOOT '26 论文，eprint 2026/1247；月份未核实） | Session 消息应用：恶意服务器节点可替换公钥 | 协议缺少双向公钥认证，且消息未与单调序号做密码学绑定；恶意服务器节点或内部人员可替换公钥、丢弃或重放消息、伪造时间戳（据论文摘要） | 论文证明了攻击可行；报告作者称已在 Session 上完成实际攻击（据摘要） | https://eprint.iacr.org/2026/1247 | Sixkey 目前是对称加密，无公钥分发，不受此直接影响。**但若将来加入多设备配对、与他人共享金库，必须做指纹或 SAS 核对**，不能只信服务器下发的公钥。 |
| 2022-08 至 2023 年（AT&T 邮箱，**未核实**：仅二手报道） | 运营商邮箱被滥用于加密货币盗窃 | 攻击者在运营商侧创建了"安全邮件密钥"，可绕过密码访问邮箱，拦截重置链接和验证码（AT&T 自述，据二手报道） | 报道称受害者损失合计 1500 万–2000 万美元（**未核实**） | https://www.techradar.com/news/atandt-accounts-are-being-hacked-to-steal-cryptocurrency | 邮箱被接管后，重置链接和 OTP 都会被拦截。Sixkey 同步采用邮箱 OTP（PLAN 7.1），**邮箱接管 = 同步账号接管**（见下一项）。 |
| 2025（FBI 报告，**二手**） | 账户接管欺诈 2025 年损失约 2.62 亿美元 | 冒充银行、客服或调查人员，诱骗受害者交出登录信息和 MFA 码 | 据 expertinsights 对 FBI 报告的转述（**FBI 原文未核实**） | https://expertinsights.com/news/262-million-lost-to-account-takeover-fraud-in-2025 | 社工诱骗交出 OTP 是普遍做法。Sixkey 的提示文案应明确"任何人索要验证码都是诈骗"。 |

**E 类未找到可靠来源的子项：**
- 「服务器回滚（replay 旧版本密文）」在真实产品中被利用的公开案例。检索只找到学术方向（REBOUND，arXiv 2511.13641，通用的回滚保护设计）和二手描述的 2026 年"恶意服务器"研究（涉及 Bitwarden、Dashlane、LastPass，**未核实原文**）。
- 「密钥目录被替换（MITM 公钥替换）」在密码管理器中的真实事件；现有的只有 E2EE 消息应用的学术研究。
- 「Google Password Manager 的 VaultJacking」（二手报道，**未核实**）。

---

## 对 Sixkey 的威胁映射

判定：**已缓解** = 设计与实现已覆盖且有测试；**部分缓解** = 有防线但有残余或依赖用户；**暴露** = 当前设计不防或未决。

### A 类：TOTP/2FA 被盗或绕过

| 威胁 | 判定 | 依据 |
|---|---|---|
| AiTM 钓鱼获取会话 | 不适用（Sixkey 不做网站登录） | Sixkey 只生成码，不持有网站会话。用户仍可能把码输入到假站。 |
| 用户把码输入假站 | **部分缓解** | PLAN §9 的域名后缀匹配可帮助用户识别，但无法阻止用户主动输入。 |
| 同机恶意软件读取解锁后的码与种子 | **暴露** | SECURITY.md："Malware running as the user, browser open and unlocked — No. It can read what the browser can."。 |
| 同机恶意软件读取无主密码的设备密钥 | **暴露** | SECURITY.md 表格第 2 行明确"No"。 |
| 剪贴板被其他应用读取 | **部分缓解** | 30 秒自动清空（仅在剪贴板未被替换时）；剪贴板历史工具仍可能保留（SECURITY.md 已写明）。 |
| SIM 换卡 | 不适用 | Sixkey 不依赖 SMS 作为第二因子。但**同步的找回若依赖手机号，则会暴露**（见 E）。 |
| 推送疲劳攻击 | 不适用 | Sixkey 无推送。 |
| 种子泄露（导出、截图、迁移二维码） | **部分缓解** | 加密备份（独立密码，PLAN §9）；明文导出带强警告（PLAN 第 9 节、SECURITY.md）。明文导出仍然**暴露**，属于设计上的取舍。 |

### B 类：密码管理器/验证器厂商泄露

| 威胁 | 判定 | 依据 |
|---|---|---|
| 云端密文被拖库后离线破解主密码 | **部分缓解** | 主密码 ≥50 bit 门槛（SECURITY.md）；PBKDF2-SHA256 600k（与 OWASP 一致）；PLAN 5.1 估算 RTX 4090 约 1.5 万次/秒（600k）。残余风险：PBKDF2 对 GPU 的抗性弱于 Argon2id（OWASP 首推 Argon2id），且**服务器保存了 wrapped_keys 与 KDF 参数**。 |
| 元数据（URL、发行方、时间戳）泄露 | **部分缓解** | PLAN §6 为整库密文；envelope 只有 vaultId、vkId、rev 等头部（明文）。但**密文大小、修改时间、版本号会暴露使用模式**，这与 LastPass 的未加密 URL 问题类似（范围较小）。 |
| 运维密钥与备份被盗 | **未覆盖** | PLAN §7 未描述备份加密与运维访问控制。可选的 KMS 层（PLAN Q7，Phase 1 后期）是目前唯一的设计。 |
| 厂商的供应商被攻破 | **未覆盖** | PLAN 未描述第三方（Supabase、SMTP、运营商）的风险评估。 |

### C 类：浏览器扩展安全

| 威胁 | 判定 | 依据 |
|---|---|---|
| 扩展外传页面内容（OX/Cyberhaven 类） | **已缓解（网络层）** | manifest 无 host 权限、无内容脚本（SECURITY.md）；`connect-src 'none'`，由 `scripts/check-dist.mjs` 与回归测试强制（SECURITY.md）。 |
| 发布者账号被钓鱼，恶意版本上架 | **暴露** | PLAN 未描述发布者账号的 MFA 方式、OAuth 授权管理、双人审核。这是本类最大缺口。 |
| 恶意更新读取解锁后的内存或 session 存储 | **部分缓解** | VK 在 `chrome.storage.session`（内存，PLAN 5.6）；可复现构建与公布哈希（PLAN §11 Phase 2）可帮助用户比对，但用户通常不会比对。 |
| 扩展所有权变更（Great Suspender 类） | **部分缓解** | 开源许可与构建可审计（PLAN 已写"开源 + 可复现构建"）；未来所有权变更的条款未约定。 |
| 同机其他进程读取扩展存储 | **部分缓解 / 依模式** | 有主密码：磁盘上是密文；无主密码：设备密钥与密文同处，等同明文（SECURITY.md 第 3 行）。LevelDB 残留（SECURITY.md Limits）也是同类问题。 |

### D 类：加密算法与实现

| 威胁 | 判定 | 依据 |
|---|---|---|
| SHA-1 碰撞 | **已缓解（非关键路径）** | Sixkey 的完整性校验与封套使用 SHA-256（PLAN 5.1、SECURITY.md）。TOTP 的 SHA-1 为 HMAC 用途，碰撞不构成直接威胁（RFC 6238 仍允许）。 |
| PBKDF2 GPU 破解成本 | **部分缓解** | 600k 迭代与 OWASP 的 PBKDF2 下限一致；但 OWASP 首推 Argon2id。PLAN 5.1 明确决定"不为 Argon2 引入 wasm，等 Chrome 原生支持"。这是一个需要复核的取舍。 |
| AES-GCM 随机 nonce 碰撞 | **部分缓解** | 每次加密使用新的随机 96 bit IV（SECURITY.md）；碰撞概率与加密次数相关。PLAN 中没有"单个 VK 的加密次数上限"的设计。 |
| WebCrypto / 第三方库实现错误 | **部分缓解** | 只用 WebCrypto、不引入加密库（SECURITY.md、PLAN 5.1）；但没有 Wycheproof 类测试向量。测试已有 RFC 向量、已知答案测试和 node:crypto 对照（PLAN §10、§5.1）。 |
| 时序侧信道 | **部分缓解** | Sixkey 只生成码，不做 HMAC 比对；但 PBKDF2、HKDF 在浏览器内运行，依赖 WebCrypto 的实现。 |
| HKDF/ECDH 误用 | **已缓解（当前）** | 只用 HKDF 派生 AES 密钥，无 ECDH。PLAN 5.1 设计的 HKDF 派生有清晰的域分隔（`sixkey/v1/vault-enc`）。 |
| 量子威胁 | **已缓解（当前）** | 当前算法均为对称或哈希；AES-256、SHA-256、HKDF 在 Grover 攻击下仍有足够余量。PQ 压力主要在 TLS 与证书层。 |

### E 类：同步与云端

| 威胁 | 判定 | 依据 |
|---|---|---|
| 服务端回滚（重放旧版本） | **部分缓解** | 客户端记录见过的最大版本号（PLAN 5.5），`if_version` 乐观锁（PLAN 6）。残余：**新设备或重装后无历史记录，无法发现回滚**；服务端可向新设备提供旧版本。 |
| 服务端替换公钥（MITM） | **已缓解（当前不适用）** | 同步是对称加密，服务器不分发公钥。**若将来加入多设备配对或共享，则为暴露**，需要指纹或 SAS 核对。 |
| 账号恢复社工（客服、找回流程） | **部分缓解** | 恢复码 + 主密码是完整路径（PLAN 5.1、Q2），服务器无法重置主密码。但 **PLAN 7.1 的邮箱 OTP 登录 + `DELETE /v1/account` 意味着邮箱接管者可删除账号或覆写云端密文**（破坏性操作，不泄露明文）。 |
| 邮箱 OTP 被劫持 | **暴露（完整性与可用性）** | 攻击者取得会话后可读取密文与 wrapped_keys，但仍需主密码或恢复码解密，所以机密性部分缓解。PUT/DELETE 的破坏性操作无额外验证。 |
| 服务器读取明文 | **已缓解（设计目标）** | 零知识（PLAN 5.5）。但 wrapped_keys 与 KDF 参数在服务器（参见 B 类）。 |
| 运维人员内鬼（Coinbase 类） | **部分缓解** | 零知识设计使运维无法解出金库。但服务器日志、备份、用户邮箱仍可能包含可关联的元数据。 |

---

## 建议的加固方向

按优先级排列。每条注明：**[纯安全]** 表示不影响用户体验，只需工程实现；**[含取舍]** 表示需要产品负责人取舍。

### 高优先级

1. **[含取舍] 决定"首次添加账户前是否强制主密码"。** 这是 SECURITY.md 与 PLAN 都列为未决的项，也是唯一能彻底关闭"旧设备密钥残留"与"无主密码时本地明文"的办法。代价：首次使用门槛上升。建议：至少在开启同步时强制（PLAN Q2 已如此），并考虑对非同步用户也默认要求。
2. **[纯安全] 防回滚：本地保存"已见过的最大版本号 + 摘要"，且在新设备首次同步时提示用户核对。** 当前设计只在同一设备内有效（PLAN 5.5）。可在加密的本地状态中保存版本链摘要，并在云端版本历史（PLAN 6）中做一致性核对。
3. **[纯安全] 为破坏性操作加二次验证：`DELETE /v1/account`、覆写云端密文、换绑邮箱都要求"已解锁 VK"的证明（例如用 VK 派生的 MAC 签名请求），并加冷静期和邮件通知。** 这直接针对"邮箱 OTP 被劫持"。
4. **[纯安全] 发布者账号硬化：** 开发者账号用硬件密钥或 passkey；禁止对 Chrome 商店账号授予第三方 OAuth；至少两人能发布版本；发布前比对构建哈希。这直接对应 Cyberhaven 与 ShadyPanda 类攻击。
5. **[纯安全] 同步的 OTP 登录必须限流与统一响应**：请求 OTP 的响应不得泄露邮箱是否存在；对同一邮箱与 IP 做限流（PLAN 7.1 已有 `Sb-Forwarded-For` 限流的设计，应延伸到 OTP 发送）。Authy 枚举案例说明这一点。
6. **[纯安全] 云端仅存最小元数据**：避免明文 URL、发行方等（LastPass 的教训，见 B 类）；评估是否要把密文长度做分桶填充，以减少使用模式泄露。

### 中优先级

7. **[含取舍] 评估 Argon2id（或在 PBKDF2 之上叠加 Argon2）作为主密码 KDF。** OWASP 首推 Argon2id；PLAN 5.1 因 wasm 体积与"等 Chrome 原生支持"而暂缓。建议：至少保留 KDF 版本字段（已有），并在 Phase 1 之前做一次 wasm 体积与耗时实测，写入决策记录。
8. **[纯安全] 单个 VK 的加密次数计数器与轮换阈值**：每次加密计数，超过保守阈值时自动轮换 VK（PLAN 5.4 的轮换机制已存在）。这把 AES-GCM 随机 nonce 的碰撞风险限制在可接受范围内。
9. **[纯安全] 服务端 wrapped_keys 加 KMS 层**（PLAN Q7 已列为 Phase 1 后期）。提高优先级：它直接降低 B 类"拖库 + 离线破解"的风险。
10. **[纯安全] 运维访问与日志审计**：服务端与备份的管理员访问全程审计，日志不记录请求体。对应 Okta 的 HAR 与 Coinbase 的内鬼教训。
11. **[含取舍] 反馈与诊断导出自动剥离敏感字段**（cookie、token、secret、otpauth URI）。用户体验影响小，但需要明确告知用户"诊断包不含密钥"。
12. **[纯安全] 多设备配对设计前置：** 若将来加入配对或共享，必须有指纹或 SAS 核对（参见 E 类 Session 论文），并写入威胁模型章节（SECURITY.md 第 86 行已预留）。

### 低优先级

13. **[纯安全] 为 AES-GCM、HKDF、PBKDF2 的边界输入引入 Wycheproof 类测试向量。** 作者称 Wycheproof 可以发现 CVE-2022-21449 类问题。
14. **[纯安全] 将 SHA-1 的使用范围写入代码注释与测试**：确保只用于 HMAC（TOTP），禁止用于签名与指纹。
15. **[纯安全] 后量子迁移：** 当前无需行动。关注 TLS 与服务端证书迁移（NIST IR 8547 草案，一手页面未核实），并在同步协议版本中预留算法标识字段。
16. **[含取舍] 明文导出的提醒频率与自动过期提醒。** PLAN 已有强警告；可考虑导出后 N 天自动提醒删除文件。用户体验为主。

---

## 附：未能核实与未找到可靠来源的条目

**一手来源未能获取或内容不一致（已标注"未核实"）：**
- Cyberhaven 受害用户数（"约 40 万"）：仅据二手报道。
- Krebs 2024-02 报道中的金额：仅据标题。
- Authy 的"3300 万号码"：威胁者声称，Twilio 未确认。
- Twilio、Okta、Coinbase、MGM 的 8-K/公告：部分仅据二手转述；MGM 入口方式以媒体为主，8-K 未说明。
- LastPass 2022-08 的确切日期：仅从 12 月通告的表述推断。
- Bitwarden 2023.2.0 与 2026.2.1 的时间点：只见于非英文页面。
- RFC 9106 参数：仅据二手资料。
- IR 8547 草案的具体日期：仅据二手资料。
- wolfProvider CVE-2026-81019：来源页面标注"分析待证据复核"，内部信息不一致。
- Session WOOT '26 论文月份：未核实。
- 2026 年恶意服务器的密码管理器研究（涉及 Bitwarden、Dashlane、LastPass）：仅据二手摘要。
- AT&T 运营商邮箱案：仅据二手报道，金额未核实。
- FBI 2025 账户接管报告金额（2.62 亿美元）：仅据二手转述。
- Singapore 警方 2026 年提醒：仅据二手报道。
- SquareX（DEF CON 32）与 VaultJacking：仅据二手报道。
- Lumma 被打击后恢复活动：仅据二手报道。

**检索中未找到可靠来源的类别（未收录）：**
- Bitwarden 2024 年安全事件。
- 窃取剪贴板的 Chrome 扩展公开案例。
- 验证器种子（secret）泄露的公开事件。
- Vidar/Raccoon 专门针对 2FA 扩展的报道。
- FBI 关于运营商账户接管的专门警告。
- 服务器回滚攻击在真实产品中被利用的公开案例。
- 密钥目录被替换的真实产品事件。
- 随机 96 bit nonce 碰撞导致的真实泄露。
- PBKDF2-600k 在 RTX 4090 上的实测速率。

**结论：** 符合"每类至少 4 至 6 个真实案例"的类别：A 类 6 个、C 类 4 个（另加 1 条官方文档）、D 类 6 个（其中 1 个为未核实的 CVE）。**B 类仅 3 个**，**E 类仅 3 个可靠案例**，未达到 4 至 6 的下限。按"宁缺毋滥"原则未补充不可靠的条目。
