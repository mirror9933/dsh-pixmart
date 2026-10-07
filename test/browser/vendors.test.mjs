/**
 * 浏览器 lane：**厂商 / 模型配置卡片对齐官方「模型」设置页**（2026-10-11）。
 *
 * ## 这份用例守什么
 *
 * 2026-10-11 把设置页的「厂商」卡片按 DSH 官方「模型」设置页
 * （`@deepseek-ai/dsh-client-ui-settings-models`）的**标记结构 + 内联 CSS** 重排。
 * 那次改造有两条互相拉扯的要求，缺一不可：
 *
 *   1. **不许丢东西**：用户明确要求保留三样 —— 「拉取模型」按钮、「测试连接」按钮、
 *      以及**拉取之后的模型列表**。样式统一最容易踩的坑就是"重排时把它们弄没了"，
 *      所以这里三条各自一条用例（`1.1` / `1.2` / `1.3`），而且断言是**行为级**的：
 *      按钮不只是"存在"，还要点得动、点下去真的发请求；列表不但要出现，条目数必须
 *      等于夹具给的模型数。
 *   2. **必须长得像官方**：卡片 / 区块 / 字段 / 模型列表行的**内边距、圆角、间距、字号**
 *      必须等于官方 `._3nPmjq_*` 那套取值（`2.x`）。取值在本文件里**独立复述**一遍
 *      （同源不同处），实现与用例任何一处漂移都会红。
 *
 * ## 官方取值从哪来（都在 app.asar 内联 CSS 里核过原文）
 *
 *   - `._3nPmjq_rowCard{border:.5px solid var(--dsw-alias-settings-card-stroke);
 *     background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);
 *     flex-direction:column;gap:12px;padding:12px 14px}`
 *   - `._3nPmjq_rows{flex-direction:column;gap:8px;margin:12px 0 0;padding:0;list-style:none}`
 *   - `._3nPmjq_rowHead{gap:10px}` / `._3nPmjq_rowIdentity{gap:6px}` /
 *     `._3nPmjq_rowName{font-size:14px;font-weight:500;line-height:22px}` /
 *     `._3nPmjq_rowTag{padding:1px 6px;font-size:11px;line-height:16px;
 *     border-radius:var(--dsw-radius-xs)}` / `._3nPmjq_credentialDot{width:8px;height:8px;
 *     border-radius:50%}`（已配置 = `state-success-primary`）
 *   - `._3nPmjq_editor{border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);
 *     gap:14px;padding:14px 16px}` / `._3nPmjq_editorActions{justify-content:flex-end;gap:8px}`
 *   - `._3nPmjq_modelCatalog{border-top:.5px solid var(--dsw-alias-border-l2);gap:10px;padding-top:12px}`
 *     / `._3nPmjq_modelCatalogTitle{font-size:12px;font-weight:500;line-height:18px}`
 *     / `._3nPmjq_modelCatalogMeta{font-size:12px;line-height:18px}`
 *   - `._3nPmjq_linkButton{height:28px;padding:0 10px;font-size:12px;line-height:18px;
 *     border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);border:none}`
 *     —— 官方「获取模型」（`fetchModels`）就是这一档，位置在模型区块标题行右侧。
 *   - 模型列表（多选）取官方**候选列表**那一套：
 *     `._3nPmjq_candidateList{gap:2px;padding:0;overflow-y:auto}`、
 *     `._3nPmjq_candidateLabel{gap:8px;padding:6px 8px;align-items:center;display:flex}`、
 *     `._3nPmjq_candidate{border-radius:var(--dsw-radius-md)}`、
 *     `._3nPmjq_candidateId{font-size:13px;text-overflow:ellipsis;white-space:nowrap;flex:auto}`。
 *     逐条来源与偏差见 `docs/contract-notes.md` §23。
 *
 * ## 与 sizes.test.mjs 的分工
 *
 * `sizes.test.mjs` 管"控件档位"（按钮 / 输入框 / 胶囊 / 卡片的内边距与圆角）；
 * 本文件管**这一张**卡片重排之后的**区块级**几何与那三个保留项。两条都会在
 * 反向变异里被证明不是空跑（`tools/lane-mutations.mjs` 的 `M37`~`M40`）。
 *
 * ## 2026-10-12：卡片改成"列表 + 点「编辑」展开"之后新增的 `3.x`
 *
 * 卡片默认收起之后，"先点 `[data-pxm-vendor-edit]` 把编辑器打开"是本文件所有用例的
 * **共同前置**——这是**结构性适配**，不是放宽：任何期望值（内边距 / 圆角 / 字号 /
 * 解析出来的颜色）一个字都没动。
 *
 * 新增 `3.x` 钉的是重构新增的那几处，官方取值同样逐条复述：
 *   - `:24` `._3nPmjq_rowActions ._3nPmjq_secondaryButton{border-radius:var(--dsw-radius-sm);
 *     height:28px;padding:0 10px;font-size:12px;line-height:18px}` ← 「编辑」
 *   - `:19` `._3nPmjq_secondaryButton{…border:.5px solid var(--dsw-alias-border-l3);
 *     background:0 0}` ← 「编辑」/「取消」的描边与透明填充
 *   - `:45-49` `._3nPmjq_customized` / `…Summary`（含 `[open]` 时箭头 `rotate(45deg)`）
 *   - `:16-17` `._3nPmjq_primaryButton{background:var(--dsw-alias-button-primary-fill);
 *     height:36px;padding:0 14px;14px/22px}` ← 「保存」
 *   - `:39` `._3nPmjq_addButton{border:1px dashed var(--dsw-alias-border-l3);
 *     border-radius:var(--dsw-radius-lg);min-width:180px;height:44px}`
 *
 * ## 2026-10-12（第二次）：虚线按钮改成**页内展开 add-card**，`3.7` / `3.7b` 重写
 *
 * 用户反馈"厂商 UI 与 DSH 官方不一致"：上一版把添加流程做成了**弹窗 + 卡片网格**
 * （参考实现那一套），而官方 `settings-models` 是**页内 add-card**。本次按官方返工，
 * 旧弹窗的锚点（`data-pxm-catalog*`）与 3.7 的网格 / 卡片几何断言**整条删除**，
 * 换成官方的 add-card 取值，全部出自 `.probe/models-css-pretty.txt`：
 *   - `:37-39` `_addBlock{gap:12px}` / `_addActions{display:flex}` / `_addButton{…}`
 *   - `:40-41` `_addModes{flex-direction:column;align-items:flex-start;gap:8px}` /
 *     `_addPanel{flex-direction:column;gap:14px}`（`:42` 的 `[hidden]{display:none}` 一起钉）
 *   - `:43` `_addCard{border-radius:var(--dsw-radius-lg);
 *     background:var(--dsw-alias-bg-module-platform);gap:14px;padding:14px 16px}`
 *   - `:44` `_addCard ._editor{background:0 0;padding:0}` ← **"卡中卡"的反向判据**
 *   - `:35` `_advancedHint{color:label-tertiary;font-size:12px;line-height:18px}`（两段 hint）
 *   - `:73-74` / `:78` `_input`（32px / `0 10px` / 14px-22px / `bg-layer-1` /
 *     `border-l4`）+ `select._input{max-width:240px}` + `_selectInput`
 *   - 分段控件来自 `dsh-client-ui-primitives/lib/SegmentedControl.module.css`：
 *     `.control{inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;
 *     border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}`
 *     / `.indicator{…background:var(--dsw-alias-bg-layer-1)}` / `.tab{height:28px;padding:0 16px;
 *     font-size:13px;line-height:20px;font-weight:500}`
 *
 * 反向变异 `M46-add-card-editor-surface`（编辑器挂回第二层底）与
 * `M47-add-on-select-posts`（选中即发请求）分别由 **3.7** / **3.7b** 抓住（跑 `tools/lane-mutations.mjs` 自证）。
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { startLaneServer, launchLaneBrowser } from './lane-server.mjs'

// ── 夹具 ────────────────────────────────────────────────────────────────────

/**
 * 拉取会回给我们的模型目录。**故意给 5 个**（不是 1 个）：条目数断言才有意义 ——
 * 只给 1 个的话"列表画出来了"与"列表画对了条数"分不出来。
 */
const PULLED = [
  'google/gemini-3.1-flash-image',
  'openai/gpt-image-1',
  'black-forest-labs/flux-1.1-pro',
  'qwen/qwen-image-edit',
  'text-embedding-3-large',
]

/**
 * 目录条目（宿主 `catalog[]` 的一项）—— 形状与 jsdom lane 的 `catalogEntry` 同源不同处：
 * `{id,label,baseUrl,group,imageCapable,note,added}`。
 */
const cat = (id, label, group, extra) => ({
  id,
  label,
  group,
  baseUrl: 'https://api.example.test/v1',
  imageCapable: true,
  note: '',
  added: false,
  ...(extra ?? {}),
})

/**
 * 20 条目录：8 official + 9 aggregator + 3 custom。
 *
 * 为什么这三张卡必须存在：3.7 要量**已添加**（置灰 `opacity:.5` + `disabled`）与
 * **未取证生图**（小角标）两种形态，夹具里没有的话那两条断言就是空转。
 */
const CATALOG = [
  cat('openai', 'OpenAI', 'official'),
  cat('anthropic', 'Anthropic', 'official', { imageCapable: false }),
  cat('google', 'Google', 'official', { added: true }),
  cat('azure', 'Azure OpenAI', 'official'),
  cat('mistral', 'Mistral', 'official'),
  cat('cohere', 'Cohere', 'official'),
  cat('xai', 'xAI', 'official'),
  cat('deepseek', 'DeepSeek', 'official'),
  cat('ofox', 'Ofox', 'aggregator', { added: true }),
  cat('siliconflow', 'SiliconFlow', 'aggregator'),
  cat('openrouter', 'OpenRouter', 'aggregator'),
  cat('together', 'Together', 'aggregator'),
  cat('fireworks', 'Fireworks', 'aggregator'),
  cat('replicate', 'Replicate', 'aggregator'),
  cat('fal', 'Fal', 'aggregator'),
  cat('novita', 'Novita', 'aggregator'),
  cat('dashscope', 'DashScope', 'aggregator'),
  cat('custom', '自定义', 'custom'),
  cat('custom-openai', '自定义（OpenAI 兼容）', 'custom'),
  cat('selfhost', '自建端点', 'custom', { imageCapable: false }),
]

/**
 * task-8：下拉**列出全部 20 家**（顺序 = `sortCatalog`：label 的 `zh-Hans-CN` 升序、
 * `custom` 那一组固定最后），默认选中"第一个未添加"的那家。
 * 夹具里已添加的是 google / ofox，所以第一个未添加的是 `anthropic`（label 'Anthropic' 最小）。
 * 这是**独立复述**：实现换了排序规则或又变成"过滤掉已添加"，这里就红。
 */
const FIRST_ADDABLE_ID = 'anthropic'

const providersFixture = {
  ok: true,
  dataDir: 'D:/pixmart',
  exportDir: '',
  defaults: { provider: 'ofox', model: 'openai/gpt-image-1', size: '1:1', n: 1 },
  usage: { requests: 1, ok: 1, failed: 0, images: 1 },
  historical: { images: 0, projects: 0, note: '' },
  // 厂商目录（task-4 §1 冻结形状，20 条）：3.7 量的那张「添加模型配置」弹窗靠它渲染。
  catalog: CATALOG,
  providers: [
    {
      id: 'ofox',
      label: 'Ofox',
      group: 'aggregator',
      apiMode: 'images-generations',
      baseUrl: 'https://api.example.test/v1',
      geminiNativeBaseUrl: '',
      dialect: 'standard',
      apiKeyEnv: '',
      hasApiKey: true,
      apiKeySource: 'config',
      models: ['openai/gpt-image-1'],
      allowedSizes: ['1:1'],
      sizeMode: 'whitelist',
      timeoutMs: 180000,
    },
  ],
}

/**
 * 写请求的响应（lane 的 `fixture.posts`，键是路径正则）。
 * `api/providers$` = 新增一家（**不含 `/` 后缀所以命不中 `…/delete`**）；
 * `/delete$` = 移除一家（task-4 §1：没有 DELETE 方法，走 POST）。
 */
