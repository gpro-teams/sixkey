# 指纹浏览器的安全与隐私做法：对 Sixkey 的启示

调研日期：2026-10-15。范围：AdsPower、Multilogin X、GoLogin、Dolphin{anty}、Kameleo、Incogniton、VMLogin、BitBrowser（比特浏览器），顺带 Octo Browser、MoreLogin。只看**防御、用户保护、数据处理**这一面；反检测、规避风控/封号、定价与商业模式不在范围内，也没有收集。

对照的 Sixkey 现状：`docs/security/local-vault.md`、`docs/PRIVACY.md`（Phase 0 已实现）、`docs/history/PLAN-zh.md`、`docs/SYNC-DESIGN.md`（Phase 1 设计），以及 `extension/src/` 的实际代码。以上文件全部只读，未修改。

**引用标记**
- **[复核]**：我本人重新抓取了原文（或原始代码）并核对过。
- **[转录]**：研究子代理抓取了原文，我没有逐条二次核对。
- **[摘要]**：只看到搜索摘要，或页面打不开。
- 所有厂商的说法都按"厂商自述"处理。至今没有找到任何一家厂商的独立安全审计。

---

## 摘要

1. **扩展存储会离开这台电脑，而且这是被文档化的正常功能，不是边缘情况。**
   - GoLogin 的同步包含 "local storage, and extensions"。其官方 Node SDK 会打包整个 `Default/` 目录上传，只排除 IndexedDB 等缓存目录，而 `Local Extension Settings`（即 `chrome.storage.local`）不在排除之列。
   - Kameleo 的"复制配置文件"是 "exact clone"，包含扩展。
   - AdsPower、BitBrowser、VMLogin、Dolphin 都有"同步扩展数据"的开关。
   - BitBrowser 2023 年 8 月正是通过这条路径出事：服务器端缓存被入侵，开启了扩展数据同步的用户钱包被盗。
   - 结论：Sixkey 的"设备密钥模式"（未设主密码）在这些环境里等于把种子交给厂商和团队。
2. **厂商自己的扩展分发渠道已经被投过毒。** 2025-01-21 至 01-24，AdsPower 的钱包扩展下载被替换成恶意版本，SlowMist 估计损失约 470 万美元。几乎所有厂商都支持上传 zip/crx 或未打包目录来安装扩展，这样装的扩展 ID 可能变化，也不会自动更新。
3. **本机自动化接口是一个被低估的攻击面。** 各家本地 API 都会返回配置文件的 CDP 调试地址，而且鉴权"可选"或根本没有文档：
   - AdsPower：只有"开启安全校验时"才需要 API Key。
   - BitBrowser：Token 定位为"公网环境"使用。
   - VMLogin：未见任何鉴权文档。
   - Kameleo：OpenAPI 中没有任何 securitySchemes（即文档未写任何鉴权）；配置参考表写 `ListeningHost` 默认 `+`（所有网卡），而安装页又说默认监听 `localhost:5050`，两处自相矛盾。
   能连上调试端口的进程，可以在扩展的 service worker 里执行代码。Sixkey 解锁期间，VK 就在 `storage.session` 里。
4. **"加密"宣传几乎都不说密钥在谁手里。** 只有 Octo（受密码保护的配置文件，厂商"不存密码"）和 MoreLogin（可选的每配置文件端到端加密）明确是用户持钥。GoLogin 声称 "keys are not accessible to us"，但其 SDK 实际以明文 zip 上传配置文件。
5. **厂商已经把 2FA 种子存进配置文件。** AdsPower 的 "2FA 密钥"/`fakey`、BitBrowser 的窗口 2FA/`faSecretKey`、MoreLogin 的 `otpSecret`，都与账号密码、cookie 放在一起，可以随配置文件复制（AdsPower 一次最多 30 份）、共享，也可以从本地 API 读出。
   - 最流行的网页验证码生成器 2fa.live 页面声称"本地生成"，实际却把密钥发到服务器（`fetch('/tok/' + secret)`，已复核）。
   - Sixkey 对这类用户最大的价值是**把种子与配置文件、与厂商云分开**，而不是功能更多。
6. **现实需求是"一个配置文件一个账号、多人共用一个配置文件"。** "同一组种子要进几十个配置文件"的场景没有找到证据。团队真正缺的是：只把某个配置文件需要的那几个种子放进去，以及员工离开时知道该轮换哪些种子。
7. **建议的预算：7 个 S + 1 个 M，不新增权限，Phase 0 不触网，不改加密格式**（见第 3 节）。其中最重要的一项，是把 PLAN §15 悬而未决的"首个账户前必须设主密码"定下来。

---

## 1. 分问题摘要

### Q1 配置文件隔离、本地数据、克隆/导出/导入、云同步

