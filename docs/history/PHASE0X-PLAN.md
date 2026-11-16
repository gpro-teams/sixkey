# Sixkey Phase 0.x 实施计划（PHASE0X-PLAN）

> **History, not current.** An internal working document from 2026-10, kept for the record. It describes how
> the work was planned and split between AI coding agents, and how their patches were exchanged and merged; it is
> not a guide for contributors (see `CONTRIBUTING.md`) and its file and line references are to the tree of its date.
> Local paths were replaced with placeholders. 历史文档，不再更新；描述当时如何在多个 AI 编码代理之间分工与交接补丁，
> 不是贡献指南，文中的文件与行号对应当时的代码树。本地路径已替换为占位符。

> 日期：2026-10-16。性质：**只做计划**，本文件之外没有改动任何文件。
> 依据：`docs/SYNC-DESIGN.md` §9.1 的 H1–H8（以及 §6 的 Z1–Z6、§7 的文档更正）、`docs/research/ux-study.md`（§1、§2.2、§2.3、§2.7–§2.10、§2.12、§3、§4、§7）、`docs/research/mcp-feasibility.md`（H8 的"AI 代理与自动化"一节）、`docs/history/PLAN-zh.md`、`docs/security/local-vault.md`、`docs/PRIVACY.md`，以及 `extension/` 下的真实代码与全部测试。
> 引用一律用 H*n* / U1 / O*n* / Z*n* 编号，不用行号：SYNC-DESIGN 正在被另一个代理同时修改。每个包开工前，实现者先重读一遍对应的 H 项原文，与本文不符时以原文为准，并在交付报告里写明差异。
> 下文路径凡以 `src/`、`test/`、`scripts/` 开头的，都是相对 `extension/` 的路径。

---

## 0. 总则

### 0.1 范围

**要做**
- **H1–H8**，全部按 §9.1 原文。
  - H1 已授权立即开始：添加第一个账户前必须先设主密码；`create`、`restoreBackup`、`startOver` 都先拿到密码，永不写设备包裹。
  - H5 的首次运行提问与 U1 的安全预设合并实现。
- **U1**，按 ux-study §3 的定义：
  - 性能：O1–O3、O5–O6，加 CI 门槛（读取次数与字节数是硬门槛，计时只告警）。
  - 当前网站分级：只有已登记域名才标"此网站"；名称猜测降为"可能相关"；可以编辑域名，一键"记住此网站"；修正中文 issuer。
  - 两个安全预设（标准 / 共享·自动化），接到 H5 那一问上。
  - 显示：标准 / 紧凑两档密度；"隐藏验证码"开关；手动 / 按名称排序。
  - 主题：手动切换；两个页面加 `color-scheme` meta；修正对比度。
  - 添加：弹窗内"粘贴任何东西"，带确认页（去重、"添加并复制验证码"）。
  - 快捷键 `_execute_action`。
  - 错误文案重写，不再显示内部错误名。
  - 首次运行顺序跟随 H1：主密码 → 恢复码 → H5 一问 → 第一个账户。
  - ux-study §2.12 P1 列出的可访问性修正。
- **U1b**：解锁不再扫描快照，打开弹窗只走一次读取的服务调用。单独成包，**必须在 M2 开始前合入**。

**不做**
- 侧边栏、点按填入、网页版、摄像头 / 屏幕区域取码。
- 导入其他应用的加密文件。
- issuer→域名建议表：属于 U3，本阶段的确认页只提供"记住当前网站"。
- "打开时自动复制"、"最近使用"排序、置顶字段。
- 任何同步内容（M2 及以后）。

### 0.2 硬约束（每个包的验收都要检查）

1. **不新增权限。**
   - `scripts/check-dist.mjs` 的 `PERMISSIONS_ALLOWED`、`OPTIONAL_ALLOWED` 和 `test/e2e/smoke.spec.ts` 的权限断言，都只能保持不变。
   - `commands` 不是权限。`chrome.management.getSelf()` 不需要 `management` 权限。
   - 剪贴板仍是原有的可选权限，并且只在设置页标签页里申请。
2. **不新增网络。**
   - CSP 与 check-dist 的网络绊线不动，`test/regression/network.spec.ts` 不动。
   - 文档链接只是页面导航，而且本阶段为空（见 C1）。
3. **零追踪。**
   - 不记录使用次数或最近使用。
   - 安全记录（H6）只存在本机，只含时间与类型。
4. **永不丢数据。**
   - "替换"一律把旧条目移进回收站。
   - 任何新的读取路径都必须与旧路径在故障注入下结果一致（A2 的差分测试）。
5. **弹窗预算 60 KB gz**，由 check-dist 计算。
   - 现在是 46.3 KB（实测：入口 JS 7.1 + 共享块 33.5 + 两份 CSS 6.8）。中英两份文案目录都在共享块里，合计约 9.6 KB gz。
   - 每个包都要报告自己的增量，见 §2 各包与附录 C。
6. **加密、存储、服务的改动必带测试**（PLAN §13 第 3 条）。
7. **不放松现有测试。**
   - H1 可以迁移"点了'不设密码'"或调用无参 `svc.create()` 的测试，但断言强度不能降低。
   - 迁移清单逐条列在附录 A；评审时逐条核对。
8. **不碰别人的区域。**
   - 不改 `src/core/sync/**`、`contract/**`、`api/**`、`test/unit/sync-crypto-*`、`test/unit/contract-*`、`test/helpers/sync-*`、`test/helpers/contract.ts`（另一个代理正在修 M1）。
   - 不改 `docs/SYNC-DESIGN.md`（另一个代理正在改）。
9. **`src/core/crypto/keyring.ts` 首选不改，最多只增不改。**
   - `src/core/sync/crypto/` 有 3 处 import 它，`test/helpers/sync-keyrings.ts` 和 `test/helpers/world.ts` 都在用 `createKeyring` 与 `enableMasterPassword`。
   - H1 首选在 service 里用已经导出的 `generateVk`、`newVaultId`、`setPassword`、`setRecovery` 组装受保护的 keyring，做法与 `rekey` 相同，这样 `keyring.ts` 一行都不用动。只有组装逻辑需要复用时，才在文件末尾**新增**一个函数。
   - `createKeyring`、`enableMasterPassword` 的行为与签名都不动。`enableMasterPassword` 继续作为旧设备密钥库的升级路径。
   - `envelope.ts`、`kdf.ts`、`recovery-code.ts`、`vk.ts`、`vault/merge.ts` 也被 sync 代码引用，本阶段一律不改。
10. **不提交 git。** 这条直接决定了隔离方式，见 §0.3。

### 0.3 隔离与集成方式（仓库没有任何提交）

**事实**
- `git log` 报 "does not have any commits yet"，所以没有分支可用，`git worktree` 和 Agent 的 `isolation: "worktree"` 也都用不了（它们都需要一个提交）。
- 在同一棵树里并行也不行：
  - `scripts/build.mjs` 每次 `emptyOutDir` 清空 `dist/` 或 `dist-e2e/`；
  - Playwright 写共享的 `test-results/`；
  - M1 代理此刻也在这棵树里改文件；
  - 别人改了一半的文件会让 `tsc` 失败。

**做法：每个包一份私有副本，交回补丁，由集成者按固定顺序合入。**

```bash
# 开一个包（实现者执行）。P = 包号，例如 A1
L=/path/to/scratch/phase0x/$P
R=/path/to/sixkey
EX="--exclude node_modules --exclude dist --exclude dist-e2e --exclude test-results"
mkdir -p $L/base $L/work
rsync -a $EX $R/extension $R/docs $L/base/     # 基线：只读，用作补丁与三方合并的 base
rsync -a $EX $R/extension $R/docs $L/work/     # 工作副本
ln -s $R/extension/node_modules $L/work/extension/node_modules
cd $L/work/extension      # 之后的 npm / npx / python3 命令都在这里运行
```

```bash
# 交付（实现者执行）。diff 用 -x（GNU 与 macOS 自带的 diff 都支持），_locales 不进补丁
DX="-x node_modules -x dist -x dist-e2e -x test-results -x _locales"
cd $L && diff -ruN $DX base work > $P.patch
grep -nE '^\+\+\+ work/(extension/src/core/sync/|extension/test/unit/(sync-crypto|contract)-|extension/test/helpers/(sync-|contract)|docs/SYNC-DESIGN|contract/|api/)' $P.patch && echo "越界，退回"
```

```bash
# 合入（只由集成者执行，一次一个包）
SNAP=/path/to/scratch/phase0x/snap
mkdir -p $SNAP/before-$P && rsync -a $EX $R/extension $R/docs $SNAP/before-$P/   # 回滚点
cd $R && patch -p1 --dry-run < $P.patch              # 补丁里的路径形如 work/extension/...，-p1 去掉 work/
patch -p1 < $P.patch                                 # 干净才应用；有冲突的文件用三方合并：
# git merge-file -p $R/<file> $L/base/<file> $L/work/<file> > merged   （git merge-file 不需要仓库或提交）
cd extension && python3 scripts/messages.py && npm run verify
```

**规则**
- 上面的临时目录路径属于当前会话；换会话时改成新会话的临时目录。不要放在仓库里。ux-study 的测量脚本也在这个会话的临时目录里（`…/scratchpad/ux/bench/`），会随会话一起被清理，所以 A2 要尽早把它们移进 `scripts/bench/`。
- 文件独占是第一道防线（附录 B 的归属表）；补丁只是传输方式，不负责解决冲突。
- `_locales/*/messages.json` 是生成物：**从不进补丁、从不手改**，只由集成者重新生成。
- 生成基线前，先确认主树能通过 `npm run typecheck`。如果 M1 代理改到一半、过不了，就用最近一次绿色快照里的 `src/core/sync/**` 等 M1 文件替换副本里的同名文件；这些文件永远不进补丁。
- 在 M1 修复完成前，道内迭代可以用 `npx vitest run --exclude 'test/unit/sync-crypto-*' --exclude 'test/unit/contract-*'`。**交付前和集成后都必须跑全量 `npm run verify`。**
- 几条道同时跑 Chromium e2e 会互相抢 CPU，弹窗计时和 35 秒剪贴板这类测试容易抖。集成者应把各道的全量 e2e 错开运行。
- 每合入一个包，集成者记录：
  - check-dist 打印的 popup gz；
  - 新增文案键的数量；
  - 这个包的回滚快照位置。

### 0.4 文案（i18n）怎样并行添加

现状：`scripts/messages.py` 是一个文件里的两个大字典，谁加键都会冲突。R0 把它改成"基础 + 分片"：

- 现有 EN/ZH 原样移进 `scripts/i18n/base.py`。R0 之后，任何包都不改这个文件。
  - 目录不叫 `scripts/messages/`：它与 `scripts/messages.py` 同名，容易和 Python 的 import 混淆。
  - 生成器用 `runpy.run_path` **按路径**读取分片，不用 import。
- 每个包有自己的分片 `scripts/i18n/<包号小写>.py`（例如 `a1.py`），里面可以定义：
  - `EN` / `ZH`：新增的键。
  - `OVERRIDE_EN` / `OVERRIDE_ZH`：改写已有的键，必须显式列在这里。
  - `REMOVE`：要删除的键。
- `scripts/messages.py` 只做合并与校验，下面任何一种情况都直接报错：
  - 两个分片新增了同一个键；
  - 改写一个没在 OVERRIDE 里声明的键；
  - 两个分片改写同一个键；
  - 删除不存在的键；
  - 中英键集合不一致。
  - 输出顺序：base 在前，分片按文件名排在后面。R0 加入分片机制时还没有分片，输出必须与现在**逐字节相同**。
- 新键按领域加前缀，进一步避免撞名：

  | 前缀 | 用于 |
  |---|---|
  | `fr` | 首次运行 |
  | `sm` | 安全模式 |
  | `sec` | 安全卡 |
  | `exp` | 导出 |
  | `inst` | 安装来源 |
  | `guide` | 指南 |
  | `site` | 当前网站 |
  | `pa` | 粘贴添加 |
  | `look` | 外观 |
  | `lines` | 纯文本行 |
  | `err` | 错误文案 |

- **键必须和用到它的代码在同一个包里落地。** `test/unit/i18n.test.ts` 有"每个键都必须在源码里出现（no dead text）"的测试。
- 弹窗只加载它的代码用得到的键（附录 E.5）。分片的写法不变；弹窗代码里的键请写成字面量，或者从字面量的表里取，动态拼出的键见 E.5。
  - 因此 SYNC-DESIGN H1 里"`welcomeStart` 只保留给旧库"这句做不到：按钮删掉以后这个键就没有引用了，必须删除。
  - `noPasswordNotice` 仍被旧设备库的横幅引用，保留。

### 0.5 共享文件的其他规则

- **新界面配新 CSS 文件。** 新组件带自己的 CSS 文件，在组件里 import，例如 `src/options/firstrun.css`、`src/popup/main/confirm.css`。`popup.css`、`options.css`、`styles.css` 只由拥有那段已有规则的包修改。
- **图标由 R0 一次预置。** 后续包需要的新图标（`eyeOff`、`sun`、`moon`）由 R0 一次加进 `src/ui/icons.tsx`，其余复用现有的 37 个图标。之后不再往这个文件里加。
- **e2e 稳定选择器是契约**，见附录 D。改动它们的包必须在同一个补丁里迁移对应测试。
- **`test/e2e/harness.ts` 归 A1。** 其他包的新辅助函数放各自的新文件，例如 `test/e2e/perf-helpers.ts`、`test/e2e/export-helpers.ts`。

### 0.6 规模如实说明

SYNC-DESIGN §9.1 把 H1–H8 记作"1 个 M + 7 个 S"。按真实代码看：

- **H1 实际是 M**：
  - 一个新的首次运行向导，覆盖创建、恢复、重新开始三种模式；
  - 加上 H5；
  - 加上 27 处 `svc.create()` 迁移，与原文一致：service.test 16、import-backup 2、enable-crash 2、write-read-mismatch 2，platform、clock、session、purge、store-misc 各 1；
  - 外加 merge.test 的 1 处 `restoreBackup`，以及 e2e 里 7 个直接受影响的测试。
- **H2 是 M。** 其余各项是 S。

H1–H8 合计约 2 M + 6 S，U1 约 1 M + 6 S，U1b 是 S–M。工作量估计的不确定性约为 ±50%。

---

## 1. 依赖与并行道

```
                      ┌─────────────── 可以立即开始，与 R0 同时 ───────────────┐
   C1a 文档初稿（FINGERPRINT-BROWSERS.md + §7 里今天就成立的三处更正，零代码）
   A1-core（keyring 新函数 + service + 单元/回归测试迁移；与 R0 的文件不重叠）
                      └────────────────────────────────────────────────────────┘
R0 准备包（拆文件 · 文案分片 · Settings 字段与预设 · O5 按语言加载 · 预留扩展点）
 │
 ├─ 道 A 核心/安全（每包 Opus 独立评审）
 │    A1 H1+H5 首次运行（core 与 UI 一起交付）──► A2 U1b 读取路径 + 计数门槛 ──► A3 H3+H6 服务层
 │         │                                      │
 │         └──────────────┬───────────────────────┘
 │                        ▼
 │        ══ 闸门 G-M2：A1 与 A2 都合入主树、全量 verify 通过之后，M2 才能开始 ══
 │           （A3 也尽量在 M2 之前；否则它的 service.ts 小改动对 M2 做三方合并）
 │
 ├─ 道 B 弹窗界面（Sonnet 评审 + e2e + 截图）
 │    B1 列表与性能（O1、O3、首屏优先、密度、隐藏、排序、行的可访问性）
 │      ──► B2 当前网站分级 + 记住此网站 + 快捷键
 │      ──► B3 弹窗粘贴添加 + 确认页
 │
 └─ 道 C 设置页/导入/平台/文档（Sonnet 评审）
      C1b 应用内指南面板 ─► C2 H7 纯文本密钥行 ─► C3 H4 安装来源 ─► C8 错误文案
      ─► C4 主题/对比度/字体/外观面板（等 B1 合入）─► C5 安全模式预设（等 B1 合入）
      ─► C6 H2+H3 导出（等 A1、A3 合入；子集导出的核心部分做一次 Opus 专项评审）
      ─► C7 H6 安全记录界面（等 A3 合入）
 ▼
D 收尾：SECURITY/PRIVACY/PLAN §15 终稿 + 全量验收 + 交给 M2 的说明 + 所有者人工检查
```

