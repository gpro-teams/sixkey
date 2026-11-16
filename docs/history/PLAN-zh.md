# Sixkey 开发计划书 v2（修订草案，仅 Chrome 扩展）

> **History, not current.** Sixkey's original product plan (in Chinese), from 2026-10, kept for the record. It was
> replaced by [ROADMAP.md](../../ROADMAP.md); the rules for contributors are [CONTRIBUTING.md](../../CONTRIBUTING.md).
> Its status notes (§15), open questions (§14), goals and figures are those of its date and are not updated, and its
> file references are to the tree of that date. Paths under `scratchpad/` were temporary working copies and were not
> retained. 历史文档，不再更新：Sixkey 最初的产品计划，已由 ROADMAP.md 取代；贡献规则见 CONTRIBUTING.md。文中的状态
> 记录（§15）、开放问题（§14）、目标与数字都是当时的，文件引用对应当时的代码树。

> 产品：Sixkey — 浏览器里最顺手、永远不丢码的 2FA 验证器
> 域名：sixkey.app（API：api.sixkey.app；开发期可用 auth.g.pro）
> 主体：VIEW TECH LTD
> 技术栈：Chrome 扩展（MV3 + TypeScript + Preact + Vite）+ FastAPI + Supabase
> 状态：**草案，待审阅**。基于 v1 计划书 + 2026-10-15 技术调研（Chrome 155 实测）修订。
> 修订标记：`【已决】` = 用户已拍板；`【默认】` = 采纳调研推荐值，待确认；`【新增/变更】` = 相对 v1 的改动。

---

## 0. 项目目的

一次实验：**一个使用频率极高、门槛极低、竞争极度内卷的工具，靠打磨到极致能不能拿到用户。**

取舍原则：
1. **可靠性 > 功能数量**：永远不丢数据，是第一卖点。
2. **信任 > 增长手段**：不加分析、不加追踪、不注入网页、权限最少。
3. **只做 Chrome 扩展**【已决】：Firefox / Edge / Safari / 手机端都不在前期范围。但平台相关代码（剪贴板、存储、定时器、标签页）必须隔离在 `platform/` 适配层，`core/` 保持纯逻辑，不碰 `chrome.*` 和 DOM。
4. **只做 2FA**：不做密码管理。

---

## 1. 范围

### Phase 0 必须有
- TOTP：RFC 6238，SHA1/256/512，6/8 位，自定义周期。
- 添加账户：手动输入；粘贴 `otpauth://`（可多条）；上传二维码图片；截取当前标签页识别；导入 Google Authenticator 的 `otpauth-migration://`（含多批次）。
- 弹窗：搜索、一键复制、倒计时圆环、按当前网站优先排序、分组、重命名、拖动排序、深色模式、全键盘。
- 时间偏差检测（见 4.3）。
- 防丢数据存储（第 4 节）。
- 主密码（可选）+ 恢复码。
- 导出（加密备份 + 明文列表）与导入。

### Phase 1：端到端加密云同步（第 6、7 节）

### 不做（但预留）
- YubiKey / WebAuthn PRF：Phase 3，作为**附加**解锁方式。
- HOTP 正式支持：Phase 0 导入时**保留并标注"暂不支持生成"**，不静默丢弃（违背"永不丢数据"）；Phase 1 正式支持。【默认】
- 付费、订阅、Steam Guard、其他浏览器、手机 App。

---

## 2. 仓库结构

```
sixkey/
├── extension/
│   ├── manifest.base.json / manifest.dev.json      # 叠加；生产包不得含开发域名
│   ├── src/
│   │   ├── core/                  # 纯逻辑；Clock/Random/KV/Crypto 全部注入
│   │   │   ├── totp/              # base32, hotp, totp, otpauth-uri, ga-migration
│   │   │   ├── crypto/            # envelope, kdf, keyring, recovery-code, hkdf
│   │   │   ├── vault/             # model, hlc, merge, fractional-index, migrations
│   │   │   ├── storage/           # kv 接口, slots, snapshots, mirror, recovery-ladder
│   │   │   └── sync/              # engine 状态机, backoff   （Phase 1）
│   │   ├── platform/              # chrome-kv, idb-kv, session-cache, alarms, clipboard, tabs, locks
│   │   ├── background/sw.ts       # 仅事件接线
│   │   ├── offscreen/             # 剪贴板清空
│   │   ├── popup/                 # Preact
│   │   ├── options/               # 全页：导入导出、恢复码、设置、权限申请、文件上传
│   │   └── workers/qr-decode.worker.ts
│   ├── _locales/{en,zh_CN}/messages.json
│   └── test/{unit,fault,e2e}
├── api/                           # FastAPI（Phase 1）
├── supabase/migrations/
├── docs/{SECURITY.md,PRIVACY.md}
└── PLAN.md
```

---

## 3. 数据模型

```ts
type Entry = {
  id: string;                         // uuid v4
  type: "totp" | "hotp";              // 【新增】hotp 仅保留，不生成
  issuer: string;
  label: string;
  secret: string;                     // Base32
  algorithm: "SHA1" | "SHA256" | "SHA512";
  digits: 6 | 8;
  period: number;                     // totp，默认 30
  counter?: number;                   // hotp，合并取 max
  group?: string;
  order: string;                      // 【变更】分数索引（fractional index），避免拖动排序引起整表冲突
  domains?: string[];
  createdAt: number;
  hlc: string;                        // 【变更】混合逻辑时钟（墙钟ms + 计数器 + 设备ID），取代 updatedAt 做合并
  deleted?: boolean;                  // 墓碑，【已决】永久保留（每条约 60B）
};

type Vault = {
  schemaVersion: 1;
  vaultId: string;
  entries: Entry[];
};
```

HLC 规则：本地取 `max(本地时钟, 已见最大 HLC)`；拒绝超过"当前时间 + 1 天"的远端时间。
删除与并发编辑冲突时**编辑胜出**；UI 上删除先进回收站。

### 加密封套（本地与云端同一格式）

