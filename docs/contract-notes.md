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

## 9. P1 状态与新增结论

**代码完成，验证部分完成。** 提交 `e83c150`。

### 9.1 已验证

| 项 | 证据 |
|---|---|
| `pnpm verify` 全绿（typecheck + build + 18 项测试） | `test/vendor.test.mjs`，Node 内置 runner，零额外依赖 |
| 6 个工具在真实 Loader 组合中注册，且 `required` 投影正确 | `px` profile 的 marker（`tools[]`） |
| Ofox 方言：`input_images` / `output_format` 而非 `image` / `response_format` | mock 端点断言请求体 |
| Gemini 原生：端点为 `/gemini/v1beta/models/{m}:generateContent`、`x-goog-api-key`、`aspectRatio`、`inlineData` 解析 | 同上 |
| 路由表：`gpt-image` + 参考图 → `images-edits`（multipart）；Gemini 图像 + Ofox → `gemini-native` | 同上 |
| 重试与不重试：429 后成功；审核拒绝 1 次即止；5xx 重试耗尽 | 同上 |
| 降级链：`quality` 被拒 → 去掉后成功并回报 `degraded:['quality']` | 同上 |
| 尺寸：`1:1`↔`1024x1024` 双向归一化；不支持时给最近邻且不发请求 | 同上 |
| 配置容错：脏 JSON 被隔离、不阻断启动 | 同上 |
| 内容寻址去重：同字节不同 slug → 同一个文件 | 同上 |

### 9.2 未验证（需要宿主重启 + 真实 Key）

| 项 | 原因 |
|---|---|
| 真实 desktop 宿主里调用 `pixmart_generate` 产出图片（A2 全链） | 需要 (a) 重启宿主加载新 host 代码，(b) 有效 Ofox Key |
| 图片在对话工具卡片中的实际渲染效果 | 同上，且需要一次真实生图 |
| 参考图经 `ctx.fs` 读取的实际行为 | 依赖真实会话工作目录 |

### 9.3 P1 的两个实现修正（重要）

| # | 问题 | 修正 |
|---|---|---|
| 1 | **可重试错误走了降级链**：5xx/429 会逐档重试整个链，把同一个请求反复花钱重发 | 降级链**只在 `bad_request`（参数被服务端拒绝）时触发**；其余可重试错误在重试耗尽后直接失败。测试用例 `5xx 重试到耗尽后失败` 锁住这个语义 |
| 2 | **内容寻址没有真正去重**：文件名含 slug，同图不同 slug → 两个文件 | 落盘前按哈希前缀扫描目录复用已有文件；slug 仅用于可读性 |

### 9.4 与方案的偏离

| 方案 | 实现 | 理由 |
|---|---|---|
| §7.8 维护 `index.json` | **不维护索引**，列表由扫描 `projects/*/project.json` 得出 | 「扫描即可重建」是索引的超集：没有可损坏的索引，A6 变成结构性成立而不是靠恢复逻辑 |
| §7.5 `fragments` 五键 | 增加可选 `finish`（材质质感） | 电商图里「质感」是与光影/构图独立的轴 |
| §6.1 `src/tools/` 每工具一文件 | 合并为 `meta.ts`（3 个只读工具）+ `generate.ts`（generate/edit） | 两者共享大量参数解析与项目落盘逻辑，拆开反而重复 |

## 10. A2 真实链路验收结果（2026-10-05）

**通过。** 用户完成：填入 Key → 重启宿主 → 真实生图一次。

### 10.1 验收记录

| 检查点 | 结果 |
|---|---|
| 6 个工具重启后就位 | ✅ `pixmart_ping` 的 `dataDir` = `C:\Users\30461\.dsh\pixmart`，确认 P0 的 `DSH_HOME` 修复生效 |
| 密钥 | ✅ 长度 70，`resolveApiKey` 来源为 `config` |
| 零花费预演 | ✅ `check_size` → `尺寸可用：1:1（Gemini 图像模型，gemini-native）`；`prompt` 输出 1120 字提示词 |
| 真实生图 | ✅ `ok:true`；`ofox / google/gemini-3.1-flash-lite-image / gemini-native`；1 次请求；4655ms；`degraded: []` |
| 落盘 | ✅ `projects/2026-10-05-A2验收/images/19f5787b-main.white-bg-01.jpg`（77228 字节）；`project.json` 完整 |
| 内容寻址 | ✅ 文件名前缀与记录 sha256 前缀一致 |
| **对话卡片内嵌图** | ✅ 图片直接渲染在工具卡片里 |

