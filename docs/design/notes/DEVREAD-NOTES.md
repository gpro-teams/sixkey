# 开发版的插件名单：在开发版里测试读取类和修改类插件（OWNER-DECISIONS/19 问题 1 (a)）

日期：2026-10-30（r2 同日）。状态：**已实现；独立审查结论“可以合入，没有阻断项”，r2 按审查修改了全部七条（§13）**。所有者 2026-10-30 答复 19 号文件“按推荐”：问题 1 选 (a)，只在开发版里
放开，商店版不加开关，开发者指南写一节说明。基线是 5e983ee（OD30 合入之后）；商店版的产物和 5e983ee（也和 2c9b55a）逐字节
相同。以代码为准；本文与代码不一致时，以代码和测试为准，并请指出。

---

## 1. 做了什么

- **开发者**：在自己的 Sixkey 源码副本里写 `extension/plugins/catalog.dev.json`（git 不收），格式就是发布目录
  `plugins/catalog.json` 的格式，每一条是审核时会写进发布目录的那一条（`"trust": "listed"`、名称、发布者、商店地址、
  `ceiling`、`contributionsHash`）。`npm run build:dev` 读它；构建出的 **Sixkey (dev)** 把这些插件当作审核过的插件：
  批准页、读账户列表、提议修改，整个流程都能走。步骤写在 `docs/sdk/GETTING-STARTED.md` 第 10 节，规范是
  `docs/sdk/SIXKEY-PLUGIN-SDK.md` §11.5（修订 1.0-draft.13）。
- **普通用户**：什么都没变。商店版（以及 e2e 测试版）从不打开这个文件，也没有能读这种名单的代码；按 ID 添加的插件在
  商店版里照旧只有 P0。

## 2. 机制

只有三处代码，各一件事：

| 哪里 | 做什么 |
| --- | --- |
| `extension/scripts/build.mjs` | 一开始就拒绝 `--dev` 和 `--e2e` 同时出现（一次构建只有一种 flavour）。只有 flavour 是 dev（`const ownList = flavour === "dev"`）、且文件存在时，才读 `plugins/catalog.dev.json`；用 Sixkey 自己读目录的函数（`src/core/plugins/policy.ts` 的 `parseCatalog`，经 Vite 的 `runnerImport` 加载，`runnerImport` 只在这个分支里 `await import("vite")` 取用）检查它，扩展会拒绝的条目让构建停下并说明原因；然后由 `scripts/own-plugins.mjs` 并入；名单的 ID 放进构建常量 `__PLUGIN_OWN_IDS__`。其他每一种构建都把这个常量定义为 `false`。 |
| `extension/scripts/own-plugins.mjs` `withOwnPlugins` | 纯函数：把名单条目原样接在测试目录（`catalog.test.json`）之后，逐字段和名单文件相同（trust、ceiling、钉住的哈希都不动），于是 `externally_connectable.ids` 也有它们；只收 `listed`，ID 不能和测试目录重复；不改动传进来的两份目录。 |
| `extension/src/core/plugins/policy.ts` `trustOf` | 唯一的例外：开发者副本规则（审核过的 ID，`management` 报告为本机加载 `development` 或 `sideload`，就当作未审核）不适用于开发版名单里的 **listed** 条目，ID 必须整串逐字相同。名单本身不列入任何插件：目录里没有的 ID 照旧是未审核。 |
| `extension/scripts/check-dist.mjs` | 第二意见，独立写出期望值：开发版的 `ids` 必须是测试目录的、再接名单里的；商店版和 e2e 版的任何文件（清单在内）里都不能出现名单文件里写的扩展 ID（把文件当文本读，写到一半、不是合法 JSON 也照查；本版目录自己列的 ID 和保留 ID 除外）；任何一种构建里都不能出现 `__PLUGIN_OWN_IDS__` 这个名字（出现就说明构建常量漏了定义，运行时会去读全局变量）。 |

另外 `.gitignore` 加了 `extension/plugins/catalog.dev.json`。