**跨道依赖**（集成顺序必须遵守）
- B2 依赖 B1，因为两者都改 `src/popup/main/model.ts` 和 `List.tsx`。
- B3 依赖 B2，因为确认页复用"记住此网站"的域名选择。
- C4 和 C5 依赖 B1：它们写入的密度、排序、隐藏验证码要由 B1 来渲染。
- C6 依赖 A1（`Backup.tsx` 的恢复路径）和 A3（`verifyPassword`、`recordExport`）。
- C7 依赖 A3。
- A2 依赖 A1，因为两者顺序修改 `service.ts`。
- C8、C7、A2 都会小改 `src/popup/screens/Locked.tsx`，合入顺序是 A2 → C8 → C7。

---

## 2. 工作包

每个包都按同一顺序写：目标、范围、文件、测试、验收、预算、风险、回滚、评审。

- **独占文件**：本阶段只有这个包改。
- **共享文件**：会有多个包改，附录 B 写明了是哪几段、按什么顺序。

### R0 准备包（行为不变 · 共享契约 · 预算前提）

**目标**：把后面会被多个包同时改的热点文件拆开，一次定下共享的数据契约，并先腾出预算空间。

**范围**
1. **拆分 `src/popup/App.tsx`（588 行）。DOM、class、id、文案、行为全部不变。**
   - `src/popup/App.tsx`：只做路由与 `Screen` 状态。
   - `src/popup/load.ts`（新，非 JSX）：`loadScreen(rt)`，即现在的 `load()`。
     - 现在 `load()` 里"`touch()` 之后 `sendMessage` 重排定时器"的那一步，挪到 App 渲染之后再调用。两者原本就是并发的，挪动不改变可观察的行为。
     - 这样这个模块不在加载时触碰任何 `chrome.*` API，A2 的门槛单测可以直接调用它。
   - `src/popup/chrome.tsx`：Frame、Brand、LangToggle，预留 `banner` 插槽（给 C3 用）。
   - `src/popup/screens/Welcome.tsx`。
   - `src/popup/screens/Status.tsx`：lost、newer、error 三个屏。
   - `src/popup/screens/Locked.tsx`：回调签名预留为 `onUnlocked(info?: { failedSince?: number })`，现在不用这个参数。
   - `src/popup/main/Main.tsx`：状态、键盘、复制、toast、编辑。
   - `src/popup/main/Notices.tsx`：恢复横幅与无主密码横幅，预留 `extra` 插槽（给 C3 和 C7 用）。
   - `src/popup/main/List.tsx`：分区、行、Code 组件。
   - `src/popup/main/model.ts`：纯函数，把过滤、按当前网站分区、分组这几段现有逻辑原样搬过去。
   - `src/popup/main/AddMenu.tsx`、`EditDialog.tsx`、`scan.ts`。
2. **拆分 `src/options/App.tsx`**：侧栏移到 `Rail.tsx`，`UnlockBar` 移到 `UnlockBar.tsx`，`App.tsx` 只做组合。
3. **文案分片**：按 §0.4 改造 `scripts/messages.py`，新建 `scripts/i18n/base.py`。
4. **Settings 契约**：
   - `src/core/service/types.ts` 的 `Settings` 增加 `display: { density: "standard" | "compact"; hideCodes: boolean; sort: "manual" | "name" }`。
   - `parseSettings` 解析这几个字段，默认值 standard / false / manual，等于现状。
     - `parseSettings` 在读和写时都会丢掉不认识的字段，所以这些字段必须在任何界面包之前加进来，否则保存看起来成功，实际会丢设置。
   - 新文件 `src/core/service/presets.ts`：
     - `PRESETS.standard`：闲置 15 分钟锁定、锁屏即锁、不隐藏验证码。
     - `PRESETS.shared`：`always`、锁屏即锁、隐藏验证码。
     - `applyPreset(settings, id)` 和 `detectPreset(settings) → "standard" | "shared" | "custom"`。
     - **不存"当前预设"字段**，按设置推导，少一个状态。
   - 主题不进 `Settings`：它和语言一样放在 localStorage，首屏前同步读取。
5. **O5：只加载当前语言的文案目录。**
   - `src/ui/i18n.ts` 新增 `loadCatalog()`：用两个显式分支的动态 import，让构建产出两个固定命名的块 `assets/locale-en-*.js`、`assets/locale-zh_CN-*.js`。命名在 `scripts/build.mjs` 里配置。
   - `src/popup/main.tsx`、`src/options/main.tsx` 在 render 之前 `await loadCatalog()`。失败时回落到英文目录。
   - `t()` 只查当前目录，缺键时返回键名。两份目录键集合一致，已由 i18n 测试与生成器双重保证。
   - **`scripts/check-dist.mjs` 的 popup 预算把较大的那个语言块计入总数。** 否则 60 KB 门槛会因为文案移出静态图而失真。这不是放松，口径比现在更严。
   - `test/unit/i18n-lang.test.ts` 在 `setLangChoice` 之后加 `await loadCatalog()`，断言不变。
6. **图标**：在 `src/ui/icons.tsx` 预置 `eyeOff`、`sun`、`moon`。

**独占文件**
- `src/popup/**`
- `src/options/App.tsx`、`Rail.tsx`、`UnlockBar.tsx`
- `scripts/messages.py`、`scripts/i18n/base.py`
- `src/core/service/types.ts`、`src/core/service/presets.ts`
- `src/ui/i18n.ts`、`src/ui/icons.tsx`
- `src/popup/main.tsx`、`src/options/main.tsx`
- `scripts/check-dist.mjs`、`scripts/build.mjs`
- `test/unit/i18n-lang.test.ts`

**新增测试**：`test/unit/settings.test.ts`
- 旧记录没有 `display` 字段时，补上默认值；
- 往返不丢字段；
- 非法值回落到默认；
- `detectPreset` 覆盖三种结果；
- `applyPreset` 不动无关字段。

**验收**
```bash
python3 scripts/messages.py && diff -r $L/base/extension/_locales _locales   # 必须无差异
npm run typecheck && npm test
npm run build && npm run check        # 记录 popup gz；预计约 42 KB
npm run e2e                           # 现有 24 条全过（PLAN §15 记为 23）；除 i18n-lang 单测外不改任何测试文件
```
- **DOM 对比**：R0 前后各用同一个 Playwright 脚本（放在临时目录里，不进仓库）打开以下页面，把 `document.body.innerHTML` 里带 hash 的资源名去掉后比较，必须一致：
  - 欢迎、锁定、列表（2 个账户）、添加菜单、编辑对话框；
  - 设置页（空库、已解锁、已锁定三种状态）。

**预算**：约 −4.2 KB。计算：46.3 − 9.6（两份目录移出静态图）+ 5.3（计入较大的中文目录）≈ 42.1；不确定性 ±0.5。这也是用户感受得到的下降：每次打开少解析一份目录。

**风险**
- top-level await 失败会导致白屏：用 catch 回落到英文目录，并有 e2e 冒烟测试。
- 拆分时漏传 props：用 DOM 对比和现有 e2e 兜底。

**回滚**：只回滚代码，不影响数据。旧版本的 `parseSettings` 会丢弃 `display` 字段，仍能正常读取。

**评审**：Sonnet 级 code-review，加 DOM 对比。

### A1 H1 + H5：首个账户前必须设主密码，首次运行四步

**目标**：新安装、从备份恢复、重新开始，在写入任何东西之前都必须先有主密码和已确认的恢复码。永不写设备包裹。首次运行的顺序是：主密码 → 恢复码 → H5 一问 → 第一个账户。

**服务层（A1-core，可以与 R0 同时开工）**

A1-core 开工时用的是 R0 之前的副本，所以要分三步走：
1. `create()`、`restoreBackup()` 改成接收 prepared 对象之后，弹窗欢迎页、`Backup.tsx`、`Misc.tsx` 里的 3 个旧调用点会让 `tsc` 失败。因此在开始界面那一半之前，**A1-core 只用 vitest 验证**（vitest 不做类型检查）。
2. R0 合入之后，从主树重新取一份 `base/` 和 `work/`，把 A1-core 的补丁打上去。它只改 core 文件和测试，应当能干净地打上。
3. 然后再开始界面那一半，最后用全量 `npm run verify` 交付。
- 受保护 keyring 的组装：新 VK，带 password 与 recovery 两个包裹，没有 `deviceKey`，`previous` 为空。
  - **首选**：在 service 里用已经导出的 `generateVk`、`newVaultId`、`setPassword`、`setRecovery` 组装，与 `rekey` 的做法相同，`src/core/crypto/keyring.ts` 不改。
  - 只有组装逻辑需要复用时，才在 `keyring.ts` 末尾**新增** `createProtectedKeyring(password, ctx & { vaultId?, iterations? }) → { keyring, vk, recoveryCode }`，已有的函数一律不动。
- `src/core/service/service.ts`：
  - `prepareKeys(password, opts?: { vaultId? }) → PreparedKeys`
    - 先过 `requirePolicy`，然后在内存里算好 keyring。
    - **不写任何存储。**
    - 返回的不透明对象里带恢复码文本，供界面显示。
  - `create(prepared)`、`restoreBackup(backup, prepared)`、`startOver(prepared)`
    - 各自一次 transact 写入，随后 `startSession(vk)`。
    - 对 `restoreBackup`，`prepared.vaultId` 必须等于 `backup.vaultId`（恢复保留原 vaultId），否则报 `bad_state`。
    - 同一个 `prepared` 只能用一次。
  - 删除无参的 `create()` 以及新建库时写设备包裹的路径。
  - 旧设备密钥库照常可用，`enableMasterPassword` 保留。
  - **这样同时满足 H1 的"先拿密码"和 Z1 的"显示并确认恢复码之后才写入任何东西"。** 页面关闭就等于什么都没写，不需要"设置未完成"标记，也就不需要恢复流程。

**界面**
- `src/popup/screens/Welcome.tsx`：删掉"不设密码直接开始"，只留两个按钮，都打开设置页标签页：
  - "开始（先设置主密码）"：打开 `#setup`，按钮 id 沿用 `start-secure`；
  - "从备份恢复"：打开 `#setup-restore`。
- `src/options/FirstRun.tsx`（新，配 `firstrun.css`）：一个向导，三种模式。
  - 四步：
    1. **主密码**：复用 `PasswordFields`，强度至少 50 bit。
    2. **恢复码**：复用 `RecoveryCodeBox`，可复制、可存为文件，必须勾选"已保存"。
    3. **H5 一问**：措辞用 ux-study §2.8 的原文；两张单选卡；附注"以后可在 设置 › 安全 › 安全模式 中更改"。
    4. **添加第一个账户**：完成后回到正常面板，滚动到"添加账户"，并提示"也可以在网站页面上点 Sixkey 图标，识别页面上的二维码"。
       - **向导在同一个页面实例里继续，不能 `location.reload()`。** `always` 模式下解锁后的 VK 只在这个页面的内存里，一刷新就丢了。用 `ctx.reload()` 重新取状态即可。
       - 选"共享"的用户在这一步前先看到剪贴板清空引导，按钮直接调用 `chrome.permissions.request`。在标签页里调用不会像在弹窗里那样把页面关掉。
  - **提交顺序是关键。** 第 3 步点"完成"时：
    1. 先 `updateSettings(applyPreset(...))`。此时还没有库，`updateSettings` 在模式变化时会清空会话，但这时清空无害。
    2. 再 `create(prepared)`。之后的 `startSession` 会按新模式落到正确的位置：`always` 模式下在页面内存里。
    - 反过来做，选"共享"的用户会在添加第一个账户之前被锁出去。
  - 边界情况：
    - 另一个页面先完成了设置：`create` 报 `bad_state`，提示"已在另一个页面完成设置"，然后 reload。
    - 关掉标签页：什么都没写，下次从头开始。
  - 三种模式：
    - `create`；
    - `restore`：先选文件、输入备份密码、看到"包含 N 个账户"，再进入第 1 步，用 `prepareKeys(pw, { vaultId: backup.vaultId })`；
    - `startOver`：库处于 lost 状态、用户输入 DELETE 之后进入第 1 步。
- 其他界面改动：
  - `src/options/App.tsx`：空库时渲染向导；`#setup-restore` 直接进入 restore 模式。
  - `src/options/Backup.tsx`：`canRestore` 时，apply 改为进入向导的 restore 模式。
  - `src/options/Misc.tsx`：startOver 改为进入向导的 startOver 模式。
  - `src/options/Rail.tsx`：旧设备密钥库在状态卡上持续警告，并提供"现在设置主密码"链接（Z1）。

**为什么放在标签页，而不是弹窗**（偏离了 ux-study 的弹窗示意图，结论推荐，所有者可以否决，见 §5）
- 弹窗一失去焦点就关闭。用户去密码管理器里存密码、存恢复码、下载恢复码文件，都会让焦点离开。
- 在弹窗里：
  - 要么关窗时什么都没写，用户手里留着一个对不上任何库的恢复码；
  - 要么先写入，用户却可能从没看到恢复码。
  - 两种都会诱发日后丢数据。
- 标签页没有这个问题。"扫描本页"要靠 activeTab，只能在弹窗里做，所以由第 4 步的提示与 B3 的空列表按钮补上。

**文案**（`scripts/i18n/a1.py`）
- 新增 `fr*` 键，约 20 个。
- `REMOVE`：`welcomeStart`。
- `OVERRIDE`：
  - `restored`：原文"接下来请设置主密码"在 H1 之后不再成立；
  - `emptyOptions`；
  - `welcomeStartSecure`。

**测试**
- 迁移：附录 A 逐条列出，共 11 个 vitest 文件和 4 个 e2e 文件。
- 新增单元 / 回归测试：
  - `prepareKeys`：遇到弱密码拒绝，且不写任何存储键。
  - `create`：写入之后，kv 与 mirror 里所有值都不包含 `"deviceKey"` 和 `"method":"device"`，keyring 只有 password 与 recovery 两个包裹。
  - 恢复码能解锁；同一个 prepared 不能用两次；`restoreBackup` 遇到 vaultId 不符时拒绝。
  - `test/regression/create-crash.test.ts`（新）：沿用 enable-crash 的 Proc 模型，在 `create` 的每一次写入前后崩溃。之后重启只可能是两种结果：
    - 空库（重新显示欢迎页）；
    - 一个能被该密码和该恢复码打开的库。
    - 任何时刻磁盘上都没有设备包裹。
- 新增 e2e：`test/e2e/firstrun.spec.ts`
  - 新安装在设主密码之前，任何入口都加不了账户。
  - 选"是"之后，`#al-mode` 为 `always`，出现剪贴板引导，并且**到第 4 步时仍是解锁状态**。
  - 选"否"之后是闲置 15 分钟锁定。
  - 用旧设备库 fixture 打开：照常可用，弹窗与侧栏都有警告。