### 10.2 暴露的四个问题

| # | 问题 | 等级 | 建议 |
|---|---|---|---|
| **F1** | **`aspectRatio` 未被遵守**：请求 `1:1`，实际 **1408×768**（≈1.83:1） | 高 | `generationConfig.imageConfig.aspectRatio` 对该端点/模型无效（参考项目同一写法，疑端点已变）。需探测正确字段（可能还要 `imageSize`）。**在此之前 `gemini-native` 的尺寸承诺不可信** |
| **F2** | 模块文本假设有参考图（`main.white-bg` 含 "of the reference image"），文生图场景语义错位 | 中 | `buildPrompt` 需感知 `hasReferences`，无参考图时改用虚拟产品表述 |
| **F3** | 无产品描述时模型**自行编造真实品牌包装**（生成了 Clorox 图） | 中 | 商用有 IP 风险。文生图路径应把 `product` 设为必填或注入中性描述 |
| **F4** | `gemini-native` 实际返回 **JPEG** | 低 | **不是缺陷**：魔数嗅探 + 扩展名映射已正确处理。"请求 png" 只适用于兼容路径的 `output_format` |

### 10.3 遗留（已关闭）

`pixmart_providers` 曾因 `output.schema` 误用 `additionalProperties: false` 而失败；
修复 `8bce89c` 已在重启后验证通过（见 §12.1）。

### 10.4 新实证结论：宿主工具返回校验是一道真实闸门

`output.schema` 声明 `additionalProperties: false` 而返回值超出声明时，调用**直接失败**
（`tool "…" returned invalid value`）。P1 的 18 项单测没有覆盖这一点——
应补一条测试：把每个工具的返回值喂给 `output.schema` 校验器。这属于"真实组合才暴露"的契约。

## 11. F1–F3 修复（2026-10-05）

### 11.1 F1 根因：缺 `responseModalities` 导致端点整体忽略 `generationConfig`

用真实端点做的对照实验（`tools/probe-aspect.mjs`，提示词固定，只改 body 形状）：

| 变体 | 实际产出 |
|---|---|
| `imageConfig.aspectRatio` 单独传（原实现） | 1408×768 ❌ |
| **`+ responseModalities: ['TEXT','IMAGE']`** | **1024×1024 ✅** |
| `+ imageSize: '1K'` | 1408×768 ❌ |
| `generationConfig.aspectRatio`（放到上层） | 1408×768 ❌ |
| 不传 `generationConfig`（对照） | 1408×768 |

第一行与最后一行**完全一致** → 缺 `responseModalities` 时端点把整个 `generationConfig` 丢掉。
加上它之后比例映射正确：`1:1`→1024×1024、`3:4`→896×1200、`16:9`→1376×768。

**修复**：`gemini-native` 分支固定带 `responseModalities: ['TEXT','IMAGE']`。

**加固**：`pixmart_generate` 落盘后核对实际宽高比与请求值，偏差 >2% 时在返回值与卡片里
回报 `sizeMismatch`。端点再变时是**可见告警**而不是静默失真。

### 11.2 F2 修复：拼装感知有无参考图

`buildPrompt` 增加 `hasReferences`（**默认 false** —— 保守假设更安全）。无参考图时
**按句**剔除含 `reference` 的描述：删句而非删词，避免留下残句。

例外：整模块覆盖（`overrides[moduleId]`）时既不剔除也不注入保护语——用户显式接管就该由用户说了算。

### 11.3 F3 修复：不编造真实品牌

| 情形 | 行为 |
|---|---|
| 文生图且无 `vars.product` | 注入「通用无品牌、无对应实体」主体句 + 负向提示追加品牌/商标禁令 |
| 文生图且给了 `vars.product`，但模块片段里没有 `{product}` 占位符 | 把产品描述补成独立主体句（**否则用户描述会被静默丢弃**） |
| 有参考图 | 不注入（产品来自参考图） |