**“它算审核过”之外，规则全部照旧。** 名单里的插件在开发版里是一个普通的 listed 插件：

- 要用户批准：`hello` 之后出现在“等你批准”里，批准页就是审核过的插件的批准页（P1、P2 在“敏感权限”下）；
- 受它那一条的 `ceiling` 和钉住的 `contributionsHash` 约束：条目变了就“已暂停：审核后它有了变化”，批准不了，直到开发者
  写上新的哈希、重新构建；
- `management` 照样在启用时问（审核过的插件都问）；拿到 `management` 之后，版本检查照旧：插件的版本和批准时的不同，
  持有 P0 以上的就暂停，要重新批准；
- 读列表只在 Sixkey 的工具栏弹窗或侧边栏开着、并且已解锁时；没开和锁定的回答逐字节相同；
- 提议修改只拿到一张票，由 Sixkey 的变更列表让用户决定；
- 碰不到密钥和验证码（Never 清单、摘要只有八个字段），请求日志照旧不记内容。

**为什么 `management` 照样问（而不是给名单插件免掉）。** 免掉能让 e2e 不必绕开 Chrome 的提示，但那就多一处例外
（`Plugins.tsx` 的 `wantsManagement`），批准页也就和审核过的插件不一样了（不出现“Chrome 会问能否管理扩展”那一句，
“在 Chrome 里的权限”写看不到）。开发者要预览的正是用户会看到的样子，所以只留 `trustOf` 这一处例外。

**为什么 `contributionsHash` 不放宽。** 钉住哈希是“审核过”的一部分；开发者测的就是他将来提交审核的那一条。指南里给了用
SDK 算哈希的三行代码（`checkDescriptor` + `contributionsHash`，SDK 本来就导出）。

**为什么用 `runnerImport` 在构建时检查。** 不这样，写错的条目要到扩展运行时 `parseCatalog` 抛错才发现（插件平台整个
不可用，失败是安全的，但开发者看不出原因）。复制一份校验逻辑到构建脚本里会和 `parseCatalog` 走样。`runnerImport`
在 Vite 8.3.4（`package.json` 钉死版本）里标着 experimental；只在开发版、且名单文件存在时才动态导入并调用，约 60 ms，
商店版和 e2e 版的构建根本不碰它（r2，DR-04）；
`devread-build.test.ts` 的拒绝用例逐条核对它的报错，以后升级 Vite 若它变了，这个测试会失败。

## 3. 为什么商店版不受影响

- **名单进不了商店版**：只有 flavour 是 dev 才读文件（`if (ownList && existsSync(...))`，`ownList = flavour === "dev"`），
  `--dev --e2e` 一起传被拒绝；商店版和 e2e 版的 `__PLUGIN_OWN_IDS__` 是 `false`。源码规则钉住这几点（拒绝在最前面；文件的
  一次存在检查和一次读取都在这个分支里；常量的定义只有这一处）。
- **能走到名单的代码也不在商店版里**：`trustOf` 里的检查写成
  `typeof __PLUGIN_OWN_IDS__ === "object" && entry.trust === "listed" && __PLUGIN_OWN_IDS__.includes(id)`，
  商店版里 `typeof false === "object"` 是常量假，压缩器把整段去掉。实测：
  - 本补丁的商店版 `dist/` 和 5e983ee 的逐字节相同（`diff -r`，124 个文件）；5e983ee 的和 2c9b55a 的也相同；
  - 有没有 `catalog.dev.json`、里面写什么，商店版都相同；
  - e2e 版（常量也是 `false`）的 `dist-e2e/` 也和 5e983ee 的逐字节相同；开门构建（商店版带同步界面）的体积数字和基线相同；
  - 只有开发版的产物变了（`trustOf` 所在的共享块和它的哈希名），这是预期的。
