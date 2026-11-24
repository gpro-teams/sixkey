# Sixkey

> 本文是 [README.md](README.md) 的中文译本。两者不一致时，以英文版为准。

Sixkey 是一个 Chrome 两步验证器：一个 Manifest V3 扩展，把 TOTP 密钥加密保存在浏览器配置文件里，在工具栏弹窗中显示
6 位验证码。本仓库还包含一个可选的端到端加密同步服务及其 API 契约，二者都尚未发布。Sixkey 是 g.pro 旗下的产品，
由 VIEW TECH LTD 发布和维护。

> **现状（2026 年 11 月 22 日）：扩展已上架 Chrome 应用商店，其余部分尚未发布。**
>
> - **扩展（`extension/`）** 已上架 [Chrome 应用商店](https://chromewebstore.google.com/detail/bbfpkjnpfcddoagjiadebfafdfbckpho)，
>   形态是**只在本机**的验证器。商店版本不发任何网络请求，也没有开启同步的入口。它可以和同一台 Mac 上的 Sixkey app
>   联动（设置 › 高级），只经过 Chrome、只在这台电脑上；Sixkey for Mac 还没有发布。
> - **服务器同步已经搁置。** 扩展里的同步客户端（同步引擎、后台的同步和网络传输，以及设置页用邮箱登录的"同步"一节）
>   已经从所有版本里删掉，开发版本也一样；需要时可以从历史里找回。服务器和 API 契约保留，测试照旧，留给以后可能做的
>   付费云。同一个人的多台设备以后改用 Chrome 同步。
> - **同步服务器（`api/server/`）与 API 契约（`api/openapi.yaml`、`contract/`）尚未发布。** 服务器只能在开发与测试
>   模式下运行：在生产环境的登录提供方实现之前，它拒绝以生产模式启动。
> - **暂时无法自行部署。** 原因见 [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)（英文）。
> - **YubiKey 支持只是设计提案**（[docs/design/proposals/YUBIKEY-DESIGN.md](docs/design/proposals/YUBIKEY-DESIGN.md)）。
> - **还没有做过外部安全审计。** [docs/audit/](docs/audit/README.md) 里的评审记录是 AI 模型的评审会话，不是第三方审计。
> - **开源**：扩展用 MPL-2.0，服务器用 AGPL-3.0-or-later，契约用 Apache-2.0 与 CC0-1.0，文档用 CC-BY-4.0（见[许可证](#许可证)）。
>
> 接下来做什么、按什么顺序：[ROADMAP.md](ROADMAP.md)（英文）。

## 功能

- 显示 TOTP 验证码（RFC 6238；SHA-1、SHA-256 或 SHA-512；6 位或 8 位），与当前网站匹配的账户排在前面。HOTP 账户
  可以保存和备份，但暂时不能生成验证码。
- 可从 `otpauth://` 链接、Google 身份验证器的导出二维码（截图，或在设置页用电脑摄像头扫描）、当前页面上或粘贴的截图里的
  二维码、纯文本密钥行、其他应用未加密的导出文件（链接列表、Aegis、2FAS、andOTP、Raivo、Bitwarden、FreeOTP+、Proton
  Authenticator、CSV）以及 Sixkey 备份文件添加账户。从文件导入之后，会询问是否删除那个文件。
- 库由一把密钥加密，这把密钥受主密码和恢复密钥保护。两者都丢失时，任何人都无法恢复数据，这是有意的设计。主密码由你自己设；
  随机生成的恢复密钥可以拆成分片，3 份里任意 2 份、或 5 份里任意 3 份就能拼回来。
- 平时用 4 到 8 位的 PIN 解锁（浏览器重启后也能用），也可以用 Touch ID 或 Windows Hello。
- 点"填写"或按填写快捷键，把当前验证码填进网页的验证码框，只对登记了这个网站的账户。在你逐个开启的网站上，工具栏图标还会
  提示这里可以填写。它从不替你提交表单。
- 自动备份到浏览器自带的同步存储，2026-11-08 起已在构建里：每次改动约 30 秒后，把保险库的加密副本写进去（Sixkey 锁着时也会写），
  Chrome 同步会把它带到登录同一 Google 账户的其他电脑；新电脑上用主密码或恢复密钥恢复。
  在只有你自己用的浏览器配置文件里，新保险库在首次运行最后一步默认勾选开启；已有的保险库点一下就能开启；备份状态一直看得见。
  Sixkey 只能确认已交给 Chrome，看不到 Chrome 是否上传成功（[记录](docs/design/notes/CSB-NOTES.md)，英文）。
  加密备份文件（设置 › 备份）照旧保留。通过单独插件的 Google 云端硬盘备份已于 2026-11-06 撤下。
- 列表可以显示在浏览器的侧边栏里，不用弹窗。
- 在本机保留多份副本（两个槽位、滚动与每日快照、IndexedDB 里的第二份副本），崩溃或写坏一次不会丢失已保存的数据；
  并提醒你导出加密备份。
- 每次导出都要再确认一次（输 PIN；没有 PIN 时输主密码），并在本机记录输错的 PIN、密码和导出操作。
- 不用离开弹窗就能调整列表的样子：搜索框旁的"外观"按钮（太阳图标）可以切换主题、行距（标准或紧凑）、排序，以及是否隐藏验证码，
  与"设置 › 外观"里的四个选项相同；侧边栏里同样可用。

本地库如何工作、防什么、不防什么：[docs/security/local-vault.md](docs/security/local-vault.md)（英文）。存了什么、存在
哪里：[docs/PRIVACY.md](docs/PRIVACY.md)（英文）。

## 承诺，以及每条承诺由什么来保证

| 承诺                                                                                                                                                             | 在哪里强制或检查                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 商店版不为备份发送网络请求：加密副本放在 `chrome.storage.sync`，由 Chrome 自己的同步带走；只有 service worker 写它，而且要等浏览器把它对网页脚本关上之后才写。   | `extension/manifest.base.json`；`extension/src/platform/csb-area.ts`；`extension/test/unit/source-rules.test.ts`；`extension/test/e2e/csb-probe.spec.ts`                          |
| 核心只在开启同步并接受 Chrome 权限提示后，才从 service worker 访问同步 API。                                                                                     | 核心清单 CSP、`extension/src/platform/api-permission.ts`、`check-dist.mjs`、`extension/test/regression/network.spec.ts`                                                           |
| 安装时没有 host 权限，没有在清单里声明的内容脚本，没有远程代码，没有 `nativeMessaging`。只在你开启了验证码提示的网站上运行自己的小脚本，且要等你亲自点进输入框。 | `extension/manifest.base.json`；清单与预期不符、含内联脚本或远程资源时，`check-dist.mjs` 让构建失败                                                                               |
| 只响应自己的页面。它在你开启的网站上运行的脚本只能发一条消息，而且得不到任何回答；其他扩展和网页都无法联系它。                                                   | `extension/src/platform/sender-policy.ts` 检查每条消息的发送方；`extension/src/platform/content-channel.ts`；清单没有 `externally_connectable`；`check-dist.mjs` 拒绝监听外部消息 |
| 所有密码学操作都来自浏览器的 WebCrypto，不用第三方密码库。                                                                                                       | `extension/package.json`（没有密码学依赖）；[docs/security/local-vault.md](docs/security/local-vault.md) 的 Cryptography 一节                                                     |
| 没有统计、跟踪或崩溃上报。                                                                                                                                       | 没有网络路径（见上）；服务器日志字段是白名单（`api/server/sixkey_server/applog.py`）                                                                                              |
| 同步（尚未发布）：服务器看不到你的密钥、库密钥、主密码或恢复密钥。                                                                                               | 端到端加密的设计：[docs/SYNC-DESIGN.md](docs/SYNC-DESIGN.md) §1.2（攻击者 A1）与 §2；`contract/vectors/` 里的已知答案向量                                                         |
| 本机功能永远不会被锁在付费托管服务后面。                                                                                                                         | 项目承诺，不是代码：[GOVERNANCE.md](GOVERNANCE.md)（英文）                                                                                                                        |

每一条的局限都如实写明：见 [docs/security/local-vault.md](docs/security/local-vault.md) 的 "Limits you should know
about" 与 "Known gaps"，以及同步威胁模型（SYNC-DESIGN §1.2）的残余风险一栏。

## 构建与测试

需要：扩展用 Node.js 22 与 npm 10；服务器用 Python 3.14 与 PostgreSQL 14 或更高版本（`initdb`、`pg_ctl`）。不需要
Docker。命令在各代码块注明的目录下运行。

**扩展**（`extension/`）：

```
npm ci
npm run typecheck     # TypeScript 严格模式
npm test              # 单元、故障注入与回归测试（vitest）
npm run build         # 商店版本 -> dist/（在 chrome://extensions 以"加载已解压的扩展程序"载入）
npm run check         # check-dist：按硬性规则检查构建结果
npm run build:test    # 手工测试用：商店版本，名字是"Sixkey (test)"，扩展 ID 固定 -> dist-test/
npm run build:dev     # 开发版本，含商店版本里关着的功能 -> dist-dev/
npm run e2e           # 在 Chromium 里跑端到端测试；需要先执行一次 `npx playwright install chromium`，并且 127.0.0.1:8787 空闲
```

**服务器**（`api/server/`）：

```
make venv             # 只需一次：按 requirements-dev.txt 的确切版本建立 .venv
make check            # 在 .pg/ 里启动一个私有 PostgreSQL（只用 unix socket），然后运行测试
make run              # 在 http://127.0.0.1:8787 提供 API（扩展的任何版本都不再连接它）
```

**契约**（在仓库根目录）：

```
node contract/tools/gen-vectors.mjs --check            # 重新计算每个已知答案向量；与文件不同则失败
python3 -I contract/tools/check_consistency.py          # 对照设计文档与 api/openapi.yaml
(cd api/server && make contract)                        # Python 参考实现的检查，使用 venv 里的 cryptography
```

修改的规则见 [CONTRIBUTING.md](CONTRIBUTING.md)（英文），各部分如何组合见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
（英文）。

## 仓库结构

| 路径               | 内容                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension/`       | Chrome 扩展（TypeScript、Preact、Vite）。`src/core` 是纯逻辑（TOTP、密码学、库、存储、备份）；`src/platform` 把它接到 Chrome；`src/popup`、`src/sidepanel`、`src/options`、`src/background`、`src/offscreen` 是扩展的各个上下文 |
| `api/server/`      | 同步 API（FastAPI、PostgreSQL），尚未发布                                                                                                                                                                                       |
| `api/openapi.yaml` | API 契约：29 个操作、错误、限额、请求签名（JSON 语法，也是合法 YAML）                                                                                                                                                           |
| `contract/`        | 扩展与服务器共用的已知答案测试向量、向量生成器、另行编写的 Python 参考实现，以及对照设计文档与契约的检查器                                                                                                                      |
| `docs/`            | 设计、安全与隐私文档，以及审计记录。索引见 [docs/README.md](docs/README.md)                                                                                                                                                     |
| `tools/`           | 扩展之外的开发工具：`webauthn-probe/`，一个仅供开发的扩展，为快速解锁的设计在真机上测量通行密钥（passkey）的能力                                                                                                                |
| `LICENSES/`        | 各许可证的全文；`REUSE.toml` 把每个路径对应到它的许可证（[LICENSE.md](LICENSE.md)，英文）                                                                                                                                       |

## 本项目是怎样做出来的

Sixkey 由一位维护者与 AI 编码代理（Anthropic 的 Claude）一起设计和维护。代码、测试和大部分文档都是这样写成的；与安全
相关的改动在合入前，都由另外的 AI 模型评审会话评审过。这些评审记录及每条发现的处理结果公开在
[docs/audit/](docs/audit/README.md)。它们不是独立审计：外部审计还没有做。欢迎按 [CONTRIBUTING.md](CONTRIBUTING.md)
的规则参与贡献。

## 安全

请按 [SECURITY.md](SECURITY.md)（英文）私下报告漏洞：通过 GitHub 私密漏洞报告，或发邮件到
[security@g.pro](mailto:security@g.pro)。不要为安全问题开公开 issue。本项目没有付费的漏洞赏金。

## 许可证

每个部分都开源，各用适合它的许可证（理由见 [LICENSE.md](LICENSE.md)，英文；`REUSE.toml` 列出每个路径）：

| 部分                                                  | 许可证            |
| ----------------------------------------------------- | ----------------- |
| 扩展（`extension/`、`tools/`）                        | MPL-2.0           |
| 同步服务器（`api/server/`）                           | AGPL-3.0-or-later |
| 契约的代码（`contract/tools/`、`contract/py/`）       | Apache-2.0        |
| 契约的数据（`api/openapi.yaml`、`contract/vectors/`） | CC0-1.0           |
| 文档                                                  | CC-BY-4.0         |

贡献须按开发者原创证书（DCO）签署（[CONTRIBUTING.md](CONTRIBUTING.md)，英文）。付费部分只限于托管的同步服务
（[GOVERNANCE.md](GOVERNANCE.md)）。第三方组件保留各自的许可证：[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

"Sixkey" 名称与图标是 VIEW TECH LTD 的商标（未注册），见 [TRADEMARKS.md](TRADEMARKS.md)。
