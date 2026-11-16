# Sixkey 安全事件时间线（2016–2026，正序）

类别：A = TOTP/2FA 被盗或绕过；B = 密码管理器/验证器厂商；C = 浏览器扩展；D = 加密算法与实现；E = 同步、服务端与账号恢复。

日期只写来源中实际出现的年月（能确定到日则写到日）。「（未核实）」表示只有二手来源或内部信息不一致。调研结论详见同目录下的 `security-incidents-report.md`。

| 年月 | 事件 | 类别 | 一句话启示 | 来源链接 |
|---|---|---|---|---|
| 2016-08 | GCM nonce 误用伪造攻击（Böck 等，WOOT '16，背景案例） | D | 随机 nonce 在大量加密下有重用风险，应记录加密次数并设上限。 | https://eprint.iacr.org/2016/475 |
| 2020-01 | SHA-1 首个 chosen-prefix 碰撞（Leurent & Peyrin，USENIX Security 2020） | D | SHA-1 不应再用于签名、指纹等场景；TOTP 的 HMAC-SHA1 用途不受直接影响。 | https://www.usenix.org/conference/usenixsecurity20/presentation/leurent |
| 2020-（月未核实） | Minerva：ECDSA nonce 时序泄露（TCHES 2020） | D | 库里的"常量时间"必须经过验证，不能只信实现名称。 | https://eprint.iacr.org/2020/728 |
| 2020-06 | The Great Suspender 扩展被出售（据二手报道） | C | 扩展所有权可以转手，所有权变更应公告并保留可审计构建。 | https://thehackernews.com/2021/02/warning-hugely-popular-great-suspender.html |
| 2020-10 | The Great Suspender 恶意版本 7.1.8 经商店分发（据二手报道） | C | 上架审核不能代替持续监控，远程加载代码是红线。 | https://thehackernews.com/2021/02/warning-hugely-popular-great-suspender.html |
| 2021-02 | Google 下架 The Great Suspender，声称超过 200 万安装 | C | 大规模扩展被投毒后，用户侧只能被动下架，发布方必须在源头防守。 | https://thehackernews.com/2021/02/warning-hugely-popular-great-suspender.html |
| 2022-04 | CVE-2022-21449 "Psychic Signatures"：Java 15–18 ECDSA 接受零值签名 | D | 实现错误比算法弱点更常见，应引入 Wycheproof 类测试向量。 | https://neilmadden.blog/2022/04/19/psychic-signatures-in-java/ |
| 2022-07 | Microsoft 披露 AiTM 钓鱼，攻击超过 1 万家机构（自 2021-09 起） | A | 2FA 码和会话都可被中转截获，2FA 不能单独保证登录安全。 | https://www.microsoft.com/en-us/security/blog/2022/07/12/from-cookie-theft-to-bec-attackers-use-aitm-phishing-sites-as-entry-point-to-further-financial-fraud/ |
| 2022-08 | LastPass 开发环境被入侵，源代码与技术信息被盗（8 月事件，据 12 月通告引用） | B | 攻击常从开发环境开始，云端备份与运维密钥要分层隔离。 | https://blog.lastpass.com/posts/notice-of-recent-security-incident |
| 2022-09 | Uber 承包商遭 MFA 推送疲劳攻击后，内部系统被入侵（8-K 附件日期 2022-09-19） | A | 推送式 MFA 可被疲劳攻击，需要数字匹配或更强的第二因子。 | https://www.sec.gov/Archives/edgar/data/1543151/000155278122000558/e22427_ex99-1.htm |
| 2022-12 | LastPass 加密金库备份被拷贝（通告日期 12-22）；PBKDF2 100,100 次迭代被批评偏低 | B | 金库备份一旦被拖库，主密码强度与 KDF 迭代数就是唯一防线；URL 等元数据也不应明文存放。 | https://blog.lastpass.com/posts/notice-of-recent-security-incident ；https://palant.info/2022/12/28/lastpass-breach-the-significance-of-these-password-iterations/ |
| 2023-03 | LastPass 修订通告：攻击者还获取了配置数据与 API/第三方集成密钥 | B | 事件初报常被修正，应假设影响范围会扩大，并预留撤销与轮换能力。 | https://blog.lastpass.com/posts/security-incident-update-recommended-actions |
| 2023-（具体月未核实） | Bitwarden 将 PBKDF2 默认迭代数升到 600,000（据 2023.2.0 版本，未核实） | B | 行业 KDF 基线会随 OWASP 调整，KDF 版本字段与升级路径必须一开始就设计好。 | https://bitwarden.com/help/kdf-algorithms/ |
| 2023-10 | Okta 客服系统被入侵：HAR 文件中的会话 token 被访问，涉及 134 名客户（窗口 2023-09-28 至 2023-10-17） | A | 用户为排障分享的诊断文件可能含会话令牌，导出功能必须自动剥离敏感字段。 | https://sec.okta.com/articles/2023/11/unauthorized-access-oktas-support-case-management-system-root-cause/ |
| 2023-10 | 1Password 因 Okta 事件受影响：员工上传的 HAR 文件被利用访问 Okta 管理后台（媒体报道日期 2023-10-24） | B | 供应商的支持流程本身也是攻击面，第三方风险必须纳入评估。 | https://www.helpnetsecurity.com/2023/10/24/1password-okta-support-breach/ |
| 2023-10 | MGM Resorts 遭 Scattered Spider 攻击（8-K 2023-10-05；入口的具体方式据媒体报道，8-K 未说明） | E | 服务台可以被电话社工，重置密码与转移 MFA 等同于攻破账号。 | https://www.computing.co.uk/news/4126034/mgm-resorts-hackers-deceived-service-desk-phone |
| 2023-11 | CISA/FBI 发布 AA23-320A：Scattered Spider 利用服务台转移 MFA（2025-07-29 修订） | E | 账号恢复流程（换绑、重置）是最便宜的攻击面，恢复必须有独立于邮箱或手机的强验证。 | https://www.cisa.gov/news-events/cybersecurity-advisories/aa23-320a |
| 2024-02 | Krebs 报道佛州男子因 SIM 换卡被控，报道称与 FTX 相关的约 4 亿美元级盗窃有关（仅据标题，金额未核实） | A | 同步或找回流程若依赖手机号，就会被 SIM 换卡打穿。 | https://krebsonsecurity.com/2024/02/arrests-in-400m-sim-swap-tied-to-heist-at-ftx/ |
| 2024-06 | KyberSlash：Kyber/ML-KEM 参考实现的秘密相关除法时序泄露（ePrint 2024/1049） | D | 后量子实现同样会犯侧信道错误，应使用经审计的库，而不是自己实现。 | https://eprint.iacr.org/2024/1049 |
| 2024-07 | Twilio 修复 Authy 未认证 API，可枚举手机号关联账户（变更日志日期 2024-07-01；"3300 万"为威胁者声称，未确认） | A | 账户与手机号的关联是高价值的枚举目标，找回与注册接口必须统一响应并限流。 | https://www.twilio.com/en-us/changelog/Security_Alert_Authy_App_Android_iOS |
| 2024-08 | NIST 发布 FIPS 203（ML-KEM）、204（ML-DSA）、205（SLH-DSA）（2024-08-13） | D | 后量子标准已定稿；对 Sixkey 当前的对称加密暂无紧迫迁移压力，但 TLS 与证书层需要规划。 | https://www.nist.gov/news-events/news/2024/08/nist-releases-first-3-finalized-post-quantum-encryption-standards |
| 2024-11 | NIST IR 8547 草案：计划 2030 年后弃用、2035 年后禁用 RSA/ECC（日期据二手报道，未核实） | D | 公钥算法的迁移时间表已经明确，证书与 TLS 层要在 2030 年前完成规划。 | https://www.abiresearch.com/market-research/insight/7785443-nists-intention-to-deprecate-rsa-and-ecc-w |
| 2024-12 | Cyberhaven 扩展发布者账号被钓鱼，恶意 OAuth 应用获取授权，恶意版本 24.10.4 上架（钓鱼日期 2024-12-24） | C | 开发者 MFA 不能挡住 OAuth 授权钓鱼，发布者账号要用硬件密钥并禁止无必要的 OAuth 授权。 | https://www.cyberhaven.com/engineering-blog/cyberhavens-preliminary-analysis-of-the-recent-malicious-chrome-extension |
| 2024-12 | Coinbase 客服人员被贿赂开始窃取客户数据（据 Maine AG 文件，2024-12-26 起，2025-05-11 才发现） | E | 内部人员能看到的数据要最小化，零知识设计可以限制内鬼的影响。 | https://www.theregister.com/2025/05/21/coinbase_confirms_insider_breach_affects/ |
| 2025-03 | NIST 选定 HQC 作为 ML-KEM 的备份算法（2025-03-11；草案约一年后，最终标准预计 2027） | D | HQC 尚未定稿，Sixkey 不应现在引入；关注长期保存密文的 harvest-now-decrypt-later 风险。 | https://www.nist.gov/news-events/news/2025/03/nist-selects-hqc-fifth-algorithm-post-quantum-encryption |
| 2025-05 | Coinbase 通过 8-K 披露客服内鬼事件（2025-05-15），称勒索 2000 万美元（据报道） | E | 同上：运维与客服权限要审计，并且尽量不让其能解出用户数据。 | https://www.theregister.com/2025/05/21/coinbase_confirms_insider_breach_affects/ |
| 2025-05 | 微软与执法部门协同打击 Lumma 信息窃取木马（博文 2025-05-21）；约 2300 个域名被处置，2025-03-16 至 05-16 识别 39.4 万台 Windows 感染 | A | 信息窃取木马能读取浏览器可见的数据和会话，解锁状态下的本地密钥不能假设安全。Lumma 随后又恢复活动（未核实）。 | https://blogs.microsoft.com/on-the-issues/2025/05/21/microsoft-leads-global-action-against-favored-cybercrime-tool/ |
| 2025-12 | Koi Security 披露 ShadyPanda：约 430 万 Chrome/Edge 用户受影响，部分扩展曾被 Google 标为 Featured/Verified（据 Koi 报告） | C | "审核一次"不代表永久安全，每次版本更新都是攻击面，应做可复现构建与签名校验。 | https://www.koi.ai/blog/4-million-browsers-infected-inside-shadypanda-7-year-malware-campaign |
| 2025-12 | OX Security 报告两个扩展偷窃 ChatGPT/DeepSeek 对话与 tab URL，约 90 万用户，每 30 分钟外传（博文 2025-12-30） | C | 扩展有内容脚本或宽松网络权限就能外传页面内容；Sixkey 的 `connect-src 'none'` 是直接对照优势。 | https://www.ox.security/blog/malicious-chrome-extensions-steal-chatgpt-deepseek-conversations |
| 2026-（月未核实，WOOT '26 录用） | Session 消息应用的协议问题：缺少双向公钥认证，恶意服务器节点可替换公钥、丢弃或重放消息（eprint 2026/1247） | E | 若将来加入多设备配对或共享，必须做指纹或 SAS 核对，不能只信服务器下发的公钥。 | https://eprint.iacr.org/2026/1247 |
| 2026-08-28 | wolfProvider（wolfSSL）TLS 1.2 的 AES-GCM 显式 nonce 从不递增，CVE-2026-81019（未核实，来源页面标注分析待复核） | D | 计数器型 nonce 状态管理仍是高发错误，应对每次写入的 IV 唯一性做测试。 | https://hol.org/guard/security/cves/CVE-2026-81019-wolfprovider-reuses-the-aes-gcm-nonce-on-every |
