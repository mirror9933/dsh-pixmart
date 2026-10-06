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

**§14 的历史语义已被 §15 / §16.3 取代**：`refresh-models` 从"拉取即全量写回"改成**只读**，
写入拆到新的 `POST /providers/<id>/models`（原因与契约见 §15）；
原先在这里的 `POST /settings/output-dir`（产物保存路径）已被 `POST /settings/export-dir`
取代，自动复制取消——见 §16.3。

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
| `POST /pixmart/api/projects/<id>/export` | `{dir?}`（绝对路径，**见 §16.3**） | `200 {ok,id,dir,count,files[],warnings[]}` | `400 no_export_dir` / `400 invalid_export_dir` / `404 not_found` |
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

**已知取舍**：导出的 `dir` 接受任意**绝对路径**（与设置页「作品库导出路径」同一立场：
落点由用户明确指定），因此它本身不过 `assertContained`；但**每一张图的落点**都过
（`assertContained(目标目录, 文件名)`），记录里被手改脏的文件名越不出去。

### 16.3 语义变更（2026-10-06）：取消「产物保存路径」的自动复制 → 「作品库导出路径」

一句话：**生成不再往数据目录之外的任何地方写文件**；要文件形式的副本，由用户在
作品库显式点「导出」。

变更前的三条落点，变更后只剩两条：

| 落点 | 变更前 | 变更后 |
|---|---|---|
| ① 插件数据目录 `projects/<id>/` | 总是写（唯一真相） | **总是写**（不变） |
| ② `outputDir`（每张成功的图自动复制一份） | 生成时自动复制 | **取消**。改为「作品库导出路径」`exportDir`，**只在导出时**用 |
| ③ 会话内嵌附件（DSH 用来在对话卡片显示图片） | 生成时创建 | **不变**（它是显示机制，不是用户的保存路径） |

**为什么取消自动复制**：生成不该有未经请求的副作用。用户没说要副本，插件却在他的
磁盘上多写一份——而且那份副本还有自己的生命周期问题（谁清理？改了原件怎么办？）。
现在图片只落数据目录（作品库浏览），要不要副本、副本放哪，全由用户在导出时决定。

**配置字段**：`outputDir` → `exportDir`（默认 `''`，非空必须是绝对路径，否则记 warning
当未设置）。`outputDir` 仍留在 schema 里兼容旧 `config.json`，但**不再被读、不再有任何行为**。

**迁移**：读配置时若 `exportDir` **缺键**而旧 `outputDir` 有可用的绝对路径，把旧值搬到
`exportDir`，并记一条 warning 说明"已从 outputDir 迁移"（用户已填好的路径不能凭空消失）。
`exportDir` 显式写了空串或写坏了（相对路径/非字符串）则**不回填**——那是用户已经表过态或
需要他自己修，静默改用另一个路径更糟。

**HTTP**：

| 路由 | 变化 |
|---|---|
| `POST /pixmart/api/settings/output-dir` | **删除**（不再存在，命中即 `404 unknown_route`） |
| `POST /pixmart/api/settings/export-dir` | **新增**：body `{exportDir}`；空串 = 清除；非绝对路径 → `400 invalid_export_dir`；缺字段/非字符串 → `400 bad_field`；GET → `405`。写盘时顺手把废弃的 `outputDir` 清成 `''` |
| `GET /pixmart/api/providers` | 回 `exportDir`，**不再回** `outputDir` |

**`POST /projects/<id>/export` 的新语义**（目标目录优先级即顺序）：

1. 请求体里的 `dir`（绝对路径，覆盖配置）；
2. 配置里的 `exportDir`；
3. 都没有 → **`400 no_export_dir`**，message 直接指向设置页（"请先在设置里配置作品库导出路径"）。

落点固定是 `<目标目录>/<projectId>/`（不同项目各占一格）。**只复制、不移动**；
目标不可写时仍是 `200` + `warnings[]`，**原项目一个字节都不受影响**。
项目不存在 → `404`（不会凭空造目录）；`dir` 相对路径 → `400 invalid_export_dir`。

**边界（已被 §16.5 取代）**：`pixmart_projects` 工具的 `export` action 当初行为**未动**
（默认导出到 `<dataDir>/exports/<id>`）——它是 Agent 侧的独立口径，本次只改 HTTP/界面那条用户路径。
`pixmart_projects` 工具回传的字段由 `outputDir` 改成 `exportDir`（文本里明确写"生成时不复制"）。
**（2026-10-06 修正）**：该字段随后又改名为 **`targetDir`**——`exportDir` 已经是配置项
「作品库导出路径」的名字，工具里再用同一个词指"数据目录内的导出落点"是必然的误读源，
见 §16.4。

`<id>` 一律过 `SAFE_ID`，跨目录的 id 在路由层就 400。

### 16.4 `pixmart_projects` 的 delete 与 HTTP 对齐（2026-10-06，批次 A 收口）

**问题**：批次 A 只把 **HTTP/UI** 那条路改成了软删；`pixmart_projects` 工具的 `delete`
仍然是 `rmSync` 硬删。两个入口语义相反（界面里可恢复、Agent 一删就没），而 Agent 恰恰是
最容易被触发删除的入口——用户说一句"把那些测试项目删掉"，模型就会调它。这属于**同一能力
两个语义**，必须收口。

**决定：Agent 路径也必须能恢复。** 理由不是"对称好看"，而是**误删的自救路径**：
如果工具只能软删、不能恢复，Agent 一旦删错（理解错范围、id 张冠李戴），它自己没有任何
补救手段，只能停下让用户去界面点——而用户此时多半并不知道该点哪里。可恢复 = 这条路的
错误代价从"永久丢数据"降到"多一次调用"。因此 `delete`（软删）与 `restore` **必须成对**
提供；只给软删不给恢复，等于把不可逆性从"磁盘"搬到了"操作流程"里。

| 变化 | 之前 | 之后 |
|---|---|---|
| `delete` 默认语义 | `rmSync` 硬删（永久销毁） | **软删**：`projectStore.moveToTrash(id)`，与 HTTP 路径同一个 store 方法 |
| `delete` 新增入参 | — | `permanent?: boolean`（默认 `false`）。`true` 才真删（保留原 `rmSync` 行为） |
| `confirm: true` | 必须 | **两种模式都仍然必须**，缺失即拒绝且不碰磁盘 |
| 返回形状 | `{ok,action,deleted[],skipped[]}` | `deleted` / `skipped` **不变**；**新增** `permanent` 与软删时的 `trashed: [{id, trashId}]` |
| 渲染文本 | 「已删除 N 个项目」 | 软删：「已移入回收站 N 个项目：…（可用 `pixmart_projects action=restore` 恢复；`permanent: true` 才是永久删除）」；真删：「已永久删除 N 个项目：…（不可恢复）」 |
| `restore` | **不存在** | 新增 action：入参 `ids: string[]`，走 `restoreFromTrash`，返回 `restored[]` / `skipped[]` |
| `list` | 只报项目 | **新增** `trashCount` 与 `trash[]`（回收站条目 id / projectId / name / deletedAt / imageCount），**绝不混进 `projects`** |
| `export` 落点字段 | `exportDir` | **`targetDir`**（当时的默认落点仍是 `<dataDir>/exports/<id>`，该默认落点已被 §16.5 删除） |

**为什么 `restore` 不要求 `confirm`**：它是**非破坏性**的（原 id 被占用时 store 抛 `conflict`
拒绝，绝不覆盖），加一道确认只会让"删错了赶紧救回来"变慢。与 HTTP 的
`POST /trash/<id>/restore` 同一立场（那里也不要求 `confirm`）。

**`restore` 收两种 id**：`list` 报出的**回收站条目 id**（`trash[].id`）与原**项目 id**
（`trash[].projectId`）都能用。原因是 Agent 删完之后手上通常只有自己刚传进去的那个 id，
要求它先去 list 里查回收站条目 id 是多余的一步（而条目 id 在同名项目删两次时会带 `-2` 后缀）。

**`list` 为什么要报回收站**：不报的话，「项目 0 个」会被读成"从来没生成过"，
而实际上东西都还在回收站里；报了才能让"删了能找回来"对 Agent 也成立。

**没有削弱任何既有断言**：原 `test/p2.test.mjs` 里
`delete（confirm: true）→ deleted == [id] 且 has(id) === false` 在软删下**同样成立**
（`has()` 看的是 `projects/<id>/project.json`，软删后它确实不在了）。
该用例另**新增**一条断言：删除后 `listTrash().length === 1` 且 `projectId` 对得上——
把"默认必须是软删"钉死。新增覆盖见 `test/projects-tool.test.mjs`（11 条：
默认软删 / 软删失败原项目仍在 / 恢复后内容逐字节一致 / `permanent` 真删且不进回收站 /
两种模式缺 `confirm` 都被拒 / `confirm` 只认布尔 / `export` 回 `targetDir` 且无 `exportDir` /
`list` 不混回收站 / schema 里 `permanent` 为可选 boolean 且 action 含 `restore`）。
**其中与 `export` 有关的两条已随 §16.6 删除能力而重写**（见该节表格），其余断言逐字未动。