```ts
type EncryptedVault = {
  format: "sixkey-vault";
  formatVersion: 1;
  cipher: "AES-256-GCM";
  vaultId: string;                    // 【新增】保险库标识
  vkId: string;                       // 【新增】VK 标识（由 VK 经 HKDF 派生的 64 位指纹），轮换时变化
  rev: number;                        // 【新增】单调递增的修订号，写入 AAD；云端阶段与服务器 version 对应
  iv: string;                         // 96 位随机
  ciphertext: string;
  checksum: string;                   // 【变更】SHA-256(header ‖ iv ‖ ciphertext)，不再对明文哈希
};
```

- AAD 为字符串 `sixkey-vault|1|{vaultId}|{vkId}|{rev}`；checksum = SHA-256(AAD ‖ iv ‖ ciphertext)（已实现并与 node:crypto 对照验证）。包裹密钥的 AAD 为 `sixkey-wrap|1|{method}|{vkId}|{vaultId}|{kdf 参数}`，KDF 参数被篡改会直接解不开；读取存储的 PBKDF2 参数时拒绝迭代数 <600k 或 >2000 万。
- 如需明文层校验，把 `contentHash` 放进**加密载荷内部**。
- 【变更】原因：明文哈希与密文并存会泄露内容指纹，并允许离线验证明文猜测；且与 GCM 认证标签冗余。密文哈希在锁定状态下也能做存储自检。

---

## 4. 防丢数据的本地存储（最高优先级）

### 4.1 关键事实（调研结论）
- `storage.local` 单次多键 `set` 在 Chromium 实现中是一个 LevelDB WriteBatch，**跨键原子**（实现细节，文档未承诺 → 测试里两种情况都要覆盖）。
- 写入 `sync=false`：进程崩溃不丢，**断电/系统崩溃可能丢最近的写入**；"写后读回"只能抓序列化错误，防不了断电丢失。
- Chrome 对 LevelDB 损坏会删坏值、`RepairDB`（可能丢任意多表），失败则**删除整个库**。
- 因此：**A/B 槽位 + 快照都在同一个 LevelDB，整库丢失时一起丢**。必须有库外冗余。
- 用户"清除浏览数据"不会清除扩展 `storage.local` 与扩展 origin 的 IndexedDB；卸载扩展会清除。

### 4.2 四层防护【变更】
1. `storage.local`：A/B 槽 + 指针（`vault_slot_a/b`、`vault_active`）；写入流程：写非当前槽 → 读回校验密文 checksum → 同一次 `set` 切换指针。
2. **IndexedDB 独立镜像**【新增】：最新一份 + 每日快照。（底层同为 LevelDB 类实现，非完全独立，但可挡住"单个库被删/被修"。）
3. **导出提醒**【新增】：有修改但 7 天内未导出加密备份 → 提醒。Phase 0 本地版尤其重要。
4. 云端（Phase 1）。

所有写入方（popup / SW / options）用 `navigator.locks.request('vault-write')` 串行化。
保留 `unlimitedStorage`（无警告，且让 IndexedDB 免驱逐）。

### 4.3 快照与时间
- 滚动快照：最近 10 次修改 + 最近 7 天每日一份；**只复制密文封套**，无需 VK，锁定状态下也能做。
- 【变更】不依赖 alarm 准时：`ensureDailySnapshot()` 在 SW 每次启动、popup 每次打开、alarm 触发时都执行，按本地日期键补做；每次 SW 启动检查 alarm 是否存在，不存在就重建。
- 时间偏差【已决 Q1】：Phase 0 **完全零网络、无 host_permissions**，不做自动检测；设置页提供说明和系统时间显示，提示用户开启系统自动校时。Phase 1 再用 `/v1/time` 或 API 响应的 `Date` 头做自动检测（偏差 >15 秒提示并校正）。

### 4.4 启动自检与自动恢复
当前槽 → 另一槽 → 本地快照 → IndexedDB 镜像 → 云端（已登录）。任何一次自动恢复都写入"需告知用户"事件，界面明确说明恢复到的时间点。

### 4.5 必须有的测试（故障矩阵）
自写 `FaultyKV` 包装层，支持：第 N 次写抛异常；多键写入**非原子**；随机删除某键（模拟 FixCorruption）；整库清空（模拟 RepairDB/删库）；翻转字节；任意 await 点"崩溃"（步数预算 + 重启后跑恢复）。
fast-check 不变量：永远至少一个可用副本；恢复后状态 = 旧已提交态或新已提交态；每次恢复都产生告知事件。

### 4.6 Schema 迁移
扩展自动更新可能推送坏迁移：迁移前自动快照；迁移可回滚；格式向后兼容。

---

## 5. 加密设计

全部 WebCrypto，不引入第三方加密库。

### 5.1 密钥层级
- **VK**：随机 256 位。`VK_raw = getRandomValues(32)`，用 HKDF 派生 `K_enc`（AES-GCM，non-extractable）运行时使用。
- **包裹方式统一为 AES-GCM(KEK, 96位随机IV, VK_raw, AAD=规范化头部{fmt, kind, vkId, kdf})**。不用 AES-KW（确定性、无 AAD、无法绑定上下文）。
- KEK 来源：
  - **主密码**：Unicode **NFKC 规范化**后 PBKDF2-SHA256，**≥600,000 次**（可按设备校准到约 1M），16B salt；参数写入封套 `kdf:{alg, iter, salt, v}` 以便将来迁移。实测 M3 Max 约 40ms；低端机推测 0.4–1s。【已决：不为 Argon2 引入 wasm，等 Chrome 原生支持】
  - **恢复码**：**28 位 Crockford base32，分 7 组 4 位 = 128 bit 随机数 + 12 bit 校验**（SHA-256 前 12 bit）；输入不分大小写，O→0，I/L→1。熵足够，用 HKDF-SHA256 派生 KEK，无需慢 KDF。【变更】v1 的 24 位格式只有 120 bit。
  - **设备包裹**：随机 256 bit，与封套在**同一次原子写入**中落盘。
  - **（Phase 3）WebAuthn PRF**：仅作附加包裹。
- 主密码强度门槛：估算熵 ≥50 bit，或 ≥4 个随机词口令。依据：服务器泄露后单张 RTX 4090 约 1.5 万次/秒（600k 次迭代）。

