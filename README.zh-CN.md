# dsh-orquestrator

[![ci](https://github.com/frederico-kluser/dsh-orquestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/frederico-kluser/dsh-orquestrator/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH: 0.1.6-alpha.2](https://img.shields.io/badge/DSH-0.1.6--alpha.2-tested-blue.svg)](https://github.com/deepseek-ai/deepseek-harness)

**自己选定子代理运行的模型——附带推理力度上限和输出 token 上限——在代码层面对 DSH 启动的
每一个子代理强制执行，无论它由哪个工具启动。**

```sh
dsh plugin --profile web add github:frederico-kluser/dsh-orquestrator
```

[English](README.md) · [Português (Brasil)](README.pt-BR.md) · 中文

这是一个 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件。当你发出一个新任务时，
一个采用 DSH 原生外观的对话框会问你一个问题：

**子代理要不要用与主代理不同的模型**运行？

如果要，你就挑一个模型，插件会对该会话中 DSH 启动的每一个子代理在**代码层面**强制执行：
不只是 `subagent` 工具，还包括 `workflow` 启动的代理、`ralph` 的轮次、一次性后台任务和代理团队。
主代理无法用话术绕过它：这不是给模型的一条指令，而是插件本身守在 DSH 启动子代理的必经之门上。
参见[覆盖哪些委派](#覆盖哪些委派)。

每个受管子代理还会带上**推理力度上限**和**输出 token 上限**，因为 DSH 否则会让换了路由的子代理
按该路由的默认值运行（很多环境里是 `max`）：这正是子代理把整份预算烧在一个边界情况上的原因。
参见[推理力度](#推理力度)。

从 0.8.0 起，插件还附带一个**全局 agent 技能** `orchestrate-subagents`，对话框里有一个对应的
复选框，默认勾选：勾选后，消息会带着 `/orchestrate-subagents` 发出，DSH 会为该任务加载这个技能的
指令。它教主代理把工作拆成小块、并行运行子代理、派子代理去读代码而不是自己读，并用校验子代理
复核每个结果。参见[编排技能](#编排技能)。任务页的子代理列表现在还显示每个子代理所用的模型
和一个状态图标（运行中、已完成、失败）。参见[子代理列表的模型与状态](#子代理列表的模型与状态)。

**Cancel、Escape 和关闭按钮现在含义相同：放弃发送**——什么都不发出，不出现消息气泡，已输入的
文字作为草稿留在输入框里。只有"Send with these options"（按这些选项发送）才会真正发送。
DSH 的其他一切都原样不变。

| 深色 | 浅色 |
| --- | --- |
| ![对话框，深色主题](docs/img/modal-dark.png) | ![对话框，浅色主题](docs/img/modal-light.png) |

从输入框自己的列表里挑好模型之后：

![已选定子代理模型的对话框](docs/img/modal-filled.png)

> **0.5.0 移除了独立审查者**——0.2 到 0.4 版本在模型选择旁边提供的那个。约束模型的部分保留了
> 下来，如今它是插件唯一的机制。为 0.4 保存的选择和补丁文件继续可用（审查者的字段会被忽略，
> 并给出警告）。原因见[为什么移除了审查者](#为什么移除了审查者)。

## 安装

```sh
dsh plugin --profile web add github:frederico-kluser/dsh-orquestrator
dsh --profile web            # (re)start it: see the note below
```

**安装或更新之后要重启 `dsh`，而不只是刷新页面。**插件的宿主端在 `dsh` 启动时加载，浏览器端在
页面加载时加载，所以只刷新页面会让旧宿主端继续运行（旧守卫也随之留下）。从 0.5.1 起，两端在
混搭状态下也能与 0.2 到 0.4 的两端互通（为此链路上会保留一个停用的 `reviewer` 块），所以混搭
状态仍能保存；在此之前会报错"config does not match the expected shape"。

从本地克隆安装：`dsh plugin --profile web add /path/to/dsh-orquestrator`。

在 **DSH 0.1.6-alpha.2**（Node 24、pnpm 11）上测试通过。仓库中已提交的 `lib/` 就是构建产物，
因此安装不需要任何构建步骤。

## 使用

在输入框里输入任意内容并发送。对话框会在你发送**每一条**消息之前出现——纯文本、`@file` 引用或
`/skill` 调用都一样，任何会话里都一样，即使一轮对话正在进行时也一样：

- **子代理模型**：打开开关，然后从输入框模型选择位所用的同一个按提供商分组的列表里挑一个模型。
  它对每个子代理生效，包括 workflow 启动的代理。关闭则表示子代理沿用主代理的模型。对话框会为
  需要提示的模型显示简短的、标注日期的备注（例如：MiMo-V2.6-Pro 在高力度下单轮可能耗时数分钟；
  GLM 5.3 仅支持文本）。
- **推理力度**（模型选择器正下方的一个下拉框，始终可见——不再有需要展开的区块）：只列出所选模型
  真正提供的力度档位，从低到高，外加一个中性的 `Model default`。选择或更换模型时，下拉框会立刻
  跳到该模型的**最高**档位；想要更低就自己改。你上次确认的档位会预填进下一个对话框（即使模型的
  档位阶梯还在加载也不会丢）。开关关闭时下拉框依然可用：在那里选的档位是仅限力度的选择（子代理
  沿用主代理的模型，但受该上限约束）。
- **模型能理解什么**（力度下拉框下方的一条小信息带）：四个标记——音频、图片、文本、视频——当所选
  模型支持该类输入时点亮，外加它的头条分数：官方 Terminal-Bench 4.0 排行榜收录该模型时显示
  `Terminal-Bench 4 · 41.8%`（一份烘焙进构建的快照），否则显示 OpenRouter 的智能指数
  `Intelligence · 39.5`。数据实时来自 OpenRouter 的公开模型目录（无需密钥、不走代理）；无法解析
  的模型不显示这条信息带。

  ![模型能理解什么：音频、图片、文本、视频——以及 Terminal-Bench 4 分数](docs/img/model-facts.png)
- **编排技能**（一个复选框，默认勾选；仅当插件宿主端已注册该技能时显示）：把全局技能
  `orchestrate-subagents` 应用到这条消息。消息会带着 `/orchestrate-subagents` 标记发出，DSH 会把
  该技能的指令注入到这一步。取消勾选则不带该技能发送消息；对话框会记住你上一次的回答供下条消息
  使用。无论子代理模型开关处于什么状态，它始终可见、可切换。如果消息里已经含有该标记（你自己
  输入的），复选框会显示为勾选并锁定，因为 DSH 反正会加载该技能。参见[编排技能](#编排技能)。
- **没有"不再询问"**：模态框会在你发送每条消息时弹出，没有任何办法让它闭嘴。一次回答绝不会让
  它在后续消息或另一个会话中消失。上次确认的选择只是预填对话框。
- **Cancel / Esc / ✕**：放弃发送——什么都不发出，不出现消息气泡，已输入的文字作为草稿留在输入框
  里；不存储任何内容。只有"Send with these options"才会发送。

`/orquestrar` 可随时打开同一个对话框（用于修改或清除已保存的选择）。

输入框下方有一个小徽标（`conversation.composer.dock` 那一行）始终显示当前会话的编排设置——选了
模型时是 `Subagents: <model> · <effort>`，没选时是 `Subagents: same as the main agent`——点击它会
打开同一个对话框。

没有什么能跳过对话框：只有空发送会直接放行。早期版本会跳过 `/` 开头的行、一轮对话进行中发送的
消息和子代理会话，于是每个以技能调用（`/skill ...`）开头的任务都完全不经对话框就发了出去；
从 0.6.0 起，无论消息长什么样都会问这个问题。

## 覆盖哪些委派

DSH 启动子代理的途径不止两个 `subagent` 工具。所有途径都要经过两扇门：`SubagentRuntime.start()`
和 `startContinuable()`，而**启动守卫**（`src/guard.ts`）就守在这两扇门上。对于已有确认选择的会话
（自己保存的、继承自祖先会话的，或来自 `defaults`），它会为每个子代理规划：所选的路由、用户要求
的力度或该模型的上限，以及输出 token 上限，并作为子代理的 `agentOptions` 交给 DSH。

| DSH 如何启动子代理 | 模型、力度上限、token 上限 |
| --- | --- |
| `subagent` 和 `subagent_fork` 工具（标准预设） | 是 |
| `subagent` 作为一次性后台任务（`backgroundMode: one-shot`、`run_in_background: true`） | 是 |
| `workflow` 工具：脚本里的每一个 `agent()` 调用 | 是 |
| `ralph`（标准预设中关闭；它跑在 workflow 引擎上） | 是 |
| 代理团队（实验性） | 是 |
| `codex`、`claude-code` 和 ACP 提供商 | 否：它们在自己的模型上运行自己的代理，不接受任何代理选项（插件对每个提供商记录一次警告） |
| DSH SDK 提供商（一个独立的 DSH 子运行时） | 选了子代理模型时为是（它会采用该路由、力度和 token 上限）；没选模型时其子代理沿用提供商自己的模型 |

在三个目标模型上实际跑过的有：`subagent` 工具（前台和后台）、`subagent_fork`，以及 `workflow`
工具（分别配默认的 `override`、`keep` 和关闭强制执行），既有 headless，也有通过真实浏览器里的
对话框。其余各行由它们使用的那两扇门推导而来，而这些门由契约测试对照 DSH 源码钉死（`ralph`
跑在 workflow 引擎上，一次性任务和代理团队调用 `start` / `startContinuable`，SDK 提供商接受代理
选项）。没有任何一次实跑用到一次性后台任务、`ralph`、代理团队、SDK 提供商或
`codex` / `claude-code` / ACP。

为什么用守卫而不是工具包装器：包装器永远看不到 `workflow` 调用的代理，因为引擎是通过服务自身
启动它们的。在暴露这个问题的那次会话里，34 个 workflow 代理以 `max` 力度跑在 Claude Sonnet 5.5
上（约 720 万输出 token、12.6 亿缓存读取 token），尽管子代理已确认使用 DeepSeek V4.1 Flash。
0.3 及更早版本都有这个漏洞；[验证页面](docs/validation/README.md)在一个隔离的 DSH 上复现了它，
并展示了漏洞已被堵上。

受管子代理得到什么：用户选的模型、用户选的力度（或该模型的上限）和输出 token 上限。主代理从不
被改动，没有确认选择的会话也从不被改动。

如果你确认的模型不见了（你确认之后被改名或从 DSH 设置里移除），子代理的启动会被拒绝，并附带
说明和处理办法（执行 `/orquestrar`，或取消对话框）的报错消息。其他方案更糟：让子代理跑在主代理
的模型上，正是这套设计要防的 bug；而强行走已失效的路由，会让每个 workflow 代理静默失败成
`null`。

调用方自己指定的模型（workflow 脚本里的 `agent({ provider, model })`）默认让位于用户的选择
（`children.explicitModel: override`）：对话框是用户的明确指令。`keep` 则保留调用方的模型，但受
同样的上限约束。只定了力度没定模型（仅有 `defaults.workerEffort`）时，子代理沿用主代理的模型并
受该档力度约束，脚本自己指定的模型也保留。

## 编排技能

插件加载时会向 DSH 的技能注册表注册一个技能：`orchestrate-subagents`
（[`skills/orchestrate-subagents/SKILL.md`](skills/orchestrate-subagents/SKILL.md)）。它由插件注册，
而不是复制进某个 skills 目录，所以只要装上插件，每个会话的每个任务就都有它。

它教给负责协调的那个代理（绝不是子代理；技能文本自己写明了这一点）的内容：

1. **先把任务拆成小块**，写成一份带依赖关系的计划，每块都值得派一个子代理（同一类的琐碎项打包
   处理，而不是一项一个代理）。
2. **能一起跑的都一起启动**：一条消息里发多个 `subagent` 调用，慢的块用后台任务，很多块同构时用
   一个 `workflow` 脚本。
3. **并行的块共享同一个工作树**：每个文件只有一个归属者，多个块都需要的文件本身作为一块先做，
   改动代码前先记录测试基线，提交、stash 和依赖变更只在任务要求时才做。
4. **不要自己读代码。**派子代理去读并回答问题，要求给出 `path:line` 引用、把事实和猜测分开、
   限定篇幅，这样一份报告只花很少的上下文。
5. **不要自己写或运行任何东西。**编辑、构建和测试都归子代理。
6. **用另一个子代理来校验**，在该块完成后启动，给它需求和该查的位置，而不是作者的报告；只读的
   结论交给一个试图推翻它的读者。最后由一个终审校验者检查整个改动。
7. **分轮修复，然后停手**：每块最多两轮，然后报告还有什么没修好。
8. **凭证据汇报**：证明了什么、由哪条命令证明，以及哪些没有验证。

它还带有简报模板（目标、范围、不做什么、上下文、完成标准、汇报格式）、校验者简报，以及要求每个
子代理遵守的固定汇报格式。定稿之前，它的措辞在四个假想任务上试过（一次代码改动、一个只读问题、
一处一行笔误、一次 40 文件的迁移），暴露出的粗糙之处就写成了现在的规则 3 和规则 6。

它通过三种途径到达任务，全部是 DSH 原生机制：

| 方式 | 发生什么 |
| --- | --- |
| 对话框的复选框（默认勾选） | 消息发出时会在末尾单独一行带上 `/orchestrate-subagents` 标记（放在末尾，是因为 DSH 用第一条消息的前五个词给会话命名；不足五个词的首条消息仍会把标记带进标题）。DSH 的技能触发机制识别到它，就把该技能的完整指令注入到那一步，最贴近模型的回答。转录里能看到这个标记，因此你可以看出哪些消息带了技能。 |
| 你自己输入 `/orchestrate-subagents`（任何 profile，包括 headless） | 同样的触发机制。 |
| 模型自己的选择 | 该技能列在模型的技能目录里，因此当任务明显匹配时，主代理可以用 `skill` 工具加载它。`skill: { modelInvocable: false }` 会让它不出现在目录里，此时只有标记能加载它。 |

只有当宿主端已注册该技能，并且掌管 `/name` 触发机制的 DSH 插件 `dsh-tool-skill` 已加载时，复选框
才会显示（对话框会询问宿主），因此宿主端早于 0.8.0 的页面，或者没有 DSH 技能注册表、没有那个插件
的组合，绝不会发出一个无人展开的标记。当你在子代理自己的会话里与它对话时也不会显示：这个技能是
给负责协调的代理的，收到它的子代理会试图去协调。`skill: false` 会关闭注册，复选框也随之消失。

![一条带了该技能的消息：标记独占最后一行，以及 DSH 注入技能（"Context injection"各行）](docs/img/skill-transcript.png)

技能文本在构建时嵌入 `lib/index.js`（`pnpm run gen:skill` 从 Markdown 渲染出
`src/skill.generated.ts`，两者不一致时测试会失败），所以安装后的插件从不从磁盘读取它；该文件只是
作为技能的路径交给 DSH，以便转录能打开它。要在另一个 agent harness 里用同一份文本，把该目录链接
到那个 harness 自己的 skills 目录（Claude Code：`ln -s <clone>/skills/orchestrate-subagents ~/.claude/skills/orchestrate-subagents`）。不要链接到 `~/.agents/skills` 下面：DSH 也会读取那个目录，
结果只是在每次构建目录时记一条日志，说插件自己的注册排在那份副本之前。

**它是指令，不是强制。**模型、力度上限和 token 上限是启动守卫在代码层面施加的，而技能只是要求
模型按某种方式工作，模型可以无视它，尤其在长对话的后段。它不屏蔽任何工具：主代理仍然可以读写
文件。如果"主代理绝不能碰代码"很重要，那是会话的权限预设该干的活。

## 子代理列表的模型与状态

任务页在标题栏的下拉框里列出它的子代理（标题旁边的计数）。从 0.8.0 起每一行还显示：

- **模型**：子代理运行所用的模型，以行下方的小标签显示（`DeepSeek V4.1 Flash · medium`）：模型名
  取自输入框自己的目录，有推理档位时一并显示。
- **状态图标**：取代 DSH 的圆点：运行中是转圈，完成是勾，失败是红色标记（报错、token 上限、被拒），
  被停止是琥珀色方块，结果未记录是灰色圆点。

![子代理下拉框：一个子代理运行中（转圈），一个已完成（勾），各自标注所用的模型](docs/img/subagent-list.png)

DSH 不记录子代理的结果（它的目录只知道"运行中"和"未运行"），所以由宿主端来记录。它监听 DSH 的
`subagent/start` 和 `subagent/end` 事件——每个进程内子代理无论由哪个工具启动都会发出——并把每个
子代理最近一次运行的模型、状态和停止原因保存在 `<stateDir>/subagents.json`（仅属主可读写，保留
最近 2000 条）。页面通过 `GET /dsh-orquestrator/subagents?sessionId=<id>` 读取它，与配置路由
受同一道信任围栏保护。在 0.8.0 之前运行过、或在插件未加载时运行过的子代理没有记录：它的那一行
显示 DSH 自己知道的模型（如果知道），以及一个灰色圆点，绝不会编造一个"已完成"。

行上的模型优先取 DSH 自己为该子代理会话报告的值（`lastUsed`），没有时取宿主在运行开始时记录的值。
宿主在运行结束时修正记录的能力只限于一次性子代理：DSH 会在宣布结束之前释放可续接的子代理（标准
预设的 `subagent` 和 `subagent_fork` 工具默认启动的那种），此时代理已经不在了，所以记录保留的是
运行开始时请求的路由。它的状态和停止原因仍会被记录。

DSH 的下拉框无法通过插槽扩展，所以浏览器端从外部装饰它的行：它监视菜单出现，从 DSH 自己的会话
存储推断每一行对应哪个子代理，并往行里加两个小元素。它是故障开放（fail-open）的（任何意外情况
都原样保留 DSH 的行），只读取 role 和结构，绝不读取类名，并在插件卸载时移除它添加的一切。它依赖
的 DSH 结构被契约测试钉死。

## 配置

所有配置都是可选的；不做任何配置时，插件在用户确认对话框之前什么都不做。向你 profile 的
`cordis.patch.yml` 添加覆盖项（一个 patch 会替换该行的整个 `config`）：

```yaml
- id: orquestrator
  config:
    # Headless/TUI/SDK sessions have no dialog: apply this to every session.
    defaults:
      subagentModel: { provider: azure-opencode, model: DeepSeek-V4.1-Flash }
      workerEffort: medium           # optional; absent = the recommended level for the model
    effort:                        # ceiling on the reasoning effort of every subagent; false turns it off
      worker: medium
    limits:                        # output tokens per model request, reasoning included; false = no cap
      workerMaxTokens: 64000
    children:                      # the start guard; false switches the enforcement off (the dialog still stores choices)
      explicitModel: override      # override | keep: a model the caller names itself, e.g. agent({ model }) in a workflow script
    skill:                         # the global orchestration skill; false = do not register it (the dialog then has no checkbox)
      modelInvocable: true         # list it in the model's skill catalog; false = only the /orchestrate-subagents token loads it
    persist: true                  # remember choices and subagent outcomes across restarts
    stateDir: /home/me/.dsh/dsh-orquestrator   # an absolute path: "~" is not expanded
    maxSessions: 500               # stored sessions before the oldest are pruned
```

0.4 及更早版本中属于审查者的字段（`tools`、`reviewerProvider`、`reviewerContext`、
`structuredVerdict`、`workerHandoff`、`maxWorkerReportChars`、`retryOnTokenLimit`、
`workspaceChecks`、`sensitivePaths`、`defaults.reviewer`、`effort.reviewer`、
`limits.reviewerMaxTokens`）会被忽略并在 DSH 日志中给出警告，所以现有的补丁文件仍能加载。

### 推理力度

DSH 从父代理解析子代理的选项，当路由变更而没有指定力度时，它会清掉父级的档位，让新模型"自己
解析默认值"。在路由写着 `reasoning: max` 的环境里，这意味着每个换过路由的子代理都以 `max` 思考，
并以该路由声明的完整输出上限（本插件所基于的那批路由是 131K 到 943K token）为限。

因此插件向 DSH 查询该模型自己的档位阶梯，并施加**上限**，从不直接下设置：本身已在上限之下的路由
保持不变，跳档的阶梯（GLM 5.3 只提供 `low`、`high`、`max`）取不超过上限的最高档。`off` 绝不会被
单独选中。上限按以下顺序取：对话框里选的档位（它可能高于上限）、`effort.worker`、
[`src/models.ts`](src/models.ts) 中该模型的行（标注日期和出处），以及 `medium`。

| 模型 | 子代理上限 |
| --- | --- |
| DeepSeek V4.1 Flash | `medium` |
| MiMo-V2.6-Pro | `low` |
| GLM 5.3 / GLM 5.3 Flash | `high` |
| Claude Sonnet / Opus | `high` |
| 其他模型 | `medium` |

`limits` 限制单次模型请求的输出 token（含推理），并且只会在已知该模型具备的上限上往下调。
这些数值为什么这样取、哪些研究建议被略去以及原因：[docs/estudos/](docs/estudos/README.md)。

## 限制

- **编排技能是指令，不是强制。**模型、力度上限和 token 上限是在代码层面施加的；技能只是要求模型
  拆分、并行、把读代码委派出去并做校验，模型可以无视它，尤其在长对话的后段。它不屏蔽任何工具
  （主代理仍然可以读写文件），而且只有主代理收到它：子代理只看到主代理写的简报，所以技能要求主
  代理把汇报格式和校验规则写进简报。每勾选一次复选框，技能文本（约 1,800 token）就再注入一次，
  所以简短的追问请取消勾选。**编排要花时间和 token。**在一次实测中（每种做法各采样一次，主代理
  为 GLM 5.3）一个三文件任务用技能花了 374 秒、约 108 万 token（一份计划、两个编写者并行、一轮
  修复、一个独立校验者），而主代理独自做完同样的工作只花 9.5 秒、8.8 万 token；两边结果都正确。
  当任务大到值得并行且需要独立检查时，技能才划算；小任务请取消勾选。
- **子代理的状态只对插件加载期间启动的子代理可知。**更早的只显示 DSH 知道的模型和一个灰色圆点。
  更新插件后，重启 `dsh` 并重新加载页面：在宿主端拥有新路由之前加载过的页面只请求过一次，拿到
  404，之后不会再问（直到重新加载）；那时它的行会把 DSH 说在运行的子代理显示为转圈，其余显示
  灰色圆点，模型则显示 DSH 知道的那个。运行在没有自己会话的后端上的子代理（`acp`、`codex`、
  `claude-code`）根本不在 DSH 的下拉框里，因此没有行可标。被取消的子代理显示为已停止，其他任何
  非正常完成的结局显示为失败。
- **下拉框各行上的标记是从 DSH 的封闭组件外部加上的。**它们依赖该组件的 role 和结构（挂在页面
  主体上的 `role="tree"` 菜单、`role="treeitem"` 行、状态圆点和内容 span），契约测试把它们对照
  一份 DSH 检出钉死；DSH 改动这些时标记会消失，DSH 自己的行保持原样。某一行对应哪个子代理，来自
  把行与 DSH 的会话存储比对（行的数量，以及每行的 label 和 title，按顺序）。当两份目录同样匹配
  同一个菜单时（页面上两个会话的子代理具有完全相同的 label 和 title），插件宁可什么都不标也不
  猜测，因此绝不会把另一个会话的子代理装饰到这个菜单上。
- **插件控制用哪个模型、思考到什么程度，但不检查子代理产出的内容。**主代理读到的结果就是 DSH
  一贯交付的样子；如果你想要检查，勾选编排技能（它要求主代理用一个单独的校验子代理检查每一块，
  但那是指令，见上文）、直接要求主代理去校验，或者跑项目自己的测试。（独立审查者过去在代码层面
  做这件事；见[下文](#为什么移除了审查者)。）
- 无法接受代理选项的提供商（`codex`、`claude-code`、ACP）保留它们运行所用的模型；插件记录一条
  警告（每个提供商一次），不碰它们的子代理。跑自己默认路由的提供商（SDK 提供商）在没选子代理
  模型时也不动，因为插件无从知道它的子代理跑在什么模型上。
- **输出 token 上限对 `continuable` 子代理不持久。**当 DSH 稍后恢复一个已结束的子代理（释放之后
  又来了跟进消息，或重启之后），它会从记录的描述符重建子代理的选项，而描述符里有提供商、模型和
  力度，却没有 token 上限。力度上限能留下；上限只对第一次运行生效。要修好它需要再找一个挂接点
  （见 [decisoes.md](docs/estudos/decisoes.md)，N21）。
- 主代理在 `subagent` 调用里指定的模型（DSH 的模型选择，标准预设中开启）在有确认选择时被忽略；
  `override` 把同样的规则应用到其他所有调用方。调用方设定的 token 上限（运维方的工具配置行、
  团队名单）绝不会被抬高：取调用方和插件两者中较小的那个。
- 未知的顶层配置字段会被忽略，并在 DSH 日志中给出警告（否则缩进错了的 `explicitModel: keep`
  会被当成 `override` 运行）。
- DSH 没有围绕子代理启动的钩子（`subagent/start` 在子代理已存在之后才触发），所以启动守卫在服务
  实例上安装自己的 `start` 和 `startContinuable`。契约测试（`test/contract/`）对照一份 DSH 检出
  和一个真实的 `SubagentRuntime` 钉死这个假设，DSH 改动时它们最先失败。它们在备有 DSH 检出
  （`DSH_CHECKOUT`）的机器上运行，不在 CI 里。服务无法被包装时插件加载失败；它绝不会带病工作。
  `children: false` 会移除守卫。
- 推理力度上限和 token 上限只作用于插件管辖的子代理，绝不动主代理。LLM 运行时无法描述但可以调用
  的模型，原样保留用户所选的选项（日志里会写明）；完全无法调用的模型会被拒绝，如上文所述。
- 对话框里的模型建议（备注、上限）是 2026 年 9 月和 10 月的研究得出的带日期数据，几周内就会过时；
  不认识的模型得到通用上限，且没有备注。
- 葡萄牙语和中文文案以词典形式随插件发布。当 DSH（或另一个插件）注册了对应语言时它们才会出现；
  本插件从不自行注册语言，以免与拥有该语言的插件冲突。

## 安全模型

插件不运行子代理的任何代码，也不启动任何自己的进程。它只改变 DSH 启动子代理时使用的选项。
它做的事：在 DSH 信任围栏（Host/Origin 围栏和浏览器认证）之后提供两条路由（配置路由和只读的
子代理路由），带严格的传输校验；把状态保存在仅属主可读写的文件里，其中只有提供商和模型 id、
状态和停止原因，没有凭据（即各会话的选择和子代理台账）；只读地监听 DSH 的子代理生命周期事件；
向 DSH 的技能注册表注册一段静态技能文本；从不读取、写入或转发 API 密钥。它**不**做的事：不提供
沙箱，不过滤网络，不控制进程环境。子代理能做什么由会话的权限预设决定，和没有插件时完全一样。
技能只是给消息加指令；它不授予任何权限。

### 挂接点清单

本插件触及运行中 DSH 的每一个部分，以及在每一处约束它的东西：

| 挂接点 | 插件在这里做什么 | 约束它的东西 |
| --- | --- | --- |
| `SubagentRuntime.start()` / `startContinuable()`（在服务实例上包装，早于子代理存在） | 重写子代理的选项：模型、推理力度上限、输出 token 上限 | 只改这三个字段；只在有确认选择时生效；`children: false` 彻底移除守卫 |
| DSH 子代理生命周期事件 | 只读监听：把状态和停止原因记入台账 | 只读；只写自己的状态文件 |
| DSH web 服务器——恰好 3 条路由（`GET`/`POST /dsh-orquestrator/config`、`GET /dsh-orquestrator/subagents`） | 读取并保存各会话的选择；对外提供只读的子代理台账 | 位于 DSH 的 Host/Origin 围栏和浏览器认证之后；严格的传输校验；任何路由都不执行任何东西 |
| DSH 技能注册表 | 注册一段静态技能文本（`orchestrate-subagents`） | 只是文本；不授予任何权限 |
| 任务页的子代理下拉框（浏览器端） | 向 DSH 自己的行添加两个小标记（模型、状态） | 故障开放：任何意外都原样保留 DSH 的行；只读 role 和结构，绝不读类名；添加的一切都在卸载时移除 |
| 文件系统——`$DSH_HOME/dsh-orquestrator/`（可用 `stateDir` 迁走） | `sessions.json`（选择）、`subagents.json`（台账） | 仅属主可读写的文件；只有提供商/模型 id、状态和停止原因；绝无凭据，绝无你的代码 |
| 网络——仅浏览器端 | 只有一个请求：为"模型能理解什么"信息带拉取 `GET https://openrouter.ai/api/v1/models`（公开目录） | 无密钥、无代理、无遥测、无更新检查，宿主端完全没有对外请求 |
| 凭据（API 密钥） | **什么都不做。**从不读取、写入或转发 | — |
| 进程与子代理代码 | **什么都不做。**不启动任何进程，这里不运行任何子代理代码 | 子代理能做什么由会话的权限预设决定，和没有插件时完全一样 |

（Terminal-Bench 4 的数据不需要网络：它们是发布时烘焙进构建的快照，取自官方排行榜。）

## 供应链

你安装的就是仓库里的东西，而且它非常少：

- **零运行时依赖。**唯一的 peer 是 `@deepseek-ai/cordis`（`>=4.0.0 <5`）；harness 本身从不作为依赖
  ——插件绑定到正在运行的 DSH 所提供的东西。peer 故意用稳定版本区间：预发布的 peer 区间是这个
  生态里已知的 ERESOLVE 陷阱。
- **构建产物已提交。**`lib/` 随仓库发布，因此安装时不运行任何编译器、打包器或下载步骤。仓库里唯一
  的生命周期脚本（`prepare`）通过 husky 安装维护者的 git hooks，不碰工作树之外的任何东西；pnpm
  默认的构建脚本策略在安装时会直接忽略它。
- **tarball 走白名单**（`package.json` 里的 `files`）：两个构建入口、技能文本、`cordis.patch.yml`、
  三份 README、截图、许可证和变更日志。
- **一切都上了锁**：开发工具链由 `pnpm-lock.yaml` 锁定（CI 用 `--frozen-lockfile` 安装），每个
  GitHub Action 都按 commit SHA 锁定。
- **锁定你安装的东西。**每个版本都有 tag；从 tag 而不是不断移动的 `main` 分支安装，就是插件界的
  `--save-exact` 纪律：`dsh plugin --profile web add github:frederico-kluser/dsh-orquestrator#v0.8.3`
  （一个 git-ref 规格；默认解析到 `main` 的最新提交）。

## 为什么移除了审查者

0.2 到 0.4 版本还提供过一个独立审查者：一个检查每个子代理的工作、修复坏掉的部分、并代替子代理把
结果交给主代理的第二个模型。0.5.0 版本移除了它，原因有三：

1. **这是用一个 LLM 评判另一个 LLM。**插件在代码层面强制的东西（跑哪个模型、思考到什么程度、
   最多能写多少）是确定性的，主代理无法绕过。而审查者的 `APPROVED` 只是一种意见，插件只能检查
   它的格式和自洽性。
2. **它的成本大约翻倍，还让每次委派都要等第二个模型**，而且它只覆盖 DSH 启动子代理的两条路径，
   管不到 workflow 的代理。
3. **它需要第二套机制。**审查者要求包装 `subagent` 工具；而仅启动守卫就已管辖所有路径（已实测
   验证，把包装器挪开之后），两者并存只是留下两套达到同一结果的路子。

研究、审查者协议及其背后的决策作为历史留在仓库里：[docs/estudos/](docs/estudos/README.md)、
[docs/pesquisa/padrao-revisor.md](docs/pesquisa/padrao-revisor.md)（葡萄牙语），以及
[docs/estudos/decisoes.md](docs/estudos/decisoes.md) 里的决策 D16。0.4.0 是最后一个带它的版本。

## 验证情况

0.8.0 版本在真实的 DSH 0.1.6-alpha.2 上做了端到端验证，每次运行都在项目的 Mac mini 测试机上、
隔离的 DSH home 内进行，只用 GLM 5.3（主代理）和 DeepSeek V4.1 Flash（子代理）：841 个单元、集成
和契约测试跑了两遍（不含 DSH 检出时为 804 个，即 CI 跑的那套），并在两台机器上得到字节一致的
重建；127 项针对对话框和技能复选框的浏览器检查，包括对 0.7 宿主的链路行为和一条发往子代理自己
会话的消息；146 项跨 20 个页面的子代理列表标记检查，每个状态都通过台账路由驱动，并实跑两个真实
子代理（从转圈到勾，台账与会话日志吻合）；此前五个浏览器阶段重跑全绿；以及一次用真实模型做、
衡量技能改变了什么的 A/B 运行（主代理改为编排两个编写者加一个独立校验者，而不是自己动手，在
一个三文件任务上耗时 39 倍、token 12 倍）。技能文本本身在四个假想任务上做过压力测试，发布前逐条
对照 DSH 源码核实过，三轮独立代码评审修复了一个原本就存在的对话框卡死问题，以及对抗性实验发现
的若干匹配、时序和恶意文件缺陷。证据与发现（包括未覆盖的部分）：
[docs/validation/README.md](docs/validation/README.md)。

## 开发

```sh
pnpm install
pnpm run check          # typecheck + build + tests
pnpm run check:lib      # the committed lib/ must equal a fresh build (run it after committing lib/)
DSH_CHECKOUT=/path/to/deepseek-harness pnpm test   # also pins the DSH seams this plugin uses
```

针对真实 DSH 的实测验证只使用三个目标模型，跑出任何其他模型都会失败：`scripts/e2e/run-workflow.sh`
（`workflow`、`subagent` 和 `subagent_fork` 工具以及启动守卫，headless），由 `session-config.mjs`
读回每个会话被要求的配置；以及 `scripts/e2e/ui-e2e.mjs`（浏览器）。
`scripts/e2e/setup-isolated-home.sh` 构建它们所需的隔离 `DSH_HOME`，`scripts/e2e/with-keys.sh`
只带着三个模型需要的那两个 API 密钥运行它们。参见
[docs/validation/README.md](docs/validation/README.md)。

目录结构：`src/`（宿主端）、`src/client/`（浏览器端）、`test/`（单元、集成、契约）、
`scripts/e2e/`（针对真实 DSH 的 headless 和浏览器运行）、`docs/`（设计、验证，以及 `estudos/`：
研究、其摘要和决策日志）。

## 参与贡献

欢迎贡献——参与流程见 [CONTRIBUTING.md](CONTRIBUTING.md)（fork → 临时分支 → 向 `main` 发起
pull request；Conventional Commits，在提交时强制校验；评审前 `pnpm run check` 全绿），以及所有人
都要遵守的[行为准则](CODE_OF_CONDUCT.md)。漏洞是另一回事：绝不要以公开 issue 提交——请遵循
[SECURITY.md](SECURITY.md) 中的私密流程。

## 许可证

MIT