第三条是修复过程中发现的**额外缺口**：24 个模块里只有 5 个声明了 `variables`，
其余模块没有 `{product}` 占位符，调用方给的产品描述会凭空消失。

### 11.4 测试

新增 `test/prompt-guards.test.mjs`（10 项），把三条修复与 §10.4 的教训都钉住；
其中一项直接断言 `gemini-native` 请求体必须含 `responseModalities`。
`pnpm verify` 共 **28 项全绿**。

> 仍未验证：修复后的**工具级**端到端（`pixmart_generate` 真出 1:1 图）需要再重启一次宿主。
> 但适配器层已由「真实端点对照实验 + 单元断言」双重确认。

## 12. P1 收口验证（宿主重启后）

用户重启宿主并授权一次真实生图，两项遗留全部关闭。

### 12.1 `pixmart_providers` —— schema 修复生效

返回完整厂商视图：`Ofox [ofox] aggregator · images-generations/ofox · 密钥 已就位(config) · 3 个模型`。
`8bce89c` 的 `additionalProperties: true` 修复在真实宿主中确认。

### 12.2 F1 工具级端到端确认

`pixmart_generate { module: "main.white-bg", size: "1:1" }` →

| 检查 | 结果 |
|---|---|
| 产出尺寸 | **1024×1024**（请求 1:1，偏差 0%） |
| `sizeMismatch` | **空**（卡片未出现 `⚠ 尺寸未被厂商遵守` 行；该行仅在数组非空时输出） |
| 落盘 | `projects/2026-10-05-F1验证/images/a1f803de-main.white-bg-01.jpg`（62947 字节） |
| 请求次数 / 耗时 | 1 次 / 5490ms |

**F1 闭环**：根因修复在真实工具调用中生效。

### 12.3 F3 的肉眼验证（意外收获）

| | A2（修复前） | F1 验证（修复后） |
|---|---|---|
| 产出物 | **Clorox Scentiva 消毒湿巾**——真实品牌 | 一台**虚构的灰色手持设备**（屏上 `UNIT: 487 / MODE: LOG`、`SN: 5B0001`） |
| 成因 | 无产品描述 → 模型自由发挥，抓到真实品牌 | 注入「通用无品牌」主体 + 品牌/商标禁令 |

同样是"没给产品描述"，现在编的是中性产品而不是别人的品牌。

### 12.4 两条质量观察（非缺陷，属提示词调优空间）

1. **否定式指令未被完全遵守**：提示词写了 `no drop shadow`，图中产品下方仍有可见投影。
2. **精确构图被打了折扣**：要求「正面平视、略俯 5 度」，实际约 45° 三分之四视角。

`gemini-3.1-flash-lite-image` 对否定式表述与精确构图的遵循度有限。后续可试：
把关键约束改成**肯定式**（「无接触阴影」→「产品悬浮于均匀白场」），
或把角度要求前置到 `subject` 段首位。

## 13. 过程教训：付费调用的失控

F1 取证共发出 **25 次付费调用**，其中**必要 9 次、可避免 16 次**：

| 用途 | 次数 |
|---|---|
| F1 找根因（5 种 body 形状）+ 比例确认（3 种）+ A2 验收生图（1 次） | **9（必要）** |
| 加了新阶段后整跑一遍 | 8 |
| 改了路径后整跑一遍 | 8 |
| 用 `--yes` 测花费闸门（当时 `--only` 未过滤比例） | 3 |

两条错误：

1. **报价 5 次、实际花 21 次**——把付费探测脚本当单元测试跑，改一行就整跑一遍。
2. **修「防止乱花钱」的过程中又花钱**——验证花费闸门时开着 `--yes`，而 `--only` 当时只过滤形状。

已固化：`tools/probe-aspect.mjs` 默认不发请求（需 `--yes` 放行）、`--only` 覆盖整个计划、
结束打印实际次数；并用三个「不放行」路径验证过（0 / 2 / 8，均零请求）。

**规则**：任何会产生费用的调用，先报数、等用户点头。用量硬计数属 P2 的 `usage.jsonl`。

## 14. 设置页可写（4 个 POST 路由）

