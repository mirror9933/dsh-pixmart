# dsh-pixmart P0 契约笔记

> 记录 P0（骨架 + 契约 spike）的**取证结论**。每条结论都带证据来源，不写推测。
> 与 [技术方案](./dsh-pixmart-技术方案.md) 冲突时**以本文件为准**，并回头修订方案。

| 项 | 值 |
|---|---|
| 日期 | 2026-10-05 |
| DSH 版本 | **0.2.0-rc.2**（`dsh --version`） |
| 内置 Node | **v24.18.1**（`resources/runtime/versions.json`）；宿主机 Node v24.16.0 |
| 内置 pnpm | 11.7.0 |
| 插件版本 | dsh-pixmart@0.0.1 |
| 验证 profile | `px`（仅 dsh-base）、`pxh`（dsh-base + dsh-headless）；**未触碰 `desktop`** |

## 0. 取证方法

本机 DSH 代码打包在 `resources/app.asar` 内，`dsh/` 不可直接读；npm 上 `@deepseek-ai/dsh-tools`
的依赖图含未发布包（`@deepseek-ai/dsh-type-meta` 404），装不上。

因此工具链自建：`tools/asar.mjs`（无依赖的 asar 读取器，**按花括号配对定位 JSON 头**，
不假设 pickle 偏移）。支持 `count / find / read / extract / grep`，`grep` 可带路径过滤。
本文件所有 `dsh/node_modules/...` 引用均指 asar 内路径。

## 1. S1 —— host 工具可见性 ✅ 通过（宿主半边）

### 1.1 结论

| 断言 | 结果 | 证据 |
|---|---|---|
| 插件在真实 Loader 组合里被装载，`apply()` 执行 | ✅ | 两阶段 marker 落盘（`phase: "apply"` / `"settled"`） |
| `ctx.tools.register()` 接受**手写**的 ToolDefinition | ✅ | 无异常，marker 记录 `registered: ["pixmart_ping"]` |
| 注册表投影出的模型面 schema 与手写的一致 | ✅ | `ctx.tools.schemas()` 取回了我们的 `parameters` 原文 |
| 模型确实会调用它 | ✅ **已通过** | 在活的 `desktop` 宿主里直接调用 `pixmart_ping` 成功（见 §1.5） |

`ctx.tools.schemas()` 取回的投影（= 模型看到的那一份）：

```json
{
  "name": "pixmart_ping",
  "description": "dsh-pixmart 契约自检工具。…",
  "parameters": {
    "type": "object",
    "properties": {
      "echo": { "type": "string", "description": "原样回显的字符串，用于确认参数传递链路。" }
    }
  }
}
```

### 1.2 `defineTool` 是糖，不是必需（重要）

证据：`dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`

| 行 | 内容 |
|---|---|
| L838 | `function defineTool(options)` |
| L848 | `const parameters = parameterSchemaSpecToJsonSchema(options.parameters)` |
| L849 | `const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema)` |
| L851-871 | 返回 `{name, description, parameters, output:{schema, render, presentationMeta?}, execute, ...}` |
| L866-870 | 仅额外包一层 `validate(args)` 再调 `userExecute` |
| L802-811 | `parameterSchemaSpecToJsonSchema` → `{ type:"object", properties, required? }` |
| L792-796 | `valueSchemaSpecToJsonSchema` 只做 `compileValueSchema` + `assertSupportedJsonSchema` |

**含义**：`defineTool` 的产物就是一个普通对象；第三方插件手写等价对象即可，
**运行时零 `@deepseek-ai` 依赖**。官方 `read_image` 的定义
（`dsh-tool-fs/lib/index.js` L974-1047）就是同一形状的参照。

手写时两处必须是**编译后的原始 JSON Schema**：
- `parameters`：`{ type:'object', properties:{…}, required:[…]? }`（根 `required` 为数组）
- `output.schema`：同一形状，宿主用 `assertSupportedJsonSchema` 校验

交叉印证：`cordis_inspect Tool.listTools` 返回的活工具表里，`read` 的 `parameters` 正是
`{type:'object', properties:{…}, required:['file_path']}`——原始 JSON Schema 形态。

### 1.3 服务可用性必须**按阶段**看（重要）

同一个 `px` profile，两个阶段探测结果不同：

| 服务 | `apply()` 时刻 | 3s 后（settled） |
|---|---|---|
| `tools` / `attachments` / `timer` / `storage` / `commands` / `systemPrompt` / `web` | ✅ | ✅ |
| `fs` | ❌ 缺失 | ✅ 可用 |
| `credentials` | ❌ 缺失 | ✅ 可用 |
| `webServer` | ❌ | ❌（`px` 无 web 应用，符合预期） |

**规则**：可选服务只能在**工具 `execute()` 时**或 `ctx.inject([...], cb)` 里判定；
在 `apply()` 里探测会产生系统性误判，进而错误地走降级分支。

### 1.4 `DSH_PROFILE` 不可作为当前 profile 依据

marker 里 `profileEnv: "desktop"` 而 `profileFlag: "px"`——`DSH_PROFILE` 是**父子进程继承**的
环境变量（本次实验从 desktop 会话里启动子进程），不是被启动 profile 的真实值。
需要真实 profile 时读 `process.argv` 的 `--profile`。