const POSTS = {
  'refresh-models$': { ok: true, models: PULLED, count: PULLED.length },
  '/test$': { ok: true, latencyMs: 42, modelCount: PULLED.length },
  '/models$': { ok: true, count: 1 },
  'api/providers$': { ok: true, provider: { id: 'openai', label: 'OpenAI' } },
  '/delete$': { ok: true, removed: 'ofox', providers: [], defaults: { provider: '' } },
}

const fixture = () => ({ providers: providersFixture, projects: [], posts: POSTS })

// ── 官方取值（本文件独立复述；每条都带出处） ─────────────────────────────────

/** `._3nPmjq_rowCard` —— settings-models/lib/client.js:58 */
const OFFICIAL_CARD = {
  paddingTop: '12px',
  paddingRight: '14px',
  paddingBottom: '12px',
  paddingLeft: '14px',
  gap: '12px',
  flexDirection: 'column',
  /** `border-radius:var(--dsw-radius-xl)` —— 同处 */
  radiusVar: '--dsw-radius-xl',
  /** `border:.5px solid …` —— 同处（计算样式会被量化成 1px，只能断言声明值） */
  expectBorderTopWidth: '0.5px',
  /**
   * `border:.5px solid var(--dsw-alias-settings-card-stroke)`，而官方 theme 的 base CSS 里
   * `--dsw-alias-settings-card-stroke: var(--dsw-alias-border-l4)` —— 描边这一半挂的
   * `border-l4` 同样是那条规则的**别名目标**。
   */
  borderColorVar: '--dsw-alias-border-l4',
  /**
   * `background:var(--dsw-alias-settings-card-fill)`，而官方 theme 的 base CSS 里
   * `--dsw-alias-settings-card-fill: var(--dsw-alias-bg-layer-2)` —— 所以我们挂的
   * `bg-layer-2` 就是这条规则的**别名目标**（不是近似色）。
   */
  backgroundVar: '--dsw-alias-bg-layer-2',
}

/** `._3nPmjq_rows` —— 同处 */
const OFFICIAL_ROWS = {
  gap: '8px',
  marginTop: '12px',
  paddingTop: '0px',
  paddingRight: '0px',
  paddingBottom: '0px',
  paddingLeft: '0px',
  listStyleType: 'none',
  flexDirection: 'column',
}

/** 厂商标头那一行：rowHead / rowIdentity / rowName / rowTag / credentialDot —— 同处 */
const OFFICIAL_HEAD = {
  headGap: '10px',
  identityGap: '6px',
  nameFontSize: '14px',
  nameLineHeight: '22px',
  nameFontWeight: '500',
  tagPadTop: '1px',
  tagPadRight: '6px',
  tagPadBottom: '1px',
  tagPadLeft: '6px',
  tagFontSize: '11px',
  tagLineHeight: '16px',
  tagRadiusVar: '--dsw-radius-xs',
  dotSize: '8px',
  dotRadius: '50%',
  /** 已配置 → `background:var(--dsw-alias-state-success-primary)` */
  dotOkColorVar: '--dsw-alias-state-success-primary',
  actionsGap: '4px',
}

/** 编辑块与字段：`._3nPmjq_editor` / `._3nPmjq_editorActions` / `._3nPmjq_field` —— 同处 */
const OFFICIAL_EDITOR = {
  padTop: '14px',
  padRight: '16px',
  padBottom: '14px',
  padLeft: '16px',
  gap: '14px',
  radiusVar: '--dsw-radius-lg',
  /** `background:var(--dsw-alias-bg-module-platform)` —— 同处 */
  backgroundVar: '--dsw-alias-bg-module-platform',
  actionsGap: '8px',
  actionsJustify: 'flex-end',
}

/** 模型区块：`._3nPmjq_modelCatalog` / `…Title` / `…Meta` —— 同处 */
const OFFICIAL_CATALOG = {
  padTop: '12px',
  gap: '10px',
  titleFontSize: '12px',
  titleLineHeight: '18px',
  titleFontWeight: '500',
  metaFontSize: '12px',
  metaLineHeight: '18px',
}

/** 「拉取模型」= 官方 `._3nPmjq_linkButton`（同文件 :749-758 的 `fetchModels`） */
const OFFICIAL_LINK_BUTTON = {
  height: '28px',
  paddingTop: '0px',
  paddingRight: '10px',
  paddingBottom: '0px',
  paddingLeft: '10px',
  fontSize: '12px',
  lineHeight: '18px',
  radiusVar: '--dsw-radius-sm',
  /** `.linkButton{…border:none;background:0 0}` —— 官方链接式按钮没有描边 */
  expectNoBorder: true,
}

/** 模型列表行 = 官方候选列表那一套（同文件 :88-91） */
const OFFICIAL_MODEL_ROW = {  rowGap: '8px',
  rowPadTop: '6px',
  rowPadRight: '8px',
  rowPadBottom: '6px',
  rowPadLeft: '8px',
  rowDisplay: 'flex',
  rowAlignItems: 'center',
  rowRadiusVar: '--dsw-radius-md',
  nameFontSize: '13px',
  listGap: '2px',
  listOverflowY: 'auto',
  listPadTop: '0px',
  listPadLeft: '0px',
  /**
   * 滚动上限 = 官方值 `._3nPmjq_candidateList{max-height:320px}`
   * （`settings-backends`… 不，是 `settings-models/lib/client.js:58` 那一行内联 CSS）。
   *
   * 2026-10-12 修正偏差 ③：早先本插件取 240px，理由是"既有 jsdom 用例把它钉在 240px，
   * 改大等于放宽保证"—— 方向错了：目标是"与官方一致"，官方值就是标准，
   * 那条 jsdom 断言应当按官方值**更新**（更新断言 ≠ 放宽断言）。
   * "150 项不许把卡片撑爆"这条保证没有被削弱：`overflowY:auto` 与上限本身都还在
   * （见下面 2.3 里 `scrollHeight >= clientHeight` 那条互补断言）。
   */
  listMaxHeight: '320px',
}

/**
 * 行尾动作里那一枚「编辑」= 官方 `._3nPmjq_rowActions ._3nPmjq_secondaryButton`
 * （`.probe/models-css-pretty.txt:24`）：
 *   `{border-radius:var(--dsw-radius-sm);height:28px;padding:0 10px;font-size:12px;line-height:18px}`
 * 它的描边 / 填充来自 `._3nPmjq_secondaryButton`（同文件 :19）：
 *   `{border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);background:0 0}`
 * —— 与大号 `secondaryButton` 只差 `:24` 那一行的三个几何值，所以这里两者都要钉。
 */
const OFFICIAL_ROW_BUTTON = {
  height: '28px',
  paddingTop: '0px',
  paddingRight: '10px',
  paddingBottom: '0px',
  paddingLeft: '10px',
  fontSize: '12px',
  lineHeight: '18px',
  radiusVar: '--dsw-radius-sm',
  /** `border:.5px solid var(--dsw-alias-border-l3)` —— 同处（**不是**卡片用的 l4） */
  borderColorVar: '--dsw-alias-border-l3',
  /** `background:0 0` → 计算值就是全透明 */
  transparent: 'rgba(0, 0, 0, 0)',
}

/** `._3nPmjq_editorActions` 里那两枚：`…:16-19`（几何 + 配色）+ `:36`（对齐 / 间距） */
const OFFICIAL_EDITOR_BUTTON = {
  height: '36px',
  paddingTop: '0px',
  paddingRight: '14px',
  paddingBottom: '0px',
  paddingLeft: '14px',
  fontSize: '14px',
  lineHeight: '22px',
  radiusVar: '--dsw-radius-md',
  /** `._3nPmjq_primaryButton{background:var(--dsw-alias-button-primary-fill)}` —— :17 */
  saveFillVar: '--dsw-alias-button-primary-fill',
  /** `._3nPmjq_secondaryButton{border:.5px solid var(--dsw-alias-border-l3)}` —— :19 */
  cancelBorderVar: '--dsw-alias-border-l3',
  transparent: 'rgba(0, 0, 0, 0)',
}

/**
 * `._3nPmjq_customized` + `…Summary`（`.probe/models-css-pretty.txt:45-51`）：
 *   `{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px}` /
 *   `…Summary{border-radius:var(--dsw-radius-sm);cursor:pointer;width:fit-content;
 *    color:var(--dsw-alias-label-secondary);gap:6px;margin-left:-4px;padding:2px 4px;
 *    font-size:12px;font-weight:500;line-height:18px;list-style:none}`
 * 箭头是 `::before`（`:48` 收起 `rotate(-45deg)` / `:49` `[open]` 时 `rotate(45deg)`）。
 */
const OFFICIAL_CUSTOMIZED = {
  padTop: '10px',
  borderTopWidth: '0.5px',
  borderTopColorVar: '--dsw-alias-border-l2',
  summaryFontSize: '12px',
  summaryLineHeight: '18px',
  summaryFontWeight: '500',
  summaryWidth: 'fit-content',
  summaryColorVar: '--dsw-alias-label-secondary',
}

/**
 * 虚线「添加模型提供商」= 官方 `._3nPmjq_addButton`（`.probe/models-css-pretty.txt:37-39`）：
 *   `{border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);
 *     flex:1 1 0;gap:6px;min-width:180px;height:44px}`
 */
const OFFICIAL_ADD_BUTTON = {
  height: '44px',
  minWidth: '180px',
  borderTopStyle: 'dashed',
  radiusVar: '--dsw-radius-lg',
  borderColorVar: '--dsw-alias-border-l3',
}

/** 未配置密钥的圆点色：`._3nPmjq_credentialDotMissing{background:--dsw-alias-state-error-primary}`（:14） */
const DOT_MISSING_VAR = '--dsw-alias-state-error-primary'

// ── lane 启动 ───────────────────────────────────────────────────────────────

const server = await startLaneServer()
const launched = await launchLaneBrowser()
const ALLOW_SKIP = process.env.PXM_LANE_ALLOW_SKIP === '1'

const SKIP_BANNER = [
  '',
  '='.repeat(78),
  '  ⚠  浏览器 lane 已跳过 → 厂商卡片的样式对齐与三个保留项未经验证',
  '  ⚠  原因：本机没有可用的 Microsoft Edge / Google Chrome（playwright-core 不下载浏览器）',
  '     尝试过的 channel：' + (launched.failures.length === 0 ? '（无）' : launched.failures.join(' | ')),
  '  ⚠  修法：装 Edge/Chrome 后重跑；确实要在无浏览器机器上放行，用 PXM_LANE_ALLOW_SKIP=1',
  '='.repeat(78),
  '',
].join('\n')