**未改**：HTTP 路径的任何语义（路由、错误码、`GET /trash`、`purge`）都没动；
客户端本次零改动（`client/client.js` 不涉及 `pixmart_projects` 工具）。
`purgeTrash`（清空回收站）**没有**暴露给 Agent 工具：那是真正的不可逆批量销毁，
让它只留在用户显式点按钮的界面里。

### 16.5 导出落点收敛（2026-10-06）：只留用户显式指定的那一个

> **已被 §16.6 取代（同日稍后）**：本节把"导出"统一到了 `exportDir`，但 Agent 侧的
> `action=export` 仍在写用户的目录。§16.6 把那个 action **整个删除**——Agent 不再有
> 任何写文件的落点。本节保留为当时的问题记录；下表里 `pixmart_projects action=export`
> 那一行的"之后"状态**已经不存在**。

**问题**：同一个"导出"有两条同义但**落点不同**的实现——界面/HTTP 用配置里的 `exportDir`
（空则 `400 no_export_dir`），而 `pixmart_projects action=export` 自作主张写
`<dataDir>/exports/<id>/`。两者并存的结果是：用户分不清"导出到底去哪"，数据目录里还会
莫名多出一份副本（实测就在那里留下了文件）。

**决定：`exportDir` 胜出，`<dataDir>/exports/` 这条落点彻底取消（不留兜底）。**
理由是 `exportDir` 是用户**显式配置的意图**，隐式默认是插件自作主张。

| 入口 | 之前 | 之后 |
|---|---|---|
| `POST /pixmart/api/projects/<id>/export` | `dir` > `exportDir` > `400 no_export_dir` | **语义与错误码不变**（只把"没有可用目录"的文案换成与工具共用的那一条） |
| `pixmart_projects action=export` | 固定 `<dataDir>/exports/<id>` | 新增可选入参 `dir` > 配置 `exportDir` > **失败**（`no_export_dir`）——**该 action 随后被 §16.6 整个删除** |

**共用的唯一实现**（`src/tools/export-output.ts`）：`resolveExportRoot(overrideDir, configuredExportDir)`
给出 `{ok:true, root}` 或 `{ok:false, code, message}`；`planProjectExport(root, projectId, imagesDir, items)`
给出落点 `<root>/<projectId>/` 与待复制原件（源与目标**两条**路径都过 `assertContained`）。
当时两个入口都调它们，所以错误码与文案**不可能分叉**——有一条用例直接断言两边 `message` 逐字节相同
（该用例已随 §16.6 删除 Agent 入口而重写，见 §16.6 的"因删除能力调整的既有断言"表）。

**"两者皆无"的文案**（当时 HTTP 与工具共用；§16.6 后只剩 HTTP，文案一字未改）：

> 没有可用的导出目录：请先在设置里配置作品库导出路径（设置 → PixMart → 作品库导出路径），或显式指定目标目录（绝对路径）

**不删用户已有的数据**：磁盘上已经存在的 `<dataDir>/exports/` 与其中的文件**原样保留**
（那是用户的数据），插件只是不再往里写任何东西。

**同批清掉的另一个死字段**：`exportToWorkspace`（默认 `false`）在 schema 里存在，
但**没有任何代码读它**——工作区副本是无条件自动的（§7.9），它"像开关却不是开关"。
故从 `PixmartConfig` / 默认值 / `parseConfig` 中删除；写盘时（`ConfigStore.save` / `update`）
顺手把残留键抹掉，读盘遇到残留键**不报错也不告警**（旧 `config.json` 必须照常可用）。

### 16.6 收敛（2026-10-06）：取消 Agent 的独立导出能力 —— 方案 B

**问题**：§16.5 把"导出"统一到 `exportDir`，但**忽略了发起者的区别**：

- **用户**点界面「导出」= 刻意挑选、要长期留存 → 写 `exportDir`（用户管理的目录）✅
- **Agent** 调 `pixmart_projects action=export` = 它自主的中间动作 → 也写进同一个用户目录 ❌

两个演员写同一个用户目录，会把用户精心管理的文件夹灌满 Agent 的临时产物，
而且用户分不清哪些是自己要的。

**决定（方案 B）：Agent 不再有任何写文件的落点。**
它要"给用户文件"时，指向**已经存在**的会话暂存副本即可（生成时本来就会留一份）。

| 变化 | 之前 | 之后 |
|---|---|---|
| `pixmart_projects` 的 action 枚举 | `list / get / export / delete / restore / usage` | **`list / get / delete / restore / usage`** |
| 入参 `dir` | `export` 用（显式覆盖目标目录） | **删除**（留着它等于暗示"还能指定落点"） |
| 工具描述 | 说明 `export` 的落点口径 | **不得出现 `export` / `exports/` / `exportDir` 字样**；只说它不写用户目录 |
| `export` 的返回字段 `targetDir` / `files` / `warnings` / `count` | 真导出 | **全部消失**（能力没了，形状自然也没了） |
| 调 `action=export` | 真导出 | 走**未知 action 的既有失败路径**（`invalid_args`：`未知 action "export"`），**不写任何文件** |
| `action=get` | 只回项目详情 | **新增** `workspaceOut`：`{workspace, dir, exists}` |
| `POST /pixmart/api/projects/<id>/export` | 用户点「导出」 | **语义、错误码、落点全部不变**（它现在是唯一入口） |
| `pixmart_providers` 的渲染文本 | 说"用户点「导出」**或 Agent 调 `pixmart_projects action=export`** 时生效" | 只说"**用户**在作品库点「导出」时生效；生成时不复制，Agent 工具也不写这里" |

**`action=get` 的新字段**（Agent 侧"知道文件在哪"的替代）：

```json
{
  "ok": true, "action": "get", "dataDir": "<插件数据目录>",
  "project": { "…": "形状未变" },
  "workspaceOut": {
    "workspace": "<会话工作区根（绝对路径）>",
    "dir": "<工作区>/pixmart-out/<项目 id>",
    "exists": true
  }
}
```

- 工作区一律经 `tools/workspace-copy.ts` 的 `sessionWorkspace()` 取
  （`exec.agent.session.header.cwd`，必须是绝对路径）——**复用既有解析，不另写一套**；
  `dir` 再过一次 `assertContained`（项目 id 写脏也越不出去）。
- **拿不到工作区时 `workspaceOut` 整个缺省**（不编造路径），渲染文本明说
  "本次调用拿不到会话工作区"。
- `exists` 是**只读探测**（`existsSync`）：`get` 绝不创建目录。
- `get` 现在有**专门的渲染分支**（此前是 JSON 直出），三件事必须说到：
  **原件**在插件数据目录（作品库可浏览）；**会话暂存副本**在工作区的 `pixmart-out/`
  （工作区内的路径才会被客户端渲染成可预览的会话地址，可直接内嵌 / `present`，
  并报"在不在"）；**本工具不会导出到设置里的「作品库导出路径」**。

**`resolveExportRoot` / `planProjectExport` 的归属**：它们现在只剩 HTTP 一个调用方，
因此**原地保留**（`src/tools/export-output.ts`）——搬文件只会制造一次无收益的 diff；
`NO_EXPORT_DIR_MESSAGE` 也原样留着（`400 no_export_dir` 的文案一个字都没改）。
`exportImages` 仍有两个调用方：HTTP 导出与工作区自动副本（后者只借复制语义）。

**不删用户磁盘上的数据**：`<数据目录>/exports/` 与其中的文件（实测 2 个）**原样保留**
——那是早先版本的隐式落点留下的用户数据，插件只是不再往里写。

**因删除 export 能力而调整的既有断言（逐条，含"为何不是降低强度"）**：

| 文件 / 用例 | 原断言 | 为什么不是降低强度 |
|---|---|---|
| `test/projects-tool.test.mjs` · `export 的目标与 HTTP 同一口径`（4 条） | `action=export` 成功、落点 `<dir>/<项目 id>`、`targetDir`、无 `exportDir`、warnings 收敛、数据目录无 `exports/` | 该能力已删除，断言对象不复存在。4 条换成 3 条**反断言**（见下），原本"落点唯一"的意图被保留并加强为"**一个落点都没有**" |
| `test/projects-tool.test.mjs` · schema 用例 | `schema.properties.dir.type === 'string'`、`dir` 可选、描述含「作品库导出路径」与 `dir` | 入参已删除。改为断言 `dir` **不存在**、action 枚举**逐项相等**（恰五个）、描述里 `export` / `exports/` / `exportDir` **一个都不许有**——比原来更强 |
| `test/export-dir.test.mjs` · §H 第 1 条 | HTTP 与工具回**同一句** `no_export_dir` 文案、同一错误码、同一判定顺序 | 工具那条路已不存在，"两处一致"无从断言。改为：HTTP 仍回 `no_export_dir`（同一句文案、同一判定顺序），工具回 `invalid_args`，且两者都**不写任何文件** |
| `test/export-dir.test.mjs` · §H 第 2 条 | 工具带 `dir` 时落点唯一、无 `exports/` | 工具的 `dir` 已删除。改为：HTTP 带 `dir` 仍落 `<dir>/<项目 id>`；工具侧连目标目录都**不得被创建**，且旧字段 `targetDir`/`files` 必须不存在 |
| `test/p2.test.mjs` · `pixmart_projects` 用例 | `action=export` 带 `dir` → `ok:true` + `targetDir` | 同上。改为断言被拒（`invalid_args`），且 `exportDir` 与数据目录 `exports/` 都不存在 |