- 残留测试：在 `residue.spec.ts` 新增一个用例。在一个新配置文件里从备份恢复，然后扫描 `Local Extension Settings` 与 `IndexedDB`，不得出现种子明文、`"deviceKey"` 或设备包裹。

**验收**
```bash
npx vitest run test/unit/service.test.ts test/unit/import-backup.test.ts test/unit/keyring.test.ts test/regression
npm run typecheck && npm test
npm run build:e2e && npx playwright test test/e2e test/regression
npm run verify
```

**预算**：popup 增加约 0.6 KB，几乎都是文案。向导代码在设置页的块里，欢迎页反而略有简化。

**风险**
- **测试变慢。** 每次 `prepareKeys` 都要跑一次 PBKDF2 600k，并且无法降低：读取时会强制 600k 下限。27 处迁移预计让 vitest 慢 10–30 秒，未实测。
- **多实例测试会被锁住。** 原来的设备库永远是解锁的。改成密码库之后，那些每次 `make()` 都 `new MemorySession()` 的测试（merge、store-misc、clock）必须改为共享同一个会话，否则后面的实例都处于锁定状态。这是测试夹具的变化，断言不变。
- **H5 的提交顺序**：见上文"提交顺序是关键"。

**回滚**：回滚代码即可。新建的密码库与"开启主密码之后"的库形状相同，旧代码也能读。

**评审**：**必须做 Opus 独立评审**，合入之前完成。三项内容：
- `service.ts` 与 `keyring.ts` 的 diff；
- 向导的状态机：在任意一步关闭或崩溃，都不会写设备包裹、不会丢恢复码、不会锁住用户；
- 附录 A 的逐条核对：断言没有被放松。

**闸门**：A1 合入是 G-M2 的前提之一。

### A2 U1b：打开只读一次、解锁不扫快照，加计数硬门槛（必须在 M2 开始前合入）

**目标**：落实 ux-study 的 O2（服务调用部分）和 O4，加上读取次数与字节数的硬门槛。
- 已解锁时打开一次弹窗：`storage.local` 读取不超过 4 次，读取字节不超过当前槽大小的 1.5 倍。现在是 18 次、5 倍。
- 解锁一次：读取不超过 8 次、不超过 3 倍。现在是 36 次、13 倍。

**范围**
1. **一次打开 = 一次服务调用。**
   - `VaultService.openView()` 返回 `{ state, vault?, events, passwordProtected, settings, lastBackup }`。
   - 读取次数：
     - 指针与事件一次 `get`，加上待清理标记，即 `[sk_active, sk_events, sk_keychange]`；
     - 当前槽一次；
     - settings 与上次备份时间一次（`KvSettingsStore.getView()`）；
     - 再加 `storage.session` 的读取。`storage.session` 不计入 local 门槛，但不得增加。
   - `openVault(vk, gen)` 复用已经读到的 generation，不再读第二遍。
   - 旧的 `status()` 与 `read()` 保留，作为差分测试的参照实现，设置页也还在用。
   - `src/popup/load.ts` 改为调用 `openView`。
2. **解锁不扫快照**：引入"旧密钥材料待清理"标记 `sk_keychange: { v: 1, vkId, at }`。
   - `enableMasterPassword` 与 `rotateKey` 的 transact 在**提交之前**写入这个标记。
     - 如果在提交之前崩溃，留下的是一个多余的标记，代价只是下次多做一次清理（操作本身幂等）。
     - 如果在提交之后才写，在两者之间崩溃会漏掉清理，留下设备密钥残留，是安全回退。
   - `rewriteForKeyChange` 全部成功之后清除标记。
   - `housekeeping` 与 `scrubStaleDeviceKey` 只在标记存在时运行。
   - 现有用户的一次性迁移：没有 `sk_store_v` 时，下一次解锁执行一次原来的完整扫描，然后写 `sk_store_v: 2`。这样可以覆盖升级之前崩溃留下的残留。
   - `selfCheck` 里的 `restoreRedundancy` 照旧覆盖残留的设备密钥。这是 Service Worker 启动时的独立保险。
3. **把不变量写进代码注释**，并写进交给 M2 的说明：`src/core/storage/store.ts` 头部写明"任何会在非当前 VK 之下留下材料的写入，都必须先写 `sk_keychange`"。M2 的入网时重新加密旧快照、previous-VK 回退、`applyRemote` 都必须遵守这一条。
4. **解锁返回视图**：`unlockWithPassword` 和 `unlockWithRecoveryCode` 返回打开所需的数据。弹窗在 `onUnlocked` 之后不再整页重新 load。
5. **`src/platform/runtime.ts`**：`createRuntime` 允许注入 storage area，供门槛测试使用。

**文件**
- 独占：`src/core/storage/store.ts`、`src/core/storage/format.ts`（新增 `KEYS.keyChange`、`KEYS.storeVersion`）。
- 共享：`src/core/service/service.ts`（排在 A1 之后）、`src/core/service/types.ts`（只加 `getView`）、`src/platform/runtime.ts`（排在 A3 之前）、`src/popup/load.ts`、`src/popup/App.tsx`、`src/popup/screens/Locked.tsx`。
- `src/options/App.tsx` 的 reload 改为调用 `openView`，这一项可选。

**测试**
- 新增 `test/unit/read-budget.test.ts`，即**硬门槛**。
  - 用真实的 `ChromeLocalKV` 和 `ChromeSessionCache`，底下是计数用的 fake area（写法同 `platform.test.ts` 里的 `fakeArea`）。
  - 测试数据：100 个账户，快照数分别为 2 和 17。
  - 对 `loadScreen(rt)` 断言：local 读取不超过 4 次，字节不超过当前槽的 1.5 倍，mirror 读取为 0。
  - 解锁之后再打开视图：读取不超过 8 次、不超过 3 倍。
  - 快照数为 2 和为 17 时，读取次数必须相同，证明读取量不随快照增长。
- 新增 `test/fault/open-view-diff.test.ts`，差分测试。
  - 复用 `test/helpers/faulty-kv.ts`，随机生成各种损坏状态：坏槽、坏指针、空主库只剩镜像、坏快照。
  - 断言 `openView()` 与 `status()` 加 `read()` 的结果相同：state、vault 的 canonicalJson、事件种类、`passwordProtected`。
- 新增 `test/fault/keychange-marker.test.ts`，用 enable-crash 的 Proc 模型覆盖 `rotateKey`，以及升级前的残留和多余标记两种情况。
- 迁移 `test/unit/service.test.ts` 里"finishes the cleanup after a crash that left old material behind"这一条。
  - 它手工放回旧材料，但没有放回标记。真实的崩溃状态里一定有标记，所以测试要一并放回标记。
  - 另加一条新测试：没有标记、也没有 `sk_store_v` 的旧残留，由一次性扫描清掉。这条覆盖的正是原测试的本意。
- **以下测试一行都不改，必须照样通过**：`test/regression/enable-crash.test.ts`（以 A1 合入后的版本为准）、`test/fault/store.test.ts`。它们是 U1b 的安全底线。
- 新增 `test/e2e/perf.spec.ts`，**只告警**：100 个账户，在冷态与热态各测一次"导航到出现首个验证码"的时间，写进 `test.info().annotations`；超过 ux-study 的预算时打 warning，不让测试失败。
- 把 ux-study 的测量脚本（临时目录里的 `cdp.mjs`、`bench.mjs`、`seed.mjs`）移进 `scripts/bench/`，作为手工工具，不进 CI。临时目录会被清理，所以这一步要尽早做。

**验收**
```bash
npx vitest run test/unit/read-budget.test.ts test/fault test/regression/enable-crash.test.ts
npm run typecheck && npm test && npm run build && npm run check
npm run build:e2e && npx playwright test test/e2e/perf.spec.ts && npm run verify
```

**预算**：约 +0.2 KB。

**风险**
- **最大的风险是清理时机变了。** 评审必须逐一列出所有可能在"非当前 vkId"之下留下材料的路径：
  - 密钥变更；
  - 恢复链（`recover` 里的 `writeBoth` 选到的旧 keyring）；
  - 解密回退（`openVault` 的 transact）；
  - `purgeForever` 的 `rewriteForKeyChange`。
  - 并确认每条路径要么写了标记，要么由 `selfCheck` 兜底。
- 一个副作用要写清：现在解锁时的清理会丢掉"属于比当前更新的 VK"的快照（恢复到旧状态之后才会出现）。不扫描之后，这些快照会保留下来。这是对数据更保守的方向，D 包要把它写进 SECURITY.md。

**回滚**：回滚代码。留下的 `sk_keychange` 和 `sk_store_v` 不会被旧版本当作库数据：`hasAnyData` 不认它们，`gcSnapshots` 只处理 `sk_snap_*`。旧版本自己会照常做完整扫描。

**评审**：**必须做 Opus 独立评审**（存储）。重点是：
- 标记的崩溃安全；
- 一次性迁移；
- 差分测试有没有覆盖到所有恢复分支；
- 门槛测试测的是不是弹窗真实走的那条路径。弹窗必须只调用 `loadScreen`，评审要核对。

**闸门**：A2 合入之后，满足 G-M2。

### A3 H3 + H6 服务层：验证密码，独立的本地安全记录

**目标**：给 H3 和 H6 提供服务层接口与数据，界面分别由 C6 和 C7 做。

**范围**
- 新文件 `src/core/service/security-log.ts`：`SecurityLog`，注入 KV 与锁（锁名 `sixkey-security-log`）。
  - 数据：键 `sk_security_log`，格式 `{ v: 1, entries: [{ at, kind }], ackAt? }`，最多 50 条，超出时丢最旧的。
  - kind 的取值：`unlock_failed`、`recovery_failed`、`export_encrypted`、`export_plain`、`export_subset`、`password_changed`、`key_rotated`、`recovery_code_new`、`password_reset`。
  - 方法：`failuresSinceAck()`、`ack()`、`clear()`、`recent(n)`。
  - 记录损坏时按空记录处理。
  - **完全不读写 `sk_events`**（H-b）。
- `src/core/service/service.ts`：
  - 新增可选依赖 `security?: SecurityLog`，注入方式与 `onDiag` 相同。
  - 两个解锁方法失败时记一条。记录本身写失败，不影响原来的返回值。
  - 解锁成功时返回 `{ failedSince }`，然后 `ack`。
  - 改密码、轮换、新恢复码、用恢复码重设成功时，各记一条。
  - 新增 `verifyPassword(password)`：只读，解包之后比对当前 vkId。它不改会话、不写任何库键；失败时记 `unlock_failed`；对旧设备库返回 `not_protected`。
  - 新增 `recordExport(kind)`：界面在导出成功之后调用。
- `src/platform/runtime.ts`：接线。

**测试**
- `test/unit/security-log.test.ts`：计数、ack 之后清零、clear、50 条上限滚动、损坏回落、从不碰 `sk_events`。
- `test/unit/service.test.ts` 新增一个 describe：
  - 错误密码的计数与 `failedSince`；
  - `verifyPassword` 前后，会话与所有库键逐字节不变。

**验收**：`npx vitest run test/unit/security-log.test.ts test/unit/service.test.ts && npm run verify`

**预算**：+0.4 KB。这段代码进入共享块，因为弹窗也会实例化服务。

**风险**：几个上下文同时记录时，计数可能少一次。锁可以挡住大部分情况；剩下的不影响安全，只影响告警。

**回滚**：回滚代码。`sk_security_log` 会被旧版本忽略。

**评审**：Opus 独立评审（服务层）。diff 很小，可以与 A2 的复审合并。

### B1 U1 列表与性能

**目标**：落实 O1、O3 和 O2 的界面部分（首屏优先），实现密度、隐藏验证码与排序的渲染，以及列表行的可访问性修正。

**范围**
- **O1**：`.row { content-visibility: auto; contain-intrinsic-size: auto 54px }`，紧凑模式为 38px。
- **O3：倒计时圆环改为 CSS 动画。**
  - 圆环的 6 段各用一条 `@keyframes`，`animation-duration` 等于周期，用负的 `animation-delay` 对齐当前秒数。
  - JS 刷新从每 250 ms 一次改为每秒一次，并对齐秒边界，只更新秒数与 `.low` 状态。
  - 最后 5 秒只有圆环和秒数变红，验证码数字保持原色。删掉 `.row.low .code` 的红色。
  - 在 `prefers-reduced-motion` 下，全局规则会把动画时长压成 0.001 ms，圆环会直接显示为"已耗尽"。这时必须退回每秒用 JS 更新一次的实现，并配一条测试。
  - 圆环里的秒数字号不小于 9.5 px。
- **首屏优先**：`useCodes` 先算可见的前 16 个，其余放到下一个任务里。
- **密度**：标准 / 紧凑，读 `settings.display.density`。
- **隐藏验证码**：读 `settings.display.hideCodes`。
  - 隐藏时 DOM 里**不放数字**，只放一个用 `--muted` 颜色的遮罩。
  - 点击照样复制。
  - 按空格或按住鼠标，显示选中那一行 5 秒。
  - 当前网站那一行也隐藏。
- **排序**：手动 / 按名称。按名称时用当前语言的 `localeCompare`。当前网站分区始终排在最前，这一条在 `model.ts` 里实现。
- **可访问性**（ux-study §2.12 P1）：
  - 现在 `role="option"` 里面套着编辑按钮，属于交互元素嵌套。改为列表结构，每行两个独立按钮：复制、编辑。
  - 方向键用 roving tabindex 在复制按钮之间移动。
  - 每行带一段视觉隐藏的"剩 N 秒"，不做实时朗读。
  - 等待中的"••• •••"改用 `--muted` 颜色。现在用的 `--faint` 对比度只有 2.3:1。
  - 附录 D 列出的 class 与 id 一律保留。
- **闲置 CPU 告警**：新增 `test/e2e/perf-idle.spec.ts`。
  - 100 个账户，弹窗打开 10 秒，通过 CDP `Performance.getMetrics` 读 `TaskDuration`。
  - 超过 20 ms/秒时只发告警。

**文件**
- 独占：`src/ui/hooks.ts`、`src/ui/art.tsx`（Ring）。
- 共享：
  - `src/ui/styles.css`：只改 `.ring` 那一段与新增的 keyframes；
  - `src/popup/popup.css`：只改列表、行、`.low`、紧凑模式，不碰两个暗色 `@media` 块；
  - `src/popup/main/List.tsx`、`Main.tsx`（键盘）、`model.ts`（排序）。

**测试**
- 单元测试：
  - `model.ts` 的排序与分区；
  - 首屏优先的调度函数（拆成纯函数来测）；
  - Ring 在 reduced-motion 下的退回逻辑（纯函数）。
- e2e：`test/e2e/list.spec.ts`
  - 隐藏模式下，`document.body.innerText` 不含当前验证码的任何一种可接受值，点击之后剪贴板是正确的码；
  - 紧凑模式下，行高约 38 px；
  - 按名称排序的顺序正确；
  - 不存在包含 button 的 `[role=option]`。

**验收**：`npx vitest run test/unit && npm run build && npm run check && npx playwright test test/e2e/list.spec.ts test/e2e/flows.spec.ts && npm run verify`

**预算**：+1.0 KB（CSS 0.5，JS 0.4，文案 0.1）。

**风险**
- O3 能省下多少闲置 CPU 只是估算，没有实测。
- 6 段 keyframes 要和现在 `Ring` 的计算结果对齐，需要截图比对。

**回滚**：回滚代码。

**评审**：Sonnet code-review，加浅色 / 深色 × 中 / 英四组截图，由集成者人工过目。

### B2 U1 当前网站分级、记住此网站、快捷键

**目标**：只给已登记的域名打"此网站"标签，名称猜测降为"可能相关"；可以编辑域名，一键记住当前网站；修正中文 issuer；加快捷键。