if (launched.browser === null) {
  console.error(SKIP_BANNER)
  if (ALLOW_SKIP) {
    describe('浏览器 lane 前置（厂商卡片）', () => {
      it('SKIP：没有可用浏览器 → 样式与保留项未经验证', (t) => {
        t.skip('没有可用的 Edge/Chrome（PXM_LANE_ALLOW_SKIP=1 已显式放行）')
      })
    })
  } else {
    describe('浏览器 lane 前置（厂商卡片）', () => {
      it('必须有可用的系统 Edge/Chrome', () => {
        assert.fail(SKIP_BANNER)
      })
    })
  }
  await server.close()
} else {
  const browser = launched.browser

  after(async () => {
    await browser.close()
    await server.close()
  })

  const probe = (page, name, arg = null) =>
    page.evaluate(([fn, value]) => window.__pxmLane[fn](value), [name, arg])
  const probeArgs = (page, name, args) =>
    page.evaluate(([fn, list]) => window.__pxmLane[fn].apply(null, list), [name, args])

  /**
   * 开一个真页面：真 HTTP 源 + 真 shell 骨架 + 原产物 client.js，挂设置页。
   *
   * `overrides` 用来换夹具的某一块（例如把 `providers` 换成"没配密钥"的那份），
   * 不动其余默认值。
   */
  async function openVendorLane(overrides) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const problems = []
    page.on('pageerror', (err) => problems.push('pageerror: ' + err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push('console.error: ' + msg.text())
    })
    await page.goto(server.origin + '/shell.html', { waitUntil: 'load' })
    const payload = fixture()
    if (overrides !== undefined) Object.assign(payload, overrides)
    await page.evaluate((data) => window.__pxmLane.install(data), payload)
    await page.evaluate(() => window.__pxmLane.mount('settings.section'))
    // 设置页要等取数回来才画卡片。
    await page.waitForSelector('[data-pxm-vendor-card]', { timeout: 15000 })
    /*
     * 2026-10-12 结构变化的**统一前置**：卡片默认收起，编辑器（字段 / 模型区 /
     * 底部动作）点「编辑」才渲染。本文件所有 vendor 用例先展开再量/再点。
     */
    await page.click('[data-pxm-vendor-edit]')
    await page.waitForSelector('[data-pxm-editor]', { timeout: 10000 })
    /*
     * 请求记录由 **lane** 交出来，而不是 `page.on('request')`：插件的 `window.fetch`
     * 被 lane 换成了夹具路由，浏览器侧**没有真实网络请求**，Playwright 的请求事件
     * 什么都看不到（实测：`posts` 恒为空数组）。
     */
    const calls = () => probe(page, 'fetchCalls')
    return { page, context, problems, calls }
  }

  /** 让浏览器把 `var(--dsw-*)` 现场解析成具体值（颜色 / 长度都用它）。 */
  async function resolveVars(page, items) {
    return probeArgs(page, 'resolveCss', [items])
  }

  /** 官方**颜色**变量在**当前主题**下的解析值。 */
  async function resolveColors(page, keys) {
    return resolveVars(
      page,
      keys.map((item) => ({ key: item.key, prop: item.prop ?? 'backgroundColor', value: 'var(' + item.token + ')' })),
    )
  }

  /** 官方**长度**变量（圆角）的解析值。 */
  async function resolveRadii(page, varNames) {
    return probeArgs(
      page,
      'resolveSize',
      [varNames.map((name) => ({ key: name, prop: 'width', value: 'var(' + name + ')' }))],
    )
  }

  /**
   * 声明值那一半：`0.5px` 的发丝线在 Chromium DPR=1 下计算值被量化成 `1px`，
   * 所以只能断言**声明值**（与 `sizes.test.mjs` 的 `borderDiff` 同一处理）。
   */
  function declaredBorderOf(metrics) {
    const declared = metrics.declared ?? {}
    const raw = metrics.declaredBorder ?? {}
    return {
      shorthand: String(raw.shorthand ?? ''),
      topShorthand: String(raw.topShorthand ?? ''),
      topWidth: String(raw.topWidth ?? ''),
      longhand: declared.borderTopWidth,
      border: declared.border,
      borderTop: declared.borderTop,
    }
  }

  function expectDeclaredBorder(metrics, want, where) {
    const got = declaredBorderOf(metrics)
    const startsWith = (value) => typeof value === 'string' && value.indexOf(want) === 0
    const ok =
      got.longhand === want ||
      got.topWidth === want ||
      startsWith(got.border) ||
      startsWith(got.borderTop) ||
      startsWith(got.shorthand) ||
      startsWith(got.topShorthand)
    assert.ok(
      ok,
      where + ' 声明的边框宽度：实测 ' + JSON.stringify(got) + '，官方 ' + want,
    )
  }

  /**
   * "没有描边"这一条：官方链接式按钮写的是 `.linkButton{…border:none}` ——
   * 它是**显式声明成没有**，不是"从未写过边框"。两种形态都算通过：
   *   - `border: none`（我们与官方同款）→ 简写读回 `none`、宽度读回空或 `0px`；
   *   - 从未声明过 → 简写为空、宽度为 UA 初始值 `medium`。
   * 真正要挡住的是"给它加了一根看得见的描边"（例如 `1px solid …`）。
   */
  function expectNoVisibleBorder(metrics, where) {
    const got = declaredBorderOf(metrics)
    const noneDeclared = got.shorthand === '' || got.shorthand === 'none'
    const noWidth = got.topWidth === '' || got.topWidth === 'medium' || got.topWidth === '0px'
    assert.ok(
      noneDeclared && noWidth,
      where + ' 不该有描边（官方 `.linkButton{…border:none}`），实测 ' + JSON.stringify(got),
    )
  }

  /** 不由**计算样式**承担的键（圆角 / 底色走变量、描边走声明值）——只比计算样式。 */
  const NOT_COMPUTED = new Set([
    'radiusVar',
    'backgroundVar',
    'borderColorVar',
    'expectBorderTopWidth',
    'expectNoBorder',
    /** `background:0 0` 的透明填充：单独用 `assert.equal(backgroundColor, 'rgba(0, 0, 0, 0)')` 断 */
    'transparent',
    /** 官方配色 token 的名字（值要靠 `resolveColors` 现场解析，不是字面量） */
    'saveFillVar',
    'cancelBorderVar',
  ])

  /** 一组"必须等于官方"的字段 → 逐条 diff（失败信息带实测值）。 */
  function diffOf(measured, expect, where) {
    const bad = []
    for (const [prop, want] of Object.entries(expect)) {
      if (NOT_COMPUTED.has(prop)) continue
      const got = measured[prop]
      if (got !== want) {
        bad.push(where + ' 的 ' + prop + '：实测 ' + String(got) + '，官方 ' + String(want))
      }
    }
    return bad
  }

  /** 圆角：计算值必须等于 `var(--dsw-radius-*)` 在**本页**的解析值。 */
  function radiusDiff(measured, varName, resolved, where) {
    const parsed = resolved[varName]
    if (measured.borderRadius === parsed) return []
    return [
      where + ' 的 borderRadius：实测 ' + String(measured.borderRadius) +
        '，官方 var(' + varName + ') 的解析值 ' + String(parsed),
    ]
  }

  /** 颜色：计算值必须等于该 token 在**当前主题**下的解析值。 */
  function colorDiff(measured, prop, token, resolved, where) {
    const parsed = resolved[token]
    if (measured[prop] === parsed) return []
    return [
      where + ' 的 ' + prop + '：实测 ' + String(measured[prop]) +
        '，官方 var(' + token + ') 的解析值 ' + String(parsed),
    ]
  }

  /**
   * 重构新增那几处的**事实**（只有事实，判断在用例里）。
   *
   * 为什么自己 evaluate 而不是加 `lane.js` 的探针：`lane.js` 是**共用** harness，
   * 这四个区块（编辑按钮 / 自定义设置 / 保存取消 / 添加按钮）只有本文件消费，
   * 放这里改动面最小（且 lane.js 的 `vendorFacts` 已经负责卡片与三个保留项）。
   *
   * 一次取完所有需要的量，避免多次往返（这台机器近期反复蓝屏，命令越少越好）。
   */
  async function refactorFacts(page) {
    return page.evaluate(() => {
      const dump = (el) => {
        if (el === null || el === undefined) return null
        const cs = window.getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return {
          tag: el.tagName,
          text: (el.textContent || '').trim().slice(0, 40),
          disabled: el.disabled === true,
          rect: { width: r.width, height: r.height },
          display: cs.display,
          flexDirection: cs.flexDirection,
          alignItems: cs.alignItems,
          justifyContent: cs.justifyContent,
          gap: cs.gap,
          paddingTop: cs.paddingTop,
          paddingRight: cs.paddingRight,
          paddingBottom: cs.paddingBottom,
          paddingLeft: cs.paddingLeft,
          marginTop: cs.marginTop,
          marginRight: cs.marginRight,
          marginBottom: cs.marginBottom,
          marginLeft: cs.marginLeft,
          fontSize: cs.fontSize,
          lineHeight: cs.lineHeight,
          fontWeight: cs.fontWeight,
          color: cs.color,
          backgroundColor: cs.backgroundColor,
          borderRadius: cs.borderRadius,
          borderTopWidth: cs.borderTopWidth,
          borderTopStyle: cs.borderTopStyle,
          borderTopColor: cs.borderTopColor,
          width: cs.width,
          height: cs.height,
          minWidth: cs.minWidth,
          listStyleType: cs.listStyleType,
          /** 声明值里那几项计算样式读不出来的（`fit-content` 会被解析成用后的 px） */
          declaredWidth: el.style.width,
          declaredBorder: el.style.getPropertyValue('border'),
          declaredBorderTop: el.style.getPropertyValue('border-top'),
          declaredBorderTopWidth: el.style.getPropertyValue('border-top-width'),
        }
      }
      const text = (el, want) =>
        el === null
          ? null
          : Array.prototype.find.call(
              el.querySelectorAll('button'),
              (b) => (b.textContent || '').trim() === want,
            ) || null
      const card = document.querySelector('[data-pxm-vendor-card]')
      const actions = card === null ? null : card.querySelector('[data-pxm-vendor-actions]')
      const edit =
        actions === null ? null : actions.querySelector('[data-pxm-vendor-edit]') || text(actions, '编辑')
      const details = card === null ? null : card.querySelector('[data-pxm-vendor-customized]')
      const summary = details === null ? null : details.querySelector('summary')
      const editorActions = card === null ? null : card.querySelector('[data-pxm-editor-actions]')
      const addButton =
        document.querySelector('[data-pxm-add-vendor]') ||
        Array.prototype.find.call(
          document.querySelectorAll('button'),
          (b) => (b.textContent || '').indexOf('添加模型提供商') >= 0,
        ) ||
        null
      /**
       * 箭头 = summary 上**真正带动画的那一处** `transform`。官方用 `::before` 画
       * （`.probe/models-css-pretty.txt:48-49`），本插件的内联样式表达不了伪元素，
       * 所以两处都收：伪元素（若实现走样式表）与 summary 内第一个带 transform 的真实元素。
       */
      const arrowTransforms = (el) => {
        if (el === null) return null
        const out = {}
        const pseudo = window.getComputedStyle(el, '::before').transform
        if (pseudo !== undefined && pseudo !== '' && pseudo !== 'none') out.pseudo = pseudo
        Array.prototype.forEach.call(el.querySelectorAll('*'), (kid) => {
          const t = window.getComputedStyle(kid).transform
          if (t !== undefined && t !== '' && t !== 'none') {
            out.child = (out.child === undefined ? '' : out.child + '|') + t
          }
        })
        return out
      }
      return {
        rows: dump(card === null ? null : card.parentElement),
        edit: dump(edit),
        details: dump(details),
        detailsOpen: details === null ? null : details.open === true,
        summary: dump(summary),
        summaryArrow: arrowTransforms(summary),
        editorActions: dump(editorActions),
        save: dump(editorActions === null ? null : editorActions.querySelector('[data-pxm-vendor-save]') || text(editorActions, '保存')),
        cancel: dump(editorActions === null ? null : editorActions.querySelector('[data-pxm-vendor-cancel]') || text(editorActions, '取消')),
        addButton: dump(addButton),
      }
    })
  }

  // ── 1. 三个保留项 ─────────────────────────────────────────────────────────

  describe('1. 保留项（改样式不许把它们弄没）', () => {
    it('1.1 「拉取模型」按钮存在、可点，点下去真的发 refresh-models', async () => {
      const { page, context, problems, calls } = await openVendorLane()
      try {
        const facts = await probe(page, 'vendorFacts')
        assert.ok(facts !== null, '必须能定位厂商卡片（[data-pxm-vendor-card]）')
        const button = facts.fetchButton
        assert.ok(button !== null && button.present === true, '卡片上必须有「拉取模型」按钮')
        assert.equal(button.tag, 'BUTTON', '「拉取模型」必须是原生 button（Tab / Enter 才有原生行为）')
        assert.equal(button.text, '拉取模型', '「拉取模型」的文案不许改：' + JSON.stringify(button))
        assert.equal(button.disabled, false, '「拉取模型」默认必须是可点的')

        await page.click('[data-pxm-role="fetch-models"]')
        await page.waitForSelector('[data-pxm-model-row]', { timeout: 10000 })

        const all = await calls()
        const refreshPosts = all.filter(
          (call) => call.method === 'POST' && /refresh-models$/.test(call.url),
        )
        assert.equal(
          refreshPosts.length,
          1,
          '点「拉取模型」必须发一次 POST …/refresh-models，实际：' + JSON.stringify(all),
        )
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('1.2 「测试连接」按钮存在、可点，点下去真的发 /test 并给出成功文案', async () => {
      const { page, context, problems, calls } = await openVendorLane()
      try {
        const facts = await probe(page, 'vendorFacts')
        assert.ok(facts !== null, '必须能定位厂商卡片（[data-pxm-vendor-card]）')
        const button = facts.testButton
        assert.ok(button !== null && button.present === true, '卡片上必须有「测试连接」按钮')
        assert.equal(button.tag, 'BUTTON', '「测试连接」必须是原生 button')
        assert.equal(button.text, '测试连接', '「测试连接」的文案不许改：' + JSON.stringify(button))
        assert.equal(button.disabled, false, '「测试连接」默认必须是可点的')

        await page.click('[data-pxm-role="test-connection"]')
        await page.waitForFunction(
          () => (document.body.textContent || '').indexOf('连接正常') >= 0,
          null,
          { timeout: 10000 },
        )

        const all = await calls()
        const testPosts = all.filter((call) => call.method === 'POST' && /\/test$/.test(call.url))
        assert.equal(
          testPosts.length,
          1,
          '点「测试连接」必须发一次 POST …/test，实际：' + JSON.stringify(all),
        )
        assert.ok(
          (await page.evaluate(() => document.body.textContent)).includes('连接正常'),
          '成功时必须回显结果文案（语义保持现状）',
        )
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('1.3 拉取之后的模型列表出现，且条目数 == 夹具给的模型数', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        const before = await probe(page, 'vendorFacts')
        assert.equal(before.rowCount, 0, '还没拉取时不该有模型列表行')

        await page.click('[data-pxm-role="fetch-models"]')
        await page.waitForSelector('[data-pxm-model-list]', { timeout: 10000 })

        const after = await probe(page, 'vendorFacts')

        assert.ok(after.list !== null, '拉取后必须出现模型列表（[data-pxm-model-list]）')
        assert.equal(
          after.rowCount,
          PULLED.length,
          '拉取后列表的条目数必须等于夹具给的模型数（' + String(PULLED.length) + '）：实测 ' +
            String(after.rowCount),
        )
        const texts = after.rows.map((row) => row.text)
        for (const name of PULLED) {
          assert.ok(
            texts.some((text) => text.indexOf(name) >= 0),
            '列表里必须有模型「' + name + '」，实测：' + JSON.stringify(texts),
          )
        }
        // 多选能力落在**每一行自己的选择控件**上（我们这一块要"选择保留哪些模型"）。
        const withoutCheckbox = after.rows.filter((row) => row.hasCheckbox !== true)
        assert.deepEqual(
          withoutCheckbox,
          [],
          '每一行都必须有自己的选择控件（checkbox）：' + JSON.stringify(withoutCheckbox),
        )
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })
  })

  // ── 2. 样式对齐 ───────────────────────────────────────────────────────────

  describe('2. 样式对齐：等于官方「模型」页的取值', () => {
    it('2.1 厂商卡片 = 官方 ._3nPmjq_rowCard（12px 14px / gap 12px / radius-xl / 0.5px 描边 / settings-card-fill）', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        const facts = await probe(page, 'vendorFacts')
        const radii = await resolveRadii(page, [OFFICIAL_CARD.radiusVar])
        const colors = await resolveColors(page, [{ key: OFFICIAL_CARD.backgroundVar, token: OFFICIAL_CARD.backgroundVar }])
        const borderColors = await resolveColors(page, [
          { key: OFFICIAL_CARD.borderColorVar, token: OFFICIAL_CARD.borderColorVar, prop: 'borderTopColor' },
        ])

        const bad = diffOf(facts.card, OFFICIAL_CARD, '厂商卡片')
          .concat(radiusDiff(facts.card, OFFICIAL_CARD.radiusVar, radii, '厂商卡片'))
          .concat(
            colorDiff(
              facts.card,
              'backgroundColor',
              OFFICIAL_CARD.backgroundVar,
              colors,
              '厂商卡片',
            ),
          )
          .concat(
            colorDiff(
              facts.card,
              'borderTopColor',
              OFFICIAL_CARD.borderColorVar,
              borderColors,
              '厂商卡片',
            ),
          )
        assert.deepEqual(bad, [], '厂商卡片与官方 rowCard 不一致：\n' + bad.join('\n'))
        expectDeclaredBorder(facts.card, OFFICIAL_CARD.expectBorderTopWidth, '厂商卡片')

        // 卡片是**列表项**：官方把每一家厂商放在 `ul.rows` 的一个 `li.rowCard` 里。
        assert.equal(facts.card.tag, 'LI', '厂商卡片必须是 <li>（官方 ul.rows 的列表项）')
        // 列表容器：2026-10-12 起按**父节点**取（卡片自己知道它住在哪个 `ul.rows` 里），
        // 这样断言不依赖列表上挂的类名。
        const refactor = await refactorFacts(page)
        const rowsBad = diffOf(refactor.rows, OFFICIAL_ROWS, '厂商列表（ul.rows）')
        assert.deepEqual(rowsBad, [], '厂商列表与官方 ._3nPmjq_rows 不一致：\n' + rowsBad.join('\n'))
        assert.equal(refactor.rows.tag, 'UL', '厂商列表必须是 <ul>（官方 rows 是 ul）')

        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('2.2 标头 / 编辑块 / 模型区块 = 官方 rowHead + editor + modelCatalog', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        const facts = await probe(page, 'vendorFacts')
        const radii = await resolveRadii(page, [
          OFFICIAL_HEAD.tagRadiusVar,
          OFFICIAL_EDITOR.radiusVar,
        ])
        const colors = await resolveColors(page, [
          { key: OFFICIAL_HEAD.dotOkColorVar, token: OFFICIAL_HEAD.dotOkColorVar },
          { key: OFFICIAL_EDITOR.backgroundVar, token: OFFICIAL_EDITOR.backgroundVar },
          // 两枚"不许退回去"的对照面（见下面编辑块底色的反向断言）
          { key: 'bgBase', token: '--dsw-alias-bg-base' },
          { key: 'bgLayer1', token: '--dsw-alias-bg-layer-1' },
        ])

        const bad = []
        // ── 标头：rowHead / rowIdentity / rowName / rowTag / credentialDot
        bad.push(...diffOf({ gap: facts.head.gap }, { gap: OFFICIAL_HEAD.headGap }, '标头行'))
        bad.push(...diffOf({ gap: facts.identity.gap }, { gap: OFFICIAL_HEAD.identityGap }, '标头标识组'))
        bad.push(
          ...diffOf(
            facts.name,
            {
              fontSize: OFFICIAL_HEAD.nameFontSize,
              lineHeight: OFFICIAL_HEAD.nameLineHeight,
              fontWeight: OFFICIAL_HEAD.nameFontWeight,
            },
            '厂商名',
          ),
        )
        bad.push(
          ...diffOf(
            facts.tag,
            {
              paddingTop: OFFICIAL_HEAD.tagPadTop,
              paddingRight: OFFICIAL_HEAD.tagPadRight,
              paddingBottom: OFFICIAL_HEAD.tagPadBottom,
              paddingLeft: OFFICIAL_HEAD.tagPadLeft,
              fontSize: OFFICIAL_HEAD.tagFontSize,
              lineHeight: OFFICIAL_HEAD.tagLineHeight,
            },
            '厂商标识小标签',
          ),
        )
        bad.push(...radiusDiff(facts.tag, OFFICIAL_HEAD.tagRadiusVar, radii, '厂商标识小标签'))
        const dot = facts.dot
        assert.ok(dot !== null && dot !== undefined, '标头必须有凭据状态点（[data-pxm-credential-dot]）')
        if (dot.rect.width !== 8 || dot.rect.height !== 8) {
          bad.push('凭据状态点的真实几何：实测 ' + JSON.stringify(dot.rect) + '，官方是 8×8')
        }
        bad.push(...diffOf({ borderRadius: dot.borderRadius }, { borderRadius: OFFICIAL_HEAD.dotRadius }, '凭据状态点'))
        bad.push(
          ...colorDiff(dot, 'backgroundColor', OFFICIAL_HEAD.dotOkColorVar, colors, '凭据状态点'),
        )
        bad.push(...diffOf({ gap: facts.actions.gap }, { gap: OFFICIAL_HEAD.actionsGap }, '行尾动作组'))

        // ── 编辑块：editor（内边距 / 圆角 / 底色 / 间距）+ editorActions
        bad.push(
          ...diffOf(
            {
              paddingTop: facts.editor.paddingTop,
              paddingRight: facts.editor.paddingRight,
              paddingBottom: facts.editor.paddingBottom,
              paddingLeft: facts.editor.paddingLeft,
              gap: facts.editor.gap,
            },
            {
              paddingTop: OFFICIAL_EDITOR.padTop,
              paddingRight: OFFICIAL_EDITOR.padRight,
              paddingBottom: OFFICIAL_EDITOR.padBottom,
              paddingLeft: OFFICIAL_EDITOR.padLeft,
              gap: OFFICIAL_EDITOR.gap,
            },
            '编辑块',
          ),
        )
        bad.push(...radiusDiff(facts.editor, OFFICIAL_EDITOR.radiusVar, radii, '编辑块'))
        bad.push(
          ...colorDiff(facts.editor, 'backgroundColor', OFFICIAL_EDITOR.backgroundVar, colors, '编辑块'),
        )
        /*
         * 底色这一条还要求**反向**成立：官方 `._3nPmjq_editor` 是
         * `background:var(--dsw-alias-bg-module-platform)`，不能退回应用底色 `bg-base`，
         * 也不能退回输入控件那一层 `bg-layer-1`（`._3nPmjq_input{background:…bg-layer-1}`）。
         * 只看"等于 bg-module-platform"是不够的：夹具若把两枚 token 解成同一个值，
         * 上面的相等断言会同时成立、缺陷形态被掩盖。
         */
        for (const [key, label] of [['bgBase', 'bg-base'], ['bgLayer1', 'bg-layer-1']]) {
          assert.notEqual(
            facts.editor.backgroundColor,
            colors[key],
            '编辑块的底色不得等于 ' + label + '（官方 editor 用的是 bg-module-platform）',
          )
        }
        bad.push(
          ...diffOf(
            { gap: facts.editorActions.gap, justifyContent: facts.editorActions.justifyContent },
            { gap: OFFICIAL_EDITOR.actionsGap, justifyContent: OFFICIAL_EDITOR.actionsJustify },
            '编辑块动作行',
          ),
        )

        // ── 模型区块：modelCatalog + 标题 / 说明那一列
        bad.push(
          ...diffOf(
            { paddingTop: facts.catalog.paddingTop, gap: facts.catalog.gap },
            { paddingTop: OFFICIAL_CATALOG.padTop, gap: OFFICIAL_CATALOG.gap },
            '模型区块',
          ),
        )
        expectDeclaredBorder(facts.catalog, '0.5px', '模型区块上边线')
        bad.push(
          ...diffOf(
            facts.catalogTitle,
            {
              fontSize: OFFICIAL_CATALOG.titleFontSize,
              lineHeight: OFFICIAL_CATALOG.titleLineHeight,
              fontWeight: OFFICIAL_CATALOG.titleFontWeight,
            },
            '模型区块标题',
          ),
        )
        bad.push(
          ...diffOf(
            facts.catalogMeta,
            {
              fontSize: OFFICIAL_CATALOG.metaFontSize,
              lineHeight: OFFICIAL_CATALOG.metaLineHeight,
            },
            '模型区块说明',
          ),
        )

        assert.deepEqual(bad, [], '厂商卡片各区块与官方取值不一致：\n' + bad.join('\n'))
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('2.3 模型列表 = 官方候选列表；每一行 = 官方 .candidateLabel（6px 8px / gap 8px / radius-md / 13px）', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        await page.click('[data-pxm-role="fetch-models"]')
        await page.waitForSelector('[data-pxm-model-list]', { timeout: 10000 })

        const facts = await probe(page, 'vendorFacts')
        const radii = await resolveRadii(page, [OFFICIAL_MODEL_ROW.rowRadiusVar])

        assert.ok(facts.list !== null, '必须能定位模型列表容器（[data-pxm-model-list]）')
        const listBad = diffOf(
          {
            display: facts.list.display,
            flexDirection: facts.list.flexDirection,
            gap: facts.list.gap,
            overflowY: facts.list.overflowY,
            paddingTop: facts.list.paddingTop,
            paddingRight: facts.list.paddingRight,
            paddingBottom: facts.list.paddingBottom,
            paddingLeft: facts.list.paddingLeft,
            maxHeight: facts.list.maxHeight,
          },
          {
            display: 'flex',
            flexDirection: 'column',
            gap: OFFICIAL_MODEL_ROW.listGap,
            overflowY: OFFICIAL_MODEL_ROW.listOverflowY,
            paddingTop: OFFICIAL_MODEL_ROW.listPadTop,
            paddingRight: OFFICIAL_MODEL_ROW.listPadTop,
            paddingBottom: OFFICIAL_MODEL_ROW.listPadTop,
            paddingLeft: OFFICIAL_MODEL_ROW.listPadLeft,
            maxHeight: OFFICIAL_MODEL_ROW.listMaxHeight,
          },
          '模型列表容器',
        )
        assert.deepEqual(listBad, [], '模型列表容器与官方 .candidateList 不一致：\n' + listBad.join('\n'))
        assert.ok(
          facts.list.scrollHeight >= facts.list.clientHeight,
          '列表必须是**内部滚动**的容器（150 项不许把卡片撑爆）：' + JSON.stringify(facts.list),
        )

        const rowsBad = []
        for (const row of facts.rows) {
          rowsBad.push(
            ...diffOf(
              {
                display: row.display,
                alignItems: row.alignItems,
                gap: row.gap,
                paddingTop: row.paddingTop,
                paddingRight: row.paddingRight,
                paddingBottom: row.paddingBottom,
                paddingLeft: row.paddingLeft,
                fontSize: row.fontSize,
              },
              {
                display: OFFICIAL_MODEL_ROW.rowDisplay,
                alignItems: OFFICIAL_MODEL_ROW.rowAlignItems,
                gap: OFFICIAL_MODEL_ROW.rowGap,
                paddingTop: OFFICIAL_MODEL_ROW.rowPadTop,
                paddingRight: OFFICIAL_MODEL_ROW.rowPadRight,
                paddingBottom: OFFICIAL_MODEL_ROW.rowPadBottom,
                paddingLeft: OFFICIAL_MODEL_ROW.rowPadLeft,
                fontSize: OFFICIAL_MODEL_ROW.nameFontSize,
              },
              '模型行「' + row.text + '」',
            ),
          )
          rowsBad.push(...radiusDiff(row, OFFICIAL_MODEL_ROW.rowRadiusVar, radii, '模型行「' + row.text + '」'))
        }
        assert.deepEqual(rowsBad, [], '模型行与官方 .candidateLabel 不一致：\n' + rowsBad.join('\n'))

        // 每行高度 = 内边距 6+6 + 行盒（模型名 13px 的行高与复选控件里更高的那个）
        // —— 证明"行高由官方内边距决定"，而不是被别的样式凑出来的。
        for (const row of facts.rows) {
          const inner = Number.parseFloat(row.lineHeight)
          const control = row.checkboxRect === null ? 0 : row.checkboxRect.height
          const expected = 12 + Math.max(inner, control)
          assert.ok(
            Math.abs(row.rect.height - expected) <= 1.01,
            '模型行的真实高度必须由官方内边距 + 行盒决定（期望约 ' + String(expected) + 'px）：' +
              JSON.stringify({
                text: row.text,
                height: row.rect.height,
                lineHeight: row.lineHeight,
                checkbox: row.checkboxRect,
              }),
          )
        }
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('2.4 「拉取模型」= 官方 linkButton（28px / 0 10px / 12px-18px / radius-sm / 无描边）', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        const facts = await probe(page, 'vendorFacts')
        const radii = await resolveRadii(page, [OFFICIAL_LINK_BUTTON.radiusVar])
        const metrics = facts.fetchButton.metrics !== null ? facts.fetchButton.metrics : facts.fetchButton
        const bad = diffOf(metrics, OFFICIAL_LINK_BUTTON, '「拉取模型」')
          .concat(radiusDiff(metrics, OFFICIAL_LINK_BUTTON.radiusVar, radii, '「拉取模型」'))
        if (Math.abs(metrics.rect.height - 28) > 0.51) {
          bad.push('「拉取模型」的真实几何高度：实测 ' + String(metrics.rect.height) + 'px，官方 .sm 是 28px')
        }
        assert.deepEqual(bad, [], '「拉取模型」与官方 linkButton 不一致：\n' + bad.join('\n'))
        expectNoVisibleBorder(metrics, '「拉取模型」')
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })
  })

  // ── 3. 2026-10-12 重构新增的那几处（编辑按钮 / 圆点两色 / rows / 自定义设置 / 保存取消 / 虚线添加） ──

  describe('3. 卡片重构（点「编辑」展开）新增的官方取值', () => {
    it('3.1 行尾「编辑」= 官方 rowActions .secondaryButton 小号形态（28px / 0 10px / 12px-18px / radius-sm / border-l3 / 透明填充）', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        const r = await refactorFacts(page)
        assert.ok(r.edit !== null, '标头行尾必须有「编辑」按钮（[data-pxm-vendor-edit]）')
        assert.equal(r.edit.tag, 'BUTTON', '「编辑」必须是原生 button（Tab / Enter 才有原生行为）')
        assert.equal(r.edit.text, '编辑', '「编辑」的文案不许改：' + JSON.stringify(r.edit))

        const radii = await resolveRadii(page, [OFFICIAL_ROW_BUTTON.radiusVar])
        const borderColors = await resolveColors(page, [
          {
            key: OFFICIAL_ROW_BUTTON.borderColorVar,
            token: OFFICIAL_ROW_BUTTON.borderColorVar,
            prop: 'borderTopColor',
          },
        ])

        const bad = diffOf(r.edit, OFFICIAL_ROW_BUTTON, '「编辑」')
          .concat(radiusDiff(r.edit, OFFICIAL_ROW_BUTTON.radiusVar, radii, '「编辑」'))
          .concat(
            colorDiff(
              r.edit,
              'borderTopColor',
              OFFICIAL_ROW_BUTTON.borderColorVar,
              borderColors,
              '「编辑」',
            ),
          )
        if (Math.abs(r.edit.rect.height - 28) > 0.51) {
          bad.push('「编辑」的真实几何高度：实测 ' + String(r.edit.rect.height) + 'px，官方 rowActions 里是 28px')
        }
        assert.deepEqual(bad, [], '「编辑」与官方 `._3nPmjq_rowActions ._3nPmjq_secondaryButton` 不一致：\n' + bad.join('\n'))
        // 声明值那一半走 lane 的 `boxMetrics`（0.5px 被量化，只能读声明的边框）
        expectDeclaredBorder(
          await probeArgs(page, 'boxMetrics', ['[data-pxm-vendor-edit]']),
          '0.5px',
          '「编辑」',
        )
        assert.equal(
          r.edit.backgroundColor,
          OFFICIAL_ROW_BUTTON.transparent,
          '「编辑」不得有填充（官方 `._3nPmjq_secondaryButton{background:0 0}`）',
        )
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('3.2 凭据圆点：8×8 圆；已配置 = state-success-primary，未配置 = state-error-primary', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        const dot = await probeArgs(page, 'boxMetrics', ['[data-pxm-credential-dot]'])
        assert.ok(dot !== null, '标头必须有凭据状态点（[data-pxm-credential-dot]）')
        const colors = await resolveColors(page, [
          { key: 'configured', token: OFFICIAL_HEAD.dotOkColorVar },
          { key: 'missing', token: DOT_MISSING_VAR },
        ])
        assert.equal(dot.rect.width, 8, '圆点宽必须是 8px：' + JSON.stringify(dot.rect))
        assert.equal(dot.rect.height, 8, '圆点高必须是 8px：' + JSON.stringify(dot.rect))
        assert.equal(dot.borderRadius, OFFICIAL_HEAD.dotRadius, '圆点必须是正圆（border-radius:50%）')
        assert.equal(
          dot.backgroundColor,
          colors.configured,
          '已配置密钥 → 圆点必须是 `--dsw-alias-state-success-primary` 的解析值：实测 ' +
            String(dot.backgroundColor) + '，解析值 ' + String(colors.configured),
        )
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }

      /*
       * 另一侧：没配密钥的夹具 → 同一枚圆点必须换成 `--dsw-alias-state-error-primary`。
       * 只断"已配置那一色"的话，"两色接线接反 / 恒定成功色"这种缺陷测不到。
       */
      const missingProviders = {
        ...providersFixture,
        providers: [
          { ...providersFixture.providers[0], hasApiKey: false, apiKeySource: 'none' },
        ],
      }
      const second = await openVendorLane({ providers: missingProviders })
      try {
        const dot = await probeArgs(second.page, 'boxMetrics', ['[data-pxm-credential-dot]'])
        assert.ok(dot !== null, '未配置密钥时标头同样必须显示凭据状态点')
        const colors = await resolveColors(second.page, [
          { key: 'configured', token: OFFICIAL_HEAD.dotOkColorVar },
          { key: 'missing', token: DOT_MISSING_VAR },
        ])
        assert.equal(
          dot.backgroundColor,
          colors.missing,
          '未配置密钥 → 圆点必须是 `--dsw-alias-state-error-primary` 的解析值：实测 ' +
            String(dot.backgroundColor) + '，解析值 ' + String(colors.missing),
        )
        assert.notEqual(
          dot.backgroundColor,
          colors.configured,
          '未配置时不得仍然画成功色：实测 ' + String(dot.backgroundColor),
        )
        assert.deepEqual(second.problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await second.context.close()
      }
    })

    it('3.3 厂商列表容器 = 官方 ._3nPmjq_rows（gap 8px / margin-top 12px / padding 0 / list-style none / 竖列）', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        const r = await refactorFacts(page)
        assert.ok(r.rows !== null, '卡片必须住在列表里（父节点存在）')
        assert.equal(r.rows.tag, 'UL', '官方厂商列表是 <ul class="rows">')
        const bad = diffOf(r.rows, OFFICIAL_ROWS, '厂商列表（ul.rows）')
        assert.deepEqual(bad, [], '厂商列表与官方 `._3nPmjq_rows` 不一致：\n' + bad.join('\n'))
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('3.4 「自定义设置」= 官方 .customized（border-top .5px border-l2 + padding-top 10px；summary 12px/18px 500 label-secondary width:fit-content；开合两态箭头 transform 不同）', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        const closed = await refactorFacts(page)
        assert.ok(closed.details !== null, '编辑器里必须有 details[data-pxm-vendor-customized]')
        assert.equal(closed.detailsOpen, false, '「自定义设置」初始必须是收起的（不带 open）')

        // 上边线：声明值是官方那根 0.5px 发丝线（计算值会被量化成 1px）
        assert.match(
          String(closed.details.declaredBorderTop),
          /^0\.5px\s+solid/,
          '「自定义设置」的上边线声明值必须是 0.5px solid，实测 ' +
            JSON.stringify(closed.details.declaredBorderTop),
        )
        assert.equal(
          closed.details.paddingTop,
          OFFICIAL_CUSTOMIZED.padTop,
          '「自定义设置」的 padding-top：实测 ' + String(closed.details.paddingTop) +
            '，官方 ' + OFFICIAL_CUSTOMIZED.padTop,
        )
        const borderColors = await resolveColors(page, [
          {
            key: 'l2',
            token: OFFICIAL_CUSTOMIZED.borderTopColorVar,
            prop: 'borderTopColor',
          },
        ])
        assert.equal(
          closed.details.borderTopColor,
          borderColors.l2,
          '上边线颜色必须是 var(--dsw-alias-border-l2) 的解析值：实测 ' +
            String(closed.details.borderTopColor) + '，解析值 ' + String(borderColors.l2),
        )

        // summary：12px/18px + 500 + label-secondary + width:fit-content
        const summary = closed.summary
        assert.ok(summary !== null, '「自定义设置」必须有 summary')
        assert.equal(summary.fontSize, OFFICIAL_CUSTOMIZED.summaryFontSize, 'summary 字号')
        assert.equal(summary.lineHeight, OFFICIAL_CUSTOMIZED.summaryLineHeight, 'summary 行高')
        assert.equal(summary.fontWeight, OFFICIAL_CUSTOMIZED.summaryFontWeight, 'summary 字重')
        assert.equal(
          summary.declaredWidth,
          OFFICIAL_CUSTOMIZED.summaryWidth,
          'summary 的**声明宽度**必须是 fit-content（官方 `…Summary{width:fit-content}`），实测 ' +
            JSON.stringify(summary.declaredWidth),
        )
        const summaryColors = await resolveColors(page, [
          { key: 'secondary', token: OFFICIAL_CUSTOMIZED.summaryColorVar, prop: 'color' },
        ])
        assert.equal(
          summary.color,
          summaryColors.secondary,
          'summary 文字色必须是 var(--dsw-alias-label-secondary) 的解析值：实测 ' +
            String(summary.color) + '，解析值 ' + String(summaryColors.secondary),
        )

        /*
         * 箭头：官方 `:48` 收起是 `rotate(-45deg)`、`:49` `[open]` 时 `rotate(45deg)`
         * （`._3nPmjq_customized[open]>…Summary:before{transform:rotate(45deg)…}`）。
         * 所以判据就是"两态的 transform 必须不同"——不必猜实现用的是 ::before 还是真实元素。
         */
        await page.click('[data-pxm-vendor-customized] summary')
        /*
         * 箭头的 `transform` 带 `.12s` 过渡（官方 `:48` 的 `transition:transform .12s`），
         * 点完立刻读会落在过渡途中、读到与收起态几乎相同的插值 —— 那是**测试自己的竞态**，
         * 不是实现没换箭头。等过渡结束再读。
         */
        await page.waitForTimeout(250)
        const open = await refactorFacts(page)
        assert.equal(open.detailsOpen, true, '点 summary 后 details 必须真的展开')
        const closedArrow = JSON.stringify(closed.summaryArrow)
        const openArrow = JSON.stringify(open.summaryArrow)
        assert.notEqual(
          openArrow,
          closedArrow,
          '箭头在开合两态的 transform 必须不同（官方 -45deg → 45deg）：收起=' +
            closedArrow + ' 展开=' + openArrow,
        )
        assert.ok(
          Object.keys(closed.summaryArrow ?? {}).length > 0 ||
            Object.keys(open.summaryArrow ?? {}).length > 0,
          '箭头必须真的画出来（两态都没有任何 transform 说明根本没有箭头）：收起=' +
            closedArrow + ' 展开=' + openArrow,
        )
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('3.5 编辑器底部「保存」= 官方 primaryButton（button-primary-fill + 36px）；「取消」= secondaryButton（.5px border-l3 + 透明填充）', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        const r = await refactorFacts(page)
        assert.ok(r.save !== null, '编辑器底部必须有「保存」（[data-pxm-vendor-save]）')
        assert.ok(r.cancel !== null, '编辑器底部必须有「取消」（[data-pxm-vendor-cancel]）')

        const geometry = {
          height: OFFICIAL_EDITOR_BUTTON.height,
          paddingTop: OFFICIAL_EDITOR_BUTTON.paddingTop,
          paddingRight: OFFICIAL_EDITOR_BUTTON.paddingRight,
          paddingBottom: OFFICIAL_EDITOR_BUTTON.paddingBottom,
          paddingLeft: OFFICIAL_EDITOR_BUTTON.paddingLeft,
          fontSize: OFFICIAL_EDITOR_BUTTON.fontSize,
          lineHeight: OFFICIAL_EDITOR_BUTTON.lineHeight,
        }
        const radii = await resolveRadii(page, [OFFICIAL_EDITOR_BUTTON.radiusVar])
        const colors = await resolveColors(page, [
          { key: OFFICIAL_EDITOR_BUTTON.saveFillVar, token: OFFICIAL_EDITOR_BUTTON.saveFillVar },
          {
            key: OFFICIAL_EDITOR_BUTTON.cancelBorderVar,
            token: OFFICIAL_EDITOR_BUTTON.cancelBorderVar,
            prop: 'borderTopColor',
          },
        ])

        const bad = diffOf(r.save, geometry, '「保存」')
          .concat(radiusDiff(r.save, OFFICIAL_EDITOR_BUTTON.radiusVar, radii, '「保存」'))
          .concat(
            colorDiff(
              r.save,
              'backgroundColor',
              OFFICIAL_EDITOR_BUTTON.saveFillVar,
              colors,
              '「保存」',
            ),
          )
          .concat(diffOf(r.cancel, geometry, '「取消」'))
          .concat(radiusDiff(r.cancel, OFFICIAL_EDITOR_BUTTON.radiusVar, radii, '「取消」'))
          .concat(
            colorDiff(
              r.cancel,
              'borderTopColor',
              OFFICIAL_EDITOR_BUTTON.cancelBorderVar,
              colors,
              '「取消」',
            ),
          )
        for (const [label, measured] of [['「保存」', r.save], ['「取消」', r.cancel]]) {
          if (Math.abs(measured.rect.height - 36) > 0.51) {
            bad.push(label + ' 的真实几何高度：实测 ' + String(measured.rect.height) + 'px，官方是 36px')
          }
        }
        assert.deepEqual(
          bad,
          [],
          '编辑器底部两枚按钮与官方 `._3nPmjq_editorActions` 里的取值不一致：\n' + bad.join('\n'),
        )
        expectDeclaredBorder(
          await probeArgs(page, 'boxMetrics', ['[data-pxm-vendor-cancel]']),
          '0.5px',
          '「取消」',
        )
        assert.equal(
          r.cancel.backgroundColor,
          OFFICIAL_EDITOR_BUTTON.transparent,
          '「取消」不得有填充（官方 `._3nPmjq_secondaryButton{background:0 0}`）',
        )
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('3.6 虚线「添加模型提供商」= 官方 addButton（dashed / 44px / min-width 180px / radius-lg / border-l3 / 可点）', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        const r = await refactorFacts(page)
        const add = r.addButton
        assert.ok(add !== null, '厂商列表后面必须有「添加模型提供商」按钮（[data-pxm-add-vendor]）')
        assert.equal(add.tag, 'BUTTON', '「添加模型提供商」必须是原生 button')
        assert.ok(
          add.text.indexOf('添加模型提供商') >= 0,
          '按钮文案必须是「添加模型提供商」，实测 ' + JSON.stringify(add.text),
        )
        /*
         * 2026-10-12：这一枚**不再恒 disabled** —— 它现在打开「添加模型配置」目录弹窗
         * （`data-pxm-catalog`，见 3.7）。断言从"disabled === true"改成"必须可点"，
         * 不是删掉：形态（下面那组几何 / 描边）一个字都没放宽。
         */
        assert.equal(
          add.disabled,
          false,
          '「添加模型提供商」必须可点：它现在打开「添加模型配置」弹窗（不再是恒定 disabled）',
        )

        const radii = await resolveRadii(page, [OFFICIAL_ADD_BUTTON.radiusVar])
        const colors = await resolveColors(page, [
          {
            key: OFFICIAL_ADD_BUTTON.borderColorVar,
            token: OFFICIAL_ADD_BUTTON.borderColorVar,
            prop: 'borderTopColor',
          },
        ])
        const bad = diffOf(add, OFFICIAL_ADD_BUTTON, '「添加模型提供商」')
          .concat(radiusDiff(add, OFFICIAL_ADD_BUTTON.radiusVar, radii, '「添加模型提供商」'))
          .concat(
            colorDiff(
              add,
              'borderTopColor',
              OFFICIAL_ADD_BUTTON.borderColorVar,
              colors,
              '「添加模型提供商」',
            ),
          )
        if (Math.abs(add.rect.height - 44) > 0.51) {
          bad.push('「添加模型提供商」的真实几何高度：实测 ' + String(add.rect.height) + 'px，官方 44px')
        }
        assert.deepEqual(
          bad,
          [],
          '「添加模型提供商」与官方 `._3nPmjq_addButton` 不一致：\n' + bad.join('\n'),
        )
        /*
         * 声明值那一半：官方 `._3nPmjq_addButton` 有**两条**规则都命中它 ——
         * `:19` 的 `.secondaryButton,.addButton{border:.5px solid var(--dsw-alias-border-l3)}`
         * 与 `:39` 的 `.addButton{border:1px dashed var(--dsw-alias-border-l3);…}`。
         * 同优先级、后者在后 → **实到的是 `1px dashed`**（这也是"虚线"的字面来源）。
         */
        expectDeclaredBorder(
          await probeArgs(page, 'boxMetrics', ['[data-pxm-add-vendor]']),
          '1px',
          '「添加模型提供商」',
        )
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    /**
     * 分段控件滑块的位移表达式。官方原文是
     * `transform:translateX(calc(var(--dsh-segment-index) * (100% + 2px)))`；
     * Chromium 会把内联 `calc()` **归一化**后序列化（下标 0 → `translateX(calc(0% + 0px))`、
     * 下标 1 → `translateX(calc(100% + 2px))`），逐字比原文会把"写对了"判成失败。
     * 这两个**等价式**仍然钉住"位移由下标与 gap 2px 算出来"这条事实。
     */
    function segmentShift(index) {
      return index === 0 ? 'translateX(calc(0% + 0px))' : 'translateX(calc(100% + 2px))'
    }

    /**
     * 「添加模型提供商」**页内 add-card** 的**事实**（几何 / 配色），判断全在下面的用例里。
     *
     * 为什么就地 `page.evaluate` 而**不**加 `lane.js` 的探针：`lane.js` 是共用 harness、
     * 不在本次写域内，而且这张卡只有本文件消费；`boxMetrics` 也不交
     * `--dsh-segment-*` 那两个自定义属性（本用例的核心几何之一）。
     * 一次取完所有量，避免多次往返（这台机器近期反复蓝屏，命令越少越好）。
     */
    async function addFacts(page) {
      return page.evaluate(() => {
        const dump = (el) => {
          if (el === null || el === undefined) return null
          const cs = window.getComputedStyle(el)
          const r = el.getBoundingClientRect()
          return {
            tag: el.tagName,
            // 200：官方几条文案本身就 50+ 字符（`addCustomHint` 56），截短了断言就没意义。
            text: (el.textContent || '').trim().slice(0, 200),
            disabled: el.disabled === true,
            hidden: el.hidden === true,
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            selected: el.getAttribute('aria-selected'),
            /** 表单控件的当前值（`<select>` / `<input>`）；其它元素上是 `undefined`。 */
            value: el.value,
            rect: { width: r.width, height: r.height, top: r.top, left: r.left },
            display: cs.display,
            flexDirection: cs.flexDirection,
            alignItems: cs.alignItems,
            justifyContent: cs.justifyContent,
            gap: cs.gap,
            columnGap: cs.columnGap,
            gridAutoFlow: cs.gridAutoFlow,
            gridAutoColumns: cs.gridAutoColumns,
            paddingTop: cs.paddingTop,
            paddingRight: cs.paddingRight,
            paddingBottom: cs.paddingBottom,
            paddingLeft: cs.paddingLeft,
            fontSize: cs.fontSize,
            lineHeight: cs.lineHeight,
            fontWeight: cs.fontWeight,
            color: cs.color,
            backgroundColor: cs.backgroundColor,
            borderRadius: cs.borderRadius,
            borderTopStyle: cs.borderTopStyle,
            borderTopWidth: cs.borderTopWidth,
            borderTopColor: cs.borderTopColor,
            width: cs.width,
            maxWidth: cs.maxWidth,
            height: cs.height,
            overflowY: cs.overflowY,
            /** 声明值：0.5px 发丝线在 Chromium 计算样式里被量化成 1px，只能读声明值 */
            declaredBorder: el.style.getPropertyValue('border'),
            /*
             * 另外两类**只能读声明值**的：`calc()` 在计算样式里已被解析成 px
             * （滑块宽度 / 高度），而 `display:inline-grid` 计算值会退化成 `grid`。
             * 官方原文写的就是 calc 与 inline-grid，所以断言必须打在声明值上。
             */
            declaredDisplay: el.style.display,
            declaredWidth: el.style.width,
            declaredHeight: el.style.height,
            declaredLineHeight: el.style.lineHeight,
            declaredTransform: el.style.transform,
            /** 声明值里的底色：官方 `.addCard .editor{background:0 0}` 要求它**空**。 */
            declaredBackground: el.style.background,
          }
        }
        /* 两个自定义属性（官方靠它们**算**滑块，不量 DOM）只能这样读出来。 */
        const custom = (el) => {
          if (el === null) return null
          const cs = window.getComputedStyle(el)
          return {
            count: cs.getPropertyValue('--dsh-segment-count').trim(),
            index: cs.getPropertyValue('--dsh-segment-index').trim(),
          }
        }
        const card = document.querySelector('[data-pxm-add-card]')
        const seg = document.querySelector('[data-pxm-segmented]')
        const indicator = document.querySelector('[data-pxm-segmented-indicator]')
        const select = document.querySelector('[data-pxm-add-provider]')
        const catalogPanel = document.querySelector('[data-pxm-add-panel="catalog"]')
        const customPanel = document.querySelector('[data-pxm-add-panel="custom"]')
        return {
          addButtonGone: document.querySelector('[data-pxm-add-vendor]') === null,
          hasDialog: document.querySelector('[role="dialog"]') !== null,
          hasOverlay: document.querySelector('[data-pxm-catalog-overlay]') !== null,
          modes: dump(document.querySelector('[data-pxm-add-modes]')),
          hint: dump(document.querySelector('[data-pxm-add-hint]')),
          card: dump(card),
          cardGap: card === null ? null : window.getComputedStyle(card).gap,
          panel: dump(catalogPanel),
          panelCustom: dump(customPanel),
          customHidden: customPanel === null ? null : customPanel.hidden === true,
          seg: dump(seg),
          segCustom: custom(seg),
          segRadiusVar: seg === null ? null : seg.style.borderRadius,
          indicator: dump(indicator),
          tabs: Array.prototype.map.call(
            document.querySelectorAll('[data-pxm-add-tab]'),
            (node) => dump(node),
          ),
          select: dump(select),
          selectRadiusVar: select === null ? null : select.style.borderRadius,
          selectOptions: select === null
            ? []
            : Array.prototype.map.call(select.options, (o) => o.value),
          /*
           * task-8：选项的**可读文案 + disabled 状态**（"20 条全列、已添加的不可选并标注"）
           * 只能这样逐条读出来 —— `o.value` 拿不到「（已添加）」后缀。
           */
          selectOptionFacts: select === null
            ? []
            : Array.prototype.map.call(select.options, (o) => ({
                value: o.value,
                text: (o.textContent || '').trim(),
                disabled: o.disabled === true,
              })),
          exhausted: document.querySelector('[data-pxm-add-exhausted]') !== null,
          keyInput: dump(document.querySelector('#pxm-add-key')),
          baseUrlInput: dump(document.querySelector('#pxm-add-base-url')),
          customized: dump(document.querySelector('[data-pxm-add-customized]')),
          customizedSummary: dump(document.querySelector('[data-pxm-add-customized-summary]')),
          actions: dump(document.querySelector('[data-pxm-add-actions]')),
          save: dump(document.querySelector('[data-pxm-add-save]')),
          cancel: dump(document.querySelector('[data-pxm-add-cancel]')),
          /*
           * 「卡中卡」的反向判据：add-card 里**任何**编辑器（我们复用的那套编辑器锚点）
           * 都不许再挂 own surface。官方 `._3nPmjq_addCard ._3nPmjq_editor
           * {background:0 0;padding:0}`（`.probe/models-css-pretty.txt:44`）。
           */
          innerEditors: Array.prototype.map.call(
            document.querySelectorAll('[data-pxm-add-card] [data-pxm-editor]'),
            (node) => dump(node),
          ),
        }
      })
    }

    it('3.7 点虚线按钮 → **页内** add-card：面板 / 分段控件 / 原生 select / 编辑器无第二层底色（全部 = 官方取值）', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        assert.equal(
          (await refactorFacts(page)).addButton.disabled,
          false,
          '「添加模型提供商」必须可点',
        )
        // 官方 `addOpen ? addCard : addButton`：点下去是**就地展开**，不是弹窗。
        assert.equal(await page.$('[data-pxm-add-card]'), null, '默认态不该有 add-card')
        await page.click('[data-pxm-add-vendor]')
        await page.waitForSelector('[data-pxm-add-card]', { timeout: 10000 })

        const f = await addFacts(page)
        assert.ok(f.card !== null, '点虚线按钮必须出现页内 add-card（[data-pxm-add-card]）')
        assert.equal(f.addButtonGone, true, '展开后虚线按钮必须从 DOM 里消失（官方是二选一渲染）')
        assert.equal(f.hasDialog, false, 'add-card 不是对话框：不许有 role="dialog"')
        assert.equal(f.hasOverlay, false, 'add-card 不是弹窗：不许有遮罩层')
        assert.equal(f.panel.role, 'tabpanel', 'catalog 面板必须是 role="tabpanel"（官方 :2276）')

        const bad = []
        const eq = (where, got, want) => {
          if (got !== want) bad.push(where + '：实测 ' + String(got) + '，期望 ' + String(want))
        }

        // ── addCard：官方 `._3nPmjq_addCard{border-radius:lg;background:bg-module-platform;
        //    flex-direction:column;gap:14px;padding:14px 16px}`（:43）
        eq('add-card paddingTop', f.card.paddingTop, '14px')
        eq('add-card paddingRight', f.card.paddingRight, '16px')
        eq('add-card paddingBottom', f.card.paddingBottom, '14px')
        eq('add-card paddingLeft', f.card.paddingLeft, '16px')
        eq('add-card gap', f.cardGap, '14px')
        eq('add-card flexDirection', f.card.flexDirection, 'column')

        // ── addModes：官方 `{flex-direction:column;align-items:flex-start;gap:8px}`（:40）
        eq('add-modes flexDirection', f.modes.flexDirection, 'column')
        eq('add-modes alignItems', f.modes.alignItems, 'flex-start')
        eq('add-modes gap', f.modes.gap, '8px')

        // ── hint：官方 `._advancedHint{color:label-tertiary;font-size:12px;line-height:18px}`（:35）
        eq('hint 文案（catalog）', f.hint.text, '从内置目录中选择 OpenAI、Anthropic、Kimi 等提供商，填入其 API 密钥即可使用。')
        eq('hint fontSize', f.hint.fontSize, '12px')
        eq('hint lineHeight', f.hint.lineHeight, '18px')

        // ── addPanel：官方 `{flex-direction:column;gap:14px}`（:41）+ `[hidden]{display:none}`（:42）
        eq('catalog 面板 flexDirection', f.panel.flexDirection, 'column')
        eq('catalog 面板 gap', f.panel.gap, '14px')
        eq('catalog 面板 hidden=false', String(f.panel.hidden), 'false')
        eq('catalog 面板 display', f.panel.display, 'flex')
        eq('custom 面板 display:none（hidden 生效）', f.panelCustom.display, 'none')

        // ── SegmentedControl（官方 `SegmentedControl.module.css`）：
        //    轨道 `inline-grid` + `grid-auto-flow:column` + `grid-auto-columns:1fr` +
        //    `gap:2px;padding:4px;border-radius:var(--dsw-radius-md)`
        // `display:inline-grid` 的计算值在 Chromium 里退化成 `grid`（外层盒型不保留），
        // 所以这条打**声明值**上（官方原文就是 `display:inline-grid`）。
        eq('分段轨道 display', f.seg.declaredDisplay, 'inline-grid')
        eq('分段轨道 gridAutoFlow', f.seg.gridAutoFlow, 'column')
        eq('分段轨道 gridAutoColumns', f.seg.gridAutoColumns, '1fr')
        eq('分段轨道 gap', f.seg.gap, '2px')
        eq('分段轨道 paddingTop', f.seg.paddingTop, '4px')
        eq('分段轨道 paddingLeft', f.seg.paddingLeft, '4px')
        eq('tab 数量', String(f.tabs.length), '2')
        eq('tab[0] 文案', f.tabs[0].text, '第三方模型提供商')
        eq('tab[1] 文案', f.tabs[1].text, '自定义模型 API')
        eq('tab[0] role', f.tabs[0].role, 'tab')
        eq('tab[0] 选中态', f.tabs[0].selected, 'true')
        eq('tab[1] 选中态', f.tabs[1].selected, 'false')
        // `.tab{height:28px;padding:0 16px;font-size:13px;line-height:20px;font-weight:500}`
        eq('tab 高度', f.tabs[0].height, '28px')
        eq('tab paddingLeft', f.tabs[0].paddingLeft, '16px')
        eq('tab fontSize', f.tabs[0].fontSize, '13px')
        eq('tab lineHeight', f.tabs[0].lineHeight, '20px')
        eq('tab fontWeight', f.tabs[0].fontWeight, '500')
        // 滑块是**算**出来的：官方把段数 / 选中下标放在两个自定义属性上。
        eq('--dsh-segment-count', f.segCustom.count, '2')
        eq('--dsh-segment-index', f.segCustom.index, '0')
        // 滑块几何是**算**出来的 `calc(...)`：计算样式里已被解析成 px，只能读声明值。
        eq('滑块 height（声明值）', f.indicator.declaredHeight, 'calc(100% - 8px)')
        /*
         * 官方原文 `calc((100% - 8px - 2px * (var(--dsh-segment-count) - 1))
         * / var(--dsh-segment-count))`，段数 = 2 时 Chromium 把它归一化并序列化成
         * `calc(50% - 5px)`（= (100% - 8px - 2px)/2，同一个值）。逐字比原文会把
         * "实现写对了"误判成失败，所以这条断言打在**归一化后的等价式**上：
         * 它仍然钉住"宽度是由段数算出来的"（两段 = 半宽再减一格 gap）。
         */
        eq('滑块 width（声明值，归一化后）', f.indicator.declaredWidth, 'calc(50% - 5px)')
        /*
         * 位移：官方靠 `translateX(calc(var(--dsh-segment-index) * (100% + 2px)))`。
         * Chromium 会把内联 `calc(...)` **归一化**后再序列化（下标 0 读回
         * `translateX(calc(0% + 0px))` —— 0 × (100% + 2px) 就是这个值），所以这里比
         * `segmentShift(0)` 这个**等价式**，而不是逐字比官方原文。
         * 两种形态都收：计算值（有的实现会解析成 matrix）与内联声明值，但必须命中一个。
         */
        {
          const want = segmentShift(0)
          const computed = f.indicator.transform
          const declared = f.indicator.declaredTransform
          if (computed !== want && declared !== want) {
            bad.push(
              '滑块 transform：计算值实测 ' + String(computed) + '，声明值实测 ' +
                String(declared) + '；期望 ' + want,
            )
          }
        }

        // ── 原生 `<select>`：官方 `._input{height:32px;padding:0 10px;font-size:14px;line-height:22px;
        //    background:bg-layer-1;border:.5px solid border-l4;border-radius:var(--dsw-radius-md)}`
        //    + `select._input{max-width:240px}`（:73-74）
        assert.ok(f.select !== null, 'catalog 面板必须有原生 <select>（[data-pxm-add-provider]）')
        eq('select 标签名', f.select.tag, 'SELECT')
        eq('select 高度', f.select.height, '32px')
        eq('select paddingLeft', f.select.paddingLeft, '10px')
        eq('select fontSize', f.select.fontSize, '14px')
        // 原生 `<select>` 在 Chromium 里计算 lineHeight 读回 `normal`（表单控件不继承
        // 行高），所以这条打声明值（官方 `._3nPmjq_input{line-height:22px}`，:73）。
        eq('select lineHeight（声明值）', f.select.declaredLineHeight, '22px')
        eq('select maxWidth', f.select.maxWidth, '240px')
        eq('select 声明圆角', f.selectRadiusVar, 'var(--dsw-radius-md)')

        /*
         * ── task-8：下拉**列出全部 20 家**，已添加的（夹具里 google / ofox）不可选并标注
         *    「（已添加）」。以前只列未添加的，用户在自己已有 ofox / agnes 时只看到 18 条，
         *    会以为"目录里少了厂商"——这条断言就是把"不再过滤"钉死。
         */
        eq('下拉选项数 = 目录全部条目', String(f.selectOptions.length), String(CATALOG.length))
        for (const option of f.selectOptionFacts) {
          const entry = CATALOG.find((item) => item.id === option.value)
          if (entry === undefined) {
            bad.push('下拉里出现了目录之外的 id：' + option.value)
            continue
          }
          const already = entry.added === true
          eq('选项 ' + option.value + ' 的 disabled', String(option.disabled), String(already))
          if (already) {
            eq(
              '选项 ' + option.value + ' 的文案',
              option.text,
              entry.label + '（已添加）',
            )
          } else {
            eq('选项 ' + option.value + ' 的文案', option.text, entry.label)
          }
        }
        // 默认选中项必须是**第一个未添加**的那家（独立复述，见上面 FIRST_ADDABLE_ID）。
        eq('默认选中项', f.select.value, FIRST_ADDABLE_ID)

        // ── 编辑器动作：官方 `._editorActions{justify-content:flex-end;gap:8px}`（:36）
        eq('动作行 justifyContent', f.actions.justifyContent, 'flex-end')
        eq('动作行 gap', f.actions.gap, '8px')
        eq('「取消」disabled', String(f.cancel.disabled), 'false')
        eq('「保存」disabled', String(f.save.disabled), 'false')
        // 密钥框 = 官方 `._input`（同上），不是 34px 那档共享表单控件。
        eq('密钥框 高度', f.keyInput.height, '32px')
        eq('密钥框 fontSize', f.keyInput.fontSize, '14px')
        eq('密钥框标签名', f.keyInput.tag, 'INPUT')

        /*
         * ── **卡中卡**的反向判据（正是官方 `.addCard .editor{background:0 0;padding:0}` 那条）：
         *    add-card 自己已经是 `bg-module-platform`，如果里面再挂一层同色编辑器表面，
         *    就变成"卡里套卡"的两层底。这里先要求复用的编辑器**真的在**（否则断言空转），
         *    再要求它没有自己的底色。
         */
        assert.equal(
          f.innerEditors.length,
          1,
          'add-card 里必须**复用**那一套编辑器（[data-pxm-add-card] [data-pxm-editor]）',
        )
        for (const editor of f.innerEditors) {
          if (editor.declaredBackground !== '') {
            bad.push(
              'add-card 里的编辑器声明了自己的底色 ' +
                JSON.stringify(editor.declaredBackground) +
                '：官方 `.addCard .editor{background:0 0;padding:0}`' +
                '（.probe/models-css-pretty.txt:44），这正是"卡中卡"两层底',
            )
          }
          if (editor.backgroundColor === f.card.backgroundColor) {
            bad.push(
              'add-card 里的编辑器出现了第二层同色底色（' +
                editor.backgroundColor +
                '）：官方 `.addCard .editor{background:0 0;padding:0}`（.probe/models-css-pretty.txt:44）',
            )
          }
        }

        assert.deepEqual(bad, [], '「添加模型提供商」add-card 与官方取值不一致：\n' + bad.join('\n'))

        // ── 配色 / 圆角：一律走官方 token 的**解析值**（不写死 hex）
        const colors = await resolveColors(page, [
          { key: 'bgModulePlatform', token: '--dsw-alias-bg-module-platform' },
          { key: 'interactiveBgHover', token: '--dsw-alias-interactive-bg-hover' },
          { key: 'bgLayer1', token: '--dsw-alias-bg-layer-1' },
          { key: 'bgBase', token: '--dsw-alias-bg-base' },
          { key: 'labelPrimary', token: '--dsw-alias-label-primary', prop: 'color' },
          { key: 'labelSecondary', token: '--dsw-alias-label-secondary', prop: 'color' },
          { key: 'borderL4', token: '--dsw-alias-border-l4', prop: 'borderTopColor' },
        ])
        const radii = await resolveRadii(page, ['--dsw-radius-lg', '--dsw-radius-md', '--dsw-radius-sm'])
        const colorBad = []
          .concat(colorDiff(f.card, 'backgroundColor', 'bgModulePlatform', colors, 'add-card 底色'))
          .concat(
            colorDiff(f.seg, 'backgroundColor', 'interactiveBgHover', colors, '分段控件轨道'),
          )
          .concat(colorDiff(f.indicator, 'backgroundColor', 'bgLayer1', colors, '分段控件滑块'))
          .concat(colorDiff(f.tabs[0], 'color', 'labelPrimary', colors, '选中的 tab 文字'))
          .concat(colorDiff(f.tabs[1], 'color', 'labelSecondary', colors, '未选中的 tab 文字'))
          .concat(colorDiff(f.select, 'backgroundColor', 'bgLayer1', colors, '原生 select 底色'))
          .concat(colorDiff(f.select, 'borderTopColor', 'borderL4', colors, '原生 select 描边'))
          .concat(radiusDiff(f.card, '--dsw-radius-lg', radii, 'add-card'))
          .concat(radiusDiff(f.seg, '--dsw-radius-md', radii, '分段控件轨道'))
          .concat(radiusDiff(f.indicator, '--dsw-radius-sm', radii, '分段控件滑块'))
          .concat(radiusDiff(f.select, '--dsw-radius-md', radii, '原生 select'))
        assert.deepEqual(colorBad, [], 'add-card 的配色 / 圆角必须等于官方 token 的解析值：\n' + colorBad.join('\n'))
        /*
         * 底色还要求**反向**成立：`bg-module-platform` 不能与 `bg-base` / `bg-layer-1`
         * 被当成同一个值 —— 否则上面的相等断言会在"挂错层"时一起成立、缺陷被掩盖。
         */
        for (const [key, label] of [['bgBase', 'bg-base'], ['bgLayer1', 'bg-layer-1']]) {
          assert.notEqual(
            f.card.backgroundColor,
            colors[key],
            'add-card 底色不得是 ' + label + '（官方 _addCard 是 bg-module-platform）',
          )
        }

        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('3.7b 页内 add-card 的交互：切 tab 与选厂商都不发请求；保存恰好 1 次；「取消」零请求回到虚线按钮态', async () => {
      const { page, context, problems, calls } = await openVendorLane()
      try {
        const providerPosts = async () =>
          (await calls()).filter(
            (call) => call.method === 'POST' && /\/api\/providers$/.test(call.url),
          )

        await page.click('[data-pxm-add-vendor]')
        await page.waitForSelector('[data-pxm-add-card]', { timeout: 10000 })

        // 选一家厂商：**不发请求**（要等「保存」）—— 这条同时是反向变异 M47-add-on-select-posts 的判据。
        await page.selectOption('[data-pxm-add-provider]', 'anthropic')
        assert.deepEqual(await providerPosts(), [], '选中厂商不得发请求')

        // 填密钥 → 点「保存」：**恰好一次** POST，body 恰为 {catalogId, apiKey}。
        await page.fill('#pxm-add-key', 'sk-lane-secret')
        await page.click('[data-pxm-add-save]')
        await page.waitForFunction(
          () =>
            window.__pxmLane
              .fetchCalls()
              .some((call) => call.method === 'POST' && /\/api\/providers$/.test(call.url)),
          undefined,
          { timeout: 5000 },
        )
        const saved = await providerPosts()
        assert.equal(saved.length, 1, '点「保存」必须恰好发 1 次 POST，实际 ' + String(saved.length))
        assert.deepEqual(
          JSON.parse(String(saved[0].body)),
          { catalogId: 'anthropic', apiKey: 'sk-lane-secret' },
          'body 必须恰为 {catalogId, apiKey}（API 地址没填就不许出现 baseUrl）',
        )

        // 切到自定义 tab：hint 与面板跟着换（文案逐字），仍然零请求。
        await page.click('[data-pxm-add-tab="custom"]')
        await page.waitForFunction(
          () => {
            const panel = document.querySelector('[data-pxm-add-panel="custom"]')
            return panel !== null && panel.hidden === false
          },
          null,
          { timeout: 5000 },
        )
        const customFacts = await addFacts(page)
        assert.equal(customFacts.panelCustom.display, 'flex', 'custom 面板必须显形')
        assert.equal(customFacts.panel.display, 'none', 'catalog 面板必须隐掉')
        assert.equal(
          customFacts.hint.text,
          '连接中转站、自部署服务或其他兼容 OpenAI / Anthropic 协议的接口，需填写 API 地址、协议和模型。',
          'hint 必须换成官方 addCustomHint',
        )
        assert.equal(customFacts.segCustom.index, '1', '滑块下标必须跟到第二段')
        assert.equal(
          customFacts.indicator.declaredTransform,
          segmentShift(1),
          '滑块位移必须跟着下标走（下标 1 → 100% + 一格 gap）',
        )
        // 基线 = 刚才那一次保存；后面的"零请求"断言都相对它数**增量**。
        const postsAfterSave = (await providerPosts()).length
        assert.deepEqual(
          (await providerPosts()).length,
          postsAfterSave,
          '切 tab 不得再发请求',
        )

        // 「取消」：零请求、回到虚线按钮态。
        await page.click('[data-pxm-add-cancel]')
        await page.waitForSelector('[data-pxm-add-card]', { state: 'detached', timeout: 5000 })
        assert.ok(
          await page.$('[data-pxm-add-vendor]'),
          '「取消」后必须回到虚线「添加模型提供商」',
        )
        assert.equal(
          (await providerPosts()).length,
          postsAfterSave,
          '「取消」必须零请求（不新增任何 POST api/providers）',
        )

        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    /**
     * 「删除」的**两步确认**（行为级，真浏览器）：
     * 第一次点只改文案、**零请求**；第二次点才恰好发一次 `POST …/<id>/delete`。
     *
     * 文案逐字用官方 `.probe/models-client.js:2967` 的 `remove` = 「删除」。
     * 这条同时是反向变异 `M48-remove-one-step` 的判据（把两步退回一步直发 → 这里红）。
     */
    it('3.8 「删除」两步确认：第一次点零请求，第二次点恰好 1 次 POST …/delete', async () => {
      const { page, context, problems, calls } = await openVendorLane()
      try {
        const remove = '[data-pxm-vendor-remove]'
        assert.ok(await page.$(remove), '厂商卡片行动作里必须有「删除」（[data-pxm-vendor-remove]）')
        assert.equal((await page.textContent(remove)).trim(), '删除')

        await page.click(remove)
        assert.equal(
          (await page.textContent(remove)).trim(),
          '确认删除',
          '第一次点只把文案改成「确认删除」',
        )
        // 给异步一点时间：若这一步真的发了请求，必须被抓到（不是"恰好还没记录"）。
        await page.waitForTimeout(300)
        const afterFirst = (await calls()).filter((call) => /\/delete$/.test(call.url))
        assert.deepEqual(
          afterFirst,
          [],
          '第一次点不得发任何请求（两步确认的第一半），实测 ' + JSON.stringify(afterFirst),
        )

        await page.click(remove)
        await page.waitForFunction(
          () => window.__pxmLane.fetchCalls().some((call) => /\/delete$/.test(call.url)),
          undefined,
          { timeout: 5000 },
        )
        const afterSecond = (await calls()).filter((call) => /\/delete$/.test(call.url))
        assert.equal(
          afterSecond.length,
          1,
          '第二次点必须恰好发 1 次 POST，实际 ' + String(afterSecond.length),
        )
        assert.equal(afterSecond[0].method, 'POST', '本仓库只支持 GET/POST：删除也走 POST')
        assert.match(
          afterSecond[0].url,
          /\/api\/providers\/ofox\/delete$/,
          '目标必须是 POST api/providers/<id>/delete',
        )
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })
  })
}
