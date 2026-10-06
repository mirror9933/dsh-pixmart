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
| 分页 | 「加载更多」**追加**而非替换。**2026-10-10 起**「显示 N / 共 M」已按用户要求从工具条移除，`hasMore` 只剩「加载更多（还有 N 个）」一个可见载体（见 §22） |
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

## 21. 控件形态复刻：设置页的三种控件照官方 DOM/CSS 自绘（2026-10-09）

### 21.1 为什么只能"照 DOM + CSS 复刻"，不能 require 官方组件

官方 primitives（`SettingsValueField` / `Menu` / `Input`）**明文禁止插件 require**
（`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:35`：
"Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness
Client package as a module"），且该包是未打包 ESM、loader 也解析不了。
所以本节的纪律是**只抄 DOM 结构与 CSS 取值**：颜色一律 `--dsw-*` token、
圆角一律 `var(--dsw-radius-*)`、图标用**手写内联 SVG**（不引图标库）。

### 21.2 官方三处的组件来源（逐条 `文件:行`，都在 `resources/app.asar` 里核过原文）

| 用户给的样子 | 官方组件 | 官方 DOM / CSS 证据 | 关键取值 |
|---|---|---|---|
| 「权限」那一行 | `PermissionRow`（`dsh-client-ui-permission-presets`） | 行：`PermissionRow.module.css` = 同包 `lib/client.js:438` 的内联 CSS 字符串；下拉触发器：同文件 `.selector`；菜单：`primitives/lib/Menu.module.css` | 行 `.row{align-items:center;gap:8px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);display:flex}`；左列 `.rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}`；标题 14px/400/22px；说明 `label-tertiary` 12px/18px；触发器 `.selector{height:36px;padding:0 14px;gap:12px;font-size:14px;line-height:22px;border-radius:var(--dsw-radius-md);border:none;background:var(--dsw-alias-bg-module-platform)}` |
| 下拉弹层 + ✓ | `primitives` 的 `Menu` / `MenuSurface` | `primitives/lib/index.js:3927`（`Menu`）、`:4198`（`selected && selection==='check'` → `IconCheckOutlineRegular`）、`:3782`（`MenuSurface`）；`Menu.module.css:7-35`（`.list`）、`:95-122`（`.item` / `:hover` / `:focus-visible`）、`:209-212`（`.check`）、`:216-218`（`.selected`）；`MenuSurface.module.css:1-33` | `.list{padding:4px;min-width:144px;max-width:360px;top:calc(100% + 4px);z-index:100;box-shadow:var(--dsw-elevation-prominent)}` + `border-radius:var(--dsw-radius-lg)`；`.item{min-height:34px;padding:6px 8px;border-radius:var(--dsw-radius-md);font-size:13px;line-height:20px}`；`.item:hover{background:var(--dsw-alias-interactive-bg-hover)}`；`.check{width:14px;height:14px}` |
| 「搜索插件」输入框 | **不是** `settings-form` 的字段，而是 `dsh-client-ui-settings-plugin-inventory` 自己的搜索框 | `settings-plugin-inventory/lib/client.js:57` 的内联 CSS（类名 `RotMhW_search`）+ 标记在 `:488-505` | `label>svg{position:absolute;left:12px;pointer-events:none}`；`input{width:100%;height:36px;padding:0 34px 0 36px;font-size:13px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1)}`；`::placeholder{color:var(--dsw-alias-label-tertiary)}` |
| 「字号大小」数字字段 | `FontSizeRow`（`dsh-client-ui-theme`） | `dsh-client-ui-theme/lib/client.js:1013` 的内联 CSS（类名 `_0Fr0Ha_*`）+ 标记在 `:1050-1098` | `.stepper{min-width:72px;height:36px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);display:inline-flex;position:relative}`；`.value{font-variant-numeric:tabular-nums;min-width:18px;font-size:14px;line-height:22px}`；`.unit{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}`；`.arrows{flex-direction:column;gap:2px;position:absolute;right:8px;opacity:0}`（hover / focus-within 才显形）；`.arrow{width:17px;height:12px;border-radius:var(--dsw-radius-xs)}`；到边界（10/22）`disabled` |

**"表单值字段"与"搜索框"确实不是同一个组件**（用户特别要求核这一条）：
`primitives/lib/settings-form/fields.module.css:107-118` 的 `.input` 是 **34px / `0 12px` /
13px / `bg-layer-3` / `border-l4`**，而搜索框是 **36px / `0 34px 0 36px` / `bg-layer-1`**。
本插件设置页的文本框沿用前者、作品库搜索框对齐后者（`sizes.test.mjs` 里分成
`OFFICIAL_FIELD` 与 `OFFICIAL_SEARCH` 两套断言）。

**同样重要的是**：官方 `SettingsValueField`（`fields.module.css:3-8`）本身反而是
**堆叠式**（`.field{display:flex;flex-direction:column;gap:6px}`，标签在输入框上方）。
用户给的"行式"参照是「权限」「字号大小」这两行 —— 它们在官方那边是**另一类**设置项
（由各功能包自己画，用的是 `.row`/`.rowText` 那一套）。本插件设置页统一取**行式**。

### 21.3 我们 → 官方 的逐项对照

| 项 | 官方 | 我们（`client/client.js`） |
|---|---|---|
| 字段布局 | `.row` + `.rowText`（行式，标签/说明在左、控件在右） | `Field`：`display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:.5px solid border-l2`；左列 `flex-direction:column;gap:4px;padding-right:48px`；标题 14px/22px；说明 `labelTertiary` 12px/18px |
| 下拉触发器 | `.selector` 36px / `0 14px` / 14px-22px / `radius-md` / **无描边** + chevron（展开转 180°） | `SelectField` 触发器：同上；底色取同族的 `bg-layer-3`（官方是 `bg-module-platform`，见下"偏离"）；chevron 16px、`color:labelTertiary`、`transform:rotate(180deg)` |
| 下拉弹层 | `Menu.module.css` 的 `.list` + `MenuSurface`（`radius-lg` + 阴影） | `pxm-select-list`：`padding:4px`、`min-width:100%`、`max-width:360px`、`radius-lg`、底 `bgOverlay`、0.5px `border-l1`、阴影由 `shadow()` 从 `label` token 派生、`top:calc(100% + 4px)`、`z-index:100`、`max-height:60vh` |
| 当前项标记 | 行尾 `IconCheckOutlineRegular`（`Menu` 的 `selection='check'`） | 行尾同路径的**手写内联 SVG**（`Icon name="check"`，14px），行上带 `aria-checked="true"` |
| 选项 hover / 键盘焦点 | `--dsw-alias-interactive-bg-hover`，且 `:focus-visible{outline:none}` | `<style>` 里同语义：`tint(T.labelTertiary, 12)` 填充 + `outline:none`（该 token 不在本插件已用清单内，见下"偏离"） |
| 搜索框 | 36px / `0 34px 0 36px` / 13px / `radius-md` / `border-l4` / `bg-layer-1` + 前置 16px 放大镜 `left:12px` | `SearchInput`：逐项相同；图标是同路径的**手写内联 SVG** |
| 数字步进器 | 36px / `min-width:72px` / `radius-md` / 数值 `tabular-nums` + 右侧单位 + 右侧上下两枚 17×12 的 chevron 按钮，边界 `disabled` | `NumberStepper`：几何逐项相同；单位是「张」（官方是 `px`）；上下按钮 `aria-label=增加/减少每次张数`，1/4 边界 `disabled` |
| 焦点可见 | 官方 `.helpButton:focus-visible` 等用 `--dsw-focus-ring-*` / 状态色 | 触发器与两枚步进箭头：`outline:2px solid labelTertiary;outline-offset:1px`（与既有按钮同一套，颜色仍只来自 token） |

**两处有意偏离（如实记）**：

1. **底槽 token**：官方触发器/步进器用 `--dsw-alias-bg-module-platform`，弹层 hover 用
   `--dsw-alias-interactive-bg-hover`。这两枚**不在**本插件已用的 token 清单里，
   而 `test/client-tokens.test.mjs` 有一条"代码里出现的 token 种类 == 清单"的硬约束
   （加 token 要同步改静态用例，等于放宽那一条）。本次**没有**动那条清单，
   改用同族、同在清单里的 `bg-layer-3`（控件层）与 `labelTertiary` 的 12% 半透明填充。
   **代价**：这两处的色值与官方不完全相同；**收益**：token 契约一条没动。
   如果后续要求"逐色相同"，正确的做法是把这两枚 token 加进 `REQUIRED_TOKENS` 并同步
   `theme.test.mjs` 的 token 表，而不是改成硬编码。
2. **步进器箭头常显**：官方 `.arrows{opacity:0}` 只在 hover / focus-within 时显形。
   本插件改成**常显**——验收项要求"两枚 chevron 可点、可键盘"，默认不可见的箭头
   对触屏/键盘用户等于不存在。几何照抄不变。

### 21.4 可用性（不弱于原生 `<select>`）

- `Tab` 能进触发器（原生 `<button>`）；`Enter` / `Space` 展开（`<button>` 的原生激活行为）。
- 展开后 `↑` / `↓` 在选项上移动**真实焦点**（照官方 `Menu` 的做法），`Home` / `End` 到首尾，
  `Enter` / `Space` 选中；`↑↓` 与 `Enter` 都 `preventDefault`（否则页面会跟着滚）。
- `Esc` 关闭并把焦点交回触发器；**点击外部（`pointerdown`）关闭**；关闭**不等于**选中。
- `aria-haspopup="menu"` / `aria-expanded` / `role="menu"` / `role="menuitem"` /
  `aria-checked` / `aria-labelledby`（`Field` 用 `htmlFor` 显式关联）齐备。

### 21.5 新增断言（浏览器 lane，新文件 + 9 条用例）

`test/browser/controls.test.mjs`（新文件，9 条）：

| 用例 | 钉住什么 |
|---|---|
| `1.1` | 触发器是 `BUTTON` + `aria-haspopup=menu` + **有 chevron**；展开后弹层存在、`role=menu`、**恰好一项带 ✓ 且它 `aria-checked=true`**（两种"当前项"表达必须落在同一项） |
| `1.2` | 搜索框是 `input`；**有前置图标**、`pointer-events:none`、距输入框左边界 **12px**、**16×16**；输入框**整宽**且图标在框内 |
| `1.3` | 步进器有**两枚** chevron 且落在容器内、上下排列；有单位后缀；点上/下改值；**n=1 时下箭头 disabled、n=4 时上箭头 disabled** |
| `2.1` | 四个字段逐个：标签与控件**纵向重叠 ≥ 半个标签高**且控件在标签右侧；说明文字在标签**下方**、同左列、不越到控件底下 |
| `3.1` | 展开后焦点在**当前项**；`↑`/`↓` 移动焦点（并 `preventDefault`）；`Enter` 选中后弹层收起、值写回触发器 |
| `3.2` | `Esc` 关闭弹层且焦点回到触发器 |
| `3.3` | 点外部关闭、**值不变** |
| `3.4` | **真键盘**（`page.keyboard`）：聚焦触发器 → 真 `Enter` 展开 → 真 `↑`/`↓` → 真 `Esc` 关闭并归还焦点（3.1~3.3 用的是合成事件，这一条补真按键链路） |
| `0` | lane 自证：探针都在 |

lane 侧新增探针（`test/browser/lane.js`）：`fieldRow` / `selectFacts` / `stepperFacts` /
`searchFacts` / `pressKey` / `pointerDownAt`。定位一律走**语义锚点**
（`data-pxm-field*` / `data-pxm-role` / `data-pxm-icon`），不写样式类名。

### 21.6 反向变异（5 条新变异，全部 ✔）

| 变异 | 改坏的实现 | 抓住它的用例（真实报错首行） |
|---|---|---|
| `M27-no-select-chevron` | 触发器不再渲染 chevron | `1.1`：**「触发器里必须有 chevron（官方 PermissionRow 的 .selector 就是标签+chevron）」**；`3.1`：「收起后 chevron 仍在（只是转回 0°）」 |
| `M28-no-select-list` | 点击后**永不渲染弹层** | `1.1`/`3.1`/`3.2`/`3.3`：**「page.waitForSelector: Timeout 5000ms exceeded」** |
| `M29-field-row-to-stack` | `Field` 退回**堆叠式** | `2.1`：「厂商：标签与控件必须在同一行（纵向重叠 ≥ 半个标签高）」；`layout.test.mjs` 的「「默认值」卡片：每个字段是行式」 |
| `M30-no-search-icon` | 搜索框去掉前置放大镜 | `1.2`：**「搜索框必须有前置图标（内联 SVG）」** |
| `M31-stepper-one-arrow` | 步进器只剩向上那一枚 | `1.3`：**「下箭头必须是一枚 chevron（内联 SVG）」** |

`tools/lane-mutations.mjs` 的 `TEST_FILES` 由 3 → **4**（+`controls.test.mjs`）。
另：`M10` 因 `Field` 结构变了而**换了变异点**（旧形态的 `flexDirection:column` 已不存在，
改成把左列的列方向写坏）；`M22` 的预期用例名跟着 `sizes.test.mjs` 的新标题更新。
两条都**没有被删除或放宽**。

### 21.7 因控件替换而调整过的既有断言（逐条）