**范围**
- `src/core/match.ts`：
  - 新增 `matchTier(entry, host) → "registered" | "related" | null`。
    - registered：`host` 等于某个已登记域名，或是它的子域名。
    - related：现有的名称猜测。
  - 规范化改为保留 Unicode 字母与数字（`\p{L}\p{N}`），中文 issuer 不再被清成空串。
  - **`matchesSite` 保留，语义等于"任意一级"**，所以 `test/unit/match.test.ts` 里的现有断言一条都不用改。
- 新文件 `src/core/site-domains.ts`：`domainChoices(host)` 返回当前主机名及各级父域名。
  - 排除单段名称，排除内置的大约 100 个多段公共后缀，例如 `co.uk`、`com.cn`、`github.io`、`vercel.app`。直接排除比给警告更简单。
  - 只在点"记住"时才懒加载这张表。
- 弹窗：
  - 分区依次为"此网站"（只有 registered）、"可能相关"（related，不带标签；每行一个"记住：<host> 属于此账户"按钮，点开是域名选择）、其他账户。
  - 搜索同时匹配域名。
  - 编辑对话框加"网站"一栏（chips），可以删除，也可以一键加入当前主机。
  - 写入前按 `LIMITS`（最多 16 个、每个不超过 253 字符）校验。
- `manifest.base.json`：加 `"commands": { "_execute_action": { "suggested_key": { "default": "Alt+Shift+K" } } }`。设置页里显示当前绑定，由 C4 实现。

**文件**
- 独占：`src/core/match.ts`、`src/core/site-domains.ts`、`manifest.base.json`。
- 共享（排在 B1 之后）：`src/popup/main/model.ts`（分级）、`List.tsx`、`EditDialog.tsx`、`popup.css`（"可能相关"分区的样式）。

**测试**
- `test/unit/match.test.ts`，只加不改：
  - ux-study E5 的 5 个仿冒主机，在没有 domains 时都不是 registered；
  - "阿里云"规范化之后不为空，加上 `domains: ["aliyun.com"]` 后能在 `signin.aliyun.com` 上命中。
- `test/unit/site-domains.test.ts`、`test/unit/list-model.test.ts`。
- e2e `test/e2e/site.spec.ts`：编辑 chips 之后，`domains` 能保存下来，搜索域名能找到对应账户。
- "真实弹窗里的分级"需要真实的工具栏弹窗才能拿到 activeTab，Playwright 以标签页方式打开弹窗时做不到。ux-study 用 CDP `Extensions.triggerAction` 做到了，但在 Playwright 的持久化上下文里能不能拿到浏览器级 CDP 会话，**没有核实**。所以列为人工检查（§4），做不到自动化不算失败。

**验收**：`npx vitest run test/unit/match.test.ts test/unit/site-domains.test.ts test/unit/list-model.test.ts && npx playwright test test/e2e/site.spec.ts && npm run check && npm run verify`

**预算**：入口约 +1.0 KB，域名选择与后缀表放进懒加载块。

**风险**
- `domains` 属于内容寄存器（LWW）。Phase 1 同步后，"在 A 设备记住网站"和"在 B 设备改名"会互相覆盖。这是现有模型的局限，交给 M3 记录。
- 建议快捷键与其他扩展冲突时，Chrome 不会自动分配，用户要自己设置。

**回滚**：回滚代码。已经写进库里的 `domains` 本来就是现有字段，旧版本也会用于匹配，只是不分级。

**评审**：Sonnet code-review。

### B3 U1 弹窗"粘贴任何东西"与确认页

**目标**：在弹窗里完成最常见的添加方式：粘贴链接、密钥或截图，或扫描本页。确认页负责去重，并提供"添加并复制验证码"。

**范围**
- **添加页**（`AddMenu.tsx`）：
  - 顶部是粘贴区，自动获得焦点。它接受 Ctrl+V 粘贴文本或图片，走 `clipboardData`，不需要任何权限。
  - 下面依次是：扫描本页（主按钮）、上传图片（跳设置页）、手动输入（跳设置页）、从其他应用导入（跳设置页）。
- **列表页**：焦点不在输入框时按 Ctrl+V，直接进入确认页。在搜索框里粘贴仍然只是粘贴。
- **空列表**：插图下面直接放"粘贴"和"扫描本页"两个按钮。
- **扫描**：用 `BarcodeDetector` 时解出画面里所有二维码，多于一个时让用户选；回退路径仍然只解一个。
  - 解出的文本直接进入弹窗的确认页，**不再通过 `storage.session` 转交设置页**。这是一项隐私改进：扫到的密钥不再经过共享的会话存储。D 包要相应更新 SECURITY.md。设置页那段读取代码保留，因为它无害。
- **确认页**（`src/popup/main/AddConfirm.tsx`，配 `confirm.css`）：**整页连同 importer、otpauth 和 migration 解析器一起动态 import。**
  - 这些模块现在只在设置页的块里。如果弹窗静态 import 它们，它们会挪进计入预算的共享块。
  - 显示 issuer、label（可改）、字母头像，以及位数、周期、算法。
  - 有当前网站时，显示"在 <host> 上排在最前"复选框。issuer 与主机名能匹配上时默认勾选，否则不勾。复用 B2 的 `domainChoices`。
  - 主按钮"添加并复制验证码"，复制后照常触发剪贴板清空；次按钮"仅添加"。
  - 写明下一步："在网站上输入这个验证码完成绑定；网站说验证码错误时，先检查电脑时间"。
- **去重**（新文件 `src/core/import/dedupe.ts`，纯函数）：比较**解码后的密钥字节**。
  - 现有的 `normalizeBase32` 不规范末尾的填充位，两个不同的字符串可能解出同样的字节。
  - 判定与处理：

    | 情况 | 处理 |
    |---|---|
    | 同一个密钥、同一个 issuer | 跳过，提示"已存在" |
    | 同一个密钥、不同名称 | 提示"可能是重复扫描"，由用户决定 |
    | 同一个 issuer 加 label、不同密钥 | 提示"可能是重新绑定"，由用户选"保留两个"或"替换"。替换 = 在同一次 `mutate` 里添加新条目并 `deleteEntry` 旧条目，旧条目进回收站。**永不自动替换。** |

- **边界情况**
  - 多个候选（例如 Google 迁移码）：只提供"添加 N 个"，不复制。
  - 迁移批次不全、或多列文本：显示"在设置页继续"按钮。列选择由 C2 在设置页实现。
  - HOTP：保存并标注。

**文件**
- 独占：`src/core/import/dedupe.ts`、`src/popup/main/AddMenu.tsx`、`AddConfirm.tsx`、`confirm.css`、`scan.ts`、`src/lib/qr.ts`。
- 共享（排在 B2 之后）：`Main.tsx`（粘贴事件、视图状态）、`List.tsx`（空列表按钮）。

**测试**
- `test/unit/dedupe.test.ts`：
  - 字节层面相同、字符串不同的密钥要判为相同；
  - 三种提示；
  - 替换之后旧条目在回收站里，`secret` 不为空，可以恢复。
- e2e `test/e2e/add-popup.spec.ts`：
  - 粘贴 otpauth 之后进入确认页，"添加并复制"后剪贴板里是可接受的码，列表里出现这一行；
  - 重复粘贴显示"已存在"；
  - 在列表页按 Ctrl+V 进入确认页；
  - 用 `page.evaluate` 派发一个带 `DataTransfer` 图片的 paste 事件，验证截图粘贴。

**验收**：`npx vitest run test/unit/dedupe.test.ts && npm run build && npm run check`（入口增量不得超过 1.5 KB，另外打印懒加载块的大小）`&& npx playwright test test/e2e/add-popup.spec.ts && npm run verify`

**预算**：入口约 +1.0 KB；懒加载块约 6–8 KB gz，不计入弹窗预算。

**风险**
- 在弹窗里点"上传图片"会打开文件选择框，当前版本会不会因此关闭弹窗，**没有核实**。所以上传仍然跳设置页。
- 粘贴截图依赖 `createImageBitmap`，在弹窗里可用（现有的扫描路径已经在用）。

**回滚**：回滚代码。

**评审**：Sonnet code-review。"替换进回收站"这一段要单独过一遍，确认不会丢数据。

### C1 H8 文档与应用内指南（C1a 可以立即开始，C1b 在 R0 之后）

**目标**：写出《在指纹浏览器中使用 Sixkey》，包括"AI 代理与自动化"一节；现在就改正 PRIVACY 和 SECURITY 里两处不实的表述，并在威胁表里补上 A10。

**C1a：文档（零代码）**
- 新建 `docs/guides/FINGERPRINT-BROWSERS.md`，英文在前、中文在后，同一个文件。各节：
  1. 这些浏览器会对配置文件做什么：厂商云同步、克隆、共享、转移、本地 API 与调试端口。按调研报告分厂商写，并注明来源。
  2. 安装：只用商店链接安装，核对扩展 ID，并说明 H4 横幅是什么意思。
  3. 转移或共享配置文件之前：先卸载 Sixkey，或者只放"导出所选账户"的子集（H2）。
  4. 共享的、或被脚本控制的配置文件：用"共享 / 自动化"预设，即每次都锁定、隐藏验证码、清空剪贴板。
  5. 没有主密码的旧设备密钥库，在这些环境里等于把种子交给厂商和团队：请立即设置主密码，并到各网站重新绑定。
  6. 同步：**明确标注"Phase 1 上线后才适用"**，先写原则：加入同步的配置文件绝不能被厂商同步或与他人共享。
  7. **AI 代理与自动化**（mcp-feasibility 的结论）：
     - Sixkey 不向任何代理返回验证码、种子或账户清单；
     - 能连上调试端口的代理，在解锁期间能读到一切（A10），被自动化控制的配置文件要用"每次都锁定"；
     - QA 自动化应该把测试账号的种子放进 CI 环境变量，而不是放进 Sixkey；
     - "交接"模式：代理在 2FA 这一步停下，由用户点图标复制。
  8. 卸载与残留：卸载只删除**这个**配置文件里的数据；厂商云端或复制出去的副本仍然存在。
  9. 限制：如实写明。
- `docs/PRIVACY.md`、`docs/security/local-vault.md`：只改 §7 里描述**今天就成立**的三处。
  1. 卸载那句（PRIVACY）："卸载只删除这个配置文件里的数据；同步到云端、复制或导出过的副本不会因此消失。"
  2. IndexedDB 镜像那句（SECURITY 的 Limits）：在部分指纹浏览器里，镜像不是独立副本。
  3. SECURITY 的威胁表加上 A10：能连上配置文件调试端口（CDP）的本机进程，在解锁期间几乎能读到一切；我们只能缩短窗口，这也是 H5 存在的原因。
  - 其他 Phase 0.x 的行为描述留给 D 包。**不写任何 Phase 1 的网络或同步内容。**

**C1b：应用内**
- `src/options/Guide.tsx`（新）：一个面板，5–6 条要点，走 i18n。
- `GUIDE_URL` 常量：现在为空，为空时不显示链接。Phase 2 网站上线后再填。因为本阶段零网络、还没有网站，"链接到指南"现在只能是应用内摘要；链接本身只是导航，不是 fetch。
- `src/options/App.tsx`：在 `SECTIONS` 里加一项。

**测试与验收**
- 所有者阅读。
- 一个 Sonnet 子代理对照代码核对文档里的每一条事实陈述，并在报告中逐条列出。
- 检查文档里的相对链接是否存在。
- `npm test`：i18n 测试覆盖新键。
- e2e 冒烟：设置页出现该面板。

**预算**：+0.4 KB（文案进入全局目录）。

**风险**：文档承诺了尚未实现的行为。处理办法是 D 包在全部代码合入后再核对一遍，没有实现的部分改成"计划中"。

**回滚**：直接回滚文件。

**评审**：便宜检查，加所有者阅读。

### C2 H7 纯文本密钥行导入

**目标**：在本地导入 `名称|密钥` 行和裸 base32 行，把用户从会外传种子的在线工具拉回来。其他列一律丢弃。

**范围**
- `src/core/import/importer.ts` 的 `planImport` 接受以下输入：
  - **裸 base32 行**：规范化之后至少 16 个字符（80 bit）；更短的判为 `not_key`。
  - **`名称|密钥` 两列**。
  - **三列及以上**：
    - 自动选"整列都能解析成 base32、且长度至少 16"的那一列作为密钥列，`opts.keyColumn` 可以覆盖；
    - 名称取第 0 列；如果第 0 列就是密钥列，则取第 1 列；
    - **其余列不进入 plan 的任何字段。**
  - 每一列只报告"第 N 列：多长、像不像密钥"，**从不回显内容**。这沿用了现有"不把秘密显示回去"的原则：密码列也是秘密。
- `src/options/AddAccounts.tsx`：有多列时，预览里显示密钥列选择，并写明"其他列（例如密码）不会保存"。

**文件**：独占 `src/core/import/importer.ts`、`src/options/AddAccounts.tsx`（只改 Preview 部分）。

**测试**：`test/unit/import-lines.test.ts`，不少于 30 个用例。
- 覆盖：两列、三列、四列、空列、首尾带 `|`、CRLF、全角空格、otpauth 行与纯文本行混排、非法 base32、过短、重复。
- **断言 `JSON.stringify(plan)` 以及写入之后的库里，都不包含任何"非密钥、非名称"列的内容。**
- 现有的 `test/unit/otpauth.test.ts` 与 `test/unit/import-backup.test.ts` 不改。

**验收**：`npx vitest run test/unit/import-lines.test.ts test/unit/import-backup.test.ts && npm run verify`

**预算**：+0.2 KB，只有文案。代码在设置页块里；弹窗经 B3 的懒加载块间接获得这项能力。

**风险**：一行普通的字母可能被当成密钥。三层防护：最短长度、必须确认之后才添加、预览里标明"来自纯文本行"。

**回滚**：回滚代码。

**评审**：Sonnet code-review，重点看那几个"不保存"的测试是不是真的在测这件事。

### C3 H4 安装来源自检

**目标**：发现旁加载的、不会自动更新的旧副本，并给用户一个可以核对的扩展 ID。**它挡不住恶意副本**（恶意副本可以把这项检查删掉），文案要如实写明。

**范围**
- 新文件 `src/core/install-source.ts`（纯函数）：`installProblem({ id, installType }, storeId) → null | "not_store" | "id_mismatch"`。
  - `installType` 为 `normal` 或 `admin` 时不提示（H-d）。
  - `storeId` 为空时只检查 `installType`。
- 新文件 `src/platform/install-source.ts`：调用 `chrome.management.getSelf()`，在首个验证码渲染之后才调用，不进入首屏关键路径。
- `scripts/build.mjs`：用 Vite `define` 注入两个常量。
  - `__STORE_ID__`：Phase 2 第一次提交 CWS 之后才有，现在为空。
  - `__INSTALL_CHECK__`：prod 与 e2e 为 true，dev 为 false。
- `scripts/check-dist.mjs`：加一条规则，只有配置了商店 ID 时才生效：prod 的 JS 里必须包含它。
- 横幅：
  - 弹窗：`src/popup/chrome.tsx` 的 `banner` 插槽，加 `Notices.tsx` 的 `extra`。
  - 设置页：`src/options/App.tsx` 主栏顶部。
  - 横幅用 `role="status"`，**不用 `role="alert"`**，否则会让现有 e2e 里 `getByRole("alert")` 的计数断言失败。
- 交给所有者的提醒：在 Phase 2 之前，所有者自己测试用的未打包构建会**一直**显示这条横幅。这是预期行为。

