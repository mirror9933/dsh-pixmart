# Changelog

本文件记录本项目的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.2] - 2026-10-07

### Added

- npm 与仓库的关联元数据：`repository` / `homepage` / `bugs` / `keywords` / `author`
  （awesome-dsh-plugin 收录要求已发布包的 `repository` 指回被收录的仓库，否则两者不会关联）。
- 仓库添加 `dsh-plugin` topic。

## [0.1.1] - 2026-10-07

### Added

- 设置页底部加 GitHub 主页链接（`@mirror9933`）。
- `test/version.test.mjs`：三处版本号（`package.json` / `src/version.ts` / `client/client.js`）必须一致的机器检查。

### Fixed

- 版本号只在 `package.json` 改过，另两处仍留 0.0.1，导致设置页头部显示旧版本；现三处对齐，并由断言防再次漂移。
- README 安装口径改为主推「包名 / Release `.tgz`」，明确 GitHub 仓库地址**不推荐**（实测被 pnpm 11 构建闸门拦下）；
  并再删掉「待办 / 已知限制 / 发布」三节。
## [0.1.0] - 2026-10-07

**首个正式发布的版本**：已发布到 npm —— `dsh-pixmart@0.1.0`（103 files / 1.2 MB unpacked）；
同时在 GitHub Release [`v0.1.0`](https://github.com/mirror9933/dsh-pixmart/releases/tag/v0.1.0) 提供
`dsh-pixmart-0.1.0.tgz`（332 KB，**零闸门**、包内自带 `lib/` + `dist/`）。
安装的三种填法与推荐顺序见 README 的「安装」。

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
  再剥离 → `dist/`），因此 **npm 包与 Release `.tgz` 装完即自带 `lib/` + `dist/`**（`prepare` 保留给
  git / 本地目录安装；但 git 依赖在 pnpm 11 下会被构建闸门挡住，见 Fixed）。

### Changed

- **出厂不带任何厂商**：安装后 `providers` 为空、默认厂商/模型为空串，必须先在设置页添加一家并填 API Key。
- `package.json`：`0.0.1` → `0.1.0`，并**去掉 `private: true`**（可发布）；`files` 收敛为
  `lib` / `dist` / `cordis.patch.yml` / `LICENSE` / `README.md` / `CHANGELOG.md` / `NOTICE`
  （不再随包发 `client/` 源码）。

### Fixed

- **`prepack` 只产 `dist/`、不产 `lib/`** —— 而 `files` 里列了 `lib`，于是 `npm pack` 打出的包里**缺
  `lib/index.js`**，按包名安装会直接加载失败。现在 `prepack`（以及 `prepare`）会跑完整构建。
- **README 把「GitHub 仓库地址」写成安装填法，实测装不上** —— 它算 git 依赖，pnpm 11 会用构建闸门拦下
  `prepare`（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），而 pnpm 要的 `allowBuilds` **精确键含 commit sha**
  （每次提交都变），DSH 审批流写的却是裸包名 ⇒ 救不了。现已改为**主推包名与 Release `.tgz` 地址**，
  仓库地址明确标注「别填 / 不推荐」。
- 一个厂商都没配时，工具的报错从「厂商解析失败」改成可操作指引（去哪、点什么）。

## [0.0.1] - 2026-10-06

开发期的内部版本，`private: true`，**未发布**；仅通过本地路径安装验证功能（主链路、厂商适配、作品库、
四套测试 lane）。打包步骤当时尚未收尾，因此不做分发。

[0.1.2]: https://www.npmjs.com/package/dsh-pixmart/v/0.1.2
[0.1.1]: https://www.npmjs.com/package/dsh-pixmart/v/0.1.1
[0.1.0]: https://www.npmjs.com/package/dsh-pixmart/v/0.1.0