### 5.2 设备包裹的诚实表述
设备密钥与密文同处存储，安全性等同混淆。UI 文案：
> 未设置主密码：数据在本机仅做基础加密，可防止被随手查看，**无法阻止能访问这台电脑或浏览器配置文件的人或恶意软件读取**。

### 5.3 启用主密码时【新增，严重】
必须**原子地删除所有 device 包裹**，包括各槽位、本地快照、IndexedDB 镜像中的；并**轮换 VK**（重加密整库）。否则本地攻击者仍可用残留设备包裹解密。测试：启用后扫描全部存储，断言无 device 包裹残留。

### 5.4 改密码 / 轮换 VK
- 改主密码只重新包裹 VK；但知道旧密码者配合旧备份仍可解密 → 提供"轮换 VK"。
- keyring 保留历史 VK（由当前 VK 包裹），否则轮换后旧版本无法恢复。
- 云端 `wrapped_keys` 有**独立版本号与乐观锁**；两台设备同时改密码，后提交者收 409，提示"密码已在其他设备修改"。
- 云端拒绝用旧 `vk_id` 加密的写入。

### 5.5 零知识
服务器只存密文、包裹后的密钥、KDF 参数、版本、时间戳。**开启云同步必须设主密码**。UI 明确告知：忘记主密码且丢失恢复码，数据无法找回。客户端记录见过的最大版本号以发现服务器回滚。

### 5.6 运行时会话
- 解锁后的 VK 原始字节放 `chrome.storage.session`（仅内存；CryptoKey 无法存入，只能存字节 base64）。
- 扩展更新、重载、浏览器重启后需重新解锁——UI 中说明。
- 自动锁定：每次 / 闲置 N 分钟（以"最后使用 Sixkey"计）/ 浏览器会话结束 / **锁屏即锁**（`idle` 权限）。

---

## 6. 云同步（Phase 1）

- 模型：整库密文 + 乐观锁（`if_version`）+ 客户端按条目 `id` 合并（HLC 较新者胜，编辑胜过删除，墓碑永久保留）。
- **锁定状态下无 VK，无法合并**【新增】：只做快进式推/拉；冲突则等解锁后处理。
- 触发：本地修改后 3 秒；打开弹窗；每 30 分钟 alarm。
- 【变更】SW 中的 3 秒防抖实现：先持久化 `sync.pending` 与 `dirtySince` → `setTimeout(3s)` → 同时建 `alarms` 30 秒兜底 → SW 每次启动检查 `pending` 并补做 → 退避 <30s 用 setTimeout，≥30s 用 alarm。客户端合并必须幂等。
- 服务端版本历史：最近 30 版 + 最近 30 天每日一版。客户端可列出/恢复，版本记录带 `vk_id`。

---

## 7. 后端（Phase 1）

### 7.1 认证【已决】
邮箱 6 位 OTP（Magic Link 模板加 `{{ .Token }}`，`verifyOtp type:'email'`），**由 FastAPI 代理**：`/v1/auth/otp`、`/v1/auth/verify`、`/v1/auth/refresh`。
- 扩展 host 权限仍只有 `api.sixkey.app`。
- 必须开启 Supabase IP Address Forwarding，带 `Sb-Forwarded-For`，使用 secret key，否则所有用户共享服务器 IP 的限流额度。
- **上线前必须接自定义 SMTP**（内置邮件每小时 2 封）。
- 不使用 supabase-js（58KB gz）。
- Token：refresh token 单次使用且复用会吊销整个会话 → **只由 SW 一处刷新**（`navigator.locks`）；access token 放 storage.session，refresh token 放 storage.local；access token 有效期建议 15 分钟。【默认】
- JWT 校验：JWKS（ES256），PyJWT，`algorithms` 白名单，校验 `aud=authenticated`、`iss`、`exp`、`sub`，拒绝 `is_anonymous`。使用 `sb_publishable_` / `sb_secret_` 新密钥体系。

### 7.2 数据库
表放在**不对外暴露的 schema**（如 `sixkey`），同时开 RLS 并撤销 anon/authenticated 授权；FastAPI 用最小权限角色，每条查询带 JWT `sub`，写跨租户隔离测试。asyncpg 若走 transaction pooler 需 `statement_cache_size=0`。

```sql
create table sixkey.vaults (
  user_id uuid primary key references auth.users(id) on delete cascade,
  version bigint not null default 1,
  vk_id text not null,
  ciphertext text not null,
  wrapped_keys jsonb not null,
  keys_version bigint not null default 1,      -- 【新增】wrapped_keys 独立乐观锁
  size_bytes int not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table sixkey.vault_versions (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  version bigint not null,
  vk_id text not null,
  ciphertext text not null,
  wrapped_keys jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, version)
);
```

PUT CAS（READ COMMITTED 下行锁 + WHERE 重新求值即可保证正确）：

```sql
WITH upd AS (
  UPDATE sixkey.vaults SET version = version + 1, ciphertext = $2, vk_id = $3, updated_at = now()
  WHERE user_id = $1 AND version = $4 AND vk_id = $3
  RETURNING user_id, version, ciphertext, vk_id, wrapped_keys, updated_at)
INSERT INTO sixkey.vault_versions (user_id, version, vk_id, ciphertext, wrapped_keys, created_at)
SELECT user_id, version, vk_id, ciphertext, wrapped_keys, updated_at FROM upd RETURNING version;
-- 0 行 → 409 并返回当前 version / vk_id；首次写入 INSERT … ON CONFLICT DO NOTHING
```

版本保留（30 版 + 30 天每日一版，UTC 日期）在写入事务之后或 pg_cron 中清理（SQL 思路见调研报告 §9）。

### 7.3 API
同 v1：`GET /v1/time`、`GET/PUT /v1/vault`、`GET /v1/vault/versions[/{v}]`、`DELETE /v1/account`、`/healthz`，另加 `/v1/auth/*` 和 wrapped_keys 的独立更新端点。
要求：1 MB 上限；PUT 每用户每分钟 ≤30；`/v1/time` 与 `/v1/auth/*` 按 IP 限流（仅信任已知代理的 XFF）；日志不得含请求体/密文/token；CORS 仅 `chrome-extension://<id>` 与 `https://sixkey.app`。
**隐私政策必须披露**：已删除条目的密文仍会在服务端版本历史中保留至多 30 天；提供"彻底删除账户及全部历史"。
可选加固（Phase 1 后期）：服务端对 `wrapped_keys` 再做 KMS 应用层加密，防数据库转储/备份泄露。【默认】