### 1.5 desktop 活宿主实测——S1 闭环

经用户确认后执行 `dsh plugin --profile desktop add <path>`，**无需重启**：运行中的宿主热加载了
插件，`pixmart_ping` 立刻出现在模型的工具目录里，并被成功调用。返回节选：

```
pixmart_ping ok=true dsh-pixmart@0.0.1
node: v24.18.1
cwd: C:\Users\30461\.dsh\profiles\desktop
可用服务: tools, attachments, webServer, fs, timer, storage, credentials, commands, systemPrompt, web
缺失服务: (空)
```

| 发现 | 说明 |
|---|---|
| desktop 组合下 **10 个服务全部可用** | 含 `webServer` → 方案 §7.10 只读路由与 §7.11 HTTP API 均可行；`credentials` 也可用，密钥可走凭据服务 |
| **`DSH_HOME` 在 GUI 启动的宿主里未设置** | 首版 `resolveDataDir` 因此退化成 `process.cwd()/pixmart`，而 cwd 正是 profile 目录——踩中方案 §4.6 明令禁止的「用 cwd 散落用户数据」。**已修**：显式配置 > `$DSH_HOME` > `<用户主目录>/.dsh`（实测期望值 `C:\Users\30461\.dsh\pixmart`） |
| **host 代码改动不热生效** | 修复后重新调用 `pixmart_ping`，返回仍是旧行为 → **插件安装热生效；host 代码改动需重启**（与 Skill §7.2 一致，客户端 bundle 例外） |
| 安装是「热挂载」而非「改配置重启」 | 说明 profile 的 `dsh.profile.bundles` 变更会被运行中的宿主感知 |

## 2. S3 —— 图片 ContentBlock 形状 ✅ 通过

证据：`dsh/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js`（官方 `read_image` 工具）

```js
// L955-963
function imageReadContent(value) {
  return [
    { type: "text", text: formatImageReadOutput(value.path, value.image) },
    { type: "image", attachment: imageRefFromValue(value.image) },
  ]
}
// L917-927 —— attachment 的精确形状
{
  attachmentId, mediaType, bytes, width, height,
  ...(name !== undefined ? { name } : {}),
  ...(originalDimensions !== undefined ? { originalDimensions: { width, height } } : {}),
}
```

**含义**：
- `output.render(args, value)` 返回 `ContentBlock[]`；图片块是 `{ type:'image', attachment }`，
  其中 `attachment` 就是 `ctx.attachments.saveImages()` 返回的 `ImageAttachmentRef`。
- 因此生图工具的正确链路是：**字节先 `saveImages()` 落存 → `output.render` 用该 ref 产图块**。
- 参考实现在 `output` 里还用了 `presentationMeta`（L995），可用于卡片副标题。

## 3. S2 —— client bundle ⏸ 契约已定，GUI 渲染待验

### 3.1 装载契约（已取证）

| 事实 | 证据 |
|---|---|
| 产物必须是 `window.__ModuleLoader__.load({ id, factory })` | `dsh-client-modules/lib/client.js:1`；本机 `dshmarket/client/client.js:1` |
| `id` 用 **npm 包名** | `dshmarket` 的 `id: "dshmarket"` |
| 执行 bundle 只注册 factory，副作用在 materialize 时发生 | `dsh-client-modules/README.md:68` |
| **`factory(require)` 只收到 `require`** | 同上：「factory(require) → exports, memoized in loadCache」 |
| 解析顺序：平台 seed 表 → 已 memo 记录 → boot-graph 行 → 已注册 factory；其余抛错 | `README.md:68` |

### 3.2 **RPC 机制修正（影响方案 §6.3 / §7.11 / §8.5.4）**

`host.call` 只在 **Builtin 的「dynamic Client half」** 语义下存在
（`cordis_inspect Builtin.listBuiltins` 原文："Plain-JavaScript symbols available to a
**dynamic Client half**"）。包式 client 半的 factory 只拿到 `require`。

工作参照：`dshmarket` 的 client 全部走**自己的 HTTP 路由**
（`fetch(api('/dsh-market/…'), { cache: 'no-store' })`，`src/client/MarketSection.tsx` 等约 60 处），
并用一个 `api()` 助手把路径解析到挂载点，以支持路径前缀部署
（`src/client/self-check.ts:131` 注释记录了 #345 的踩坑）。

**结论（方案须改）**：
- 包式 client ↔ host 的通道 = **本插件自己的 host HTTP 路由**，不是 `host.call`。
- HTTP 基址必须**相对挂载点解析**，不能写死根绝对路径。
- 这反过来让 §8.5 的实时预览更简单：轮询就是一个 `fetch`，天然支持 `cache: 'no-store'`。

### 3.3 已完成的验证 / 待办