**新增的更强断言**（替代被删的那些）：action 枚举逐项相等；`dir` 入参不存在；
描述里 `export` 子串为假；`get` 的 `workspaceOut` 三段形状 + "只探测不创建" + 缺省；
干净临时数据目录里跑遍 `list/get/usage/export/delete/restore` 后**不存在 `exports/`**。

**未改**：HTTP 路径的任何语义（路由、错误码、`400 no_export_dir` 文案、
`GET /api/providers` 回 `exportDir`）都没动；客户端零改动（客户端只用 HTTP）。

---

## 17. 作品库批次 C：查询 / 分页 / 重命名（2026-10-06）

提交 `c662acd`。测试 `250 / 0`。**既有 216 项断言零删除零修改**。

### 17.1 `GET /pixmart/api/projects` 支持查询与分页

| 参数 | 取值 | 默认 |
|---|---|---|
| `q` | 子串，大小写不敏感；匹配 **项目名 / 模块名** | 空（不过滤） |
| `sort` | `createdAt:desc` · `createdAt:asc` · `name:asc` · `images:desc` | `createdAt:desc` |
| `limit` | 正整数，沿用既有上限 | 50 |
| `offset` | 非负整数 | 0 |

未知 `sort` → **400 `bad_sort`**（不静默回退到默认值——静默回退会让"排序没生效"变成
一个查不出来的现象）。

响应新增（**原有 `count` / `projects` 保留**）：

```json
{ "ok": true, "count": 50, "total": 55, "hasMore": true,
  "offset": 0, "limit": 50, "projects": [ ... ] }
```

**两条容易写错、已用测试钉住的语义**：

1. **过滤先于分页**：`total` 报的是**过滤后**的总数。若写成过滤前的总数，
   搜索时旁边那个分母就是假的（搜出 3 条却显示"共 55"）。
2. **`total` 必须报真实总数**。此前实现是 `list().slice(0, limit)` —— **超过 limit 的
   项目被静默隐藏**，界面上毫无提示，用户会以为自己只有 50 个项目。
   测试造 55 个项目：`?limit=50` → `count=50 / total=55 / hasMore=true`；
   `?offset=50` 取回剩余 5 个；两页并集恰为 55。

`listWithModules()` 与 `list()` **共用同一次目录扫描**；模块名只走 HTTP 口径，
**`list()` 的返回形状逐字未变**（守住"不动 `pixmart_projects` 工具层"的决定）。

### 17.2 `POST /pixmart/api/projects/<id>/rename`

```
body: { name: string }
→ 200 { ok:true, project: <更新后的摘要> }
→ 400 { ok:false, error:{code:'invalid_name', message} }
→ 404 not_found      → 405 非 POST
```

`invalid_name` 的三种理由：**空（含仅空白）· 超长 · 含路径分隔符**。

**铁律：只改 `project.json` 里的 `name` 显示名，绝不移动或重命名项目目录。**
目录名就是项目 id，而 `GET /pixmart/file/<id>/<name>` 依赖它——一旦移动目录，
该项目的**所有图片路由立刻 404**。

测试断言：目录仍在 · `readdirSync(projects)` 未变 · 记录里 `id` 未变 ·
**改名后 `/pixmart/file/<id>/<name>` 仍 200** · 新名字能被 `q` 搜到。

### 17.3 客户端落点

| 能力 | 实现要点 |
|---|---|
| 搜索 | 250ms 防抖（否则每敲一个字发一次请求）+ 清空按钮 |
| 排序 | 四种，变化时**重置到第一页** |
| 分页 | 「加载更多」**追加**而非替换；显示「显示 N / 共 M」 |
| 懒加载 | 封面 `loading="lazy"` + `decoding="async"`，**每个项目只加载 1 张** |
| 查看器 | `position: fixed` 覆盖层；`top` = shell 的 `--dsh-frame-chrome-top`（**不写死 40px**）；固定顶栏 + 唯一滚动区；打开时锁背景滚动；`Esc` 关闭；`←/→` 切图；「3 / 8」；提示词可复制；焦点与滚动还原；`prefers-reduced-motion` 关动画 |
| 对比 | 同一模块多张时 2-up；**只有 1 张时不出现该开关** |
| 多选 | 全选**限定当前筛选**且文案写明数量；批量软删需二次确认；批量导出 |
| 重命名 | 详情内联编辑 |

**查看器刻意不使用 `shell.overlay`**：那个全局座位已被「实时预览卡」占用，
同一插件抢两个 contributor 会互相覆盖。查看器在面板内自建覆盖层。

### 17.3.1 查看器与窗口 chrome（Windows 桌面外壳）

用户实测：查看器自己的顶栏（模块标签 / 关闭）压在标题栏上、右上角看不到控件。根因是
**查看器从视口 y=0 起画**，而 Windows 桌面外壳把视口顶部 40px 留给了窗口 chrome：

- `lib/main.js`：窗口用 `titleBarStyle: "hidden"` + `titleBarOverlay: { height: 40 }`，
  原生最小化/最大化/关闭按钮由 Electron 画在 **web 内容之上**；
- `lib/preload-app.cjs`：preload 给 `<html>` 打 `data-windows-titlebar`、
  把标题栏高度写进 `--dsh-windows-titlebar-height`（40px），并把「应用 / 编辑」菜单挂成
  `position: fixed; top: 0; z-index: 1100` 的宿主（`[data-windows-menu]`）；
- `ui-layout` 的 `AppFrame`：`padding-top: var(--dsh-windows-titlebar-height)`，
  即三栏整体在这条带**下面**（`.centerCol` 从 40px 起算）；
- shell 为模态层发布 `--dsh-frame-chrome-top`（Windows = 标题栏高度，原生全屏归零；
  普通浏览器文档不发布），`ui-primitives` 的 `Modal` 正是 `inset: var(--dsh-frame-chrome-top, 0px) 0 0`。

因此查看器 `top: var(--dsh-frame-chrome-top, 0px)`，`zIndex` 保持 60（**低于 1100**，
永不盖窗口 chrome）。顶栏另外从 `overflow: auto` 的根盒子里搬出来，与滚动区并列，
滚图片/提示词时它不会被滚走。

**背景滚动锁**：查看器打开时把面板滚动层（`.pxm-scroll`）的 `overflow-y` 置 `hidden`
（`lockBackgroundScroll`），关闭或**卸载**时按**原内联值**精确还原（原来是 `auto` 回
`auto`，原来没有就回到没有）。只在量到真有经典滚动条（`offsetWidth − clientWidth > 0`）
时才写 `scrollbar-gutter: stable`，免得锁本身把背景横移一条滚动条宽度。
注意：`.pxm-scroll` **不是**查看器的祖先（`workbenchFrame` 里覆盖层与滚动区并列），
所以这条锁是"链式滚动 + 未来的祖先变化"的防线，而不是"事件冒泡回滚动区"的补丁。

### 17.4 已知边界（诚实记录）

- **jsdom 无排版引擎**：滚动位置还原只能断言"调用了替身"，真实 `scrollTop` 恢复
  **无断言**（jsdom 里恒为 0）。窄屏布局、`max-height` 内滚、真实高度同样测不到，
  只能 GUI 目视（方案 §13.5）。
- **批量导出与详情页导出的路径不同**：批量在客户端**预检** `exportDir`，未配置则
  直接提示、不发请求；详情页则发请求由宿主回 400，再翻译提示。**用户可见文案一致，
  但规则写在两处**——将来宿主改规则时存在只改一处的风险。建议收敛为"宿主权威"
  或共用一个 helper（**尚未做**）。
- **不做服务端缩略图**（决定②）：网格加载的是原图，靠懒加载与 CSS 限尺寸缓解。
- **查看器的两条修复只到"结构断言"为止**（§17.3.1）：`overflow-y: hidden` 写进内联样式
  ≠ 真的滚不动；`top: var(--dsh-frame-chrome-top, 0px)` 只是个待解析的字符串，jsdom 里
  既不解析变量也不算布局——"背景有没有跟着滚""顶栏有没有真的避开标题栏与原生按钮"
  **都必须 GUI 目视**。Tab 陷阱能测 activeElement 落点（事件是测试自己派的），
  测不到浏览器默认 Tab 行为、也测不到焦点框有没有被裁。
  **macOS 未验证**：`html[data-platform=darwin]` 不发布 `--dsh-frame-chrome-top`
  （它的顶带是红绿灯那 48px 的 `--dsh-frame-top-clearance`），所以查看器在 macOS 上
  仍从 y=0 起画（与修复前一致，非回归）——要不要避让红绿灯需要真机确认。

---