- **机器检查**（会一直跑的）：
  - `test/unit/devread-build.test.ts` 在私有副本里构建：带功能、带名单文件的商店版和 e2e 版，和**手工去掉这段检查**、
    不带名单文件的商店版和 e2e 版，逐文件逐字节比较（r2 起 e2e 版也比，DR-02）；商店版、e2e 版里找不到名单 ID 和常量名；
    它们的 `ids` 只是各自目录的；开发版的 `ids` 和代码里确实有名单；
  - `check-dist`（`npm run check`、`--e2e`、`--dev`）的三条规则（§2），各有变异体用例；
  - 体积上限一个没动，也一个没放宽（§9）。

## 4. 安全边界

- 例外只有“本机加载的这一份算审核过的那一份”。名单是开发者自己写的，能改开发者源码树的人本来就能把任何代码编进
  开发版，所以名单不增加新的信任对象。
- 开发版本身不该当日常验证器：自己的保险库、固定 ID 的公钥在仓库里（任何本机加载的扩展都能用这个 ID）、带开发用同步页和
  本地 API 地址、代码不压缩、不检查安装来源。指南里写明“只放测试账户”。
- 商店版的 `ids` 和权限不变：商店清单仍是 `{"ids": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}`，权限、可选权限都和基线一样。

## 5. 界面文字

- **没有新增任何界面文字**，`_locales/`、`catalogs/` 没有变化（`messages.py` 重新生成后与基线相同）。
- 开发版的标识沿用现有的：Chrome 里的名字 **Sixkey (dev)**（`manifest.dev.json`）和固定 ID。名单里的插件在界面上就是
  审核过的插件（“第三方 · 已审核”）。
- 只多了一行**构建时的控制台输出**（英文，开发者终端里看到，不进任何产物）：
  `your own plugins (plugins/catalog.dev.json), listed in this build: <ID, ...>`；以及名单文件有错时构建的报错
  `build: plugins/catalog.dev.json: <原因>`。

## 6. 测试

| 文件 | 测试数 | 内容 |
| --- | --- | --- |
| `test/unit/devread.test.ts` | 17 | `trustOf`：名单插件本机加载或旁加载时是 listed 而不是开发者副本；名单外的 listed（测试目录的 reader）照旧是开发者副本；整串逐字匹配（前缀、更长、大写、前后空格、轮转都不算）；空名单、`false`、未定义都等于没有例外；名单本身不列入（目录没有的 ID 是未审核、P0）；只对 listed（blocked 还是 blocked，official 本机加载还是开发者副本）。批准（`grantsOf`）：名单插件按它那一条的 `ceiling` 授权，名单外 P0；钉住哈希不符就暂停；有 `management` 时版本不同就暂停；按钮出现在审核过的插件出现的地方。按检查顺序（`dispatch`，`management` 报告本机加载）：批准前 `hello` 是 pending、其余 not-approved；批准后弹窗或侧边栏开着并已解锁才给列表；没开、锁定都 `unavailable` 且逐字节相同、不读保险库；以验证过的记录为准；`ceiling` 管住 P1 和 P2；P2 只给票；同一插件名单外：P1 `developer-mode`、P2 `not-granted`。 |
| `test/unit/devread-platform.test.ts` | 4 | 假 `chrome`、`management` 在手、Chrome 报告本机加载：worker 的真实路径（`installOf` → 检查顺序 → P1）。名单插件批准前 not-approved；批准后没开、在标签页里开都 `unavailable`；侧边栏开着才有列表，只有八个字段，没有密钥、`otpauth`、算法、条目 ID；锁定时 `unavailable` 且不开保险库；名单外（空名单、别的 ID、未定义）是 `developer-mode`；版本不同就 `suspended`。 |
| `test/unit/devread-build.test.ts` | 18 | 真构建（私有副本）：商店版和 e2e 版都与手工去掉功能的树逐字节相同；`--dev --e2e`（两种顺序）被拒绝、不写产物；商店版、e2e 版无名单 ID、无常量名，`ids` 各是各的，check-dist 通过；开发版 `ids` = 测试目录 + 名单，代码里有名单，check-dist 通过；没有名单文件时开发版只有测试目录、名单为空；构建拒绝 9 种坏文件（不是 JSON、v 不对、缺钉住哈希、`ceiling` 里有不存在的权限、official、blocked、和测试目录重复、保留 ID、同一 ID 两次），都说明原因、不写产物；`withOwnPlugins` 的单元测试（条目原样并入、逐字段相同、trust 仍是 listed、ceiling 和钉住哈希不变、不改动输入、空名单不加任何东西；拒绝 official、blocked 和与测试目录重复的 ID）；check-dist 的变异体（开发版漏了名单 ID、商店版或 e2e 版放进名单 ID（清单里或代码里）、任何构建出现常量名、名单文件写到一半照查、名单文件读不出来时一句清楚的报错而不是堆栈）；源码规则（只有 `policy.ts` 用常量、只在开发者副本规则里；`build.mjs` 先拒绝两个 flavour 同时出现，按 flavour 判断，只在开发版分支读文件、其余构建 `false`；静态导入里没有 `runnerImport`，只在这个分支里动态导入一次；开发版的目录和 ids 只取 `withOwnPlugins` 的结果，原样使用；e2e 固定插件的 ID 由它的公钥算出、不在任何受版本控制的目录里；`.gitignore`）。 |
| `test/e2e/plugins-own.spec.ts` | 1 | Chromium 里真走一遍（见 §8）。 |