---

## 8. 扩展安全约束与权限【变更】

最终形态（权限随任务逐步声明，只声明已有代码用到的）：

```json
"permissions": ["storage", "unlimitedStorage", "activeTab", "alarms", "offscreen", "idle"],
"optional_permissions": ["clipboardRead", "clipboardWrite"]
```

- **Phase 0 无 `host_permissions`**；Phase 1 才加 `https://api.sixkey.app/*`（开发构建另加开发域名，生产包必须去掉）。
- 声明节奏：task 1 起 storage / unlimitedStorage / activeTab / alarms；task 7 加 idle；task 11 加 offscreen 与可选剪贴板权限。

- `offscreen`、`idle` 无安装警告；`clipboardRead/Write` 有警告，故为可选【已决】，在 **options 全页**中用户开启"自动清空"时申请（popup 内弹授权框可能导致失焦关闭）。
- 无 content scripts；无远程代码；无分析/追踪；MV3 默认 CSP，不加 `wasm-unsafe-eval`（只用纯 JS 解码库）；关闭 Vite 的 modulePreload polyfill（避免 inline 脚本）；SW 产物不含动态 `import()`。
- 错误信息与日志不得含密钥或验证码。
- 无埋点 → 数据丢失事件无法被统计：提供**本地诊断日志**（仅事件，无密钥），用户可手动导出反馈。【默认】

### 剪贴板自动清空设计
1. popup 的点击/按键处理函数里 `navigator.clipboard.writeText`（无需权限）。
2. 将 `SHA-256(code)` 与到期时间发给 SW → 确保 offscreen 文档存在（reason `CLIPBOARD`）。
3. offscreen 内 `setTimeout(30s)`（offscreen 无生命周期上限，比 SW 可靠）→ `execCommand('paste')` 读取并比对哈希 → 相同才写空串 → `window.close()`。
4. 用户未授权可选权限时，功能关闭，优雅降级。
5. UI 说明：操作系统剪贴板历史（如 Windows Win+V）可能仍保留验证码。

---

## 9. 弹窗体验

- 目标：已解锁状态下，**从 popup 导航开始到验证码渲染完成 <100ms**（`performance.mark` 实测）；锁定态的 KDF 耗时不计入。
- 关键路径：并行读 `storage.session` 的 VK 与 `storage.local` 当前槽 → importKey → AES-GCM 解密（实测 60KB×100 次共 5ms）→ HMAC → 渲染；**不走 SW 往返**。
- 当前网站匹配：`tabs.query({active:true,currentWindow:true})` 取 URL（activeTab 授权，不要 `tabs` 权限）；用条目 `domains` 做后缀匹配（`host===d || host.endsWith('.'+d)`）+ issuer 模糊匹配，不引入公共后缀列表。需 e2e 验证。
- 单一匹配项按 Enter 复制；输入即搜索；上下键/Enter/`/`；剩余 ≤5 秒变色；复制时剩余 <3 秒自动复制下一周期并提示。
- 文件上传、拖拽、批量导入、权限申请放 **options 全页**；popup 支持 Ctrl+V 粘贴截图。
- i18n：`_locales` + `default_locale`（chrome.i18n 跟随浏览器语言，不支持运行时切换；若要应用内切换需自写 loader）。先中英。
- 体积：popup 主包目标 <200KB（Preact+hooks 实测 5.7KB gz）；QR 库懒加载进 Worker。CI 加体积门槛。

### 二维码识别
- 路径：`BarcodeDetector`（仅 macOS/ChromeOS 可用）快速路径 → 回退 **paulmillr/qr**（17KB gz）；放 Worker，懒加载（扩展 SW 不支持 `import()`）。
- 不用 jsQR（2021 年起无发版，实测大噪声图 17 秒）。
- 截屏：`captureVisibleTab`（activeTab，限速 2 次/秒，仅可见区域）；先缩放再解码；**截图/图片只存内存，不落盘**。
- Phase 0 建 **≥30 张真实截图语料库**再最终定库（识别率 ≥95%，<300ms）。

### 导入/导出
- Google 迁移：标准 base64（含 `+ / =`，URLSearchParams 会把 `+` 变空格，需还原；容忍 `-_`）；按 proto3 补默认值（algorithm 0→SHA1，digits 0→6，type 0→TOTP）；MD5 拒绝；批次收齐 N 张后去重（secret+issuer+name）；周期固定 30；字段表见调研报告 §6。
- 加密备份格式：`{format:"sixkey-backup", v:1, kdf, wrap, iv, ct, created, app_ver}`。未设主密码的用户导出时必须单独设导出密码或使用恢复码，**不能用设备密钥**。
- 明文导出（otpauth 列表/二维码）：提供，带强警告，避免用户被锁在 Sixkey 里。【默认】

---

## 10. 测试要求

- **TOTP**：RFC 6238 附录 B 全部向量。注意勘误 2866：SHA1/256/512 的密钥分别为 20/32/64 字节（`12345678901234567890` 重复延长），不是统一 20 字节。向量表见调研报告 §7。另测 RFC 4226 HOTP 向量。HMAC 坑：计数器 8 字节大端（`setBigUint64`）；偏移取 MAC **最后一个字节** `&0x0f`；空密钥抛异常，导入前校验。
- **otpauth 解析**：≥50 条边界用例（大小写、`+`/`%20`、中文、缺 issuer、issuer 冲突、小写/空格/`=` 填充/非法字符的 secret、80 bit 短密钥、algorithm/digits/period 异常、hotp 缺 counter、多条粘贴、去重），fast-check 往返。
- **GA 迁移**：dim13 + Aegis 真实样本；多批次；HOTP 保留；截断/恶意输入 fuzz 不崩溃。
- **加密**：往返；错误密码失败；任意字节篡改失败；已知答案测试；改密码只改包裹；启用主密码后无 device 包裹残留。
- **存储**：4.5 的故障矩阵。
- **合并**：属性测试——交换律、结合律、幂等；并发修改、删除与修改冲突、HLC 偏移。
- **E2E**：Playwright（自带 Chromium / Chrome for Testing——品牌版 Chrome 137+ 不再接受 `--load-extension`），`launchPersistentContext`；同 userDataDir 重启验证已锁定与快照补做；剪贴板 30 秒清空 / 用户复制了别的则不清 / 拒绝权限降级。tab 方式打开 popup 不授予 activeTab，需测试专用 manifest 或 `openPopup()`。
- **API**：pytest + httpx，真实 Postgres；并发相同 `if_version` 恰好一个 200 一个 409；保留策略；JWT（过期、aud/iss 错误、HS256 公钥混淆攻击）；限流假时钟；跨租户隔离。
- 工具链：vitest、fast-check、fake-indexeddb、@webext-core/fake-browser 或自写薄 mock（sinon-chrome 等已停滞）。