**测试**
- `test/unit/install-source.test.ts`：各种 `installType` 与 id 组合，`storeId` 为空和不为空两种情况。
- e2e：e2e 构建是未打包安装（`installType` 为 `development`），所以在一个用例里断言横幅出现、显示的 ID 正确；其他用例不受影响。

**验收**：`npx vitest run test/unit/install-source.test.ts && npm run build && npm run check && npm run verify`

**预算**：+0.5 KB。

**风险**：横幅占用弹窗高度，列表少显示约一行。

**回滚**：回滚代码。

**评审**：Sonnet code-review。

### C4 U1 主题、对比度、字体与外观面板（等 B1 合入）

**目标**：手动选择主题（跟随系统、浅色、深色），两个页面加 `color-scheme` meta，修正对比度，字体文件从 5 个减到 3 个（O6），并新增外观面板。

**范围**
- 新文件 `src/ui/theme.ts`：选择存在 localStorage，读写都包在 try 里。
- 主题 CSS 写法：`:root[data-theme=dark]`，加上 `@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) { … } }`。下面这些现有的暗色规则都要按同样写法一起改：
  - `styles.css` 里的 `.btn.danger`、`.av`、`.mk-tile`；
  - `popup.css` 里的 `.row.sel`、`.toast`；
  - `options.css` 里下拉框箭头与复选框的暗色规则。
- **防止首屏闪烁。** CSP 不允许内联脚本。方案是在 `<head>` 里放一个同步执行的经典脚本 `public/theme-boot.js`，在 `<body>` 绘制前设好 `data-theme`。
  - 这个文件放在 `public/`，按原样复制到产物里；用 `src=` 引用，不是内联脚本，所以 check-dist 的规则允许。
  - Vite 会不会按原样保留这个非 module 的脚本，**没有核实**。做不到就接受轻微闪烁，列入人工检查。
- 两个 HTML 都加 `<meta name="color-scheme" content="light dark">`。
- 对比度：
  - 输入框边框 `--line-2` 至少 3:1：浅色 `#8E97A3`、深色 `#5A6370`，以 ux-study 的建议值为起点，设计上再确认；
  - 其余正文 token 保持至少 4.5:1。
- **O6**：删掉 Instrument Sans 500 与 Martian Mono 400 两个字重，同时去掉对应的 `<link rel=preload>`。
  - 后果：`font-weight: 500` 的界面文字会按字体匹配规则落到 400，等宽文字从 400 落到 500。需要截图确认。
- 新文件 `src/options/Appearance.tsx`：
  - 主题；
  - 密度、排序：B1 已经实现了渲染，这里只是写设置；
  - 显示当前快捷键：`chrome.commands.getAll()`，不需要权限；附上"在 chrome://extensions/shortcuts 修改"；
  - 语言菜单里注明"简体中文"（ux-study §2.12 P1）。
- `src/options/App.tsx`：在 `SECTIONS` 里加"外观"。

**文件**
- 独占：`src/ui/theme.ts`、`public/theme-boot.js`、`src/options/Appearance.tsx`、两个 `index.html`。
- 共享：
  - `src/ui/styles.css`：token 与组件的暗色规则；
  - `popup.css`：只改两个暗色块；
  - `options.css`：只改暗色块；
  - 两个 `main.tsx`：设置主题的那一行；
  - `src/options/App.tsx`。

**测试**
- `test/unit/theme.test.ts`。
- **`test/unit/contrast.test.ts`（硬门槛）**：从 `styles.css` 解析浅色与深色两套 token，按 WCAG 2.x 公式计算对比度（照搬 ux-study 的 `contrast.mjs`）：
  - 输入框边框对表面色至少 3:1；
  - `--ink`、`--ink-2`、`--muted`、警告、危险色，对所在背景至少 4.5:1。
- e2e `test/e2e/theme.spec.ts`：选深色之后，弹窗与设置页的 `data-theme` 都是 `dark`，计算出的背景色是深色；选"跟随系统"之后会跟随 `emulateMedia`。
- check-dist 加规则：popup 与 options 的 HTML 必须带 `color-scheme` meta。这是收紧，不是放松。

**验收**：`npx vitest run test/unit/contrast.test.ts test/unit/theme.test.ts && npm run build && npm run check && npx playwright test test/e2e/theme.spec.ts && npm run verify`

**预算**：+0.9 KB，主要是暗色 token 的第二份选择器。

**风险**：首屏闪烁（见上）；字重变化。

**回滚**：回滚代码。localStorage 里留下的主题值无害。

**评审**：Sonnet code-review，加上四组截图：浅色、深色、跟随系统，以及"系统深色 + 手动浅色"。

### C5 U1 安全模式预设（设置页，等 B1 合入）

**目标**：在设置 › 安全 › 安全模式里，提供"标准 / 共享·自动化"两个预设；改动其中任何一项后显示"自定义"。与首次运行的 H5 一问用同一份 `presets.ts`。

**范围**
- 新文件 `src/options/SecurityMode.tsx`：
  - 两张预设卡；
  - 原来的自动锁定选项，`#al-mode`、`#al-minutes`、`#al-screen` 三个 id 保留；
  - "隐藏验证码"开关；
  - 剪贴板清空的入口链接，指向现有的 Clipboard 面板。
- "导出前重新输入主密码"始终开启，**不属于任何预设**。
- `src/options/Security.tsx`：用 `SecurityMode` 替换掉 `AutoLock`，改动约 2 行。

**测试**
- e2e `test/e2e/presets.spec.ts`：
  - 切到"共享"之后，`#al-mode` 为 `always`，弹窗里的验证码被隐藏；
  - 单独改一项之后显示"自定义"；
  - 切回"标准"之后恢复闲置 15 分钟。
- 单元测试已经在 R0 里。

**验收**：`npx playwright test test/e2e/presets.spec.ts test/e2e/flows.spec.ts && npm run verify`

**预算**：+0.3 KB，只有文案。

**风险**：`updateSettings` 在模式变化时会锁定，切到"共享"会立刻锁上，界面要提示一句。

**回滚**：回滚代码。

**评审**：Sonnet code-review。

### C6 H2 + H3 导出（等 A1、A3 合入）

**目标**：
- 所有导出之前都要重新输入主密码（H3）；
- 新增"导出所选账户"子集备份（H2）：新的 vaultId、新的条目 id、重新盖章的 HLC，`createdAt` 取导出时间。

**范围**
- 新文件 `src/core/backup/subset.ts`：`buildSubsetVault(vault, ids, { now, rng })`。
  - 只取被选中、且仍存活的条目。
  - 每个条目换新 id，`createdAt` 改为导出时刻。
  - 用一个随机设备后缀的临时时钟，重新给 `hlc` 与 `phlc` 盖章；不带 `dhlc`；`order` 重新均匀分布。
  - 保留 `group` 与 `domains`：这是用户选中账户的内容。
  - vaultId 用 `newVaultId()` 生成。
  - 最后交给现有的 `createBackup`。**不新增任何格式。**
- `src/options/Backup.tsx`：
  - 明文导出、加密备份、子集导出三条路径都要求先填"当前主密码"（`#export-pw`）。
  - 导出时先 `verifyPassword`，再 `read()` 读取最新的库，再执行导出，最后 `recordExport`。
  - 旧设备库没有主密码可验，显示警告之后允许导出。
  - 子集导出可以按分组勾选，也可以逐个勾选，有全选与全不选，并写明"适合放进共享或厂商云配置文件：对方只会得到这几个账户"。

**测试**
- **`test/unit/backup-subset.test.ts`**，fast-check 属性测试。随机生成的库里包含回收站条目、墓碑与已永久删除的条目，随机选择一部分。断言子集文件解密之后：
  - 不含任何未选条目的 id、名称或 secret；
  - 不含任何源条目 id；
  - 不含源 HLC 的设备后缀；
  - vaultId 是新的；
  - `createdAt` 全部等于导出时刻；
  - 只包含存活的条目。
- 通过服务层导入到另一个库：
  - 只得到被选中的账户；
  - 再次导入更新后的子集时，没改名的账户不重复；改过名的作为新条目出现。这是 H-d 放宽过的验收口径。
- e2e `test/e2e/export.spec.ts`：
  - 已解锁但没有重输密码时，三个导出按钮都不可用；
  - 输错密码会报错，并在安全记录里加 1；
  - 子集导出之后导入一个新配置文件，得到的恰好是选中的那几个账户。
- 迁移 `flows.spec.ts` 里两个导出相关的测试（"encrypted backup restores a fresh install"的导出部分，以及"a backup holds what was added after the settings page opened"）：补上 `#export-pw`，断言不变。
  - 辅助函数放进新文件 `test/e2e/export-helpers.ts`。

**验收**：`npx vitest run test/unit/backup-subset.test.ts && npx playwright test test/e2e/export.spec.ts test/e2e/flows.spec.ts && npm run verify`

**预算**：+0.3 KB，只有文案；代码在设置页块里。

**风险**：子集里泄露未选条目，是这一包唯一的高后果错误。由属性测试加专项评审把关。

**回滚**：回滚代码。已经导出的子集文件是标准的 v1 备份，旧版本也能导入。

**评审**：对 `subset.ts` 加属性测试做一次 **Opus 专项评审**（diff 很小）；界面部分做 Sonnet code-review。

### C7 H6 安全记录界面（等 A3 合入）

**目标**：
- 设置页增加安全状态卡（Z4）；
- 解锁之后在弹窗里提示一次"上次以来输错主密码 N 次"；
- 这一切都不碰"数据已恢复"横幅。

**范围**
- 新文件 `src/options/SecurityCard.tsx`：
  - 输错次数，以及最近的导出、改密码、轮换记录；
  - "本机存了什么"清单：
    - 是否还有设备密钥；
    - 快照数，用 `rt.store.snapshots()`；
    - 镜像状态，用 `rt.mirror?.keys()`；
    - 上次备份；
    - "网络请求：0（本版本不联网）"。
  - 一个"清空记录"按钮：调用 `rt.service.clearSecurityLog(password)`，必须先填主密码（旧设备密钥库没有密码可填），输错会被拒绝并记下。没有别的清空途径；查看卡片不会 ack。
  - 如实说明：这是告警线，不是证据；拿到配置文件副本的人可以改它。
- `src/options/Security.tsx`：插入安全卡，改动 1 行。
- 弹窗（所有者选定方案 1，见 `docs/audit/internal-reviews/A3-REVIEW.md` 的 "C7's open question"）：只在这个弹窗里解锁成功之后、首个验证码显示出来以后，由 `App.tsx` 的 `unlocked` 处理读一次 `rt.security.read()`（`src/popup/notice.ts`）；`Notices.tsx` 用 `role="status"` 显示提示，显示之后才 `ack(显示的数字)`。`Locked.tsx` 不传 `failedSince`。**打开弹窗的读取次数不变（4 / 6），解锁到首个验证码的读取次数也不变（7，门槛 8）。**

**测试**：`test/e2e/security-log.spec.ts`
- 连续输错 3 次密码之后正确解锁，弹窗提示"3 次"，并且没有出现"数据已恢复"横幅；
- 设置页的卡片显示同样的数字和最近的事件；
- 点"清零"之后变成 0。

**验收**：`npx playwright test test/e2e/security-log.spec.ts && npx vitest run test/unit/read-budget.test.ts && npm run verify`。读取门槛保持不变，只有一个写明理由的例外：`test/e2e/perf.spec.ts` 的 `READS.unlock.all` 从 9 提到 10（理由："one read of sk_security_log after the first code, only after an unlock, for the C7 notice"），`unlock.firstCode`（8）和打开的两个门槛（4、6）不变；`read-budget.test.ts` 为这一次读取单独加了用例（解锁之后正好多一次 `get(['sk_security_log'])`），没有它的用例仍是 7 和 10。

**预算**：+0.6 KB。

**回滚**：回滚代码。

**评审**：Sonnet code-review。

### C8 U1 错误文案重写

**目标**：任何界面都不再显示内部错误名（`TypeError`、`QuotaExceededError`、`bad_state` 等），一律改为"发生了什么 + 下一步怎么做"。

**范围**
- 新文件 `src/ui/errors.ts`：把错误码映射为 `{ what, next }`。
  - 未知错误显示通用文案："发生了意外错误。点重试；仍然失败的话，到 设置 › 高级 保存诊断信息"。
  - 原始的错误码写进本地诊断日志（`createDiagLogger`），这个日志只记错误类别。
- 弹窗：`Status.tsx` 的错误屏、`Locked.tsx` 的错误映射。
- 设置页：`src/options/shared.tsx` 的 `errText`。
- 文案：按 ux-study 的例子重写。原来的 `errorBody`（"Error: $1"）不再被引用，用 `REMOVE` 删除。

**测试**
- `test/unit/errors.test.ts`：对一组典型错误（`TypeError`、名为 `QuotaExceededError` 的 `DOMException`、`StorageError` 的各个 code、`BackupError`、普通对象、字符串），断言输出里不出现错误名或错误码，并且都有"下一步"。
- 迁移 e2e：现有断言里匹配 `/too weak|太弱/`、`/restored|恢复/` 的文本保持兼容；文本变了就在同一个补丁里迁移。

**验收**：`npx vitest run test/unit/errors.test.ts && npm run verify`

**预算**：+0.4 KB。

**回滚**：回滚代码。

**评审**：Sonnet code-review，加所有者通读文案。

### D 收尾（单个代理，所有包合入之后）

1. **`docs/security/local-vault.md`**：按合入后的真实代码更新。
   - 保护表里，"没有主密码"和"添加账户之后才设密码"两行只适用于旧库；
   - "Known gaps"的第一条已经解决；
   - 新增 H3、H4、H5、H6、H7、隐藏验证码、"记住此网站"的说明，各自写明限制；
   - 写入 U1b 的清理规则，以及"不再丢弃较新密钥下的快照"；
   - 扫描文本不再经过 `storage.session`。
2. **`docs/PRIVACY.md`**：补上新存的东西。
   - 安全记录：只在本机，只含时间与类型；
   - 登记的网站域名：在加密库里；
   - 读取本扩展自己的安装信息（H4）；
   - 外观设置。
   - 仍然写明"零网络"。
3. **`docs/history/PLAN-zh.md` §15**：写 Phase 0.x 的实施状态。可选：`docs/ARCHITECTURE.md` 补上新模块。
4. **交给 M2 的说明**（写进 `docs/history/PHASE0X-PLAN.md` 末尾，或者 M2 的任务说明里）。M2 必须知道这几件事：
   - `sk_keychange` 不变量（A2）；
   - `openView` 与 `openVault(vk, gen)`；
   - `prepareKeys`、`create(prepared)`；
   - `sk_security_log`、`settings.display`；
   - 读取门槛测试：M2 不得让它变红，需要多读时先改门槛并说明理由。
5. 跑一遍 §4 的全量验收，整理出所有者的人工检查清单。

**评审**：一个 Sonnet 子代理把文档里的每一句陈述对照代码核实。

---

## 3. 执行顺序与评审安排

### 3.1 三个实现者（推荐）

| 时段 | 实现者 1（道 B） | 实现者 2（道 A） | 实现者 3（道 C） | 集成者 / 评审 |
|---|---|---|---|---|
| T0 | R0 | A1-core（与 R0 并行，文件不重叠） | C1a 文档 | — |
| T1 | B1 | A1 UI 与 e2e 迁移 | C1b → C2 | 合入 R0；A1 做 Opus 评审后合入 |
| T2 | B2 | A2 | C3 → C8 | A2 做 Opus 评审后合入，**G-M2 满足** |
| T3 | B3 | A3 | C4 → C5（B1 已合入） | A3 做 Opus 评审后合入 |
| T4 | （空闲，或接 C7） | C6 | C7 | C6 的子集部分做 Opus 专项评审 |
| T5 | D | — | — | 全量验收 |

