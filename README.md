# dsh-pixmart

DeepSeek Harness 的**电商生图插件**：主图 / 详情图 / 广告图生成、风格复刻、作品库与生图实时预览。

- 状态：**P0（骨架 + 契约 spike）** 进行中
- 技术方案：[docs/dsh-pixmart-技术方案.md](./docs/dsh-pixmart-技术方案.md)
- P0 取证结论：[docs/contract-notes.md](./docs/contract-notes.md) ← **实现前必读，与方案冲突以它为准**

## 安装

```powershell
$dsh = 'E:\Program Files\deepseek harness\resources\runtime\cli\bin\dsh.cmd'

# 装进一个 scratch profile 验证（不要直接装进正在使用的 profile）
& $dsh plugin --profile px add <本仓库路径>
& $dsh --profile px --dump-config      # 断言出现 dsh-pixmart 层
```

`dsh plugin` 会自动把本包并入 profile 的 `dsh.profile.bundles`，无需手写 profile manifest。

> 注意：`dsh.cmd` 的退出码恒为 1（Electron-as-Node 启动方式所致），**不要用退出码判断成功**，看输出里的 `Done in …`。

## 自检

安装后可用 `pixmart_ping` 工具自检（确认插件已加载、工具注册链路可用、列出宿主服务）。

不需要模型凭据的落盘自检：

```powershell
$env:PIXMART_P0_MARKER = "$PWD\.probe\p0-marker.json"
$p = Start-Process -FilePath $dsh -ArgumentList '--profile','px' -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 16
Get-Content $env:PIXMART_P0_MARKER
taskkill /PID $p.Id /T /F     # 必须 /T；切勿按进程名杀（会误杀桌面端）
```

## 开发

```powershell
pnpm install
pnpm build        # tsc → lib/
pnpm typecheck
```

- host 半：`src/`（TypeScript，**运行时零 `@deepseek-ai` 依赖**）
- client 半：`client/client.js`（手写 `window.__ModuleLoader__` 包装，P0 不引入打包器）
- bundle 层：`cordis.patch.yml`
- 取证工具：`tools/asar.mjs`（读取 `app.asar` 内 DSH 源码）

## 许可

MIT。提示词与实现均为本仓库原创；组织结构参考了 `pixmart-ai`（MIT）的模块化思路，详见方案 §15。