1. `test/client-settings-dom.test.mjs` 的 `选择s`：`lane.selects()`（原生 `<select>`）
   → `lane.selectTriggers()` / `lane.selectList()` / `lane.pick()`（自绘触发器 + 弹层）。
   **强度不变**：仍然逐个证明"厂商/模型/尺寸的候选项真的在选项集合里"（改成展开弹层读
   `data-pxm-option`），并且**新增**了一条"展开后弹层必须存在"的断言。
   此路径只剩作品库「排序」一个原生 `<select>`（官方无对照物，保持原生），
   `lane.select()` 保留给那条。
2. `test/client-settings-dom.test.mjs` 的 `exportDirCard()`：卡片定位从"含标题的
   flex-column"改成"含标题 + flex-column + `padding:12px 14px`"。**不是放宽**：
   行式改造后标题不再直接住在卡片容器里，旧判据会连外层 `.pxm-settings` 一起收进来。
3. `test/browser/lane.js` 的 `settingsSlots`：`select` 角色从 `root.querySelector('select')`
   → `[data-pxm-role="select"]`；`button` 角色加 `.pxm-btn` 限定（行式布局里自绘触发器与
   两枚步进箭头也是 `<button>`，不限定就会量错元素）。**角色语义不变**。
4. `test/browser/sizes.test.mjs`：`fieldExpectation()` 分流——
   `select` → **新增**的 `OFFICIAL_SELECT`（36px / `0 14px` / 14px / **无描边**）、
   `searchInput` → **新增**的 `OFFICIAL_SEARCH`（36px / `0 34px 0 36px` / `bg-layer-1`）、
   `sortSelect` 仍按 `OFFICIAL_FIELD` 去掉 `lineHeight`。`borderDiff()` 增加
   `expectNoBorder` 分支（官方触发器确实没有描边）。**每一条都是"换成官方对应物的确切值"，
   没有任何一条被放宽或删掉**；1.1 的用例标题改成"输入框 = 官方表单控件；自绘下拉触发器
   = 官方 .selector"。
5. `test/browser/layout.test.mjs` 的 7a：**方向反转**——原来断言"控件必须在标签下方、
   左边界对齐"（旧形态），现在断言"控件必须与标签**纵向重叠**且排在右侧"（行式）。
   这是需求要求的形态变更（同一行 vs 上下），**不是放宽**：断言数量与严格度相当，
   而且新增了"说明文字必须在标签下方"这一条。另三处 `waitForSelector('select')`
   改成 `waitForSelector('[data-pxm-field]')`；导出路径输入框改用 `#pxm-export-dir` 定位
   （原来用文档里第一个 `input`，行式改造后会绑错元素）。
6. `test/browser/theme.test.mjs` 的 8.9：`select` 选择器改自绘触发器；该控件的**描边**
   那一半改成"不适用"（官方触发器 `border:none`，是另一个模板），底色那半照旧判
   `bg-layer-3`。用例标题与那张对照表注释同步更新。
7. `test/client-tokens.test.mjs`：**一条都没改**（没有新增 token）。

**没有删除或放宽任何一条断言**：`pnpm test` 仍是 **323**（2 条既有用例被改写、`it` 数量不变），
`pnpm test:browser` **30 → 39**（+9）。

`git diff` 里出现的 4 行被删掉的 `it(` 全部是**同名替换**（用例体保留、只换标题与定位方式）：

| 旧标题 | 新标题 | 为什么 |
|---|---|---|
| `默认值卡片：三个字段是可选的 select，模型选项来自当前厂商` | `…三个字段是自绘下拉…` | 控件换了，"select" 这个词不再准确 |
| `「默认值」卡片：每个字段的标签与控件同列（控件在标签下方、左边界对齐）` | `「默认值」卡片：每个字段是行式（标签+说明在左、控件在右，纵向重叠）` | 形态方向反转（堆叠 → 行式） |
| `1.1 输入框 / 下拉 = 官方设置页表单控件（34px / …）` | `1.1 输入框 = 官方表单控件；自绘下拉触发器 = 官方 .selector（36px / …）` | 两套尺寸分开断言 |
| `8.9 input / password / select 的底色与描边逐个等于官方解析值；提示词 textarea 同` | `8.9 input / password / 自绘下拉触发器的底色与描边逐个等于官方解析值；提示词 textarea 同` | 控件换了名字 |

### 21.8 结果

`pnpm verify`：**323 + 39**，全绿。`git diff` 里被删掉的 `it(` 只有上面那 4 行**改名**，
没有任何用例体被删。

### 21.9 没做到 / 没把握（诚实记录）

1. **弹层定位在窄屏下的表现只做了"不溢出"层面**：弹层是 `position:absolute` +
   `min-width:100%` / `max-width:360px`，随触发器走。若某个字段的右列本身很窄
   （例如 375px 下），弹层最窄就是那个宽度 —— 选项文字靠 `text-overflow:ellipsis` 收，
   **没有**做官方 `Menu` 的 portal + 视口翻转（`portal:true` 那一套）。
   触发器的祖先若有 `overflow:hidden` 也会裁掉弹层；当前设置弹窗的滚动层是
   `overflow-y:auto`，实测在 520/375 两档没有裁切，但这条**没有被专门断言覆盖**。
2. **"Tab 进入触发器"这条链路仍然只是近似**：3.4 走的是真 `page.keyboard`，但用
   `page.focus()` 把焦点**放到**触发器上，而不是"从上一个控件按 Tab 走过来"
   （真 Tab 序列会被设置弹窗自己的焦点陷阱影响，断言会变得很脆）。合成事件那条
   （3.1~3.3）另外补齐了 `keyCode` / `which`（`lane.js` 的 `pressKey`），但它毕竟不是真按键。
3. **`aria-checked` 用在 `role="menuitem"` 上**：官方 `Menu` 用的是"行尾 ✓"，
   `aria-checked` 是本次为可断言性补的（`menuitemradio` 才是 ARIA 的标准搭配）。
   屏幕阅读器行为**未实测**。
4. **步进器箭头常显是对官方的一处偏离**（见 21.3），观感与官方 hover 才显形不同。
5. **`bg-module-platform` / `interactive-bg-hover` 两枚官方 token 没有引入**（见 21.3），
   这两处的色值与官方不是逐色相同。
6. 作品库的「排序」仍是原生 `<select>`：官方 client 侧没有同形态对照物，
   **保持现状**（没有硬造一个"像官方"的样子）。

## 22. 作品库工具条：压成单行（2026-10-10，按用户要求）

### 22.1 用户要求（原话）与改动前后

> 删除左边部分，把右边放在一行，排序、全选和取消全选放左边，搜索放右边

**改前**：`bars` 里是**三行**，每行都是"左列标签+说明 / 右列控件"（`Field` 组件）：

| 行 | 左 | 右 |
|---|---|---|
| 1 | `搜索（项目名 / 模块名）` + `输入即筛，300ms 防抖` | 搜索框 |
| 2 | `排序` + `只影响列表顺序，不改任何文件` | 排序下拉 |
| 3 | `显示 N / 共 M` | `全选（当前 N 个）` + `取消全选` |

**改后**：**一行**（`.pxm-list-bar`，`data-pxm-toolbar` 为语义锚点）：

```
[排序下拉] [全选（当前 N 个）] [取消全选]  ······  [搜索框]
 ←———— 左 ————→                                 ←— 右 —→
```

- 那四段标签 / 说明文字**全部删除**（`Field` 包装从工具条上撤掉）；
- 「显示 N / 共 M」**删除**；
- 搜索框靠 `marginLeft:'auto'` 右对齐、`flex:'0 1 220px'`（桌面 220px，不够先缩再折行）；
- 排序下拉靠 `flexGrow:0 / flexShrink:1 / flexBasis:'content'` 保持固有宽度
  （**两个坑**：`flex:'0 1 auto'` 的 `flex-grow` 默认 1，`<select>` 会吃满整行；
  `flexBasis:'auto'` 取的是 `width:auto`，块级 `<select>` 在 flex 项里解析成
  `fill-available`，照样占满。必须显式 `content`）；
- 窄屏沿用 `skin.row` 的 `flexWrap:'wrap'`：放不下时**搜索框折到第二行**。

### 22.2 刻意回归：`hasMore` 的可见信息量**净减少**（不粉饰）

「显示 N / 共 M」原来是界面上**唯一**把"宿主那边还有多少条被 `limit` 静默截掉"
摆出来的地方。按用户要求删掉之后：

- **还看得见**的：`hasMore` 由滚动区里的「加载更多（还有 N 个）」体现
  （按钮在 = 还有；按钮没了 = 取完了；N = `total - shown`）；
- **看不见了**的：`已加载 N 条 / 共 M 条` 这个**绝对计数**。用户无法一眼看出
  当前只加载了 `24 / 共 150`。

**这是可见信息量的净减少，不是等价替换。** 恢复办法：把那一行
（`h('span',{className:'pxm-count'}, '显示 ' + shown + ' / 共 ' + total)`）
加回 `client/client.js` 的 `bars` 即可；`shown` / `total` 两个变量**仍然存在**
（`total` 还在给「加载更多」算剩余数），加回去不需要动任何取数逻辑。
代码侧同一段警示写在 `client/client.js` 工具条上方那条注释里。

### 22.3 新增断言（`test/browser/layout.test.mjs` §9，3 条用例）

1. **9.1 单行 + 左右分半 + 标签已删**：
   - 四枚控件（`[data-pxm-role="sort" / "select-all" / "select-none" / "search"]`，
     按**语义角色**找，不按类名）两两 `getBoundingClientRect()` **纵向重叠 > 0**，
     且每枚都与工具条行的**中线相交**；
   - 排序 / 全选 / 取消全选的**右边界 ≤ 行中点**，搜索框的**左边界 ≥ 行中点**
     且 `|右边界 − 行右边界| ≤ 2`（真的右对齐）；
   - 工具条行里 `[data-pxm-field-label]` / `[data-pxm-field-desc]` 必须为**空数组**
     （原来那三行就是靠它们承载标签与说明）；
   - 整页文本里 `搜索（项目名 / 模块名）` / `输入即筛` / `只影响列表顺序` /
     `显示 ` / ` / 共 ` **一个字都不许剩**（`显示 ` 与 ` / 共 ` 在全插件里
     只有那一处计数会拼出来，见 `client.js:1950` 的模型选择面板 —— 它不展开就不存在）；
   - `placeholder` **逐字等于** `搜索项目名 / 模块名`（左侧标签删了之后它是唯一交代）。
2. **9.2 375px 无横向溢出**：`[data-pxm-toolbar].scrollWidth <= clientWidth + 1`、
   `documentElement.scrollWidth <= clientWidth + 1`、`.pxm-scroll` 自身也不横向溢出；
   左侧三枚控件必须**完整落在行内**且**两两纵向重叠**（折行只允许发生在搜索框上）。
3. **9.3 内部滚动没被破坏**：`.pxm-scroll` 仍 `overflow-y:auto` / `overflow-x:hidden`、
   夹具真的长出可滚内容、滚 800px 后 `scrollTop > 0`，且工具条的
   `getBoundingClientRect()` **一个像素都没动**（它属于固定层）。

`test/browser/lane.js` 新增两个探针：`toolbarRow()`（按 `data-pxm-role` 交几何事实）、
`bodyHasText(text)`（整页文本查找）。`Select` / `Btn` 各新增一个 `props.role` →
`data-pxm-role` 的透传（与设置页 `[data-pxm-role="select"]` 同一做法）。

### 22.4 因布局改动而调整过的既有断言（**逐条**，共 4 处）

> 没有删除任何一条断言，也没有放宽任何一条 —— 下面每条都写清"换成了什么、为什么
> 强度不低"。

1. `test/workbench-dom.test.mjs:787`（用例"懒加载：封面一张…"）
   `assert.ok(lane.text().includes('显示 3 / 共 3'))`
   → `assert.equal(lane.container.querySelectorAll('.pxm-tile').length, 3, …)`。
   **强度不降反升**：原来断言的是 `shown` 被格式化成一段文字，现在直接钉住
   "已加载 3 条就渲染 3 张卡片"（那串计数的事实来源就是 `shown = projects.length`）。
   另外把"没有更多时不该有加载更多"从只查 DOM 元素补成
   `lane.text().includes('加载更多') === false`。
2. `test/workbench-dom.test.mjs:798`（用例"加载更多是追加…"）
   `assert.ok(lane.text().includes('显示 24 / 共 30'))`
   → ① 渲染卡片数 == 24；② `「加载更多」按钮文案含「还有 6 个」`（`total − shown`）。
   **更强**：现在证明的是"宿主报的 `total` 真的被界面用上了"，而不只是一段文字存在。
3. `test/workbench-dom.test.mjs:802` 同用例的 `显示 30 / 共 30`
   → 删掉（上面 `assert.equal(…length, 30, '加载更多必须追加而不是替换')` 已经逐字覆盖
   同一事实，重复断言没有额外强度）。
4. `test/workbench-dom.test.mjs:826`（用例"宿主只回 total 没回 hasMore…"）
   `assert.ok(lane.text().includes('显示 24 / 共 30'))`
   → `assert.ok(loadMore)` + 文案含「还有 6 个」+ 渲染卡片数 == 24。
   **强度相当**：本用例的意图就是"只给 `total` 也要推出还有更多"，而这个推论现在
   **唯一**的表现就是「加载更多」按钮存在。

另外 **2 处非断言的定位改动**（不改判定，只换"等哪个元素出现"）：