## 18. 余额不足（HTTP 402）不得自行兜底（2026-10-06）

### 18.1 事件（session 日志取证，非推测）

用户配置的厂商余额为负，Agent **未经询问**就自己写了合成脚本，把"造出来的图"当交付物：

```
s13  pixmart_prompt ×2（main.selling-point / main.scene）
s14  pixmart_edit → 失败 [bad_request]：请求被拒绝（HTTP 402）：
     {"error":{"message":"Insufficient credits. Current balance: $-0.138427.",
               "type":"insufficient_credits","code":402}}
s15  write  → pixmart-in\compose_main.py     ← 自己写 PIL 合成脚本
s16  pwsh   → 跑脚本
s18/s19 edit → 反复改脚本
s20  pwsh   → 再跑
```

全程**没有 `ask_user_question`、没有任何审批**。

### 18.2 根因：402 落进了泛化的 `bad_request`，并因此走了降级链

`vendor/openai-compat.ts` 的 `classify()` 只按状态码分档，402 命中 `status >= 400`
的兜底分支 → `bad_request`。这带来两个后果：

1. **重复计费**：主循环里 `bad_request` 是唯一触发**降级链**的码
   （`if (lastError.code === 'bad_request') shouldDegrade = true`）。余额为负时
   适配器会把同一个注定被拒的请求换着参数（去 quality → 去 format → 去参考图 → 纯文本）
   **最多再发 4 次**。降级链每一档都是真实厂商调用。
2. **错误指令失效**：工具只回一句"该错误重试无意义，请先修正配置或提示词"。
   对余额不足来说这句话毫无指向性——配置没错、提示词也没错，是账户没钱。
   于是 Agent 自己发明了出路：**用 PIL 拼图**。

比"没弹窗"更严重的一点：对电商主图而言，**PIL 脚本合成的图不是"生成的图"**，而是
**伪造的交付物**——不经过模型、质量不可控，但外形像成品，会被计入 `pixmart-out/`、
被 `present`、被当成结果交付。所以这一条必须在**规则层面**明令禁止，而不只是"体验优化"。

### 18.3 决定

1. **新增专用错误码 `insufficient_credits`**（`VendorError.code`）。识别规则：
   - `status === 402` → 余额不足；
   - 其他 4xx（排除 429）里出现显式特征（`insufficient_credits` / `insufficient quota` /
     `credit balance` / 余额不足 / 额度不足 / 欠费）→ 余额不足；
   - **429 与 5xx 一律不算**——限流和服务端故障不是账户状态，需要的是重试而不是充值。
   - `retryable: false` → 主循环既**不重试**也**不降级**，只发一次请求。
   - 原始 message **原样保留**（含 `Current balance: $-0.138427`）：余额数值是用户判断
     "差多少钱"的唯一依据。
2. **`hint` 写成指令级文案**（`tools/runtime.ts` 的 `INSUFFICIENT_CREDITS_HINT`，
   `generate` / `edit` / `batch` 三条付费链路共用），三层意思缺一不可：
   ① 账户余额问题、重试无用 → 请用户去厂商后台充值；② **必须先 `ask_user_question`
   询问用户**（停下来充值 / 按用户指示改用别的方式），不要自行降级；
   ③ **严禁**用脚本或绘图库（PIL / ImageMagick / canvas）自行合成或伪造图片充当交付物。
3. **guidance 立硬规则**（2 行，净增 2 行 → 正文 36 行，仍在 36 行上限内；靠压缩
   "没有可用密钥"那句腾出的空间，**没有抬高上限**）：付费调用失败（尤其余额不足 / 402）
   先停下并 `ask_user_question`；严禁写脚本合成/伪造交付物。
   注意：**没有**夹带任何"图片该怎么展示 / 内嵌 / present"的规则（那类在 `ab6dad8` 已整段删除）。
4. **文档**：README「常见问题」加一条——余额不足时插件**不会**替你兜底，不要期待自动降级出图。

### 18.4 做不到的部分（诚实记录，不要当成已实现的能力）

- 插件**无法**拦截 DSH 核心工具（`pwsh` / `write`）——那是宿主的能力，不在插件权限内。
  因此**无法从机制上阻止** Agent 写脚本；能做的是让它在动手前先看到"禁止"和"先问用户"。
- 插件**无法强制弹出对话框**。DSH 里"问用户"的正规渠道只有模型调用 `ask_user_question`。
  这条规则属于**指令级约束**（工具返回文案 + guidance），不是技术强制。
- 因此本节的结论边界是：**降低概率，不保证根除**。真正的兜底需要宿主层面的能力
  （如按工具白名单、或对特定错误强制中断回合），目前不存在。

### 18.5 测试

`test/insufficient-credits.test.mjs`（13 项，全部 stub fetch、零真实网络、零花费）：
402 映射到专用码并保留负余额原文；**只发 1 次请求**（回归锁：旧行为是降级链 5 次）；
hint 三层关键词；`pixmart_edit` / `pixmart_batch` 工具层与渲染文本都带指令；5xx 不被误标；
成功路径不受影响；guidance 新规则存在且正文 ≤36 行。

## 19. 客户端视觉对齐：配色统一走官方主题 token（`--dsw-*`）

### 19.1 契约（**不要再写死颜色**）

`client/client.js` 的配色**只允许**引用 DSH 官方主题变量 `--dsw-*`，深浅色主题因此自动与官方
一致。插件侧不得出现：十六进制色值、`rgb()` / `rgba()` / `hsl()`、CSS 系统色关键字
（`Canvas` / `Field` / `WindowText` …），以及 CSS 的「当前颜色」关键字用来凑半透明色。

需要半透明时用**基于 token** 的写法：

```js
color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)
```

源码里集中在三个常量上（`client/client.js` 顶部）：`T`（token 表）、`tint()`（半透明变体）、
`shadow()`（浮层阴影）。加/换颜色只改这三处，不要在组件里内联新值。

用到的那份官方 token 与语义对应（都经 client Theme 的 `listTokens` 确证存在，且
`requiresLightAndDark: true`，即官方保证有浅/深两套值）。

**表面（`bg-*`）的语义按官方用法分层，不要按名字猜**（2026-10-06 修正，详见 19.4）：

| 层 | token | 深色取值 | 官方用在哪 | 我们用在哪 |
|---|---|---|---|---|
| 应用最底层 | `--dsw-alias-bg-base` | `#151517` | `AppFrame.frame` / `centerCol` / `rightbarCol`、`body`、整页级面板（`schedule` 的 `S0jZwq_page`） | shell 的 `body`；缩略图的占位底（`bg-layer-2` 的卡片里那一格） |
| 抬起的表面 | `--dsw-alias-bg-layer-1` | `#232324` | `chat` 的 turn-preview（带 `elevation-panel`）、`deliverables` 的卡片、`primitives` 的 HoverCard | **作品库面板**（`main` 槽）、模型选择盒 |
| 弹窗 / 嵌套表面 | `--dsw-alias-bg-layer-2` | `#2c2c2e` | `settings-general` 的 `.wCInkW_panel`（设置弹窗）、`Modal`、`--dsw-alias-settings-card-fill` | 卡片 / 列表盒 / 缩略图占位；**设置页 section 显示的就是这一层**（自己不再画一层） |
| 输入控件 | `--dsw-alias-bg-layer-3` | `#353638` | `primitives` 的 `settings-form/fields.module.css` 里 `.input`（`SettingsValueField` / `SettingsSecretField` 同一个类）、`settings-plugin-inventory` 的 `.RotMhW_search input`、`plugin-manager` 的 `.fO69Vq_installField input[type=text]` | **全部输入类控件**：`inputStyle`（`TextInput` / `Select`）、提示词 `<textarea>`（2026-10-07 对齐，见 19.5） |
| 分段控件底槽 | `--dsw-alias-bg-module-platform` | `#353638` | `SegmentedControl` | 未使用（备案在 `OFFICIAL_SURFACES` 注释里） |
| 浮层底 | `--dsw-alias-bg-overlay` | `#61666b` | tooltip 一类浮层 | 查看器 / 预览卡 / 徽标 |

其余非表面 token：

| 用途 | token |
|---|---|
| 分隔线（发丝级） | `--dsw-alias-border-l1` |
| 卡片 / 按钮描边 | `--dsw-alias-border-l2` |
| **输入控件描边** | `--dsw-alias-border-l4`（官方 `.input{…border:0.5px solid var(--dsw-alias-border-l4)}`；`primitives/Input.module.css` 的 `.wrap` 与 `settings-plugin-inventory` 搜索框同） |
| 品牌强调（**主按钮填充**） | `--dsw-alias-brand-primary`（官方 `--dsw-alias-button-primary-fill` 就是它；浅色近黑 / 深色近白）**本插件不用** |
| 主文字 / 次文字 / 三级文字 | `--dsw-alias-label-primary` / `--dsw-alias-label-secondary` / `--dsw-alias-label-tertiary` |
| 状态色（对齐官方 `StateDot`） | `--dsw-alias-state-success-primary`（完成）· `-state-error-primary`（失败）· `-state-warn-primary`（警告 / 数据过期）· `-state-idle-primary`（待机 / 进度条底槽）· **`--dsw-alias-label-tertiary`（进行中 —— 官方 `StateDot` 的 `ongoing` 用的正是它）** |