**e2e 怎么做的。** 在临时副本里写 `catalog.dev.json`（一条：reader 的代码、换一把公开测试公钥
`test/fixtures/plugins/own-key.json`，ID `njjbnpaondeahkpaaflppoecgecimbfn`），`build.mjs --dev`，check-dist --dev；
开发版要求 `management`，而 Chrome 的这个提示自动化答不了、开发版也没有测试应答（check-dist 拒绝），所以**只在测试的
这份产物里**把 `management` 从可选权限挪到必需权限，Chrome 加载时就给了，相当于开发者在提示里点了“允许”。同一个配置里
还加载了测试目录的 reader（同样本机加载），作对照。检查：Sixkey (dev) 持有 `management`；名单插件 `hello` 是 pending，
请求 not-approved；设置 › 插件里它在等你批准、“第三方 · 已审核”，批准页有 P1、P2 的敏感权限和“无法阻止发到网上”那句，
没有“开发者副本”；允许后 `hello` 是 approved、trust listed；没开 Sixkey、弹窗页面在标签页里都 `unavailable`；侧边栏开着
有列表（八个字段，没有密钥）；提议添加拿到票；reader 是“开发者副本”，批准页没有敏感权限，P1 `developer-mode`、P2
`not-granted`；锁定后 `unavailable`，与没开时逐字节相同；没有未翻译的文字。

**有意改动的旧测试：没有。**

## 7. 变异体

手工变异体，一个想法一个，在工作树的副本里改、跑指定测试、改回（`tools/mutants.py`、`tools/e2e-mutants.py`，在快照目录
`scratchpad/devread/` 里）。只有失败的断言（vitest 的 `AssertionError`，Playwright 的 `expect`）
算杀死，超时和别的错误都不算；每个进程组单独运行，超时是原始运行时间的 5 倍（30–180 秒）。