**隔离方式。** 各家都是"一个配置文件 = 一个独立的 Chromium user-data-dir"。扩展数据就存在这个目录里：`chrome.storage.local` 在 `Local Extension Settings/<扩展ID>`（Chromium 常量 `kLocalExtensionSettingsDirectoryName = "Local Extension Settings"`，[chromium constants.cc](https://chromium.googlesource.com/chromium/src/+/refs/tags/110.0.5481.192/extensions/common/constants.cc) [摘要]），扩展 IndexedDB 在 `IndexedDB/` 下。因此，"复制、上传、共享配置文件"是否连带 Sixkey 的数据，只取决于厂商打包哪些子目录。

**各家与扩展数据相关的事实**

| 厂商 | 扩展数据是否离开本机 | 加密说法 | 来源 |
|---|---|---|---|
| GoLogin | 云同步包含 "cookies, local storage, and extensions"，在"profile is closed correctly"时上传。SDK 上传前的排除清单只有 Cache、Extensions、IndexedDB 等，**不含** `Local Extension Settings`。SDK 每次停止时 `sanitizeProfile()` 都会删除 `Default/IndexedDB`，然后删除整个临时配置文件目录。 | 文档称 "these keys are not accessible to us at any stage"。但 SDK 的 `postFile` 以 `body: fileBuff`、`Content-Type: application/zip` 加 Bearer token 上传，客户端不加密。桌面版是否不同：未核实。 | [同步文档](https://gologin.com/docs/browser-profiles/profile-management/profile-synchronization.md) [复核]；[data-safety](https://gologin.com/docs/general/data-safety.md) [复核]；[profile-directories-to-remove.js](https://github.com/gologinapp/gologin/blob/40329508d12965409a5539f8e7b1f6a2492d30bb/src/profile/profile-directories-to-remove.js) [复核]；[gologin.js L1222–1372（commit 2026-10-06）](https://github.com/gologinapp/gologin/blob/40329508d12965409a5539f8e7b1f6a2492d30bb/src/gologin.js) [复核] |
| Kameleo | "Extensions and their storage persist"；`.kameleo` 导出 "include installed extensions"；复制 = "exact clone with all profile settings, browsing data, cookies… and installed extensions"（2025-11-19）。Team Owner 模式 "can view and edit any group and profile"（2026-01-27）。 | 只有 "All sensitive data remains protected"，未说密钥归属。 | [扩展教程](https://developer.kameleo.io/04-tutorials/06-install-browser-extensions.md) [复核]；[复制](https://help.kameleo.io/article/70-duplicating-profiles) [复核]；[团队](https://help.kameleo.io/article/57-groups-profile-sharing) [复核]；[隐私 FAQ](https://help.kameleo.io/article/77-what-traces-does-kameleo-leave-is-the-data-online-or-offline) [转录] |
| Multilogin X | 转移时接收方得到 "Cookies / Local storage / Sessions / Extensions…"，不可撤销，仅限 owner（2026-09-18）。克隆 "Cookies, browsing history, and saved logins are not copied"，是否含扩展存储未说明。导出为 "encrypted .zip"，含扩展。 | 隐私政策："encrypts sensitive data before sending… account password is used as a private key"。措辞像旧版 Multilogin 6，与现在的 Google/Apple 登录方式对不上。 | [转移](https://multiloginx.helpjuice.com/en_US/browser-profile-tools/how-to-transfer-browser-profiles) [复核]；[克隆](https://multiloginx.helpjuice.com/en_US/browser-profile-tools/how-to-clone-profiles) [转录]；[导出](https://multiloginx.helpjuice.com/how-to-export-profiles) [转录]；[隐私政策](https://multilogin.com/privacy-policy/) [转录] |
| AdsPower | 默认不同步。可选同步类型包括 LocalStorage、IndexedDB、"插件应用程式资料"；团队设置默认值，每个配置文件可以单独覆盖。**只有通过"扩展"板块安装的扩展**才同步数据，在配置文件里直接安装的扩展数据留在本地；上限 60MB。 | 营销页称 "end-to-end encryption"，帮助中心只说 "we use encryption"，都没有说密钥归属。 | [account-security](https://www.adspower.com/account-security) [复核]；[扩展文档 2025-08-26](https://help.adspower.com/docs/extensions) [复核]；[全局设置 2026-04-24](https://help.adspower.com/docs/global_settings) [转录]；[data_security](https://help.adspower.com/docs/data_security) [转录] |
| BitBrowser | API 中 `syncExtensions`（同步扩展应用数据）、`syncUserExtensions`（**跨窗口**同步扩展应用）、`syncIndexedDb`（"极少的情况下才需要同步"）、`syncLocalStorage` 默认都是 false。跨窗口同步会把一个配置文件的扩展数据复制进其他配置文件。 | 营销页说"层层加密"。2023 年事件后（v5.0.9）："Enabling extension data synchronization requires mandatory password input"，并暂停跨浏览器扩展同步；v6.0.1 恢复。这个密码是客户端密钥还是服务器校验：未找到。 | [浏览器接口文档](https://doc.bitbrowser.cn/api-jie-kou-wen-dang/liu-lan-qi-jie-kou.md) [复核]；[更新日志](https://doc.bitbrowser.net/updatelog.md) [复核] |
| VMLogin | 开启同步后关闭浏览器时上传 "cookies, bookmarks, passwords, history, extended data"；"Extension storage" 开关可跨电脑同步扩展（是否含 `chrome.storage` 措辞含糊）；转移所有权要先开同步上传。 | "stored and synchronized on the server in encrypted form"，未说算法或密钥。 | [详情页](https://www.vmlogin.us/help/fingerprint/vmlogin-details.html) [转录]；[子账号](https://www.vmlogin.us/help/account/sub-account-instru.html) [转录] |
| Dolphin{anty} | 有 "Extension Filesystem sync" 和 IndexedDB 同步选项（帮助中心 404，只见摘要）。"本地同步"的配置文件 "stored exclusively on the user's local device"，云端数据 45 天后删除，不能共享或转移。 | 隐私政策（2023-03-29）只说数据存放在 "mcs.mail.ru, Yandex.Cloud or AWS Amazon"，没有加密说法。 | [IndexDB and sync](https://intercom.help/dolphinteam/en/articles/9657888-indexdb-and-sync) [摘要]；[关闭云同步](https://dolphin-anty.com/blog/en/disabling-cloud-synchronization-in-dolphin-anty/) [转录]；[隐私政策](https://dolphin-anty.com/privacy-policy/) [转录] |
| Incogniton | 文档未说明是否同步扩展存储（未写明 ≠ 不同步）。 | "our encrypted cloud servers"，并称本地保存"at your own risk"。 | [cloud-saving](https://docs.incogniton.com/account-management/cloud-saving.md) [转录] |
| Octo | — | AES-256，需要 "secret key + unique database key + user key（若设密码）" 三者才能解密。受密码保护的配置文件："Octo Browser does not store profile passwords"，不可找回，**没有尝试次数限制**，设密码期间不能导出或转移。 | [How Octo protects user data](https://blog.octobrowser.net/how-octo-browser-protects-user-data) [复核]；[Password-protected profiles](https://blog.octobrowser.net/password-protected-profiles) [复核] |
| MoreLogin | 可选的每配置文件端到端加密："only accounts and devices with a decryption key can access the profile"。 | 同左。 | [profile settings 2026-01-21](https://support.morelogin.com/en/articles/10204297-profile-settings) [转录] |

**IndexedDB 在不同厂商那里的命运正好相反**，这一点直接影响 SYNC-DESIGN（见第 4 节 d2）：
- GoLogin SDK 每次停止都删除 IndexedDB，也不上传它。
- AdsPower、BitBrowser 把 IndexedDB 作为单独的、默认关闭的同步项。
- Kameleo 把 IndexedDB 作为配置文件的持久状态（[profiles 概念页](https://developer.kameleo.io/02-concepts/02-profiles.md) [转录]）。

所以，云同步的配置文件里很可能出现"`storage.local` 跟着走、IndexedDB 不跟着走"的组合。

**事件与批评**
- **BitBrowser，2023-08**："比特服务端缓存数据遭到黑客入侵……如有开启了扩展数据同步的用户，钱包有被盗风险"（[ChainCatcher 2023-08-26](https://www.chaincatcher.com/en/article/2100154) [复核]；[TechFlow 2023-08-30](https://www.techflowpost.com/en-US/newsletter/30219) [复核]；中文原文转载 [jb51 2023-08-29](https://www.jb51.net/blockchain/897763.html) [转录]）。
  - 社区统计超过 3000 个钱包受损（同 jb51 页 [转录]）；SlowMist 估计至少 52 万美元（[摘要](https://slowmist.medium.com/slowmist-weekly-security-report-august-28th-to-september-3rd-c3315484304b)）。
  - 厂商事后的承诺是"使用户拥有独一无二的密钥，或让用户自行设置密钥"（jb51 [转录]）。**这正是 Sixkey 已经在做的事。**
- **AdsPower，2025-01**：攻击者 "replaced the project's browser extension with a malicious download"（[Halborn 2025-01-30](https://www.halborn.com/blog/post/explained-the-adspower-hack-january-2025) [复核]）。
  - 时间窗为 2025-01-21 10:00 至 01-24 10:00 UTC，目标是 MetaMask、OKX 钱包扩展，SlowMist 估计约 470 万美元（[Risky Bulletin 2025-02-07](https://news.risky.biz/risky-bulletin-supply-chain-attack-at-adspower-browser-platform/) [复核]）。
  - 受害者人数各方说法差异很大：Halborn 说 5 人，MetaMask 报告称超过 34,000 个钱包（[MetaMask 2025-01](https://metamask.io/news/metamask-security-report-january-2025) [转录]），OneKey 说超过 2 万。官方数字未找到。
- **Dolphin{anty}，2022-07**：竞争对手 Octo 的博客称其泄露了"15% of user browser profile data"，包括 cookie、写在配置文件备注里的密码和钱包（[Octo 博客](https://blog.octobrowser.net/how-octo-browser-protects-user-data) [复核]，但这是竞争对手的说法）。**一手来源未找到，未核实。**
- **GoLogin**：Trustpilot 上有用户称团队 cookie 被盗、怀疑内部人员出售数据（2025-02）。厂商回复（2025-05-08）称"no evidence of GoLogin services being compromised"，把原因归于"third-party two-factor authentication providers"和"malicious behavior by team members"（[Trustpilot p7](https://www.trustpilot.com/review/gologin.com?page=7) [转录]）。**无独立证实。**

### Q2 账户与设备安全

| 机制 | 谁有 | 来源 |
|---|---|---|
| 登录 2FA（TOTP） | 所有厂商都有。AdsPower 可对全队强制，分三档（低档："新设备或距上次 90 天以上需要 2FA"），删除配置文件、管理成员时也可要求 2FA。Multilogin X 只有 owner 能强制，且"no longer uses backup codes"。BitBrowser、AdsPower 也接受短信或邮箱验证码。 | [AdsPower 2FA](https://help.adspower.com/docs/two_factor_authentication) [转录]；[MLX 2FA](https://multiloginx.helpjuice.com/en_US/account-settings-navigation/two-factor-authentication-in-multilogin-x) [转录]；[BitBrowser 2FA](https://doc.bitbrowser.net/help1/account-security/how-to-turn-on-two-factor-verification.md) [转录] |
| 异地/新 IP 登录提醒、失败登录告警、IP 白名单 | AdsPower："Remote login reminder and failed login attempt alert"、"Login IP Allowlist"。GoLogin 回复称已加入"logins from unknown locations"邮件提醒。 | [AdsPower account-security](https://www.adspower.com/account-security) [复核]；[GoLogin Trustpilot 回复](https://www.trustpilot.com/review/gologin.com?page=7) [转录] |
| 会话/设备列表、远程登出 | GoLogin 的 active sessions 显示 IP，支持"Terminate all other sessions"。Incogniton 2026-09-10 加入设备列表（含 OS、IP、版本）和全部登出。 | [GoLogin active sessions](https://gologin.com/docs/general/account-and-billing/active-sessions-1.md) [转录]；[Incogniton changelog](https://docs.incogniton.com/changelog/readme.md) [转录] |
| 打开配置文件需密码 | Octo：主账号可要求启动配置文件时输入密码（1.14 起）。Dolphin：配置文件密码"reset is impossible unless the old one is known"。 | [Octo](https://blog.octobrowser.net/how-octo-browser-protects-user-data) [复核]；[Dolphin](https://dolphin-anty.com/blog/en/profile-management-in-dolphin-anty/) [转录] |
| 闲置锁定 / 锁屏即锁 | **在已检索的文档里没有找到任何一家有。** | 未找到（已检索各家帮助中心与更新日志） |
| 操作日志 | AdsPower 的操作日志含成员 IP；BitBrowser 主账号可查看子账号记录；VMLogin 管理员看得到子账号的操作日志，但看不到浏览器内数据；Octo 有配置文件操作历史。 | [AdsPower 博客](https://www.adspower.com/blog/behind-the-scenes-how-adspower-keeps-your-data-safe) [转录]；[BitBrowser 团队](https://www.bitbrowser.cn/team-work) [转录]；[VMLogin](https://www.vmlogin.us/help/account/sub-account-instru.html) [转录] |

**反面做法，值得引以为戒：**
- Incogniton："Team admins can now turn off two-factor authentication for individual team members"（2026-07-29，[changelog](https://docs.incogniton.com/changelog/readme.md) [转录]）。
- BitBrowser 主账号可以**永久屏蔽**操作日志："once the shielding is confirmed, the operation log will never be displayed again!"（[更新日志](https://doc.bitbrowser.net/updatelog.md) [复核]）。
- VMLogin 的 API Token"equivalent to your account password"，而且放在 URL query 里传（[view-api-token](https://www.vmlogin.us/help/api/view-api-token.html) [转录]）。
- AdsPower 团队 owner 可以查看并复制成员的验证器代码。这是给登录 AdsPower 本身用的（[members](https://help.adspower.com/docs/members) [转录]）。

**对 Sixkey 的含义**
- 在"本地锁定"这件事上，Sixkey Phase 0 已有主密码、闲置锁、锁屏即锁、"每次都锁"；在我们查到的厂商文档里，没有一家提供闲置锁或锁屏即锁。
- 厂商的设备列表、远程登出，在 SYNC-DESIGN 里已有更强的对应物：设备签名、批准入网、吊销加轮换（§3.2、§3.10）。
- 唯一缺的是**本机层面的"有没有人在动我的东西"**：失败解锁次数、导出记录。

### Q3 团队/权限：哪些是真正的安全功能

| 做法 | 例子 | 评价 |
|---|---|---|
| 角色 + 按文件夹授权 | MLX：Owner/Manager/Operator/Starter，Starter "start assigned profiles, but can't edit or delete them"（[roles](https://multiloginx.helpjuice.com/en_US/teamwork/workspace-roles-and-permissions) [复核]）。Kameleo：Admin/Analyst/Member（[复核](https://help.kameleo.io/article/57-groups-profile-sharing)）。BitBrowser、AdsPower、Dolphin 类似。 | 对厂商的**服务器端资源**有效。但能"运行"配置文件的人，就能拿到里面的 cookie 和扩展数据，见下行。 |
| 对成员隐藏密码 / 禁用 F12 | BitBrowser v6.0.5 可控制成员是否看到平台账号密码，v7.1.5 可禁止子账号使用 DevTools 和装卸扩展（[更新日志](https://doc.bitbrowser.net/updatelog.md) [复核]）。MoreLogin "only the super administrator can view the password and use the F12 developer tools"（[转录](https://support.morelogin.com/en/articles/10204297-profile-settings)）。 | 这是**客户端强制**。Bitwarden 自己称隐藏密码"a convenience control that reduces casual exposure, not as a security guarantee"（[Bitwarden 2026-04-10](https://bitwarden.com/blog/hidden-passwords-control-credential-visibility-across-organizations/) [复核]）。1Password 称"the unencrypted data is still on their devices and could be extracted with some effort"（[1Password](https://support.1password.com/permission-enforcement/) [转录]）。**对 TOTP 种子同理：能生成码的客户端必然持有种子。** |
| 不交出凭据的共享、带期限的共享 | Incogniton 账号共享"without sharing passwords"，有到期日、可撤销，但开了 2FA 就不能用（[转录](https://docs.incogniton.com/account-management/account-sharing.md)）。BitBrowser 分享码 7/15/30 天。AdsPower 分"可撤销"和"不可撤销"共享，共享出去的配置文件"keeps its data such as account platform, account username/password, cookies"（[Profile_Sharing 2025-09-25](https://help.adspower.com/docs/Profile_Sharing) [复核]）。 | 撤销与期限只约束厂商服务器上的下一次访问；已经拿到的 cookie 和种子收不回。 |
| 转移不可撤销 | MLX、Incogniton、VMLogin。 | 对 Sixkey 的含义：转移前必须先把 Sixkey 数据清出该配置文件。 |
| 只给需要的东西 | Octo 建议"only give employees access to the profiles they need"（[复核](https://blog.octobrowser.net/how-octo-browser-protects-user-data)）。BitBrowser 建议一个配置文件一个业务账号、员工离开即移除访问（[博客 2026-06-30](https://www.bitbrowser.net/blog/web-based-2fa-multi-account-teams-bitbrowser) [转录]）。 | **最简单、最有效**：Sixkey 可以做到"这个配置文件里只有这 2 个种子"（见候选 F2）。 |
| 离职处理 | Bitwarden："when a team member with vault access is deprovisioned, rotate the TOTP secret and password"（[转录](https://bitwarden.com/resources/mfa-for-shared-accounts/)）。 | 种子一旦被看到，唯一的补救就是到网站重新绑定。SYNC-DESIGN §3.10 的吊销清单已经写了这一条。 |

**简单且有价值的**：最小化每个配置文件里的种子；离职时给出"该轮换哪些"的清单；本地操作记录。

**复杂度陷阱**：
- 角色/权限矩阵、"能用码不能看种子"的成员角色：都是客户端强制，在 E2EE 下做真需要每人独立密钥，相当于 Q7 说的另一套设计。
- 服务器端的"到期共享"：E2EE 下撤不回已经交付的种子。
- 管理员代管成员 2FA：这是反模式。

### Q4 隐私卫生

- **清除残留**：
  - AdsPower 可分"本机/云端"清缓存（[Cache-Data](https://help.adspower.com/docs/Cache-Data) [转录]）。
  - BitBrowser 有启动前清缓存/cookie 的选项，以及同时清本地和云端 cookie 的接口（[接口文档](https://doc.bitbrowser.cn/api-jie-kou-wen-dang/liu-lan-qi-jie-kou.md) [转录]）。
  - VMLogin 可在启动时删 cookie、关闭时清缓存（[转录](https://www.vmlogin.us/help/fingerprint/vmlogin-details.html)）。
- **本地模式**：
  - Kameleo 说"for complete privacy, you can use local profiles"（[复核](https://help.kameleo.io/article/57-groups-profile-sharing)）。
  - Dolphin 的本地同步模式下，云端数据 45 天后删除。
  - Kameleo 还支持 accountless 启动（[配置项](https://developer.kameleo.io/05-reference/06-configuration-options.md) [复核]）。
- **遥测**：
  - Dolphin 隐私政策列出 Amplitude、Yandex Metrica、Google Analytics（[转录](https://dolphin-anty.com/privacy-policy/)）。
  - GoLogin 隐私政策列出 GA4、GTM、Microsoft Clarity、Sentry、广告像素，可用 `GOLOGIN_TELEMETRY=0` 退出（[转录](https://gologin.com/privacy)）。
  - AdsPower 隐私政策称会记录"web pages you visit"，适用范围措辞含糊（[转录](https://www.adspower.com/privacy-policy)）。
  - Kameleo 称客户端只上报订阅、新闻、指纹下载和错误（[转录](https://help.kameleo.io/article/77-what-traces-does-kameleo-leave-is-the-data-online-or-offline)）。
- **WebRTC/DNS/IP 一致性检测**：这是厂商的核心卖点，但服务于反检测，与 2FA 无关，而且需要联网。**不在 Sixkey 范围内。**

**对 Sixkey 的含义**：Sixkey 已有 CSP 强制的零网络（`connect-src 'none'`）和数据清单（PRIVACY.md）。厂商普遍做不到"说清楚密钥在谁手里"，Sixkey 能做到，这本身就是卖点（SYNC-DESIGN §3.1 / O1 的"服务器能看到什么"）。需要补的有两处：
1. 应用内的"本机存了什么"。
2. PRIVACY.md 的"删除扩展即删除全部数据"在厂商云同步的配置文件里不成立（见第 4 节末尾）。

### Q5 用户的抱怨与称赞

证据较薄：Reddit 无法抓取，BlackHatWorld 返回 403，下面多为 Trustpilot。
- **抱怨**：
  - GoLogin（2025-02，1 星，未标 Verified）："I had two different teams hacked at the same time… stealing cookies"、"someone inside is selling user data"（[Trustpilot](https://www.trustpilot.com/review/gologin.com?page=7) [转录]）。
  - Dolphin："many warning about virus/phishing from Kaspersky and Bitdefender"、注册需要 WhatsApp（[Trustpilot](https://www.trustpilot.com/review/dolphin-anty.com) [转录]）。
  - AdsPower 的 Trustpilot 评分因"a breach of our guidelines"不可用，Trustpilot 称删除了一批虚假评论（[Trustpilot](https://www.trustpilot.com/review/adspower.com) [转录]）。
  - MetaMask 在 2025-01 事件中建议用户在处置期间"avoid using ADSPower"（[MetaMask](https://metamask.io/news/metamask-security-report-january-2025) [转录]）。
  - 论坛上反复出现的主题是"团队共享配置文件导致会话失效"（[BHW 摘要](https://www.blackhatworld.com/seo/stop-using-team-features-on-anti-detects-they-break-sessions-trigger-logouts-and-ban-waves-explained.1778642/)）。这是运维问题，不是安全问题。
- **称赞**："good tool for remote teams"、"profile isolation works well most of the time"（Dolphin）；"no worries about having VA staff access the accounts"（Incogniton，2024-03-22）（均为 [转录]）。
- **归纳**：用户最在意的是"会话/cookie 被别人拿走"和"团队成员带走东西"。这两点正好对应 Sixkey 的"种子不跟配置文件走"和"每个配置文件只放需要的种子"。中文论坛对数据管辖地的担忧：**未找到来源**。

### Q6 在大量配置文件里使用 TOTP：真实需求

**种子现在在哪里**
- AdsPower：配置文件"账号信息"里有"2FA 密钥"，可自动生成验证码（v5.9.14，2023-11，[转录](https://www.adspower.com/tc/release/2023-10)）。API 字段 `fakey` 可写，查询接口也会返回它（[New-Profile-V2](https://localapi-doc-en.adspower.com/docs/New-Profile-V2) [转录]）。复制配置文件时可勾选复制"Information (Platform, username, password, 2FA)"，"the maximum number is 30"（[editing 2025-09-08](https://help.adspower.com/docs/editing) [复核]）。
- AdsPower 还发布了自研的 "AdsPower Authenticator" 扩展，用来保存密码和 2FA 密钥，并在打开配置文件时自动填入；其公告说这样做"mitigates the chances of arousing suspicions of antifraud systems"（[2023-11-06](https://www.adspower.com/news/whats-new-what-we-launched-in-october-2023) [复核]）。
- BitBrowser：v6.0.6（2024-01）起每个窗口都可设 2FA 密钥（[更新日志](https://doc.bitbrowser.net/updatelog.md) [复核]），API 字段为 `faSecretKey`（[转录](https://doc2.bitbrowser.cn/jiekou/liu-lan-qi-jie-kou.html)）。
- MoreLogin：配置文件中有 2FA key 字段，API 字段为 `otpSecret`（[转录](https://support.morelogin.com/en/articles/10204806-browser-profile)）。
- 这些种子在厂商服务器上如何存储、是否加密、成员能否看到：**都未找到文档**。

**网页生成器在泄露种子**
- 2fa.live 的 FAQ 说"generated locally in your browser, ensuring your key never leaves your device"，页面代码却是 `fetch('/tok/' + curTokens[lastIdx]…)`，还支持按 `|` 分隔的批量行（[2fa.live](https://2fa.live/)，2026-10-15 抓取页面源码 [复核]）。
- Semrush 估计其 2026-09 访问量为 2364 万次（[转录](https://www.semrush.com/website/2fa.live/overview/)）。
- 2fa.cn 同样以 `"/codes/" + secret` 请求服务器（[转录](https://2fa.cn/js/main.js)）。
- 一份团队 SOP 写着员工"open the corresponding profile to retrieve the 2FA code"（[sop.ai](https://sop.ai/public/accessing-and-using-ads-power-software-b82e8) [转录]）。

**流行的验证器扩展**
- authenticator.cc（约 900 万用户）默认把条目放在 Chrome 同步存储，未设密码时以明文存储（研究子代理读了[源码](https://github.com/Authenticator-Extension/Authenticator/blob/dev/src/models/storage.ts) [转录]）。
- Lumma 窃密木马把"2FA browser extensions like… Authenticator"列为目标（[Darktrace 2023-09-06](https://www.darktrace.com/blog/the-rise-of-the-lumma-info-stealer) [转录]）。

**"同一组种子进几十个配置文件"是否常见：未找到证据。** 能找到的证据都指向"一个配置文件 = 一个（或几个）账号"：
- BitBrowser："One BitBrowser profile can be assigned to one business account"。
- AdsPower：账号默认允许重复，可选去重；一个配置文件最多 10 个平台账号（[zQuVBk](https://help.adspower.com/docs/zQuVBk) [转录]）。

团队的形态是"多人轮流用一个配置文件"（共享或分配），而不是"一个种子复制到很多配置文件"。

**由此推出的真实需求，按价值排序：**
1. 种子不以可恢复的形式存在于会被厂商同步、复制或共享的配置文件数据里。也就是说，必须用户持钥，不能用设备密钥。
2. 一个配置文件里只放它需要的那几个种子。
3. 在本地完成批量粘贴导入，替代 2fa.live 这类会外传种子的网站。
4. 快速搜索、一键复制、按当前网站排序、剪贴板自动清空。Sixkey 已有。
5. 配置文件被脚本控制时，缩短解锁窗口。
6. 员工离开时有轮换清单。
7. （可选、较远）在不交出种子的前提下给同事一段时间的验证码，例如 Ente Auth v4 的预计算码分享："Ente will pre-compute the codes for this duration… Your 2FA secret… is not shared"（[Ente 2024-10-12](https://ente.com/blog/auth-v4/) [转录]）。

**不需要的**：
- 自动填码：AdsPower Authenticator 的做法需要内容脚本，而它宣传的用途正是规避风控，超出范围。
- 每个种子分别设权限。

---

## 2. 候选功能表

复杂度以现有代码和 SYNC-DESIGN 里程碑为参照：
- **S**：在现有模块内改动，不改格式，约半天到一天，另加测试。
- **M**：新的 UI 流程，或需要仔细定义语义，约 2–4 天。
- **L**：新的密码学对象、协议或服务端设计。

| # | 功能 | 来源（产品 / 用户需求） | 安全/隐私价值 | 复杂度 | 与零追踪/零网络/最小权限冲突？ | SYNC-DESIGN 已覆盖？ |
|---|---|---|---|---|---|---|
| F1 | **添加第一个账户前必须设主密码**（新安装不再进入设备密钥模式；已有的设备密钥库保留，但持续警告） | Q1：GoLogin、Kameleo、MLX、AdsPower、BitBrowser、VMLogin 都能把扩展存储带离本机；BitBrowser 2023 事件；PLAN §15 的 LevelDB 残留问题 | 高 | S（`enableMasterPassword` 已有；改首次运行流程和欢迎页） | 无 | 部分：D4 只要求同步时必须有主密码；Phase 0 仍是开放问题 |
| F2 | **选择性加密导出**：按分组或勾选的账户导出 `sixkey-backup` v1 子集，在另一个配置文件里用现有"导入备份"（added/merged 模式）导入 | Q3/Q6：一个配置文件一个账号；AdsPower 复制会连 2FA 一起复制；最小化放入共享配置文件的内容 | 高 | M（`createBackup` 可以直接接收子集 Vault；难点在子集语义：排除回收站、墓碑、未选条目的任何字段；测试"子集里不含任何未选数据"。**子集一律使用新的 vaultId**：若沿用源 vaultId，恢复到新配置文件后会得到"同 vaultId、不同 VK"的库，日后入网时落入 SYNC-DESIGN I6/§3.5 没处理的情况；用新 vaultId 时，再次导入更新后的子集走 added 模式，按 secret + issuer + label 去重，现有代码已支持） | 无 | 否 |
| F3 | **导出前重新输入主密码**（明文导出和加密备份都要） | Q3：成员会坐在已解锁的共享配置文件前；目前明文导出只要"已解锁 + 勾选"（`options/Backup.tsx`） | 中 | S | 无 | 否（§3.14 只管服务器端的敏感操作） |
| F4 | **安装来源自检**：`chrome.management.getSelf()`（"can be used without requesting the 'management' permission"）检查 `id` 是否等于商店 ID、`installType` 是否为 `normal`；不一致时持续提示"此副本不是从 Chrome 应用商店安装，不会自动更新"；官网公布扩展 ID 和构建哈希 | AdsPower 2025 投毒；AdsPower、Kameleo、VMLogin、BitBrowser 都用 zip、crx 或未打包目录安装；BitBrowser 修过"custom extension caused an ID change" | 中（对恶意副本无效，它可以删掉这项检查；但能发现"旧版未打包副本"，并给用户一个可核对的 ID） | S（依赖：商店 ID 要到 CWS 首次提交时才有，即 Phase 2 / 任务 13，之前只能留常量位；dev 与 e2e 构建以未打包方式加载，必然触发提示，需要按构建关闭或在 e2e 中断言它出现） | 无（无需新权限，[API 文档](https://developer.chrome.com/docs/extensions/reference/api/management) [复核]） | 否 |
| F5 | **首次运行问一句"这个配置文件会被共享、同步到厂商云，或由脚本控制吗？"** 选"是"时预设"每次都锁定"，并引导开启剪贴板清空（"每次都锁定"模式下 VK 只在 popup 或打开着的设置页内存中，设置页闲置 15 分钟后锁定，见 SECURITY.md） | Q1/Q2：本地 API 交出 CDP，鉴权可选；Puppeteer 可在扩展 SW 中 `worker.evaluate`（[pptr.dev 2026-01-15](https://pptr.dev/guides/chrome-extensions) [复核]） | 中 | S（自动锁模式 `always` 已有） | 无 | 否 |
| F6 | **本地安全记录 + 安全状态卡**：记录失败解锁次数（解锁后提示"上次以来 N 次错误密码"）、导出、改密码/轮换、自动恢复；附"本机存了什么"清单（是否有设备密钥、快照数、上次备份、网络请求 = 0） | AdsPower、BitBrowser、VMLogin、Octo 的操作日志；AdsPower 的失败登录告警 | 中（是告警线，不是证据：持有配置文件副本的人可以改它） | S（`parseEvents` 已接受任意 kind；诊断日志已有） | 无（只存本地，不含账户名） | 否（Phase 1 只有同步横幅） |
| F7 | **本地纯文本密钥行导入**：接受 `名称\|密钥` 和裸 base32 行，预览后由用户确认密钥列，**只取 2FA 字段，丢弃其他列**（不保存密码） | Q6：2fa.live 的批量 `\|` 行、会外传种子 | 中（替代外传种子的网站） | S（扩展 `planImport`，补边界测试） | 无 | 否 |
| F8 | **文档：《在指纹浏览器中使用 Sixkey》**：厂商云、克隆、共享、转移、本地 API/CDP 各意味着什么；只通过商店链接安装；转移前先卸载 Sixkey；共享配置文件只放 F2 子集 | 全部 | 高 | S | 无 | 部分：§4.10 只有一句帮助文案 |
| F9 | Phase 1（M2 之前定设计）：**IndexedDB 丢失而 `storage.local` 仍在**时的身份处理 | GoLogin SDK 每次停止都删 IndexedDB；AdsPower、BitBrowser 的 IndexedDB 同步默认关闭 | 高（可靠性；避免设备行无限增长、反复要求批准） | M | 无 | **否**：§2.5、§4.13 假设身份库比 storage.local 更持久 |
| F10 | Phase 1：克隆检测从 M7 提前到 M6，检测到克隆时同时重新生成 `sk_device` | BitBrowser `syncUserExtensions`；Kameleo 的 exact clone；AdsPower 复制 30 份 | 中 | S–M（§4.10 已有设计） | 无 | 是（列为 M7 可选） |
| F11 | Phase 1（M4 服务端 + M5 客户端）：服务器状态响应带 `min_client_version`，过旧的客户端停止同步并提示更新 | AdsPower "do not auto-update"；Kameleo、VMLogin 用 crx/未打包安装 | 中 | S | 无 | 部分：§3.13 的 `paused_newer` 只处理"远端格式比本机新" |
| F12 | Phase 1（M5/M6）：在旧内核上跑 CI（例如 Chromium 120 和 134） | 内核滞后：Orbita 153 对 Chrome 155；VMLogin 为 Win7/8.1 保留 109；BitBrowser 最新只查到 134 | 中（可靠性） | S | 无 | 否 |
| F13 | Phase 1（M2）：`sixkey-identity` 不再明文保存邮箱 | 配置文件副本会到厂商和团队手里 | 低–中 | S | 无 | 否（§2.5 明文存了 email） |
| F14 | 设备列表、吊销、新设备横幅、敏感操作要求主密码 | AdsPower 会话管理与敏感操作 2FA；GoLogin、Incogniton 设备列表 | 高 | — | 无 | **是**（§3.2、§3.10、§3.14、O8、P4） |
| F15 | 设备名端到端加密 | 配置文件名常是店铺或账号名 | 中 | — | 无 | **是**（C6） |
| F16 | 复制时当前域名与条目不匹配则提示（防钓鱼） | 通用需求（AiTM，见 security-incidents-report），非厂商功能 | 中 | S（`match.ts` 已有） | 无 | 否 |
| F17 | 新设备加入时发邮件提醒 | AdsPower 异地登录提醒；GoLogin 未知位置邮件 | 低（几乎所有入网路径的攻击者都已控制邮箱，能删掉提醒） | S–M（服务端） | 不违反 D3（前提是不含 IP） | 否 |
| F18 | 带 IP/地理位置的登录提醒、IP 白名单 | AdsPower、Incogniton | 低 | M | **冲突 D3** | 否 |
| F19 | WebRTC/DNS/IP 泄露检测 | 所有厂商 | 与 2FA 无关 | M | **冲突零网络** | 否 |
| F20 | 内容脚本自动填码 | AdsPower Authenticator | 负（注入面；宣传用途是规避风控） | M | **冲突最小权限** | 否 |
| F21 | 团队角色 / "能用码不能看种子"的成员权限 | MLX、BitBrowser、MoreLogin、Bitwarden | 低（客户端强制） | L（真做需要每人密钥） | 无 | Q7：明确不做 |
| F22 | 限时共享验证码（预计算码，不交出种子） | Ente Auth v4；1Password 到期链接；Incogniton 到期共享 | 中 | M–L（新格式，或需要服务器） | 若走服务器则冲突零网络 | 否 |
| F23 | 错误密码 N 次锁定或自毁 | Octo 明确不限次数 | 低（不影响对副本的离线爆破） | S | **冲突"永不丢数据"**（自毁） | 否 |
| F24 | 多保险库 / 按分组密钥同步 | — | 中 | L | 无 | 否 |
| F25 | "记住我"/PIN，减少多配置文件解锁次数 | Q4 摩擦 | 负（等于设备密钥） | S | 冲突安全目标 | Q4：已决不做（2026-10-19 所有者收窄：只存于内存、浏览器重启即失效的会话解锁获准（Sixkey 的 PIN 后备，以及没有 PRF 时只作门禁的 Touch ID / Windows Hello），存进配置文件的仍不做；见 `docs/design/proposals/QUICK-UNLOCK.md` §0.5 Q1） |

F9–F13 都落在 SYNC-DESIGN 现有的里程碑里（F9 在 M2 之前定设计，F10 在 M6，F11 在 M4/M5，F12 在 M5/M6，F13 在 M2），属于 Phase 1 的工作量，**不计入**下一节 Phase 0.x 的预算。

---

## 3. 推荐清单与复杂度预算

**预算（硬约束）**
- Phase 0.x 的"安全加固"最多 1 个 M，其余全是 S，不出现 L。
- 不新增任何 permission 或 host_permission。
- Phase 0 仍然零网络：CSP 与 check-dist 不变。
- 不新增加密格式：子集导出复用 `sixkey-backup` v1，安全记录复用现有事件机制。
- 每项都必须带测试（PLAN §13 第 3 条）。

**推荐做（按"每单位复杂度换来的保护"排序）**

| 顺序 | 项 | 复杂度 | 为什么值得 |
|---|---|---|---|
| 1 | F1 首个账户前必须设主密码 | S | 一次性关闭两个洞：厂商/团队拿到配置文件副本即可解密，以及 LevelDB 残留（PLAN §15、SECURITY.md）。代价是多配置文件用户每次重启都要输密码（Q4），已决定接受。同一个人在所有配置文件用同一个主密码即可。 |
| 2 | F8 指纹浏览器使用指南 | S | 零代码，覆盖安装渠道、克隆、转移、共享、CDP 的全部风险。很多风险只能靠用户的使用方式来规避。 |
| 3 | F2 选择性加密导出 | M | 共享或上云的配置文件里只放那 1–3 个种子，把爆炸半径从"全部账户"降到"这个配置文件的账户"。Phase 1 之后同样是团队场景的正确答案（见第 4 节 d5）。 |
| 4 | F3 导出前重输主密码 | S | 目前 UI 里唯一能拿到种子的路径就是导出。堵上它，"坐到已解锁电脑前的同事"就只能拿到验证码，拿不到种子。 |
| 5 | F5 高风险配置文件预设 | S | 只改默认值，不加机制。把 CDP 能读到解锁 VK 的窗口，从"闲置 15 分钟"缩短到"popup 或设置页打开期间"。 |
| 6 | F6 本地安全记录 + 状态卡 | S | 让用户发现共享配置文件里有人试过密码、导出过数据，同时做本地数据透明化。 |
| 7 | F4 安装来源自检 | S | 便宜，能发现不会自动更新的旁加载副本，也给了用户可核对的扩展 ID。如实说明它防不住恶意副本。 |
| 8 | F7 本地纯文本密钥行导入 | S | 把用户从会外传种子的 2fa.live、2fa.cn 拉回本地。必须丢弃除密钥以外的所有列。 |

**明确不做**
- **F19 WebRTC/DNS/IP 泄露检测**：需要联网，与 2FA 无关，是反检测工具的地盘。
- **F18 带 IP 的登录提醒、IP 白名单**：违反 D3（不收集 IP）。Phase 1 已有不含 IP 的"新设备加入"横幅（§3.3、P4）。
- **F17 新设备邮件提醒**（暂不做）：批准入网和恢复码入网都要求新设备先过邮箱 OTP，攻击者通常已经控制邮箱、能删邮件；只有邀请码路径不经过邮箱，而它又需要 `pw_auth`。价值低于 SMTP 模板和防滥用的成本。
- **F20 内容脚本自动填码**：需要内容脚本和 host 权限；其宣传用途（"mitigates… suspicions of antifraud systems"）超出范围；还会把 Sixkey 变成网页可接触的攻击面。
- **F21 团队角色 / 隐藏种子的成员权限**：只能做到客户端强制（Bitwarden、1Password 自己都承认），给的是虚假的安全感。真做需要每人独立密钥，即 Q7 说的另一套设计。
- **F22 限时码分享**（Phase 1 之前不做）：需要新格式或服务器；而且同事拿码登录后，cookie 会话照样在他手里，增量价值有限。等 F2 上线后看需求再议。
- **Sixkey 同步账户本身的 TOTP 2FA**：账户会话读不到任何东西（§0.1），数据由设备签名、批准入网和主密码把守。再加一层只会增加找回负担。
- **F23 错误次数锁定或自毁**：对复制走的配置文件做离线爆破不受 UI 限制；自毁违反"永不丢数据"，还会变成同事手里的拒绝服务按钮。用 F6 的告警代替。
- **远程抹除**：离线副本无法保证被抹掉，承诺了也兑现不了。诚实的版本是吊销、轮换、重绑，SYNC-DESIGN §3.10 已有。
- **检测"是否运行在指纹浏览器或自动化环境中"**：近似于浏览器指纹，而厂商会伪造 `navigator.webdriver` 等信号，不可靠。改为直接问用户（F5）。
- **F24 多保险库 / 分组密钥同步**：L。在那之前用 F2，或给每个人一个独立的同步账户。
- **F25 "记住我"/PIN**：等于把设备密钥放回配置文件，而厂商会复制配置文件（Q4 已决）。
- **系统钥匙串 / native messaging 存设备密钥**：需要 `nativeMessaging` 和本机安装程序，破坏"只是一个扩展"的定位；配置文件被同步到另一台机器时钥匙串不跟着走，会导致无法解锁。
- **Phase 0 单独的"抹掉本机"按钮**：卸载扩展就会清除它的存储，效果相同。真正需要的是在 F8 里说明"厂商云端副本不会因卸载而消失"。

---

## 4. SYNC-DESIGN.md 应修改之处

我没有修改 SYNC-DESIGN.md。以下是建议，按重要性排序。

**d1. §11 Q6 / §12 中"未决：需实测"的部分可以先用文档回答，§1.2 A3 与 §4.10 的措辞应升级。**
- 文档证据表明，多数厂商**能**把扩展存储带离本机：
  - GoLogin 同步本身就包含。
  - Kameleo 的复制和导出都包含。
  - MLX 转移包含 Extensions 和 Local storage。
  - AdsPower、BitBrowser、VMLogin、Dolphin 有可选开关。
  - BitBrowser 还能跨配置文件同步扩展数据。
  - 证据见 Q1 表。
- 因此 A3"配置文件副本"应写成**常态**，并补上 BitBrowser 2023 这个先例。
- §4.10 最后一句"厂商同步配置文件 = A3"可以加上具体厂商名和来源。
- 实测仍然需要，但目标应缩小为：IndexedDB 是否同步、克隆是否含 `Local Extension Settings`、AdsPower 通过"扩展"板块安装时的行为。

**d2. §2.5、§4.13（C7）："身份库比 storage.local 更持久"这个前提不成立。**
- GoLogin SDK 每次停止都删除 `Default/IndexedDB`，也不上传（[gologin.js `sanitizeProfile`/`stopAndCommit`](https://github.com/gologinapp/gologin/blob/40329508d12965409a5539f8e7b1f6a2492d30bb/src/gologin.js) [复核]）。AdsPower、BitBrowser 的 IndexedDB 同步默认关闭。
- 后果一：在这些环境里，DSK 每次启动或每换一台机器就消失，配置文件不得不反复入网。设备行会累积（§5.5 的上限是 200），其他设备会被批准请求刷屏。
- 后果二：Phase 0 的 IndexedDB 镜像在这些环境里也不是"库外冗余"。这一点还影响 SECURITY.md 的"Limits"一节。
- 建议：
  - 把"`storage.local` 显示已入网，但 `sixkey-identity` 不存在"列为一等状态，界面上明确说明原因，并提供一键重新入网（邀请码最合适，§3.4）。
  - 新增一个 OPEN QUESTION："是否把 DSK 私钥以 VK 加密的 JWK 形式在 storage.local 另存一份"。取舍是：需要可导出的密钥；锁定状态下不能签名；但 non-extractable 本来就挡不住"复制 IndexedDB 文件"。
- 这一项要在 M2 之前定。

**d3. §4.10 克隆软检测从 M7 提前到 M6，并扩大处理范围。**
- 克隆是厂商的日常功能：Kameleo 的 exact clone、AdsPower 一次复制 30 份、BitBrowser 跨窗口同步扩展数据。
- 同一个云配置文件也会在两台机器上先后打开（Kameleo "Only one device can use a cloud profile at a time"，[转录](https://help.kameleo.io/article/56-cloud-stored-profiles)）。
- 检测到克隆后，除了建立独立身份，还应重新生成 HLC 设备 ID `sk_device`（§4.10 已提到，建议写进验收标准）。

**d4. §1.2 新增攻击者 A10"能连接配置文件调试端口的本机进程"，§1.3 同步改写。**
- 证据：
  - AdsPower：只有 "When enabling security verification" 才要求 API Key，启动接口返回 `ws.puppeteer`（[复核](https://localapi-doc-en.adspower.com/docs/Rdw7Iu)）。
  - BitBrowser：Token 是"公网环境"下的可选项（[复核](https://doc.bitbrowser.net/updatelog.md)）。
  - VMLogin：本地接口 `http://127.0.0.1:35000/api/v1/profile/start` 没有任何鉴权文档（[转录](https://www.vmlogin.us/help/api/start-browser-profile.html)）。
  - Kameleo：OpenAPI 无 securitySchemes，即文档未写任何鉴权（[swagger.json v5.3.1](https://developer.kameleo.io/static/swagger.json) [复核]）。配置参考表写 `ListeningHost` 默认 `+`，即"accepts connections from any network interface"（[复核](https://developer.kameleo.io/05-reference/06-configuration-options.md)），而安装/配置页说默认监听 `localhost:5050`（[转录](https://developer.kameleo.io/01-getting-started/03-configure.md)），两处矛盾。
  - Puppeteer 可以在扩展 SW 中执行代码（[复核](https://pptr.dev/guides/chrome-extensions)）。
- 应如实写明：
  - 这类进程在解锁期间可以读走 VK。
  - 用户在设置页输入主密码时，它也能读走密码，此时 `pw_auth` 不再构成屏障。
  - 缓解手段只有"每次都锁定"（F5），以及不要在被脚本控制的配置文件里开启同步。
- 这比"不防恶意软件"更具体：在这个场景里，"恶意软件"可能就是团队自己的自动化脚本，或者局域网上的另一台机器（按 Kameleo 配置参考表的默认值，本地 API 可能从局域网可达）。

**d5. §3.4 邀请码、§12 Q3、§1.3、Q7：邀请码的前提被削弱；给"同步进共享配置文件"加一道闸门，并写明团队路径。**
- §3.4 和 §12 Q3（已"采纳"）的前提是：用户一次新建几十个配置文件，并把每个都加入同一个库，于是每个配置文件都拿到**整个库**。Q6 的证据指向相反方向：常态是一个配置文件一个（或几个）账号，多人共用一个配置文件；"同一组种子进几十个配置文件"没有找到证据。
- 因此建议二选一，由所有者决定：
  - (a) 保留邀请码，但把 F2 子集导出写成"批量配置文件 / 共享配置文件"的**文档推荐路径**，邀请码只用于"同一个人自己的、不共享、不上厂商云"的配置文件；
  - (b) 把邀请码从 M7 推迟到上线后，看到真实需求再做。
  - 我倾向 (b)：它省掉一个持有者凭证（§10 第 19 条的残余风险）和一组端点（§5.4 invites），而 F2 在 Phase 0 就能满足"给新配置文件放几个种子"。
- 团队的常态是多人共用一个配置文件（Q3、Q6）。把一个已入网设备放进共享配置文件，每个能打开它、又知道主密码的人，就拿到了**整个库**。
- 建议：
  - 邀请码生成页和入网确认页（O6）加一句："这个配置文件会被他人使用、或同步到厂商云吗？若是，所有人都能看到全部账户。建议改用'导出所选账户'（F2）。"
  - §1.3"不提供团队共享"之后补一句推荐做法："一个同步库 = 一个人；给共享配置文件用子集导出。"
  - 吊销清单（§3.10、O10）在团队场景下提示"轮换此人见过的种子"，参照 Bitwarden 的离职建议。

**d6. §5.2 CORS、§7、§3.13：扩展 ID 与旧版本。**
- 厂商常用 zip/crx 或未打包目录安装：AdsPower 让用户用 CRX Extractor 打 zip，且"Auto-update of personal extensions is not supported"（[复核](https://help.adspower.com/docs/extensions)）；Kameleo 用 crx；MLX、BitBrowser、VMLogin 用未打包目录或 `--load-extension`。
- 未打包扩展的 ID 由路径决定，除非 manifest 带 `key`（[chromium extension.h](https://chromium.googlesource.com/chromium/src/+/main/extensions/common/extension.h) [转录]）。
- 建议：
  - 服务器任何安全判断都不依赖 `Origin`。现设计 CORS 只防网页读取响应，SW 带 host 权限本来就绕过 CORS，这一点已经成立，建议明文写出，免得以后有人加"按 Origin 拒绝"。
  - 在 `GET /v1/sync/status` 返回 `min_client_version`（F11），让永远不会自动更新的旧副本优雅停止同步，而不是用旧逻辑写入。
  - 客户端做 F4 自检。

**d7. §2.5：`DeviceIdentity.email` 不明文落盘（F13）。** 配置文件副本会落到厂商和团队手里，明文邮箱等于告诉他们"这个配置文件用了 Sixkey 同步，账号是谁"。可以改为只显示"已登录"，或者用 VK 派生的密钥加密。

**d8. §8.6–8.7 测试：** 增加一个在旧 Chromium（≥ `minimum_chrome_version` 120，例如 134）上跑的同步 e2e（F12）。Phase 1 新用到的 WebCrypto ECDH/ECDSA、`storage.session`、offscreen 都应在这个版本上验证。

**顺带：PRIVACY.md 和 SECURITY.md 下次更新时要改两处（不属于 SYNC-DESIGN）**
1. "removing the extension deletes all its stored data"在厂商云同步的配置文件里不成立：云端副本还在。
2. IndexedDB 镜像在部分指纹浏览器里每次启动都会被清空。

---

## 5. 未能核实的说法

- Dolphin{anty} 2022-07 泄露"15% 配置文件数据"：只有竞争对手 Octo 的说法，一手来源未找到。
- AdsPower 2025-01 事件的受害人数（5 / 2 万 / 3.4 万）与起始时间（OneKey 说 01-17）：各方矛盾，没有官方数字。AdsPower 的 X 原帖无法抓取。
- AdsPower 声称的 "end-to-end encryption" 的实现与密钥归属；`fakey` 种子在服务器上如何存储；AdsPower Authenticator 是否真的"never be uploaded"。
- AdsPower 本地 API 的"安全校验"是否默认开启；BitBrowser 本地 API 默认端口 54345、无鉴权（仅第三方 HackMD 指南）；Multilogin launcher 是否拒绝不带 token 的请求。
- GoLogin **桌面版**（不是 SDK）是否在客户端加密配置文件，以及是否同样删除 IndexedDB。
- MLX 克隆是否包含扩展存储；VMLogin "Extension storage" 是否包含 `chrome.storage`；Incogniton 云保存是否包含扩展存储。
- Dolphin 帮助中心的 "Extension Filesystem sync" / IndexedDB 同步页面（404，只见摘要）。
- Multilogin 旧版 "AES… master password" 页面（HTTP 402，只见摘要）。
- GoLogin 用户关于 cookie 被盗、内部人员出售数据的说法：没有独立证实。
- Chromium `constants.cc` 中 "Local Extension Settings" 常量：googlesource 返回 503，只见搜索摘要。
- 中文论坛对厂商数据管辖地的担忧、Reddit 与 BlackHatWorld 帖子正文：无法访问。
- "同一组种子需要放进几十个配置文件"是常见需求：未找到证据。