**「进行中 / 进度」为什么是 `label-tertiary` 而不是 `brand-primary`**：`brand-primary` 是**主按钮
填充**色（官方 `--dsw-alias-button-primary-fill: var(--dsw-alias-brand-primary)`），浅色 `#0f1115`
近黑、深色 `#f9fafb` 近白。把它挂在"正在跑"的状态点上，浅色主题下会呈现近黑色——看起来像一枚
按钮而不是状态。官方 `StateDot` 的 `ongoing`（唯一非圆点的状态）用的是
`--dsw-alias-label-tertiary`（`StateDot.module.css` 的 `.spinner{color:var(--dsw-alias-label-tertiary)}`，
轨道是同色的 25% 半透明）。本插件照抄该语义：状态色映射 `COLORS.run`、运行中缩略图的边框与它的
进度环都用它。**预览卡头部那枚 36px `ProgressRing` 不在此列**——它只画「完成 / 失败 / 剩余槽」
三段，本来就没有"进行中"这一段要上色。

**唯一的例外**：官方 token 里 `state-success-primary` 与 `state-warn-primary` 的浅色/深色
取值**本来相同**（`#22c55e` / `#f59e0b`），所以它们不能用来证明"跟随主题"——这不是硬编码，
19.3 第 3 条里的 8.5 用例把这件事钉住。除此之外，客户端配色里**没有**任何一处因为
"没有 token 可用"而保留硬编码颜色（逐处核对过：`Canvas` 两处、`rgba(0,0,0,…)` 两处、
`#hex` 八处、基于 `currentColor` 的半透明二十余处，全部换成了 token 或其派生色）。

### 19.2 为什么不直接 require 官方组件包（`@deepseek-ai/dsh-client-ui-primitives`）

两个独立的原因，缺一不可：

1. **官方明文禁止**：`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:35`
   写明不要从插件里 require 该组件包。
2. **技术上也不通**：该包是**未打包 ESM + 38 个相对 `.module.css`**（`import './X.module.css'`），
   而本插件的 client 半边是**手写 JS、没有构建步骤**（`window.__ModuleLoader__.load` 里手写
   factory）。loader 解析不了那些相对导入，换组件的结果是**整个面板挂掉**，而不是"只变丑"。

官方认可的最低风险做法就是本文这条：**照抄视觉 token**。依据是同文件 `practices.md:34` ——
"a renamed token degrades appearance but never breaks rendering"：token 名字写错只会让外观退化，
**永远不会让渲染崩掉**。这也正是"只改样式值、不动组件结构"这条纪律的来源。

### 19.3 回归怎么锁住（三条）

1. **静态扫描**（`test/client-tokens.test.mjs`，9 项，`pnpm test`）：先按字符串/注释状态机剥掉
   注释（注释里会**提到**被禁的写法），再对代码断言——没有十六进制色值、没有系统色关键字、
   没有 `rgb()`/`hsl()`、没有「当前颜色」关键字。三条**正向**断言：`--dsw-` 出现次数 ≥ 清单长度
   （阈值 = 清单长度，现为 16）；从源码里**读出** `const T = {…}` 表，断言它与清单一一对应、
   且每个 token 键都真的被样式引用过（只声明不引用 = 那处多半被换回硬编码了）；以及
   「进行中/进度」那几处必须走 `labelTertiary`（逐处正则钉住，换成 `T.brand` 或硬编码 hex 直接红）。
2. **token 真的生效**（`test/browser/theme.test.mjs` 8.1 / 8.3 / 8.7 / 8.8 / 8.9，`pnpm test:browser`）：
   在 `test/browser/shell.html` 里**定义**官方浅色取值，然后按**计算样式**
   （`getComputedStyle`，不是内联字符串）断言元素某个属性 == 该 token 在**当前页面**里的解析值
   （解析由浏览器现场完成，`__pxmLane.resolveCss` 按目标属性本身解析，两边同一个序列化器）。
   夹具里刻意放一条失败项，否则 `.pxm-item-error` 根本不渲染，"失败文字走 error token"就是空转。
   8.8 / 8.9 是**表面映射**那一类（"挂的是哪一层"），判据与证据见 19.4 / 19.5。
3. **深浅色跟随**（8.2 / 8.4 / 8.7）：在**同一个页面**里把同一批 token 换成官方深色取值
   （`__pxmLane.setTokens`），断言每个被断言的颜色**都变了**、且等于新的解析值。
   这是"能与官方深浅色主题一致"的唯一硬证据——只断言浅色下相等，可能是硬编码巧合同色
   （成功色官方浅色就是 `#22c55e`，与历史硬编码一模一样）。8.5 另外把"哪几个 token 浅深同色、
   因此不能当证据"写成断言，防止以后拿它们当证据。`--dsw-alias-label-tertiary` 浅色 `#81858c`、
   深色 `#adb2b8` **确实不同色**（从 app.asar 里
   `@deepseek-ai/dsh-client-ui-theme/lib/client.js` 的 `body{}` 与 `body[data-ds-dark-theme]{}`
   两份定义逐层解析得到），所以 8.7 可以拿它当"跟随主题"的证据。

第 2、3 条刻意拆成**各自独立**的用例（8.1 只管浅色相等，8.2 只管跟着变）：写成一个用例时，
"浅色不相等"会先失败、把"跟着变"那条断言挡在后面，反向变异就只能证明一半。

**反向变异**：`tools/lane-mutations.mjs` 的 `M16-color-hardcoded-hex` 把面板底色从
`T.bgLayer1` 换回 `'#f4f4f5'`。实测（`node tools/lane-mutations.mjs M16`）：

- `8.1 列表态` 红：「这些元素的颜色不是它挂的那个 token 的解析值」；
- `8.2 列表态` 红：「这些元素在深色 token 下颜色没变」；
- 静态侧 `test/client-tokens.test.mjs` 的「没有任何十六进制颜色字面量」也红
  （浏览器 lane 脚本另跑一份临时副本，仓库产物 sha256 前后一致）。

**反向变异（语义侧）**：`M17-progress-color-is-brand` 把「进行中/进度」的状态色从
`labelTertiary` 退回 `brand-primary`（= d03a4a4 里那处错误的映射），并在 `T` 表里补回 `brand`
（变异体必须仍然可运行，才谈得上"被断言抓住"）。实测（`node tools/lane-mutations.mjs M17`）：
`8.7` 红——「这些元素的颜色不是它挂的那个 token 的解析值」；静态侧
`test/client-tokens.test.mjs` 的「token 表与清单一一对应」与「进行中/进度用的是 label-tertiary」
两条同时红。

该脚本现在同时跑 `layout.test.mjs` 与 `theme.test.mjs`：几何变异不该惊动配色用例，反之亦然。

### 19.4 表面映射修正（问题①）与宽屏占满（问题②）（2026-10-06）

用户在 `ab4e44c` 之后实测报了两个视觉/布局问题，两处都先在 **app.asar 里核对官方原文**，
再改代码。结论与证据如下。

#### 问题①：设置面板底色比官方「通用设置」暗一大截（看着是纯黑）

**根因**：`skin.wrap`（`settings.section` 的根）写的是 `background: T.bgBase` —— 那是
**应用最底层**（深色 `#151517`）。而官方设置页的 section 自己**根本不画表面**：
`settings-general` 的 `SettingsRoot.module.css` 里只有

```
.wCInkW_panel{… background:var(--dsw-alias-bg-layer-2)}
.wCInkW_options{flex:1;min-height:0;padding:0 24px 24px;overflow-y:auto}   /* 没有 background */
```

——内容是**继承弹窗面板那一层** `bg-layer-2`（深色 `#2c2c2e`）。所以我们的页面：
`#151517`（更暗）vs 官方 `#2c2c2e`；再加上卡片还挂在 `bg-layer-2` 上（与 section 同色，
卡片边界只靠描边），观感就是"整块纯黑"。

**改法**：`skin.wrap` **去掉 `background`**（跟随官方 section 的"不画表面"），保留 `color`。
`skin.card`（`bg-layer-2`）与官方 `--dsw-alias-settings-card-fill: var(--dsw-alias-bg-layer-2)`
**恰好同层**，因此不动。

**逐个复核了全部四处表面映射**（官方对应物 → 我们对应物）：

| 现在 | 应为 | 依据 |
|---|---|---|
| `skin.wrap` `bg-base` | **不画表面**（继承 `bg-layer-2`）← 已改 | 官方 `.wCInkW_options` 无 `background` |
| `skin.panel` `bg-layer-1` | `bg-layer-1` ✅ 不动 | 官方"抬起的表面"层（chat turn-preview / deliverables 卡片） |
| `skin.card` `bg-layer-2` | `bg-layer-2` ✅ 不动 | `--dsw-alias-settings-card-fill` = `bg-layer-2` |
| `inputStyle` / 提示词 `<textarea>` `bg-base` | 官方同类控件是 `bg-layer-3` → **19.5 已改** | `primitives` 的 `settings-form/fields.module.css` `.input{background:var(--dsw-alias-bg-layer-3)}` |
| `.pxm-viewer` / 预览卡 / 徽标 `bg-overlay`（92% / 100%） | ✅ 不动 | 浮层底 |
| 状态点/进度 `label-tertiary` | ✅ 不动（8.7 守着） | `StateDot` 的 `ongoing` |

