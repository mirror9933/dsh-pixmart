# dsh-pixmart

给 **DeepSeek Harness** 加一套**电商生图**能力：主图、详情图、广告图、风格复刻、白底图。
全部操作都在**对话里**完成——你说要什么，Agent 去调工具。

> **当前状态（请先读这段）**
>
> - **尚未发布到 registry**，`package.json` 里仍是 `private: true`。所以只能用**本地路径 / git 地址**安装（见下方「安装」）。
> - 功能阶段：**P0–P3 已完成**；P4 的**打包步骤已做完** —— `NOTICE` 已补、`exports["./client"]` 已切到 `dist/client.js`、
>   `dist/` 的构建与陈旧性守卫都在（见「[打包与发布](#打包与发布)」）。**剩下的只有"发布与验收"**：
>   去掉 `private`、补 `LICENSE`、定版本号，以及在全新 `DSH_HOME` 上跑一遍从零安装（方案里的 A8）。
> - 版本：`0.0.1`。测试：跑 `pnpm verify`（数字随测试增删变化，**别照抄**；最近一次实测计数写在「[开发与验证](#开发与验证)」）。
> - 没做的功能写在「[已知限制](#已知限制)」里，别当成已有能力。

---

## 一句话

你在对话里说「帮我给这个产品做一张 1:1 的白底主图」，Agent 会用本插件的工具把图**真的生成出来**，
落盘到插件数据目录，并在侧边栏「PixMart → 作品库」里给你看。

---

## 能做什么

### 用起来大概是这样

| 你想做的事 | 对话里怎么说 | 背后用的工具 |
|---|---|---|
| 生成白底首图 / 场景主图 | 「做一张 1:1 的白底主图」 | `pixmart_generate` |
| 拿产品图做保真改写 | 「按这张图做一张场景图，产品别变形」 | `pixmart_edit`（带参考图） |
| 学某张爆款图的设计风格 | 「照这张爆款的风格，换成我的产品」 | `pixmart_edit` + `tool.style-replica` 模块 |
| 有参考图做纯白底 | 「把这个玩偶抠出来放纯白底」 | `pixmart_edit` + `tool.white-bg` 模块 |
| 详情页一整套（14 屏） | 「帮我出一套详情图」 | `pixmart_batch` |
| 翻旧账 / 看以前的图 | 「我之前生成过什么」/「那个项目的图在哪」 | `pixmart_projects` |

### 工具（共 8 个）

**免费、不发任何厂商请求**（放心让 Agent 多调）：

| 工具 | 作用 |
|---|---|
| `pixmart_prompt` | 按模块把最终提示词拼出来给你看（dry run）。也可以 `listModules: true` 列出全部模块。 |
| `pixmart_check_size` | 校验目标尺寸这个模型到底支不支持，不支持就给最近的可选尺寸。 |
| `pixmart_providers` | 列出厂商 / 模型 / 能力 / 密钥是否就位（**不返回密钥内容**）。 |
| `pixmart_projects` | 作品库操作：`list` / `get` / `delete` / `restore` / `usage`。`get` 会给出该项目在**会话工作区**里的暂存副本目录（`pixmart-out/<项目 id>`）；它**不导出**、不往任何用户目录写文件。 |
| `pixmart_ping` | 自检：确认插件已加载、工具链路可用。装完想确认一次就调它。 |

**计费、每次都会真的调用厂商**：

| 工具 | 作用 | 备注 |
|---|---|---|
| `pixmart_generate` | 文生图 | 可以一次多张（`n`，1–4） |
| `pixmart_edit` | 图生图 / 参考图保真 / 风格复刻 / 白底图 | **必须**给参考图；想保持产品一致只能用这个 |
| `pixmart_batch` | 一次做一整套（比如详情图 14 屏） | 每项独立成败，一项失败不影响其余 |

### 提示词模块（共 24 个）

模块是**决定画面长什么样的预设**。你不用记 id，直接说人话，Agent 会挑；也可以自己指定。

- **主图 5 个**：白底首图、场景主图、卖点主图、细节主图、尺寸规格主图
- **详情图 14 个**：首屏、场景、氛围、卖点、细节、效果对比、工艺材质、系列、尺寸规格、配件、使用方式、品牌故事、售后、多角度
- **广告 3 个**：电商广告、社交种草、海报
- **工具 2 个**：`tool.white-bg`（**有参考图的**纯白底）、`tool.style-replica`（爆款风格迁移）

> ⚠️ 容易选错的一处：**「基于参考图做纯白底」要用 `tool.white-bg`**，不是 `main.white-bg`。
> 后者是**无参考图**的白底首图，它的提示词是给**带印刷包装**的商品写的，拿去做玩偶 / 软体产品会不对口。
> 需要保持产品外观一致（保真 / 风格复刻 / 白底图）时，一定要走 `pixmart_edit` 并带参考图——文生图保证不了主体一致。

---

## 安装

**前提：先装好 DeepSeek Harness，并知道它的 `dsh` 命令。**

当前**没有发布到 registry**（`private: true`），所以**不能用** `dsh plugin add dsh-pixmart` 这种按名字装的方式。
用**路径**或**git 地址**：

```sh
# 从本地目录安装（推荐先装到 scratch profile 验证，不要直接装进正在使用的 profile）
dsh plugin --profile px add E:\Programs\agent\dsh-pixmart

# 或者从 git 地址安装
dsh plugin --profile px add <git-url>

# 确认装上了：输出里应当出现 dsh-pixmart 层
dsh --profile px --dump-config
```

装完**重启宿主**。改动的生效分级（和「[常见问题](#常见问题)」里同一套规则）：

| 你改了什么 | 怎么生效 |
|---|---|
| host 半（`src/` → `lib/`） | **重启宿主** |
| client 半（`client/client.js` → `dist/client.js`） | 重新构建（`pnpm build:client`）+ **刷新页面**即可 |
| `package.json` / `exports` / `dsh.client` / profile bundles | **必须重启宿主** |

> **注意 `dist/` 不入库**：`exports["./client"]` 现在指向 `dist/client.js`，所以从 git 装一份之后
> **第一次用之前要先 `pnpm build:client`**（详见「[打包与发布](#打包与发布)」）。

> **待验证**：上面这三条命令来自技术方案 §11.2 的既有记录，**没有在全新 `DSH_HOME` 上跑过一遍完整的从零安装**（那是 P4 的验收项 A8，尚未执行）。
> 另外 `dsh.cmd` 的退出码**恒为 1**（Electron-as-Node 启动方式所致）——**不要用退出码判断成功**，看输出里的 `Done in …`。

---

## 首次配置（最关键的一步）

**不填 API Key 是生不出图的**；没配密钥时工具会返回一条可读的报错并指向设置页，这是正常的首次体验，不是坏了。

1. **重启宿主**（安装后必须重启；改完 `package.json` / exports 也一样）。
2. **刷新页面**（浏览器端改动刷新即可生效）。
3. 打开 **设置 → PixMart**。
4. 在**厂商**区点虚线按钮 **「添加模型提供商」** → 页内展开的卡片里选一个 tab：
   **「第三方模型提供商」**（从内置目录 13 家里挑一家，如 Ofox / Agnes AI / 阿里云百炼…）或
   **「自定义模型 API」**（自填 ID / 显示名 / API 地址）。
   填 **API Key** 后点**「保存」** —— 这一步同时把厂商加进配置并把密钥落盘。
   **插件出厂不带任何厂商**，所以这一步不能省（也可以先设环境变量，如 `OFOX_API_KEY`，它的优先级高于设置页）。
   - 密钥只以「是否就位」的形式回显，任何时候都不会显示内容。
   - 加好之后，卡片默认是**收起**的（只显示厂商名、密钥圆点与「编辑」）；**改字段不再即时落盘**——
     点「编辑」展开后「保存」才写，「取消」丢弃本地改动且不发任何请求。
   - API 地址在编辑区里的 **「自定义设置」** 折叠项里（平时收着）；填错端点时就是去那里改。
   - 卡片行尾的 **「删除」** 是两步确认（第一次只是改文案）；**删掉就不会在重启后被补回来**。
5. 在编辑区里点 **「测试连接」**——确认端点与密钥都对。
6. 点 **「拉取模型」**（`GET {baseUrl}/models`，**只拉取、不写配置**）→ 在列表里**多选**你需要的生图模型 → 点 **「保存选择」**（这是唯一会写入模型列表的入口）。
   - 列表很长：搜索框按子串过滤；「全选 / 全不选」只作用于**当前筛选结果**；「只选图像模型」按启发式**重设**选择。
7. 回到顶部的 **「默认值」** 卡片，选 **厂商 / 模型 / 尺寸 / 每次张数（1–4）** 并保存。生图时不带参数就用这一套。
8. **可选**：在 **「作品库导出路径」** 卡片里填一个**绝对路径**。只有你在作品库点「导出」时，图片才会被复制到 `该路径/<项目 id>/`。
   - 空着 = 未配置，导出按钮会提示你先去填。
   - **必须是绝对路径**：填相对路径会被当成「未设置」并记一条 warning（宿主的工作目录是什么，用户无从预期）。
   - 生成时**不会**往这里自动复制任何文件。

设置页里还能看到**累计用量**与**数据目录**，方便核对账目。

### 厂商

厂商列表由配置里的 `providers` 驱动，**出厂是空的**（安装后一家都没有，由用户自己加）；
所有厂商都在设置页点 **「添加模型提供商」**从**内置目录（13 家）**里挑，也可以走「自定义模型 API」
自填端点（目录出处见 [docs/contract-notes.md](./docs/contract-notes.md) §31）。
卡片行尾的「删除」是两步确认；**删掉就不会在重启后被补回来**——**出厂不带厂商**，所以
`load()` 不会给任何配置补人（`removedProviders` 那套墓碑记账是为"将来可能的出厂预设"保留的机制，
正常流程用不到；见 §33）。

下表是**我们真机验证过**的两家，也是目录里最稳的选择（其余厂商的「生图能力」标注见目录数据）：

| 厂商 | `dialect` | 端点 | 密钥 | 状态 |
|---|---|---|---|---|
| **Ofox** | `ofox` | `https://api.ofox.io/v1` | `OFOX_API_KEY` | 已验证（真实出图 / 契约笔记 §11、§18） |
| **Agnes AI** | `agnes` | `https://api.agnes-ai.cn/v1` | `AGNES_API_KEY` | **已真机验证**：2.1 / 2.5-flash 真实出图（**1K / 2K / 3K / 4K 四档齐**，§29、§36） |

**Agnes 的取舍**（细节与出处见 [docs/contract-notes.md](./docs/contract-notes.md) §25）：

- 生图与图生图**同一个端点** `POST /v1/images/generations`，`Authorization: Bearer`；**不走** `/images/edits`。
- 参考图必须在 **`extra_body.image`**（data URI 数组），`response_format` 也必须在 **`extra_body`** 内
  ——官方明文：放到顶层会**报错**。所以它单列成一个方言 `agnes`，而不是复用 `standard`。
- 尺寸是**「档位 + 比例」**：**档位由精确像素尺寸决定**（`2048x2048` → `size: '2K'` + `ratio: '1:1'`，
  官方 32 个精确尺寸见 [src/sizes.ts](./src/sizes.ts)；只给比例则用默认 `1K`），
  比例支持 8 种：`1:1`/`3:4`/`4:3`/`16:9`/`9:16`/`2:3`/`3:2`/`21:9`。
  所以在 Agnes 上前端选 `1:1` 之类的**比例**，不要按像素理解。
- 官方文档**没有** `/models` 列表接口。点「拉取模型」**会失败**并给出可读原因（HTTP 404）——
  这是可接受的结论，不是坏了；请在设置页用「模型」列表手动勾选，或先填 `models`。
- **未验证**：真实出图、真实尺寸回传、多图合成、`/models` 是否存在。拿到 Key 后才能确认（清单见 §25.5）。

---

## 怎么用

**直接对话就行**，不需要记工具名或参数。Agent 侧有一段系统提示，知道什么时候该用这些工具。例如：

- 「帮我给这个产品做一张 1:1 的白底主图」
- 「按这张爆款图的设计风格，换成我的产品，出一张社交种草图」
- 「帮我出一套详情图，14 屏，先给我看提示词再开始」

Agent 的默认动作顺序是（这条顺序是为了省钱）：

1. `pixmart_prompt` —— 拼出最终提示词给你看（**免费**）
2. `pixmart_check_size` —— 校验尺寸（**免费**）
3. `pixmart_generate` / `pixmart_edit` / `pixmart_batch` —— 真正生图（**计费**）

**批量前 Agent 会先把「项数 × 每项张数」报给你确认**，不会自己放大规模。单张生图实测要 **1–3 分钟**（曾观测到 106 秒），耐心等；等待期间不要让它重复调同一个工具（会重复计费）。

---

## 产物在哪

- **只落盘到插件数据目录**，形如：

  ```
  $DSH_HOME/pixmart/
  ├── config.json            # 厂商 / 密钥 / 默认值 / 作品库导出路径（设置页写的就是它）
  ├── index.json             # 项目索引（可重建）
  ├── usage.jsonl            # 追加式用量审计
  └── projects/<项目 id>/
      ├── project.json       # 项目元数据 + 每张图的记录
      └── images/<sha256前8位>-<slug>.png
  ```

  宿主的 `DSH_HOME` 没设时（GUI 启动的宿主就是这样）会回落到 `<用户主目录>/.dsh/pixmart`。实际路径可以直接在设置页的**数据目录**一栏看到。

- **浏览**：侧边栏「**PixMart → 作品库**」。里面有搜索、排序、分页、查看器、删除 / 回收站 / 导出。
- **要文件形式的副本**：用作品库里的「**导出**」，落点永远是设置里的「**作品库导出路径**」下的 `<项目 id>/`（没配就提示你去配，不会自己挑一个地方）。这条路径**只由你点界面触发**——Agent 侧的 `pixmart_projects` 没有导出能力（它不会把文件写进你管理的目录）。
- 生成时唯一自动产生的副本是**对话里渲染图片需要的那一份**（会话工作区内的 `<工作区>/pixmart-out/<项目 id>/`），它与你的导出路径互不相干。Agent 需要给你文件时，是让你用这个**已经存在**的副本，而不是再复制一份到别处。
- `pixmart-out/` 是**会话暂存目录**，不是插件独占：除了插件写入的自动副本，**也可能混有 Agent 自己加工的产物**（实测它会往里放抠图 / 白底处理结果等衍生物）。插件**不会清理**这个目录，确认没用了可以**随时整体删除**——生成的原件始终在插件数据目录，不受影响。
- Agent 侧的**输入**（参考图、临时脚本、中间产物）约定放在**会话工作区的 `pixmart-in/`**，插件不读也不写这个目录；`.gitignore` 里 `/pixmart-out/` 与 `/pixmart-in/` 都锚定到仓库根，所以工作区即使就是本仓库也不会被弄脏。
- 数据目录里如果有一个旧的 `exports/` 目录，那是早先版本的隐式落点留下的：**新版不再往里写任何东西**（Agent 侧现在也没有任何写文件的落点），文件可自行清理。

---

## 费用

| 免费（不发厂商请求） | 计费（每次真实调用厂商） |
|---|---|
| `pixmart_prompt`、`pixmart_check_size`、`pixmart_providers`、`pixmart_projects`、`pixmart_ping` | `pixmart_generate`、`pixmart_edit`、`pixmart_batch` |

- 计费次数 = **项数 × 每项张数**。`pixmart_batch` 的 `items` 有几项、`n` 是几张，就调几次。
- 批量前 Agent 会**报价并等你确认**。
- 用量可以在设置页的「累计用量」或 `pixmart_projects` 的 `usage` 里核。
- 项目内单项数量上限、并发上限都在配置里（默认并发 2、单批最多 20 项）。

---

## 常见问题

**Q：按钮点了报「宿主未加载此接口，请重启 DeepSeek Harness 后重试」？**
A：这是**预期**的——**host 代码改动必须重启宿主**才生效（host 的 HMR 只做文件 stat 检测 + 通知刷新页面）。
分级记住：client bundle 改动 → 刷新页面即可；host 代码 → 重启；`package.json` / exports / `dsh.client` / profile bundles → 必须重启。

**Q：生成了图，但对话里看不到图片？**
A：检查配置 `attachmentInConversation`（**默认 `true`**）。它是 `config.json` 里的字段，**设置页目前没有对应开关**；关掉之后图片只落盘，工具会回一句说明。
另外宿主没提供 `attachments` 服务时也会只落盘——这两种情况都能在侧边栏作品库里看到图。

**Q：删掉的项目还能找回来吗？**
A：能。删除是**软删**：项目被移入回收站（`projects/.trash`，磁盘字节一个都没少），在作品库的「回收站」里可以逐个**恢复**，或者整体**清空**（清空才真的删）。
Agent 侧通过 `pixmart_projects` 删除时，默认同样是软删；**只有你明确要求永久删除时它才会传 `permanent: true`**——两种模式都需要 `confirm: true`。

**Q：我直接改了 `config.json`，为什么要重启才生效？**
A：**正确做法是用设置页改**，不要手改 `config.json`。设置页改完即时生效（写完会用原子写落盘）；手改文件则要等宿主重启后才被读进来。

**Q：`pnpm test:browser` 报没有浏览器？**
A：这条 lane 需要系统已装 Edge 或 Chrome（**不会自动下载浏览器**）。没有浏览器时它会**醒目失败**而不是假装通过；确实要放行可以设 `PXM_LANE_ALLOW_SKIP=1`。

**Q：厂商余额不足（HTTP 402）时，插件会替我想办法把图"做出来"吗？**
A：**不会，也不该期待。** 余额不足时工具返回专用错误码 `insufficient_credits`，原始报错里的余额数值原样保留，
并附一条**指令级提示**要求 Agent **先停下来用 `ask_user_question` 问你**（去充值，还是换个方式）。
"自动降级出图"不存在：插件不会、也不允许 Agent 用 PIL / ImageMagick / canvas 之类的脚本
**合成或伪造**一张图充当交付物——那不是"生成的图"，质量和可追溯性都不可控。
所以正确做法是充值后重试；插件只保证**不重复扣费**（402 是终态，不重试、不降级）。

**Q：装完发现工具没出现？**
A：先在对话里调一次 `pixmart_ping`——它无副作用，能确认「插件已加载 + 工具注册链路可用」，并列出宿主当前暴露的服务。

**Q：生图时报「还没有配置任何厂商：打开「设置 → PixMart → 厂商」，点「添加模型提供商」选一家并填入 API Key」？**
A：这不是故障，而是**出厂不带厂商**的预期首启状态（契约笔记 §33）。按提示去 设置 → PixMart 加一家并填 Key
（也可以先设环境变量，如 `OFOX_API_KEY`）再重试即可。
这句话是**统一的可操作指引**，`pixmart_check_size` / `pixmart_generate` / `pixmart_edit` / `pixmart_batch`
四处失败点在"一家都没配"时返回的是同一句；如果已经配了厂商、只是 **id 写错**，文案会不一样——
它会列出「已配置：a, b」帮你对拼写。别把后者也当成"没配厂商"。

**Q：出的图尺寸对不对？为什么报表里的尺寸和我看到的预览不一样？**
A：**核对尺寸要看原件，不要看对话里的附件预览**（契约笔记 §36）。预览可能被宿主缩放，
而账本（`project.json` / `usage.jsonl`）记的是**厂商真实回传的像素**。要核对就打开数据目录里的原图，
或用作品库的查看器。agnes 尤其注意：它的尺寸是「**档位 + 比例**」，档位由**精确像素**决定
（`2048x2048` → 2K + 1:1）；只给比例时用默认档位 1K。

---

## 已知限制

- **不做 3D、不做视频**（v1 范围外）。
- **不做服务端缩略图**：作品库靠浏览器加载原图，图多时首屏会吃力。
- **不像云盘**：没有账号、没有云同步、没有多人协作；数据就在本机数据目录。
- **「重新生成」已取消**：作品库里没有这个入口（原先设计过，已砍掉）。
- **提示词片段是英文**：目标模型（Gemini / gpt-image 系）对英文指令的遵循度更稳；界面标签是中文。
- **macOS 未验证**：目前只在 Windows 上实际跑过。
- **未上架社区市场**，也**未发布到 registry**（`private: true`）。
- **打包步骤已完成，但"发布形态"还没验收**：`exports["./client"]` 已切到 `dist/client.js`、`NOTICE` 已补；
  剩下的是**发布前待办**（去掉 `private`、补 `LICENSE`、定版本号），以及**从零安装全链路（方案里的 A8）尚未执行**
  —— `dist/` 不入库，所以新装/干净 checkout 之后**必须先 `pnpm build:client`**，这一步只有 `pnpm test` 的
  `pretest` / 发布的 `prepack` 会自动做。见「[打包与发布](#打包与发布)」。
- **部分验证没做**：真实批量生图的端到端链路要花钱，尚未执行（mock 层已过）。
- **白底图可能"不够纯"，需要后处理**：提示词里已明确要求"绝对纯白背景"与"四边留白均匀"，
  但厂商模型**没能可靠交付**这两点。实测（2026-10-06）Agent 为此现场写了脚本：
  从边框 flood fill 把背景强刷成 `(255,255,255)`、并按产品包围盒重新居中。
  **插件不做这件事**（图像后处理会破坏"零运行时依赖"），所以若你的平台对白底有硬性审核，
  需要自己或让 Agent 后处理。**结论记录在此以免重复调查**，不要误以为插件会保证纯白。

---

## 开发与验证

host 半是 TypeScript（`src/`，**运行时零 `@deepseek-ai` 依赖**），client 半是手写的
`client/client.js`（`window.__ModuleLoader__` 包装，没有打包器、没有 JSX）。

```sh
pnpm install
pnpm typecheck        # host + client 两个 TS program
pnpm build            # host tsc → lib/
pnpm build:client     # 打包步骤：剥离 client bundle 的 __test__ → dist/client.js
pnpm test             # 宿主 lane：node:test（含 jsdom 子 lane）
pnpm test:browser     # 浏览器 lane：真实排版引擎（Playwright + 系统 Edge/Chrome）
pnpm verify           # typecheck + build + test + test:browser 串起来跑
```

**`pnpm verify` 覆盖什么**：`pnpm typecheck` → `pnpm build` → 宿主 lane（`node --test test/*.test.mjs`，
含 jsdom）→ 浏览器 lane（`node --test test/browser/*.test.mjs`）。**任何一项红就是没通过**；
浏览器 lane 需要系统已装 Edge / Chrome（不自动下载，见「常见问题」）。
测试计数会随测试增删变化，**以 verify 的实测输出为准**：最近一次为宿主 lane 478 项、
浏览器 lane 69 项，全绿。

**浏览器 lane 的变异纪律（`tools/lane-mutations.mjs`）**：lane 的断言必须能被证明**不是空跑**。
这个脚本把 `client/client.js` 里的实现按清单**故意改坏**（只写进 `os.tmpdir()` 的副本，仓库文件
一个字节都不动：开头结尾各算一次 sha256 比对），再让 lane 加载那份坏产物，**要求对应用例真的变红**。
三条纪律：① 每处 `find` 必须**恰好命中一次**（0 次=实现漂移了，多次=改错地方了，都当场报错退出）；
② 该红的没红 → 脚本**非零码退出**并逐条列出实际失败的用例名；③ 跑完丢弃临时产物。
**新增或改动 lane 断言时，请顺手给它配一条变异**，否则无法区分"断言有效"和"断言没跑"。

```sh
node tools/lane-mutations.mjs            # 跑全部
node tools/lane-mutations.mjs M3 M4      # 只跑指定 id（前缀匹配）
```

**客户端配色：只走 DSH 官方主题 token，不要写死颜色。**
`client/client.js` 的配色全部引用官方 `--dsw-*`（浅/深两套值由官方主题提供），所以深浅色主题
自动与官方一致；半透明用 `color-mix(in srgb, var(--dsw-…) X%, transparent)`。
源码里集中在 `T` / `tint()` / `shadow()` 三个常量上，加颜色只改那里。
**不要**从插件里 `require('@deepseek-ai/dsh-client-ui-primitives')`：官方明文禁止
（`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:35`），
而且该包是未打包 ESM + 38 个相对 `.module.css`，本插件手写 JS、没有构建步骤，loader 解析不了
—— 换组件的结果是**整个面板挂掉**，不是"只变丑"。官方认可的最低风险做法就是照抄 token
（同文件 `:34`：`a renamed token degrades appearance but never breaks rendering`）。
回归由三条测试锁住（静态扫描 / token 真的生效 / 深浅色跟随），详见
[docs/contract-notes.md](./docs/contract-notes.md) §19。

**客户端几何（控件尺寸）对齐官方**：官方**没有**尺寸 token（只有 `--dsw-radius-*` 这一族
圆角变量），所以圆角走 `var(--dsw-radius-*)`、高度/内边距/字号是**照抄官方 px**，
集中成 `S` 常量表（每个值带 `文件:行` 出处）。照抄的那半**不会**随官方升级自动跟随，
只有 `test/browser/sizes.test.mjs` 会变红提醒；作品库网格等**无官方对应物**的控件不强行对齐。
详见 [docs/contract-notes.md](./docs/contract-notes.md) §20。

---

## 目录结构

```
dsh-pixmart/
├── src/                 # host 半（TypeScript；**运行时零 `@deepseek-ai` 依赖**）
│   ├── index.ts         # 插件入口：注册工具 / 路由 / guidance / 只读接口
│   ├── config.ts        # 配置类型、出厂默认（**0 家厂商**）、容错解析
│   ├── catalog.ts       # 厂商目录（设置页「添加模型提供商」的数据源）
│   ├── routes.ts        # 设置页与作品库用的 HTTP 路由（只接受 GET / POST）
│   ├── sizes.ts         # 尺寸能力表（agnes 的档位与精确像素清单在这里）
│   ├── guidance.ts      # 给模型的系统提示段（计费纪律、省钱顺序）
│   ├── prompts/         # 24 个提示词模块（纯数据）+ 拼装器
│   ├── tools/           # 8 个 `pixmart_*` 工具的实现与共用运行时
│   ├── vendor/          # 厂商适配器（OpenAI 兼容 / gemini-native / 各方言）
│   ├── store/           # 配置 / 项目 / 运行 / 历史 的落盘（原子写 + 按路径互斥）
│   └── log/usage.ts     # usage.jsonl 追加式账本
├── client/              # client 半：手写 `client.js`（`window.__ModuleLoader__` 包装，无打包器、无 JSX）
│   └── client.js        #   **带 `__test__` 测试钩子**（测试从这里取组件；打包时被剥离）
├── dist/                # client 打包产物（剥离后的 client.js）—— **不入库**，见「打包与发布」
├── lib/                 # host 构建产物（`pnpm build` 的 tsc 输出）—— **不入库**
├── test/                # 宿主 lane：`node:test`（含 jsdom 子 lane）
│   └── browser/         # 浏览器 lane：真实排版引擎（Playwright + 系统 Edge/Chrome）
├── tools/               # 开发脚本：`strip-test-hooks.mjs`（打包剥离）、`lane-mutations.mjs`（变异验证）等
├── docs/                # 契约笔记 / 技术方案 / 验收记录 / 提案（见「文档索引」）
├── .probe/              # 只读取证素材（被 docs 按 `文件:行号` 引用）；`.gitignore` 忽略，**不要删**
├── pixmart-in/ · pixmart-out/   # 会话工作区里的进 / 出目录（`.gitignore` 忽略，见「产物在哪」）
├── cordis.patch.yml     # cordis 配置补丁（对应 `package.json` 的 `dsh.bundle.patch`）
└── package.json · tsconfig.json · .gitignore · README.md · NOTICE
```

---

## 打包与发布

**一句话现状**：打包**步骤**已经做完（`NOTICE` 已补、`exports["./client"]` 已切到 `dist/client.js`），
**发布**还没做（`private: true`、没有 `LICENSE`、版本仍是 `0.0.1`）。

### 包里的东西（`package.json` 的 `files`）

| 条目 | 是什么 | 怎么产生 |
|---|---|---|
| `lib` | host 半（`main` / `types` 都指向这里） | `pnpm build` = `tsc -p tsconfig.json` |
| `dist` | client 半（**已剥离**测试钩子） | `pnpm build:client` = `node tools/strip-test-hooks.mjs` |
| `client` | client 半**源码**（带 `__test__` 测试钩子） | 手写、入库；运行时不被引用，留着是为了让测试与变异能取组件 |
| `cordis.patch.yml` | cordis 配置补丁 | 手写、入库 |
| `README.md` / `NOTICE` | 文档 + 原创范围与第三方出处声明 | 手写、入库 |

两个入口：`exports["."]` → `./lib/index.js`（host 半），`exports["./client"]` → `./dist/client.js`（client 半）。

### 为什么要"构建"两步

- **host 半**有 `tsc`：`src/` → `lib/`；
- **client 半**没有打包器（手写 JS），"构建"指的是**剥离测试钩子**：`client/client.js` 里带着
  `const __test__ = {…}`（五套 `node:test` + 浏览器 lane 都靠它取组件），
  `pnpm build:client` 把它剥掉后写出 `dist/client.js`（`node --check` 通过、导出契约不变）。
  **源码保留钩子、打包时产出剥离版**——直接删源码会一次性打断所有测试，也就无法验证"剥离"本身。

### `dist/` 为什么**不入库**

产物可再生、源码才是真相（完整理由写在 `.gitignore` 的 `/dist/` 一节）。代价是：
**干净 checkout 或新装一份之后，第一次使用之前必须 `pnpm build:client`**，否则
`exports["./client"]` 指向的文件根本不存在。`pnpm test` 的 `pretest` 与发布时的 `prepack`
都会自动产出它；忘了重建会被 `test/strip-test-hooks.test.mjs` 的**陈旧性守卫**抓住
（dist 缺失 → 带可读原因跳过；dist 与当前 `client/client.js` 剥出来的字节不一致 → **直接失败**，
并提示跑 `pnpm build:client`）。

### 发布前待办（**都还没做**）

1. **去掉 `package.json` 的 `private: true`** —— npm 会拒绝发布 `private` 包；现在留着它是"明确不想误发"的护栏；
2. **补 `LICENSE` 文件** —— 现在只有 `package.json` 的 `"license": "MIT"` 与 [NOTICE](./NOTICE)，
   `files` 里也没有 `LICENSE`；NOTICE 已把它写成显式待办；
3. **定版本号**（现在 `0.0.1`）并补 `CHANGELOG`（暂无）；
4. **从零安装全链路（技术方案里的 A8）**：在全新 `DSH_HOME` 上跑 `dsh plugin add` → 构建 →
   设置页加厂商 → 真实生图 —— **尚未执行**；
5. 可选：把 `client`（源码，含测试钩子）从 `files` 里去掉，运行时只认 `dist`，包体更小。

---

## 文档索引

| 文档 | 是什么 |
|---|---|
| [docs/contract-notes.md](./docs/contract-notes.md) | **契约笔记**：§1–§41 —— 全部决策与真机证据（多数条目带复现方式）。**与其它文档冲突时以它为准**。 |
| [docs/dsh-pixmart-技术方案.md](./docs/dsh-pixmart-技术方案.md) | 技术方案：架构、契约、阶段划分、验证矩阵、打包与分发（§11.5 / §12.2） |
| [docs/a2-acceptance.md](./docs/a2-acceptance.md) | A2（真实生图落盘）验收记录 |
| [docs/提示词工程优化提案.md](./docs/提示词工程优化提案.md) | 提示词工程的后续优化提案（**待审核，未开工**） |
| [docs/并发与大批量出图方案.md](./docs/并发与大批量出图方案.md) | 并发与大批量出图的方案（**待审核，未开工**） |
| [docs/作品库优化方案.md](./docs/作品库优化方案.md) | 作品库后续优化（**待审核，未开工**） |
| [docs/蓝屏排查记录.md](./docs/蓝屏排查记录.md) | 开发机蓝屏的排查记录（与插件无直接关系，但排障时别重走一遍） |

---

## 许可

MIT（见 `package.json` 的 `"license"`）。提示词与实现均为本仓库原创；组织结构参考了
`pixmart-ai`（MIT）的「模块 → 片段」思路与供应商目录的**事实性转录**，**不含其任何代码或文本**
——完整声明见 [NOTICE](./NOTICE)，依据见技术方案 §15。
**本仓库目前没有独立的 `LICENSE` 文件**（发布前必须补，见「[打包与发布](#打包与发布)」）。

## 待办（尚未实现，已记录待补）

### T1. 账本要能证明"参考图真的传出去了"（可观测性）

**背景**：图生图真机验证时发现，出图是对的，但**账本自证不了**（见
[docs/contract-notes.md](./docs/contract-notes.md) §40.2）：

- `usage.jsonl` 只写 `apiMode`，**没有"本次用了 N 张参考图"**；
- `project.json` **不记录参考图路径**，作品库看不出这张图基于哪几张图；
- 适配器带**降级重试**（`src/vendor/openai-compat.ts` 的 fallback trail 里有一档
  `no-references`），而**账本不记录"成功的是哪一档"** —— 因此无法从账本排除"其实降级成了纯文生图"。

**要补的**：
1. `usage.jsonl` 增加**成功那一档的 label**（attempt label）与**参考图张数**；
2. `project.json` 记录**参考图路径**（作品库可显示"基于哪几张图"，也便于复现）。

### T2. 批量结果头部只显示一个尺寸（显示瑕疵，非数据错）

`pixmart_batch` 省略 `size` 时，结果头部打的是单个尺寸（例如 `尺寸：16:9`），但那只是**某一项**的尺寸；
实际每项各用自己的模块默认（contract-notes §41：16:9 / 3:4 / 3:4）。
**数据层是对的**（`project.json` 与 `usage.jsonl` 都逐项记录了正确尺寸），**只有那一行摘要会误导**。
建议：省略 `size` 时显示「各模块默认」，或逐项列出。

### 提案文档（已记录，未排期）

两份写好的提案都还**没有开工**，开工前先过一遍评审：

- [docs/提示词工程优化提案.md](./docs/提示词工程优化提案.md) —— 提示词工程（模块片段、变量、负向提示）的优化方向；
- [docs/并发与大批量出图方案.md](./docs/并发与大批量出图方案.md) —— 并发上限与大批量出图（超出 20 项、并发调度）的方案。

另有作品库方向的 [docs/作品库优化方案.md](./docs/作品库优化方案.md)（同样是待审核状态）。
**注意**：上述提案里的数字/接口若与 [docs/contract-notes.md](./docs/contract-notes.md) 冲突，以契约笔记为准。