---

## 11. 开发阶段

### Phase 0：本地版（先交付）

| # | 任务 | 验收点 |
|---|---|---|
| 1 | 骨架：Vite 8 多入口、manifest、CSP、CI 体积预算 | 扩展可加载；无 inline 脚本；Playwright 冒烟能拿到 SW；popup 主包有体积门槛 |
| 2 | core/totp：base32、HOTP、TOTP、URI | RFC 全部向量过；URI 用例 ≥50；往返测试 |
| 3 | core/import：GA 迁移、多行粘贴 | 真实样本；多批次；HOTP 保留；fuzz |
| 4 | core/crypto：封套 v1、KDF 版本化、keyring、28 位恢复码、AAD | 已知答案；篡改失败；改密码只改包裹；性能基准 |
| 5 | core/vault：模型、HLC、墓碑、分数排序、合并 | 属性测试通过；Phase 1 要用的字段现在就定好 |
| 6 | core/storage：A/B 槽、密文 checksum、快照、IDB 镜像、恢复链、迁移框架 | 故障矩阵全过；每次恢复产生告知事件 |
| 7 | 平台层与 SW：快照补做、session VK、locks、自动锁 | e2e：写入中杀 SW 可恢复；重启后锁定；日期跳变补快照 |
| 8 | 主密码、恢复码、锁定/解锁流程（含 5.3 清除 device 包裹 + VK 轮换） | 启用后扫描存储无残留；恢复码能找回数据 |
| 9 | popup UI | 参考机 <100ms；全键盘 e2e |
| 10 | 添加流程：手动、粘贴、上传、截屏、GA 导入 | 语料库 ≥30 张，识别率 ≥95%；<300ms；图片不落盘 |
| 11 | 剪贴板自动清空 | 见 §10 E2E |
| 12 | 加密备份导出/导入、明文导出、导出提醒 | 全新 profile 能从文件恢复；错误密码/损坏文件有明确提示 |
| 13 | 上架准备素材：隐私政策、权限理由、生产 manifest | 通过 CWS 上传检查；生产包无开发域名 |

**验收**：开发者本人替代现有验证器连续使用一周无数据丢失；故障矩阵全过。**通过前不开始 Phase 1。**

### Phase 1：云同步
FastAPI + Supabase、邮箱 OTP（代理）、E2EE 同步、版本历史、HOTP 正式支持。
验收：两台电脑同时修改合并正确；卸载重装后能从云端完整恢复；并发 PUT 恰好一个 200 一个 409。

### Phase 2：上架与官网
官网（首页、安全、隐私、FAQ、2FA 教程页）；开源 + 可复现构建（公布 SHA-256）；以 VIEW TECH LTD 身份上架 Chrome Web Store，声明 trader。
上架注意：名称/描述不得含"Google Authenticator"（可写"支持从 Google Authenticator 导入"）；避免关键词堆砌；准备每项权限的理由文案；分阶段发布。

### Phase 3：YubiKey / WebAuthn PRF
RP ID `sixkey.app`（Chrome 122+，扩展可声明 host 权限对应的域名；已核实）。**仅作附加包裹**，不能是唯一解锁方式。开发前先在 YubiKey 5 系列上做原型验证。

---

## 12. 实验指标
扩展内不加任何埋点。指标来源：Chrome 商店后台；服务端仅汇总计数（已开同步用户数、每日同步用户数）；官网用无 cookie 统计（Plausible）。观察：自然安装增速、WAU/总安装（留存）、云同步开启比例、评分与差评内容。

---

## 13. 工作约定

1. 按 Phase 顺序开发，Phase 0 验收前不开始 Phase 1。
2. 先写 `core/` 纯逻辑 + 测试，再写界面。
3. 加密、存储、同步代码，每次修改必带测试。
4. 不确定的安全设计决定，停下来问。
5. 不引入大体积 UI 框架；popup 主包 <200KB（CI 门槛）。
6. 所有用户可见文字走 i18n。
7. 每完成一个 Phase，更新 `docs/security/local-vault.md`（威胁模型、加密细节、已知限制）。
8. 版本号固定：Preact 先用 10.29.x，11 稳定后再升级；不使用 CRXJS（3.0 刚发布）；若日后需要 Firefox 再评估 WXT。

---

## 14. 开放问题（Q1–Q10 已于 2026-10-15 全部按推荐值【已决】）

| # | 问题 | 推荐 |
|---|---|---|
| Q1 | Phase 0 是否需要 `api.sixkey.app` host 权限（仅用于时间偏差检测）？还是 Phase 0 完全零网络、时间检测推迟到 Phase 1？ | 零网络，手动提示用户系统时间；Phase 1 再接 `/v1/time` |
| Q2 | 没设主密码时是否强制生成恢复码？ | 强烈引导、可跳过但持续提醒；开启同步时强制 |
| Q3 | 扩展更新/浏览器重启后需重新解锁，是否接受？ | 接受，UI 解释原因 |
| Q4 | 是否提供明文导出？ | 提供，带强警告 |
| Q5 | HOTP：Phase 0 导入保留并标注"暂不支持"？ | 是 |
| Q6 | QR 库最终选型 | 以语料库实测为准，默认 paulmillr/qr + BarcodeDetector |
| Q7 | 服务端对 wrapped_keys 加 KMS 层 | Phase 1 后期做 |
| Q8 | CWS 声明 trader 与否 | 计划收费则声明 trader |
| Q9 | 无埋点，改本地诊断日志、用户手动导出 | 接受 |
| Q10 | access token 缩短到 15 分钟 | 缩短 |