| ID | 想法 | 结果 | 被谁杀死 |
| --- | --- | --- | --- |
| M01 | 商店版也读名单（文件和常量对每种构建都开） | 断言杀死 | devread-build：逐字节比较、源码规则 |
| M02 | 商店版的常量是空名单 `[]` 而不是 `false` | 断言杀死 | devread-build：逐字节比较（`[].includes` 留在产物里）、源码规则 |
| M03 | 名单插件跳过用户批准 | 断言杀死 | devread、devread-platform：批准前 not-approved |
| M04 | 名单插件在 Sixkey 没开时也能读 | 断言杀死 | devread、devread-platform：`unavailable`、不读保险库 |
| M05 | 名单插件算官方插件（锁定时告诉它 `locked`，ceiling 不过滤） | 断言杀死 | devread：trust 是 listed、锁定与没开逐字节相同 |
| M06 | 名单按前缀匹配 | 断言杀死 | devread：整串逐字匹配 |
| M07 | 名单匹配不分大小写 | 断言杀死 | devread：整串逐字匹配 |
| M08 | 名单为空时放行全部 | 断言杀死 | devread：空名单等于没有例外；名单外 `developer-mode` |
| M09 | 开发版里所有 listed 的本机副本都免开发者副本规则 | 断言杀死 | devread、devread-platform：reader 照旧是开发者副本 |
| M10 | 名单本身就列入插件（目录没有的 ID 也算 listed） | 断言杀死 | devread：名单不列入 |
| M11 | 名单里的 official 条目也免规则 | 断言杀死 | devread：只对 listed |
| M12 | 名单插件不受钉住哈希约束 | 断言杀死 | devread：钉住哈希不符就暂停 |
| M13 | 名单插件不受 `management` 版本检查 | 断言杀死 | devread、devread-platform：版本不同就暂停 |
| M14 | 名单插件不受 `ceiling` 约束 | 断言杀死 | devread：`ceiling` 管住 P1、P2 |
| M15 | 并入时漏掉条目（`ids` 里也没有；r2 起改在 `own-plugins.mjs`） | 断言杀死 | devread-build：并入的单元测试、开发版 `ids` |
| M16 | 构建不用 `parseCatalog` 检查名单文件 | 断言杀死 | devread-build：拒绝用例 |
| M17 | 构建接受不是 listed 的条目（r2 起改在 `own-plugins.mjs`） | 断言杀死 | devread-build：并入的单元测试、拒绝用例 |
| M18 | check-dist 不在商店版、e2e 版里找名单 ID | 断言杀死 | devread-build：check-dist 变异体 |
| M19 | check-dist 不要求开发版 `ids` 有名单 ID | 断言杀死 | devread-build：开发版 check-dist、变异体 |
| M20 | check-dist 不查常量名 | 断言杀死 | devread-build：check-dist 变异体 |
| E1 | e2e：没有例外（名单插件本机加载就是开发者副本） | 断言杀死 | plugins-own.spec：设置页那一行不是目录里的名字 |
| E2 | e2e：所有 listed 的本机副本都免规则 | 断言杀死 | plugins-own.spec：reader 的批准页没有“开发者副本” |
| E3 | e2e：名单插件在 Sixkey 没开时也能读 | 断言杀死 | plugins-own.spec：没开时应为 `unavailable` |
| C01 | 对照：名单检查改用 `indexOf(id) !== -1`（等价） | 存活（应当） | 只跑 devread、devread-platform：build 测试钉住了这段源码的原文（它要手工去掉这段来比字节） |
| C02 | 对照：并入时换一种写法收集名单 ID（等价） | 存活（应当） | devread、devread-platform、devread-build |
| R02 | 审查的 R02：e2e 版的常量写成 `[]`（写在钉住的那一行之外） | 断言杀死 | devread-build：e2e 版逐字节比较（r2，DR-02） |
| R11 | 审查的 R11：并入时把条目改成 official（`own-plugins.mjs`） | 断言杀死 | devread-build：并入的单元测试 |
| R11b | 同一想法改在 `build.mjs` 并入之后 | 断言杀死 | devread-build：源码规则（只用并入的结果） |
| R12 | 审查的 R12：并入时把 ceiling 放宽到 P1、P2 全部 | 断言杀死 | devread-build：并入的单元测试 |
| R12b | 同一想法改在 `build.mjs` 并入之后 | 断言杀死 | devread-build：源码规则 |
| R13 | 审查的 R13：并入时去掉钉住的哈希 | 断言杀死 | devread-build：并入的单元测试 |
| R13b | 同一想法改在 `build.mjs` 并入之后 | 断言杀死 | devread-build：源码规则 |
| DR01 | 审查的 DR-01 情形：不拒绝 `--dev --e2e`，且按标志读名单（e2e 版带名单） | 断言杀死 | devread-build：两个参数被拒绝；源码规则 |
| DR01a | 只去掉拒绝（仍按 flavour 判断） | 断言杀死 | devread-build：两个参数被拒绝 |
| DR01b | 只改回按标志读名单（拒绝还在） | 断言杀死 | devread-build：源码规则 |
| DR04 | `runnerImport` 又改回静态导入 | 断言杀死 | devread-build：源码规则 |
| DR07 | check-dist 读不出名单文件时直接抛出 | 断言杀死 | devread-build：报错那一句、没有堆栈 |