设置页从「只读」改为「可写」，新增 4 个写路由，**形状即客户端对接契约**：

| 路由 | body | 成功 | 失败 |
|---|---|---|---|
| `POST /pixmart/api/providers/<id>/credentials` | `{apiKey?, apiKeyEnv?, baseUrl?, geminiNativeBaseUrl?}` | `200 {ok:true, provider:ProviderView}` | `404 unknown_provider` / `400 bad_id` / `400 bad_url` |
| `POST /pixmart/api/providers/<id>/refresh-models` | — | `200 {ok:true, models:string[], count, provider}` | `400 no_api_key` / `401 auth` / `502 bad_response` / `504 timeout` |
| `POST /pixmart/api/providers/<id>/test` | — | `200 {ok:true, latencyMs, modelCount}` | `200 {ok:false, latencyMs, error:{code,message}}`（成败都是 200） |
| `POST /pixmart/api/defaults` | `{provider?, model?, size?, n?}` | `200 {ok:true, defaults}` | `400 unknown_model` / `400 unknown_provider` / `400 bad_field` |

**六条实现红线**（都有测试钉住，见 `test/providers-api.test.mjs`）：

1. **任何响应体都不含 apiKey 本体**，只回 `hasApiKey` / `apiKeySource`（`ProviderView`）。
2. **密钥不进日志、不进错误消息**：401 只说「密钥被拒（HTTP 401）」。
3. 写路由全部走 `src/routes.ts` 的 `guard`（环回来源校验 + 异常转结构化响应）。
4. 配置写入一律走 `ConfigStore.update()`（原子写 + 按 key 串行），不直接写文件。
5. `POST` 才允许写；`GET` 命中写路由 → 405。
6. 请求体有 64KB 上限（超限 413）、JSON 解析失败 400；`IncomingMessage` 的
   `error` 事件也会 reject 读体 promise，避免连接中断时永远挂着。

**探测实现**在独立的 `src/vendor/models.ts`（不塞进 `openai-compat.ts`）：
`GET {baseUrl}/models`（末尾斜杠先去掉），鉴权与生图同源（OpenAI 兼容用
`Authorization: Bearer`；`gemini-native` 用 `x-goog-api-key` + 原生 baseUrl）；
响应兼容 `{data:[{id}]}` / `{models:[...]}` / 纯数组三种形状；
超时取 `min(provider.timeoutMs, 15s)`。

**已知取舍**：

- 写成功后 `runtime.configStore` 的内存副本与工具侧共享，但若 `config.json`
  被本进程之外的东西改动，内存不会自动重读（与改动前一致）。
- `baseUrl` 只做形状校验（`http(s)://` + 非空主机 + 不内嵌用户名密码），
  不做联通性判断——那是「测试连接」的事。

**§14 的历史语义已被 §15 取代**：`refresh-models` 从"拉取即全量写回"改成**只读**，
写入拆到新的 `POST /providers/<id>/models`。原因与契约见下一节。

## 15. 拉取 = 只读，选择 = 显式写入（2026-10-06）

### 15.1 为什么改：150 个模型里绝大多数是纯文本模型

实测 Ofox 的 `GET /v1/models` 一次返回 **150 个** id，其中能生图的只有个位数。
旧契约（§14）是"拉取即把**全部** id 写进 `provider.models`"，后果有三：

1. 默认模型下拉框被 150 项淹没，用户要自己从里面挑出能生图的那几个；
2. 用户没有"缩小列表"的手段——想删掉文本模型只能去手改 `config.json`；
3. 拉取本身**改了配置**，但界面上只看到一句"已拉取 150 个模型"，
   写操作是隐式的、没有确认步骤。

所以拆成两步语义：**拉取 = 只读**（只看，不写），**选择 = 显式写入**（勾完点保存）。

### 15.2 `POST /pixmart/api/providers/<id>/refresh-models`（改为只读）

```
200 { ok:true, models:string[], count:number, provider:ProviderView }
```

- 只对厂商发一次 `GET {baseUrl}/models`；`config.json` **不被触碰**
  （测试用写前后内存深比较 + 磁盘字节比较钉住）。
- `provider` 回的是**配置里的当前值**（因为什么都没写），`models` 才是探测结果。
- 失败码不变：`400 no_api_key` / `401 auth` / `502 bad_response` / `504 timeout`。