调研原始数据与脚本：`scratchpad/m/`（PBKDF2 基准、RFC 向量、GA 迁移原型、QR 基准、体积对比）。

---

## 15. 实施状态（Phase 0：2026-10-15；Phase 0.x：2026-10-16）

**总览**
- **Phase 0**：任务 1–12 的代码与测试已完成；任务 13 部分完成（隐私政策、权限理由、生产 manifest、SECURITY.md 已写，商店上传检查无法在本地验证）。
- **Phase 0.x**（`docs/history/PHASE0X-PLAN.md`）：R0、H1–H8、U1（含 U1b）的全部工作包已合入主树，外加计划外的 A4（G-M2 闸门修复）。D 包更新了 `docs/security/local-vault.md`、`docs/PRIVACY.md`、`docs/guides/FINGERPRINT-BROWSERS.md` 与本节，并新建 `docs/history/M2-HANDOFF.md`、`docs/OWNER-CHECKLIST.md`。
- **最后一次 `npm run verify`**（2026-10-16，主树 `extension/`）：
  - 类型检查通过；
  - vitest 1090 条通过，1 条跳过；
  - build 与 check-dist 通过，弹窗 57.4 KB gz（门槛 60 KB）；
  - Chromium 端到端 97 条通过。
- **仍在等待**：开发者本人一周实用验收（§11 Phase 0 的验收条件），以及 `docs/OWNER-CHECKLIST.md` 里的人工检查。

**Phase 0 之外建成的部分**（逐包；详见 PHASE0X-PLAN 各节与其附录 E"实际建成"）

| 包 | 内容 |
|---|---|
| R0 | 拆分弹窗与设置页的大文件；文案改为"基础 + 每包一个分片"（`scripts/i18n/`）；`Settings.display` 与两个安全预设（`core/service/presets.ts`）；每个页面只加载当前语言的文案目录（O5） |
| A1（H1 + H5） | 添加任何账户之前必须先有主密码和已确认的恢复码：新建、从备份恢复、重新开始都先 `prepareKeys`，最后一次加锁写入，永不写设备包裹；首次运行向导在设置页标签页里，含 H5 那一问 |
| A2（U1b） | 打开弹窗只走一次 `openView`；解锁不扫快照，改用换密钥标记 `sk_keychange` 与 `sk_store_v`；读取次数硬门槛 `test/unit/read-budget.test.ts`；`scripts/bench/` |
| A3（H3 + H6 服务层） | `verifyPassword`、`recordExport`、独立的本地安全记录 `sk_security_log`（`core/service/security-log.ts`） |
| A4（计划外） | G-M2 评审要求的修复：提交之后不再报失败、新恢复码只经 `onCode` 交出（GM2-1）；同一 VK 的 keyring 变化也写标记（GM2-3，关闭 P-5）；唯一的清理入口 `finishKeyChanges`（GM2-4）；`StoreOptions.lock` 必填（GM2-11）；FIXa2 拒绝的槽被覆盖（GM2-2(a)）；忘记密码的重设改在设置页标签页里两步完成（A4R-1） |
| B1（U1） | 列表首屏优先、密度、隐藏验证码、排序、行的可访问性；倒计时圆环每秒重绘一次（见偏差） |
| B2（U1） | "此网站"只给已登记域名，名称猜测降为"可能相关"；记住此网站、编辑域名；快捷键 `_execute_action`（Alt+Shift+K） |
| B3（U1） | 弹窗内粘贴文本或截图、扫描本页，直接进入懒加载的确认页；按解码后的密钥字节去重；"替换"把旧条目移进回收站 |
| C1（H8） | `docs/guides/FINGERPRINT-BROWSERS.md`；设置页的应用内指南面板（`GUIDE_URL` 为空，不显示链接） |
| C2（H7） | 本地导入裸密钥与 `名称\|密钥` 行，其他列丢弃、从不显示 |
| C3（H4） | 安装来源自检横幅（`chrome.management.getSelf()`），商店 ID 常量在 `scripts/store-id.mjs`（现在为空） |
| C4（U1） | 主题手动切换（`public/theme-boot.js` 首帧前设好）、`color-scheme` meta、对比度硬门槛、去掉两个字重、外观面板 |
| C5（U1） | 设置 › 安全 › 安全模式：两个预设卡与"自定义" |
| C6（H2 + H3） | 每次导出都重输主密码；"导出所选账户"子集备份（`core/backup/subset.ts`） |
| C7（H6 界面） | 设置页安全记录卡与"本机存了什么"清单；弹窗解锁后提示"N 次错误"，显示之后按所示数字确认 |
| C8（U1） | 错误文案改为"发生了什么 + 下一步"，界面不再显示内部错误名 |

**测试与体积**
- 单元、故障注入与回归测试（vitest）1090 条通过、1 条跳过；端到端（Playwright，Chromium）97 条通过。
- 读取次数是硬门槛：
  - 单元（`read-budget.test.ts`）：打开弹窗不超过 4 次、1.5 倍当前槽；解锁不超过 8 次、3 倍；快照数为 2 与 17 时结果相同；
  - 真实浏览器（`perf.spec.ts`）：打开到首个验证码 4 次、总共 6 次；解锁到首个验证码 8 次、总共 10 次（原为 9 次，多出的 1 次是 C7 的安全记录读取，是写明的例外）。
  - 计时一律只告警（`perf.spec.ts`、`perf-idle.spec.ts`）。
- 弹窗 57.4 KB gz：静态部分（入口脚本、共享块、两个 CSS 与 `theme-boot.js`）47.3 KB，加较大的中文目录 10.1 KB（check-dist 的口径，1 KB = 1024 B）。PHASE0X-PLAN 附录 C 的估计是 49.9 KB。门槛 60 KB gz 是团队自己的 CI 门槛。§9、§13 的产品目标"popup 主包 <200KB"没有写明是压缩前还是 gz：同一组文件压缩前约 174 KB（静态 146.4 KB + 较大的英文目录 27.8 KB），见下面"需要产品负责人决定"。