r1 的 20 个单元变异体和 3 个 e2e 变异体，加上 r2 的 12 个（审查的 R02、R11、R12、R13，各自在 `build.mjs` 里的变体，
DR-01 的情形和它的两半，DR-04，DR-07），在 r2 的树上全部重跑，全部被断言杀死，没有超时；2 个对照存活
（`mutants-r2.log`、`e2e-mutants-r2.log`）。r2 起，“被断言杀死”按 vitest 的 JSON 报告判：每一处失败都以 `AssertionError`
开头。DR07 的断言消息里引用了 check-dist 的堆栈文字，按 r1 那条更粗的文本规则会被误算成“别的错误”，单独按 JSON 规则重跑
（`mutants-r2-dr07b.log`）。

## 8. 门禁、全量单元、e2e

（运行记录在快照目录 `logs/`。）

- **门禁**（`gates-*.log`，在去掉 OWNER-DECISIONS 的副本里）：`messages.py`（重新生成的 `_locales/`、`catalogs/` 与基线
  相同）；`npm run typecheck`（含 SDK 自己的 tsconfig）；商店版、e2e 版、开发版构建和各自的 check-dist；开门构建（商店版，
  `SYNC_UI_IN_STORE_BUILD = true`）和 check-dist；`npm run format:check`（只用 `npm run format` 格式化）；
  `npm run notices:check`；没有遗留的 `.orig`、`.rej`。商店版清单的 `externally_connectable` 和权限与基线相同。
- **全量单元**（r1，`unit-full-1.log`，拿重活锁、`--maxWorkers=2`）：299 个文件；4,598 通过，4 个预期失败，1 个跳过，
  0 失败，用时 1,161 秒。r1 新增 34 个（17 + 4 + 13）。r2 没有重跑全量（维护者合入时跑）；r2 跑了 devread 三个文件和
  plugins-core、plugins-source-rules、plugins-protocol、externally-connectable、m5-build-guard、plugin-sdk-build-guard、
  plugins-w2a、plugins-w2b、plugins-slots（`unit-targeted-r2.log`：12 个文件，215 个测试，全部通过）。r2 的 devread 共
  39 个（17 + 4 + 18）。门禁在 r2 的树上全套重跑（`gates-r2.log`），商店版和 e2e 版仍与 5e983ee 逐字节相同。
- **e2e**（`e2e-plugins-1.log`，在路径里没有 `/e2e/` 的副本里，API 端口在 18 个文件里从 8787 换成了另一个端口、两份清单都核对过，
  从没碰 127.0.0.1:8787）：和插件有关的 11 个 spec 加 `test/regression/permission-wire.spec.ts`（它用开发版），共 63 个
  测试全部通过，用时 6.5 分钟：`plugins.spec.ts`、`plugins-w1b`、`plugins-w2a`、`plugins-w2b`、`plugins-w2b-r2`、
  `plugins-lone-surrogate`、`plugins-own`（新）、`plugin-samples`、`sample-screenshot-pages`、`externally-connectable`、
  `perf.spec.ts`（打开弹窗时的读取次数）。r2 在改过的树上把 `plugins-own.spec.ts` 再跑了一遍，通过，3 个 e2e 变异体也都
  再次被杀死（`e2e-mutants-r2.log`）。

## 9. 体积

商店版产物与基线逐字节相同，所以每一个上限下的数字都和基线一样（check-dist，gzip 字节，zh_CN）：