**当时没改的那一处（已在 19.5 补齐）**：输入控件严格对齐官方应当是 `bg-layer-3`。本次没动它，
原因有两条：（a）`bg-layer-3` 尚未进入本插件的 token 表，加进去会牵动静态用例的"一一对应"
断言与 token 计数，属于另一处独立改动；（b）本次用户报的是**面板底色**，输入框底色不在报告
范围内。已在 `OFFICIAL_SURFACES` 与 19.1 的表里备案"官方是 `bg-layer-3`、我们是 `bg-base`"，
随后按这份备案改掉了（见 19.5）。

#### 问题②：2560 全屏下作品库挤在左侧、右边一大片空白

**先证伪了一个假设**：这不是 shell 的中栏给的宽度上限。asar 里 `ui-layout` 的 AppFrame
（`lib/client.js` 里那段内联 CSS）对中栏只有这一条：

```
.BynINW_centerCol{flex-direction:column;min-width:0;display:flex;overflow:hidden}
```

**没有 `max-width`、没有 `width`、没有 `margin:auto`**。`main` 槽的宿主是 `display:contents`
的槽锚点，面板是它的直接 flex 子项，中栏 `flex-direction:column` ⇒ 子项横向 stretch ⇒
座位本来就该占满。lane 实测 2560px：中栏 `left 220 / right 2560 / width 2340`。

**真根因在我们自己**：`skin.panel` 上那条 `maxWidth: '880px'`（git c6b342c 引入，抄"聊天的
阅读宽度"）。lane 实测 2560px：面板 `left 220 / right 1100 / width 880` ——
右边界距中栏右边界 **1460px**，正是截图里那块空白。

**改法**：删掉 `maxWidth: '880px'`（并留注释说明为什么）。官方对 `main` 槽里的**面板**页的
惯例也是占满：`settings-general` 的 `kh1pJG_page` 是 `width:100%`，`schedule` 的 `S0jZwq_page`
是 `width:100%; height:100%`。内层滚动（`workbenchFrame` 的固定层 + `.pxm-scroll{overflowY:auto}`）
**未动**，8 号用例同时断言面板根不滚、`.pxm-scroll` 仍 `auto`、高度仍被锁在面板里。

#### 新增断言（浏览器 lane，2 条）

- **`theme.test.mjs` 8.8**：`.pxm-settings` 的**感知表面**必须等于官方弹窗面板那一层
  （深色下由最近色判定为 `bg-layer-2`），且必须**不等于** `bg-base`；同时断言 section
  **自己不画底色**（`backgroundColor` 为 `rgba(0,0,0,0)`）。浅色下官方三层同色，所以那条
  "等于哪一层"只在深色判——顺序上深色先跑，失败信息才直接说"实际是哪一层"。
- **`layout.test.mjs` 8**：1600×900 与 2560×900 两档断言面板右边界 == 中栏右边界、
  面板宽度 == 中栏可用宽度、`.pxm-scroll` 内容区左右边界 == 面板内容区边界（只差 18px padding）、
  面板无 `max-width`、文档无横向溢出、面板根 `overflow-y:visible` 且 `.pxm-scroll` 仍 `auto`。

夹具侧同步：`shell.html` 的 `:root` 补 `bg-layer-3` / `bg-module-platform`，
`#settingsDialog` 的底色从写死 `#fff` 改成 `var(--dsw-alias-bg-layer-2)` —— 这才是官方
"设置弹窗面板那一层"的**同语义对应物**，否则"我们该等于什么"无可比对象。

#### 反向变异（`tools/lane-mutations.mjs`，两条新变异）

- `M18-settings-surface-is-bg-base`：把 `skin.wrap` 写回 `background: T.bgBase`。
  实测 **8.8 红**：「深色：`.pxm-settings` 现在显示的表面是 `--dsw-alias-bg-base`（rgb(21,21,23)），
  官方设置页内容表面用的应是弹窗面板那一层 `--dsw-alias-bg-layer-2`」。
  另外把它写成 `bgLayer1` / 写成 `color-mix(…, 50%)` 两种近似变异也分别被 8.8 抓住
  （后者报"感知表面为 null"，因为它不是任何一层的不透明色）。
- `M19-panel-max-width-880`：给 `skin.panel` 加回 `maxWidth:'880px'`。
  实测 **8. 宽屏红**：「1600px 宽视口：面板右边界必须贴住中栏右边界（右边不留空白块）：
  panel `right 1100 / width 880 / maxWidth 880px`，centerCol `right 1600 / width 1380`」。
- 顺带修正了 `M16-color-hardcoded-hex` 的锚点：它原来的 `find` 串改成现在**唯一**的那一处
  （`background: T.bgLayer1,` 在文件里出现过两次，脚本的"必须恰好命中一次"纪律因此报错）。

`pnpm verify`（typecheck + build + `pnpm test` + `pnpm test:browser`）：
**322 + 21**，全绿；`client/client.js` 的 sha256 在变异脚本前后一致（脚本只写临时副本）。

### 19.5 输入控件底色对齐官方 `bg-layer-3`（2026-10-07）

19.4 备案的偏差（"官方输入控件是 `bg-layer-3`、我们是 `bg-base`"）本次补齐。用户肉眼确认的
现象是：设置页的输入框比官方**暗一层**，看起来像"塌进面板里"。

#### 先在 app.asar 里逐类核实官方用法（不照抄结论）

| 官方控件 | 挂的 token | 出处（app.asar 原文） |
|---|---|---|
| 设置页 `SettingsValueField`（`<input type="text">`） | `background: var(--dsw-alias-bg-layer-3)` + `border: .5px solid var(--dsw-alias-border-l4)` | `dsh-client-ui-primitives/lib/settings-form/fields.module.css:110-112` 的 `.input` |
| 设置页 `SettingsSecretField`（`<input type="password">`） | **同一个类** `css$25.input` ⇒ 同 token | `dsh-client-ui-primitives/lib/index.js`：`jsx("input",{className: css$25.input, type:"password"})` |
| 设置页搜索框 | `bg-layer-3` + `border-l4` | `dsh-client-ui-settings-plugin-inventory/lib/client.js` 的 `.RotMhW_search input` |
| 插件安装字段 `input[type=text]` | `bg-layer-3` + `border-l4` | `dsh-client-ui-plugin-manager/lib/client.js` 的 `.fO69Vq_installField input[type=text]` |
| 原子 `<Input>`（**不是**表单字段） | 外层 `.wrap`: `bg-layer-1` + `border-l4`；内层 `.input`: `background: transparent` | `dsh-client-ui-primitives/lib/Input.module.css` |
| `<select>` / `<textarea>` | **官方 client 侧一处都没有**（全 asar grep `<select` / `<textarea` 只命中 domino 与 renderer 的模板） | 因此下拉与大段文本按"同一枚表单控件"的**最接近语义**对齐到 `.input` 那一处 |
| checkbox | 不画底色（`accent-color: var(--dsw-alias-brand-primary)`） | `Checkbox.module.css` |
| switch | 不画输入底色（轨道 `border-l3` / 选中 `brand-primary`） | `Switch.module.css` |

浅/深实测色值（由 `dsh-client-ui-theme/lib/client.js` 的 `body{}` / `body[data-ds-dark-theme]{}`
两份定义逐层解析）：

| token | 浅色 | 深色 |
|---|---|---|
| `--dsw-alias-bg-base` | `#fff` | `#151517` |
| `--dsw-alias-bg-layer-1` | `#fff` | `#232324` |
| `--dsw-alias-bg-layer-2` | `#fff` | `#2c2c2e` |
| `--dsw-alias-bg-layer-3` | `#fff` | `#353638` |
| `--dsw-alias-border-l4` | `#00000029` | `#fff3` |

即：**浅色下官方四层表面同色（都是 `#fff`），"挂错一层"只有深色能区分** —— 与 8.5 / 8.8
的既有做法一致，8.9 因此把"等于哪一层"的判定也放在深色那一次。

#### 改法（只改样式值，不动结构 / 尺寸 / 行为）

| 处 | 现在 → 应为 |
|---|---|
| `inputStyle`（`TextInput` 共用） | `background: T.bgBase` → `T.bgLayer3`；`border: 1px solid T.borderL2` → `T.borderL4` |
| `Select`（厂商 / 模型 / 尺寸 / 排序下拉） | 复用 `inputStyle` ⇒ 同上（无独立代码） |
| 密码框 | 走 `TextInput` + `type:'password'` ⇒ 同上（无独立代码） |
| 提示词 `<textarea>`（`.pxm-copy-fallback`） | `background: T.bgBase` → `T.bgLayer3`；`border: T.borderL2` → `T.borderL4` |
| `T` 表 | 新增 `bgLayer3` / `borderL4`（`OFFICIAL_SURFACES` 同步加 `bgLayer3`，清单 4 → 5 层） |
| `test/client-tokens.test.mjs` 的 `REQUIRED_TOKENS` | 13 → 16 项（加上述三枚：`bg-layer-3` / `border-l4`；`bg-base` 仍在表内） |