5. `test/browser/controls.test.mjs` 的 `openLane()`：`waitForSelector` 从一律
   `'[data-pxm-field]'` 改成"`main` 槽等 `'[data-pxm-toolbar]'`、其余槽等
   `'[data-pxm-field]'`"。原因：工具条上的 `Field` 包装按用户要求撤掉了，
   `main` 槽里**不再有** `[data-pxm-field]` —— 不改的话 1.2 会 30s 超时。
   1.2 自身的断言（整宽 / 前置图标 `left:12px` / 16×16 / `pointer-events:none` /
   有 placeholder）**一条都没动**。
6. `test/workbench-dom.test.mjs:1270` 的断言消息文案
   （"计数 / 全选属于固定层" → "排序 / 全选 / 取消全选 / 搜索都属于固定层"）：
   `.pxm-list-bar` 元素**没变**（它一直是这一层工具条的锚点），只是它现在的含义
   从"计数行"变成了"单行工具条"，描述同步。

### 22.5 反向变异（`tools/lane-mutations.mjs`，5 条新变异，全部 ✔）

| 变异 | 改坏什么 | 抓住它的用例 | 真实报错（首条） |
|---|---|---|---|
| `M32-search-to-left` | 去掉搜索框的 `marginLeft:'auto'`（右对齐失效，搜索回到左边） | 9.1 | `搜索框必须落在工具条行的**右半**（左边界 559.140625 < 中点 750）` |
| `M33-toolbar-nowrap` | `flexWrap: wrap → nowrap` | 9.1 / 9.2 | 9.1：`工具条行必须允许换行（窄屏不得溢出）` / `'nowrap' !== 'wrap'`；9.2：`左侧三枚控件在 375px 下也必须同处一行（纵向重叠 -8px）` |
| `M34-search-rigid-overflow` | 搜索框 `flex:'0 1 220px' → '0 0 400px'`（不可压缩的定宽，比 375px 可用宽 339px 还宽） | 9.2 | `工具条行不得横向溢出：{"scrollWidth":400,"clientWidth":339,"row":{…}}` |
| `M35-label-back` | 把删掉的 `[data-pxm-field-label]` / `[data-pxm-field-desc]` 与「搜索（项目名 / 模块名）」加回来 | 9.1 | `工具条行里不该再有字段标签 / 说明：["输入即筛，300ms 防抖","搜索（项目名 / 模块名）"]` |
| `M36-placeholder-vague` | placeholder 从 `搜索项目名 / 模块名` 退回 `搜索` | 9.1 | `左侧标签删掉后，placeholder 必须自己交代搜什么（项目名 / 模块名）：搜索` |

**分工说明**：`M33` 与 `M34` 是刻意分开的两条 —— `M33`（禁止换行）会先撞上"行内
三枚控件被挤散"那条断言，**溢出那条轮不到报**；`M34` 让左侧三枚控件照旧整齐、
只把溢出单独逼出来。两条合起来才证明 9.1 的"左右位置"、9.1 的"标签已删"、
9.2 的"不横向溢出"三处**都不是空跑**。

### 22.6 结果

`pnpm verify`（`typecheck + build + test + test:browser`）：**323 + 42**，全绿。
`pnpm test` 仍是 **323**（基准不变，只有 3 条既有用例的锚点被改写，`it` 数量不变）；
`pnpm test:browser` **39 → 42**（+3，全部是 §22.3 的新用例）。

### 22.7 没做到 / 没把握（诚实记录）

1. **窄屏折行后的观感只做到"不溢出"，没做"更好看"**：375px 下实测是
   第一行 `排序 / 全选 / 取消全选`（320px of 339px）、第二行搜索框**右对齐**
   （220px，右侧留 11px 空隙）。它不溢出、三枚控件同处一行，但第二行左半是空的，
   观感偏"右重左轻"。没有改成"折行后搜索框整宽"（那需要容器查询 / `ResizeObserver`，
   属于把改动扩大，本次不做）。520px 下同样是两行。
2. **搜索框的 220px 是写死的基准宽**（不是 `%`）：1280px 视口下它不跟着面板变宽。
   好处是"搜索框不该长得像主内容"；代价是超宽屏下它偏窄。
3. **排序下拉的固有宽度由最长选项决定**（实测 107px，「名称 A→Z」那档）。
   这是原生 `<select>` 的平台行为：将来加一个更长的选项，工具条第一行会跟着变宽，
   375px 下可能从"搜索框折行"变成"某枚按钮也折行"。当前 5 条用例只保证
   "不横向溢出"，**没有**保证"永远只有搜索框折行"（9.2 里那条"左侧三枚同处一行"
   会在选项变长到把按钮挤下去时变红）。
4. **点开排序下拉时的原生弹层位置未测**：`<select>` 的弹层由平台绘制，
   在窄屏折行状态下它挂在哪一枚控件下方**没有断言覆盖**。

## 23. 厂商配置卡片对齐官方「模型」设置页（2026-10-11）

用户要求：把设置页的「厂商 / 模型配置」卡片改成 DSH 官方**「模型」设置页**的样子，
但**不许丢**三样东西 —— 「拉取模型」按钮、「测试连接」按钮、拉取之后的模型列表。

### 23.1 先读官方实现（不是凭印象画）

官方那一页 = `dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`
（app.asar 内的原文件；下面行号即该文件行号，`tools/asar.mjs read` 取出的副本行号一致）。

| 位置 | 证据（文件:行 / 规则原文） |
|---|---|
| 页面整体 | `:2102-2112` → `div.section > h2.title + p.intro`；`.section{max-width:720px;flex-direction:column;gap:12px}`、`.title{font-size:16px;font-weight:500;line-height:24px}`、`.intro{color:label-tertiary;font-size:14px;line-height:22px}`（CSS 全在 `:58` 那一行内联串里） |
| 区块之间怎么分 | 页面不分「卡片套卡片」：`h2` + `intro` 之后直接是 `ul.rows`（`:2123-2124`）。`.rows{flex-direction:column;gap:8px;margin:12px 0 0;padding:0;list-style:none}` |
| 卡片 | `:2160-2161` `li.rowCard` → `.rowCard{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);flex-direction:column;gap:12px;padding:12px 14px}` |
| 厂商标头 | `:2163-2187` → `.rowHead{align-items:center;gap:10px;display:flex}` > `.rowIdentity{align-items:center;gap:6px;min-width:0;display:inline-flex}` > `.rowName{font-size:14px;font-weight:500;line-height:22px}` + `.rowTag{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:label-secondary;padding:1px 6px;font-size:11px;line-height:16px}` + `.credentialDot{width:8px;height:8px;border-radius:50%}`（已配置 `state-success-primary` / 缺失 `state-error-primary`） |
| 副信息 | 模型数 / 状态**不在**标头行：状态是那枚 8px 圆点（`role="img"` + `aria-label` + `title`，`:2176-2186`）；自定义与否在模型区块的 `.modelCatalogMeta`（`:465-468`）。**没有**「厂商分组 / apiMode」这类字段 —— 官方最接近的是编辑块里的 `.editorRoute`（`:1291-1293`，"这一条走哪个路由/协议"） |
| 操作按钮放哪 | 两处：① 标头**行尾** `.rowActions{align-items:center;gap:4px;margin-left:auto;display:inline-flex}`（`:2188-2212`，放「编辑」「删除」）；② **模型区块标题行右侧**的 `.modelListHead`（`:729-759`）里放「获取模型」。档位：`.rowActions .secondaryButton{border-radius:var(--dsw-radius-sm);height:28px;padding:0 10px;font-size:12px;line-height:18px}`（= `Button.sm`）；「获取模型」是 `.linkButton{border-radius:var(--dsw-radius-sm);height:28px;padding:0 10px;font-size:12px;line-height:18px;color:label-tertiary;background:0 0;border:none}` |
| 编辑块（字段） | `:1286-1395` `div.editor > div.editorHeader(editorTitle+editorRoute) + div.field(fieldLabel+input)… + div.editorActions`；`.editor{border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);flex-direction:column;gap:14px;padding:14px 16px}`、`.editorHeader{align-items:baseline;gap:8px}`、`.editorTitle{14px/22px;500}`、`.editorRoute{12px/18px;label-tertiary}`、`.field{flex-direction:column;gap:6px}`、`.fieldLabel{color:label-secondary;font-size:12px;font-weight:500;line-height:18px}`、`.editorActions{justify-content:flex-end;gap:8px}` |
| 输入字段用哪套 | **不是** `settings-form` 的 `.input`：这一页有自己的 `._3nPmjq_input{height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-size:14px;line-height:22px}`。**我们没跟这一档**（理由见 §23.5-①） |
| 模型列表：行式还是 chips | **行式**，两种：① 卡片内可编辑列表 `.modelList{gap:8px}` + `.modelEntry{border:.5px solid border-l4;border-radius:var(--dsw-radius-lg);padding:6px}` + `.modelRow{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto auto;gap:6px}`（`:209-277`）；② 拉取弹层里的**多选**列表 `.candidateList{gap:2px;max-height:320px;padding:0;overflow-y:auto}` + `.candidate{border-radius:var(--dsw-radius-md)}` + `.candidateLabel{cursor:pointer;align-items:center;gap:8px;padding:6px 8px;display:flex}` + `.candidateId{font-family:var(--ds-font-family-code);font-size:13px;text-overflow:ellipsis;white-space:nowrap;flex:auto;overflow:hidden}`（`:88-91` / `:862-881`）。**没有 chips**。选中态 / hover 态：官方候选行**没有任何** hover / checked 样式规则（选中靠原生 `<input type="checkbox">`，hover 只有 `cursor:pointer`） |
| 弹层 | 拉取结果在 `primitives` 的 `Modal` 里（`:824-882`），`.fetchDialog{max-width:520px}`；工具条 `.candidateToolbar{gap:8px}`、搜索框 `.candidateSearch{flex:240px;min-width:0}`，两枚按钮是 `Button ghost size="sm"` |

**token 的一处关键事实**（`@deepseek-ai/dsh-client-ui-theme/lib/client.js` 的 base CSS）：
`--dsw-alias-settings-card-stroke: var(--dsw-alias-border-l4)`、
`--dsw-alias-settings-card-fill: var(--dsw-alias-bg-layer-2)` ——
所以卡片那两个"官方专用 token"就是本插件**已有**的 `border-l4` / `bg-layer-2` 的别名，
不是近似色。

### 23.2 官方 → 我们（逐项）

| 位置 | 官方 | 我们（2026-10-11 之后） |
|---|---|---|
| 厂商区块 | `.section{gap:12px}` + `ul.rows{gap:8px;margin:12px 0 0;padding:0;list-style:none}` | `div.pxm-vendors`（gap 10px，承接外层 `skin.wrap` 的 14px）+ `ul.pxm-vendor-rows`（gap 8px / margin 12px 0 0 / padding 0 / list-style none）**取消了原来"卡片套卡片"的外壳** |
| 一家厂商 | `li.rowCard`：`.5px settings-card-stroke / settings-card-fill / radius-xl / gap 12px / padding 12px 14px` | `li[data-pxm-vendor-card]`：0.5px `border-l4`（= stroke 的别名目标）/ `bg-layer-2`（= fill 的别名目标）/ `radius-xl` / gap 12px / padding 12px 14px |
| 标头 | `rowHead` gap10 + `rowIdentity` gap6 + `rowName` 14/22/500 + `rowTag` 1px 6px·11/16·radius-xs + `credentialDot` 8px | 同（`[data-pxm-vendor-head]` / `-identity` / `-name` / `[data-pxm-row-tag]` / `[data-pxm-credential-dot]`）；`id` 落在 rowTag 上 |
| 副信息 | 密钥状态 = 圆点（aria-label/title）；"自定义"标记 = 模型区块 meta；没有 group/apiMode | 密钥状态 = 同一枚圆点；`group · apiMode` 落在编辑块的 `[data-pxm-vendor-route]`（官方 `.editorRoute` 的同语义位） |
| 操作按钮 | 行尾 `rowActions`（sm 档）+ 模型区块标题行右侧的 `linkButton`「获取模型」 | 「测试连接」在 `[data-pxm-vendor-actions]`（行尾，sm 档 28px）；「拉取模型」在模型区块标题行右侧（`linkButton` 档：28px / 0 10px / 12-18 / radius-sm / 无描边 / 透明底）；「保存 / 清除密钥」在编辑块行尾的 `[data-pxm-editor-actions]`（右对齐 + gap 8px） |
| 字段 | `.field` 堆叠式（标签在上）+ `.fieldLabel` 12/18/500 secondary | 新增 `EditorField`（`data-pxm-editor-field`），取值同上；**保留**原有行式 `Field`（默认值 / 导出路径卡片仍在用） |
| 编辑块 | `.editor` radius-lg / padding 14px 16px / gap 14px / `bg-module-platform` | 同（`[data-pxm-editor]`，底色 = `T.bgModulePlatform`） |
| 模型区块 | `.modelCatalog{border-top:.5px solid border-l2;gap:10px;padding-top:12px}` + `modelCatalogTitle{12/18/500}` + `modelCatalogMeta{12/18}` | 同（`[data-pxm-model-catalog]` / `[data-pxm-model-title]` / `[data-pxm-model-meta]`） |
| 模型列表（多选） | `.candidateList` + `.candidateLabel` + `.candidateId` | 同（`[data-pxm-model-list]` / `[data-pxm-model-row]` / `[data-pxm-model-name]`）：行 = checkbox + 等宽 13px 模型名（+「图像」小标签），gap 2px、行 padding 6px 8px、radius-md、列表内部滚动 |
| 拉取工具条 | `.candidateToolbar{gap:8px}` + `.candidateSearch{flex:240px}` + ghost sm 按钮 | 同（搜索框 240px 基准；「全选 / 全不选 / 只选图像模型」改走 `LinkButton` = ghost sm 档） |
| 空态 | `.modelEmpty{border:1px dashed border-l3;border-radius:radius-lg;text-align:center;padding:12px}` | 同结构（描边用 `border-l2`，见 §23.5-②） |