### 15.3 `POST /pixmart/api/providers/<id>/models`（新增，唯一写模型列表的入口）

```
body: { models: string[] }
200 { ok:true, provider:ProviderView, count:number }
400 { ok:false, error:{ code:'invalid_models'|'empty_models'|'too_many_models', message } }
404 { ok:false, error:{ code:'unknown_provider', message } }
```

判定顺序与规则（`pickModelsField`，有测试逐条钉住）：

1. 不是数组、或存在**非字符串 / 只含空白**的元素 → `invalid_models`；
2. 原始数组长度 > **500** → `too_many_models`（先挡再干活，500 本身合法）；
3. 去重**保持首次出现的顺序**（`trim` 后作去重键，落盘 trim 后的 id）；
4. 去重后为空 → `empty_models`（`[]` 走这一条）；
5. 写入 `config.json` 的 `providers[i].models`，走 `ConfigStore.update()`
   （原子写 + 按 configPath 串行读改写，**绝不直接写文件**）；
6. 响应体沿用 `toProviderView`，**不含 apiKey**。

### 15.4 顺带修掉的实测缺陷：模型行不更新（根因在宿主读缓存）

**现象**：拉取成功、界面提示"已拉取 150 个模型"，但同一卡片的「模型」行仍显示旧的 3 个默认值。

**根因**：**不是没落盘，也不是界面没重取**——是宿主 `runtime.config()` 吃缓存。
`src/tools/runtime.ts` 里首次读盘的结果被当成 `config()` 的永久返回值：

```ts
pending = configStore.load().then((result) => { warnings = result.warnings; return result.config })
return pending            // ← 之后每一个 GET api/providers 都回这份首次快照
```

写路由走的是 `ConfigStore.update()`，它更新的是 store 的 `current` 与磁盘，
**但 `config()` 永远不会再读 store**。于是：

- `POST refresh-models` 的 200 响应里 `provider.models` 是新值（它自己算的）→ 提示正确；
- 随后的 `GET api/providers` 回首次读盘快照 → 「模型」行、默认值下拉框全是旧值。

**修复**：`config()` 只把**读盘动作**共享一次，返回值一律取 store 的当前副本：

```ts
let loaded: Promise<void> | undefined
if (loaded === undefined) loaded = configStore.load().then((r) => { warnings = r.warnings })
return loaded.then(() => configStore.get())
```

**回归测试**：`test/providers-api.test.mjs` 的"写后重取 api/providers 必须看到新值"用
**真实 `createRuntime`**（假 runtime 的 `config()` 直接读 store，**测不出这个缺陷**——
这正是它当初溜过去的原因）。已验证：把 `config()` 改回快照语义，该用例立刻失败
（`actual: ['stale-default'] / expected: ['picked-image-model']`）。

### 15.5 客户端：拉取后展开模型选择面板

`client/client.js` 的 `ModelPickerPanel`（拉取成功后展开在厂商卡片内）：

- **搜索框**：按**子串**过滤，大小写不敏感；
- **全选 / 全不选**：只作用于**当前筛选结果**，按钮文案写明作用域
  （`全选（当前 23 个）`），避免用户以为选的是全部 150 个；
- **只选图像模型**：按模型名启发式**重设**选择，命中的行加「图像」标记。
  启发式覆盖 `gemini.*image` / `imagen` / `nano-banana` / `gpt-image` / `dall-e` /
  `qwen.*image` / `seedream` / `wan.*image` / `flux` / `stable-diffusion` / `kolors`。
  它是启发式：漏判只少一个标记，不会丢模型；
- **复选列表**：`max-height: 240px` + `overflow-y: auto`（150 项不撑爆卡片），
  面板头部显示「已选 N / 共 M」；
- **保存选择** → `POST .../models` 只提交**已选子集**（按拉取列表顺序）；
  成功后重取 `api/providers`、收起面板、给成功提示；
- **取消** → 收起面板且**不写入**；拉取结果留在卡片上，
  用「选择模型（N 个）」重新打开即可，不必再向厂商拉一次；