**`bg-base` 没有被弃用**：它仍被缩略图占位底（`T.bgBase`，卡片里那一格）引用，所以静态用例的
"每个 token 键都被样式引用过"照旧成立，**没有变成空转**。`borderL2` 也仍被按钮描边引用。

#### 新增断言（浏览器 lane，1 条用例 / 12 处断言）

- **`theme.test.mjs` 8.9**：在 `settings.section` 里对 `.pxm-settings input[type="text"]`、
  `input[type="password"]`、`select` 逐个断言**计算背景色 == `var(--dsw-alias-bg-layer-3)` 的
  当页解析值**，且**不等于** `bg-base` / `bg-layer-2` 的解析值（四层在**深色**下互不相同，
  浅色下官方同色，故"等于哪一层 / 不等于哪一层"只在深色判，浅色只核对"官方确实同色"这条前提
  ——与 8.8 同一做法）；同时断言这三类的**边框色 == `border-l4`** 的解析值，且 != `border-l1`。
  提示词 `<textarea>`（详情页里"复制失败才渲染"的 `.pxm-copy-fallback`）量同一套：用
  `addInitScript` 把 `navigator.clipboard.writeText` 换成必然 reject 的 Promise（走的是真实的
  降级分支，不是伪造 DOM），点「复制提示词」后等它出现再量。
- **静态**：`test/client-tokens.test.mjs` 的清单与 `T` 表一一对应、`--dsw-` 种类数 == 16。

#### 反向变异（`tools/lane-mutations.mjs`，两条新变异）

- `M20-input-surface-is-bg-base`：把 `inputStyle` 的 `background: T.bgLayer3` 改回 `T.bgBase`
  （缺陷形态）。实测 **8.9 红**：
  「深色：input.text 的底色是 bg-base（rgb(21, 21, 23)，源码挂在 `inputStyle.background`）……」
- `M21-input-surface-is-bg-layer-2`：改回 `T.bgLayer2`（与所在卡片同色，只差一档、肉眼几乎
  看不出）。实测 **8.9 红**：「深色：input.text 的底色是 bg-layer-2（rgb(44, 44, 46)）……」
  —— 这一条证明 8.9 里"**不等于** `bg-layer-2`"那句不是空转（删掉它这条变异就不会红）。

`pnpm verify`（typecheck + build + `pnpm test` + `pnpm test:browser`）：
**322 + 22**，全绿。基准是 **322 + 21**（在 HEAD `ae5a6bf` 的临时 worktree 里实测 node 322 /
浏览器 21），本次浏览器 lane **+1**（新用例 8.9），静态用例**条数不变**（只改了清单内容与一处
用例标题里的数字：14 → 16）；`git diff` 里没有任何被删掉的 `it(` / `describe(`。
`client/client.js` 的 sha256（`916c6dff5d88…`）在变异脚本前后一致（脚本只写临时副本），
21 条变异（20 严格 + 1 信息性）全部被对应用例抓住。


## 20. 组件尺寸对齐：把设置页与作品库的几何对齐到官方（2026-10-08）

§19 解决的是**颜色**（`--dsw-*` token，官方改了自动跟随）。这一节解决**几何**：
控件多高、内边距多少、字号多大、圆角多少。两者做法**不一样**，原因在下面 20.1。

### 20.1 官方尺寸是怎么表达的：**一半是变量，一半是写死的 px**

先在 `app.asar` 里把官方 CSS 逐条读出来（`tools/asar.mjs` 的 `read` / `grep`）：

| 类别 | 官方有没有变量 | 证据 |
|---|---|---|
| **圆角** | **有** | `@deepseek-ai/dsh-client-ui-theme` 的 base CSS `:root{…}` 声明了 `--dsw-radius-xs:4px; --dsw-radius-sm:8px; --dsw-radius-md:12px; --dsw-radius-lg:16px; --dsw-radius-xl:20px; --dsw-radius-panel:28px`，以及 `--dsw-focus-ring-width:2px`。官方控件规则的 `border-radius` **一律**写 `var(--dsw-radius-*)`（`primitives/Button.module.css` / `Input.module.css` / `Menu.module.css` / `SegmentedControl.module.css` / `Modal.module.css` 皆是） |
| **高度 / 内边距 / 字号 / 行高** | **没有** | 不存在 `--dsw-size-*` / `--dsw-space-*` / `--dsw-control-*`。`--dsw-font-*-{font-size,line-height}` 虽然存在（如 `--dsw-font-xs-13-font-size:13px`），但**官方控件规则自己并不消费它们**：`settings-form/fields.module.css` 的 `.input` 与 `Button.module.css` 的 `.sm` 写的都是裸 px |

**所以做法分两半**（`client/client.js` 的 `S` 常量表，见该表表头注释里逐条的 `文件:行` 出处）：

1. **圆角走官方变量**：`borderRadius: 'var(--dsw-radius-md)'` 这种写法与颜色 token 同理
   ——官方改圆角，本插件**自动跟随**，不需要改代码。
2. **高度 / 内边距 / 字号 / 行高照抄 px**：集中成具名常量表 `S`（与颜色表 `T` **分开**，
   两族不混；`T` 只收颜色，有静态用例钉住）。**这是照抄、不是 token**：
   官方改了这些数，本插件**不会**自动跟随，只有 `test/browser/sizes.test.mjs` 会变红来提醒。
   这个风险是**已知且接受**的——DSH 没给尺寸 token，能选的只有"照抄 + 可回归"或"不对齐"。

### 20.2 关键尺寸对照表（我们 → 官方 → 证据）

| 控件 | 我们的取值（`S.*`） | 官方取值 | 证据（`app.asar` 内路径省略 `dsh/node_modules/@deepseek-ai/`） |
|---|---|---|---|
| **表单值控件**（设置页 input / password / 搜索框） | `height:34px` `padding:0 12px` `font-size:13px` `line-height:1.5` `border-radius:var(--dsw-radius-md)` `border:.5px solid var(--dsw-alias-border-l4)` | 同左 | `dsh-client-ui-primitives/lib/settings-form/fields.module.css:107-118`（`.input`；`:108` height / `:109` padding / `:110` radius / `:111` border / `:114` font-size / `:115` line-height） |
| **下拉（`<select>`）** | 与上面**同一组**（`inputStyle` 共用） | 官方 client 侧**没有原生 `<select>`**；语义最近的是 `settings-models` 的 `._3nPmjq_input` 与 `primitives/Input.module.css` 的 `.wrap`，两者都是 `height:32px` | `dsh-client-ui-settings-models/lib/client.js:58`；`dsh-client-ui-primitives/lib/Input.module.css:5` |
| **按钮（行内动作：刷新 / 回收站 / 全选 / 导出 / 删除 / 查看器翻页）** | `height:28px` `padding:0 10px` `font-size:12px` `line-height:18px` `border-radius:var(--dsw-radius-sm)` `box-sizing:border-box` | 同左（官方 `Button` 的 `.sm`；也是设置页行内动作按钮实际用的那一档） | `dsh-client-ui-primitives/lib/Button.module.css:27-33`（`:29` height / `:30` font-size / `:31` line-height / `:32` padding / `:33` radius）；官方设置页里的同档：`dsh-client-ui-settings-models/lib/client.js:58` 的 `._3nPmjq_rowActions ._3nPmjq_secondaryButton` / `._3nPmjq_dangerButton` |
| **按钮（默认档，**未采用**）** | — | `height:36px` `font-size:14px` `line-height:22px` `padding:0 14px` | `dsh-client-ui-primitives/lib/Button.module.css:8-25`（`.button` + `.md`） |
| **Tag / 胶囊小标签**（`.pxm-pill`） | `padding:1px 8px` `font-size:11px` `line-height:17px` `border-radius:999px` | 同左 | `dsh-client-ui-primitives/lib/Tag.module.css:5-13`（`:7` radius / `:9` padding / `:10` font-size / `:11` line-height） |
| **Pill / 实时预览徽标**（`.pxm-badge`） | `height:24px` `padding:0 8px` `font-size:12px` `line-height:18px` `border-radius:999px` | 同左 | `dsh-client-ui-primitives/lib/Pill.module.css:1-13`（`:5` height / `:6` padding / `:8` radius / `:10` font-size / `:11` line-height） |
| **卡片**（设置页卡片 / 回收站列表项 / 通知块 / 查看器信息卡） | `padding:12px 14px` `border-radius:var(--dsw-radius-lg)` `border:.5px solid …` | `._3nPmjq_rowCard` 是 `padding:12px 14px; border-radius:var(--dsw-radius-xl); border:.5px solid …`；同文件的内容卡片（`editor` / `addCard` / `setupCard`）是 `border-radius:var(--dsw-radius-lg); padding:14px 16px` | `dsh-client-ui-settings-models/lib/client.js:58` |
| **节标题**（`skin.title`） | `font-size:16px` `line-height:24px` `font-weight:500` | 同左 | `dsh-client-ui-settings-models/lib/client.js:58` 的 `._3nPmjq_title` |
| **次级标题**（卡片内的 `strong`：默认值 / 厂商 / 累计用量 …） | `font-size:13px` | 官方 `.label` 是 `font-size:13px; font-weight:500; line-height:1.5` | `dsh-client-ui-primitives/lib/settings-form/fields.module.css:20-26` |
| **次文字**（`skin.muted`） | `font-size:12px` `line-height:18px` | 同左 | `dsh-client-ui-settings-models/lib/client.js:58` 的 `._3nPmjq_intro` / `_3nPmjq_advancedHint` / `_3nPmjq_modelCatalogMeta` |