| 什么 | 本补丁 = 基线 | 上限 |
| --- | --- | --- |
| 弹窗，门关着（今天的商店版） | 58,095 | 61,440 |
| 弹窗，门开着 | 59,369 | 61,440 |
| 侧边栏，门关着 / 开着 | 60,325 / 61,595 | 63,488 |
| 设置页所有部分一起 | 12,116 | 12,288 |
| 保险库页面加上所有懒加载目录 | 15,258 | 15,360 |
| 插件文字：设置页的 / 弹窗的 / 变更列表的 | 1,946 / 415 / 703 | 3,072 / 2,048 / 2,560 |

没有放宽任何上限，也没有加新的。开发版（不计预算，只打印）多出 `trustOf` 里的一小段和名单本身。

## 10. 残余，给审查人重点看

- **`runnerImport` 是 Vite 标为 experimental 的 API**（§2）。只在开发版、名单文件存在时动态导入并使用（r2）；坏了只影响
  开发者，测试会报；商店版和 e2e 版的构建不依赖它。
- **e2e 改了测试那份产物的清单**（把 `management` 挪成必需权限），因为自动化答不了 Chrome 的提示。真 Chrome 里的提示本身
  已由 OWNER-CHECKLIST 第 37、45 项在开发版里人工看过；这里不新增人工检查项。
- **check-dist 在商店版检查时会读开发者的 `catalog.dev.json`**（只为找有没有漏进产物的 ID，按文本读，不解析也不报格式错）。
  发布机上不该有这个文件；有的话，检查只会更严。
- **开发版的固定 ID 是公开的**（`manifest.dev.json` 的公钥）：任何本机加载的扩展都能用这个 ID。和以前一样，所以开发版不该放真实账户。
- **全量单元多了约 35 秒**：`devread-build.test.ts` 在私有副本里构建 6 次（商店版两次、e2e 两次、开发版两次）。

## 11. 改成“已定”的说法

- `docs/design/notes/PLUGINS-W2A-NOTES.md` §7（两处）、§10 的待定项：开发者开关按 19 问题 1 (a) 已定、已实现；同一句里的
  “每次关闭弹窗时锁定”按 19 问题 2 (a) 已定（保持 `unavailable`）。
- `docs/design/notes/PLUGINS-W2B-NOTES.md` §10：“From W2a”两项都已定。
- `docs/sdk/SIXKEY-PLUGIN-SDK.md`：开头的修订说明（1.0-draft.13，两项决定）、§3.3 第 6 项和 §6.3 的残余（问题 2 已定）、
  §6.3 Who、§8.2 开发者副本、§8.3 P1 一行、§8.4（不做开发者模式）、§11.4、新增 §11.5、§16.1。
- `docs/sdk/GETTING-STARTED.md`：开头、§9 的“Who can”、新增 §10。
- `docs/OWNER-CHECKLIST.md` 第 46 项：开发版的例外，以及“按 ID 添加的插件要不要开发者开关”已定。
- `docs/design/proposals/MOD-PLATFORM.md` 开头的“Since then”：S-5 已定。
- `docs/ARCHITECTURE.md` 构建一览表：多一行插件目录。

## 12. 需要所有者定的事

没有。

## 13. r2：独立审查之后（2026-10-30）

审查（快照目录里的 `REVIEW.md`）结论“可以合入，没有阻断项”，一条应修、六条建议；维护者要求七条都修，基线仍是 5e983ee。