**与本计划书的偏差**（Phase 0 的各项均已在 `docs/security/local-vault.md` 说明）
- 信封增加 `vaultId` / `rev`，校验和改为对密文封套计算（§3.2）。
- 恢复码改为 28 位 Crockford base32，128 位随机数 + 12 位校验（§5.1）。
- 启用主密码会更换 VK、清除设备包裹、重加密所有快照；旧 VK 只保存在新 keyring 内（§5.3）。Phase 0.x 起新库一律先设主密码，这条只剩旧设备密钥库的升级路径在用。
- 条目时间戳改为 HLC，三个独立寄存器（内容 / 位置 / 删除），墓碑永久保留；"编辑胜出"的精确语义见 `core/vault/merge.ts` 头注释。
- Phase 0 完全零网络、无 host_permissions；时间偏差只做设置页提示，自动检测推迟到 Phase 1。
- 权限：`storage, unlimitedStorage, activeTab, alarms, idle, offscreen` + 可选 `clipboardRead/Write`。Phase 0.x 没有新增权限；`commands` 不是权限。
- 新增本地诊断日志（用户手动导出）、回收站（30 天后可一键清除旧条目）、备份提醒（7 天）。
- 弹窗阴影：Chrome 的弹窗外框由浏览器绘制，页面内的阴影会被裁掉，因此"更重的阴影"只用在弹窗内的浮层（提示条、对话框）上。
- **Q2 的已决值被 H1 取代**：不再是"可跳过但持续提醒"，新库必须先设主密码并确认恢复码。
- **§5.4 改密码 / 轮换**：改密码、新恢复码、用恢复码重设之后，也按"keyring 变化"写清理标记并清理其他副本（GM2-3）。新恢复码需要主密码（C6-1）。忘记密码的重设只在设置页标签页里进行，先显示新恢复码、确认已保存之后才写入。
- **§9 弹窗**：添加流程的"粘贴、截屏扫描"移到弹窗内的确认页；扫描结果不再经过 `chrome.storage.session` 转交设置页。
- **Phase 0.x 相对 PHASE0X-PLAN 的偏差**写在该文件的附录 E"实际建成"，要点：
  - 计划外的 A4 包；
  - H4 自检只在生产构建里开启（e2e 构建关闭，e2e 用生产 `dist/` 断言横幅）；
  - B1 的圆环没有用 CSS 动画，改为每秒重绘一次；
  - 安全记录比计划多三种类型（`recovery_used`、`password_enabled`、`log_cleared`）；
  - §4.1 要求逐字节不变的 `test/fault/store.test.ts` 与 `test/regression/enable-crash.test.ts` 有机械性改动（`lock: createMutex()`，以及 `enable-crash` 里必填的 `onCode` 参数），断言未变。

**独立评审与结论**（一行一个；详情见各文件）
- **Phase 0 评审**（Opus，2026-10-15）：10 项主要问题与 9 项低优先级问题，逐条复现（20 条失败测试）后修复，评审写的测试已改为常驻回归测试（`extension/test/regression/`）。
  - 已修复：写入与读取校验不一致导致整批导入被静默回滚；开启主密码在提交后抛错导致恢复码丢失；快照/恢复按墙钟排序在时钟回拨后选错；时钟超前时删除无效、clamp 翻转存活状态；回收站按墙钟自动清空；"每次关闭弹窗都锁定"模式下设置页永不锁定；零网络没有被强制（现在由 CSP `connect-src 'none'` 强制，并有回归测试）；永久删除后快照里仍有明文；一次瞬时读取失败会覆盖最新槽位；offscreen 创建竞态；首次运行检查在锁外；诊断/设置键被误判为"数据丢失"；密码下限注释与实现不符；备份导出用的是页面打开时的旧数据。
  - 当时未能在存储层解决的"开启主密码之前添加的账户会在 LevelDB 里残留"：所有者已决定"首次添加账户前必须先设主密码"，由 H1（A1）实现。仍然有效的只剩 Phase 0 遗留的旧库，SECURITY.md 如实写明。
- `docs/audit/internal-reviews/A1-REVIEW.md`（H1 + H5）：**合入前修复**。唯一的 medium F1（写入已落盘却报错，重试时误报"在另一个页面完成"）已修，`makeVault` 认出自己落盘的写入；其余 9 项 low。
- `docs/audit/internal-reviews/A2-REVIEW.md`（U1b）：**合入前修复**。A2-1（镜像一直失败时每次打开都完整扫描）改为"只剩镜像"的标记；A2-3 改为新格式的快照记录不当作损坏、不被清理删除（仍按 10 / 7 的上限正常轮换出局）。原有问题 P-1（High，报失败的换密钥被 selfCheck 提交）由 FIXb + FIXa2 修复；P-2、P-3、P-4、P-6、P-7 已修，P-5 由 A4 的 GM2-3 关闭；P-8、P-9 未修（见推迟项）。评审时"测试会放过"的那些变异是否全部补上了测试，D 包没有逐条核对。
- `docs/audit/internal-reviews/A3-REVIEW.md`（H3 + H6 服务层）：**合入前修复**。A3-1（清空与确认什么都不需要）改为清空必须验证主密码、页面只拿到只读接口；A3-2 改为按所示数字扣减；A3-3 补测试。
- `docs/audit/internal-reviews/GM2-REVIEW.md`（A1 + A2 + FIXa2 + FIXb 合并状态，G-M2 闸门）：**M2 之前修复**。"M2 开始前"的五项中，GM2-1(a)(b)、GM2-3、GM2-11 由 A4 在代码里完成，GM2-4、GM2-5 写进 SYNC-DESIGN §0.0i。
- `docs/audit/internal-reviews/A4-REVIEW.md`（A4）：**合入前修复**。A4R-1（High，弹窗里先显示后提交的重设会把用户锁在外面）改为设置页标签页里的两步重设，新密码输两次；A4R-2 改为 `onCode` 之后立即记安全记录；A4R-3 加了镜像例外；A4R-5 改为 `onCode` 由类型强制、删除一步重设；A4R-8 修了重设的错误状态；A4R-13 的测试已加入 `gm2-fixes.test.ts`；A4R-4、A4R-11、A4R-12 写成 SYNC-DESIGN §0.0i 第 5、12、13 条，留给 M2。
- `docs/audit/internal-reviews/C6-REVIEW.md`（H2 + H3）：**合入前修复**。C6-1（High，"生成新的恢复码"不要密码，H3 可绕过）改为需要主密码；C6-2 改为文件只含页面显示的那些账户；C6-3 补了对抗性模糊测试与 `export-selection.spec.ts`；C6-4、C6-5、C6-6 已修；C6-8 写成 SYNC-DESIGN §0.0j 的决定；C6-9 写进 PRIVACY 与 SECURITY。
- `docs/audit/internal-reviews/M1-REVIEW.md`（Phase 1 的同步加密 M1）：**修复后就绪**（1 high、7 medium），处理记录在 `docs/design/notes/M1-NOTES.md`（修订 7）。
- `docs/audit/internal-reviews/SYNC-DESIGN-REVIEW.md`、`docs/audit/internal-reviews/SYNC-DESIGN-FINAL-REVIEW.md`（Phase 1 设计）：已并入 SYNC-DESIGN 的各次修订（§0.0–§0.0c）。
- `docs/audit/internal-reviews/YUBIKEY-REVIEW.md`（YubiKey 设计，未实现）：**修复后就绪**。
- R0、B1–B3、C1–C5、C7、C8：PHASE0X-PLAN §3.4 把它们列为"便宜检查"的包，`docs/` 下没有它们的评审文件。