- ✅ `client/client.js` 通过 `node --check`；`exports["./client"]`、`cordis.patch.yml`、`lib/index.js` 均存在
- ✅ `package.json` 声明 `dsh.client.platform: "web"` 与 `dsh.bundle.patch`
- ✅ `settings.section` 注册写法对齐 `dshmarket/src/client/index.ts:158-172`（`slots.inject` 内 `slots.register({name,id,order,label}, Component)`）
- ✅ **已通过（R3 收口）**：刷新页面后，「电商生图」设置页条目出现、侧边栏面板图标出现，**点击图标能把中央主面板切换到我们的页面**——`sidebar.panellist` 的 `id` ↔ `main` 的 `key` 一一对应，在真实 GUI 中得到验证
- 附带结论：`dsh plugin --profile desktop add` 之后**宿主热挂载插件，且 client bundle 刷新页面即生效**，无需重启（host 代码改动仍需重启，见 §1.5）

## 4. A1 —— 从零安装 ✅ 通过

```
dsh plugin --profile px  add E:\Programs\agent\dsh-pixmart
dsh plugin --profile pxh add E:\Programs\agent\dsh-pixmart
```

结果（`$DSH_HOME/profiles/<p>/package.json`）：

```json
{
  "dependencies": { "dsh-pixmart": "link:E:/Programs/agent/dsh-pixmart" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-pixmart"] } }
}
```

`dsh --profile px --dump-config` 末尾出现我们的 patch 层：

```yaml
# == dsh-pixmart
- id: dsh-pixmart
  name: dsh-pixmart
  config: {}
```

**结论**：`dsh.bundle.patch` 声明被识别，bundle 列表**自动对账**（无需手写 profile manifest），
本地路径安装走 `link:`。与方案 §11.2 一致。

## 5. 环境陷阱备忘

| 陷阱 | 事实 | 影响 |
|---|---|---|
| `dsh plugin --help` 需要 `--profile` | 缺参会直接报错 | 所有 plugin 子命令都要带 profile |
| `dsh.cmd` 退出码恒为 1 | 用 Electron 以 Node 模式跑 `dsh-desktop-host/lib/cli.js`，`exit /b %errorlevel%` 不透传成功 | **不能用退出码判断成功**，要看输出（`Done in …`） |
| `dsh --profile <p>` 无应用时会挂住 | `px` 只有 dsh-base，没有 app 入口 | 验证脚本必须自带超时 + `taskkill /T` |
| `taskkill` 必须用 `/T` | 直接 kill cmd 会留下 Electron 子进程 | 用 `/PID <cmdPid> /T /F`，且**绝不能**按进程名杀（会误杀桌面端） |
| npm 上 `@deepseek-ai/dsh-tools` 不可安装 | 依赖图含 `@deepseek-ai/dsh-type-meta`（404） | 第三方插件不能依赖它 → 手写定义（见 §1.2） |

## 6. 对技术方案的修订清单

| 方案位置 | 原写法 | 修订为 | 依据 |
|---|---|---|---|
| §6.3 / §7.11 | `host.call(method, args)` 包私有 RPC | 本插件自己的 HTTP 路由（`/pixmart/api/*`），相对挂载点解析 | §3.2 |
| §8.5.4 | 用 `host.call` 轮询 | `fetch('/pixmart/api/runs', {cache:'no-store'})` | §3.2 |
| §7.1 | 「可选服务用 `ctx.get()` 判断」 | 补：**只能在 execute/inject 时判断，不能在 apply()** | §1.3 |
| §7.2 / §7.7 | 依赖 `@deepseek-ai/dsh-tools` 的 `defineTool` | 手写原始 JSON Schema 的 ToolDefinition，零运行时依赖 | §1.2 |
| §7.7 | `output.render` 出图块（形状待定） | `{ type:'image', attachment: ImageAttachmentRef }` | §2 |
| §7.4 | 端点/方言 | 不变 | — |

## 7. 复现命令

```powershell
# 构建
pnpm build

# 安装到 scratch profile
$dsh = 'E:\Program Files\deepseek harness\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile px add E:\Programs\agent\dsh-pixmart
& $dsh --profile px --dump-config          # 断言出现 dsh-pixmart 层

# 宿主半边自检（不需要模型凭据）
$env:PIXMART_P0_MARKER = 'E:\Programs\agent\dsh-pixmart\.probe\p0-marker.json'
$p = Start-Process -FilePath $dsh -ArgumentList '--profile','px' -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 16
Get-Content $env:PIXMART_P0_MARKER
taskkill /PID $p.Id /T /F                  # 必须 /T，且不可按进程名杀

# asar 取证
node tools/asar.mjs count
node tools/asar.mjs grep "ContentBlock" 30 "dsh-(tools|session)/"
```

## 8. 未决项

| # | 事项 | 阻塞对象 | 需要什么 |
|---|---|---|---|
| 1 | ~~模型实际调用 `pixmart_ping`~~ | — | ✅ 已闭环（§1.5） |
| 2 | ~~设置页 / 侧边栏面板在真实 GUI 渲染~~ | — | ✅ 已闭环（§3.3，R3 关闭） |
| 3 | 图片块在对话卡片中的实际渲染效果 | P1 验收 A2 | 需要一次真实生图（P1 才有工具） |
| 4 | host 代码改动需重启 | 每次改 host 都要重启宿主 | 属预期行为（§1.5），无需解决，只需记住 |