### 23.3 三个保留项各自落在哪 + 新断言

| 保留项 | DOM 位置 | 新断言（`test/browser/vendors.test.mjs`） |
|---|---|---|
| 「拉取模型」 | 模型区块标题行右侧 `<button class="pxm-link-btn" data-pxm-role="fetch-models">`（`ModelCatalog` 内）；忙碌态文案 `拉取中…` | **1.1**：`vendorFacts().fetchButton` 存在 / `tag==='BUTTON'` / 文案逐字 `拉取模型` / `disabled===false`；再真点一次，断言 lane 记下的请求里**恰好一条** `POST …/refresh-models` |
| 「测试连接」 | 标头行尾 `[data-pxm-vendor-actions]` 内 `<button class="pxm-btn" data-pxm-role="test-connection">`；忙碌态 `测试中…` | **1.2**：同上（文案 `测试连接`），真点之后**恰好一条** `POST …/test`，且页面出现 `连接正常` |
| 拉取后的模型列表 | 模型区块内 `[data-pxm-model-list]` > 每行 `label[data-pxm-model-row]`（checkbox + 模型名） | **1.3**：拉取前 `rowCount===0`；点「拉取模型」后列表出现且**行数 == 夹具模型数（5）**，5 个模型名逐个都在，且**每一行都有自己的 checkbox** |

> 请求记录为什么由 lane 交（新探针 `fetchCalls`）：插件的 `window.fetch` 被 lane 换成了
> 夹具路由，浏览器侧**没有真实网络请求**，`page.on('request')` 什么都看不到
> （实测第一次跑就是 `posts` 恒为空、1.1/1.2 双双变红）。lane 里同时补了
> `fixture.posts`（键 = 路径正则）好让「拉取模型」真的回一份模型目录。

### 23.4 调整过的既有断言（逐条）

1. **`test/client-tokens.test.mjs` 的 `REQUIRED_TOKENS` 扩容 19 → 22**（不是削弱）：
   新增 `--dsw-alias-bg-module-platform`（官方编辑块底色，浅色 `#f5f6f7` 与
   `bg-layer-3` 的 `#fff` **不同值**）、`--dsw-radius-xs`（官方 rowTag 的圆角 4px）。
   相应地 `T` / `S` 各进一枚键、`radiusTokens` 局部清单补上 `-xs`。
   该用例守的是"代码里出现的 `--dsw-*` 种类 == 清单"——**加 token 必须两边一起改**，
   所以这是它设计好的扩展路径；清单变长之后断言只会更严。
   （`border-l3` 那枚**没有**扩容，见 §23.5-②。）
2. **没有其它既有断言被改**：`sizes.test.mjs` / `theme.test.mjs` / `controls.test.mjs` /
   `layout.test.mjs` 与全部 jsdom 用例**一个字都没动**，42 + 323 的基准数量与内容都不变
   （新用例只增加在 `test/browser/vendors.test.mjs`）。
3. `test/browser/lane.js` 是 harness（不是断言）：新增 `fixture.posts` 分支、`fetchCalls`、
   `vendorFacts` 探针，并给 `boxMetrics` **增量**补了几个计算样式键（gap / alignItems /
   justifyContent / backgroundColor / borderTopColor / maxHeight / overflowY / margin* 与
   `border-top` 声明值）。既有用例只比它自己 `expect` 里列出的键，多出来的键不影响它们。

### 23.5 与官方的偏差（每一处都说清代价）

1. ~~**输入控件仍是 `settings-form` 的 `.input`（34px / `0 12px` / 13px / `bg-layer-3`），
   不是这一页自己的 `.input`（32px / `0 10px` / 14px / `bg-layer-1`）**~~
   **（2026-10-12 已修正：见 §24.2 —— 这一页私有的那枚 `._3nPmjq_input` 与
   `settings-form` 的 `.input` 是同一页里并存的两个类，按"控件属于哪一类"各自对齐；
   §23.5-1 原来那段理由"改它要改两条既有断言，与'不得削弱断言'冲突"方向是错的：
   那两条断言按官方值更新即可，更新断言 ≠ 放宽断言。）**
   官方同一页里两个类并存：`.field` 里的 `<input>` 用的是**页面私有**的
   `._3nPmjq_input`（`:73`），而 `primitives` 的 `settings-form/fields.module.css` 的
   `.input` 是**跨页面共享**的表单值控件。本插件从 2026-10-07 起把设置页的全部表单控件
   对齐到后者，并被两条既有断言钉住（`sizes.test.mjs` 1.1 的 34px/`0 12px`/13px、
   `theme.test.mjs` 8.9 的 `bg-layer-3`）。改成页面私有的 32px/`bg-layer-1` 必须**改这两条
   既有断言**（且会把"输入控件层"的语义从 `bg-layer-3` 挪到 `bg-layer-1`），
   与"不得削弱或删除任何现有断言"冲突 —— 所以本次不动，如实记为偏差。
2. **`rowTag` / 空态虚线框的描边用 `border-l2`，官方是 `border-l3`**：`border-l3` 官方是
   `#0000001f`(浅) / `#ffffff29`(深)，`border-l2` 是 `#0000001a` / `#ffffff1f` —— 差 5/255
   的 alpha。为这一处扩容 token 清单不划算（§23.4-1 的代价是实打实的），故不扩。
   形状（0.5px / 1px dashed / radius-xs / radius-lg）都按官方。
3. ~~**模型列表滚动上限保留 240px**（官方 `.candidateList` 是 320px）~~
   **（2026-10-12 已修正：见 §24.2 / §24.3 —— 上限改成官方的 320px，
   并把那条 jsdom 断言按官方值更新；"150 项不许把卡片撑爆"这条保证没有被削弱：
   `overflowY:auto` 与上限本身都还在，只是上限挪到官方值。）**
   既有 jsdom 用例（`test/client-settings-dom.test.mjs`「列表必须放在 max-height: 240px
   的滚动容器里」）把它钉在 240px，而 240 < 320 —— 改大等于**放宽**"150 项不许把卡片撑爆"
   这条保证。
4. **拉取结果仍在卡片内联展开，官方是 `Modal`**：官方把候选列表放在 `Modal`（`.fetchDialog`
   `max-width:520px`）里。本插件的面板开合行为（展开 / 取消 / 重开、内部滚动）被既有 jsdom
   用例逐条钉住，改成 Modal 属于"换交互形态"而不是"统一视觉"，本次不做；列表本身的几何
   按官方取值。
5. **编辑块里的提交行是 28px（`Button.sm`）**，官方 `.editorActions` 里那两枚是默认档
   36px（`.primaryButton{height:36px}`）：本插件全站按钮都是同一枚 `Btn`（`Button.sm`），
   既有尺寸用例（1.2）钉着 28px。混进一枚 36px 按钮会让"设置页按钮 = 官方 `.sm`"这条
   断言失去意义。
6. **模型名的字体族**用本插件既有的 `skin.code.fontFamily`（`ui-monospace, …`），
   官方是 `var(--ds-font-family-code)`（`SF Mono, JetBrains Mono, …`）。字号（13px）、
   省略号截断、`flex:auto` 都按官方。
7. **我们没有的官方字段**：官方那一页有「自定义 / 声明式提供方」标记（`row.entry.declared`
   → rowTag「自定义」）、凭据点的"缺失"三态（`credentialMissing` 只在配了 `apiKeyEnv`
   却没凭据时出现）、路由 `editorRoute`（provider 的注册路由 id）、以及每个模型的
   `contextWindow / maxTokens / inputModalities` 形状。本插件的数据模型里**没有**这些
   （见 `src/**` 的 provider 视图）：`group` / `apiMode` 是就近塞进 `.editorRoute` 那一格的
   近似，其余一概没有画。这是**能力差异**，不是样式差异。

### 23.6 反向变异（`tools/lane-mutations.mjs` 新增 4 条，全部 ✔）

| 变异 | 改坏什么 | 抓住它的用例 | 真实报错 |
|---|---|---|---|
| `M37-no-fetch-models-button` | 删掉「拉取模型」按钮 | 1.1（+1.3 / 2.3 / 2.4 连带） | `AssertionError: 卡片上必须有「拉取模型」按钮` |
| `M38-no-test-connection-button` | 删掉「测试连接」按钮 | 1.2 | `AssertionError: 卡片上必须有「测试连接」按钮` |
| `M39-vendor-card-style-old` | 卡片 `padding:12px 14px→10px 12px`、`radius-xl→radius-lg`、描边 `border-l4→border-l1` | 2.1 | `厂商卡片与官方 rowCard 不一致：`<br>`厂商卡片 的 paddingTop：实测 10px，官方 12px`<br>`… paddingRight：实测 12px，官方 14px`（paddingBottom/Left 同）<br>`厂商卡片 的 borderRadius：实测 16px，官方 var(--dsw-radius-xl) 的解析值 20px`<br>`厂商卡片 的 borderTopColor：实测 rgba(0, 0, 0, 0.04)，官方 var(--dsw-alias-border-l4) 的解析值 rgba(0, 0, 0, 0.16)` |
| `M40-model-list-style-old` | 模型行退回旧样式（去掉 padding / radius，gap 8→6px） | 2.3 | `模型行与官方 .candidateLabel 不一致：`<br>`模型行「google/gemini-3.1-flash-image图像」 的 gap：实测 6px，官方 8px`<br>`… 的 paddingTop：实测 0px，官方 6px` / `paddingRight：实测 0px，官方 8px`（paddingBottom/Left 同）<br>`… 的 borderRadius：实测 0px，官方 var(--dsw-radius-md) 的解析值 12px` |

**M37 的连带失败是如实记录而不是噪声**：没有那一枚按钮就拉不出候选列表，
1.3（列表条目数）与 2.3 / 2.4（列表行 / linkButton 的几何）都无从谈起。

### 23.7 结果

`pnpm verify`（`typecheck + build + test + test:browser`）：**323 + 49**，全绿。
`pnpm test` 仍是 **323**（基准不变：只有 `client-tokens` 的 token 清单扩容，`it` 数量不变）；
`pnpm test:browser` **42 → 49**（+7，全部在新增的 `test/browser/vendors.test.mjs`）。

### 23.8 没做到 / 没把握（诚实记录）

1. **没做成 `Modal`**（§23.5-4）：官方的拉取候选是在弹层里选的，我们是卡片内展开。
   视觉上"列表行 / 工具条 / 搜索框"都对齐了，但"弹层"这一层没有复刻。
2. **官方 `._3nPmjq_input` 的 32px / `bg-layer-1` 没跟**（§23.5-1）：这是本次唯一一处
   属于"官方同页有明确取值、我们**故意**没跟"的地方，代价是与官方那张页面的输入框
   差 2px 高度、底色差一层。
3. **没有 hover / 选中态的自定义样式**：官方候选行本身就没有（只有 `cursor:pointer`），
   所以这一条是"照抄官方 = 什么都不加"；但观感上"鼠标划过没有反馈"，
   将来若要加，得先决定用哪个 token 表达"选中"（官方在这一页没有给）。
4. **`group · apiMode` 这行小字是我给的位置**：官方 `.editorRoute` 放的是 provider 的
   注册路由（如 `anthropic-messages`），我们没有那个字段，用 `group · apiMode` 顶上；
   语义相近但**不是同一个东西**。
5. **窄屏（375px）下这张卡片没有专门用例**：`layout.test.mjs` 7.3 管的是"设置弹窗不横向
   溢出"（两条 87 字符长路径），厂商卡片在 375px / 520px 下只是被它**顺带覆盖**
   （弹窗 `scrollWidth ≤ clientWidth`），没有针对卡片的窄屏断言。
6. **本插件加的防溢出偏离**（官方没有，都是为了让长厂商名 / 长模型名不撑破卡片）：
   `.rowIdentity` 多一条 `overflow:hidden`、`.rowName` 多一组
   `overflow:hidden;text-overflow:ellipsis;white-space:nowrap`（官方只在父级写 `min-width:0`）；
   编辑块标头 / 模型区块标头 / 编辑块动作行这三处加了 `flexWrap:'wrap'`（官方都不换行）。
   列表行那组 `white-space:nowrap + text-overflow:ellipsis` 是官方 `.candidateId` 本来就有的。
7. **「拉取模型」现在是官方的 `linkButton`（tertiary 文字色、无描边），比改造前那枚描边按钮
   在视觉上"轻"**：这是官方「获取模型」的真实档位（§23.1），位置也照搬（模型区块标题行右侧）。
   若用户更看重"显眼"而不是"和官方一致"，把它换成 `Btn`（描边、`Button.sm`）是一行的事 ——
   本次按"与官方一致"取，如实标出这处取舍。

---

## 24. 修正 §23 的两条偏差 + 可搜索下拉（2026-10-12）

用户要求三件事：① 把上一轮记的偏差 ②（输入字段尺寸/底色）与 ③（模型列表滚动上限）
**按官方值改掉**；② 把「默认值 → 模型」下拉做成**可搜索**且**弹层不再被遮挡**；
③ 连带的断言与反向变异。约束：只动 `client/client.js` + 测试 + 文档，不动 `src/**`。

### 24.1 官方取值的确切出处（都在 app.asar 内联 CSS 里核过原文）