**圆角为什么取 `radius-lg(16px)` 而不是 `rowCard` 的 `radius-xl(20px)`**：这是**明确的选择**，
不是默写——同一份官方 CSS 里"内容卡片"（`editor` / `addCard` / `setupCard`）用的就是 `lg`，
本插件的卡片是内容卡片。卡片**描边**取官方那根 `0.5px` 发丝线（原来是 `1px`）。

### 20.3 哪些控件**无官方对应物、故意没对齐**

| 处 | 为什么不对齐 | 现状 |
|---|---|---|
| **作品库网格卡片**（`.pxm-tile`：`repeat(auto-fill, minmax(180px,1fr))` + 4:3 封面 + 名称/张数/时间三行） | 官方**没有任何同类网格**（设置页只有行卡片列表，没有"图墙"）。硬套一个行卡片的尺寸只会把它做坏 | **保持自身几何协调**：`padding:8px`、`border-radius:10px`、封面圆角 6px。**未对齐，且不打算对齐**——这是一条**已知缺口**，不是漏做 |
| **缩略图网格**（详情页里的 `repeat(auto-fill,minmax(120px,1fr))`） | 同上（官方没有图片网格） | 未对齐 |
| **实时预览卡的逐格缩略图**（`.pxm-chip` 56×56） | 官方没有"逐格点亮的生成缩略图"这种东西 | 未对齐（尺寸由卡片自身布局推导） |
| **进度环 / 状态点 / 徽标里的 Spinner** | 官方 `StateDot` 是 8~20px 的圆点/弧，"36px 的 N/M 圆环"与"56px 缩略图上的小环"都没有对应物 | 未对齐 |

### 20.4 落点（`client/client.js`）

- 新增 `S`（`Object.freeze`）：每个值都带 `文件:行` 出处，**只放尺寸，不放颜色**。
- 改尺寸的原子：`skin.title` / `skin.muted` / `skin.card`（padding + 圆角 + 0.5px 描边）、
  `Pill`（Tag 几何）、`Btn`（Button`.sm` + `border-box`）、`inputStyle`
  （34px / `0 12px` / 13px / `radius-md` / `0.5px`）、`PreviewBadge`（Pill 几何）。
- 卡片内的次级标题一并收敛到 `S.subheadFontSize`（原来散着写 `'13px'`）。
- `Pill` 补 `className: 'pxm-pill'`：**只为测试挂钩**（尺寸用例按语义角色定位它）。
- 提示词 `<textarea>` 与 `inputStyle` 同步改成官方的 `0.5px` 描边。
- `test/browser/lane.js` 新增四个纯事实探针：`settingsSlots` / `workbenchSlots` / `overlaySlots`
  （按**语义角色**在 `client.js` 当前的类名上做映射，并给元素打 `data-pxm-role`）、
  `boxMetrics`（计算样式 + 真实几何 + **内联声明值**）、`resolveSize`（把 `var(--dsw-radius-*)`
  交给浏览器现场解析成 px）。`route()` 的 `/pixmart/api/trash` 开始认夹具里的 `trash`
  （在此之前它硬编码返回空回收站，回收站列表项**根本没法测**——这是既有 lane 的一处能力缺口）。

### 20.5 可回归：新增 `test/browser/sizes.test.mjs`（8 条用例）

之前**没有任何用例**管"按钮有多高"——把 28px 写成 40px，页面照样排得下、颜色也照样对。
新 lane 文件按**语义角色**（而不是类名）在四个面板/模态层上量 `getComputedStyle`：

| 用例 | 覆盖 |
|---|---|
| 0. lane 自证 | 服务的是仓库原产物 + 尺寸探针可用 |
| 1.1 | 设置页 `input[type=text]` / `password` / `select`：height / padding / fontSize / lineHeight / **radius == `var(--dsw-radius-md)` 的当页解析值** / 声明描边 0.5px |
| 1.2 | 设置页按钮 == 官方 `Button.sm`（含真实几何高度 28px）+ Tag == 官方 `.tag` |
| 1.3 | 节标题 16/24/500 + 次文字 12/18 |
| 2.1 | 作品库：工具条按钮 == `Button.sm`；搜索框 / 排序下拉 == 官方表单控件 |
| 2.2 | 回收站列表项卡片 == 官方设置卡片（`12px 14px` / `radius-lg` / 0.5px） |
| 3.1 | 大图查看器：「关闭」按钮 == `Button.sm`；信息卡 == 官方设置卡片 |
| 4.1 | 实时预览徽标 == 官方 `Pill` |

**两处如实记录的平台限制**（都在用例里有注释，不是"绕着走"）：

- **0.5px 描边只能断言内联声明值**：Chromium DPR=1 下 `border:.5px` 的**计算值就是 `1px`**
  （亚像素被量化），计算样式里 0.5px 与 1px **完全同值**。探针因此额外交回 `declared`
  （`element.style` 的声明值），断言落在那里；证据强度**弱于**其它尺寸断言。
- **`<select>` 的 `lineHeight` 不参与断言**：Chromium 不把 `<select>` 的内联 `line-height`
  落到计算样式上（实测同一个 `inputStyle` 下 `input` 是 `19.5px`、`select` 是 `normal`）；
  官方 `.input` 规则本身也是写给 `<input>` 的。`select` 只对齐 height / padding / fontSize /
  radius / 描边。

### 20.6 反向变异（`tools/lane-mutations.mjs`，5 条新变异 + lane 文件 +1）

`TEST_FILES` 增加 `test/browser/sizes.test.mjs`（否则尺寸变异无处落地）。新增：

| 变异 | 改坏的实现 | 实际抓住它的用例（真实断言原文） |
|---|---|---|
| `M22-input-height-old` | `S.fieldHeight` 34px → 28px（改造前） | `1.1`：**「textInput 的 height：实测 28px，官方 34px」**；`2.1`：**「searchInput 的 height：实测 28px，官方 34px」** |
| `M23-button-padding-old` | `S.buttonPad` `0 10px` → `6px 10px` | `1.2`：「设置页按钮的尺寸与官方 Button.sm 不一致」；`2.1`：「作品库工具条按钮与官方 Button.sm 不一致」 |
| `M24-title-size-old` | `S.titleFontSize` 16px → 15px（改造前） | `1.3`：「设置页标题的字号/行高/字重与官方 ._3nPmjq_title 不一致」 |
| `M25-tag-padding-old` | `S.tagPad` `1px 8px` → `1px 6px`（改造前） | `1.2`：**「Tag 的 paddingRight：实测 6px，官方 8px」「Tag 的 paddingLeft：实测 6px，官方 8px」** |
| `M26-radius-hardcoded` | `skin.card` 的 `borderRadius` 从 `S.radiusLg`（走变量）退回硬编码 `10px`（改造前） | `2.2`：「回收站列表项与官方设置卡片尺寸不一致」；`3.1`：「查看器信息卡与官方设置卡片尺寸不一致」 |

五条全部 ✔（`严格变异 5 条全部被对应用例抓住`）；`client/client.js` 的 sha256 在脚本前后一致
（脚本只写 `os.tmpdir()` 里的副本）。

### 20.7 静态 token 清单的同步改动（**不是**削弱断言）

`client/client.js` 现在会写 `var(--dsw-radius-*)`，于是 `test/client-tokens.test.mjs` 的
「代码里出现的 `--dsw-*` 种类 == 清单」由 16 → **19 项**（+`--dsw-radius-{sm,md,lg,xl}`）。
这不是放宽：清单仍然与代码里出现的 token **一一对应**（多一枚少一枚都红），
只是把"官方尺寸里唯一做成变量的那一族"也纳进契约。同时**新增一条用例**钉住分界：
`T`（颜色表）里**不得**出现非 `--dsw-alias-*` 的 token、四个圆角 token 必须以 `var(...)`
被真正消费。静态用例因此 **9 → 10 条**（`pnpm test` 322 → 323）。

### 20.8 结果

`pnpm verify`（typecheck + build + `pnpm test` + `pnpm test:browser`）：
**323 + 30**，全绿。基准 **322 + 22**，本次 **+1 静态 / +8 浏览器**，
`git diff` 里没有任何被删掉的 `it(` / `describe(`。
