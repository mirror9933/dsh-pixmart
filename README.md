# dsh-pixmart

给 **DeepSeek Harness** 加一套**电商生图**能力：主图 / 详情图 / 广告图、风格复刻、白底图。
你在对话里说要什么，Agent 调工具把图**真的生成出来**，落盘到插件数据目录，在侧边栏「PixMart → 作品库」里看。

> **状态**：功能 P0–P3 已完成、打包已就绪（`LICENSE` / `NOTICE` 齐、`exports["./client"]` 指向 `dist/client.js`）；
> **未发布到 registry**（`package.json` 里 `private: true`），只能用**本地路径 / git 地址**安装。从零安装的全链路验收（方案 A8）尚未跑过。

## 安装

```sh
# 本地目录安装（建议先装 scratch profile，别直接装进在用的 profile）；也可以换成 <git-url>
dsh plugin --profile px add E:\Programs\agent\dsh-pixmart
dsh --profile px --dump-config      # 输出里应出现 dsh-pixmart 层
```

**改了什么 → 怎么生效**：host 半（`src/` → `lib/`）**重启宿主**；client 半（`client/client.js` → `dist/client.js`）先 `pnpm build:client` 再**刷新页面**；`package.json` / `exports` / profile bundles **重启宿主**。
`dist/` 不入库，而 `exports["./client"]` 指向它 ⇒ 从 git 装完**先跑一次 `pnpm build:client`**。
（`dsh` 的退出码恒为 1，**别用退出码判断成功**，看输出里的 `Done in …`。）

## 首次使用（这步不能省）

**插件出厂不带任何厂商**，第一次必须先自己加一家：

1. **设置 → PixMart → 厂商** → 点 **「添加模型提供商」**；
2. 选一个 tab：**第三方模型提供商**（内置目录里挑一家，如 Ofox / Agnes AI / 阿里云百炼）或 **自定义模型 API**（自填 ID / 显示名 / API 地址）；
3. 填 **API Key** → **保存**（也可以先设环境变量，如 `OFOX_API_KEY`，优先级高于设置页）；
4. 点 **「测试连接」** 确认端点与密钥；再点 **「拉取模型」** 多选生图模型 → **「保存选择」**（唯一写入模型列表的入口）；
5. 回顶部 **「默认值」** 卡片选 **厂商 / 模型 / 尺寸 / 每次张数（1–4）** 并保存 —— 生图不带参数就用这套。

- **密钥只以「是否就位」回显**，任何时候都不显示内容，也不进日志或响应体。
- 卡片行尾的 **「删除」** 是两步确认；删掉不会在重启后被补回来（出厂没有预设可补）。
- 可选：**「作品库导出路径」**填一个**绝对路径**（相对路径会被当成未设置）；只有你点「导出」才会往那儿复制，生成时不会。

## 怎么用

直接说人话，不用记工具名：「给这个产品做一张 1:1 的白底主图」「照这张爆款的风格换成我的产品」「出一套详情图，先给我看提示词」。

Agent 的默认顺序（为了省钱）：`pixmart_prompt`（免费）→ `pixmart_check_size`（免费）→ `pixmart_generate` / `pixmart_edit` / `pixmart_batch`（**计费**）。
**计费次数 = 项数 × 每项张数**，批量前 Agent 会先报给你确认；单张实测 **1–3 分钟**，等待期间别让它重复调同一个工具。
8 个工具：免费的 `pixmart_prompt` / `pixmart_check_size` / `pixmart_providers` / `pixmart_projects` / `pixmart_ping`，
计费的 `pixmart_generate` / `pixmart_edit` / `pixmart_batch`（`pixmart_prompt` 加 `listModules: true` 能列出全部 24 个提示词模块）。

- **要保持产品外观一致**（保真 / 风格复刻 / 白底图）必须走 `pixmart_edit` 并带参考图；文生图保证不了主体一致。
- **有参考图做纯白底**用 `tool.white-bg` 模块；`main.white-bg` 是**无参考图**的白底首图，别混。

## 尺寸

比例（`1:1`、`3:4`、`16:9`…）或像素（`1024x1024`）都能传；**agnes 的档位由精确像素决定**
（`2048x2048` = 2K + 1:1，只给比例则用默认 1K），比例支持 8 种。拿不准就先调 `pixmart_check_size`（免费，不发请求）。

## 产物在哪