**变体**：如果 M2 迫在眉睫，T1 的实现者 1 改做 A2（它与 A1 改的是 `service.ts` 里不相交的方法，`service.test.ts` 的冲突段可以用三方合并解决），道 B 整体顺延一个时段。这样 G-M2 能提前大约一个时段。

### 3.2 两个实现者

- 实现者 1：A1-core（与 R0 并行）→ A1 → A2（G-M2）→ A3 → C6 → C7。
- 实现者 2：R0 → C1 → B1 → B2 → B3 → C2 → C3 → C8 → C4 → C5。
- 最后由任意一人做 D。

### 3.3 一个实现者

R0 → A1 → A2（G-M2）→ A3 → C1 → B1 → B2 → B3 → C2 → C3 → C8 → C4 → C5 → C6 → C7 → D。

C1a 是纯文档，可以随时插进任何一个空档。

### 3.4 什么时候用 Opus 独立评审，什么时候便宜检查就够

**Opus 独立评审**：新开上下文；输入 diff、本文对应小节和 SYNC-DESIGN 的 H 项原文；评审意见在合入前解决。

| 包 | 为什么 |
|---|---|
| A1 | 加密 / 服务层、首次运行的状态机，以及附录 A 测试迁移"没有放松"的逐条核对 |
| A2 | 存储层的清理时机、标记的崩溃安全、差分测试的覆盖面 |
| A3 | 服务层的接口，以及与 `sk_events` 的隔离 |
| C6 中的 `subset.ts` | 子集不得泄露未选条目，这是隐私性质 |

G-M2 之前还要再做一次 A1 加 A2 的合并复审：只看两者合入之后的 `service.ts`、`store.ts` 和交给 M2 的说明。

**便宜检查**：Sonnet 级 code-review，加上本包的 e2e，再由集成者看截图。适用于 R0、B1、B2、B3、C2、C3、C4、C5、C7、C8。C1 和 D 另加所有者阅读与事实核对。

**每个包都要做的机械检查**
- 补丁越界 grep（§0.3）；
- 文案生成器无报错；
- popup gz 数字；
- 权限白名单与 smoke 断言没有变化；
- check-dist 的网络绊线通过；
- `test/unit/read-budget.test.ts` 通过（A2 之后）。

---

## 4. 最终集成状态的验收清单

### 4.1 命令（在主树 `extension/` 下，M1 代理完成之后）

```bash
python3 scripts/messages.py                   # 合并分片无报错，中英键一致
npm run verify                                # typecheck + 单元/故障/回归 + build + check-dist + 全部 e2e
npx vitest run test/unit/read-budget.test.ts  # 打开 ≤4 次 / ≤1.5×；解锁 ≤8 次 / ≤3×；快照数 2 与 17 结果相同
npx vitest run test/unit/contrast.test.ts test/unit/backup-subset.test.ts test/unit/import-lines.test.ts
grep -n "PERMISSIONS_ALLOWED\|OPTIONAL_ALLOWED" scripts/check-dist.mjs   # 与 Phase 0 相同
```

逐项确认：
- check-dist 打印的 popup gz ≤ 60 KB。预计约 50 KB，区间 46–55，见附录 C。另外打印懒加载块的大小作为参考。
- e2e 里原有的 24 条（迁移后）加上新增的 spec 全部通过：firstrun、perf、perf-idle、list、site、add-popup、theme、presets、export、security-log。
- `test/fault/store.test.ts`、`test/regression/network.spec.ts`、`test/regression/offscreen-race.spec.ts`、`test/e2e/smoke.spec.ts` 与 Phase 0 时**逐字节相同**，用 `diff` 对比 R0 之前的快照。
- `test/regression/enable-crash.test.ts` 与 Phase 0 相比，只允许有 A1 的那一处改动：`world()` 里的 `svc.create()` 换成 `legacyDeviceVault`（附录 A）。A1 之后它就冻结了，A2 到 D 必须让它与 A1 合入后的快照逐字节相同，用 `diff` 对比 `$SNAP/before-A2/`。
- M1 区域的测试（`sync-crypto-*`、`contract-*`）照样全部通过：本阶段没有碰它们。

### 4.2 所有者人工检查

用真实的 Chrome，加载未打包的 `dist/` 生产构建。

1. **首次运行，中文、英文各走一遍。**
   - 欢迎页上已经没有"不设密码"。
   - 设置页向导：主密码 → 恢复码（复制、存为文件）→ 问题 → 完成。
   - 选"只有我用"：之后打开弹窗是解锁的。
   - 选"共享"：下次打开是锁定的，验证码被隐藏，出现了剪贴板引导。
2. **真实工具栏弹窗与当前网站。**
   - 已登记的域名显示"此网站"；
   - 只是名称像的网站显示"可能相关"；
   - "记住此网站"之后升为"此网站"；
   - 一个仿冒主机名的测试页（如 `github.com.<本机测试域>`）不会被标为"此网站"。
3. 在真实弹窗里"识别当前页面的二维码"（需要 activeTab）。
4. **快捷键** Alt+Shift+K 能打开弹窗，用快捷键打开时扫描本页也能用。快捷键冲突时，在 `chrome://extensions/shortcuts` 里可以改，设置页显示的绑定会随之变化。
5. 把系统剪贴板里的二维码截图粘贴进弹窗，确认页上点"添加并复制"之后，到网站上验证这个码可用。
6. **主题。**
   - 跟随系统、浅色、深色三种都切换一遍；
   - **在"系统深色 + 手动浅色"和反过来的组合下，打开弹窗时有没有闪烁**（CSP 禁止内联脚本，见 C4）；
   - 输入框边框清晰可见。
7. 紧凑密度的观感；隐藏验证码时屏幕上没有数字，空格能显示 5 秒，复制照常。
8. 系统里打开"减少动态效果"之后，圆环仍然正确显示剩余时间。
9. **导出。**
   - 不重输主密码就导出不了；
   - 子集导出之后导入另一个配置文件，只出现选中的账户；
   - 导入 `name|secret|password` 这样的行之后再导出明文列表，里面没有密码列的内容。
10. 连续输错主密码 3 次之后再解锁，提示"3 次"，没有"数据已恢复"；设置页的安全卡显示一致。
11. 未打包构建会显示安装来源横幅，Phase 2 之前这是预期的；核对横幅里显示的 ID。
12. **如果还有 Phase 0 留下的旧设备密钥库**：照常能打开，侧栏有警告，"开启主密码"照常可用。
13. **性能观感。**
    - 用 `scripts/bench/seed.mjs` 灌入 100 个和 500 个账户，在慢机或效率核上打开弹窗；
    - 跑一遍 `scripts/bench/bench.mjs warm|proccold`，与 ux-study 的表比较。这一项只作参考，不设门槛。
14. 去掉两个字重之后，中英文的字形与粗细是否可以接受。
15. （可选）在 Edge 和 Brave 上按 ux-study §2.4 的 10 步清单各走一遍。

---

## 5. 未决风险与给所有者的问题

### 5.1 风险（按影响排序）

1. **U1b 改变了清理密钥残留的时机。**
   - 如果漏掉一条会留下旧密钥材料的路径，就是安全回退：设备密钥残留不再被清掉。
   - 缓解：标记在提交之前写入；对升级前的状态做一次性完整扫描；`selfCheck` 兜底；enable-crash 与故障矩阵一行不改；差分测试；Opus 评审。
2. **在没有提交的仓库里用"副本 + 补丁"并行。**
   - 有人为出错的风险：补丁打错层级、合入漏文件、副本里混入 M1 改到一半的文件。
   - 缓解：每次合入前做快照、`--dry-run`、越界 grep；每次合入后跑全量 verify；一次只合一个包。
3. **M1 代理同时在改主树。**
   - 在它完成之前，主树可能过不了 typecheck，或者测试是红的，最终的全量验收要等它。
   - SYNC-DESIGN 也在被同时修改：每个包开工前先重读对应的 H 项。
4. **预算估计有 ±4 KB 的误差。**
   - O5 必须先做：没有 O5，估计值是 59–61 KB，会超出门槛。
   - B3 的确认页必须懒加载。
   - 只在设置页用到的文案也会进入全局目录、计入弹窗预算。如果还是紧张，下一步是按页面拆分文案目录。这一步本计划不做。
5. **H1 让测试明显变慢**（PBKDF2 600k 无法降低），估计慢 10–30 秒，未实测。另外，多实例的测试必须共享会话（附录 A）。
6. **测量方面的空白。**
   - 真实工具栏弹窗（activeTab）在 Playwright 里不一定能自动化，所以当前网站分级与扫描本页依赖人工检查。
   - O3 能省下多少闲置 CPU 只是估算；计时一律只告警。
7. **体验上的已知代价。**
   - 主题可能闪烁；
   - 去掉两个字重之后，部分文字变细；
   - 安装来源横幅在未打包构建上一直显示；
   - 隐藏验证码防不了读 DOM、读剪贴板或接调试端口的程序（文案如实写）；
   - H3 和 H6 都可以被 A10 绕过，安全记录也可以被拿到配置文件副本的人改掉（文案如实写）。
8. **Phase 1 的伏笔。** `domains` 在内容寄存器里，同步之后，"记住网站"和改名会互相覆盖（LWW）。交给 M3 记录。
9. **规模估计偏低。** SYNC-DESIGN 把 H1 记为 S，实际是 M。H1–H8 合计约 2 M + 6 S，U1 约 1 M + 6 S；整体估计的不确定性约为 ±50%。

### 5.2 给所有者的问题

**没有必须答复的问题。** 以下两项默认按推荐执行，所有者如果不同意，在对应的包开工前说一声即可。

1. **首次运行放在设置页的标签页里，不放在弹窗里**（A1）。
   - 推荐理由：弹窗一失焦就关闭，用户去存密码、存恢复码时，要么得到一个对不上任何库的恢复码，要么从来没看到恢复码；两种都会埋下日后丢数据的隐患。
   - 代价：与 ux-study 的弹窗示意图不同；"扫描本页"改由第 4 步的提示和弹窗空列表上的按钮承接。
   - 如果坚持放在弹窗里：A1 要另外加一个持久的"恢复码尚未确认"标记，以及打开时的补救流程。
2. **H8 的"链接到指南"在本阶段是应用内的摘要面板，加一个暂时为空的网址常量**（C1）。
   - 理由：Phase 0 零网络，网站也还不存在。Phase 2 网站上线后填上网址即可。

---

## 附录 A：H1 的测试迁移清单（逐条，评审对照用）

**新增辅助文件** `test/helpers/vaults.ts`：
- `STRONG`；
- `createProtected(svc, pw = STRONG)`，返回 `{ recoveryCode }`，内部是 `prepareKeys` 加 `create`；
- `legacyDeviceVault(store, entries?)`：只供测试用，直接用 `createKeyring`、`encryptVault` 和 `store.transact` 写一个旧的设备密钥库。

"不变"指断言一字不改；"更强"指 H1 让断言变得更严格。

**vitest：11 个文件**

| 文件 | 现状 | 迁移 | 断言 |
|---|---|---|---|
| `test/unit/service.test.ts`："a fresh vault without a master password"（6 处 create） | 设备库 | 改名为"新库必须先设主密码"；`createProtected`；"refuses over an existing vault"改为用第二个 prepared 再调 `create`，仍然报 `bad_state` | `passwordProtected: false` 改为 `true`，并新增"没有设备包裹，keyring 只有 password 与 recovery"。**更强** |
| 同文件："turning on the master password"（protectedWorld 与弱密码用例） | 测的是从设备库升级 | 改用 `legacyDeviceVault`，这条路径仍然存在 | 不变 |
| 同文件："password changes and key rotation" | create 之后再 enable | 保留旧路径（`legacyDeviceVault` 加 enable），所以"3 个 previous（设备时期的 VK 加两次轮换）"不变；另外新增一条：原生密码库轮换两次之后 previous 为 2 | 不变，另有新增 |
| 同文件："auto-lock"（3 处）、"recovery is visible…"（1 处）、"lock every time"（2 处） | create 之后再 enable（"recovery is visible…"是设备库） | 改为 `createProtected` | 不变 |
| 同文件："a crash right after turning on the password" | 旧路径 | `legacyDeviceVault` | 不变 |
| `test/unit/import-backup.test.ts`（2 处 create、4 处 restoreBackup） | 恢复出来的是设备库 | `restoreBackup(backupVault(), await svc.prepareKeys(STRONG, { vaultId: "backup-vault-id-1" }))` | `passwordProtected: false` 改为 `true`，并新增"无设备包裹"。**更强** |
| `test/unit/platform.test.ts`（1 处） | 设备库 | `createProtected`。会话存在另一个独立的 fake area 里，主库清空之后仍然是解锁的 | 不变 |
| `test/unit/keyring.test.ts` | — | 只有在 `keyring.ts` 新增了 `createProtectedKeyring` 时才改：为它加测试（无 `deviceKey`、包裹种类、恢复码可用、AAD 绑定）。按首选做法在 service 里组装时，这些断言放进 service.test 的新用例里 | 新增 |
| `test/regression/enable-crash.test.ts`（2 处） | 测的是 enable 的崩溃安全 | `world()` 改用 `legacyDeviceVault` | **不变** |
| `test/regression/write-read-mismatch.test.ts`（2 处） | 设备库 | `createProtected`，原本就共享会话 | 不变 |
| `test/regression/purge.test.ts`（1 处） | 用 `unlockWithDevice` 取 VK | `createProtected`；改用 `unlockWithPassword(keyring, STRONG)` 取 VK | 不变 |
| `test/regression/store-misc.test.ts`：首次运行竞争（1 处） | `restoreBackup(b)` 与 `create()` 竞争 | 两个 prepared 竞争；工厂函数改为共享 `MemorySession` | 不变 |
| `test/regression/session.test.ts`（1 处） | create 之后再 enable | `createProtected(first)` | 不变 |
| `test/regression/clock.test.ts`（1 处） | 设备库，`make()` 每次新建会话 | `createProtected`；工厂改为共享会话 | 不变 |
| `test/regression/merge.test.ts`（1 处 restoreBackup） | 设备库，`make()` 每次新建会话 | prepared 用 `a.vaultId`；工厂改为共享会话（否则后面的实例会被锁住） | 不变 |

**e2e：4 个文件**

| 文件 / 用例 | 迁移 |
|---|---|
| `test/e2e/harness.ts` | `startFresh(p, { risk?: "solo" \| "shared" })` 走新向导，返回 `{ recoveryCode }`。新增 `seedLegacyDeviceVault(p, uris)`：在 Node 里用 core 代码造出 generation，再从扩展页面执行 `chrome.storage.local.set` 写进去。 |
| `flows.spec.ts`："master password: turn on, lock, unlock, survive a browser restart…" | 改用 `seedLegacyDeviceVault`（旧设备库的升级路径），其余步骤与断言不变。另外新增"新安装：先设密码，存储里从无 deviceKey，重启后是锁定状态，恢复码能解锁"。 |
| `flows.spec.ts`："lock every time…" | 去掉开启主密码的那一段（库已经受保护），其余不变。 |
| `flows.spec.ts`："resetting the password from the popup…" | 恢复码改用 `startFresh` 的返回值，去掉开启那一段，其余不变。 |
| `flows.spec.ts`："encrypted backup restores a fresh install" | 新配置文件那一侧改走向导的 restore 模式（导出那一侧在 C6 补上重输密码）。断言"2 行、验证码正确"不变。 |
| `flows.spec.ts`："language: follows the browser…" | 断言的按钮文字改为新的欢迎页按钮（中英各一）。 |
| `flows.spec.ts` 里其余 10 个用 `startFresh` 的用例 | 不改，由新的 harness 承接。其中"a backup holds what was added…"的导出步骤由 C6 补上重输密码。 |
| `regression/residue.spec.ts` 用例 1 | 改走 `startFresh`（设密码在添加账户之前），`attack()` 结果为空、密钥不在磁盘上，这些断言不变。 |
| `regression/residue.spec.ts` 用例 2 | 改用 `seedLegacyDeviceVault` 加一个账户，`#residue-warning` 可见，断言不变。 |
| `regression/residue.spec.ts` 新增用例 3 | 在新配置文件里从备份恢复，扫描配置文件目录，不得出现明文种子、`"deviceKey"` 或设备包裹（H1 的验收）。 |
| `regression/ui-misc.spec.ts`、`import-rollback.spec.ts` | 不改，由新的 harness 承接。 |
| `regression/network.spec.ts`、`offscreen-race.spec.ts` | 已核对：都不建库。前者在空库（欢迎页）状态下打开两个页面，后者只向 SW 发消息。**不改。** |