**未被自动化测试覆盖 / 需要人工验证**（清单与预期结果见 `docs/OWNER-CHECKLIST.md`）
- 真实工具栏弹窗才有的东西：`activeTab` 授权下按当前网站分级（`tabs.query`）、"扫描本页"（`captureVisibleTab`）、快捷键 Alt+Shift+K。e2e 以标签页方式打开弹窗，拿不到 activeTab。`scripts/bench/` 能通过 CDP 打开真实弹窗，但只用于手工计时，不在 CI 里。
- 真实弹窗里的主题首帧闪烁、隐藏验证码的观感、倒计时圆环每秒跳一格（B1 的偏差，需要所有者认可）。
- 从系统剪贴板粘贴真实截图（e2e 派发的是合成的 paste 事件）；剪贴板权限的授权气泡（e2e 构建预先授予）。
- 设置页的"更换加密密钥"界面没有 e2e；弹窗里编辑、删除、拖动失败时的界面没有测试（也没有提示，见推迟项）。
- 在干净的 Chrome 配置文件里走一遍首次运行；在未打包的生产构建上看安装来源横幅（e2e 已用生产 `dist/` 断言，人工再看一次文字与 ID）。
- 低端机上 PBKDF2 600k 的耗时（本机实测约 60ms）；弹窗首个验证码的计时只告警，需在真实使用中复核。
- Edge、Brave 与指纹浏览器里的实际表现。

**已知推迟项**（代码现状核实于 2026-10-16；"发布前"指 A1/A2 的改动交到用户手里之前）
- **GM2-2(b)，发布前**：FIXa2 回退一次未完成的密钥改动时只写诊断日志（`store.ts:218`），没有面向用户的事件与提示（A4R-7）。
- **GM2-8**：`selfCheck` 会用较旧的槽覆盖比两槽都新的镜像 generation（`store.ts:297`），掉电丢掉本地尾部时会丢最后一次保存。推迟到 M2（服务器副本更好）；不开同步的用户仍受影响。
- **GM2-9**：永久删除在编辑提交之后被打断时没有重试（`service.ts:855-873` 两步之间没有标记），其余副本按正常轮换出局。已写进 SECURITY.md 与 PRIVACY.md。
- **GM2-6 / P-9**：IndexedDB 每次都出错时，新安装建不了库，完全读不出的库也到不了恢复与重新开始的界面（`store.ts:263`、`:303-307`）。
- **P-8 / GM2-15**：keyring 已列有 64 个旧密钥时，"更换密钥"失败（`keyring.ts:125` 最多 64 个 previous，`rekey` 不截断），什么都不写。M2 的 `capPrevious` 要覆盖 Phase 0 的本地路径（SYNC-DESIGN §0.0i 第 10 条）。
- **GM2-14**：`pushEvent` 读事件失败时会覆盖未确认的恢复提示（`store.ts:828-834` 吞掉读取错误）。
- **GM2-16**：`touch()` 在首帧之后多读 2 次 `sk_settings`，在 `perf.spec.ts` 的"总共 6 次"之内。
- **A4R-9**（Info）：`touch()` 可能清掉刚完成的解锁，失败方向安全，不改。
- **A4R-10**（Info）：会谎报写入成功的磁盘上，没有读回的写入（快照重新加密、覆盖丢失数据时的标记）会让标记的承诺失效。
- **A4R-12、A4R-4、A4R-11**：M2 的工作项（SYNC-DESIGN §0.0i 第 13、5、12 条）。
- **A4R-3 的剩余情况**：只有较旧的副本能打开、而镜像读取一直抛错时，"重试"不会结束。
- **弹窗里编辑、删除、拖动排序失败时没有任何提示**（`popup/main/Main.tsx` 的 `onSave`、`onDelete`、`move` 没有 catch；"记住此网站"有）。
- **死代码**：设置页 `AddAccounts.tsx` 里读取 `#add-scanned` 与 `sk_scan_text` 的那段已经没有写入方；`test/e2e/firstrun.spec.ts` 用它检查新安装在设主密码前不能由此添加账户，所以保留。
- 弹窗语言按钮仍显示"中文"（`popup/chrome.tsx`）；设置页语言菜单已改为"简体中文"。

**需要产品负责人决定**
- 主密码强度：目前由设置页用 zxcvbn-ts 估算（≥50 位）并由服务层强制一个下限；是否接受第三方（非加密）依赖。
- HOTP 目前只保存、不生成。
- §9、§13 的"popup 主包 <200KB"是压缩前还是 gz：同一组文件现在压缩前约 174 KB、gz 57.4 KB。CI 门槛 60 KB gz 是否调整，见 `docs/history/PHASE0X-PLAN.md` 附录 E 的预算结论。
- B1 的倒计时圆环每秒跳一格，而不是连续动画（PHASE0X-PLAN B1 原文要 CSS 动画）。
