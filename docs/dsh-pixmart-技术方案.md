# dsh-pixmart 技术方案

| 项 | 值 |
|---|---|
| 文档版本 | v1.3 |
| 日期 | 2026-10-05 |
| 状态 | **已定稿**（6 项决策已确认；等待 P0 启动） |
| 目标插件 | `dsh-pixmart` —— DeepSeek Harness 电商生图插件 |
| 参考项目 | `E:\Programs\trae\project\pixmart-ai`（**只读，禁止修改**） |
| 工作区 | `E:\Programs\agent\dsh-pixmart` |
| 目标 profile | 先用 scratch profile 验证，最后应用到 `desktop`（需单独确认） |

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [决策记录](#2-决策记录)
3. [范围边界](#3-范围边界)
4. [运行时契约（实测取证）](#4-运行时契约实测取证)
5. [架构总览](#5-架构总览)
6. [仓库结构](#6-仓库结构)
7. [Host 面设计](#7-host-面设计)
8. [Client 面设计](#8-client-面设计)
9. [数据模型](#9-数据模型)
10. [错误处理与边界情况](#10-错误处理与边界情况)
11. [分发与安装](#11-分发与安装)
12. [实施阶段](#12-实施阶段)
13. [验证矩阵](#13-验证矩阵)
14. [风险登记表](#14-风险登记表)
15. [合规与复用边界](#15-合规与复用边界)
16. [已确认决策](#16-已确认决策)
17. [附录](#17-附录)

---

## 1. 背景与目标

### 1.1 背景

`pixmart-ai` 是一个基于 Electron 35 + React 的电商生图桌面工作站，功能覆盖主图/详情图/广告图生成、风格复刻、白底图、无限画布、3D 模型生成、19 家 AI 厂商接入。

DeepSeek Harness（DSH）本身已经是完整的 Agent 宿主 + Web GUI。因此**不需要**再复刻一个桌面壳，而应把「电商生图」这件事拆成两半：

- **能力面**：以插件工具的形式暴露给 Agent，让模型能直接编排「选模块 → 拼提示词 → 生图 → 落盘归档」；
- **界面面**：以 client bundle 的形式挂进现有 GUI 的插槽（设置页 + 作品库），复用 DSH 的主题、设置、会话体系。

### 1.2 目标

在 DSH 里用一句对话完成电商生图：

> 「用这张产品图，生成一套白底首图 + 3 张场景主图，尺寸 1:1」

期望结果：图片生成、落到插件数据目录、在对话工具卡片里可见、在作品库面板里可浏览/导出。

### 1.3 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| A1 | 全新 `DSH_HOME` + scratch profile 下按 README 一条命令装好 | `dsh plugin --profile px add <path>` 成功；`dsh --profile px --dump-config` 出现 `dsh-pixmart` 行 |
| A2 | Agent 能在会话里生图 | 对本地 mock 端点调用 `pixmart_generate`，产出 PNG 落到 `<dataDir>/projects/<id>/images/`，工具卡片内显示图片 |
| A3 | 尺寸预校验 | 不支持的尺寸直接返回最近可用尺寸建议，**不发请求** |
| A4 | 错误路径可诊断 | 401 / 429 / 超时 / 内容审核拒绝 均返回结构化错误；`exec.signal` 中止能在 1s 内取消在途请求 |
| A5 | 批量不串味 | batch 8 项、并发 2 全部落盘，文件名无冲突 |
| A6 | 崩溃可恢复 | 手工损坏 `index.json` 后仍能启动并按目录扫描重建项目列表 |
| A7 | 客户端干净 | 设置页可保存厂商并「测试连接」；卸载插件后 slot / 样式 / DOM 无残留 |
| A8 | 工程质量 | `typecheck` / `test` / `build` 全绿，`git diff --check` 干净 |
| A9 | 生图过程可见（实时预览） | 发起 `pixmart_batch` 期间右下角浮层可见 `3/8` 与逐格点亮的缩略图；结束后收成徽标且**不产生布局位移**；页面刷新后仍能读到该运行的最终状态 |

---

## 2. 决策记录

| ID | 决策 | 选择 | 理由 / 影响 |
|---|---|---|---|
| D1 | 插件形态 | **宿主工具插件 + 客户端 UI（双面）** | 纯工具插件无法管理厂商/密钥/作品库；纯 UI 又无法让 Agent 编排。双面是唯一同时满足「Agent 可用」和「人可管理」的形态 |
| D2 | 首批厂商 | **Ofox**（`https://api.ofox.io/v1`，聚合接入）；协议以 **OpenAI 兼容**为主 | 首轮只接一家、跑通再扩；`baseUrl + apiKey + model` 即可走多模型。**v1.1 修订**：Ofox 的 Gemini 图像模型另需一个 Gemini 原生端点，因此实际实现两种调用形态（见 D8） |
| D8 | Ofox 方言 + Gemini 原生端点 | 适配器增设 `dialect: 'ofox'` 与 `apiMode: 'gemini-native'` | Ofox 兼容端点的参考图字段是 `input_images`、输出格式是 `output_format`；且 **Gemini 图像模型的图生图/参考图保真只在 Gemini 原生端点可用**。按标准 OpenAI 语义写会静默失败（见 §7.4.1） |
| D9 | Ofox API Key | **不预置、不入库、不硬编码**，由用户自行填入 | 联调前 Key 为空；插件必须在无 Key 时给出可读错误并指向设置页（见 §7.3） |
| D10 | 实时预览浮现时机 | **生图开始时自动浮现**（右下角浮层卡） | 不切走当前视图、不占布局轨道；不看时只是一角小卡（§8.5.5） |
| D11 | 生成前确认闸门 | **默认关闭**，`requireConfirmForBatch: true` 时可开启 | 符合"先跑通再收紧"的节奏；需要付费保护时用户主动开（§8.5.6） |
| D12 | 预览卡结束行为 | **收成徽标并保留** | 不消失也不撑大，想看时随时点开；避免布局位移（§8.5.5） |
| D3 | 提示词资产 | **借鉴结构、文本重写** | 沿用参考项目「模块 → 提示词片段 + 默认尺寸」的组织方式，文本全部新写，插件自持版权，不触发 MIT 署名义务 |
| D4 | 密钥存储 | **插件自有数据目录**（不进 patch 层） | `cordis.patch.yml` 是可读明文且会被覆盖重写；密钥走数据目录文件 + 环境变量兜底 |
| D5 | 图片呈现 | **落盘为唯一真相 + 附件服务嵌入对话** | 落盘保证可归档/导出/重放；附件服务让图片在对话里直接可见 |
| D6 | 客户端图片传输 | **只读 HTTP 路由**（非 base64 RPC） | 一张 1024×1024 PNG 的 base64 约 1.4–2.7 MB，网格渲染 20 张会拖垮 RPC；内容寻址文件名可安全长缓存 |
| D7 | 验证 profile | **scratch profile 优先** | 当前 `desktop` profile 正在运行本会话，安装/重启会打断用户 |

---

## 3. 范围边界

### 3.1 做

- 文生图、图生图（参考图保真 / 风格复刻 / 白底图）
- 主图 / 详情图 / 广告图三类模块化提示词
- 尺寸能力校验与最近邻建议
- 批量生成（一批模块项）
- 项目库：归档、浏览、导出、删除、用量审计
- 设置页：厂商/密钥/模型/默认值/提示词覆盖
- 作品库面板：项目列表 + 图片网格 + 预览

### 3.2 不做（v1）

| 不做的事 | 说明 |
|---|---|
| Electron / React 桌面壳 | DSH 已经是壳 |
| 3D 模型生成 | v2 |
| 视频 / 音频生成 | v2 |
| 自建无限画布 | 用普通网格 + 预览弹层替代 |
| Anthropic / 火山 / 百炼的**官方原生协议** | 只保留架构接口，v1 不实现 |
| Gemini 原生协议 | **例外**：Ofox 的 Gemini 图像模型必须走它，故 v1 实现 `apiMode: 'gemini-native'`（仅作为 Ofox 的调用路径，不做通用 Gemini 厂商适配） |
| 图像本地编辑（裁剪/滤镜/旋转） | 交给 Agent 用现成工具或系统能力 |
| 云端同步 / 多机协作 | 不在范围内 |

### 3.3 硬约束

- **不修改** `E:\Programs\trae\project\pixmart-ai` 下任何文件；全程只读。
- host 半**零运行时 import**（只用 `node:` 内建）。
- client 半禁止跨插件值 import，只允许平台模块表内的模块。

---

## 4. 运行时契约（实测取证）

> 以下均为 2026-10-05 在本机实测得到的事实，不是文档推测。

| 事实 | 证据 |
|---|---|
| 插件是 npm 包，`dsh plugin --profile <p> add` 安装；bundle 层由 `package.json` 的 `dsh.bundle.patch` 插入 | profile 内 `dshmarket/package.json` 的 `dsh` 字段 |
| patch 是**顶层数组**，形如 `- insert: [{id, name, config}]`；`id` 是配置树中的稳定身份；后层按 `id` 覆盖前层；覆盖时 `config` 是**整段替换**而非深合并 | `dshmarket/cordis.patch.yml` |
| client 产物必须是 `window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => { ... } })`，`id` 等于 npm 包名 | `dshmarket/client/client.js` 第 1 行实测 |
| 当前宿主**会**投影插件 Config schema（`Config.listConfigs` 返回 `status: "schema"`，共 191 条目），因此「设置 → 插件 → 插件配置」可用 | 本次 `Config.listConfigs` 实测 |
| 工具注册签名：`ctx.tools.register(definition: ToolDefinition): () => void`，返回 disposer | 本次 `Service.listService({service:"tools"})` |
| `ToolDefinition` = `ToolSchema { name, description, parameters }` + `output: { schema, render }` + `execute(args, exec)`，另有可选 `presentCall` / `presentResult` / `finalizeContent` | 同上，referencedTypes |
| 图片持久化：`ctx.attachments.saveImages([{data, mediaType, name}])` → `ImageAttachmentRef`（内容寻址、已归一化、带宽高） | 本次 `Service.listService({service:"attachments"})` |
| 可注入宿主 Service：`tools` / `attachments` / `webServer` / `commands` / `systemPrompt` / `storage` / `credentials` / `fs` / `timer` / `web` 等 | 本次 `Service.listService` 目录 |
| 客户端插槽：`settings.section`、`settings.plugins.tab`、`sidebar.panellist`、`main`(keyed)、`conversation.chat.turnTail`、`conversation.input.left/right`、`shell.overlay`、`tool.call.toolview`(keyed by 工具名) | 本次 client `Slots.listSubTree` |
| ~~client 半可用内建含 `host.call(method, args)`~~ → **P0 实测修正**：`host.call` 只属于**动态 client 半**；包式 client 半的 `factory(require)` **只收到 `require`**，与宿主通信必须走本插件自己的 HTTP 路由 | [contract-notes §3.1/§3.2](./contract-notes.md) |
| 插件数据目录惯例：市场插件用 profile 下的 `.dsh-market`；本插件用 `$DSH_HOME/pixmart` | `DSH_HOME=C:\Users\30461\.dsh`（环境变量实测） |
| **Ofox 端点契约**：OpenAI 兼容 `https://api.ofox.io/v1`；Gemini 原生 `https://api.ofox.io/gemini/v1beta`；方言细节与模型 fallback 见 §7.4.1 | 参考项目 `src/main/services/openai.ts` + `src/renderer/src/types/model.ts`（**只读取证**） |
| 契约细则（inject 语义、effect 所有权、slot 四步契约、client import 纯度、验证矩阵） | [DSH 插件开发 Skill v3.1.0](https://github.com/NanmiCoder/dsh-agent-teams/blob/v0.1.15/skills/dsh-plugin-development/SKILL.md) |
| 官方开发者预览仓库（MIT，兜底取证源） | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) |

### 4.1 取证路径说明

> **P0 新增取证与修正**（`fs`/`credentials` 的就绪时机、`host.call` 的归属、`defineTool` 的等价性、图片块形状）见 [contract-notes.md](./contract-notes.md)。该文件与本节冲突时，**以 contract-notes 为准**。

本机 DSH 代码打包在 `resources\app.asar` 内，`dsh/` 目录不可直接读。因此：

1. **优先级 1**：本机已装插件的实际产物（`dshmarket` 是目前唯一完整的双面插件样本，已实测其 host/client 入口与产物包装）。
2. **优先级 2**：`cordis_inspect_*` 工具读运行时活契约（本次已用于核验 Service / Event / Slot / Config）。
3. **优先级 3**：浅克隆官方仓库只读分析（`raw.githubusercontent.com` 本次直连失败，见 R6）。
4. **兜底**：信息仍不足时，选择可安全失败的最小实现，并在 `docs/contract-notes.md` 标注假设。

---

## 5. 架构总览

```
┌─────────────────────────────── DeepSeek Harness ───────────────────────────────┐
│                                                                                │
│  Web GUI (浏览器)                                       Host 进程 (Node)         │
│  ┌──────────────────────────────┐                    ┌───────────────────────┐  │
│  │  dsh-pixmart client 半        │  HTTP /pixmart/api │  dsh-pixmart host 半   │  │
│  │  ├ settings.section 设置页    │ ◄────────────────► │  ├ ctx.tools.register │  │
│  │  ├ sidebar/主面板 作品库      │                    │  ├ /pixmart/* 只读路由 │  │
│  │  └ shell.overlay 实时预览卡   │                    │  ├ 项目库 (JSON+文件)  │  │
│  └──────────────────────────────┘                    │  ├ 运行注册表 (runs)   │  │
│           │  HTTP GET 图片字节                        │  └ OpenAI 兼容适配器   │  │
│           └──────────────────────────────────────────┤        │              │  │
│                                                       │        ▼              │  │
│  ┌──────────────────────────────┐                    │  $DSH_HOME/pixmart/    │  │
│  │  Agent 会话                   │  ctx.tools.execute │  config.json          │  │
│  │  └ 工具卡片（内嵌生成图）      │ ◄───────────────── │  index.json           │  │
│  └──────────────────────────────┘                    │  usage.jsonl          │  │
│                                                       │  projects/<id>/images │  │
│                                                       └───────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────┘
                                                                  │
                                                                  ▼ HTTPS
                                                    OpenAI 兼容端点（聚合/自建）
```

### 5.1 关键数据流

**生图（Agent 发起）**

```
Agent → pixmart_prompt (dry run，先看后花钱)
      → pixmart_check_size (校验尺寸)
      → pixmart_generate
          ├ 解析 provider/model → 取密钥（env > dataDir）
          ├ 提示词拼装 (module + vars + overrides)
          ├ HTTP 请求 + AbortSignal 联动 exec.signal
          ├ 字节落盘 projects/<id>/images/<sha8>-<slug>.png
          ├ ctx.attachments.saveImages → ImageAttachmentRef
          └ 返回 { files, attachments, usage }
      → output.render 输出紧凑文本 + 图片块 → 对话卡片可见
```

**浏览（人发起）**

```
设置页/作品库 → fetch('/pixmart/api/projects', {cache:'no-store'}) → 项目元数据
             → <img src="/pixmart/file/<projectId>/<name>"> → host 只读路由 → 磁盘字节
```

---

## 6. 仓库结构

```
dsh-pixmart/
├── package.json              # name/type/exports/dsh 字段
├── cordis.patch.yml          # bundle 层插入声明
├── tsconfig.json             # host program
├── tsconfig.client.json      # client program (react-jsx)
├── README.md                 # 安装命令（必须经全新 profile 验证）
├── NOTICE                    # 第三方来源与灵感说明
├── src/                      # ── host 半 ──
│   ├── index.ts              # 入口：name / inject / Config / apply
│   ├── config.ts             # schemastery Config schema
│   ├── tools/                # 7 个工具，每文件一个
│   │   ├── providers.ts
│   │   ├── check-size.ts
│   │   ├── prompt.ts
│   │   ├── generate.ts
│   │   ├── edit.ts
│   │   ├── batch.ts
│   │   └── projects.ts
│   ├── vendor/
│   │   └── openai-compat.ts  # 三种 apiMode 的请求构造与响应解析
│   ├── prompts/
│   │   ├── modules.ts        # 模块目录（数据，重写文本）
│   │   └── build.ts          # 片段拼装（纯函数）
│   ├── sizes.ts              # 尺寸能力表 + 校验 + 最近邻
│   ├── store/
│   │   ├── paths.ts          # dataDir 解析与校验
│   │   ├── atomic.ts         # tmp + fsync + rename
│   │   ├── mutex.ts          # 按文件串行锁
│   │   ├── config-store.ts   # 厂商与密钥
│   │   └── project-store.ts  # 项目库 + 索引重建
│   ├── api.ts                # HTTP 路由表（client ↔ host 的唯一通道）
│   ├── routes.ts             # /pixmart/* 只读图片路由
│   ├── log/usage.ts          # usage.jsonl 审计
│   └── types.ts              # 共享类型
├── client/                   # ── client 半 ──
│   ├── index.tsx             # 入口：inject / apply
│   ├── settings-page.tsx     # settings.section
│   ├── workbench.tsx         # sidebar.panellist + main(keyed)
│   ├── api.ts                # fetch 封装（相对挂载点解析，不写死根路径）
│   └── client.js             # 构建产物（ModuleLoader 包装）
├── lib/                      # tsc 产物
├── dist/                     # 打包产物：剥离 __test__ 后的 client bundle（不入库，见 §11.5）
├── test/                     # vitest + mock OpenAI 兼容服务端
├── docs/
│   ├── TECHNICAL-PLAN.md     # 本文件
│   └── contract-notes.md     # spike 结论与逐条取证记录
└── tools/                    # 构建/安装/校验脚本
    └── strip-test-hooks.mjs  # 打包步骤：剥离 client bundle 的 __test__（§11.5）
```

> 上面这份树是最初的规划稿，与当前仓库已有出入（例如 host 工具是
> `src/tools/{ping,meta,generate,batch,projects}.ts`，客户端是单个手写的
> `client/client.js`，测试跑 `node:test` 而非 vitest）。**以实际目录为准**。

### 6.1 分层铁律

| 层 | 允许 | 禁止 |
|---|---|---|
| host 半 | `node:` 内建；宿主注入的 ctx | 任何 `@deepseek-ai/*` 运行时 import；任何浏览器 API |
| client 半 | 平台模块表内的模块（`react`、ui-primitives）；type-only import | 跨插件值 import；直接访问文件系统或外部 API |
| 两者之间 | 本插件自己的 HTTP API（`/pixmart/api/*`）+ JSON | 共享内存、共享模块实例；`host.call`（包式 client 半拿不到） |

---

## 7. Host 面设计

### 7.1 插件入口

```ts
// src/index.ts
import type { Context } from '@deepseek-ai/cordis'   // type-only，运行时零依赖
import { Config } from './config.ts'
import { registerTools } from './tools/index.ts'

export const name = 'dsh-pixmart'

// 必需依赖只有 tools；其余可选，缺失时降级而不是启动失败
export const inject = { required: ['tools'], optional: ['attachments', 'webServer'] }

export type { Config }

export function apply(ctx: Context, config: Config): void {
  registerTools(ctx, config)          // ctx.tools.register(...) 全部包在 effect 内
  registerRoutes(ctx, config)         // ctx.get('webServer') 存在才注册
  registerApi(ctx, config)            // /pixmart/api 路由（client ↔ host 唯一通道）
  ctx.effect(() => startUsageLog(ctx, config), 'dsh-pixmart: usage')
}
```

设计要点：

- **`inject` 用必需/可选分离**。`tools` 缺失直接不激活；`attachments` 缺失时降级为「只落盘、不嵌图」；`webServer` 缺失时降级为「作品库不显示缩略图」。
- **所有权全部归 fiber**：工具、路由、RPC、定时器、文件句柄都通过 `ctx.effect(() => disposer, label)` 注册，HMR / 卸载时干净回收。
- **不在 `apply()` 里抢跑兄弟 provider**，可选服务用 `ctx.get()` 判断或 `ctx.inject()` 惰性挂载。
- **P0 实测修正**：可选服务**只能在工具 `execute()` 时或 `ctx.inject()` 里判定**。实测 `fs` 与 `credentials` 在 `apply()` 时刻尚未就绪而 3 秒后可用——在 `apply()` 探测会导致系统性误判并错误地走降级分支（见 [contract-notes §1.3](./contract-notes.md)）。

### 7.2 配置 schema

```ts
// src/config.ts（schemastery，注意不是 zod）
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  dataDir: z.string().default(''),          // 空 = $DSH_HOME/pixmart
  providers: z.array(z.object({
    id: z.string(),                          // 本地标识，如 'ofox'
    label: z.string().default(''),
    group: z.union([z.const('official'), z.const('aggregator')]).default('aggregator'),
    baseUrl: z.string(),                     // OpenAI 兼容端点，如 https://api.ofox.io/v1
    geminiNativeBaseUrl: z.string().default(''),  // 仅 gemini-native 用：https://api.ofox.io/gemini/v1beta
    apiMode: z.union([
      z.const('images-generations'),
      z.const('images-edits'),
      z.const('chat-image'),
      z.const('gemini-native'),       // Ofox: Gemini 图像模型的参考图/编辑唯一可用路径
    ]).default('images-generations'),
    dialect: z.union([z.const('standard'), z.const('ofox')])
      .default('standard'),           // ofox: 参考图字段 input_images、输出 output_format
    apiKeyEnv: z.string().default(''),       // 环境变量名，优先级高于数据目录
    models: z.array(z.string()).default([]),
    allowedSizes: z.array(z.string()).default([]),
    sizeMode: z.union([z.const('whitelist'), z.const('exact'), z.const('free')])
      .default('whitelist'),
    extraHeaders: z.dict(z.string()).default({}),
    timeoutMs: z.number().default(180000),
  })).default([]),
  defaults: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    size: z.string().default('1024x1024'),
    n: z.number().default(1),
  }).default({}),
  limits: z.object({
    maxConcurrency: z.number().default(2),   // 批量并发上限
    maxBatchItems: z.number().default(20),
    maxRetries: z.number().default(3),
    retentionDays: z.number().default(0),    // 0 = 不自动清理
  }).default({}),
  promptOverrides: z.dict(z.string()).default({}),  // moduleId -> 覆盖文本
  attachmentInConversation: z.boolean().default(true),
})
```

**要点**：任何部署可能需要改变的值都进 Config，而不是写死在源码里。`apiKey` 本身**不进** schema（避免明文落 patch 层）。

### 7.3 密钥与配置存储

**存储位置**

```
$DSH_HOME/pixmart/config.json     # 厂商列表 + 密钥（权限收紧写入）
.env / 环境变量                    # 生产推荐：apiKeyEnv 指向环境变量名
```

**优先级**：`apiKeyEnv`（环境变量）> 数据目录 `config.json` 中的 `apiKey` > 报错。

**写入协议**（Skill §4.6）：

1. 写同目录临时文件 `config.json.tmp`
2. `fsync` 落盘
3. `rename` 原子替换
4. 失败保留旧文件，绝不留下半截 JSON

**读取容错**：JSON 解析失败 → 备份为 `config.json.corrupt-<ts>` → 以空配置启动并在状态里标记，让用户能进设置页修。

**密钥不回传前端**：RPC 只返回 `hasKey: boolean` 与掩码 `sk-***abc`。

### 7.4 厂商适配器（OpenAI 兼容）

单文件 `src/vendor/openai-compat.ts`，对外暴露统一签名：

```ts
export interface GenerateRequest {
  baseUrl: string
  apiKey: string
  apiMode: 'images-generations' | 'images-edits' | 'chat-image' | 'gemini-native'
  dialect?: 'standard' | 'ofox'                 // 方言，默认 standard
  model: string
  prompt: string
  size?: string                                 // 像素 'WxH' 或比例 '1:1'（gemini-native 用比例）
  n?: number
  seed?: number
  references?: { data: Uint8Array; name: string }[]  // edits / 参考图
  extraHeaders?: Record<string, string>
  timeoutMs: number
  signal?: AbortSignal
}

export interface GenerateResult {
  images: { data: Uint8Array; mediaType: ImageMediaType }[]
  usage?: JsonValue
  raw?: JsonValue
}
```

**四种 `apiMode`**

| apiMode | 端点 | 说明 |
|---|---|---|
| `images-generations` | `POST {baseUrl}/images/generations` | 文生图；响应同时支持 `b64_json` 与 `url` |
| `images-edits` | `POST {baseUrl}/images/edits` | multipart 上传参考图；图生图 / 保真 / 风格复刻 / 白底图 |
| `chat-image` | `POST {baseUrl}/chat/completions` | 聚合商的图片输出路径；从 message 内容里提取图片 |
| `gemini-native` | `POST {baseUrl}/models/{model}:generateContent` | Gemini 原生协议；**Ofox 的 Gemini 图像模型做参考图/编辑的唯一可用路径**（`x-goog-api-key` 鉴权，不是 Bearer） |

**模型 → 路径的路由决策**（`resolvePlan(model, hasReferences)`，显式表驱动，不猜）

| 模型名匹配 | 有参考图 | 无参考图 |
|---|---|---|
| `gemini.*image` / `imagen` / `nano-banana` | `gemini-native`（比例走 `generationConfig.imageConfig.aspectRatio`） | `gemini-native` |
| `gpt-image*` | `images-edits`（multipart） | `images-generations` |
| `qwen.*image` | `images-generations` + `input_images` | `images-generations` |
| 其他 | `images-generations`（带 `input_images`，失败则降级去参考图并告警） | `images-generations` |

路由表可被配置里的 `apiMode` 显式覆盖——**配置优先于猜测**。

**统一处理**

- **尺寸归一化**：入参允许比例（`1:1`）或像素（`1024x1024`）。`gemini-native` 归一化为比例写入 `imageConfig.aspectRatio`；OpenAI 兼容路径归一化为像素 `WxH`（比例 → 该比例的标准像素）。因此 `check_size` 与调用方都不必记住"哪种 apiMode 用哪种格式"。
- **鉴权按 apiMode 分叉**：OpenAI 兼容路径用 `Authorization: Bearer <key>`；`gemini-native` 用 `x-goog-api-key: <key>`。二者不可混用。
- **方言（dialect）只影响字段名，不影响路径**：`ofox` 方言下参考图字段写 `input_images`、输出格式写 `output_format`（值为 `png` / `jpeg`）；`standard` 方言写 `image` / `response_format`。**错误字段会被服务端静默忽略**，因此必须由方言配置决定，不能靠内容嗅探。
- **失败降级链**（逐级去掉可能不兼容的参数后重试，每一级都记日志）：
  `尺寸 → 去 quality → 去 output_format/response_format → 去参考图 → 纯文本`。
  降级必须留下痕迹：返回里带 `degraded: ['quality', 'references']`，避免"成功但没按预期保真"却无人知晓。
- **`AbortSignal` 必须贯穿**：`exec.signal` → 内部 `AbortController` → `fetch(signal)`。
- **重试**：仅对 429 / 5xx / 网络错误重试，指数退避 + 抖动，最多 `maxRetries` 次，尊重 `Retry-After`。4xx（除 429）不重试。**降级链不算重试**，它换的是请求参数。
- **`url` 模式必须立刻下载并落盘**：厂商 URL 是短期签名链接，不能存进项目库。
- **响应校验**：content-type 必须是 `image/*`；字节数 > 0；解码得到的宽高与能力表不符时记 warning 但不失败。
- **超时**：整体 `timeoutMs`（默认 180s），单位请求不设独立短超时（生图本身就慢）。
- **安全类错误不重试、不降级**：命中审核/安全关键词时直接抛出可读错误（参考项目对 Ofox 亦是如此处理）。

### 7.4.1 Ofox 专项契约（只读取证，实施时以官方文档二次核对）

> 来源：参考项目 `src/main/services/openai.ts`（Gemini 原生端点、`input_images` / `output_format` 方言、模型路由）与 `src/renderer/src/types/model.ts`（厂商元数据）。**仅作为接口形态取证**，实现全部重写。

**厂商元数据**

| 项 | 值 |
|---|---|
| 厂商 id / label | `ofox` / `Ofox` |
| 分组 | 聚合接入（aggregator） |
| OpenAI 兼容端点 | `https://api.ofox.io/v1` |
| Gemini 原生端点 | `https://api.ofox.io/gemini/v1beta` |
| 模型过滤 | 不做前缀过滤，以在线 `/models` 为准 |
| 内置 fallback 模型名 | `google/gemini-3.1-pro-preview`、`google/gemini-3.1-flash-lite-image`、`openai/gpt-5.5` |

**`POST /v1/images/generations`（ofox 方言）**

```jsonc
{
  "model": "openai/gpt-5.5",
  "prompt": "…",
  "size": "1024x1024",          // 必须是 WIDTHxHEIGHT 像素，不接受比例字符串
  "quality": "high",            // 部分中转不支持，需可降级
  "output_format": "png",       // 注意：不是 response_format
  "input_images": ["data:image/png;base64,…"]   // 注意：不是 image / images
}
```

**`POST /gemini/v1beta/models/{model}:generateContent`（Gemini 原生）**

```jsonc
// 请求头
{ "x-goog-api-key": "<apiKey>", "Content-Type": "application/json" }
// 请求体
{
  "contents": [{ "parts": [
    { "text": "…提示词…" },
    { "inlineData": { "mimeType": "image/png", "data": "<base64>" } }
  ]}],
  "generationConfig": { "imageConfig": { "aspectRatio": "1:1" } }
}
// 响应取值
// candidates[0].content.parts[].inlineData.data  (base64) + .mimeType
```

**必须记住的五个坑**

| # | 坑 | 后果 | 对策 |
|---|---|---|---|
| 1 | 参考图字段是 `input_images` | 写成 `image`/`images` 会被**静默忽略** → 出图但主体不一致 | `dialect: 'ofox'` 显式决定字段名 |
| 2 | 输出格式是 `output_format` | 写成 `response_format` 不生效，可能返回 URL 而非 b64 | 同上；两条响应分支都要实现 |
| 3 | Gemini 图像模型的编辑只在原生端点可用 | 兼容端点上做参考图保真会退化成纯文生图 | 路由表把 Gemini 图像模型固定到 `gemini-native` |
| 4 | 原生端点鉴权是 `x-goog-api-key` | 用 Bearer 会 401 | 鉴权按 apiMode 分叉 |
| 5 | 原生端点尺寸是**比例**，兼容端点是**像素** | 传错则被忽略或报错 | `check_size` 按 apiMode 返回对应格式的取值 |

**尺寸能力（Ofox 相关）**

- Gemini 图像系（`gemini.*image` / `imagen` / `nano-banana`）：**10 种比例** —— `1:1` / `2:3` / `3:2` / `3:4` / `4:3` / `4:5` / `5:4` / `9:16` / `16:9` / `21:9`。
- `gpt-image*`：仅 3 种像素 + `auto`。

**不搬运的部分**

参考项目在 Ofox 卡片上挂了一个**推广注册链接**（含推荐码）。本插件**不搬运、不内置**任何推广链接或推荐码。

### 7.5 提示词模块目录

结构借鉴参考项目的模块化组织（`mainModules.ts` / `detailModules.ts` 的「模块列表 + 默认尺寸 + 提示词片段」思路），**文本全部重写**。

```ts
export interface ModuleDef {
  id: string
  group: 'main' | 'detail' | 'ad' | 'tool'
  label: string
  defaultSize: string
  requiresReference?: boolean
  fragments: {
    subject: string      // 主体描述模板
    scene: string        // 场景/背景
    lighting: string     // 光影
    composition: string  // 构图
    copyStyle?: string   // 广告类文案风格
  }
  negativeHints?: string
  variables?: string[]   // 可在 vars 中替换的占位符
}
```

**模块清单（v1）**

| 组 | 模块 |
|---|---|
| 主图 `main` | 白底首图 / 场景主图 / 卖点图 / 细节特写 / 尺寸参数 |
| 详情图 `detail` | 首屏主视觉 / 使用场景 / 氛围 / 核心卖点 / 细节特写 / 效果对比 / 工艺材质 / 系列展示 / 尺寸参数 / 配件赠品 / 使用建议 / 品牌故事 / 售后保障 / 多角度 |
| 广告 `ad` | 电商广告 / 社交媒体 / 活动海报 |
| 工具 `tool` | 白底图 / 风格复刻 |

**拼装是纯函数**（`prompts/build.ts`）：

```ts
export function buildPrompt(input: {
  module: ModuleDef
  vars?: Record<string, string>
  overrides?: Record<string, string>
  userPrompt?: string
}): { prompt: string; negative?: string; resolvedSize: string }
```

保证：同入参必得同输出（可单测、可重放）；`overrides` 与 `userPrompt` 追加在末尾，不破坏模块骨架。

### 7.6 尺寸能力表

逻辑借鉴参考项目（模型 → 支持尺寸 / 连续像素档位 → 校验 + 最近邻），代码重写、规模大幅收缩。

```ts
export interface SizeCapability {
  match: string | RegExp          // 模型名匹配
  mode: 'whitelist' | 'exact' | 'free'
  sizes: string[]                 // whitelist 用
  aspectHint?: string[]           // 供最近邻建议
}

export interface SizeCheckResult {
  supported: boolean
  reason?: string
  nearest: string[]               // 最多 3 个建议
}
```

**内置默认**

| 模型匹配 | 能力 | 取值 |
|---|---|---|
| `gemini.*image` / `imagen` / `nano-banana` | 10 种**比例** | `1:1` `2:3` `3:2` `3:4` `4:3` `4:5` `5:4` `9:16` `16:9` `21:9` |
| `gpt-image*` | 3 种**像素** + auto | `1024x1024` `1536x1024` `1024x1536` |
| `dall-e-3` | 3 种**像素** | `1024x1024` `1792x1024` `1024x1792` |
| `qwen.*image` | 固定像素档位 | 复用参考项目已验证的档位集合（重写为常量表） |

**取值格式随 apiMode 变化**：`gemini-native` 用**比例**字符串并写入 `generationConfig.imageConfig.aspectRatio`；OpenAI 兼容路径用**像素** `WxH`。`check_size` 因此必须接收 `apiMode` 一起判断，不能只按模型名返回一种格式。

**未知模型**：完全依赖配置里的 `allowedSizes` + `sizeMode`；`sizeMode: 'free'` 时只做格式校验（`^\d+x\d+$`）与上下限，不猜。

### 7.7 工具清单

| 工具 | 作用 | 网络 | 备注 |
|---|---|---|---|
| `pixmart_providers` | 列出厂商 / 模型 / 能力 / 密钥状态 | 否 | `{refresh?: boolean}` 时探测端点 |
| `pixmart_check_size` | 尺寸校验 + 最近邻建议 | 否 | 校验失败即拦截，不发请求 |
| `pixmart_prompt` | 按模块拼最终提示词（**dry run**） | 否 | 「先看后花钱」的护栏 |
| `pixmart_generate` | 文生图 | 是 | 支持一次多张（`n`） |
| `pixmart_edit` | 图生图 / 参考图保真 / 风格复刻 / 白底图 | 是 | 需要 `references` |
| `pixmart_batch` | 一批模块项 | 是 | 带并发上限与逐项状态 |
| `pixmart_projects` | list / get / delete / restore / usage | 否 | 项目库操作；`get` 顺带回会话暂存目录（`workspaceOut`）。**无** export（2026-10-06 方案 B 删除，见 §7.9 / 变更记录 v1.11） |

**统一返回结构**

```ts
interface ToolResult {
  ok: boolean
  provider?: string
  model?: string
  size?: string
  files?: { path: string; bytes: number; width: number; height: number; sha256: string }[]
  attachments?: unknown[]        // ImageAttachmentRef
  usage?: JsonValue
  error?: { code: string; message: string; retryable: boolean }
}
```

**工具定义示例**

```ts
ctx.tools.register({
  name: 'pixmart_generate',
  description: [
    '生成电商商品图（文生图）。',
    '调用前建议先用 pixmart_check_size 校验尺寸；需要先预览提示词时用 pixmart_prompt（不发请求）。',
    '副作用：在插件数据目录写入图片文件，并在会话中产生图片附件。',
    '失败语义：密钥缺失/尺寸不支持/审核拒绝/超时，均返回结构化 error，不抛异常。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '补充提示词；与 module 二选一或同时给出' },
      module: { type: 'string', description: '模块 id，如 main.white-bg' },
      vars: { type: 'object', description: '模块变量', additionalProperties: true },
      size: { type: 'string', description: '目标尺寸，如 1024x1024' },
      model: { type: 'string' },
      provider: { type: 'string' },
      n: { type: 'integer', minimum: 1, maximum: 4 },
      project: { type: 'string', description: '项目名；省略则自动命名' },
    },
    required: [],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object' },
    render: (args, value) => renderTextAndImages(value),
  },
  async execute(args, exec) {
    return runGenerate(args, exec)   // exec.signal 贯穿
  },
})
```

**注意**：`parameters` / `output.schema` 必须落在宿主支持的 JSON Schema 子集内（`assertSupportedJsonSchema` 会在注册时校验），因此不用 `$ref` / `oneOf` 等高级特性，`required` 用属性内联。

### 7.8 持久化

```
$DSH_HOME/pixmart/
├── config.json                 # 厂商 + 密钥（原子写）
├── index.json                  # 项目索引（可重建）
├── usage.jsonl                 # 追加式用量审计
└── projects/
    └── <projectId>/
        ├── project.json        # 项目元数据 + 每张图的记录
        └── images/
            ├── a1b2c3d4-white-bg-01.png
            └── ...
```

**并发与崩溃语义**

| 关注点 | 做法 |
|---|---|
| 同文件读改写 | 进程内按路径串行的 async mutex |
| 原子写 | 同目录 tmp + `fsync` + `rename` |
| 并发创建项目 | no-clobber（`link()` + `unlink()` 协议，不用 `rename()` 静默覆盖） |
| 追加日志 | 处理 torn tail：读时跳过最后一行不完整 JSON |
| 索引损坏 | 启动时解析失败 → 扫描 `projects/*/project.json` 重建 |
| 恢复不依赖事件重放 | 启动显式扫描磁盘，不假设创建事件会再来 |
| 路径安全 | 所有路径 `resolve` 后必须仍在 `dataDir` 内，否则拒绝 |

**文件名**：`<sha256前8位>-<slug>.png`。内容寻址 → 天然去重、天然可长缓存。

### 7.9 图片呈现路径

1. **落盘为唯一真相**：字节写进 `projects/<id>/images/`。
2. **对话内可见**：`attachments` 服务可用时 `saveImages()` 拿 `ImageAttachmentRef`，`output.render` 返回 `[{type:'text',…}, {type:'image', attachment: <ImageAttachmentRef>}]`——**该形状已由 P0 取证**（[contract-notes §2](./contract-notes.md)）。
3. **画廊显示**：client 用 `<img src="/pixmart/file/<projectId>/<encodedName>">`。
4. **工作区副本（无条件自动）**：每张成功落盘的图复制一份到会话工作区的 `pixmart-out/<项目 id>/`——它不是"帮用户留文件"，而是 DSH 官方内嵌写法 `![说明](<路径>)` **只渲染工作区之内**的路径（见 §11.2 / `src/tools/workspace-copy.ts`）。
   用户要的文件形式副本走**显式导出**：目标 = 请求/入参 `dir` > 配置里的「作品库导出路径」(`exportDir`)，两者都没有就失败并提示去设置里配（**没有**隐式默认落点）。
   **这条入口只有用户点界面**（`POST /pixmart/api/projects/<id>/export`）：Agent 侧的 `pixmart_projects action=export` 已于 2026-10-06 **删除**（方案 B，见 [contract-notes §16.6](./contract-notes.md)）。
5. **Agent 拿路径的唯一来源**：`pixmart_projects action=get` 回 `workspaceOut: {workspace, dir, exists}`——复用 `sessionWorkspace()`（`exec.agent.session.header.cwd`），**只探测不创建**；取不到工作区时该字段**缺省**。Agent 因此没有任何写文件的落点：它要"给用户文件"时，指向上面那份**已经存在**的会话暂存副本。

### 7.10 图片只读路由

```
GET /pixmart/file/<projectId>/<name>
```

| 约束 | 做法 |
|---|---|
| 路径穿越 | 解码后 `resolve`，必须落在 `<dataDir>/projects/<projectId>/images/` 内，否则 400 |
| 项目 id / 文件名 | 白名单字符集校验（`[A-Za-z0-9._-]`） |
| content-type | 按扩展名映射，未知 → `application/octet-stream` |
| 缓存 | 内容寻址 → `Cache-Control: private, max-age=31536000, immutable` |
| 其他方法 | 非 GET → 405 |
| 未知路径 | 404，**不落入 SPA fallback** |
| 同名冲突 | 重复 `(kind, path)` 注册会抛错 → 用 `ctx.effect` 保证只注册一次 |

### 7.11 宿主 API 方法表（HTTP，非 `host.call`）

> P0 修正：包式 client 半拿不到 `host.call`，改由本插件注册自己的 `/pixmart/api/*` 路由。客户端一律用相对挂载点的路径（不写死根路径，避免路径前缀部署下失效，参照 dshmarket #345）。

| 方法 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `listProviders` | `{}` | `ProviderView[]` | 密钥只回 `hasKey` / 掩码 |
| `saveProvider` | `ProviderInput` | `ProviderView` | 校验 baseUrl 为 https（或 localhost） |
| `deleteProvider` | `{id}` | `{ok}` | |
| `testProvider` | `{id, model?}` | `{ok, latencyMs, error?}` | 轻量探测（列模型或 1×1 尺寸最小请求） |
| `listProjects` | `{limit?, offset?}` | `ProjectSummary[]` | |
| `getProject` | `{id}` | `ProjectDetail` | |
| `deleteProjects` | `{ids[]}` | `{deleted}` | 二次确认由前端做 |
| `exportProject` | `{id, dir?}` | `{files[], warnings[], dir, count}` | **只有用户点界面这一条入口**；落点 `<目标>/<id>/`；目标 = `dir` > 配置 `exportDir` > 失败（`400 no_export_dir`）；**无** `dataDir/exports/` 默认落点。Agent 侧同名能力已于 2026-10-06 删除 |
| `previewPrompt` | `{module, vars?, overrides?}` | `{prompt, size}` | 等价于 `pixmart_prompt` |
| `getUsage` | `{since?}` | `UsageSummary` | 按模型/天聚合 |
| `openDataDir` | `{}` | `{path}` | 只返回路径，不执行打开（避免任意命令执行面） |
| `listRuns` | `{sessionId?, limit?}` | `RunSummary[]` | 实时预览卡用它判断"有没有活"；空闲时零成本 |
| `getRun` | `{runId}` | `RunState` | 运行中按 1s 自适应轮询（见 §8.5） |
| `cancelRun` | `{runId}` | `{cancelled, kept}` | 中止在途请求；**已落盘的图保留** |
| `confirmRun`（可选） | `{runId}` | `{accepted}` | 仅 `requireConfirmForBatch: true` 时存在：解除生成前确认悬念 |

**通用规则**：入参 JSON 校验 → 业务 → 结构化 `{code, message}` 错误；任何 RPC 都不泄露密钥；长任务（批量导出）带进度事件。

> **已落地的写路由（设置页可写，2026-10-05；2026-10-06 修订）**：上表里的 `saveProvider` / `testProvider`
> 最终以 5 个 POST 路由实现，形状与判据见 [contract-notes §14](./contract-notes.md)
> 与 [§15（拉取=只读 / 选择=显式写入）](./contract-notes.md)：
> `POST /pixmart/api/providers/<id>/credentials`（写密钥/端点，空串清除）、
> `.../refresh-models`（GET {baseUrl}/models，**只回结果、不写配置**）、
> `.../models`（保存用户勾选的模型子集，唯一会写 `provider.models` 的入口）、
> `.../test`（只探测不写，成败都是 200）、`POST /pixmart/api/defaults`（默认 provider/model/size/n，
> model 不在该厂商列表里则 400 `unknown_model`）。请求体上限 64KB，`GET` 命中写路由一律 405。
> > 为什么 `refresh-models` 改成只读：实测 Ofox 一次返回 150 个模型、绝大多数是纯文本模型，
> > 自动全量写回会把筛选负担和淹没的下拉框推给用户（详见 contract-notes §15.1）。
>
> **作品库批次 A（2026-10-06）**：上表里 `deleteProjects` / `exportProject` 落地为
> `POST /pixmart/api/projects/<id>/delete`（**软删进回收站**，需 `confirm:true`）与
> `POST /pixmart/api/projects/<id>/export`；回收站另有
> `GET /pixmart/api/trash`、`POST /pixmart/api/trash/<id>/restore`、
> `POST /pixmart/api/trash/purge`（需 `confirm:true`）。
> 详情响应同时补齐了 6 个"磁盘上有、HTTP 层以前丢掉"的字段
> （`prompt/model/ms/createdAt/degraded/error`）。形状见
> [contract-notes §16](./contract-notes.md)。
> 「同参数重新生成」**未实现**——它是唯一不经 Agent 就花钱的路径，护栏见优化方案 §6.2。


---

## 8. Client 面设计

### 8.1 构建

```jsonc
// package.json 关键字段
{
  "name": "dsh-pixmart",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": { "default": "./client/client.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime"] }
  }
}
```

**产物包装**（已实测契约）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-pixmart',
  factory: (require) => {
    const React = require('react')
    // ... bundle
    return { name: 'dsh-pixmart', inject: ['slots', 'locale', 'theme'], apply }
  },
})
```

**规则**

- 打包工具：tsdown / rolldown，externals 只留平台模块表内的模块。
- 输出 sourcemap；**client build 不清空 host 输出**。
- CSS 注入用 `styles.insert`（随 fiber 清理），或构建期产出 CSS Modules + `style[data-plugin]`。
- HMR：需要构建 watcher 持续重写 `client/client.js`；否则改完刷新页面。
- **不另起 Vite server**：Web 壳依赖 host 注入的 `window.__DSH_BOOT__`。

### 8.2 UI 落点（位置已由 live 插槽目录确认）

三处可见位置：

| 位置 | Slot | 注册参数 | 界面上长在哪 |
|---|---|---|---|
| **A. 设置页** | `settings.section`（list, root） | `{ id: 'pixmart', order: 30, label: '电商生图' }` | 侧边栏最底部「设置」→ 设置面板 → **左侧导航列多出一项「电商生图」**（现有一列：账户 / 通用 / 模型 / 插件 / 预设 / 插件市场）；内容渲染在右侧内容列 |
| **B. 作品库入口** | `sidebar.panellist`（list, root） | `{ id: 'pixmart', order: 10 }` + 图标组件 | 侧边栏的**全局面板图标排多出一个「电商生图」图标**（当前该排只有「插件」一个） |
| **B. 作品库正文** | `main`（keyed, root） | `{ key: 'pixmart' }` | **中央主面板**（当前 key 占用：`plugins`、`conversation`）；点上面那个图标即切到这里 |
| **C. 对话内** | 默认渲染即可 | — | 工具卡片里直接出图（`tool.call.images`）；只有需要定制卡片时才注册 `tool.call.toolview` keyed `pixmart_generate` |
| **D. 生图实时预览** | `shell.overlay`（list, root） | `{ id: 'pixmart-preview', order: 50 }` | 右下角浮层预览卡：进度 `3/8` + 逐格点亮的缩略图；**生图时自动浮现，结束收成徽标**。设计见 §8.5 |

**A 与 B 的机制是官方契约原文，不是猜测**（2026-10-05 live 插槽目录）：

- `sidebar.panellist` catalog：**"Each list id addresses the matching main panel; the sidebar owns the button and resolves its label from list metadata."** → panellist 的 `id` 与 `main` 的 `key` **一一对应**，侧边栏负责画按钮、解析 label。
- `main` catalog：**"Central panel selected by sidebar entry id. The reserved `conversation` key hosts the Conversation; other keys receive no Session binding."** → 我们的 key 拿到的是**无会话绑定的全局面板**，正是作品库需要的语义。
- `settings.section` catalog：**"Sections render inside the panel content column."**，每个 section 额外拿到一个 `close()`。现成先例：`dsh-market` 即以 `{ id: 'market', order: 40 }` 挂在同一列上。

**位置示意**（当前 GUI；`+` 为我们的增量）

```
┌───────────────┬────────────────────────────────────────┐
│ 侧边栏         │  中央主面板                             │
│               │                                        │
│ 工作区/会话     │   ← 点侧边栏「电商生图」图标后           │
│  · 会话 1      │     这里切换为「作品库」                 │
│               │                                        │
│ ──────────    │                                        │
│ 面板图标排      │                                        │
│  [插件]        │                                        │
│ +[电商生图]     │                                        │
│               │                                        │
│               │                                        │
│ ⚙ 设置         │                                        │
└───────────────┴────────────────────────────────────────┘
   └─ 设置面板：左导航列 │ 右内容列
       账户            │
       通用            │
       模型            │
       插件            │
       预设            │
   +   电商生图  ───────┼──→ PixMart 设置页
       插件市场        │
```

**order 取值理由**：设置页取 `30`（落在「预设」20 与「插件市场」40 之间——它是业务功能，不是系统设置）；面板图标取 `10`（跟在「插件」之后）。

**必须用自己的新 key**：`main` 的 `replaceRisk` 是 `shadows-shipped-ui`——复用已占用的 key 会**替换掉官方面板**，所以固定用 `pixmart`。

**降级路径**：A 与 C 已由 live 目录确认可行；B 的注册契约（id ↔ key 对应）也已确认，仅剩「侧边栏是否为每个 panellist id 实际渲染按钮」需要在 P0 spike 里眼见为实。若不成立 → 作品库改挂 `settings.plugins.tab`（「插件」设置区内的一个子页），图片仍可通过对话卡片查看。不影响 A1–A6。

**Slot 四步契约**（Skill §5.2）

1. **声明**：从提供 slot 的官方包 type-only 引入类型。
2. **认领**：父 entry 用 `children` 声明子 slot。
3. **注册**：`ctx.slots.inject(key, () => ctx.slots.register({ name, id/order/label, ... }, Component))`——owner 与贡献者激活顺序不保证，必须用 `inject` 等待声明。
4. **渲染**：owner 用 `renderSlot`；贡献者不 import owner 实现。

**降级路径**：若 `sidebar.panellist` + `main` 的配套注册在 spike 中不成立 → 作品库改挂 `settings.plugins.tab` 独立页，图片仍可通过对话卡片查看。不影响 A1–A6。

### 8.3 客户端状态与清理

- 所有 `ctx.effect` / `ctx.on` / React root / DOM / window listener / `styles.insert` 都随 client fiber dispose。
- per-session 状态按 `SessionId` 分桶；连接重置时只重同步已读过的对象。
- 轮询用量/项目：`in-flight` guard + 响应形状校验 + unmount 防护；失败保留最后成功快照。
- 可访问性：键盘可达、`:focus-visible`、`aria-*`、Escape 关预览、尊重 `prefers-reduced-motion`。

### 8.4 client import 纯度

- 允许：`react`、`@deepseek-ai/dsh-client-ui-primitives`（平台模块表内），以及纯 type-only import。
- 禁止：任何跨插件的**值** import；直接 `fetch` 外部厂商 API（必须走 host RPC）。
- 平台模块以当前正式版 `packages/client/web/src/platform.ts` 为准；不确定就先用 spike 验证。

### 8.5 生图实时预览（"侧边栏预览"的可行形态）

**结论**：右侧栏 tab **插不进去**（证据见 §8.5.1），改用 `shell.overlay` 浮层 + 作品库运行视图，体验等价且不占布局轨道。

#### 8.5.1 为什么不是右侧栏 tab（live 取证）

| 证据 | 结论 |
|---|---|
| `sidebar.right.pane.tab`（keyed, session）**可用**，已有 8 个官方 tab 类型：`guide` / `documentpreview` / `terminal` / `files` / `browser` / `subagent` / `deliverables` / `plan` | 这里只注册**某个 kind 的 tab 正文**；**不能声明 kind、不能创建 tab** |
| `rightbar`（single, root）与 `rightbar.session`（single, session）：**注册参数为空**，且**已被 shell 占用**（catalog 原文 "OCCUPIED by the right Sidebar"），`replaceRisk: shadows-shipped-ui` | 单槽占位语义 = 注册进去会**整体顶掉官方右侧栏**（文件/终端/浏览器/文档预览全没）。不可接受 |
| 客户端 Service 全目录仅 `layout` / `locale` / `sessions` / `slots` / `theme` / `timer` / `uiWorkspace` / `workspaces` | 无任何「打开 tab / 声明 tab」API。`ctx.layout.openRightbar(track, fullscreen)` 只能打开列，内容仍归 shell |

→ 宿主未向第三方开放此缝。P0 可再探测一次（是否存在未暴露的运行时途径），但不作为设计前提。

#### 8.5.2 三层预览

| 层 | 落点 | 触发 | 内容 |
|---|---|---|---|
| **L1 对话内联** | 工具卡片默认图片渲染 | 自动 | 每张图落盘即出现；零成本兜底 |
| **L2 实时预览卡**（主推） | `shell.overlay`（list, root, `replaceRisk: none`；catalog：*"This is the additive seat for a frame-wide surface of your own"*） | 生图开始**自动浮现**（已确认 D10），结束**收成徽标并保留**（已确认 D12） | 缩略图网格 + `3/8` 计数 + 当前模块名 + 进度环 + 取消 + 「展开」 |
| **L3 作品库运行视图** | `main` keyed `pixmart`（§8.2） | 点 L2「展开」或侧边栏图标 | 大图网格、失败重试、导出/删除 |

L2 即右下角浮层预览：**不挤压中央内容、不占布局轨道、可折叠**。

#### 8.5.3 Host 侧：运行注册表（实时性的关键）

```ts
interface RunItem {
  index: number
  module: string; label: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped'
  file?: string; width?: number; height?: number
  error?: { code: string; message: string }
  ms?: number
}
interface RunState {
  runId: string
  sessionId?: string
  tool: 'generate' | 'edit' | 'batch'
  provider: string; model: string; size: string
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
  total: number; completed: number; failed: number
  currentLabel?: string
  startedAt: number; updatedAt: number; finishedAt?: number
  projectId?: string
  items: RunItem[]
}
```

- 生命周期：工具一进入即 `createRun()`；**每张图字节落盘后立刻 `markItemDone()`** —— 这是"实时"的本质：文件先于工具返回就已存在，浮层据此逐格点亮；工具返回前 `finishRun()`。
- 内存为主 + 落盘 `runs/<runId>.json`（页面刷新/重连后仍可读到），保留最近 20 条。
- 进程重启后读到 `status: 'running'` 的记录 → 标为 `interrupted`，**不假装还在跑**（Skill §4.6：恢复不能假设创建事件会重放）。
- 取消：`cancelRun` 触发对应 `AbortController` → 中止在途 fetch；**已落盘的图保留**，状态记 `cancelled`，返回 `{cancelled, kept}`。

#### 8.5.4 通道：轮询，不是推送

- 包式 client 半没有 `host.call`，也没有面向第三方插件的推送通道（跨端事件需生成式 remote codec）。与宿主通信一律走本插件自己的 HTTP 路由。
- 因此 L2 用**自适应轮询**：运行中 1s 一次，空闲即停；`listRuns` 判断"有没有活"，`getRun` 取增量。
- 硬要求（Skill §5.4）：`Cache-Control: no-store`、in-flight guard、响应形状校验、unmount 防护；失败保留最后一次成功快照并显示 stale 徽标。

#### 8.5.5 交互细节（照 Skill §5.4 的浮层红线）

| 关注点 | 做法 |
|---|---|
| 点击穿透 | `shell.overlay` 本身 click-through；只有我们的卡片 `pointer-events: auto` |
| 尺寸 | 宽 ≤ 320px、高 ≤ 40vh，内容区内部滚动；窄屏退化为底部整宽并另设高度上限 |
| **布局位移** | 运行中展开；**结束后收成徽标并保留**（不自动消失也不撑大，已确认 D12），用户可固定展开 |
| **首屏恢复** | 打开页面时已在跑的任务**只显示徽标、不自动展开**（避免首次请求返回后大幅位移）；其后新开始的任务才自动展开 |
| 键盘 / 无障碍 | `:focus-visible`、`aria-live="polite"` 报进度、Escape 收起、`prefers-reduced-motion` 关动画 |
| 多任务 | 同会话最多展示 1 张卡 + `+N` 计数，点击切到列表 |
| 缩略图 | `<img src="/pixmart/file/<projectId>/<name>">`，落地即出现；未完成显示模块名占位 + 进度环 |
| 清理 | React root / DOM / 轮询 timer / listener 全部随 client fiber dispose |

#### 8.5.6 可选加强：生成前「计划预览 → 确认」

同一张卡在生图**之前**可变为计划预览（模块清单 / 尺寸 / 模型 / 张数）。默认**不阻塞**；开启 `requireConfirmForBatch: true` 时，`pixmart_batch` 先建 `status: 'awaiting-confirm'` 的运行并立即返回，用户点「确认生成」→ `POST /pixmart/api/runs/<id>/confirm` 解除悬念。

- 这是**付费闸门**：`pixmart_prompt` 的 dry run 给 Agent 看，确认卡给人看。
- 必须带超时（默认 5 分钟）并与 `exec.signal` 联动：超时/中止 → 状态 `cancelled`，工具返回"未确认即取消"。
- **默认关闭（已确认 D11）**，P1 末评估阻塞语义是否值得引入。

---

## 9. 数据模型

### 9.1 config.json

```jsonc
{
  "version": 1,
  "providers": [
    {
      "id": "ofox",
      "label": "Ofox",
      "group": "aggregator",
      "baseUrl": "https://api.ofox.io/v1",
      "geminiNativeBaseUrl": "https://api.ofox.io/gemini/v1beta",  // 仅 Gemini 图像模型使用
      "dialect": "ofox",              // input_images / output_format
      "apiMode": "images-generations", // 默认路径；Gemini 图像模型由路由表改判为 gemini-native
      "apiKeyEnv": "OFOX_API_KEY",    // 推荐：密钥走环境变量
      "apiKey": "",                   // 或在此填入；留空则读 env
      "models": [
        "google/gemini-3.1-flash-lite-image",
        "google/gemini-3.1-pro-preview",
        "openai/gpt-5.5"
      ],
      "allowedSizes": ["1:1", "3:4", "4:3", "9:16", "16:9"],
      "sizeMode": "whitelist",
      "extraHeaders": {},
      "timeoutMs": 180000
    }
  ],
  "defaults": {
    "provider": "ofox",
    "model": "google/gemini-3.1-flash-lite-image",
    "size": "1:1",
    "n": 1
  }
}
```

> `apiKey` 默认为空，**由用户自行填入**（决策 D9）。未配置时所有生图工具必须在发请求前返回可读错误并指向设置页，而不是抛 401。

### 9.2 index.json

```jsonc
{
  "version": 1,
  "updatedAt": 1790000000000,
  "projects": [
    {
      "id": "2026-10-05-白底主图-01",
      "name": "白底主图",
      "createdAt": 1790000000000,
      "imageCount": 5,
      "cover": "projects/2026-10-05-白底主图-01/images/a1b2c3d4-main-white-bg-01.png",
      "provider": "ofox",
      "model": "google/gemini-3.1-flash-lite-image"
    }
  ]
}
```

### 9.3 project.json

```jsonc
{
  "version": 1,
  "id": "2026-10-05-白底主图-01",
  "name": "白底主图",
  "createdAt": 1790000000000,
  "items": [
    {
      "module": "main.white-bg",
      "prompt": "…最终提示词…",
      "size": "1:1",
      "provider": "ofox",
      "model": "google/gemini-3.1-flash-lite-image",
      "apiMode": "gemini-native",
      "n": 1,
      "images": [
        { "file": "images/a1b2c3d4-main-white-bg-01.png", "bytes": 1456789,
          "width": 1024, "height": 1024, "sha256": "a1b2c3d4…", "createdAt": 1790000000123 }
      ],
      "usage": { "promptTokens": 0, "images": 1 },
      "status": "ok"
    }
  ]
}
```

### 9.4 usage.jsonl（每行一条）

```jsonc
{"ts":1790000000123,"provider":"ofox","model":"google/gemini-3.1-flash-lite-image","mode":"gemini-native","size":"1:1","n":1,"ok":true,"ms":8421,"project":"2026-10-05-白底主图-01","degraded":[]}
```

### 9.5 runs/<runId>.json（运行注册表，驱动实时预览）

```jsonc
{
  "version": 1,
  "runId": "run-1790000000123-8f2a",
  "sessionId": "session-0fe6702f-…",
  "tool": "batch",
  "provider": "ofox",
  "model": "google/gemini-3.1-flash-lite-image",
  "size": "1:1",
  "status": "done",
  "total": 4, "completed": 4, "failed": 0,
  "projectId": "2026-10-05-详情图-01",
  "startedAt": 1790000000123, "updatedAt": 1790000009555, "finishedAt": 1790000010000,
  "items": [
    { "index": 0, "module": "detail.hero", "label": "首屏主视觉", "status": "done",
      "file": "images/b7c1d2e3-detail-hero-01.png", "width": 1024, "height": 1024, "ms": 8421 },
    { "index": 1, "module": "detail.scene", "label": "使用场景", "status": "failed",
      "error": { "code": "moderation", "message": "…" }, "ms": 1203 }
  ]
}
```

> 落盘时机：`createRun()` 先写 `status: "running"` 的记录，之后每完成一张**重写一次**（原子写）。保留最近 20 条。参见 §8.5.3。

---

## 10. 错误处理与边界情况

| 场景 | 处理 |
|---|---|
| 缺少 / 错误 Key（401） | 结构化错误 + 指明去设置页配置；**不重试** |
| 429 / 5xx / 网络抖动 | 指数退避 + 抖动，最多 `maxRetries` 次，尊重 `Retry-After`；最终失败附原始状态码与 body 摘要 |
| 内容审核拒绝 | 原样回传厂商 reason，`code: 'moderation'`，**不重试**（重试只会重复被拒） |
| 响应是 URL 而非字节 | 立即下载落盘；下载失败重试一次；仍失败则报错，**不留死链** |
| 响应非图片 | 校验 content-type 与字节魔数；不匹配则报 `code: 'bad_response'` 并附前 512 字节摘要 |
| 尺寸不支持（A3） | 请求前拦截，返回最近可用尺寸 |
| 模型不支持 edits | 能力表前置拦截，提示改用支持 edits 的模型 |
| 参考图不存在 / 不可读 | 入参校验期报错，列出尝试过的绝对路径 |
| 参考图过大 | 超过阈值（默认 20 MB）在读取前拒绝，附实际大小 |
| `exec.signal` 中止 | `AbortController` 联动，取消在途 HTTP；已成功的项目项保留 |
| 批量部分失败 | 逐项 `status` + 汇总；成功项不丢，失败项带原因 |
| 并发过高 | 并发上限（默认 2）+ batch 项数上限（默认 20），超限直接拒绝并说明 |
| 磁盘满 / 写失败 | 原子写失败保留旧文件；返回 `code: 'disk'`；项目项标记 `status: 'failed'` |
| index.json 损坏（A6） | 启动扫描重建；损坏文件备份为 `.corrupt-<ts>` |
| 项目名重复 | 自动加序号后缀，不覆盖已有项目 |
| 文件名冲突 | 内容寻址文件名天然唯一；同内容同哈希 → 复用已有文件 |
| 空 prompt 且无 module | 入参校验期报错，附可用模块 id 列表 |
| 路径穿越尝试 | 一律 400 / 拒绝，记 warning 日志 |
| 运行中页面被刷新 / 重连 | 运行记录在 `runs/*.json`；重连后按 `listRuns` 恢复，**只显徽标不自动展开** |
| 进程在运行中重启 | 该记录标为 `interrupted`，浮层显示「已中断」并提供重试；**不假装仍在运行** |
| 用户取消运行 | 中止在途请求；已落盘的图**保留**，状态 `cancelled`，返回 `kept` 张数 |
| 浮层轮询失败 | 保留最后一次成功快照 + stale 徽标；不弹错、不阻塞生图主流程 |
| 生成前确认超时 / 中止 | 状态 `cancelled`，工具返回「未确认即取消」，**不产生任何请求** |

---

## 11. 分发与安装

### 11.1 分发形态

**GitHub 分发（备选路径，推荐用于 v1）**：把构建产物 `lib/` 与 `client/client.js` **一并提交进仓库**，exports 指向已构建文件。用户安装时无需执行任何构建脚本，规避 pnpm ≥10 默认拦截构建脚本的门禁。

**npm 分发（后续）**：正常 `files` 白名单 + `prepublishOnly` 构建；需要时再提供 `prepare` 支持源码安装。

### 11.2 安装命令（README 只写经过验证的）

```sh
# 只装到指定 profile；不要直接装进正在使用的 desktop profile
dsh plugin --profile px add <path-or-git-url>
dsh --profile px --dump-config      # 确认 patch 行出现
```

### 11.3 上架社区市场

向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR 加一条目录条目即可；站点与市场会自动收录（通常一天内）。

### 11.4 HMR 与重启边界

| 变更类型 | 生效方式 |
|---|---|
| client bundle 内容 | client HMR（需构建 watcher 持续重写产物），或刷新页面 |
| host 代码 | 需要重启（host HMR 只做 stat 检测 + rev/SSE 通知刷新） |
| `package.json` / exports / `dsh.client` / profile bundles | 必须重启 |

### 11.5 打包：剥离 client bundle 的 `__test__` 测试钩子（P4 待办第 1 条）

`client/client.js` 的 factory 返回值上挂了一个 `__test__`（组件与纯函数/状态机内部件），
供 jsdom lane 与浏览器 lane 从 bundle 里取件。宿主只读 `name` / `inject` / `apply`，多一个键
对宿主无害，但**生产包不该带测试入口**——因此作为**打包步骤**剥离，源码不动。

```sh
pnpm build:client     # = node tools/strip-test-hooks.mjs → 写 dist/client.js
```

- **实现**：`tools/strip-test-hooks.mjs`，`node` 直跑，**不引入打包器、不加任何依赖**
  （`dependencies` 仍为空）。按锚句定位 → 花括号配平 → 断言下一行正是那条带 `__test__` 的
  `return`；任何一步对不上就报错退出，不做"尽力而为"的改写。
- **自证**：产物与源码做**前缀/后缀逐行比对**，唯一差异点必须是新 return 行，删块之外
  **零字节改动**；行数账、UTF-8 字节账、`node --check`、`name`/`inject`/`apply` 三项齐全。
- **陈旧性守卫**：`test/strip-test-hooks.test.mjs` 把当前 `client/client.js` 现场剥一遍，
  与 `dist/client.js` **逐字节**比对。`dist` 缺失 → 带可读原因跳过（干净 checkout 的正常
  形态，不崩）；`dist` 存在但不一致 → **失败**并提示 `pnpm build:client`。
- **自动产出**：`pretest`（跑测试前）与 `prepack`（打包/发布前）都调用它；
  `files` 白名单已加入 `dist`。`dist/` **不入库**（见 `.gitignore`）。
- **⚠️ exports 仍然指向 `./client/client.js`，没有切到 `dist/client.js`**。
  原因：开发期 profile 是指向本仓库的 symlink，而 `client.js` 还在频繁改；一旦切到 `dist/`，
  刷新页面看到的是**过期产物**，比现状更容易误判。
  **切换 `exports["./client"]` 到 `dist/client.js` 是 P4 打包的最后一步，等停止迭代后再做。**

---

## 12. 实施阶段

| 阶段 | 目标 | 交付物 | 出口验证 |
|---|---|---|---|
| **P0** 骨架 + 契约 spike ✅ | 打通「能装、能跑、能显示」三件事 | 可安装的最小双面插件（`pixmart_ping` + hello-world 设置页）+ [contract-notes.md](./contract-notes.md) | **全部通过**：A1 ✅；S1 ✅（含 desktop 活宿主实调）；S2 ✅（GUI 目视：设置页 + 侧边栏面板切换）；S3 ✅ |
| **P1** 宿主核心 ✅ | 生图主链路可用 | config / store / 适配器（`dialect: ofox` + `gemini-native`）/ 24 个提示词模块 / 尺寸表 / 6 个工具 | **全部通过**：`pnpm verify` 全绿；**A2 ✅**（真实生图落盘 + 卡片内嵌图）；**F1 ✅**（产出 1024×1024，`sizeMismatch` 为空） |
| **P2** 批量与归档 ✅ | 一套图 + 可回溯 + 过程可见（host 半边） | `batch` / `projects` / usage 审计 / **运行注册表（runs）** / 保留期清理 | **A5 ✅**（mock 8 项 / 并发 2 / 8 个互不相同文件）、**A6 ✅**（扫描式列表无索引可损坏 + boot 把 running 改判 interrupted） |
| **P3** 客户端 UI ✅ | 人可管理、可浏览、可旁观 | `/pixmart/api/*` + 图片路由 / 设置页 / 作品库面板 / **`shell.overlay` 实时预览卡** | **A7 ✅**（GUI 目视）、A9 代码完成；**jsdom lane 已补**（10 例），首跑即抓到「结束后不收起」缺陷 |
| **P4** 打包与文档 ⏳ | 别人也能装 | README / NOTICE / 全新 profile 安装脚本 / 上架条目 / **构建步骤剥离 client bundle 的 `__test__` 测试钩子** | **A8** + 从零安装全链路 |

### 12.1 P0 的三个 spike

| Spike | 问题 | 判定 |
|---|---|---|
| **S1** host 工具可见性 | 最小 host 插件注册一个工具，Agent 能否看到并调用？ | scratch profile 里 `dsh --profile px "调用 pixmart_ping"` 有结果 |
| **S2** client 装载契约 | 手写 `ModuleLoader` 包装的 client bundle、注册 `settings.section`；**并验证 `sidebar.panellist` 的 id 是否真的为 `main` 的 key 渲染出切换按钮**（收口 R3） | 设置面板出现「电商生图」条目并可交互；侧边栏出现图标，点击能切到我们的主面板 |
| **S3** 图片 ContentBlock 形状 | `output.render` 返回的图片块精确结构是什么？ | 读内建 `read_image` 的实现或官方类型；拿不到则降级为路径文本 + 客户端画廊 |

**P0 结束时先交付「契约笔记 + 最小可跑演示」，确认后再推 P1。**

### 12.2 P4 已知待办

| # | 待办 | 说明 | 来源 |
|---|---|---|---|
| 1 | ~~构建步骤剥离 `client/client.js` 的 `__test__` 测试钩子~~ ✅ **已完成（源码不动，剥离放在打包步骤）** | 手写无构建阶段，jsdom lane 需要从 bundle 里取到组件，因此 `factory` 返回值上多挂了 `__test__`。宿主只读 `name`/`inject`/`apply`，多一个键无害，但生产包不该带测试入口。**做法**：`tools/strip-test-hooks.mjs` + `pnpm build:client` 产出 `dist/client.js`（`pretest`/`prepack` 自动跑，`files` 已含 `dist`，`dist/` 不入库），`test/strip-test-hooks.test.mjs` 有陈旧性守卫。**⚠️ 剩下的最后一步**：把 `exports["./client"]` 切到 `dist/client.js`——**故意留到最后**，因为 profile 仍 symlink 本仓库且 `client.js` 还在改，切早了刷新页面看到的是过期产物。详见 §11.5 | 提交 `3ec6cd2` |
| 2 | jsdom 覆盖不到的项转 GUI 目视 | 「高度不撑大」在 jsdom 退化为内联样式 + 元素数快照；reduced-motion、缩略图真实加载、真实 CSS 布局（窄屏底部整宽）只能目视 | §13.5 |
| 3 | Git 分发形态 | 走 GitHub 分发时把 `lib/` 与 `client/client.js` 一并提交，规避 pnpm ≥10 的构建脚本门禁 | §11.1 |

### 12.3 未执行的验证（需付费，须用户先授权）

| 项 | 代价 | 说明 |
|---|---|---|
| 真实批量生图（预览卡"逐格点亮"的端到端） | 每次厂商调用计费，总额 = items × n | 已在 mock 层通过 A5；真实端到端仍待一次授权执行 |

### 12.4 待审核方案（未开工）

| 方案 | 状态 | 说明 |
|---|---|---|
| [作品库优化方案](./作品库优化方案.md) | 📋 **待用户审核** | 四批（信息可见性 / 操作能力 / 规模化 / 体验）+ 4 个待定决定（删除软硬、缩略图、费用提示、是否动工具层）。**决定未定前不要开工** |

---

## 13. 验证矩阵

### 13.1 基线命令

```sh
pnpm typecheck      # host + client 两个 program
pnpm build:client   # 打包步骤：剥离 client bundle 的 __test__ → dist/client.js（§11.5）
pnpm test           # node:test（jsdom lane + 纯函数 / 宿主契约，269 项；pretest 会先跑 build:client）
pnpm test:browser   # 真实排版引擎 lane（需系统 Edge/Chrome，见 §13.7）
pnpm build          # host tsc（client bundle 是手写产物，无转译构建步骤）
pnpm verify         # 上面四条串起来；无浏览器时 test:browser 会醒目失败（可用 PXM_LANE_ALLOW_SKIP=1 显式放行）
git diff --check
```

### 13.2 单元测试（纯函数优先）

| 对象 | 用例 |
|---|---|
| `prompts/build.ts` | 确定性；模块 + vars + overrides + userPrompt 的组合；空输入报错 |
| `sizes.ts` | whitelist / exact / free 三模式；不支持时的最近邻；格式非法 |
| `store/atomic.ts` | 写入成功；中途失败保留旧文件；torn tail 处理 |
| `store/project-store.ts` | index 损坏重建；项目名去重；并发创建 no-clobber |
| `vendor/openai-compat.ts` | 四种 apiMode 的请求构造 golden JSON；`standard` / `ofox` 两种方言的字段名断言（`input_images` vs `image`、`output_format` vs `response_format`、`x-goog-api-key` vs Bearer）；b64 / url / chat / inlineData 四种响应解析；降级链顺序；错误码映射；重试判定 |
| `store/paths.ts` | 路径穿越拦截；dataDir 越界拒绝 |
| `log/usage.ts` | 追加 + 读取 + 汇总 |
| `tools/strip-test-hooks.mjs`（`test/strip-test-hooks.test.mjs`） | 剥离确定性（同源两次同字节）；产物无 `__test__`；`node --check` 通过；`name`/`inject`/`apply` 齐全；**陈旧性守卫**（dist 缺失→带原因跳过；dist 陈旧→失败并提示 `pnpm build:client`）；结构对不上时脚本非零退出（§11.5） |

### 13.3 集成测试

- **mock 端点**：Node `http` 起本地服务，同时模拟 Ofox 的两种端点形态（`/v1/images/generations`、`/gemini/v1beta/models/*:generateContent`），覆盖 200 / 401 / 429 / 500 / 超时 / 非图片响应 / 审核拒绝 / 静默忽略参考图 八条路径。零真实花费。
- **真实 Loader 组合**：`dsh plugin --profile px add <path>` + `dsh --profile px --dump-config`，断言 bundle 层、行 id、name、config、注入顺序。
- **真实任务**：`dsh --profile px "用 Ofox 生成一张 1:1 白底主图"`（**需用户先填入 Key**；Key 未就绪时以 mock 端点替代）。
- **HMR / dispose**：每个 registry 贡献至少一个 dispose 后无残留的测试。

### 13.4 客户端测试

- jsdom + SlotTestRuntime（或最小 fake services）挂载插件，断言：slot 注册、渲染、session 隔离、connection reset、dispose 后 registry / DOM / style / controller 全部清理。
- 打包纯度门：client bundle 不得 require 平台模块表之外的值。
- **预览卡专项**（§8.5）：运行中进度更新；结束后收成徽标且 **DOM 不产生尺寸突变**（对高度做快照断言）；首屏恢复的既有运行**不自动展开**；轮询失败保留快照并显示 stale；unmount 后无 timer / listener / DOM 残留。`cancelRun` 后已落盘图片仍可见。

### 13.5 GUI 验证

在现有 `http://127.0.0.1:19387` 上（刷新或重启后）验证：设置页出现、密钥保存、测试连接、作品库列表与缩略图、预览弹层、导出、宽窄屏布局、键盘焦点、reduced motion。

### 13.6 从零安装验证

1. 全新临时 `DSH_HOME` + scratch profile。
2. 按 README 的**精确命令**安装。
3. 断言 profile 依赖与 `dsh.profile.bundles`。
4. 断言 exports 指向的 host/client 产物、patch、静态资源全部存在。
5. `--dump-config` 必须出现插件层。
6. 启动后检查工具可见性与 UI 名册。

### 13.7 浏览器 lane（真实排版引擎：Playwright + 系统 Edge/Chrome）

**为什么单独一条 lane**：jsdom 没有排版引擎——`scrollHeight` / `getBoundingClientRect()` /
`scrollTop` 在 jsdom 里是常量 0，所以「滚不动」「顶栏被滚走」「顶栏压在窗口标题栏下面」
「窄屏横向溢出」「标签与值被换行拆散」这几类缺陷**原理上**测不出来（`test/client.test.mjs`
文件头早已列明这一点）。本节这条 lane 用真排版引擎，只按**几何**断言。

```sh
pnpm test:browser     # = node --test test/browser/*.test.mjs —— 只在有浏览器的机器上跑
pnpm verify           # typecheck + build + test(260) + test:browser
```

**前置**：本机装有 Microsoft Edge 或 Google Chrome。用 `playwright-core` +
`channel: 'msedge' | 'chrome'`（**不下载浏览器**，`playwright-core` 进 `devDependencies`，
`dependencies` 仍为空）。**没有可用浏览器时不会假装通过**：打印醒目 SKIP 横幅并以**非零码**
结束；确实要在无浏览器机器上放行，用 `PXM_LANE_ALLOW_SKIP=1`（此时该轮显式报告为 skipped）。

**harness**（都不进产物、不参与打包、不改 bundle）：

| 文件 | 角色 |
|---|---|
| [test/browser/shell.html](../test/browser/shell.html) | 复刻 shell 的最小真实骨架：`html,body,#root` 高度 100% + `overflow:hidden`、**40px 标题栏带**（模拟 `titleBarOverlay`，`z-index:1100`）并发布 `--dsh-frame-chrome-top: 40px`、`.centerCol`（flex 列 + `overflow:hidden` + 高度锁死），**我们的面板是它的直接 flex 子项**（槽锚点 `display:contents`，无 DOM 包裹）；设置页槽另有自己的滚动弹窗容器 |
| [test/browser/lane.js](../test/browser/lane.js) | 页面侧 harness：`client.js` 之前定义 `window.__ModuleLoader__` → `factory(require)`（`require('react')` = 页面里的**真 React 18 UMD**）→ 最小假 `ctx` 调 **`apply(ctx)`**（走真实注册路径，不读 `__test__`）→ 挂进槽锚点；并暴露只讲事实的几何探针（rect / scrollTop / scrollWidth / `elementFromPoint` / 计算后 overflow） |
| [test/browser/lane-server.mjs](../test/browser/lane-server.mjs) | 只读静态服务（白名单路径 + 真 800×800 PNG 顶替图片路由）+ 浏览器解析/启动；默认服务的永远是**仓库原产物 `client/client.js`** |
| [test/browser/layout.test.mjs](../test/browser/layout.test.mjs) | 11 条断言 |
| [tools/lane-mutations.mjs](../tools/lane-mutations.mjs) | **反向变异验证**：把实现改坏、确认对应用例真的失败（见下表） |

**覆盖的 11 条断言**（全部基于真实几何 / 真滚轮 `mouse.wheel()`，没有一条是"读内联样式字符串"）：

| # | 断言 | 手段 |
|---|---|---|
| 0 | lane 自证：服务/加载的就是仓库原产物（逐字节 sha256 一致）+ 真 React UMD + 真图片解码 | `createHash` on 服务字节 / `naturalWidth > 0` |
| 1 | 详情页能滚；滚到底时**最后一张图完整可见** | `mouse.wheel` → `scrollTop > 0` → 滚到不动 → 末张 `rect` 落在滚动区内 |
| 2 | 列表页（40 项）能滚 | 同上 |
| 3 | 查看器顶栏 `top ≥ 40`（`--dsh-frame-chrome-top`），关闭按钮完整在视口内且 `elementFromPoint` 命中的是它自己 | rect + 命中测试 |
| 4 | 查看器内容滚动时顶栏与根盒子 `top` 不变、`root.scrollTop === 0` | `mouse.wheel` + rect 对比 |
| 5 | 打开查看器时背景 `.pxm-scroll` 被锁（计算后 `overflow-y: hidden`）、关闭后**精确还原**（回 `auto` 且滚动位置复原） | `getComputedStyle` + `scrollTop` |
| 6 | 375px 窄屏：文档 `scrollWidth ≤ clientWidth + 1`、长英文提示词/长模型名/超长项目名不被 `overflow-x:hidden` 裁掉 | `scrollWidth` vs `clientWidth` + 按内容定位长串承载元素 |
| 7 | 设置页「默认值」卡片：标签与值**同列堆叠**（左边界对齐、值在标签下方）；「标签 + 值」成组的那一对在窄屏下**仍留在同一行**（且长值在**自己内部**换行，不被裁掉）；两条 87 字符的长路径在 **520px / 375px** 下都不把 `#settingsDialog` 撑出横向滚动条，导出路径 `<input>` 随容器收窄 | rect 差值 + 左边界 + `#settingsDialog.scrollWidth` vs `clientWidth` |

**变异对照表**（`node tools/lane-mutations.mjs`，14 条严格变异全部被对应用例抓住；
脚本自身校验"每处 `find` 恰好命中一次"与"仓库原产物 sha256 前后一致"）：

| 变异 | 改坏的实现 | 抓住它的用例 |
|---|---|---|
| `M1-panel-height` | 面板根去掉 `height:100%` / `minHeight:0`（提交 `c56b518` 的根因） | 1、2、5（`scrollHeight 2534 == clientHeight 2534`：滚轮找不到可滚的盒子） |
| `M2-scroll-hidden` | 唯一滚动容器不再可滚（`overflowY: auto → hidden`） | 1、2、5（滚轮之后 `scrollTop` 仍为 0） |
| `M3-viewer-top-zero` | 查看器 `top` 退回 `0`（提交 `680b7d4` 的根因之一） | 3、5（`bar.top=16 < 40`；关闭按钮被标题栏带盖住，点击超时） |
| `M4-viewer-root-scrolls` | 查看器退回"整块一个 `overflow:auto`"（顶栏跟着内容滚走） | 4、5（根盒子成了滚动容器、顶栏位移） |
| `M5-no-background-lock` | 打开查看器时不锁背景 | 5（计算后 `overflow-y` 仍是 `auto`） |
| `M6-no-lock-restore` | 关闭时 `cleanup` 不还原背景 | 5（关闭后仍是 `hidden`） |
| `M7-prompt-unbreakable` | 提示词同时去掉 `overflowWrap:anywhere` 与 `wordBreak:break-word` | 6（`scrollWidth 666 > clientWidth 305`） |
| `M8-metarow-no-wrap-anywhere` | 元信息行的值去掉 `overflowWrap:anywhere` / `wordBreak` | 6（滚动区 `scrollWidth 798 > clientWidth 339`） |
| `M9-tile-name-no-wrap-anywhere` | 项目卡片名字去掉 `overflowWrap:anywhere` | 6（`scrollWidth 749 > clientWidth 321`） |
| `M10-field-row` | 设置页 `Field` 去掉 `flexDirection:column` | 7（控件与标签并排：左边界差 24px） |
| `M11-field-ungrouped` | 「标签 + 值」退回两个独立 flex 子项（提交 `97083a9` 的根因） | 7（值被换到下一行：`top` 差 26px） |
| `M12-no-overscroll-contain`（**信息性，无断言能抓住**） | 只去掉 `overscrollBehavior: contain` | 无 —— 已知观测盲区，见下 |
| `M13-field-group-nowrap` | 「标签 + 值」的组重新拿回 `whiteSpace:nowrap`（上一版为修 bug 1 加在**整组**上的对策） | 7（长路径无断点 → 组 `min-content` = 整条路径 → `#settingsDialog` `scrollWidth 687 > clientWidth 520`） |
| `M14-field-value-unbreakable` | 值的断行能力撤回（去掉 `overflowWrap:anywhere`） | 7（520px 下值被裁：`valueScrollWidth > valueClientWidth`；375px 下弹窗 `scrollWidth 403 > clientWidth 375`） |
| `M15-field-group-flex-wrap` | 给组加 `flexWrap:wrap`（"推荐做法"，**实测反例**） | 7（flex 按假设主轴尺寸划行 → 长值被整行推到标签下面：`top` 差 24px） |


**它仍然覆盖不到什么**（不要把这些当成已验证）：

- **真实 Electron 外壳**：真实的 `titleBarOverlay` 原生按钮、`--dsh-windows-titlebar-height`
  由 preload 写入的真实值、菜单宿主（`z-index:1100`）、原生全屏归零——本 lane 只是**模拟**
  了一条 40px 不透明带。真实窗口里"按钮真的被盖住/点不到"仍要靠 GUI 目视（§13.5）。
- **macOS / overlay 滚动条**：实测 headless Chromium 下滚动条不占宽度
  （`offsetWidth - clientWidth === 0`），所以 `lockBackgroundScroll` 里
  `scrollbar-gutter: stable` 那条分支（"锁上时内容不横移"）在 lane 里**走不到**，
  也量不出横移。
- **`overscroll-behavior: contain` 不可观测**：查看器是 `position: fixed` 的**兄弟**覆盖层，
  `.pxm-scroll` 不在它的滚动链上，"滚轮链式滚动到背景"在这套 DOM 拓扑下不可能发生
  （信息性变异 M12 已证实无断言能抓住）。T5 里轮询式的"背景没动"是**护栏**，
  真正的可证伪证据是计算后 `overflow-y` 与关闭后的还原。
- **图片内容**：lane 用自造的 800×800 PNG 顶替 `/pixmart/file/*`，只保证"能解码、布局尺寸对"，
  不覆盖真实图片的解码耗时、色彩、损坏图。
- **真实数据规模与网络**：`fetch` 全 stub（零真实网络），项目数、提示词长度、模型名长度
  都是夹具；真实 200 个项目 / 超长中文提示词下的滚动性能与懒加载节奏不在此列。
- **字体差异**：断行位置依赖实际字体，lane 用的是本机系统字体；换字体的机器上"刚好临界"
  的断行结论可能不同（夹具里的长串刻意留了大余量）。
- **输入方式**：只有鼠标滚轮；触摸/触控板惯性滚动、键盘滚动、拖滚动条都不覆盖。
- **reduced-motion / 动画**：入场动画只在等待 250ms 后测几何，动画本身（`.pxm-in`）不覆盖。

**§13.7 抓到的真实缺陷（已修，2026-10-05）**：设置页「数据目录」这一对是
`display:inline-flex` 的整组，**上一版为了修 bug 1（标签与值被 flex 拆散）把
`white-space:nowrap` 加在了整组上**——对 `1:1` / `ofox` 这类短值正确，但长值
（`C:\Users\...\.dsh\pixmart`、长导出路径）**一个断点都没有**，组的 `min-content`
就等于整条路径宽度（实测 652px），于是 520px 的设置弹窗出现横向滚动条
（`#settingsDialog.scrollWidth 687 > clientWidth 520`，文档本身不受影响）。
修法（两个目标同时成立）：组去掉 `whiteSpace:nowrap` 并保持
`inline-flex` + `alignItems:baseline` + `gap`；**标签** `whiteSpace:nowrap` + `flexShrink:0`
（它不会被拆散、也不会被压缩）；**值** `minWidth:0` + `overflowWrap:anywhere`
（长路径在**自己内部**换行，且 `anywhere` 把值的 `min-content` 压到一个字符，
组因此总能收窄进容器）。导出路径的 `<input>` 另补 `minWidth:0`（配合已有的
`width:100%` + `boxSizing:border-box`），保证它随容器收窄。
**两个反例**记在变异表里：①回到 `nowrap`（`M13`）→ 687 > 520 重现；
②按"推荐做法"给组加 `flexWrap:wrap`（`M15`）→ flex 按子项的**假设主轴尺寸**划行，
长值被整行推到标签下面，**拆散回归**（用例 7b 立刻变红）。所以实现里**故意没有**
`flexWrap:wrap`：不拆散靠"标签不可压缩 + 值可收缩"，不撑破靠"值在内部断行"。

---

## 14. 风险登记表

| # | 风险 | 等级 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | ~~client bundle 装载 / 构建工具链细节~~ → **P0 已取证**：装载契约（`ModuleLoader.load({id,factory})`）与 factory 签名（只给 `require`）已确认，并自建 [tools/asar.mjs](../tools/asar.mjs) 直接读 DSH 源码 | 低 | 仅剩 GUI 渲染未验 | 剩余项并入 R4（需装 `desktop` 才能验） |
| R2 | ~~图片 ContentBlock 精确形状未取证~~ → **P0 已取证**：`{type:'image', attachment: ImageAttachmentRef}`（[contract-notes §2](./contract-notes.md)） | 已消除 | — | 在 P1 工具里直接使用 |
| R3 | ~~`sidebar.panellist` + `main`(keyed) 配套注册~~ → **机制已由 live 插槽目录确认**（`id` ↔ `key` 一一对应，§8.2），**且已在真实 GUI 目视验证通过**（点击面板图标成功切换到我们的主面板） | **已消除** | — | — |
| R4 | 当前 profile 是 `desktop`（本会话正在运行） | 中 | 安装/重启打断用户 | 全程 scratch profile；应用到 `desktop` 与重启由用户单独确认 |
| R5 | 兼容端点差异（尺寸字段、b64 vs url、edits multipart、鉴权头） | 中 | 部分端点不通 | `apiMode` + `dialect` 显式配置；`testProvider` 探测；能力表缓存；不猜默认值 |
| R6 | `raw.githubusercontent.com` 直连失败 | 低 | 官方取证受阻 | 改用 web_search / 镜像 / 本机样本；只影响取证节奏 |
| R7 | 生图单次耗时可达数分钟 | 中 | 工具调用超时体验差 | `timeoutMs` 默认 180s 可配；工具描述明确告知耗时；批量用并发上限控制 |
| R8 | 厂商按次计费，可能误花钱 | 中 | 用户成本 | `pixmart_prompt` dry run 前置；`pixmart_batch` 上限 20；`usage.jsonl` 审计；描述里写明计费语义 |
| R9 | 密钥明文落盘 | 中 | 安全 | 支持 `apiKeyEnv`（推荐）；文件权限收紧；RPC 永不回传明文 |
| R10 | **Ofox 方言写错 → 静默失败**（参考图字段不被识别，照常出图但主体不一致） | 高 | 结果错却看起来成功，最难排查 | 方言由配置决定而非嗅探；带参考图的调用若降级去掉了参考图，返回 `degraded` 标记 + 告警（见 §7.4） |
| R11 | 用户尚未提供 Ofox Key | 低 | 无法真实联调 | 无 Key 时返回可读错误并指向设置页；**A2–A5 全部用本地 mock 端点验证**，不阻塞 P0 / P1 |
| R12 | 右侧栏 tab **无法插入**：宿主未向第三方开放 tab 声明与打开 API（`rightbar.session` 是已被 shell 占用的单槽） | 已规避 | 原「侧边栏预览」需求无处落地 | 改用 `shell.overlay` 浮层（§8.5.1）；P0 复探一次是否有未暴露途径，但不作为设计前提 |

---

## 15. 合规与复用边界

### 15.1 对参考项目的处理

- 全程**只读** `E:\Programs\trae\project\pixmart-ai`，不修改任何文件。
- **复用**：组织结构与方法（模块化提示词、尺寸能力校验、批量与归档的概念划分）。
- **重写**：全部提示词文本、全部实现代码。
- 若实施中确有逐字复用，则在 `NOTICE` 标注 MIT 版权与来源。

### 15.2 依赖策略

- **不引入**参考项目的 Electron / React 桌面栈、`sharp`、`sql.js`、`electron-store`、`electron-updater`。
- 共享运行时（DSH、Cordis、React）优先声明为 `peerDependencies`，避免复制 runtime identity。
- 运行时不引入第三方 HTTP 库（用 `node:` 全局 `fetch`）；multipart 用 `FormData` + `Blob`。

### 15.3 数据与隐私

- 图片与提示词只落在用户本机 `$DSH_HOME/pixmart`，不上传任何地方。
- 只读路由不鉴权但仅服务本机 GUI 同源请求；路径严格限定在 `dataDir` 内。
- README 明示：插件会把提示词与参考图发送给用户自己配置的第三方厂商端点。

---

## 16. 已确认决策

以下 6 项已由用户于 2026-10-05 确认，作为实施输入：

| # | 决策项 | **确认结论** | 落点 |
|---|---|---|---|
| 1 | 插件数据目录位置 | `$DSH_HOME/pixmart` | §7.3 / §7.8 / §9 |
| 2 | 是否额外导出一份到会话工作目录 | **否**（当初落的字段是 `exportToWorkspace`；**该字段已删除**——没有任何代码读它，工作区副本是无条件自动的，见 §7.9 / 变更记录 v1.10） | §7.2 / §7.9 |
| 3 | 生成的图是否在对话内直接可见 | **是** → `attachmentInConversation: true`（附件服务可用时） | §7.9 |
| 4 | P0 完成后是否先交付「契约笔记 + 最小演示」再推 P1 | **是** | §12 / §12.1 |
| 5 | 是否需要 3D / 视频 / 原生 Gemini 协议 | **否**，v2 再议（Ofox 的 `gemini-native` 调用路径除外，见 §3.2） | §3.2 |
| 6 | 首批用于联调的厂商与端点 | **Ofox** —— OpenAI 兼容 `https://api.ofox.io/v1` + Gemini 原生 `https://api.ofox.io/gemini/v1beta`；**API Key 由用户自行填入** | §7.4.1 / §9.1 |

### 16.1 实施前置（非阻塞）

| # | 事项 | 说明 |
|---|---|---|
| 1 | Ofox API Key | 用户后续自行填入。**未填入不阻塞 P0 / P1**：A2–A5 全部用本地 mock 端点验证 |
| 2 | Ofox 默认联调模型 | 暂定 `google/gemini-3.1-flash-lite-image`（走 Gemini 原生）；如需换成 `openai/gpt-5.5`（走兼容端点）只需改配置 |
| 3 | 端点二次核对 | §7.4.1 的接口形态来自参考项目实现，联调首日需与 Ofox 官方文档核对一次 |

---

## 17. 附录

### 17.1 cordis.patch.yml

```yaml
# dsh bundle patch: 把本插件插入 profile 的层栈
- insert:
    - id: dsh-pixmart
      name: dsh-pixmart
      config: {}
```

> 覆盖时必须**重述全部所需键**（`config` 是整段替换，不是深合并）。

### 17.2 会话内使用示例

```text
用户：用默认模型生成一张 1024x1024 的白底主图

Agent 调用 pixmart_prompt    { module: "main.white-bg", size: "1:1" }
      → { prompt: "...", size: "1:1" }

Agent 调用 pixmart_check_size { model: "google/gemini-3.1-flash-lite-image", size: "1:1", apiMode: "gemini-native" }
      → { supported: true, nearest: [] }

Agent 调用 pixmart_generate   { module: "main.white-bg", size: "1:1", project: "白底主图" }
      → { ok: true, apiMode: "gemini-native", degraded: [],
          files: [{ path: ".../a1b2c3d4-white-bg-01.png", width: 1024, height: 1024 }],
          attachments: [ ... ], usage: { images: 1 } }
```

### 17.3 一次性批量示例

```text
Agent 调用 pixmart_batch {
  size: "1:1",
  project: "详情图-01",
  items: [
    { module: "detail.hero" },
    { module: "detail.scene" },
    { module: "detail.ambience" },
    { module: "detail.selling-point" }
  ]
}
→ { ok: true, items: [ {status:"ok", files:[...]}, ... ], failed: 0 }
```

### 17.4 术语

| 术语 | 含义 |
|---|---|
| Bundle | 插件作者分发的包，`package.json.dsh.bundle.patch` 指向配置层 |
| Profile | 用户运行的组合，`$DSH_HOME/profiles/<name>/` |
| Patch 层 | `cordis.patch.yml`，向配置树插入/覆盖行 |
| Slot | 客户端 UI 插槽，`inject` + `register` 两段式注册 |
| apiMode | 本插件的四种调用形态：`images-generations` / `images-edits` / `chat-image` / `gemini-native` |
| dialect | 请求字段的方言：`standard`（OpenAI 标准语义）/ `ofox`（`input_images` + `output_format`） |
| 降级链 | 在不换端点、不放弃目标的前提下逐级去掉不兼容参数重试，并回报 `degraded` |
| 内容寻址文件名 | `<sha256前8位>-<slug>.<ext>`，天然去重与长缓存 |

### 17.5 参考索引

| 资料 | 用途 |
|---|---|
| [DSH 插件开发 Skill v3.1.0](https://github.com/NanmiCoder/dsh-agent-teams/blob/v0.1.15/skills/dsh-plugin-development/SKILL.md) | 契约细则、验证矩阵、分发与 HMR 边界 |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT） | 官方模板兜底取证源 |
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | 上架社区市场 |
| [dshmarket（本机已装）](https://www.npmjs.com/package/dshmarket) | 本机唯一完整的双面插件样本：bundle + client 产物 + patch 层实证 |
| `pixmart-ai`（本机只读） | 模块化提示词、尺寸能力表、批量归档的概念来源；**Ofox 端点契约的取证来源**（见 §7.4.1） |

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-05 | 初稿：基于本机实测契约与三项决策（B 方案 / 仅 OpenAI 兼容 / 提示词重写） |
| v1.1 | 2026-10-05 | 同步 6 项确认决策；锁定首批厂商 **Ofox**（D2 修订，新增 D8 方言 + Gemini 原生端点、D9 密钥由用户填入）；新增 §7.4.1 Ofox 专项契约（两端点 / 五坑 / 路由表 / 尺寸）；§16 由「待确认」改为「已确认决策」；新增风险 R10（方言静默失败）、R11（Key 未就绪）；测试矩阵补 Ofox 方言 golden 与 mock 端点路径 |
| v1.3 | 2026-10-05 | **P0 落地 + 据实测修订方案**。完成：A1（scratch profile 安装、自动并入 `dsh.profile.bundles`、`--dump-config` 断言）、S1 宿主半边（真实 Loader 组合 + 手写 JSON Schema 被接受 + `schemas()` 投影一致）、S3（图片块 = `{type:'image', attachment}`）。修订：`host.call` → 本插件 HTTP API（§6 / §7.11 / §8.5.4 / 架构图 / 分层铁律）；**可选服务不得在 `apply()` 探测**（§7.1，实测 `fs`/`credentials` 延迟就绪）；`defineTool` 只是编译糖 → 改为手写零运行时依赖定义（§7.2 / §7.7）。新增 [contract-notes.md](./contract-notes.md)、[tools/asar.mjs](../tools/asar.mjs)、`pixmart_ping` 与 `PIXMART_P0_MARKER` 自检钩子。**P0 验收全部通过**：A1（安装）、S1（含 desktop 活宿主实调）、S2（GUI 目视：设置页 + 侧边栏面板切换）、S3；**R2 / R3 关闭**。另据实测修正：`DSH_HOME` 在 GUI 启动的宿主里未设置 → 数据目录回落 `<用户主目录>/.dsh`；插件安装热生效而 host 代码改动需重启 |
| v1.4 | 2026-10-05 | **P1 落地**（提交 `e83c150`）。新增：`src/config.ts`（容错解析 + 脱敏视图）、`src/store/{paths,atomic,mutex,config-store,project-store}.ts`、`src/vendor/openai-compat.ts`（4 apiMode × 2 方言 + 降级链 + 重试）、`src/prompts/{types,modules,build}.ts`（24 模块）、`src/sizes.ts`、`src/image-info.ts`、`src/tools/*`、`test/vendor.test.mjs`（18 项）。两处实现修正：**降级链只在 `bad_request` 触发**（5xx/429 换档位会重复花钱）、**按哈希前缀扫描真正去重**。三处与方案偏离已记录（不维护索引 / 增加 `finish` 片段 / 工具文件合并）。`pnpm verify` 全绿；A2 全链待宿主重启 + 真实 Key |
| v1.5 | 2026-10-05 | **P2 + P3 落地，测试 18 → 65 项**。P2（`1eebf72`）：`batch` / `projects` / 运行注册表 / `usage.jsonl` 硬计数。P3：`/pixmart/api/*` + 图片只读路由（`08a0e63`）、设置页 + 作品库 + `shell.overlay` 实时预览卡（`c6b342c`）、client 契约测试 13 项（`4518a7b`）、jsdom lane 10 项（`3ec6cd2`）。**三处真实缺陷**：①路由在 `apply()` 里 `ctx.get('webServer')` → 永不注册（`7a2ca2c`，违反 §7.1 自己定的规则）；②浮层自动展开缺 `isActive` → 结束后不收起（`3ec6cd2`，违反 §8.5.5 / D12，由 jsdom lane 首跑抓出）；③「账本 0 与可见项目对不上」→ **账本保持真实、历史产出另列**（`1671c63`）。新增 §12.2 P4 待办（含剥离 `__test__`）与 §12.3 未执行的付费验证 |
| v1.6 | 2026-10-05 | **新增浏览器 lane（§13.7）**：`playwright-core`（`devDependencies`，`dependencies` 仍为空）+ 系统 Edge/Chrome，**不下载浏览器**；加载**未经修改的原产物** `client/client.js`（自证断言逐字节比对 sha256），经真实 `apply(ctx)` 注册路径挂进复刻的 shell 骨架（40px 标题栏带 + `--dsh-frame-chrome-top` + `.centerCol` 直系 flex 子项 + `display:contents` 槽锚点）。10 条断言全按几何（`getBoundingClientRect` / `scrollTop` / `scrollWidth` / `elementFromPoint` / 真 `mouse.wheel()`）。新增 `pnpm test:browser` 并挂进 `pnpm verify`；无浏览器时**醒目失败**（`PXM_LANE_ALLOW_SKIP=1` 可显式放行）。新增 [tools/lane-mutations.mjs](../tools/lane-mutations.mjs)：11 条反向变异全部被对应用例抓住，另记 1 条已知观测盲区（`overscroll-behavior` 在本 DOM 拓扑下不可观测） |
| v1.7 | 2026-10-05 | **修掉 lane 抓到的"长路径撑破设置弹窗"**（`#settingsDialog.scrollWidth 687 > clientWidth 520`，520px + 87 字符路径）。根因是 v1.6 之前为修 bug 1 把 `whiteSpace:nowrap` 加在「标签 + 值」的**整组**上：短值没问题，长路径一个断点都没有 → 组的 `min-content` = 整条路径宽度。改法：组去掉 `nowrap`（保持 `inline-flex` + `baseline` + `gap`）；标签 `nowrap` + `flexShrink:0`（不拆散、不压缩）；值 `minWidth:0` + `overflowWrap:anywhere`（在**自己内部**换行，`min-content` 压到一个字符）；`<input>` 补 `minWidth:0`。**故意不加** `flexWrap:wrap`：实测它会把长值整行推到标签下面（拆散回归，`M15` 为证）。浏览器 lane 10 → **11** 条断言（新增 520px/375px 两条 87 字符路径的无溢出用例），严格变异 11 → **14** 条（`M13`/`M14`/`M15`），`pnpm test` 仍为 **260** 项全绿 |
| v1.8 | 2026-10-05 | **P4 待办第 1 条落地：打包步骤剥离 client bundle 的 `__test__`**（§11.5 新增）。新增 `tools/strip-test-hooks.mjs`（按锚句定位 + 花括号配平 + 前缀/后缀逐行自证 + `node --check`，**不引入打包器、不加依赖**）、`pnpm build:client`，`files` 加 `dist`，`pretest` / `prepack` 自动产出，`dist/` 写入 `.gitignore`（产物不入库）。新增 `test/strip-test-hooks.test.mjs`（9 项，含**陈旧性守卫**：把当前源码现场剥一遍与 `dist/client.js` 逐字节比对；缺失→带原因跳过，陈旧→失败并提示 `pnpm build:client`）。**源码 `client/client.js` 一个字节未改**（五套 node:test + 浏览器 lane 仍从它的 `__test__` 取件）。**⚠️ `exports["./client"]` 仍指向 `./client/client.js`**：切换是 P4 打包的最后一步，等停止迭代后再做。`pnpm test` 260 → **269** 项、`pnpm test:browser` **11** 项全绿 |
| v1.9 | 2026-10-05 | **README 重写为用户视角**（安装 / 首次配置 / 怎么用 / 产物在哪 / 费用 / FAQ / 已知限制 / 开发者），不再写「P0 进行中」这类内部阶段状态。诚实标注：**未发布到 registry、`private: true`**，只能用本地路径 / git 地址安装；P0–P3 已完成、**P4 未完成**；不做 3D / 视频、不做服务端缩略图、macOS 未验证、当前 0.0.1 |
| v1.10 | 2026-10-06 | **导出落点收敛 + 死字段清理**。① 导出只剩一条口径：`resolveExportRoot` / `planProjectExport`（`src/tools/export-output.ts`）被 `POST /projects/<id>/export` 与 `pixmart_projects action=export` **共用**——工具新增可选入参 `dir`，未给则用配置 `exportDir`，两者都没有即失败（错误码 `no_export_dir`，与 HTTP **同一句文案**）。**彻底删除** `<dataDir>/exports/` 这条隐式默认落点（用户磁盘上已存在的该目录不动，只是不再写入）。② 删除死字段 `exportToWorkspace`：类型 / 默认值 / `parseConfig` 里都没有了，`ConfigStore` 每次写盘顺手把它从盘上抹掉（残留键读盘不报错）。③ 相应更新 README、contract-notes §16.3/§16.4、作品库优化方案。`pnpm test` 291 → **298** 项、`pnpm test:browser` **11** 项全绿 |
| v1.11 | 2026-10-06 | **方案 B：取消 Agent 的独立导出能力**（[contract-notes §16.6](./contract-notes.md)）。v1.10 统一了导出的**落点**，却漏了**发起者**：用户点「导出」是刻意挑选，Agent 调 `action=export` 只是它自己的中间动作，两者写同一个用户目录会互相污染。① `pixmart_projects` 删除 `export` action（连同入参 `dir` 与返回字段 `targetDir`/`files`/`warnings`/`count`）：调它走未知 action 的既有失败路径（`invalid_args`），**不写任何文件**；action 枚举 = `list / get / delete / restore / usage`；工具描述里不再出现 `export`/`exports/`/`exportDir`。② 补上 Agent 的替代路径：`action=get` 新增 **`workspaceOut: {workspace, dir, exists}`**（复用 `sessionWorkspace()` / `WORKSPACE_OUT_DIR`，只探测不创建；取不到工作区时字段**缺省**），`get` 另有专门渲染分支，说清"原件在数据目录 / 暂存副本在工作区 `pixmart-out/` / 本工具不导出到用户目录"。③ HTTP `POST /projects/<id>/export` **语义与错误码全不变**，仍是唯一入口；`resolveExportRoot` / `planProjectExport` / `NO_EXPORT_DIR_MESSAGE` 原地保留（只剩 HTTP 一个调用方）。④ `pixmart_providers` 的文本不再提"Agent 调 action=export"。⑤ 用户磁盘上已有的 `<数据目录>/exports/`（实测 2 个文件）**原样保留**。测试：删除 export 能力的 4+2+1 条用例改为**反断言**（枚举逐项相等 / `dir` 不存在 / 描述无 `export` / 干净数据目录无 `exports/` / `get` 的缺省），`pnpm test` 298 → **299** 项、`pnpm test:browser` **11** 项全绿 |