---

## 附录 B：文件归属总表（R0 之后的文件名）

文件按道分组。"顺序"一栏写的是多个包修改同一个文件时的合入顺序。

| 文件 | 改动的包（按顺序） | 规则 |
|---|---|---|
| `src/core/crypto/keyring.ts` | （首选不改）A1 | 若改，只在末尾新增函数 |
| `src/core/service/service.ts` | A1 → A2 → A3 | 道 A 顺序修改；之后 M2 |
| `src/core/service/types.ts` | R0 → A2 | 设置字段只在 R0 里加 |
| `src/core/service/presets.ts`、`security-log.ts` | R0；A3 | 独占 |
| `src/core/storage/store.ts`、`format.ts` | A2 | 独占（之后 M2） |
| `src/core/backup/subset.ts` | C6 | 新文件 |
| `src/core/import/importer.ts` | C2 | 独占 |
| `src/core/import/dedupe.ts` | B3 | 新文件 |
| `src/core/match.ts`、`site-domains.ts` | B2 | 独占 |
| `src/core/install-source.ts`、`src/platform/install-source.ts` | C3 | 新文件 |
| `src/platform/runtime.ts` | A2 → A3 | 顺序 |
| `src/ui/i18n.ts`、`icons.tsx` | R0 | 之后冻结 |
| `src/ui/hooks.ts`、`art.tsx` | B1 | 独占 |
| `src/ui/styles.css` | B1（`.ring` 段）、C4（token 与暗色组件规则） | 不相交的段；B1 先 |
| `src/ui/theme.ts`、`errors.ts` | C4；C8 | 新文件 |
| `src/popup/App.tsx` | R0 → A2 → C7 | 小段，三方合并 |
| `src/popup/load.ts` | R0 → A2 | 顺序 |
| `src/popup/chrome.tsx` | R0 → C3 | 插槽 |
| `src/popup/screens/Welcome.tsx` | R0 → A1 | 顺序 |
| `src/popup/screens/Status.tsx` | R0 → C8 | 顺序 |
| `src/popup/screens/Locked.tsx` | R0 → A2 → C8 → C7 | 小段，按此顺序合入 |
| `src/popup/main/Main.tsx`、`List.tsx` | R0 → B1 → B2 → B3 | 道 B 顺序 |
| `src/popup/main/model.ts` | R0 → B1 → B2 | 顺序 |
| `src/popup/main/Notices.tsx` | R0 → C3 → C7 | 插槽 |
| `src/popup/main/EditDialog.tsx` | R0 → B2 | 顺序 |
| `src/popup/main/AddMenu.tsx`、`AddConfirm.tsx`、`scan.ts`、`src/lib/qr.ts` | B3 | 独占 |
| `src/popup/popup.css` | B1 → B2 →（C4 只改两个暗色块） | 不相交的段 |
| `src/popup/index.html`、`src/options/index.html` | C4 | 独占 |
| `src/popup/main.tsx`、`src/options/main.tsx` | R0 → C4 | 顺序 |
| `src/options/App.tsx` | R0 → A1 → C1b → C3 → C4 | 小段，三方合并；`SECTIONS` 只由道 C 顺序添加 |
| `src/options/Rail.tsx` | R0 → A1 | 顺序 |
| `src/options/FirstRun.tsx`、`Guide.tsx`、`Appearance.tsx`、`SecurityMode.tsx`、`SecurityCard.tsx` | A1；C1b；C4；C5；C7 | 新文件，各配自己的 CSS |
| `src/options/Security.tsx` | C5 → C7 | 各改 1–2 行 |
| `src/options/Backup.tsx` | A1 → C6 | 顺序 |
| `src/options/Misc.tsx` | A1 | 独占 |
| `src/options/AddAccounts.tsx` | C2 | 独占（只改 Preview） |
| `src/options/shared.tsx` | C8 | 独占 |
| `src/options/options.css` | C4（只改暗色块） | 新界面不改这个文件 |
| `manifest.base.json` | B2 | 独占 |
| `scripts/build.mjs` | R0 → C3 | 顺序 |
| `scripts/check-dist.mjs` | R0 → C3 → C4 | 不相交的规则段 |
| `scripts/messages.py`、`scripts/i18n/base.py` | R0 | 之后冻结；各包只加自己的分片 |
| `scripts/bench/**` | A2 | 新目录 |
| `test/e2e/harness.ts` | A1 | 之后冻结；新的辅助函数放新文件 |
| `test/e2e/flows.spec.ts` | A1 → C6 | 顺序 |
| `test/unit/service.test.ts` | A1 → A2 → A3 | 道 A 顺序 |
| `test/unit/i18n-lang.test.ts` | R0 | 独占 |
| `docs/guides/FINGERPRINT-BROWSERS.md` | C1a | 新文件 |
| `docs/PRIVACY.md`、`docs/security/local-vault.md` | C1a（三处今天就成立的更正）→ D | 顺序 |
| `docs/history/PLAN-zh.md` §15 | D | 独占 |

**本阶段一律不碰**：`src/core/sync/**`、`src/core/crypto/{envelope,kdf,recovery-code,vk,bytes}.ts`、`src/core/vault/**`、`src/background/sw.ts`、`src/offscreen/**`、`contract/**`、`api/**`、`docs/SYNC-DESIGN.md`，以及所有 M1 测试与辅助文件。`sw.ts` 不用改：`_execute_action` 不需要监听器。

---

## 附录 C：弹窗预算估计（gz KB，按 check-dist 的口径）

| 阶段 | 增量 | 累计 | 主要来源 / 说明 |
|---|---|---|---|
| 现在 | — | 46.3 | 实测：入口 7.1 + 共享块 33.5（含中英目录约 9.6）+ CSS 6.8 |
| R0 | −4.2 | 42.1 | 两份目录移出静态图，计入较大的中文目录 5.3 |
| A1 / A2 / A3 | +0.6 / +0.2 / +0.4 | 43.3 | 文案；服务层代码在共享块里 |
| B1 / B2 / B3 | +1.0 / +1.0 / +1.0 | 46.3 | CSS keyframes 与紧凑模式；分级；粘贴入口（确认页 6–8 KB 懒加载，不计入） |
| C1 / C2 / C3 / C4 | +0.4 / +0.2 / +0.5 / +0.9 | 48.3 | 文案；横幅；第二份暗色 token |
| C5 / C6 / C7 / C8 | +0.3 / +0.3 / +0.6 / +0.4 | **≈ 49.9** | 文案为主 |

- 区间约 46–55 KB。最大的不确定性是新增文案的长度。现有目录平均每个键每种语言约 20 B gz；新文案多为说明性文字，按每键 25–30 B 估算，总共约 110 个新键。
- **如果没有 O5**，同样这些改动估计会到 59–61 KB，越过门槛。

**实测**（D 包整理；各数字来自对应评审文件或 D 包自己的构建，口径同 check-dist）

| 节点 | popup gz | 来源 |
|---|---|---|
| A1 之前 → A1 | 42.8 → 43.6（+0.8，估计 +0.6） | `docs/audit/internal-reviews/A1-REVIEW.md` |
| A2（在它自己的基线上） | 50.4 → 51.4（+1.0，估计 +0.2） | `docs/audit/internal-reviews/A2-REVIEW.md` |
| A1 + A2 + FIXa2 + FIXb 合并后 | 54.4（静态 45.6 + zh_CN 8.9） | `docs/audit/internal-reviews/GM2-REVIEW.md` |
| A3 | 54.4 → 55.5（+1.1，估计 +0.4） | `docs/audit/internal-reviews/A3-REVIEW.md` A3-7 |
| C6（在 A4 之前的主树上） | 55.6 → 55.9（+0.3，估计 +0.3） | `docs/audit/internal-reviews/C6-REVIEW.md` |
| A4 | 56.3（静态 47.4 + zh_CN 8.9） | `docs/audit/internal-reviews/A4-REVIEW.md` |
| A4 + C6 合入后（C7 之前的快照） | 56.2（静态 46.9 + zh_CN 9.3） | D 包构建 `…/scratchpad/phase0x/snap/before-C7` |
| **C7** | 56.2 → 57.4（**+1.2**，即 57,580 → 58,751 B：静态 +353 B，中文目录 +818 B；估计 +0.6） | D 包构建 |
| D 之后（最终） | **57.4**（静态 47.3 + zh_CN 10.1） | D 包的 `npm run verify` |

最终比估计的 49.9 KB 多 7.5 KB，主要来自文案（中文目录从 R0 估计的 5.3 KB 涨到 10.1 KB）和服务层代码进入共享块（A2、A3）。处理建议见附录 E.4。

---

## 附录 D：e2e 稳定选择器（改动的包必须在同一补丁里迁移测试）

**弹窗**
- class：`.row`、`.row .code`、`.row .more`、`.who b`、`.glabel`、`.toast`、`.clip`、`.code-box`
- id：`#q`、`#secret`、`#next`、`#lang-toggle`、`#e-issuer`、`#e-label`、`#e-group`
- 按钮名称：Save / 保存、Delete / 删除、Click again / 再点一次、Lock / 锁定、Unlock / 解锁、Use recovery code / 使用恢复码、Set a new password / 设置新密码、Reset and unlock / 重设并解锁、Got it / 知道了

**设置页**
- 添加：`#paste-box`、`#add-confirm`、`#add-done`、`#preview`、`#qr-file`、`#m-issuer`、`#m-label`、`#m-secret`、`#manual-add`、`#add-manual`
- 备份：`#backup-pw`、`#backup-pw2`、`#export-encrypted`、`#plain-ok`、`#export-plain`、`#backup-file`、`#open-pw`、`#apply-backup`、`#backup-msg`、`#backup-error`
- 自动锁定与解锁：`#al-mode`、`#unlock-pw`、`#unlock-btn`
- 开启主密码（旧库路径）：`#enable-pw`、`#enable-pw2`、`#enable-password`、`#enable-strength`
- 恢复码：`#recovery-code`、`#recovery-saved`、`#recovery-done`
- 其他：`#residue-warning`、`#trash`、`#trash-clear-old`、`#lang-select`
- 分区 id：`#security`、`#add`、`#backup`

**还要注意**
- `getByRole("alert")` 的计数断言很多：新的常驻横幅一律用 `role="status"`（C3、C7）。
- "数据已恢复"横幅保持 `role="alert"`。

**Phase 0.x 合入后的增减**（D 包整理：测试里实际用到、并且源码里确有的 id；`PasswordFields` 按前缀生成 `<前缀>-pw`、`<前缀>-pw2`、`<前缀>-strength`）
- **已删除**：弹窗的 `#next`，以及按钮"Reset and unlock / 重设并解锁"（A4：弹窗不再重设）。
- **弹窗新增**
  - 欢迎页：`#start-secure`、`#start-restore`
  - 列表：`#empty-paste`、`#empty-scan`、`#install-banner`、`#sec-notice`；class `.row .copy`、`.code.hid`、`.sect.site`、`.remember`
  - 编辑：`#e-site`
  - 确认页：`#pa-box`、`#pa-add`、`#pa-add-copy`、`#pa-copy`、`#pa-back`、`#pa-issuer`、`#pa-label`、`#pa-keep`、`#pa-replace`、`#pa-site`、`#pa-verdict`、`#pa-list`、`#pa-settings`
  - 锁屏：`#forgot-password`（打开设置页 `#reset`）
  - 按钮名称"Set a new password / 设置新密码"保留，现在打开设置页标签页
- **设置页新增**
  - 首次运行：`#fr-pw`、`#fr-pw2`、`#fr-strength`、`#fr-next`、`#fr-solo`、`#fr-shared`、`#fr-finish`、`#fr-cancel`、`#fr-changed`、`#fr-code-note`、`#fr-hint`、`#fr-clip`、`#fr-clip-enable`、`#fr-clip-next`、`#fr-clip-state`、`#fr-backup-file`、`#fr-open-pw`、`#fr-restore-next`、`#fr-backup-error`；侧栏 `#rail-set-password`
  - 安全模式：`#security-mode`、`#sm-standard`、`#sm-shared`、`#sm-custom`、`#sm-hide`、`#sm-locked`、`#sm-export`、`#al-minutes`、`#al-screen`
  - 安全记录：`#security-log`、`#sec-log-count`、`#sec-log-list`、`#sec-log-bad`、`#sec-log-clear`、`#sec-log-pw`、`#sec-log-confirm`、`#security-stored`
  - 重设：`#reset`（分区）、`#reset-code-in`、`#reset-pw`、`#reset-pw2`、`#reset-next`、`#reset-note`、`#reset-done`
  - 新恢复码：`#code-pw`、`#new-code`
  - 导出：`#export-pw`、`#export-nopw`、`#subset`、`#sub-list`、`#sub-count`、`#sub-preview`、`#subset-pw`、`#subset-pw2`、`#subset-same`、`#export-subset`
  - 纯文本行：`#lines`、`#lines-key`、`#lines-name`、`#lines-note`
  - 外观：`#appearance`、`#look-theme-auto`、`#look-theme-light`、`#look-theme-dark`、`#look-density-standard`、`#look-density-compact`、`#look-sort-manual`、`#look-sort-name`、`#look-hide`、`#look-shortcut`、`#look-shortcut-edit`
  - 安装来源：`#install`、`#install-id`、`#install-store-id`
  - 其他：`#guide`、`#advanced`、`#so-confirm`、`#so-go`
  - 弹窗用来打开设置页的地址 hash：`#setup`（也是向导的元素 id）、`#setup-restore`、`#reset`、`#security-log`、`#install`、`#add-<方式>`（如 `#add-paste`）；`#add-scanned` 只剩 `firstrun.spec.ts` 在用（见附录 E）

---

## 附录 E：实际建成（D 包记录，2026-10-16）

本附录记录合入后的真实状态与计划的差异，供评审与 M2 对照。逐包的内容见 `docs/history/PLAN-zh.md` §15；M2 需要知道的见 `docs/history/M2-HANDOFF.md`。

### E.1 验收结果（§4.1，D 包在主树上实测）

2026-10-16 至 17 日，主树 `extension/`，D 包的文档改动和两行代码改动都已在内：
- `python3 scripts/messages.py`：419 条文案，13 个分片，无报错；重新生成的 `_locales` 与 D 之前的快照逐字节相同。
- `npm run verify`：退出码 0。
  - 类型检查通过；
  - vitest 63 个文件，1090 条通过、1 条跳过；
  - build 与 check-dist 通过："popup gzip: 57.4 KB (budget 60 KB) = static 47.3 KB + largest catalog zh_CN 10.1 KB"；
  - Playwright 97 条通过（6.3 分钟）。