- 请求进行中按钮全部禁用；失败只在面板内显示 `error.message`（+ `code`），
  不白屏、不抛异常；卸载后落地的响应不再触发任何 `setState`/重取（有测试钉住）。

**契约变更带来的测试改动**：`test/providers-api.test.mjs` 里原有 4 个
"能解析 X 形状，并**把模型写回 config.json**"用例，其中两条断言（回写后的
`provider.models` 与磁盘 `models`）按新语义改成"**不写配置**"（深比较 + 磁盘字节一致），
其余断言（探测结果、count、端点拼接、鉴权头、不含密钥）原样保留。

## 16. 作品库批次 A：详情补字段 + 软删 / 回收站 / 导出（2026-10-06）

来源：《作品库优化方案》§2 第 1 批 + 第 2 批的无费用部分（批次 A）。
**未实现「重新生成」**——它直接花钱，护栏（§6.2 第 2–5 条）未落实前不实现。

### 16.1 `GET /pixmart/api/projects/<id>` 新增 6 个字段（**只新增，不改名不删除**）

每项除原有的 `module/label/status/size/apiMode/images/width/height` 外，新增：

| 字段 | 类型 | 说明 |
|---|---|---|
| `prompt` | string | 当时用的提示词（本插件最核心的资产） |
| `model` | string | 该项实际调用的模型 |
| `ms` | number | 该项耗时（毫秒） |
| `createdAt` | number | 该项完成时刻 |
| `degraded` | string[] | 降级链路，**恒定是数组**（空数组 = 没降级） |
| `error` | string? | 失败原因原文；成功项**不带**这个键 |

`pixmart_projects` 工具的形状**未动**（决定④）——只改 HTTP 层。
客户端：项目卡片补创建时间，详情项渲染提示词（可复制）/模型/耗时/时间/降级标记/失败原因。

### 16.2 新增 5 条写/读路由（全部走既有 `guard` 环回校验）

| 路由 | body | 成功 | 失败 |
|---|---|---|---|
| `POST /pixmart/api/projects/<id>/delete` | `{confirm:true}` | `200 {ok,id,trashId,trashed:true,mode}` | `400 confirm_required` / `404 not_found` / `400 bad_id` |
| `POST /pixmart/api/projects/<id>/export` | `{dir?}`（绝对路径） | `200 {ok,id,dir,count,files[],warnings[]}` | `400 invalid_export_dir` / `404 not_found` |
| `GET /pixmart/api/trash` | — | `200 {ok,count,trash[]}` | — |
| `POST /pixmart/api/trash/<id>/restore` | `{}` | `200 {ok,id,trashId,restored:true,mode}` | `404 not_found` / `409 already_exists` / `400 bad_id` |
| `POST /pixmart/api/trash/purge` | `{confirm:true}` | `200 {ok,purged}` | `400 confirm_required` |

**删除 = 软删**（决定①）：把 `projects/<id>` **移动**到 `projects/.trash/<id>`——
同盘走 `renameSync`（一次元数据操作，没有"复制到一半"的中间态）；跨设备
（`EXDEV`）才回退成「递归复制 + 删原件」，且回退任一步失败都会清掉目标、**保住源目录**。
`mode` 字段把实际走的分支报出来（`rename` / `copy`）。

**`.trash` 的排除**：`ProjectStore.list()` 显式跳过 `projects/` 下一切以点开头的条目
（不再依赖"那里恰好没有 project.json"这种巧合）；新增的写路由用更严的 `SAFE_ID`
（不允许以点开头）——`..`、`.`、`.trash` 都不可能被当成项目或回收站条目操作。

**其余约定**：非 `POST` 打写路由 → `405`；`confirm` 只认布尔 `true`（字符串不算）；
导出只复制、失败收敛成 `warnings`、**原件不动**；所有响应体不含 apiKey；
回收站路径同样过 `assertContained`。

**已知取舍**：导出的 `dir` 接受任意**绝对路径**（与设置页「产物保存路径」同一立场：
落点由用户明确指定），因此它本身不过 `assertContained`；但**每一张图的落点**都过
（`assertContained(目标目录, 文件名)`），记录里被手改脏的文件名越不出去。
`<id>` 一律过 `SAFE_ID`，跨目录的 id 在路由层就 400。