官方那一页 = `dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`
（`tools/asar.mjs read` 取出的副本与仓库里 `.probe/models-client.js` 逐字节一致；
下面行号即该文件行号，CSS 全在 `:58` 那一行内联串里）：

| 位置 | 规则原文 | 出处 |
|---|---|---|
| **本页输入字段** | `._3nPmjq_input{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);width:100%;**height:32px**;font:inherit;**background:var(--dsw-alias-bg-layer-1)**;color:var(--dsw-alias-label-primary);padding:0 10px;font-size:14px;line-height:22px}` | `.probe/models-css-pretty.txt:73`（同一行 CSS 里的规则；`:58` 是那一行的宿主） |
| 本页 `<select>` | `select._3nPmjq_input{cursor:pointer;max-width:240px}` —— **同一个类** | `:74` |
| 标记结构（三个字段） | `:1295` / `:1319` / `:1336` 的 `className = input`（Base URL / Gemini 原生 URL / API Key）；`:2288` 的 `input + selectInput` | 同文件 |
| **候选列表上限** | `._3nPmjq_candidateList{flex-direction:column;gap:2px;**max-height:320px**;margin:0;padding:0;list-style:none;display:flex;overflow-y:auto}` | `.probe/models-css-pretty.txt:88` |
| 对照：`settings-form` 的 `.input` | `primitives/lib/settings-form/fields.module.css:108-115` → `height:34px;padding:0 12px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l4);font-size:13px;line-height:1.5`（`bg-layer-3`） | 不在本页私有类里 |

**关键区分**（上一轮偏差 ② 就是在这里判断错了方向）：官方**同一页里两个类并存** ——
`._3nPmjq_input` 是这一页私有的（32px / `bg-layer-1`），`settings-form` 的 `.input`
是跨页面共享的（34px / `bg-layer-3`）。"与官方一致"要按**控件属于哪一类**对齐，
不是"全站统一到共享那一个"。

### 24.2 改了哪些处（client/client.js）

| # | 改动 | 位置 |
|---|---|---|
| 1 | `S` 新增 `modelsInput{Height:32px,Pad:'0 10px',FontSize:14px,LineHeight:22px}` | `S` 表内 |
| 2 | 新增 `modelsPageInputStyle`（32px / `0 10px` / 14px-22px / `bg-layer-1` / `border-l4` / `radius-md`） | 紧随 `inputStyle` |
| 3 | 厂商卡片的**三个输入字段**（Base URL / Gemini 原生 URL / API Key）改用 `modelsPageInputStyle` | 厂商卡片编辑块 |
| 4 | 自绘下拉触发器 `S.selectHeight` `36px→32px`、`selectPad` `0 14px→0 10px`，底色 `bg-layer-3→bg-layer-1` | `SelectField` |
| 5 | `S.modelScrollMaxHeight` `240px→320px` | `S` 表内 + `ModelPickerPanel` |

**没有一起改的**（仍属 `settings-form` 那一类，任务书明确警告不要动）：
`inputStyle` 本身（34px / `bg-layer-3`）——「作品库导出路径」文本框、作品库工具条的
排序下拉、提示词降级文本域都还挂着它；搜索框（36px / `bg-layer-1`）也没动。

### 24.3 按官方值**更新**的既有断言（逐条，附官方取值依据）

> 更新断言 ≠ 放宽断言：每一条都是"把期望值从旧实现抄来的数改成官方原文的数"，
> 判据形式（等于/不等于/上限/内部滚动）一条都没削弱。

| # | 文件:断言 | 改动 | 官方依据 |
|---|---|---|---|
| 1 | `test/client-settings-dom.test.mjs`「列表必须放在 max-height: 240px 的滚动容器里」 | `240px → 320px`（断言形式不变：`style.maxHeight === '320px'` + `overflowY === 'auto'`） | `._3nPmjq_candidateList{max-height:320px}`（`models-css-pretty.txt:88`） |
| 2 | `test/browser/vendors.test.mjs` `OFFICIAL_MODEL_ROW.listMaxHeight` | `'240px' → '320px'` | 同上 |
| 3 | `test/browser/sizes.test.mjs` 1.1（`fieldExpectation` 的 `textInput` / `passwordInput` / `select`） | `OFFICIAL_FIELD`（34px / `0 12px` / 13px / 19.5px）→ 新增的 `OFFICIAL_MODELS_INPUT`（**32px / `0 10px` / 14px / 22px**）；`OFFICIAL_SELECT`（36px / `0 14px`）整块删掉 —— 它引用的是官方**「权限」页**的 `.selector`，不是本页 | `._3nPmjq_input{height:32px;padding:0 10px;font-size:14px;line-height:22px}`（`:73`）；`select._3nPmjq_input`（`:74`） |
| 4 | `test/browser/sizes.test.mjs` 1.1 的**触发器无描边**那一半 | 键名 `expectNoBorder` → `expectNoBorderForTrigger`，并且只在 `where === 'select'` 时生效（文本框照旧判 0.5px 描边） | 触发器形态沿用 `.selector{border:none}`；官方本页 `<select>` 有描边，但我们画的是"触发器 + 弹层"，这一半属**已知的形态差异**（§24.6-①） |
| 5 | `test/browser/theme.test.mjs` 8.9 | 判据从"底色 == `bg-layer-3`"改成**按控件分类判层**（每条 `CONTROLS` 带 `layer`）：`input.text` / `input.password` / `select` → **`bg-layer-1`**；`input.exportDir` / `textarea.prompt` → `bg-layer-3`。反证从 2 层扩到 3 层（`bg-base` / 相邻的另一层 / 卡片层都不得相等）；深色"互不相同"前提从 3 层扩到 **4 层**；`input.text` 的选择器从 `.pxm-settings input[type="text"]`（会命中页面最后一枚 = 导出路径那一枚）改成 `#pxm-provider-base-url`，`select` 改成 `#pxm-defaults-provider` —— **钉住具体那一枚**，不再依赖实现顺序 | `._3nPmjq_input{background:var(--dsw-alias-bg-layer-1)}`（`:73`）；`settings-form` `.input` 仍是 `bg-layer-3` |
| 6 | `test/browser/lane.js` 的 `selectFacts(labelText)` | 字段标签从**子串**匹配改成**精确**匹配：字段多了之后「厂商」的说明里含"模型"二字，子串匹配会静默选错行（实测：按 `模型` 找拿到的是「厂商」那一行，长列表用例全红） | 不是断言，是探针的定位纪律 |

**净新增/删除的用例数**：`pnpm test` 仍 **323**（只有 1 处的期望值变化，`it` 数量不变）；
`pnpm test:browser` **49 → 56**（+7，全部在 `controls.test.mjs` 第 4 组）。

### 24.4 弹层**被什么裁掉**：证据与选定的修法

**先查明**（不是猜）：用 lane 新增的 `clipChain()` 探针从弹层往上逐个祖先看
`overflow-x/y` 与"弹层是否越出它的 padding box"，在**会裁的场景**（1280×480、不滚动、
「尺寸」触发器 top 346 / bottom 378）下实测：

```
clipper: {"tag":"DIV","id":"settingsDialog","className":"","overflowX":"auto","overflowY":"auto",
          "rect":{"top":40,"left":0,"right":1280,"bottom":480,...},"overflowsY":true,"clips":true}
祖先链：span.pxm-select(visible) → div(visible) → div.card(visible) → div(visible) →
        div(visible) → div.pxm-settings(visible) → #host:settings.section(display:contents) →
        #settingsAnchor(display:contents) → #settingsDialog(auto/auto, **clips**) → body(hidden)
```

即：**裁它的是设置弹窗自己**（lane 的 `#settingsDialog{overflow:auto}`；真实 shell 是
`SettingsRoot` 的 `.wCInkW_options{overflow-y:auto}`，`client.js` 里 `skin.wrap` 的注释
早就写着"设置页的滚动由设置弹窗自己负责"）。插件自己的 `.pxm-settings` 与卡片全是
`visible` —— 所以**不能靠"让某个祖先别裁"修**（那是 shell 的容器，不是我们的）。

**选定的修法**：**(a) `position: fixed` + 自身翻转 / 夹取**（不是 portal，也不是调小
`max-height`）。理由三条：

1. **不动 DOM 结构**：portal 会把弹层移出字段子树，而
   - 「点外部关闭」靠 `listRef.contains(target)`（跨树仍可用，但要多一个 ref 与一处特判）；
   - `selectFacts` 探针在 `field.querySelector('[data-pxm-select-list]')` 里找弹层；
   - 更硬的理由：React 18 的合成事件走**根容器委托**，手工 append 到 `body` 的节点不在
     根容器里 ⇒ 选项上的 `onClick` 会失效（要额外挂原生监听器打补丁，更脆）。
2. **`fixed` 本身就能脱离祖先裁切**：只有祖先带 `transform`/`filter`/`contain`
   才会为 fixed 建立包含块 —— 本插件与官方 shell 都不这么写（已核对祖先链）。
3. **调 `max-height` 不算修**：内容矮时（3 项的弹层自然高 116px）高度上限根本不起作用，
   被裁是**位置**的问题；而且"下方只有 66px"时把上限调到 66 会让列表只剩两行。

实现要点（都在内联样式里，浏览器 lane 直接断言 `rect`）：

- 打开时 `getBoundingClientRect()` 量触发器 → `spaceAbove` / `spaceBelow`（各留 8px 视口边距）
  → 向下优先，下方真的不够才翻上；高度上限 = `min(可用空间, 320)`（带搜索框时内容上限放宽到
  360 = 320 列表 + 36 外壳），下限 44px（宁可略溢出也不给"看不见内容"的盒子）。
- **用"贴住触发器的那一条边"定位**（向上钉 `bottom`、向下钉 `top`），不是
  "算好高度再 `top = triggerTop − 4 − maxHeight`"。后者在**内容比上限矮**时会把弹层
  一头栽到视口顶部：实测 3 项的弹层自然高 116px，而算出来的 `top = 346 − 4 − 320 = 22`，
  于是它停在 22 而不是紧贴触发器（334）—— 这是本次实现里踩到并修掉的一个真 bug。
- 左右夹取：`left = clamp(triggerLeft, 8, innerWidth − width − 8)`，宽度跟触发器一致
  （原生 `<select>` 的弹层也是这个宽）；`max-width` 再挡一层。
- 弹层**自身** `overflow:hidden` + 内层 `.pxm-select-scroll{overflowY:auto;maxHeight:320px}`：
  滚动只发生在内层 ⇒ 搜索框不会被滚走；高亮项 `scrollIntoView({block:'nearest'})` ⇒
  选中项不会被滚出视野。
- 跟随一次 `resize` / `scroll`（`capture:true` 才收得到任意滚动容器），另外在下一帧
  `requestAnimationFrame` **再量一次** —— 因为 `focus()` 引起的"滚动到可见"不一定派发
  `scroll` 事件（实测设置弹窗 `scrollTop` 从 0 变到 36 而弹层还停在按滚动前的位置）。

### 24.5 可搜索下拉：交互与适用范围

- **触发条件**：`props.searchable === true || options.length > 8`（阈值 **8**）。
  依据：官方给候选列表配搜索框的那一页列表动辄几十上百项；而本插件另外两枚下拉
  （厂商 3 家、尺寸 6~8 个）在 8 项以内一屏就能看全 —— 多一个搜索框只会让弹层更高、
  还多一次 Tab。所以**不是**全站统一启用，短列表保持"纯 ↑↓"的原形态。
  注意阈值判定用的是**选项总数**而不是可见项数：用可见项数的话，"打开 16 项 → 打 `flux`
  → 结果剩 2 项"会把搜索框自己抽掉（连同用户刚输入的内容），实测过这个形态。
- **过滤**：`label` / `value` 的**大小写不敏感子串**匹配；`↑↓` 在**过滤结果**内循环
  （落点换算回原数组下标，所以 ✓ / `aria-checked` / `Enter` 口径都不变）；`Home` / `End`
  到过滤结果首尾；`Enter` 选中并写回触发器（与原生 `<select>` 的 `onChange` 同形）。
- **键入选字**：打开后焦点落在**列表容器**上（长列表形态），打一个可打印字符立即把焦点
  转到搜索框并追加该字符（`Backspace` 同理）—— 不然用户要先 Tab 一次才够得着搜索框。
  短列表（无搜索框）形态保持改造前行为：焦点直接落在**当前项**上。
- **清空**：搜索框右侧的 `×`（手写 SVG `close`）只在有内容时出现，点它清空并把焦点交回搜索框。
- **空态**：过滤无结果时给出可读文案「没有匹配的选项」（`data-pxm-select-empty`），
  此时 `Esc` / 点外部照常关闭，`Enter` 不做任何事（不会写坏值）。
- **关闭**：`Esc`（焦点交回触发器）/ 点弹层外部 / 选中后关闭；三者都不改动未确认的值。
- **当前项仍打 ✓** + `aria-checked="true"`（与改造前一致）。

### 24.6 新增断言（`test/browser/controls.test.mjs` 第 4 组，7 条）与反向变异

