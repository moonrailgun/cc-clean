# cc-clean 第一版设计

日期：2026-11-08。状态：已按批准的设计实现第一版，尚未发布。

本文保留设计时的调研快照与方案说明；当前支持范围、本地运行方式和限制以 [README](../../../README.md) 为准。实现直接位于 `main`，未创建提交。

后续明确要求：应用全英文；提供 Agent 可直接调用的非交互命令、JSON 命令发现、结构化错误和退出码；永远不要自动运行清理命令（含预览和清理测试），详见根目录 `AGENTS.md`。

## 1. 产品定位与边界

`cc-clean` 是一个本地 Node.js 命令行工具，未来通过 `npx cc-clean` 启动。第一版支持 Claude Code 和 Codex，主菜单固定为 **无脑清理、分析、统计**。

用户已确定：清理超过 3 天的临时文件、压缩图片、分析目录/项目/会话/使用情况，以及按 Claude / Codex 分开累计每次清理的存储变化。字段压缩的具体规则以后再定。

已采用的实现选择：Node.js 24+、TypeScript、全英文应用、macOS 首发验证、轻量列表交互、默认无损图片压缩。第一版不做后台常驻、定时任务、云同步、金额估算和其他 AI 工具适配。

工具的配置、缓存、操作记录和工作文件都放在 `~/.config/cc-clean/`。Claude / Codex 的原始数据保留在原目录，不迁移。标准 `npx` 会使用 npm 自己的包缓存；这部分不属于应用状态，也不计入清理收益。

### 方案选择

| 方案 | 优点 | 代价 | 建议 |
| --- | --- | --- | --- |
| 菜单 + 可筛选的分层列表 + 子命令 | 接近 Mole 的使用方式；鼠标无关；适合逐层分析和选中清理 | 不持续显示多块仪表盘 | **第一版采用** |
| 全屏仪表盘 | 可同时展示目录树、图表、会话详情 | 布局、焦点、终端兼容和刷新状态更复杂 | 暂不采用 |
| 只有命令和参数 | 实现最少，易脚本化 | 不利于发现占用并逐层选择 | 保留为同一系统的直接入口 |

