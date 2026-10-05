/**
 * dsh-pixmart client 半（P0 契约自检版）。
 *
 * 装载契约（取证自 @deepseek-ai/dsh-client-modules 官方 README）：
 *   - 产物必须是 `window.__ModuleLoader__.load({ id, factory })`；
 *   - `id` 用 **npm 包名**，与 package.json 的 name 一致；
 *   - `factory(require)` **只收到 require**——包式 client 半没有 `host.call`
 *     （那是动态 client 半的能力）。因此与宿主通信必须走本插件自己的 HTTP 路由，
 *     见 docs/contract-notes.md 的「RPC 机制修正」。
 *
 * P0 只注册三处落点，用来验证 §8.2 的三条插槽契约真实成立：
 *   1. settings.section     → 设置面板导航列出现「电商生图」
 *   2. sidebar.panellist    → 侧边栏面板图标排出现图标
 *   3. main (keyed)         → 点该图标后中央主面板切到我们的页面
 * 其中 2+3 就是风险 R3 的收口验证。
 *
 * 本文件是手写 JS（无构建步骤）：P0 要隔离「契约风险」与「工具链风险」。
 * P3 引入打包器时必须复现同一包装。
 */
window.__ModuleLoader__.load({
  id: 'dsh-pixmart',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PLUGIN = 'dsh-pixmart'
    const VERSION = '0.0.1'
    const SLOT_LABEL = '电商生图'
    const PANEL_KEY = 'pixmart'

    const wrap = { padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '760px' }
    const title = { margin: 0, fontSize: '15px', fontWeight: 600 }
    const muted = { margin: 0, fontSize: '13px', lineHeight: 1.7, opacity: 0.72 }
    const card = {
      border: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
      borderRadius: '10px',
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
    }
    const code = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }
    const okMark = { color: '#22c55e', fontWeight: 600 }

    function Line(props) {
      return h('p', { style: muted }, h('span', { style: okMark }, '✓ '), props.children)
    }

    function SettingsPage() {
      return h(
        'div',
        { style: wrap },
        h('h2', { style: title }, 'PixMart 电商生图'),
        h('p', { style: muted }, 'P0 契约自检页：client 半已装载，slot 注册链路可用。'),
        h(
          'div',
          { style: card },
          h(Line, null, '插件 ', h('code', { style: code }, PLUGIN + '@' + VERSION), ' 已挂载'),
          h(Line, null, '宿主半注册的工具：', h('code', { style: code }, 'pixmart_ping')),
          h(Line, null, '设置页插槽：', h('code', { style: code }, 'settings.section')),
        ),
        h(
          'p',
          { style: muted },
          'P1 起这里会变成厂商与密钥管理、模型列表、尺寸能力与提示词覆盖；' +
            'P2 加上运行记录与用量；P3 接入作品库与实时预览。',
        ),
      )
    }

    /** `sidebar.panellist` 的 owner 只给 { size, active }。 */
    function PanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return h(
        'span',
        {
          'aria-hidden': 'true',
          style: {
            width: size + 'px',
            height: size + 'px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: Math.max(9, Math.round(size * 0.55)) + 'px',
            fontWeight: 700,
            letterSpacing: '-0.5px',
            borderRadius: '4px',
            background: props?.active
              ? 'color-mix(in srgb, currentColor 18%, transparent)'
              : 'transparent',
          },
        },
        'PM',
      )
    }

    function WorkbenchPanel() {
      return h(
        'div',
        { style: wrap },
        h('h2', { style: title }, '作品库'),
        h('p', { style: muted }, 'P0 占位页：主面板插槽（keyed ' + h('code', { style: code }, PANEL_KEY) + '）已被本插件认领。'),
        h(
          'div',
          { style: card },
          h(Line, null, '此页路由由 ', h('code', { style: code }, 'sidebar.panellist'), ' 的 id 驱动'),
          h(Line, null, 'P2 起显示项目网格；P3 加入预览、导出与实时生图进度'),
        ),
      )
    }

    const name = PLUGIN
    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.slots

      ctx.effect(
        () =>
          slots.inject('settings.section', () =>
            slots.register(
              {
                name: 'settings.section',
                id: 'pixmart',
                order: 30,
                label: SLOT_LABEL,
              },
              SettingsPage,
            ),
          ),
        'dsh-pixmart: settings section',
      )

      ctx.effect(
        () =>
          slots.inject('sidebar.panellist', () =>
            slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_KEY,
                order: 10,
                label: SLOT_LABEL,
              },
              PanelIcon,
            ),
          ),
        'dsh-pixmart: sidebar panel icon',
      )

      ctx.effect(
        () =>
          slots.inject('main', () =>
            slots.register({ name: 'main', key: PANEL_KEY }, WorkbenchPanel),
          ),
        'dsh-pixmart: main panel',
      )
    }

    return { name, inject, apply }
  },
})
