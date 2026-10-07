# Changelog

本文件记录本项目的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-07

**首个可在线安装的版本**（npm 包名 / GitHub 地址 / 本地目录三条路线，见 README 的「安装」与「发布」）。

### Added

- **8 个工具**：免费且不发厂商请求的 `pixmart_prompt` / `pixmart_check_size` / `pixmart_providers` /
  `pixmart_projects` / `pixmart_ping`；计费的 `pixmart_generate`（文生图）/ `pixmart_edit`（图生图、参考图保真、
  风格复刻、白底图）/ `pixmart_batch`（一套图批量出，每项独立成败）。
- **24 个提示词模块**（主图 5 / 详情图 14 / 广告 3 / 工具 2），片段全部为本仓库原创的英文提示词，界面标签为中文。
- **厂商目录 13 家** + 设置页「添加模型提供商」（目录挑选 / 自定义模型 API 两种 tab）、「拉取模型」、「测试连接」、
  「默认值」、「作品库导出路径」。密钥只以「是否就位」回显，永不回传前端或写进日志。
- **图生图与批量**：参考图保真、爆款风格迁移、基于参考图的纯白底；批量逐项记状态并逐格点亮。
- **真机验证**：Agnes AI（`agnes` 方言）1K / 2K / 3K / 4K 四档真实出图；Ofox（`ofox` 方言）真实出图。
- **作品库**：浏览 / 搜索 / 排序 / 分页 / 查看器 / 软删与回收站 / 导出到用户指定的绝对路径。
- **打包与分发**：`LICENSE`（MIT 全文）与 `NOTICE`（原创范围声明）；`exports["./client"]` 指向打包产物
  `dist/client.js`（剥离 `__test__` 测试钩子）；`prepare` 与 `prepack` 做同一条完整构建（`tsc` → `lib/`，
  再剥离 → `dist/`），因此 **git 安装与 npm 发布都自带预构建产物**。

### Changed

- **出厂不带任何厂商**：安装后 `providers` 为空、默认厂商/模型为空串，必须先在设置页添加一家并填 API Key。
- `package.json`：`0.0.1` → `0.1.0`，并**去掉 `private: true`**（可发布）；`files` 收敛为
  `lib` / `dist` / `cordis.patch.yml` / `LICENSE` / `README.md` / `NOTICE`（不再随包发 `client/` 源码）。

### Fixed

- **`prepack` 只产 `dist/`、不产 `lib/`** —— 而 `files` 里列了 `lib`，于是 `npm pack` 打出的包里**缺
  `lib/index.js`**，按包名安装会直接加载失败。现在 `prepack`（以及 `prepare`）会跑完整构建。
- 一个厂商都没配时，工具的报错从「厂商解析失败」改成可操作指引（去哪、点什么）。

## [0.0.1] - 2026-10-06

开发期的内部版本，`private: true`，**未发布**；仅通过本地路径安装验证功能（主链路、厂商适配、作品库、
四套测试 lane）。打包步骤当时尚未收尾，因此不做分发。

[0.1.0]: https://github.com/mirror9933/dsh-pixmart/releases/tag/v0.1.0