- `npx vitest run test/unit/read-budget.test.ts test/unit/contrast.test.ts test/unit/backup-subset.test.ts test/unit/import-lines.test.ts`：4 个文件，76 条通过。
- `perf.spec.ts` 的读取次数（硬门槛）：打开到首个验证码 4 次、总共 6 次；重启后解锁，锁屏 3 次，到首个验证码 7 次，总共 10 次。
  - 计时（只告警）：热态首个验证码 45.3 ms（预算 75 ms）；冷态提交密码到首个验证码减去 PBKDF2 为 21.6 ms（预算 80 ms）。
  - 闲置 CPU：5.5 ms/s（告警线 20）。
- 权限白名单与 `BUDGET_GZ`：与 R0 之前逐字节相同。`scripts/check-dist.mjs` 本身 D 包没有改。
- 预期 e2e 数（§4.1"原有 24 条加新增 spec"）：现在 97 条，新增的 spec 全在。
- §4.1 的"逐字节相同"要求见下面 E.2 的最后两条。

### E.2 计划外的包与范围变化

- **A4（G-M2 闸门修复）不在 §2 里。** 它按 `docs/audit/internal-reviews/GM2-REVIEW.md` 的"M2 开始前"清单与 `docs/audit/internal-reviews/A4-REVIEW.md` 的合入前修复，改了 `service.ts`、`store.ts` 与十几个已有测试文件（多数只是机械改动，见下），新增 `src/options/Reset.tsx`、`scripts/i18n/a4.py` 和 4 个测试文件（E.3）。
  - 忘记密码的重设从弹窗移到设置页标签页（`#reset`），先显示新恢复码、确认已保存之后才写入；一步完成的 `resetPasswordWithRecovery` 已删除。
  - `CodeDelivery`（`onCode`）是必填参数；`newRecoveryCode` 需要主密码（C6-1）。
  - 清理只有一个入口 `finishKeyChanges`；`StoreOptions.lock` 必填。
- **H4 自检只在生产构建里开启。** §2 C3 原文是"prod 与 e2e 为 true"，实际 e2e 构建关闭（`scripts/build.mjs:14-17`），由 `test/e2e/install-source.spec.ts` 加载生产 `dist/` 断言横幅。所以人工检查要用 `npm run build` 的产物。
- **B1 的圆环没有用 CSS 动画**，改为对齐秒边界、每秒用 JS 重绘一次。减少动态效果时也是同一种画法，不需要第二条代码路径（`src/ui/art.tsx` 的 `Ring`、`test/unit/list-codes.test.ts`）。这一项需要所有者认可，列在 `docs/OWNER-CHECKLIST.md` 第 7 项。
- **B2 的中文 issuer**：规范化保留 Unicode 字母（"阿里云"不再被清成空串），但主机名是 ASCII，名称猜测只比较 ASCII 部分。中文名称靠搜索找到，登记域名之后才标"此网站"（`src/core/match.ts` 头注释）。
- **安全记录的种类比 §2 A3 多三种**：`recovery_used`、`password_enabled`、`log_cleared`。`ack(seen)` 按所示数字扣减（A3-2）。清空只能经 `clearSecurityLog(password)`（A3-1），页面只拿到读接口。
- **C7 的读取例外**：`perf.spec.ts` 的 `READS.unlock.all` 从 9 提到 10，单元门槛不变（§2 C7 已写明）。
- **新恢复码也受 H3 约束**：C6-1 之后"生成新的恢复码"需要主密码，这条不在 §2 C6 原文里。
- **集成者记录的偏差**
  - `src/options/SecurityMode.tsx` 是 C5 的独占文件，C6 在里面加了两行（`#sm-export`，"每次导出都要重新输入主密码"；C6-10）。
  - `test/e2e/flows.spec.ts` 按附录 B 只归 A1 → C6，实际改动它的有三处：
    - A1：附录 A 的迁移；
    - B3 与 C4/C5 两个快照之间：两处 `.row .more` 的点击去掉 `force`，这是 `content-visibility` 下的时序修正；
    - A4 与 C6 一起合入时：三处 `confirmExport`（C6）；删除了"resetting the password from the popup also needs a strong one"，那条断言（弱密码被拒）移到 `test/e2e/reset.spec.ts`（A4）。
  - `src/options/Rail.tsx`（R0 → A1）：D 包把语言菜单里的"中文"改为"简体中文"（ux-study §2.12 P1）。弹窗的语言按钮（`src/popup/chrome.tsx`）仍显示"中文"：`test/e2e/firstrun.spec.ts:31` 按 `/中文|EN/` 断言，改成"简体中文"还要看弹窗宽度下的标题栏截图，D 包没有改。
  - `test/e2e/list-helpers.ts`：D 包把"设置页还没有这些控件"的过时注释改为现状。
- **§4.1 的"逐字节相同"没有字面成立**（对比 `…/scratchpad/r0/baseline/extension` 与 `…/scratchpad/phase0x/snap/before-A2/extension`）：
  - 仍逐字节相同：`test/regression/network.spec.ts`、`test/regression/offscreen-race.spec.ts`、`test/e2e/smoke.spec.ts`（与 R0 之前相同）。
  - `test/fault/store.test.ts`：只多了 `lock: createMutex()` 与对应的 import（GM2-11 让 `lock` 必填）。断言未变。
  - `test/regression/enable-crash.test.ts`：除 `lock: createMutex()` 外，`enableMasterPassword(STRONG)` 改为 `enableMasterPassword(STRONG, NO_PAGE)`，取码改为 `codeOf(...)`（A4R-5 让 `onCode` 必填）。断言未变。
- **因 `lock` 必填而机械改动的测试**（去掉 `lock: createMutex()` 与 import 之后，与 A4 之前逐字节相同）：`test/fault/store.test.ts`、`test/regression/{clock,create-crash,merge,purge,session,store-misc,write-read-mismatch}.test.ts`、`test/unit/import-backup.test.ts`。另有 `test/regression/enable-crash.test.ts`、`test/fault/open-view-diff.test.ts`、`test/unit/read-budget.test.ts` 还多了必填的 `onCode` 参数（`NO_PAGE`）。实质性修改的是 `keychange-marker`、`security-log-crash`、`a2-review`、`service.test`、`flows.spec` 与 `test/helpers/vaults.ts`，评审见 `docs/audit/internal-reviews/A4-REVIEW.md` (5)。

### E.3 附录 B 之外的新文件

| 文件 | 包 |
|---|---|
| `scripts/store-id.mjs` | C3（商店 ID 常量，现在为空） |
| `scripts/i18n/a4.py` | A4 |
| `src/options/Reset.tsx` | A4 |
| `src/options/settings-store.ts` | C4/C5（各面板共用一份设置记录） |
| `src/options/SubsetPicker.tsx`、`export.css` | C6 |
| `src/options/InstallNotice.tsx`、`install.css` | C3 |
| `src/options/appearance.css`、`guide.css`、`lines.css`、`securitycard.css`、`securitymode.css`、`firstrun.css` | 各自组件的 CSS（§0.5） |
| `src/popup/main/Remember.tsx`、`site.css` | B2 |
| `src/popup/main/add.css` | B3 |
| `src/popup/notice.ts` | C7 |
| `test/e2e/errors.spec.ts`、`guide.spec.ts`、`import-lines.spec.ts`、`install-source.spec.ts` | C8、C1b、C2、C3 |
| `test/e2e/export-selection.spec.ts`、`test/unit/backup-subset-fuzz.test.ts`、`test/unit/export-gate.test.ts` | C6（含评审 C6-3 的测试） |
| `test/e2e/reset.spec.ts`、`test/fault/gm2-crash-matrix.test.ts`、`test/regression/gm2-fixes.test.ts`、`test/unit/source-rules.test.ts` | A4 |
| `test/regression/a2-review.test.ts` | A2（评审的复现转成回归测试） |
| `test/fault/security-log-crash.test.ts` | A3 |
| `test/e2e/security-helpers.ts`、`test/unit/security-notice.test.ts` | C7 |
| `test/unit/list-codes.test.ts`、`test/unit/list-order.test.ts` | B1 |
| `test/unit/settings-store.test.ts` | C4/C5 |

### E.4 弹窗预算的结论

D 包请一个子代理在私有副本里测量（脚本、原始数据与各个变体都在 `…/scratchpad/phase0x/D/budget/`）。**结论：D 包不改 `scripts/check-dist.mjs`，`BUDGET_GZ` 仍是 60 KB。**

**现状**
- 57.4 KB gz（58,751 B），门槛 60 KB，余量 2,689 B。
- 计入的文件（gz）：入口脚本 11,553 B，共享块 28,759 B，两个 CSS 3,375 + 4,432 B，`theme-boot.js` 283 B，中文目录 10,349 B（英文 9,101 B）。
- 用 sourcemap 归因（各项不可相加）：
  - `src/core` 17.4 KB，其中 `store.ts` 4.2、`service.ts` 3.3；
  - `src/popup` 9.1 KB，`src/ui` 4.9 KB，`src/platform` 1.4 KB，Preact 5.2 KB；
  - CSS 7.8 KB，文案目录 10.1 KB。
- 弹窗代码只用到 419 个文案键中的 170 个。
- 弹窗用不到的服务层方法占 1.8 KB：类方法无法摇树。
- 安全记录相关约 1.1 KB，换密钥清理约 1.25–1.5 KB。zxcvbn 与二维码库都不在计入的部分里。

**提高门槛的代价**（实测）
- 做法：变体把约 23 KB gz 的真实设置页代码静态打进弹窗，并在加载时执行顶层代码（check-dist 读数 80.3 KB）。
- 端到端：100 个账户，`perf.spec.ts` 每个构建 20 轮，CDP 基准的 warm、proccold、4 倍降速、重启、删除代码缓存各 12–45 次。所有场景的中位数变化都在置信区间与同构建（A/A）噪声之内；最宽的上界是 4 倍降速 proccold 的 +14.7 ms。
- 读取次数完全相同。
- V8 跟踪（无代码缓存，各 8 次）：
  - 后台解析 +1.15 ms，不在主线程上；
  - 主线程 1 倍速 +0.2 ms，4 倍降速 +1.8 ms。
  - 在真正的慢机上，后台编译可能落到关键路径上，上界估计每 23 KB gz 约 6–7 ms，即每 KB gz 约 0.3 ms。
- 这只量了"带着不执行"的代码。M6 在打开时真正执行的代码，另有它自己的运行时间，与门槛无关。

**不提高门槛的办法**
- **(a) 弹窗专用文案目录**：原型已做，57.4 → 51.2 KB，省 6.2 KB，余量变成 8.8 KB。
  - 私有副本里单元测试全过（缺 `contract/` 的 8 个文件除外），e2e 97 条全过，`perf.spec.ts` 的读取门槛不变，也没有多出任何加载（子代理的报告）。
  - 前提：键必须在构建时从语法树里收集，用正则扫描会漏键（原型第一次漏了 15 个，3 条 e2e 显示出键名）；另加"缺键"兜底测试；check-dist 仍然打印并单独限制完整目录的大小，以免文案增长从统计里消失。
  - 改动范围是 R0 之后冻结的 `scripts/messages.py`、`src/ui/i18n.ts`、`scripts/build.mjs`、`scripts/check-dist.mjs`，所以要单独成包，不能在 D 里做。
- **(b) 把安全记录推迟加载**：最多约 0.8 KB。输错密码的路径会多一次加载，加载失败时这次输错就记不下来。不值得。
- **(c) 把换密钥清理推迟加载**：最多约 1.25 KB，还会被分块重排吃掉一部分。它保护数据正确性，风险中等。不建议。

**M6 的需要**
- SYNC-DESIGN §6 把入网、批准、吊销放在设置页，弹窗只有 P1–P5（同步状态、锁屏一行、欢迎页选项、横幅、HOTP 离线提示）。
- 但是加在 `VaultStore` / `VaultService` 上的同步方法，不论弹窗调不调用都会计入（与上面的 1.8 KB 同理），提交时写 outbox 的代码也在弹窗路径上。
- 实测下限：
  - outbox 加密 +1.1 KB；
  - 用同步 keyring 解锁、写 outbox、签名请求 +4.7 KB；
  - 整个 `src/core/sync/crypto` +11.0 KB；
  - 新文案约 0.5–1 KB（估计）。
- M2、M3、M5 的代码还不存在，其余未知。

**推荐**
- M6 动弹窗之前，先做一个小包实现 (a)，门槛保持 60 KB。
- 做完 (a) 之后，M6 仍然需要超过 8.8 KB 时，再把门槛提到约 70 KB，并在同一补丁里引用上面的代价（每 KB gz 约 0.3 ms 的上界）。
- 产品层面的权威是 PLAN §13 的"popup 主包 <200KB"。它没写单位：同一组文件压缩前约 174 KB，按压缩前算已用掉 87%。这一点需要所有者确认。

### E.5 弹窗专用文案目录（CATALOG 包，2026-10-17，E.4 的 (a)）

**做了什么**
- 设置页加载完整目录（`src/ui/catalog-full.ts`，`assets/locale-<语言>-*.js`）。
- 弹窗只加载它能用到的键（`virtual:popup-catalog/<语言>`，`assets/popup-locale-<语言>-*.js`）。这份目录在每次构建时由 `scripts/build.mjs` 从 `_locales` 现切出来，从不缓存，也不进仓库。
- `src/ui/i18n.ts` 自己不再 import 任何目录。`loadCatalog(source)` 由各页面传入自己的来源，所以页面只能加载它入口里写明的目录。
- `scripts/messages.py`、各分片和 `_locales` 都没有改。

**键怎样收集**（`scripts/catalog-keys.mjs`，用 TypeScript 的语法树和类型检查器）
- 模块：从 `src/popup/index.html` 出发，沿静态 import、re-export 和 `import()`（懒加载块）走遍所有模块；只跳过 `import type`。
- 兜底：这些模块里凡是以字面量出现的键都保留，包括字符串、模板文字、JSX 文本、对象属性名、枚举成员。
- 追踪：从目录的每一次读取（`catalog[key]`，也就是 `t()`）往回追，经过参数和全部调用处（含 JSX 属性）、常量、表、解构、条件、函数返回值和 `.map` 回调等。
  - 模板字符串或 `+` 拼接：保留整族，`${…}` 匹配任意键字符。
  - 追不下去的值（来自存储、消息、库、字符串方法，或者函数被当作值传走）：构建失败。只有在 `POPUP_ALLOW` 里写明这个表达式能取哪些键或哪几族之后才放行；用不到的条目也会让构建失败。

**检查**
- 构建时：
  - 打包器给出的弹窗模块图必须全部被收集器读过，并且不含完整目录；
  - 弹窗能加载的每个块，代码里加引号出现的键都必须在弹窗目录里；
  - 每种语言都要有一份弹窗目录。
- `check-dist`：
  - 从 `popup/index.html` 出发，按文件名找出弹窗能加载的所有块，把其中最大的目录计入 60 KB 预算；
  - 弹窗能加载到完整目录就失败；
  - 各语言的弹窗目录键必须相同，文字必须与完整目录逐字相同；
  - 完整目录另设上限 12 KB gz（所有者可调）。
- e2e 构建：`t()` 遇到没有文字的键会报到控制台，`test/e2e/harness.ts` 的 `close()` 据此让测试失败；`test/e2e/popup-text.spec.ts` 用中英两种语言走遍弹窗各屏。

**以后的包怎样加文案**
- 和以前一样：在自己的分片里加键，运行 `python3 scripts/messages.py`，在代码里写 `t("键")`。
- 键会自动进入弹窗目录。键名只能由代码动态拼出、又追不到字面量时，构建会报出具体位置，届时改写成字面量或表，或者在 `POPUP_ALLOW` 写明。
