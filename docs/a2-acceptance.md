# A2 真实链路验收清单

> 重启宿主后按此逐项走。目标：证明「对话里说一句话 → 真实出图 → 落盘 → 卡片里看得见」。
> 前置：本插件已装入 `desktop` profile（`dsh-pixmart@0.0.1`，`link:E:/Programs/agent/dsh-pixmart`），
> 已用 git 提交到 `8ffe277`，工作树干净。

## 为什么需要重启

P0 实测结论（见 [contract-notes](./contract-notes.md) §1.5）：**插件安装会热生效，但 host 代码改动不会**。
当前 desktop 宿主里跑的还是 P0 那版（只有 `pixmart_ping`）；P1 的 5 个新工具要重启才会加载。

## 0. 重启后先自查（不需要 Key）

在会话里让我调用 `pixmart_ping`，或直接让我列出工具。**期望看到 6 个**：

| 工具 | 用途 |
|---|---|
| `pixmart_ping` | 自检：确认加载 + 列出宿主可用服务 |
| `pixmart_providers` | 厂商/模型/密钥状态（不回传密钥） |
| `pixmart_check_size` | 尺寸校验 + 最近邻（不发请求） |
| `pixmart_prompt` | 提示词 dry run（不发请求） |
| `pixmart_generate` | 文生图 |
| `pixmart_edit` | 图生图 / 风格复刻 / 白底图 |

`pixmart_ping` 里 `dataDir` 应显示 **`C:\Users\30461\.dsh\pixmart`**
（P0 发现 GUI 启动的宿主不设 `DSH_HOME`，已修为三级回落；若仍显示 profile 目录说明重启没加载到新代码）。

## 1. 填 Key（你来）

两种方式，任选：

- **环境变量**（推荐，密钥不落盘）：给宿主进程设置 `OFOX_API_KEY`，然后重启一次宿主。
- **落盘**：写进 `C:\Users\30461\.dsh\pixmart\config.json` 的 `providers[0].apiKey`。
  该文件不存在时会以出厂默认（一个未填 Key 的 Ofox）自动创建——**先让我跑一次 `pixmart_providers`**，
  它会触发配置落盘，你再去填 `apiKey` 字段即可。

> 还没有设置页 UI（P3 才做），所以这一步暂时靠改文件或环境变量。

## 2. 无花费的三步预演

1. `pixmart_providers` → 确认 `密钥 已就位(env)` 或 `已就位(config)`
2. `pixmart_prompt { module: "main.white-bg", size: "1:1" }` → 看最终提示词
3. `pixmart_check_size { size: "1:1" }` → 应 `supported: true`

## 3. 真实生图（产生费用，单张）

```
pixmart_generate { module: "main.white-bg", size: "1:1", project: "A2验收" }
```

**通过标准**

| # | 检查点 | 期望 |
|---|---|---|
| 1 | 工具返回 | `ok: true`，`provider: ofox`，`apiMode: gemini-native`（默认模型是 Gemini 图像系） |
| 2 | 文件落盘 | `C:\Users\30461\.dsh\pixmart\projects\A2验收*/images\*.png` 存在且 > 0 字节 |
| 3 | 对话卡片 | 文本摘要 **下方显示图片本身** |
| 4 | 尺寸 | 记录 `width`/`height`（Gemini 原生返回的像素由厂商决定，比例应为 1:1） |
| 5 | 无降级 | `degraded: []`；若非空，说明某参数被厂商拒绝，记下是哪个 |

## 4. 失败时看什么

| 现象 | 含义 | 处理 |
|---|---|---|
| `[no_api_key]` | Key 未生效 | 检查环境变量名是否为 `OFOX_API_KEY`，或 config.json 的 `apiKey` |
| `[auth]` | Key 无效 / 鉴权头不对 | Gemini 原生用 `x-goog-api-key`，兼容端点用 Bearer——记录返回体 |
| `[config] HTTP 404` | 端点或模型名不对 | 用 `pixmart_providers` 核对 `baseUrl` 与模型名 |
| `[moderation]` | 提示词被拒 | 换模块或改 `userPrompt` |
| 卡片只有文本没有图 | 附件服务被拒 | 看返回里的 `attachmentNote`，图片仍在磁盘上 |

## 5. 验收后

- 把结果（含 `degraded`、实际像素、`attachmentNote`）记进 [contract-notes](./contract-notes.md) §9.2
- 然后进入 **P2**：运行注册表 + 批量 + 项目库工具（实时预览的 host 半边）

## 回滚

```powershell
dsh plugin --profile desktop remove dsh-pixmart
```