| 用例 | 钉住什么 |
|---|---|
| **4.1** | 16 项长列表的弹层**有**搜索框（且初始为空、有 placeholder、无「清空」）；3 项短列表**没有** |
| **4.2** | 输入即过滤：选项变少且只含匹配项（含"小写 `gpt` 命中 `Gpt-Image-1`"这条大小写不敏感的证据）；「清空」恢复全量 |
| **4.3** | `↑↓` 只在**过滤结果**内移动（判据 = `data-pxm-state="active"` 的下标）；`Enter` 选中写回触发器 |
| **4.4** | 直接在容器上打字就进搜索框（焦点转移）；无结果显示可读空态；空态下 `Enter` 不关弹层 |
| **4.5** | **会裁的场景**（1280×480 不滚动，下方只剩 98px）：弹层完整在视口内 + 翻到触发器上方 + 高度不小于 116px（3 项能看全） |
| **4.6** | 长列表 + 矮窗口：完整可见、高度 = `min(可用空间, 320)`、宽度跟触发器、内层可滚；过滤后仍可见；**窗口缩到 420px 宽**后仍夹在视口内 |
| **4.7** | `Esc` / 点外部关闭，且都不改动已选值 |

**反向变异**（`tools/lane-mutations.mjs`，新增 3 条，全部 ✔ —— 脚本自证"仓库原产物
sha256 前后一致"）：

| 变异 | 改坏什么 | 抓住它的用例 | 真实报错（首条断言消息） |
|---|---|---|---|
| `M41-no-select-search` | 搜索框的渲染条件 `enableSearch → false`（长列表退化成纯 ↑↓） | 4.1 / 4.2 / 4.3 / 4.4 / 4.6 | `4.1`：`16 项的长列表必须有搜索框：null`；`4.2`/`4.3`：`page.fill: Timeout 30000ms exceeded.`；`4.4`：`Cannot read properties of null (reading 'value')`；`4.6`：`16 项必须带搜索框` |
| `M42-select-list-clipped` | 弹层退回 `position:absolute` + `left:0`（不再固定/翻转/夹取） | 4.5 / 4.6 | `4.5`：`弹层底边不许超出视口：{"list":{"top":382,...,"bottom":498,...},"viewport":{"width":1280,"height":480,...}}`；`4.6`：`弹层高度不得超过 min(可用空间 257px, 官方上限 320px)：{"top":161,...,"height":311}` |
| `M43-models-input-old-34px` | 模型页输入控件退回 34px / `bg-layer-3` | 1.1（`sizes`）/ 8.9（`theme`） | `1.1`：`设置页 textInput 的尺寸与官方「模型」页本页的 ._3nPmjq_input 不一致：`（高度 34 ≠ 32）；`8.9`：`深色：input.text 的底色是 bg-layer-3（rgb(53, 54, 56)，源码挂在 modelsPageInputStyle.background）。官方同类控件用的是 --dsw-alias-bg-layer-1` |
| `M41` 的连带失败 | — | — | 没有搜索框 ⇒ 4.2 / 4.3 连"往搜索框里写字"这一步都做不到（`page.fill` 超时），如实记下而不是当成噪声 |

**被这次改造影响、锚点/期望一并更新的既有变异**（不是放宽，是"被它覆盖的对象变了"）：

| 变异 | 为什么必须改 | 改成了什么 |
|---|---|---|
| `M20-input-surface-is-bg-base` | 设置页的输入控件已从 `inputStyle`（`bg-layer-3`）改挂 `modelsPageInputStyle`（`bg-layer-1`）；8.9 现在是"按控件分类判层"，只有动**这一类**才会走到"最近色命中 `bg-layer-1`"那条断言上 | 锚点改成 `modelsPageInputStyle` 的 `background: T.bgLayer1`，`expect` 换成 8.9 的新用例名。**判据强度不变**（它现在证的是"模型页那一层不是 bg-base"） |
| `M21-input-surface-is-bg-layer-2` | 同上；这一条专证 8.9 里"**不等于** `bg-layer-2`"不是空转（`bg-layer-2` 与 `bg-layer-1` 深色只差一档） | 同上 |
| `M22-input-height-old` | `S.fieldHeight` 现在只剩作品库工具条的**排序下拉**这一处消费方（设置页的文本框 / 下拉已改挂 `modelsPageInputStyle` 的 32px） | `expect` 从 `sizes 1.1`（设置页）改成 **`2.1`（作品库）**；断言本身一字未动。设置页那一半现在由 `M43` 盯着 |
| `M27-no-select-chevron` | chevron 之后紧跟的不再是 `open ? …` 三元，而是 `),` + 弹层注释（弹层改成 `const popup`） | 第二处 `find` 的收尾锚点改成那一行注释 |
| `M28-no-select-list` | 弹层从"内联三元"改成 `open ? popup : null` | `find` 改成那一行，`replace` 改成 `null,` |
| `M26-radius-hardcoded` | 弹层不再用 `S.radiusLg`（卡片那处仍在） | 锚点不变，只补一句说明 |

### 24.7 结果

`pnpm verify`（`typecheck + build + test + test:browser`）：**323 + 56**，全绿。
`pnpm test` **323 → 323**（基准不变）；`pnpm test:browser` **49 → 56**（+7）。
`node tools/lane-mutations.mjs` 基线 `pass=56 fail=0`；`M41` / `M42` / `M43` 全 ✔，
既有 40 条（含 1 条信息性 `M12`）在锚点更新后同样全部 ✔。

### 24.8 没做到 / 没把握（诚实记录）

1. **极端窄/矮窗口下"完整可见"与"看得见内容"会冲突**：弹层高度有一个 44px 的下限
   （约一行 + 内边距），当两侧可用空间都小于 44px 时会**略微溢出视口**而不是缩成一条缝。
   当前用例覆盖到 420×480，更极端（例如 320×200）没有断言 —— 那时的行为是"可能溢出 20~40px"，
   这是**已知取舍**，不是没测出来。
2. **翻转只在"下方真不够"时发生**：判据是"可用空间"而不是"内容高度"（内容高度由浏览器
   排版给出，量它要多一次 layout pass）。所以理论上存在"下方够 320px、内容只有 116px，
   但用户更希望它向上"的场景 —— 这不影响正确性（都在视口内），只是位置偏好。
3. **`.pxm-select-list` 的推断宽度**：弹层宽度严格等于触发器宽度（原生 `<select>` 的弹层
   也是这个宽）。官方 `Menu` 有 `min-width:144px / max-width:360px` 两条，**我们没有跟** ——
   跟了就会在窄面板里溢出或与触发器错位；`S.menuMinWidth` / `S.menuMaxWidth` 因此成为
   无引用的常量（保留作为文档，未删）。
4. **搜索是纯前端过滤**：不参与插件的服务端搜索，也不改变"已选"语义（选择仍然是
   `SelectField` 的单值语义）。过滤结果为空时**保留**已经选中的值（不清空），这一点没有
   专门用例（4.4 只断言"Enter 不写坏值"）。
5. **没有做键盘的"高亮项自动滚入视野"断言**：实现里有 `scrollIntoView({block:'nearest'})`，
   但用例只断言"选中项（带 ✓ 的那一项）在可视滚动区内"（4.5-③），没有断言"连续 ↓ 到底部时
   高亮项跟着滚" —— 后者需要一个更长的夹具与逐帧断言，本次没做。
6. **`M42` 变异里宽度与定位是"一并退回旧形态"的**：单看不能证明"宽度夹取"这一条独立有效
   （4.6 里那条 `listRect.width == triggerRect.width` 在 `M42` 下也会红，但与位置那条混在一起）。
   如实记录：宽度那一条目前没有**单独**的反向变异。

---

## 25. 新增厂商 Agnes AI：`dialect: 'agnes'`（2026-10-12）

**关键前提：我们没有 Agnes 的 API Key。** 本节记录的全是**离线可取证的契约**，
**没有任何一条来自真实出图**。凡属"只能在拿到 Key 后验证"的，一律在 §25.5 列清，不混进结论。

### 25.1 取证表