只落盘**插件数据目录**：`$DSH_HOME/pixmart/`（没设时回落 `~/.dsh/pixmart`，实际路径见设置页的「数据目录」）——
`config.json`（设置页写的就是它）、`usage.jsonl`（用量账本）、`projects/<项目 id>/`（元数据 + 图片）。
浏览 / 删除 / 恢复 / 导出都在侧边栏「**作品库**」：删除是**软删**（进回收站，可恢复，清空才真删）；
**导出**只能你点界面触发，落点是设置里的导出路径，Agent 侧没有导出能力。
对话里渲染图片用的副本在**会话工作区**的 `pixmart-out/<项目 id>/`，确认没用了可以整体删（原件在数据目录）。

## 开发与打包

```sh
pnpm install
pnpm build          # host tsc → lib/
pnpm build:client   # 剥离 client bundle 的 __test__ → dist/client.js（test 的 pretest 会顺带跑）
pnpm prepack        # 发布前跑（同 build:client），npm pack / publish 时自动执行
pnpm verify         # typecheck + build + 宿主 lane + 浏览器 lane，全绿才算过（计数以它输出为准）
```

`dist/` **不入库**：它是 `build:client` 的产物、可再生，而源码在 `client/`；忘了重建会被
`test/strip-test-hooks.test.mjs` 的陈旧性守卫抓住（不一致就直接失败）。**改了 `client.js` 必须 `pnpm build:client`，刷新才看到新字节。**
变异纪律：`node tools/lane-mutations.mjs` 把 client 实现**故意改坏**再跑浏览器 lane，**对应用例必须真的变红**，该红没红就非零退出（证明断言不是空跑）。浏览器 lane 需要系统已装 Edge / Chrome。

目录：

- `src/` —— host 半（TypeScript，运行时零 `@deepseek-ai` 依赖）：配置、厂商目录、路由、`tools/`、`vendor/`、`prompts/`、`store/`
- `client/client.js` —— client 半（手写、`__ModuleLoader__` 包装，测试从这里取组件）
- `test/` —— 宿主 lane（node:test + jsdom）；`test/browser/` —— 浏览器 lane（Playwright + 系统浏览器）
- `tools/` —— 开发脚本：`strip-test-hooks.mjs`（打包剥离）、`lane-mutations.mjs`（变异验证）
- `docs/` —— 契约笔记 / 技术方案 / 验收记录：**不上传仓库**，只在本机（远端链接会 404，且无版本历史，请自行备份）
- `lib/` `dist/` —— 构建产物；`pixmart-in/` `pixmart-out/` —— 会话工作区进 / 出目录（都不入库）

## 待办

- **T1 账本可观测性**：`usage.jsonl` 记参考图张数与成功档位、`project.json` 记参考图路径（现在账本自证不了"参考图真的传出去了"）。
- **T2 批量摘要尺寸**：`pixmart_batch` 省略 `size` 时头部只显示一个尺寸（数据层是对的，只有那行摘要误导）。
- **提案（未开工）**：`docs/提示词工程优化提案.md`、`docs/并发与大批量出图方案.md`、`docs/作品库优化方案.md`。

## 排障

- **点了按钮报「宿主未加载此接口」** → 预期：host 改动要重启宿主（分级见「安装」）；不确定插件有没有加载就调一次 `pixmart_ping`（无副作用）。
- **报「还没有配置任何厂商：打开「设置 → PixMart → 厂商」，点「添加模型提供商」…」** → 预期首启状态，去加一家就行；已配厂商只是 id 写错时，文案会列「已配置：a, b」。
- **尺寸对不上** → 核对**原件**，别看对话里的附件预览（预览会被缩放）；账本记的是厂商真实回传的像素。
- **余额不足（402）** → 工具返 `insufficient_credits` 并要求 Agent **停下来问你**，不重试、不降级，也不允许用脚本"合成"一张图充数。

## 已知限制

- **不做 3D / 视频**，不做服务端缩略图；数据只在本机（没有账号 / 云同步）。
- **白底可能不够纯**：厂商模型没能可靠交付"绝对纯白"，**插件不做图像后处理** —— 平台有硬性审核时需自己或让 Agent 后处理。
- 只在 **Windows** 上实跑过；真实批量的端到端链路尚未验证（mock 层已过）。

## 许可

MIT，见 [LICENSE](./LICENSE)；原创范围声明见 [NOTICE](./NOTICE)。