| 编号 | 是什么 | 改了什么 | 谁守着 |
| --- | --- | --- | --- |
| DR-01（应修） | `--dev --e2e` 一起传时，构建出的是 e2e 版，却照样读名单（判断看的是 `dev` 标志） | `build.mjs` 一开始就拒绝两个参数同时出现（退出码 2，`build: --dev and --e2e are two flavours of the build; pass one of them`）；读名单和注入常量都改成按 flavour（`ownList = flavour === "dev"`）。SDK §11.5、本文 §2、§3 跟着改 | 构建测试：两种顺序都被拒绝、不写产物、不读名单；源码规则钉住新写法；变异体 DR01、DR01a、DR01b |
| DR-02 | e2e 版的逐字节不变没有测试守着（审查的 R02 存活） | 构建测试也构建 `bare --e2e`，和带功能、带名单的 e2e 版逐文件比较 | 变异体 R02 |
| DR-03 | 并入目录的内容没有单元测试（R11、R12、R13 只有 e2e 能杀，R12 连 e2e 也杀不死） | 并入抽成纯函数 `scripts/own-plugins.mjs` 的 `withOwnPlugins`，`build.mjs` 原样使用它的结果 | 单元测试：逐字段相同、不变成 official、钉住哈希不丢、ceiling 不变宽、不改动输入；源码规则：`build.mjs` 只用这个结果；变异体 R11、R12、R13（改在纯函数里）和 R11b、R12b、R13b（改在 `build.mjs` 并入之后） |
| DR-04 | `runnerImport` 静态导入，商店版构建也依赖这个 experimental 导出 | 只在开发版分支、名单文件存在时 `await import("vite")` 取用 | 源码规则：静态导入只有 `build`，动态导入只一次且在分支里；变异体 DR04 |
| DR-05 | 指南 §10 的片段缺 `descriptor` 的导入 | 补上导入，并写成一个完整的 vitest 测试 | 在照指南搭的插件项目里实跑通过 |
| DR-06 | 拒绝用例失败时名单文件不恢复，后面的测试连环失败 | `try { … } finally { writeOwn(mine, OWN); }` | — |
| DR-07 | check-dist 读名单文件不在 `try` 里，读不出来就抛出堆栈 | 包进 `try`，读不出来时一句报错（`plugins/catalog.dev.json cannot be read, so this <flavour> build cannot be checked for its IDs`），结果仍是不通过 | 构建测试：名单文件换成目录时，商店版和 e2e 版的检查都不通过、报这句、没有堆栈；变异体 DR07 |

## 14. DEVREAD-FU：r2 复核的两条建议（2026-10-30）

r2 复核（`REVIEW.md` 的“r2 复核”一节）结论“可以合入”，另提两条建议，都做了。

- **DR-08：`withOwnPlugins` 的输入和共享引用。** r2 的源码规则只看它的输出：调用之前先放宽名单条目的 ceiling（S12c），
  或者调用之后通过 `own` 删掉条目里钉住的哈希（S13c，并入的是同一批对象），39 条测试都发现不了。改了两处：
  - `withOwnPlugins` 并入每一条的拷贝（`structuredClone`），之后对名单文件那批对象做什么，都影响不到并入的目录；单元测试在
    调用之后改掉原对象（删钉住哈希、放宽 ceiling、改成 official），断言并入的目录不变；
  - 源码规则：名单分支里，`own` 只出现三次（`JSON.parse` 读出、`parseCatalog(own)` 检查、`withOwnPlugins(…, own, …)` 并入），
    而且声明在分支的 `try` 块里，分支外的代码碰不到它，所以从解析到并入是直接传递，中间和之后都没有改写。
  - 变异体：审查人的 S12c、S13c 都被这条源码规则的断言杀死；去掉拷贝（F01）被新的单元断言杀死；`own-plugins.mjs` 里的
    M15、M17、R11、R12、R13 按新锚点重跑，仍被杀死；对照 C01、C02 存活（`mutants-fu.log`）。审查人的对照 S24（浅拷贝）
    在这里不再等价：拷贝是深的，测试会往原对象的 ceiling 数组里加东西，浅拷贝共用这个数组。
- **DR-09：两处文字。** 本文末尾多出的空行删掉了（`.prettierignore` 不管 `docs/design/`，门禁发现不了）；指南 §10 说
  `npm test` 会打印哈希的地方补了半句：vitest 换成精简输出时（它会藏起通过的测试的输出），加 `--reporter=default`。