参考项目 `E:\Programs\trae\project\pixmart-ai` **只读**引用；官方文档走
`https://agnes-ai.com/doc/常用接入文档` → 该页 302 到 Mintlify 站（`www.agnes-ai.com/zh-Hans/docs/...`），
`web_fetch` 不跟随跨域跳转，故按文档索引取到实际页面并**以索引页给出的原生页面为准**：
[Agnes Image 2.1 Flash](https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash.md)
（索引：[llms.txt](https://wiki.agnes-ai.com/llms.txt)、[agnes-30-flash](https://agnes-ai.com/zh-Hans/docs/agnes-30-flash.md)）。

| 项 | 结论 | 出处 |
|---|---|---|
| base URL | `https://apihub.agnes-ai.com/v1` | 官方文档「Integration Checklist」；对照 `pixmart-ai/src/renderer/src/types/model.ts:142-146`（该处写的是 `api.agnes-ai.cn/v1`，见 §25.2①） |
| API base | `POST {base}/images/generations`；**图生图同端点**，无独立 `/images/edits` | 官方文档 Endpoint 小节；`pixmart-ai/src/main/services/openai.ts:552-560` 走 `client.images.generate`（即 `/v1/images/generations`） |
| 鉴权 | `Authorization: Bearer <key>` | 官方文档 Headers 小节；`pixmart-ai/src/main/services/openai.ts:250-251`（OpenAI SDK `apiKey`） |
| 请求体 | **JSON**（非 multipart），`Content-Type: application/json` | 官方文档全部 curl 示例；`openai.ts:552-560` |
| 参考图字段 | **`extra_body.image`**（字符串数组，公网 URL **或** `data:image/...;base64,`；多张=多图合成） | 官方文档「Image-to-image」「Multi-image Composition」「Data URI Base64 Input」；`openai.ts:557-558`（`extra_body.image`） |
| 输出格式字段 | **`extra_body.response_format`**，值 `url` / `b64_json`。官方 **Warning 明文：不要放到顶层**（顶层会报错） | 官方文档「Common Errors → Top-level response_format causes errors」；`openai.ts:559`（`response_format` 放在 `extra_body` 内） |
| `responseModalities` | **不需要**（Agnes 无 Gemini 原生协议） | 官方文档无此字段；与 Ofox 的 gemini-native 不同 |
| 尺寸 | `size` = **档位** `1K`/`2K`/`3K`/`4K`（官方标 **必填**，建议与 `ratio` 同用）+ `ratio` = `1:1`/`3:4`/`4:3`/`16:9`/`9:16`/`2:3`/`3:2`/`21:9`（默认 `1:1`）。像素值（如 `1024x768`）"也接受但可能被归一化" | 官方文档「Request Parameters」「Size and Ratio」「Output Dimension Reference」；`openai.ts:554-555`（`size:'1K'` + `ratio`） |
| 响应形状 | `{ created, data: [{ url, b64_json, revised_prompt }] }`，**二选一**：url 模式下 `b64_json` 为 `null`，base64 模式下 `url` 为 `null`；另可用顶层 `return_base64: true` 要 base64 | 官方文档「Response Format」两个 Tab + Response Fields 表 |
| 模型 id | 生图：`agnes-image-2.1-flash`（官方正文）、`agnes-image-2.0-flash` / `agnes-image-2.5-flash`（文档索引）；文本：`agnes-3.0-flash`（官方正文）、`agnes-2.0-flash`（`openai.ts:297` 兜底） | 官方文档标题/模型小节；`openai.ts:56`（`FALLBACK_MODELS.agnes`） |
| `/models` | **官方文档未记载**。参考项目用 `client.models.list()` 做「测试连接」（`openai.ts:1594`）与「拉取模型」（`openai.ts:1607`），但那是 OpenAI SDK 的常规调用，**不等于 Agnes 真的实现该路由** | 官方文档全站无 List Models 页；`openai.ts:1594,1607` |

### 25.2 参考项目与官方文档的冲突点（**逐条列出，不调和**）

1. **base URL 不同**：参考项目 `https://api.agnes-ai.cn/v1`（`types/model.ts:144`）
   vs 官方 `https://apihub.agnes-ai.com/v1`（官方 Integration Checklist）。
   **未解决**：两者域名、TLD 都不同，无法判断是"同一服务的两个入口"还是"参考项目过时"。
   本次**采用官方文档值**（`apihub.agnes-ai.com`），并在设置页允许用户自行改成 `.cn` 入口。
2. **`image` 的层级，官方文档内部自相矛盾**：Request Parameters **表**把 `image` 列为**顶层**参数，
   而全部 curl 示例、Image-to-image / Multi-image / Data URI 三个示例、以及
   "Missing image parameter" 排错条目都把它放在 **`extra_body.image`**。
   参考项目与示例一致（`openai.ts:557-558`）。**本次采用 `extra_body.image`**（跟示例走）。
   风险已记入 §25.5：若真实服务只认顶层，图生图会静默丢参考图。
3. **`responseModalities`**：官方文档**没有**这个字段，参考项目也不传。
   与我们在 Ofox/gemini-native 上踩到的坑（缺它则整体忽略 `generationConfig`，§11.1）**无关**——
   Agnes 不是 Gemini 原生协议，所以这条**不是冲突，是不同协议**；列在这里只为避免被误套。
4. **`/models`**：参考项目把它当既有能力用（`openai.ts:1594,1607`），官方文档完全没提。
   **不做调和**：我们按"可能不存在"实现——失败时给可读原因，不假装成功（§25.3④）。
5. **尺寸写法**：参考项目固定发 `size:'1K'` + `ratio`（`openai.ts:554-555`），
   官方文档主推"档位 + ratio"，但其部分示例用的是像素（`size: "1024x768"`）。
   两者都"被接受"，但语义不同（示例的像素会被服务端归一化）。
   **本次跟参考项目**：固定档位 `1K` + 归一化后的比例，输出尺寸才可预期。

### 25.3 映射决策：**新增 `dialect: 'agnes'`**（复用 `apiMode: 'images-generations'`）

**为什么不复用现有方言**：
- `standard` 把 `image` / `response_format` 放在**顶层**；Agnes 官方明文顶层 `response_format` **会报错**，
  参考图放顶层则**不被采用**。硬套 `standard` = 运行时静默失败（正是要避免的那类）。
- `ofox` 用 `input_images` + `output_format`（像素 `size`），字段名与尺寸语义**都不对**。

**为什么不需要新 `apiMode`**：端点、方法、请求体类型（JSON）与鉴权头都和
`images-generations` 一致，差异**只在字段名与字段位置**——这正是 `dialect` 的定义（见 `src/config.ts` 的 `Dialect` 注释）。
于是新增 `Dialect = 'standard' | 'ofox' | 'agnes'`，在适配器里加三条分支：

1. **请求体**（`src/vendor/openai-compat.ts`，`buildRequest` 的 agnes 分支）：
   `{ model, prompt, size: '1K', ratio, extra_body: { image?, response_format: 'url' } }`。
   **不发 `n`**（官方参数表无此字段）、**不发 `quality`**。
2. **降级链**（`variantChain`）：agnes 链上**剔除** `quality` 档与"去掉 size"档——
   `quality` 是厂商不认的参数，`size` 是必填；两档都只是白花一次请求的钱。
   带参考图时恰好三档：`full` → 去掉 `response_format` → 再去掉参考图（与标准链同序）。
3. **尺寸归一化**（`src/sizes.ts` 的 `requiredKind`）：agnes 方言下归一化成**比例**而不是像素
   （`3:4` 保持 `3:4`、`1024x1024` → `1:1`、`1280x960` → `4:3`），再由适配器拼成"档位 + 比例"。
   `provider.allowedSizes` 用官方那 8 种比例。
4. **缺 `size` 不构造请求**（`generateImages` 前置检查）：直接返回结构化 `config` 错误并指向
   `pixmart_check_size`，`attempts: 0`——官方把 `size` 标为必填，发出去只会换回一个 400。

**响应解析无需改动**：官方 `data[].url` / `data[].b64_json` 与既有 `extractImageHandles`
的 `images-generations` 分支形状一致（`null` 值会被当作"没有"从而回落到另一支）。

### 25.4 新增断言（`test/agnes.test.mjs`，19 条，**零真实网络**）

全部针对 `lib/` 产物、只打本文件起的本地 http 服务器：

1. **预设**（6 条）：出厂 `providers` = `['ofox','agnes']` 且 `defaults.provider` 仍是 `ofox`、
   `apiKey` 为空、`dialect`/`apiMode`/`baseUrl`/`apiKeyEnv` 齐全、`Bearer` 下 `resolveApiKey` 出厂无密钥、
   `parseConfig` 能解析回 `dialect:'agnes'`（枚举合法）、路由表对带参考图的 agnes 模型仍走
   `images-generations`、尺寸归一化成**比例**（并与 `standard` 方言的像素结果对照）、不支持比例给最近邻。
2. **请求构造**（5 条）：端点 `/v1/images/generations`、`Authorization: Bearer`、
   `size:'1K'` + `ratio:'3:4'`、`extra_body.response_format='url'`、**顶层 `response_format` 必须为 `undefined`**、
   **顶层 `image` 必须为 `undefined`**、`n`/`quality` 不出现、图生图**不走** `/images/edits`、
   多张参考图按序全进 `extra_body.image`、像素尺寸折算成受支持比例、`standard` 方言未被带偏。
3. **响应解析**（3 条）：url 形状（真的下载了远程产物，字节与魔数都对）、
   base64 形状（`url: null` 不影响判定，且**没有**多余下载）、无图片时是结构化 `bad_response`。
4. **错误分支**（5 条）：401 → `auth` 且只发一次、不降级；缺 `size` → `config` 且**零请求**；
   400 → 三档降级且**任何一档都不含 `quality`、都带 `size`**；无 `/models` → `bad_response` +
   `HTTP 404` 可读文案（探测确实打了 `/v1/models` 且带 Bearer）；无密钥 → `no_api_key` 且零请求。

**反向变异**（`.probe/agnes-mutations.mjs`，3 条，全部 ✔ = 断言真的会红）：
① 把 `response_format` 移到顶层；② 把参考图放到顶层 `image`；③ 让 agnes 的尺寸归一化回像素。

### 25.5 拿到 Key 之后**才能**验证的清单（本节的结论都不覆盖这些）

1. **真实出图**：`agnes-image-2.1-flash` 是否真能出图、耗时是否落在官方建议的 60–360s 内。
2. **base URL 到底是哪个**（§25.2①）：`apihub.agnes-ai.com` 与 `api.agnes-ai.cn` 哪个可用；是否需要二者之一。
3. **`image` 的层级**（§25.2②）：真实服务读的是 `extra_body.image` 还是顶层 `image`。
   若是后者，**图生图会静默丢参考图**——这是本次实现最需要实测的一条。
4. **`size` 是否真的必填**：我们据此做了"缺 size 直接失败"的前置检查（宁可不发也不猜）。
5. **`size:'1K'` + `ratio` 的真实回传尺寸**：是否等于官方「Output Dimension Reference」表里的
   `1:1 → 1024x1024` / `3:4 → 864x1152` / `16:9 → 1312x736` 等。
   注意官方 `16:9` 的 1K 是 **1312x736**（不是 1280x720），我们**没有**在任何地方断言这个像素值。
6. **`/models` 是否存在**：现在"拉取模型"在 Agnes 上预期失败（HTTP 404 可读原因）。
   若实际存在，应把探测结果接进设置页；若不存在，README 已写明这是可接受结论。
7. **`n` 的行为**：我们不发 `n`，多张靠多次调用。若 Agnes 支持 `n`，可省一半请求（尚未验证）。
8. **`extra_body` 是否真是 LiteLLM 语义**：参考项目 base URL 指向 `apihub`（形似 LiteLLM 代理），
   `extra_body` 很可能是代理层的"透传字段"；若是直连原生服务，该字段语义可能不同。**没把握**。
9. **`return_base64: true`**（官方文本生图专用）：我们没实现该分支，只走 `extra_body.response_format`。
10. **多图合成**：我们只按文档发了 `extra_body.image` 数组，未验证服务端是否按序理解多图角色。

## 26. 设计缺口修复：出厂厂商预设对**已有配置**补齐（2026-10-12）

### 26.1 缺口是什么（实测，不是推测）

- 用户磁盘 `C:\Users\30461\.dsh\pixmart\config.json` 里**只有 ofox 一个厂商**；
- 代码里 `defaultConfig().providers` 是 `ofox, agnes`（agnes 已实现，见 §25）；
- `ConfigStore.load()` 原本是"文件解析成功即采用**文件内容**"，只有文件缺失/解析失败才回落
  `defaultConfig()`。

→ 后果：**新增的厂商预设对已有安装永远不可见**（agnes 就是这样，用户在设置页里根本看不到它）。
这不是 agnes 的特例——**以后每加一个厂商都会重现**。根因是"以文件为准"这条正确规则缺少
一个"补齐出厂预设"的收尾步骤。

### 26.2 修法：`load()` 的最后一步做预设补齐（只补缺的、只改内存）

`src/config.ts` 新增两个纯函数，`ConfigStore.load()` 在 `parseConfig` **之后**调用：

| 函数 | 职责 |
|---|---|
| `applyFactoryPresets(config, factory = defaultConfig())` | 把 `factory.providers` 里**文件没有的 id** 追加到 `providers` 末尾；返回 `{ config, added }`。`added` 为空时**原样返回入参对象**（一个字段都没动） |
| `factoryPresetWarning(added)` | 生成告警文案（见 §26.5） |

四条规则（顺序即优先级）：

1. **文件为准**：已存在的 id 一个字段都不碰。用户填的 `baseUrl` / `apiKey` / `models` /
   `extraHeaders` / `timeoutMs` 逐字节保持原样，**哪怕它和出厂预设已经不同**——那正是用户的选择；
2. **只追加缺的**：用出厂预设对象补，`apiKey` 为空（"尚未配置"状态）；追加在**末尾**，
   文件里的厂商顺序与 `providers[0]` 不变；
3. **`defaults` / `limits` / 其它字段完全不动**（原样引用文件解析结果），尤其
   `defaults.provider` 仍是文件里的值——补齐厂商**不会**顺带改默认厂商；
4. **不改写磁盘**：补齐是纯函数 + 内存赋值，`load()` 不做任何写盘。文件只在用户后续通过
   设置页保存时才落盘。

补齐走**既有告警通道**（`ConfigStore.load().warnings` → `runtime.configWarnings()` →
`GET api/providers` 的 `warnings` 字段与 `pixmart_providers` 工具），**不静默**。
缺失文件与损坏文件两条分支**不需要**补齐：它们本来就返回 `defaultConfig()`。

**幂等**：每次 `load()` 都从文件重新解析再补，所以连续两次 load 的厂商集合完全一致
（`added` 第二次仍是同一批，因为没有写盘，文件里始终没有那个 id）。

### 26.3 新增断言（`test/factory-presets.test.mjs`，7 条，**零网络**）

走**真实** `ConfigStore` + 真实临时目录（针对 `lib/` 产物），夹具就是实测的用户文件形状
（只有 ofox、自定 `models`、被用户清空的 `apiKeyEnv`、改过的 `limits`、哨兵密钥）：

1. 只有 ofox 的文件 → load 后出现 agnes（`apiKey` 为空、`dialect`/`baseUrl`/`models` 齐全），
   且 **ofox 的 JSON 序列化与种下的那份逐字节相同**（含哨兵密钥、空 `apiKeyEnv`、
   自定 models、`extraHeaders`、`timeoutMs`）；补齐项在末尾、`providers[0]` 仍是 ofox；
2. `defaults` 与 `limits` **深比较相等**（`defaults.provider` 仍是 `ofox`，
   `maxConcurrency: 3` / `retentionDays: 30` 没被工厂值顶掉）；
3. **幂等**：load 两次 → id 序列 `deepEqual`、agnes 恰好 1 个、总数 2；
4. **告警可见**：文案精确等于 §26.5 那句；
5. **盘上未改写**：load 前后 `readFileSync` 字符串相等，且盘上的 `providers` 仍只有 ofox；
6. 反面：文件里已有 agnes（带自己的密钥）→ 不重复补、密钥不被清、无补齐告警；
7. 反面：文件缺失 → 无告警（那条路径本来就返回出厂配置）。

### 26.4 已知限制（**明说，不粉饰**）

- **用户在文件里删掉某厂商，下次 `load()` 会被补回来**。因为"补齐"的判据是
  "出厂预设里有、文件里没有"，而我们**刻意不改写磁盘**，所以这个判断每次启动都会重新成立。
  要真正彻底移除，需要**"禁用列表"**（用户显式声明"我不要这个厂商"）或**"添加厂商"UI**
  （把出厂预设降级成"可添加项"）——**本次不做**，记在这里当已知限制。
- 选择这个取舍的理由：不写盘就不会擅自改用户文件，用户手改的 `config.json` 行为可预期
  （与 §16.6 的立场一致）；代价就是上面那条"删了会回来"。
- 另一个可见后果：补齐只改内存，所以**只要用户在设置页保存一次任何字段**，被补入的厂商
  就会跟其它字段一起自然落盘。这正是我们要的（用户看得见、也批准了），但不是"静默落盘"。
- 顺带一行：用户实测文件里 `apiKeyEnv` 已被清空（`""`）。补齐**不碰**已存在厂商，所以
  `OFOX_API_KEY` 环境变量对该用户仍然不生效——这是用户自己的设置，我们不去"修"它。

### 26.5 告警文案原文

```
已从出厂预设补入厂商：agnes（尚未配置密钥）
```

多个厂商同时补入时用顿号连接：`已从出厂预设补入厂商：agnes、xxx（尚未配置密钥）`。

### 26.6 结果

`pnpm verify` 全绿：typecheck + build 通过，宿主 `pnpm test` **349**（原 342 + 新增 7），
浏览器 `pnpm test:browser` **56**（**未调整任何既有断言**）。

---

## 27. 尺寸归一化保真 + Agnes 档位真正接通（2026-10-12）

背景：§25 把 agnes 的「档位 + 比例」写对了，但**档位在中途就丢了**——`checkSize` 把任何
输入都塌缩成比例，`2048x2048` 变成 `1:1`，适配器只能发 `1K`。用户要 2K 静默拿到 1K。
这是"校验说 A、请求发 B"的一类缺陷，和 §18 的 `insufficient_credits` 同类：**看起来成功**。

### 27.1 缺陷的准确形状（先量数据流，再改代码）

改之前实测（`checkSize` 的输出 → 适配器实际发出的字段）：

| 输入 | 改前 `normalized` | 改前请求体 | 问题 |
|---|---|---|---|
| `2048x2048` | `1:1` | `size=1K ratio=1:1` | **档位丢失**（要 2K 给 1K） |
| `2624x1472` | `41:23` → 回落 `1:1` | `size=? ratio=1:1` | 比例也丢（官方 16:9 像素不是精确 16:9） |
| `9999x9999` | `1:1` | `size=1K` | 静默接受离谱输入 |

**教训（本次是踩到之后才补的）**：`allowedSizes` 太窄只是**症状**。第一版改动直接往白名单里
加 32 个像素尺寸，结果把"明确报错"变成了"静默给错"，只好撤回（提交信息里写明了不生效）。
**先跑一次数据流探针、看清中间形状，再动代码**——8 行的探针能省掉一整版返工。

### 27.2 `checkSize` 的新规则：同格式优先（`src/sizes.ts`）

`SizeCapability.kind` 换成 `forms: SizeForm[]`——**请求体能携带的格式，首个为首选**：

| 能力 | forms | 理由 |
|---|---|---|
| Gemini 图像模型 | `['ratio']` | `generationConfig.imageConfig.aspectRatio` 只吃比例 |
| gpt-image / DALL·E 3 | `['pixel']` | 官方只认像素 |
| Agnes 官方尺寸表 | `['ratio','pixel']` | `ratio` 是官方主参数；精确像素用来**表达档位** |
| 厂商配置回退项 | `acceptedForms(apiMode, dialect)` | ofox/standard → 像素；agnes 方言 → 两种 |

判定顺序（**这个顺序就是"保真"的实现**）：

1. **同格式精确命中** → 原样返回声明写法（agnes 下 `2048x2048` 保持 `2048x2048`）；
2. 同格式没精确命中 → 在**该格式内**就近吸附（`snapWithin`）：纵横比偏差 > 3%
   视为不支持（`5:4` 对 agnes 依旧被挡住，不是悄悄给 `4:3`）；像素输入还会跟该比例族的
   **最大**声明尺寸比较，超过就拒绝（`9999x9999` 不会静默变 4K）；
3. 该格式请求体携带不了（ofox 只认像素，输入却是比例）→ 折算到首选格式再比对，
   **旧行为逐字保留**（`3:4` → `960x1280`）。

`nearest` 的排序加了**最长边差距**做次序：`9999x9999` 现在首推 `4096x4096`（同比例最大档），
而不是字典序最小的那个。

**只给档位（`2K`）会被拒绝**，理由：单独一个档位不携带比例信息，替用户默认 `1:1` 属于
"静默替用户做选择"。但错误文案直接给出可用像素（`1024x1024、2048x2048、3072x3072、4096x4096`），
所以这是一步到位的提示，不是死胡同。

### 27.3 Agnes 官方尺寸表搬到 `sizes.ts` 并做成**内置能力**

- `AGNES_SIZE_TABLE`：32 条 `[像素, 档位, 比例]`（8 比例 × 4 档位），出处见 §25 的官方文档；
  适配器与 `check_size` **共用同一张表**（此前 `agnesSizeTier`/`agnesRatio` 是适配器私有，
  校验和发送各算各的，正是"校验说 2K、请求发 1K"的温床）。
- 内置能力条目 `match: /agnes/i` + `dialect: 'agnes'`：**校验不读 `config.json` 的 `allowedSizes`**。
  理由与 §26 同源：`applyFactoryPresets` 只补**缺的厂商**、不改字段，所以"改了出厂预设的
  `allowedSizes`"对老配置毫无作用（agnes 的 baseUrl 就是这么翻过一次车）。放内置表里，
  谁的配置都算数。
- 出厂预设的 `allowedSizes` **刻意只保留 8 个比例**：它同时喂给设置页「默认尺寸」下拉框，
  40 项会把控件撑得很难用；而且比例是不挑厂商的通用写法。
- `agnesSizeSpec()`：表内精确像素 → 表里记的档位与比例（`2624x1472` → `2K` + `16:9`，
  **不能靠化简比例得到 16:9**）；表外像素 → 最近官方比例 + 该比例下最长边最近的档位；
  比例输入 → 官方默认档位 `1K`；`2K` 这类纯档位输入 → 该档位 + 官方默认比例 `1:1`
  （适配器认它，但 `check_size` 会在更早的一步把纯档位挡下，见 27.2）。

### 27.4 顺带修掉：`model_not_found` 是终态，不是可重试的 5xx

agnes 国内站在模型未开通时返回的是 **HTTP 503 + `model_not_found`**
（正文：「分组 default 下模型 `agnes-image-2.0-flash` 无可用渠道（distributor）」）。
`classify()` 原先只按状态码判 5xx → `server` + `retryable: true` → 重试并顺降级链重发
（实测被拒 2 次，每次都是一个请求）。现在新增错误码 **`model_unavailable`**（终态），
并且**先于 `status >= 500` 判定**；`test/agnes.test.mjs` 断言"只发一次 + `degraded` 为空"。

### 27.5 顺带修掉：`listModules: true` 被静默忽略

`pixmart_prompt` 用 `pickString(args,'listModules') === 'true'` 判断，而系统提示里写的是
**布尔** `listModules: true` → 工具照常返回，只是不给清单。这种"看起来生效、其实没生效"
与 27.1 同类。现改为 `pickBool()`（同时认布尔与 `'true'/'1'/'yes'`），
并新增 `pixmart_check_size` 的 `list: true` → 返回 `supportedSizes`（上限 64，超了给
`supportedSizesTruncated`）。

### 27.6 新增断言（`test/agnes.test.mjs` / `test/guidance.test.mjs`，4 条）

1. 精确像素**保真**：`2048x2048` → `normalized === '2048x2048'`（回归断言，见 27.7）；
2. 请求体里档位正确：`2048x2048` → `size='2K' ratio='1:1'`；`2624x1472` → `size='2K' ratio='16:9'`；
   `3K` → `size='3K' ratio='1:1'`；
3. 内置能力优先于 config：把 `allowedSizes` 改成 `['1:1']` 后 `2624x1472` 仍然支持；
   `2K` 被拒且提示里出现 `2048x2048`；
4. 503 + `model_not_found` → `model_unavailable` / `retryable:false` / 只发 1 次 / `degraded` 为空。

系统提示新增一条 `**尺寸与档位**`（agnes 档位由精确像素决定 + `list: true` 取全量）。
**没有提高**指引的行数上限（36 行）：为塞进这一条，压缩了"模块映射"与"保真必须用 edit"
两处措辞，最终仍是 36 行 —— 限额是护栏，不该为了新内容自己往上挪。

### 27.7 可证伪性（本次没有现成 harness，就自己造一次）

`tools/lane-mutations.mjs` 只变异 `client/client.js`（浏览器 lane 用），服务端改动不在它的
覆盖范围内。所以本次直接对**编译产物** `lib/sizes.js` 做一次变异（`lib/` 是可再生产物，
不动 `src/`）：把 agnes 内置能力的 `forms: ['ratio','pixel']` 改回 `['ratio']`
（= 缺陷形态：档位塌缩），跑 `test/agnes.test.mjs`：

```
✖ 尺寸归一化：比例保留比例，精确像素**保留像素**（档位不能被丢掉）
✖ agnes 的内置尺寸能力不依赖 config 里的 allowedSizes（老配置也生效）
ℹ pass 21  fail 2
```

**恰好**是这两条新断言变红，其余 21 条不动 —— 说明它们不是空跑，也不是误伤。
随后 `pnpm build` 还原（`hit 次数 == 1`，改前先断言 `find` 唯一）。

### 27.8 已知缺口（明说）

- **设置页仍然无法选档位**：`defaults.size` 下拉框的取值来自 `allowedSizes`（8 个比例），
  所以从 UI 只能拿到默认 `1K`；要 2K/3K/4K 目前得由 Agent 传精确像素（或用户手改
  `config.json` 的 `defaults.size`）。档位选择器是**下一轮**的事。
- **`2K` 这种纯档位写法仍然被拒**（见 27.2），只为 agnes 做"档位 + 比例"的复合语法
  （如 `2K@16:9`）**本次不做**：精确像素已经能表达同一件事，且不需要新语法。
- `checkSize` 的 `declaredSizes` 会把完整清单带回调用方（40 项），但只有 `list: true`
  才出现在工具输出里——默认不灌上下文。
- **文生图刻意没发顶层 `return_base64`**：官方文档把它列为文生图取 Base64 的开关，但我们
  现在走 `extra_body.response_format: 'url'` + 立即回取字节，而且**已用真实调用验证过**
  （`2.1-flash` / `2.5-flash` 各一次，685 KB / 694 KB，1024×1024）。多发一个未验证的参数会
  改变响应形状、收益为零，所以不发；`data[].b64_json` 的解析路径仍在（离线用例覆盖）。
- 本次**没有做真实生图验证**：跑着的宿主加载的还是旧 `lib/`（插件是 `link:` 到仓库的，
  重启宿主即可生效，无需重装），且花钱的动作要先报数。

### 27.9 结果

`pnpm verify` 全绿：宿主 `pnpm test` **353**（§26 的 349 + 新增 4），
浏览器 `pnpm test:browser` **56**（未调整任何既有断言；`test/vendor.test.mjs` 的
比例/像素归一化断言、`test/p2.test.mjs`、`test/insufficient-credits.test.mjs` 全部原样通过）。

---

## 28. 设置页能选档位（1K–4K）：尺寸词表由宿主出（2026-10-12）

补上 §27.8 的最大缺口：§27 让"精确像素 → 档位"在**工具链路**上通了，但设置页的
「默认尺寸」下拉仍然只有 8 个比例，从 UI 只能拿到默认 `1K`。现在 UI 能直接选 2K/3K/4K。

### 28.1 做法：词表只有一份，客户端只渲染

- `sizes.ts` 新增 `sizeOptionsFor({model, apiMode, provider})` → `{value, label}[]`：
  **`value` 是要存进配置的原始写法**（`2048x2048`），**`label` 才是给人看的**（`2K · 1:1`）。
  档位只有官方表知道，所以标签也在宿主算——`sizeOptionLabel()` 查 `AGNES_SIZE_TABLE`，
  查不到就原样返回（比例、表外像素、其它厂商的像素都走这一条）。
- `ProviderView.sizeOptions` 把这份清单带进 `GET /providers`；`toProviderView` 用
  **厂商的第一个模型**当代表定位能力（agnes 的官方表对全部 agnes 模型一致；
  `models` 为空时自然退回厂商配置的 `allowedSizes`）。
- 客户端 `DefaultsCard` 直接渲染 `sizeOptions`；**没有该字段时退回 `allowedSizes`**
  （老宿主 / 老夹具仍然可用，这也是浏览器 lane 夹具不用改的原因）。

**为什么不把 32 个尺寸写进客户端**：那样"UI 能选的"与"`checkSize` 认的"会成为两份词表，
迟早各说各话——本次修的 `listModules`、尺寸塌缩都是这一类（看起来生效、其实不是同一回事）。
依赖方向也顺势单向化：`config.ts → sizes.ts`（`sizes.ts` 对 `config.ts` 只有 `import type`，
编译后不留运行时依赖，不成环）。

### 28.2 顺带修掉：换厂商会把上一个厂商专属的尺寸带过去

agnes 的档位要落到 `2048x2048` 这种**厂商专属**写法，而它对 ofox 无效。原先换厂商只重置
**模型**（避免 `unknown_model`），尺寸原样带过去 → 存下一个对后者无效的默认值，
下次生图才报错。现在换厂商时若当前尺寸不在新候选里，自动退回新厂商的第一项
（与模型重置同一处、同一理由）。

### 28.3 新增断言（5 条，零网络）

1. `test/agnes.test.mjs`：agnes 的候选 **40 项**（32 像素 + 8 比例），
   且 8 个比例的 `2K` 标签恰好是 `['2K · 1:1','2K · 3:4','2K · 4:3','2K · 16:9','2K · 9:16','2K · 2:3','2K · 3:2','2K · 21:9']`；
   比例项的标签等于它自己；
2. `test/providers-api.test.mjs`：`GET /providers` 的 `sizeOptions` 对厂商配置是
   `[{value:'1:1',label:'1:1'},{value:'3:4',label:'3:4'}]`；
3. 同上，agnes：**老配置的 `allowedSizes: ['1:1']` 不影响候选**（仍是 40 项，
   含 `2048x2048`→`2K · 1:1`、`2624x1472`→`2K · 16:9`）——与 `checkSize` 同一条路径；
4. `test/client-settings-dom.test.mjs`：默认值卡片把 `1024x1024` 显示为 **`1K · 1:1`**，
   选 `2048x2048` 后显示 `2K · 1:1`，**存下去的仍是 `2048x2048`**（标签不落盘）；
5. 同上：初始是 agnes 的 `2K · 1:1`，切到 ofox 后保存 → `size` 变成 `1:1`（不带过去）。

### 28.4 已知缺口（明说）

- **`POST /defaults` 仍然不校验 `size`**：UI 只会送候选里的值，但手写请求仍能存进一个
  以后会失败的值（例如给 ofox 存 `2048x2048`）。要补需要先解决"按哪个模型校验"
  （`defaults.model` 可能属于另一个厂商），本次不动。
- `sizeOptions` 用**第一个模型**当代表：若某厂商把能力不同的模型混在一起
  （ofox 的 `models` 里既有图像模型也有纯文本模型），候选按第一个模型算。
  ofox 的第一个是 gemini 图像模型 → 候选是内置的 **10 个比例**（比它配置里的 5 个更全，
  与 `checkSize` 的实际判定一致）。CI 夹具的 provider 不匹配任何内置表，行为不变。

### 28.5 结果

`pnpm verify` 全绿：宿主 `pnpm test` **358**（§27 的 353 + 新增 5），
浏览器 `pnpm test:browser` **56**（未调整任何既有断言；默认值卡片的字段说明文案变长，
几何类断言未受影响）。

> **本次会话的机器状态**：写入过程中第 4 次蓝屏，**只损坏了构建产物**（`lib/` 31 个文件、
> `dist/client.js` 整份 291346 字节全零），源码零 NUL。产物可再生产，`pnpm build` +
> `pnpm build:client` 后重新扫描为 0、`pnpm verify` 全绿。但这已是第 4 次，建议查硬件/存储。