借鉴 [Mole](https://github.com/tw93/mole) 的菜单、大小排序、分层浏览、执行进度和完成报告；独立实现，不复制其 GPL 源代码。

## 2. 本机调研对设计的影响

以下是 2026-11-08 的只读扫描快照。按普通文件逻辑大小统计，不跟随目录内符号链接，硬链接按设备和 inode 去重。应用正在使用，快照会变化；这里的 GiB 不是承诺可以释放的物理磁盘空间。

| 来源 | 总占用 | 主要部分 |
| --- | ---: | --- |
| Claude Code | 约 2.95 GiB，5,673 个文件 | `projects` 约 2.87 GiB；其中 514 个 JSONL、44 个项目目录 |
| Codex | 约 39.87 GiB，33,891 个文件 | `sessions` 约 29.28 GiB；`thread_history_1.sqlite` 约 6.06 GiB；`generated_images` 约 1.93 GiB |

关键发现：

- Claude 会话样本中存在大量 Base64 图片及重复图片，也有 `api-request-blob`、哈希和请求引用。重复并不等于可以直接删。
- Codex 不只有 JSONL。历史数据库记录 `rollout_byte_offset`、`rollout_end_byte_offset` 等偏移；改写 JSONL 长度可能使数据库中的历史定位失效。
- Codex 的状态库有 5,521 条线程记录，但与磁盘上的会话文件并不一一对应。不能只查数据库就声称完成全部分析。
- Codex `generated_images` 中有 1,071 张 PNG，约 1.93 GiB，适合作为独立图片压缩的第一批对象；尚未实测压缩率。
- `~/.codex/plugins/cache/openai-bundled/chrome/latest` 当前指向 `~/.codex/.tmp/` 下的插件资源。**`.tmp` 不能按目录整体删除。**
- Claude 的 `stats-cache.json` 最近计算日期为 2026-09-28，早于本次扫描；使用量必须标注数据时间，不能将旧缓存当实时结果。
- 本机 Codex 0.167.0 提供 `codex delete <SESSION> --force`；它要求 UUID。会话删除优先交给官方命令维护内部状态。
- 本机 Claude Code 2.1.319 提供 `claude purge`，但范围包含项目数据和 `~/.claude.json` 中的项目条目。不能把它悄悄当作“只删除所选会话”。

会话结构调研只抽样解析了每家 3 个文件，每个约前 32 MiB，并完整读取末行；这不是全量格式兼容验证。未读取认证配置内容，未执行实际删除、图片改写或会话恢复测试。

## 3. 用户交互

### 主菜单

```text
cc-clean
Claude Code  已发现       Codex  已发现

❯ 无脑清理    清理过期临时文件，尝试无损压缩图片
  分析        查看目录、项目、会话及使用情况
  统计        查看本次和累计节省
  退出

↑↓ 选择 · Enter 进入 · Ctrl+C 退出
```

主菜单不等待几十 GB 的会话解析。只检查根目录是否存在，已有统计则显示时间戳；进入对应功能后再扫描。

所有页面保持相同的列表样式。分层页面有面包屑和“返回”；可切换来源、排序和筛选，多选页面支持空格选中。使用库原生键位，不为了复刻 Mole 而另写完整终端框架。

长列表分页渲染；默认按占用降序。列表省略路径时，详情展示完整路径和稳定 ID，不能仅按同名项目或会话标题执行删除。窄终端退化为逐项文本；遵守 `NO_COLOR`，颜色不承担唯一的信息表达。

### 无脑清理

选择后直接执行已经定义为默认安全的规则，不要求用户逐文件判断。执行过程明确区分发现候选、验证、处理、跳过和失败；没有候选就显示 0。

```text
无脑清理

✓ Claude Code   扫描完成
✓ Codex         扫描完成
  过期临时文件  处理 8 项 / 8 项
  PNG 无损压缩  处理 42 张 / 120 张
  字段压缩      暂未启用规则

Ctrl+C 停止后续任务，保存已完成结果
```

下列完成报告数字是交互示例，不是本机实测收益：

```text
本次清理完成

                 Claude Code     Codex
操作确认减少       24 MiB         186 MiB
目录前后变化       24 MiB         174 MiB
跳过               2 项           6 项

Codex 目录变化少于操作减少量：期间检测到其他写入。
查看明细 / 查看累计统计 / 返回
```

### 分析

```text
分析 / Codex                         扫描完成于 14:32

❯ 按目录     会话、数据库、图片、缓存、插件……
  按项目     项目占用、会话数量、最近活动
  按会话     大会话、旧会话、归档、子会话
  使用情况   活跃日期、模型、消息、工具调用、Token
  压缩机会   图片与字段占用、重复内容候选
  返回
```

项目列表展示“项目、会话文件占用、可归属附件占用、会话数、最近活动、扫描完整度”。进入项目后列出会话；进入会话后列出主记录、子会话、附件、按记录类型和字段统计的组成。

所有存储页面提供“筛选 / 排序 / 选择清理项”，可选动作取决于对象能力：

- 临时文件：删除符合规则的选中项。
- 独立 PNG：无损压缩选中项；用户也可明确选择永久删除图片。
- 会话：删除选中会话及已展示的关联记录。
- 项目：展开为该项目的会话选择，不直接删除项目目录。
- 数据库、插件、配置、内存文件、未知文件：查看占用及原因，不提供泛化的 `rm` 按钮。

手动删除统一先显示来源、完整路径或 UUID、子会话及关联文件范围、预计字节数和“永久删除，无法通过本工具撤销”，再做一次默认取消的确认。会话与图片删除从不加入无脑清理。

## 4. 命令契约

以下是未来发布后的命令示例，目前不应运行裸 `npx cc-clean`，避免下载同名的其他包。

```bash
npx cc-clean
npx cc-clean clean
npx cc-clean clean --provider codex --dry-run
npx cc-clean analyze
npx cc-clean analyze --provider claude --view projects
npx cc-clean analyze --provider codex --view sessions --project /absolute/project
npx cc-clean analyze --view usage --json
npx cc-clean analyze delete --provider codex --session <uuid> --dry-run
npx cc-clean analyze delete --provider codex --session <uuid>
npx cc-clean stats
npx cc-clean stats --provider claude --json
npx cc-clean --help --json
```

| 参数/行为 | 约定 |
| --- | --- |
| `--provider claude\|codex\|all` | 默认 `all`；指定会话或文件必须指定单一来源 |
| `--view directories\|projects\|sessions\|usage\|opportunities` | 默认目录视图；TTY 中可切换 |
| `--project <absolute-path>` | 仅用于 `analyze --view sessions`，匹配规范化的项目路径；只筛选会话列表，不改变来源总量 |
| `--session <id>` | 可重复传入，选择精确会话；未知 ID 不推测、不扩展匹配 |
| `--file <absolute-path>` | 可重复传入，选择符合现有规则的文件；不能与 `--session` 混用，任何不合格文件均在执行前拒绝 |
| `--dry-run` | 生成并展示计划，不改来源数据、不调用删除命令、不累计收益；可更新本工具扫描缓存 |
| `--json` | stdout 只输出一个带 `schemaVersion` 和 `status` 的 JSON，包括错误；诊断写 stderr；无 ANSI，始终禁用交互提示 |
| `--no-interactive` | 始终禁用交互提示，保留人类可读输出 |
| `--yes` | 显式确认变更，适用于无脑清理和手动删除；不绕过保护、活动检测或版本兼容检查 |
| `--help --json` / 裸 `--json` | 输出带版本的命令描述、参数、取值、变更标记及退出码，供 Agent 发现能力 |
| 非交互环境 | 裸命令输出用法；分析输出报告；所有变更命令均要求 `--yes`，或通过 `--dry-run` 仅预览 |
| 退出码 | `0` 完成或无候选；`1` 执行/扫描失败或未完成；`2` 参数/非交互确认缺失；`130` 用户中断 |

预期的保护性跳过不等于错误，但逐项记录原因。明确请求删除的目标若全部被阻止，返回未完成而非成功。JSON 报告含 `status`、`scanComplete` 和各类数量，不依赖退出码表达所有细节。

JSON 错误使用 `error: { code, message }`，错误码为 `USAGE_ERROR`、`OPERATION_FAILED` 或 `INTERRUPTED`。Agent 可通过进程参数数组调用源码、构建产物或安装后的命令，无需菜单交互。

第一版的 `--file` 只接受扫描与规则验证后的合格文件，不开放任意路径删除，不提供 `--force` 绕过保护，不提供项目通配符删除。交互界面的文件选择也必须来自扫描产生的对象 ID。

## 5. 清理规则

### 超过 3 天的临时文件

“3 天”定义为操作开始时固定时间减去文件 `mtime` **严格大于 72 小时**。恰好 72 小时、未来时间戳、正在变化或无法确认用途的文件跳过。不使用目录时间、不使用访问时间、不将旧会话认作临时文件。

| 对象 | 默认策略 |
| --- | --- |
| 已验证版本的遗留原子写入临时文件，例如 Codex 根目录 `..codex-global-state.json.tmp-*` | 超过 72 小时、正式文件有效且无写入者时可清理；不输出正式文件内容 |
| 已有明确生命周期规则的工具临时产物 | 满足规则且无引用、无打开句柄、无活动写入者时可清理 |
| `.tmp`、`cache`、`paste-cache` 整个目录 | 只分类分析；目录名本身不是删除依据 |
| 插件符号链接指向的 `.tmp` 子树 | 保护，包括祖先目录 |
| `shell_snapshots`、`file-history`、会话附件与工具结果 | 长期记录，不能仅因为超过 3 天自动删除 |
| skills、plugins、packages、memories、worktrees、认证与配置 | 不进入默认清理 |

首批临时规则采取明确路径模式和版本测试；如果 Claude 没有已验证的临时规则，就如实显示“暂无可自动清理项”，不为凑数量扩大范围。

扫描和执行都不跟随来源根目录内部的符号链接。根目录本身可以经显式配置解析为真实路径，但必须展示实际位置。硬链接文件不改写、不自动删除；分析单独显示共享占用。来源根目录重叠或指向同一位置时禁用变更，防止两个来源重复操作和记账。

### 图片压缩

第一版默认压缩 **独立、已完成写入的静态 PNG**。保持路径、格式、尺寸、像素、透明度、色彩信息及原有元数据；不降分辨率、不调色板量化、不把 PNG 转成 JPEG。

建议先用 `node:zlib` 重压缩 PNG 的 IDAT 数据流：保留原始扫描行数据和所有允许的非 IDAT 数据块，仅调整 Deflate 压缩。这样无需图像原生依赖，也避免普通解码/编码流程的位深转换和元数据丢失。检查签名、块长度、CRC、IDAT 次序和完整解压结果；新旧解压数据的摘要必须一致。未知块、签名块、APNG、损坏图片和超过资源限额的图片直接跳过。具体允许块集合由实现者按 PNG 规范及测试样本确定。

只在新文件更小时替换，保留原来的文件权限和 `mtime`。压缩失败或不变小时保留原文件；无法保持文件属性时也跳过。PNG 不受“超过 72 小时”限制，但受写入者和稳定性检查约束。

这一算法的压缩率可能有限，尤其图片已经充分压缩时。第一版先验证真实收益，再决定是否增加更重的无损优化器。JPEG、WebP、GIF、内嵌 Base64 图片先报告占用，不进行假定无损的重新编码。

Claude 的内嵌图片和 Codex 的带索引会话不能套用独立图片规则。必须先证明相关哈希、引用、历史索引和恢复行为兼容，才能新增对应适配器能力。

### 字段压缩

第一版提供“字段体积报告”，**不擅自定义哪些字段没有用**。报告字段路径、记录类型、出现次数、估算字节数、重复情况和样本覆盖率。

已发现的研究候选包括 Claude 的图片重复存储和请求调试记录，以及 Codex 的重复工具输出、`replacement_history`、技能快照。候选不意味着可删；签名、加密内容、关联 ID、usage、消息顺序和未知字段都不能依据名字处理。

以后每条压缩规则必须明确适用版本、保留语义、索引/哈希处理办法，并验证历史显示、继续会话和关联工具结果。JSON 能解析不算验证通过。第一版不增加一个实际无效的“激进模式”。

### 分析内删除会话

**Codex：** 选定 UUID 后，先展开可验证的子会话关系，预览完整删除集合。实现阶段用隔离数据验证当前官方删除命令的实际级联范围；无法列全范围时拒绝父会话删除。确认后通过参数数组调用 `codex delete <uuid> --force`，固定本次解析的 `CODEX_HOME`，不使用 shell 拼接、远程服务或名字匹配。原生客户端负责维护内部状态；cc-clean 不直接写 SQLite、不自行 `VACUUM`。不以“归档”冒充节省。

删除后核对计划中的文件和会话记录是否消失。数据库删行后文件可能不缩小，节省按实测计算；残留图片或共享附件继续显示为独立占用，不擅自级联删除。官方命令不存在、版本未验证、返回失败或超时时，不退回直接删 JSONL。原生命令可能触发其已配置的生命周期行为，因此只对隔离验证通过的本地版本开放，不承诺该子进程绝无网络行为。

**Claude：** 第一版“删除会话”限定为通过结构验证的本地会话组：主 JSONL、确认唯一归属该会话的子会话和工具结果文件。实施时必须在测试数据上验证当前客户端的列表刷新和其他会话继续读取；版本或引用关系无法确认则不启用删除。保留项目 `memory`、配置、文件历史及无法证明唯一归属的资源，并在确认页列出保留量。`history.jsonl` 中的历史提示输入不属于这次删除范围，也不承诺抹除所有历史痕迹。

项目批量清理只是上述会话删除的批处理。Claude 的 `purge` 范围更大，第一版不包装它；Codex 父子会话同时选中时合并集合，避免重复执行和计费式重复记账。

两家会话删除都是第一版的交付项，但以已验证版本和结构为边界；不能仅画一个始终不可用的按钮就视为完成。

## 6. 分析的数据模型与完整度

### 四个可对账层次

1. **来源总量**：根目录逻辑字节数、文件数、分配字节参考值、扫描错误。
2. **目录/类别**：会话、历史数据库、图片附件、临时文件、缓存、插件运行时、配置/记忆、其他。
3. **项目**：可明确归属的会话和附件，另列共享、未归属数据。
4. **会话**：主会话、子会话、文件组成、最近活动、记录/Token 等使用情况。

每个文件只属于一个存储类别；一个物理文件只计一次。项目小计 + 共享 + 未归属应能与来源总量对账，允许明确列出的扫描误差。数据库实际文件大小放在共享项，不按行数平均摊给项目。可选展示项目对应数据库 payload 的估算值，但注明“包含在共享数据库内，不参与小计相加”。

项目标识优先来自明确项目元数据和会话 `cwd`，路径存在时规范化，路径已经不存在时保留原始身份。不能把 Claude 的连字符编码目录名反解成真实路径。工作树默认分开列出，不自动递归扫描所有 Git 仓库；跨 cwd 会话保留全部观察到的路径，主归属取显式项目元数据或首个有效 cwd，无法判定则进入未归属。

Codex 合并磁盘扫描与 SQLite 只读索引；数据库缺失、锁定、模式未知时降级到文件，并标注缺少哪些信息。只读连接不得创建或迁移库；WAL 场景使用 SQLite 自身的一致性读取，不使用忽略 WAL 的方式伪造静态快照。

### 使用情况

提供按来源、项目、会话、日期和模型的会话数、主/子会话数、用户消息数、工具调用数、最后活动时间，以及可获得的 Token 用量。会话首末时间差只称“时间跨度”，不称实际工作时长。

Token 适配器区分逐请求增量与累计快照，优先同版本的权威 usage 记录；按请求/消息 ID 去重，累计快照只取同一计数区间最终值或可靠增量。缓存 Token、reasoning Token 若已包含在总量内，不再次相加。不同模型或计数重置时分段。

缺失数据显示未知，不能填成 0。分叉、导入或子会话中无法可靠去重的继承 usage 标记为不确定，不加入“已验证总量”；展示已解析文件数和用量覆盖率。工具调用与消息数也需按事件身份去重，不能把所有 JSONL 行数当消息数。

保留两种清楚的时间含义：**分析**显示当前仍保留的数据；**统计**显示 cc-clean 历次清理收益。会话删掉后，当前使用分析会减少；第一版不额外建设完整的永久使用量档案。

### 字段与重复项

记录类型按整行实际字节统计；字段贡献按选定层级估算序列化字节，父字段和子字段不能再次相加。样本估算必须标注样本量，不能冒充全量扫描。重复图片通过内容摘要识别，报告潜在机会而不直接把重复量算作可节省量。

### 扫描性能

先 `stat` 得到目录占用，再按需读取项目/会话元数据；只有使用量、字段分析需要深度流式解析。支持取消、逐批显示结果和完成度。缓存以规范路径、设备/inode、size、mtime/ctime 和解析器版本失效；缓存只存汇总、必要 ID 和路径，不复制对话正文或 Base64。

首版建议文件扫描并发 8、会话解析并发 2、图片压缩并发 1；大行和图片解压量设置上限并报告跳过，禁止无界 `readFile` 读取整批会话。中断、权限错误和坏行都让报告显示“部分完成”，不得把未扫描文件统计成 0。缓存设容量上限，超限淘汰最旧条目；历史账本不随缓存淘汰。

## 7. 清理执行与数据保护

两个入口都经过同一条路径：

```text
无脑清理 ─┐
          ├─ 生成计划 → 核对范围 → 记录执行意图 → 执行 → 复测 → 保存收据
分析清理 ─┘
```

计划绑定来源根目录、规则/客户端版本、精确目标、已展开的依赖，以及设备/inode、size、mtime/ctime 等指纹。执行前重新检查；发生变化就跳过或重新预览，不复用过期计划。

原地文件变更采用保守的活动检测：发现该来源客户端/写入服务仍运行，或无法可靠判断时，跳过该来源的直接删除、PNG 改写和会话删除，提示关闭相应程序后重试。分析始终可用。第一版 macOS 的进程及打开文件检查需实际验证；cc-clean 自己的锁不能替代客户端检查，也不终止用户进程。操作期间再次发现外部写入就停止后续变更。

单次只允许一个 cc-clean 变更任务，锁文件在工具目录。只读分析可以并行，但显示可能受清理影响的快照状态。执行路径检查必须抵抗符号链接替换和路径越界；仅字符串前缀匹配不够。

所有 staging 文件放在 `~/.config/cc-clean/providers/<provider>/work/<operation-id>/`。原子替换要求来源与 staging 同一文件系统；不满足就跳过文件变更并说明原因，不进行跨盘非原子覆盖。大文件操作前检查工作空间余量。

直接删除先将目标移入该工作目录，记下状态，再永久移除；移动本身不算释放。PNG 先完成压缩与一致性验证，保留事务期间的原文件副本，再原子替换。成功收据落盘后删除事务副本；首版不长期保留备份，也不提供撤销功能。Pending transaction copies prevent the operation from contributing to verified savings.

Codex 官方删除使用独立子进程路径，不假装能通过移动几个文件回滚整个数据库操作。执行前记录完整意图和前快照，执行后记录结果；子进程超时则结束本工具启动的进程，保留“待核对”状态，复查后才决定结果，不能盲目再次删除。

记录采用 `prepared → applied → finalized` 状态：写入意图并刷新磁盘后才开始变更；完成记录按临时文件 + 原子重命名保存。启动时先核对未完成任务：暂存中的删除目标可以恢复原路径；已替换 PNG 用前后摘要识别；原生删除核对目标与索引。证据不足的操作标为待核对，不能编造成功或重复累计。

Ctrl+C 停止领取新任务，尽量完成当前文件的安全收尾并保存部分成果；意外终止走同一恢复机制。工具目录权限默认 `0700`，敏感状态文件 `0600`，日志不记录对话、凭据或完整原生命令输出。

## 8. Cleanup history and storage savings

Statistics are based only on actual cleanup executions recorded in `~/.config/cc-clean/cleanup.jsonl`. Opening the app, analysis, previews and cancelled confirmations do not create history. Without cleanup history, totals are zero. Application caches, receipts and transaction files are not subtracted from savings.

Each provider execution records one JSONL entry:

```text
schemaVersion: 1
operationId / provider / root / source: clean | analyze
startedAt / finishedAt
status: completed | partial | failed | interrupted | needs-review
beforeBytes / afterBytes / savedBytes
cleanedRecords
cleanupTypes[]: type, cleanedRecords
needsReview
```

`startedAt` is the execution start time after confirmation, not the preview time. `beforeBytes` and `afterBytes` measure the source directory's logical bytes; `savedBytes` is their difference. Completed session deletions count sessions, including descendants; file deletion and PNG compression count files. Skipped and failed actions do not count. Cleanup types are `delete-sessions`, `delete-files` and `compress-png`. An execution with no eligible actions records zero changes.

Statistics sum verified history entries and display cleaned record counts, operation counts and operations needing review. They do not infer savings from unrelated changes between app launches. Concurrent source-directory writes can affect an execution's measured difference, including making it negative. Logical bytes do not represent physical free space on APFS or other filesystems.

Safety receipts remain separate in `providers/<provider>/operations/<id>.json`, retaining action paths, fingerprints and `prepared → applied → finalized` recovery state. Their `confirmedReductionBytes` is an action-level diagnostic, not the statistics total. Unfinished actions or missing before/after snapshots mark the history entry for review and exclude it from totals. Recovery cannot reconstruct an interrupted operation's original end snapshot; it must leave that measurement unknown.

JSONL writes use the mutation lock and atomic replacement. Recovery updates the same operation ID without adding duplicate credit. Existing receipts without an execution timestamp do not generate retrospective history. Logs contain no message bodies or credentials.

## 9. 文件布局与技术选择

```text
~/.config/cc-clean/
  config.json
  cleanup.jsonl              Measured cleanup history
  mutation.lock
  providers/
    claude/
      cache/                  可淘汰的分析汇总
      operations/<id>.json     执行意图与最终收据
      work/<id>/              仅事务期间的暂存和原文件副本
    codex/
      cache/
      operations/<id>.json
      work/<id>/
```

目录首次真正使用时创建。来源发现优先级：本工具显式配置 → `CLAUDE_CONFIG_DIR` / `CODEX_HOME` → `~/.claude` / `~/.codex`。`config.json` 第一版只需要来源目录覆盖；不做插件系统、动态脚本规则或复杂设置页。工具状态位置固定为用户指定的 `~/.config/cc-clean`，不因 XDG 环境变量另行迁移。

建议最小代码结构：

```text
src/
  cli.ts                     参数和命令路由
  ui.ts                      菜单、列表、报告
  scan.ts                    文件清单与汇总缓存
  providers/claude.ts         Claude 分类、解析及会话删除规则
  providers/codex.ts          Codex 分类、索引及官方删除调用
  clean.ts                   计划、执行、保护和恢复
  png.ts                     有限范围的 PNG 无损重压缩
  stats.ts                   账本与统计口径
test/fixtures/               合成及脱敏的格式样本
```

采用一套小型 provider 约定即可：发现根目录、分类、解析会话、列出支持动作、生成变更计划。共享执行器负责安全检查和记账，适配器负责格式差异；不设计可安装第三方插件的框架。

依赖建议：用 [`@inquirer/prompts`](https://github.com/SBoudrias/Inquirer.js) 负责选择、多选、搜索和确认；参数用 Node 自带 `parseArgs`；文件、流、压缩、摘要、测试使用 Node 内置模块。SQLite 优先评估 Node 24 自带只读能力，不依赖用户额外安装 sqlite3 命令。PNG 第一版不用 sharp；它的常规编码路径涉及位深/色彩处理，`keepMetadata()` 的范围也不能当作任意 PNG 块逐字保留的保证。[Sharp 输出说明](https://sharp.pixelplumbing.com/api-output/)

发布包将 TypeScript 编译成 JavaScript，入口有 Node shebang，`package.json` 声明 `bin: { "cc-clean": "dist/cli.js" }`、Node 版本要求和发布文件白名单。安装后不要求用户本地构建，不执行安装后扫描或清理脚本。`npx` 缓存语义见 [npm exec 文档](https://docs.npmjs.com/cli/v11/commands/npm-exec/)。

本机支持 macOS 作为首版验收平台。其他系统如未具备经验证的活动检测和文件替换保障，只开放分析或明确拒绝变更；不能因为 Node 可以运行就宣布清理兼容。

## 10. 实现顺序与验收

按能独立验收的顺序实施，每步都保留共同的数据口径：

1. **只读分析**：目录分类、总量对账、项目/会话识别、使用量与字段报告、分层菜单和直接命令。
2. **变更与统计基础**：计划、保护检查、收据、恢复与 dry-run。此阶段就打通模拟的两入口记账，不能最后才给某个按钮补统计。
3. **默认清理**：经过验证的 72 小时临时规则、独立 PNG 无损重压缩、结果报告。
4. **分析中的删除**：Claude 会话组和 Codex 官方命令适配，先隔离验证实际级联范围，再开放真实操作。
5. **包验证**：打包后从临时目录安装 tarball，测试与发布后相同的命令入口；不发布 npm。

必要验收用例：

- 临时文件 72 小时边界、正式文件异常、活动写入、符号链接目标、硬链接、目录重叠均按规则处理。
- 大会话、未知记录类型、超长行、残缺末行、缺失 cwd、索引缺失/过期、只读 WAL、权限错误能够降级并明确报告覆盖率。
- 项目、类别与来源总量可对账；共享数据库不重复分摊；累计/重复 usage 不重复统计。
- PNG 测试覆盖透明度、元数据、位深、损坏 CRC、APNG、已充分压缩和资源上限；解压扫描行摘要不变且输出确实更小时才替换。
- 相同目标分别经 `clean` 和分析清理，得到一致的执行与记账；并发外部写入不会被算成本工具收益。
- 在暂存、替换、原生命令返回、收据写入和副本清除等位置模拟中断，重启后不丢原文件、不重复计数；不确定结果保持待核对。
- 所有格式破坏性测试使用合成/脱敏副本；Claude / Codex 会话删除兼容性测试使用隔离的数据根目录和可丢弃会话，不向用户现有历史做探针。
- 本机当前版本需要验证删除后列表、剩余会话继续读取、关联资源边界；只有 `--help` 能输出不算删除兼容性通过。
- 打包验证使用 `npm pack` 后的本地 tarball，例如 `npm exec --package=/absolute/path/cc-clean-<version>.tgz -- cc-clean --help`，不提前调用未发布的公共包名。

尚需后续产品决定的唯一压缩内容规则：**哪些会话字段允许丢弃，以及是否接受有损图片压缩。** 第一版按“不丢弃未定义字段、不有损”实现；这两项不阻塞上述已定义功能的设计。
