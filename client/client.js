/**
 * dsh-pixmart client 半 —— 作品库 / 设置页 / 生图实时预览。
 *
 * 装载契约（见 docs/contract-notes.md §3.1）：
 *   - 产物是 `window.__ModuleLoader__.load({ id:'dsh-pixmart', factory })`；
 *   - `factory(require)` **只收到 require**，没有 `host.call`。
 *     因此与宿主通信**只能**走本插件自己的 HTTP 路由（§3.2 的 RPC 机制修正）。
 *
 * 三处落点（技术方案 §8.2）：
 *   ① settings.section    → 设置面板左导航多一项「电商生图」：厂商/默认值/数据目录/累计用量（只读）
 *   ② sidebar.panellist   → 侧边栏面板图标排多一个图标（id 'pixmart'）
 *      main (keyed)       → 中央主面板作品库（key 'pixmart'，与上面 id 一一对应）
 *   ③ shell.overlay       → 右下角实时预览卡（§8.5）：进度 3/8 + 逐格点亮 + 取消 + 收起徽标
 *
 * 硬约束：
 *   - 手写 JS，无构建步骤；只用 `require('react')` + `React.createElement`，没有 JSX。
 *   - 所有副作用（slot 注册 / 定时器 / 监听 / DOM / <style>）都包在 `ctx.effect` 里，
 *     随 apply 的 disposer 清理。
 *   - 任何插槽注册失败只让该功能缺失：一律 try/catch，绝不冒泡到设置面板。
 *   - HTTP 基址相对挂载点解析（`new URL('pixmart/', document.baseURI)`），
 *     不写死 `/pixmart/...` 根绝对路径，以支持路径前缀部署。
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
    const SETTINGS_ID = 'pixmart'
    const OVERLAY_ID = 'pixmart-preview'
    const STYLE_ID = 'dsh-pixmart-style'

    /** 轮询周期：有运行在跑 1s；空闲重发现 10s；页面隐藏时不发请求（§8.5.4）。 */
    const POLL_ACTIVE_MS = 1000
    const POLL_IDLE_MS = 10000
    const RUN_LIST_LIMIT = 5
    const PROJECT_LIST_LIMIT = 50

    /** 相对挂载点解析基址，绝不写死根绝对路径。 */
    const BASE = (() => {
      try {
        return new URL('pixmart/', document.baseURI)
      } catch {
        return null
      }
    })()

    const ACTIVE_STATUSES = ['running', 'awaiting-confirm']
    const TERMINAL_STATUSES = ['done', 'failed', 'cancelled', 'interrupted']
    const RUN_STATUS_LABEL = {
      running: '生成中',
      'awaiting-confirm': '待确认',
      done: '已完成',
      failed: '失败',
      cancelled: '已取消',
      interrupted: '已中断',
    }
    const ITEM_STATUS_LABEL = {
      queued: '排队中',
      running: '生成中',
      done: '已完成',
      failed: '失败',
      skipped: '已跳过',
    }
    const COLORS = { ok: '#22c55e', fail: '#ef4444', run: '#3b82f6', track: 'color-mix(in srgb, currentColor 14%, transparent)' }

    const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
    const isArray = Array.isArray
    const isString = (v) => typeof v === 'string'
    const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)

    // ── URL 与取数 ──────────────────────────────────────────────────────────

    /** `file/<projectId>/<name>` 的完整 URL；name 取 `images/x.png` 的最后一段。 */
    function fileUrl(projectId, name) {
      if (BASE === null) return null
      if (!isString(projectId) || projectId === '') return null
      if (!isString(name) || name === '') return null
      const last = name.split('/').filter(Boolean).pop()
      if (last === undefined || last === '') return null
      try {
        return new URL(
          'file/' + encodeURIComponent(projectId) + '/' + encodeURIComponent(last),
          BASE,
        ).href
      } catch {
        return null
      }
    }

    function relativeUrl(path) {
      if (BASE === null) return null
      try {
        return new URL(path, BASE).href
      } catch {
        return null
      }
    }

    /** 取数助手：no-store + 形状校验 + 不抛异常。 */
    async function apiGet(path, validate) {
      if (BASE === null) return { ok: false, error: '无法解析插件基址' }
      const url = relativeUrl(path)
      if (url === null) return { ok: false, error: '无法解析请求地址' }
      try {
        const response = await fetch(url, { cache: 'no-store' })
        if (!response.ok) return { ok: false, error: 'HTTP ' + String(response.status) }
        const body = await response.json().catch(() => null)
        if (typeof validate === 'function' && !validate(body)) {
          return { ok: false, error: '响应形状不符合预期' }
        }
        return { ok: true, data: body }
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : '请求失败' }
      }
    }

    async function apiPost(path) {
      if (BASE === null) return { ok: false, error: '无法解析插件基址' }
      const url = relativeUrl(path)
      if (url === null) return { ok: false, error: '无法解析请求地址' }
      try {
        const response = await fetch(url, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        if (!response.ok) return { ok: false, error: 'HTTP ' + String(response.status) }
        const body = await response.json().catch(() => null)
        if (!isObject(body)) return { ok: false, error: '响应形状不符合预期' }
        return { ok: true, data: body }
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : '请求失败' }
      }
    }

    const isRunList = (v) => isObject(v) && v.ok === true && isArray(v.runs)
    const isRunDetail = (v) => isObject(v) && v.ok === true && isObject(v.run) && isArray(v.run.items)
    const isProjectList = (v) => isObject(v) && v.ok === true && isArray(v.projects)
    const isProjectDetail = (v) => isObject(v) && v.ok === true && isObject(v.project)
    const isProviders = (v) => isObject(v) && v.ok === true && isArray(v.providers)

    const isActive = (status) => ACTIVE_STATUSES.indexOf(status) >= 0
    const isTerminal = (status) => TERMINAL_STATUSES.indexOf(status) >= 0

    // ── 极简订阅 store（不引入状态库，也不跨插件 import 值） ─────────────────

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          if (next === value) return
          value = next
          listeners.forEach((fn) => {
            try {
              fn(value)
            } catch {
              /* 单个订阅者出错不影响其他 */
            }
          })
        },
        subscribe(fn) {
          listeners.add(fn)
          return () => {
            listeners.delete(fn)
          }
        },
      }
    }

    const selectedProject = createStore(null)
    /** 预览状态的初值必须是对象：空闲与否统一由 `run === null` 表达。 */
    const previewEmptyState = () => ({
      run: null,
      activeRuns: [],
      stale: false,
      error: null,
      /** 当前显示的运行「首次被本页面看到」的时刻；用于区分「首屏恢复」与「新开始」。 */
      firstSeenAt: null,
    })
    const previewState = createStore(previewEmptyState())

    function useStore(store) {
      const [value, setValue] = React.useState(() => store.get())
      React.useEffect(() => store.subscribe(setValue), [store])
      return value
    }

    // ── 运行轮询（§8.5.4）：in-flight guard + 形状校验 + stale 快照 ──────────

    const SESSION_KEY = 'dsh-pixmart:seen-runs'

    /**
     * 首屏恢复基线：`sessionStorage` 记住「本标签页第一次开始观察的时刻」。
     * 刷新页面后它保持不变，于是仍在跑的运行会被识别为「恢复」→ 只显示徽标（§8.5.5）；
     * 之后新开始的运行（`startedAt` 晚于该时刻）才自动展开。
     */
    function readMountBaseline() {
      try {
        const raw = window.sessionStorage.getItem(SESSION_KEY)
        const parsed = raw === null ? null : JSON.parse(raw)
        if (isObject(parsed) && isNumber(parsed.mountedAt)) return parsed.mountedAt
      } catch {
        /* 忽略，退化为「本次观察即基线」 */
      }
      const mountedAt = Date.now()
      try {
        window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ mountedAt }))
      } catch {
        /* sessionStorage 不可用：退化为内存判断 */
      }
      return mountedAt
    }

    const baseline = { mountedAt: readMountBaseline() }

    /**
     * 本页面期间亲眼看它「在跑」过的运行 id。
     *
     * 结束态的徽标**只在这次页面期间真的跑过**时才出现：
     * 否则刷新页面后会把很久以前完成的历史运行当徽标长期挂在右下角（既非 §8.5.5 的
     * 「空闲即无 DOM」，也不是用户关心的内容）。进程内单例，跨 overlay 重挂保持。
     */
    const observedActive = new Set()

    /** 单例轮询器：`shell.overlay` 可能挂多处，但只允许有一条轮询链。 */
    const runPoller = (() => {
      let subscribers = 0
      let timer = null
      let inFlight = false
      /** 正在取增量详情的运行 id；null 表示只靠列表摘要。 */
      let watchRunId = null
      /** `state.run` 是否已经是「带 items 的详情」，而不是列表摘要。 */
      let runIsDetail = false
      /**
       * 「这一轮观察」的代际号。卸载后自增，用来丢弃已作废的异步响应；
       * 同时保证 client fiber 重建（HMR 重挂）后轮询能重新启动，而不是永久停摆。
       */
      let generation = 0
      let state = previewEmptyState()

      function emit() {
        previewState.set({ ...state })
      }

      function schedule(delay) {
        if (subscribers === 0) return
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(tick, delay)
      }

      function stopTimers() {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      }

      /**
       * 采纳一条运行记录。
       * `startedAt` 早于本页面加载基线 → 首屏恢复（只显示徽标）；
       * 晚于基线 → 本页面加载之后新开始（自动展开）。
       */
      function adoptRun(run, isDetail) {
        state.run = run
        state.firstSeenAt = isNumber(run.startedAt) ? run.startedAt : Date.now()
        runIsDetail = isDetail === true
        watchRunId = isDetail === true || isActive(run.status) ? run.runId : null
        if (isActive(run.status)) observedActive.add(run.runId)
      }

      async function tick() {
        timer = null
        const current = generation
        if (subscribers === 0) return
        if (typeof document !== 'undefined' && document.hidden) {
          // 页面不可见时不发请求；回到可见时由 visibilitychange 立刻补一次
          schedule(POLL_IDLE_MS)
          return
        }
        if (inFlight) {
          schedule(POLL_ACTIVE_MS)
          return
        }
        inFlight = true
        try {
          // 1) 有正在观察的运行 → 取它的增量详情（列表摘要没有 items）
          if (watchRunId !== null) {
            const detail = await apiGet('api/runs/' + encodeURIComponent(watchRunId), isRunDetail)
            if (current !== generation || subscribers === 0) return
            if (detail.ok) {
              state.run = detail.data.run
              state.error = null
              state.stale = false
              runIsDetail = true
              if (!isActive(state.run.status)) watchRunId = null
            } else {
              state.error = detail.error
              if (state.run !== null) state.stale = true
              watchRunId = null
              runIsDetail = false
            }
            emit()
          }

          // 2) 列表：判断有没有活 / 发现新运行
          const list = await apiGet('api/runs?limit=' + String(RUN_LIST_LIMIT), isRunList)
          if (current !== generation || subscribers === 0) return
          if (!list.ok) {
            state.error = list.error
            if (state.run !== null) state.stale = true
            emit()
            schedule(state.run === null ? POLL_IDLE_MS : POLL_ACTIVE_MS)
            return
          }

          const runs = list.data.runs.filter(isObject)
          state.error = null
          state.stale = false
          state.activeRuns = runs.filter((run) => isActive(run.status))

          if (state.run === null) {
            // 空闲态：优先接住正在跑的；其次只在「本页面期间真的跑过」时保留终结徽标
            const running = state.activeRuns[0] ?? null
            const candidate =
              running ?? runs.find((run) => observedActive.has(run.runId)) ?? null
            if (candidate !== null) adoptRun(candidate, false)
          } else if (!runIsDetail) {
            // 还没有详情：用列表里的最新摘要（items 缺失，下一轮会被详情覆盖）
            const latest = runs.find((run) => run.runId === state.run.runId)
            if (latest !== undefined) state.run = latest
          }

          if (state.run === null) {
            // 真的空闲：停止轮询（§8.5.5「空闲时不渲染任何 DOM，并停止轮询」）
            stopTimers()
            emit()
            return
          }

          emit()
          schedule(isActive(state.run.status) ? POLL_ACTIVE_MS : POLL_IDLE_MS)
        } finally {
          inFlight = false
        }
      }

      function wake() {
        if (subscribers === 0) return
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(tick, 0)
      }

      return {
        start() {
          subscribers += 1
          if (subscribers === 1) wake()
        },
        stop() {
          subscribers = Math.max(0, subscribers - 1)
          if (subscribers === 0) stopTimers()
        },
        /**
         * client fiber 卸载：停表、清空快照、作废在途响应。
         * 不是「永久销毁」——fiber 重建后 overlay 重新 start()，轮询照常可用。
         */
        halt() {
          generation += 1
          stopTimers()
          subscribers = 0
          inFlight = false
          watchRunId = null
          runIsDetail = false
          state = previewEmptyState()
          previewState.set({ ...state })
        },
        /** 页面重新可见 / 用户操作后立刻同步一次。 */
        refresh: wake,
        /** 多任务切换：切到列表里的另一条运行（摘要，随后由详情补齐）。 */
        selectRun(run) {
          if (!isObject(run) || !isString(run.runId)) return
          adoptRun(run, false)
          emit()
          wake()
        },
        async cancel(runId) {
          if (!isString(runId)) return { ok: false, error: '缺少 runId' }
          const result = await apiPost('api/runs/' + encodeURIComponent(runId) + '/cancel')
          wake()
          return result
        },
        snapshot: () => ({ ...state }),
      }
    })()

    // ── 共享视觉原子 ────────────────────────────────────────────────────────

    const skin = {
      wrap: { padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '880px' },
      title: { margin: 0, fontSize: '15px', fontWeight: 600 },
      muted: { margin: 0, fontSize: '13px', lineHeight: 1.7, opacity: 0.72 },
      card: {
        border: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        wordBreak: 'break-all',
      },
      key: { fontSize: '12px', opacity: 0.7, minWidth: '72px' },
    }

    function Pill(props) {
      return h(
        'span',
        {
          style: {
            fontSize: '11px',
            padding: '1px 6px',
            borderRadius: '999px',
            border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
            background: 'color-mix(in srgb, currentColor 8%, transparent)',
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    function Notice(props) {
      return h(
        'div',
        {
          role: props.role ?? 'status',
          style: {
            ...skin.card,
            borderColor: 'color-mix(in srgb, currentColor 24%, transparent)',
            background: 'color-mix(in srgb, currentColor 6%, transparent)',
          },
        },
        h('strong', { style: { fontSize: '13px' } }, props.title),
        props.detail === undefined || props.detail === null
          ? null
          : h('p', { style: skin.muted }, String(props.detail)),
        props.children ?? null,
      )
    }

    function Spinner(props) {
      return h('span', {
        className: 'pxm-spin',
        role: 'progressbar',
        'aria-label': props.label ?? '加载中',
        style: {
          width: '13px',
          height: '13px',
          borderRadius: '50%',
          display: 'inline-block',
          flex: '0 0 auto',
          border: '2px solid color-mix(in srgb, currentColor 25%, transparent)',
          borderTopColor: 'currentColor',
        },
      })
    }

    function Btn(props) {
      const disabled = props.disabled === true
      return h(
        'button',
        {
          type: 'button',
          className: 'pxm-btn',
          onClick: props.onClick,
          disabled,
          title: props.title,
          style: {
            font: 'inherit',
            fontSize: '12px',
            padding: '4px 10px',
            borderRadius: '6px',
            color: 'inherit',
            border: '1px solid color-mix(in srgb, currentColor 24%, transparent)',
            background: 'color-mix(in srgb, currentColor 8%, transparent)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    function LoadingRow(props) {
      return h(
        'div',
        { style: { ...skin.row, ...skin.muted } },
        h(Spinner, null),
        h('span', null, props.text),
      )
    }

    // ── ① settings.section：只读厂商 / 默认值 / 数据目录 / 累计用量 ──────────

    function ProvidersSection(props) {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null })

      React.useEffect(() => {
        let alive = true
        apiGet('api/providers', isProviders).then((result) => {
          if (!alive) return
          if (result.ok) setState({ phase: 'ready', data: result.data, error: null })
          else setState({ phase: 'error', data: null, error: result.error })
        })
        return () => {
          alive = false
        }
      }, [])

      // 不再自带「关闭」按钮：shell 已在设置面板右上角提供 X（与「打开配置文件」并列），
      // 页面内再放一个重复且占位。`props.close` 仍然保留可用，留给"跳出设置去开会话"那类流程。
      const header = h('div', { style: skin.row }, h('h2', { style: skin.title }, 'PixMart 电商生图'))

      if (state.phase === 'loading') {
        return h('div', { style: skin.wrap }, header, h(LoadingRow, { text: '正在读取厂商与用量…' }))
      }
      if (state.phase === 'error') {
        return h(
          'div',
          { style: skin.wrap },
          header,
          h(
            Notice,
            { role: 'alert', title: '读取失败', detail: state.error },
            h('p', { style: skin.muted }, '宿主路由可能尚未就绪，或插件未加载到当前 profile。'),
          ),
        )
      }

      const data = state.data
      const defaults = isObject(data.defaults) ? data.defaults : {}
      const usage = isObject(data.usage) ? data.usage : {}
      // 历史产出：账本（usage.jsonl）自 P2 起才有，此前的产出由项目记录汇总。
      // 不单列的话，"累计用量 0"会和用户可见的项目并排出现、数字对不上。
      const historical = isObject(data.historical) ? data.historical : {}

      /**
       * 把「标签 + 值」包成一个**不可内部断行**的 flex 项。
       *
       * 之前两者是行容器里的两个独立子项，换行时会从中间断开——「尺寸」留在上一行、
       * `1:1` 掉到下一行，看起来像错位。成组之后换行只会整对一起走。
       */
      const field = (label, value) =>
        h(
          'span',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: '6px',
              whiteSpace: 'nowrap',
            },
          },
          h('span', { style: skin.key }, label),
          h('code', { style: skin.code }, value),
        )

      /**
       * 同上的多值版本：标签 + 若干子项。
       * 组内允许换行（模型一多不能横向溢出），但标签 `flexShrink: 0` 且始终与
       * 第一个值同排，视觉上不会被拆散。
       */
      const fieldGroup = (label, children) =>
        h(
          'span',
          {
            style: {
              display: 'inline-flex',
              flexWrap: 'wrap',
              alignItems: 'baseline',
              gap: '6px',
            },
          },
          h('span', { style: { ...skin.key, flexShrink: 0 } }, label),
          ...children,
        )
      const providers = data.providers.filter(isObject)

      return h(
        'div',
        { style: skin.wrap },
        header,
        h(
          'p',
          { style: skin.muted },
          '本页只读：厂商、模型、默认值与累计用量。密钥只显示「是否就位」，不回显内容。',
        ),

        h(
          'div',
          { style: skin.card },
          h('strong', { style: { fontSize: '13px' } }, '默认值'),
          h(
            'div',
            { style: skin.row },
            field('厂商', String(defaults.provider ?? '—')),
            field('模型', String(defaults.model ?? '—')),
            field('尺寸', String(defaults.size ?? '—')),
          ),
          h('div', { style: skin.row }, field('数据目录', String(data.dataDir ?? '—'))),
        ),

        h(
          'div',
          { style: skin.card },
          h('strong', { style: { fontSize: '13px' } }, '累计用量'),
          h(
            'div',
            { style: skin.row },
            h(Pill, null, '请求 ' + String(usage.requests ?? 0)),
            h(Pill, null, '成功 ' + String(usage.ok ?? 0)),
            h(Pill, null, '失败 ' + String(usage.failed ?? 0)),
            h(Pill, null, '出图 ' + String(usage.images ?? 0)),
          ),
          Number(historical.images ?? 0) > 0
            ? h(
                'div',
                { style: { fontSize: '12px', opacity: 0.7, lineHeight: 1.6 } },
                '历史产出（账本之前）：' +
                  String(historical.images) +
                  ' 张 / ' +
                  String(historical.projects ?? 0) +
                  ' 个项目 —— ' +
                  String(historical.note ?? ''),
              )
            : null,
        ),

        h(
          'div',
          { style: skin.card },
          h(
            'div',
            { style: skin.row },
            h('strong', { style: { fontSize: '13px' } }, '厂商'),
            h(Pill, null, providers.length + ' 个'),
          ),
          providers.length === 0
            ? h('p', { style: skin.muted }, '未配置任何厂商。可在插件配置中补充 provider 条目。')
            : providers.map((provider, index) =>
                h(
                  'div',
                  {
                    key: isString(provider.id) ? provider.id : 'p' + String(index),
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                      paddingTop: index === 0 ? '0' : '8px',
                      borderTop:
                        index === 0
                          ? 'none'
                          : '1px solid color-mix(in srgb, currentColor 10%, transparent)',
                    },
                  },
                  h(
                    'div',
                    { style: skin.row },
                    h(
                      'strong',
                      { style: { fontSize: '13px' } },
                      String(provider.label ?? provider.id ?? '未命名'),
                    ),
                    h('code', { style: { ...skin.code, opacity: 0.7 } }, String(provider.id ?? '—')),
                    h(Pill, null, String(provider.group ?? '—')),
                    h(Pill, null, String(provider.apiMode ?? '—')),
                    h(
                      Pill,
                      null,
                      provider.hasApiKey === true
                        ? '密钥已就位' + (provider.apiKeySource ? '（' + String(provider.apiKeySource) + '）' : '')
                        : '密钥缺失',
                    ),
                  ),
                  fieldGroup(
                    '模型',
                    isArray(provider.models) && provider.models.length > 0
                      ? provider.models.map((model, mi) =>
                          h(
                            Pill,
                            { key: 'm' + String(mi) },
                            isObject(model) ? String(model.id ?? model.label ?? '?') : String(model),
                          ),
                        )
                      : [h('span', { style: skin.muted }, '未声明模型')],
                  ),
                  fieldGroup(
                    '支持尺寸',
                    isArray(provider.allowedSizes) && provider.allowedSizes.length > 0
                      ? [h('code', { style: skin.code }, provider.allowedSizes.map(String).join(' / '))]
                      : [h('span', { style: skin.muted }, '未声明')],
                  ),
                ),
              ),
        ),

        h('p', { style: skin.muted }, '插件 ' + PLUGIN + '@' + VERSION + ' · 设置页插槽 settings.section'),
      )
    }

    // ── ② sidebar.panellist 图标 + main(key 'pixmart') 作品库 ───────────────

    function PanelIcon(props) {
      const size = isNumber(props?.size) ? props.size : 18
      const active = props?.active === true
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
            background: active ? 'color-mix(in srgb, currentColor 18%, transparent)' : 'transparent',
          },
        },
        'PM',
      )
    }

    function ProjectCard(props) {
      const project = props.project
      const cover = fileUrl(project.id, project.cover)
      return h(
        'button',
        {
          type: 'button',
          className: 'pxm-tile',
          onClick: () => props.onOpen(project.id),
          style: {
            font: 'inherit',
            color: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            padding: '8px',
            borderRadius: '10px',
            border: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
            background: 'color-mix(in srgb, currentColor 4%, transparent)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          },
        },
        h(
          'div',
          {
            style: {
              aspectRatio: '4 / 3',
              borderRadius: '6px',
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'color-mix(in srgb, currentColor 6%, transparent)',
              fontSize: '12px',
              opacity: 0.85,
            },
          },
          cover === null
            ? h('span', null, '无封面')
            : h('img', {
                src: cover,
                alt: String(project.name ?? '项目封面'),
                loading: 'lazy',
                style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
              }),
        ),
        h('span', { style: { fontSize: '13px', fontWeight: 600 } }, String(project.name ?? project.id)),
        h(
          'span',
          { style: { fontSize: '12px', opacity: 0.7 } },
          String(project.imageCount ?? 0) + ' 张 · ' + String(project.provider ?? '—'),
        ),
      )
    }

    function ProjectDetail(props) {
      const state = props.state
      const project = state.data
      const items = isObject(project) && isArray(project.items) ? project.items : []

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(
          'div',
          { style: skin.row },
          h(Btn, { onClick: props.onBack }, '← 返回'),
          h('h2', { style: skin.title }, String(project?.name ?? project?.id ?? '项目')),
          state.phase === 'ready' ? h(Pill, null, items.length + ' 个模块') : null,
        ),
        state.phase === 'loading' ? h(LoadingRow, { text: '正在读取项目…' }) : null,
        state.phase === 'error' ? h(Notice, { role: 'alert', title: '读取失败', detail: state.error }) : null,
        state.phase === 'ready' && items.length === 0
          ? h(Notice, { title: '这个项目还没有产出', detail: '生图完成后图片会出现在这里。' })
          : null,
        state.phase === 'ready'
          ? items.map((item, index) =>
              h(
                'div',
                { key: String(item?.module ?? index) + '-' + String(index), style: skin.card },
                h(
                  'div',
                  { style: skin.row },
                  h(
                    'strong',
                    { style: { fontSize: '13px' } },
                    String(item?.label ?? item?.module ?? '未命名模块'),
                  ),
                  h(Pill, null, String(ITEM_STATUS_LABEL[item?.status] ?? item?.status ?? '—')),
                  isString(item?.size) ? h('code', { style: skin.code }, item.size) : null,
                ),
                isArray(item?.images) && item.images.length > 0
                  ? h(
                      'div',
                      {
                        style: {
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                          gap: '8px',
                        },
                      },
                      item.images.map((imageName, ii) => {
                        const url = fileUrl(project.id, imageName)
                        return url === null
                          ? null
                          : h('img', {
                              key: 'i' + String(ii),
                              src: url,
                              alt: String(item?.label ?? '产出图'),
                              loading: 'lazy',
                              style: {
                                width: '100%',
                                aspectRatio: '1 / 1',
                                objectFit: 'cover',
                                borderRadius: '6px',
                                display: 'block',
                                background: 'color-mix(in srgb, currentColor 6%, transparent)',
                              },
                            })
                      }),
                    )
                  : h('p', { style: skin.muted }, '这个模块没有产出图片。'),
              ),
            )
          : null,
      )
    }

    function WorkbenchPanel() {
      const selected = useStore(selectedProject)
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null })
      const [detail, setDetail] = React.useState({ phase: 'idle', data: null, error: null })

      const loadList = React.useCallback(
        () =>
          apiGet('api/projects?limit=' + String(PROJECT_LIST_LIMIT), isProjectList).then((result) => {
            if (result.ok) setState({ phase: 'ready', data: result.data, error: null })
            else setState({ phase: 'error', data: null, error: result.error })
          }),
        [],
      )

      React.useEffect(() => {
        loadList()
      }, [loadList])

      React.useEffect(() => {
        if (selected === null) {
          setDetail({ phase: 'idle', data: null, error: null })
          return undefined
        }
        let alive = true
        setDetail({ phase: 'loading', data: null, error: null })
        apiGet('api/projects/' + encodeURIComponent(selected), isProjectDetail).then((result) => {
          if (!alive) return
          if (result.ok) setDetail({ phase: 'ready', data: result.data.project, error: null })
          else setDetail({ phase: 'error', data: null, error: result.error })
        })
        return () => {
          alive = false
        }
      }, [selected])

      const header = h(
        'div',
        { style: { ...skin.row, justifyContent: 'space-between' } },
        h('h2', { style: skin.title }, '作品库'),
        h(Btn, { onClick: () => loadList() }, '刷新'),
      )

      if (selected !== null) {
        return h(
          'div',
          { style: skin.wrap },
          header,
          h(ProjectDetail, { state: detail, onBack: () => selectedProject.set(null) }),
        )
      }

      const projects = state.phase === 'ready' ? state.data.projects.filter(isObject) : []

      return h(
        'div',
        { style: skin.wrap },
        header,
        state.phase === 'loading' ? h(LoadingRow, { text: '正在读取项目列表…' }) : null,
        state.phase === 'error'
          ? h(
              Notice,
              { role: 'alert', title: '读取作品库失败', detail: state.error },
              h(Btn, { onClick: () => loadList() }, '重试'),
            )
          : null,
        state.phase === 'ready' && projects.length === 0
          ? h(Notice, {
              title: '还没有作品',
              detail: '用 pixmart_generate / pixmart_batch 生成后会出现在这里。',
            })
          : null,
        state.phase === 'ready' && projects.length > 0
          ? h(
              'div',
              {
                style: {
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                  gap: '12px',
                },
              },
              projects.map((project) =>
                h(ProjectCard, {
                  key: String(project.id),
                  project,
                  onOpen: (id) => selectedProject.set(id),
                }),
              ),
            )
          : null,
      )
    }

    // ── ③ shell.overlay 实时预览卡（§8.5） ──────────────────────────────────

    function ProgressRing(props) {
      const total = props.total > 0 ? props.total : 1
      const done = Math.max(0, Math.min(total, props.completed))
      const failed = Math.max(0, Math.min(total - done, props.failed))
      const doneDeg = (done / total) * 360
      const failDeg = (failed / total) * 360
      const background =
        failed > 0
          ? 'conic-gradient(' +
            COLORS.ok + ' 0deg ' + doneDeg + 'deg, ' +
            COLORS.fail + ' ' + doneDeg + 'deg ' + (doneDeg + failDeg) + 'deg, ' +
            COLORS.track + ' ' + (doneDeg + failDeg) + 'deg 360deg)'
          : 'conic-gradient(' +
            COLORS.ok + ' 0deg ' + doneDeg + 'deg, ' +
            COLORS.track + ' ' + doneDeg + 'deg 360deg)'
      return h(
        'span',
        {
          'aria-hidden': 'true',
          className: 'pxm-ring',
          style: {
            position: 'relative',
            width: '36px',
            height: '36px',
            borderRadius: '50%',
            display: 'inline-flex',
            flex: '0 0 auto',
            background,
          },
        },
        h(
          'span',
          {
            style: {
              position: 'absolute',
              inset: '3px',
              borderRadius: '50%',
              background: 'Canvas',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '10px',
              fontWeight: 700,
            },
          },
          String(done) + '/' + String(total),
        ),
      )
    }

    function ItemChip(props) {
      const run = props.run
      const item = props.item
      const status = isString(item.status) ? item.status : 'queued'
      const label = String(item.label ?? item.module ?? '模块')
      const url = status === 'done' ? fileUrl(run.projectId, item.file) : null
      const borderColor =
        status === 'done' ? COLORS.ok : status === 'failed' ? COLORS.fail : status === 'running' ? COLORS.run : COLORS.track
      const title =
        label +
        ' · ' +
        String(ITEM_STATUS_LABEL[status] ?? status) +
        (isNumber(item.width) && isNumber(item.height) ? ' · ' + item.width + '×' + item.height : '') +
        (status === 'failed' && isObject(item.error) && isString(item.error.message)
          ? ' · ' + item.error.message
          : '')

      const runningDeg = status === 'running' ? 120 : 0

      return h(
        'div',
        {
          title,
          className: 'pxm-chip' + (status === 'running' ? ' pxm-chip-running' : ''),
          style: {
            position: 'relative',
            flex: '0 0 auto',
            width: '56px',
            height: '56px',
            borderRadius: '8px',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            fontSize: '9px',
            lineHeight: 1.2,
            padding: '2px',
            border: '2px solid ' + borderColor,
            background: 'color-mix(in srgb, currentColor 6%, transparent)',
            opacity: status === 'queued' || status === 'skipped' ? 0.5 : 1,
          },
        },
        url !== null
          ? h('img', {
              src: url,
              alt: label,
              loading: 'lazy',
              style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
            })
          : h(
              'span',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '3px',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '100%',
                  height: '100%',
                },
              },
              status === 'running'
                ? h('span', {
                    className: 'pxm-ring',
                    style: {
                      position: 'relative',
                      width: '18px',
                      height: '18px',
                      borderRadius: '50%',
                      background:
                        'conic-gradient(currentColor 0deg ' +
                        String(runningDeg) +
                        'deg, color-mix(in srgb, currentColor 18%, transparent) ' +
                        String(runningDeg) +
                        'deg 360deg)',
                    },
                  })
                : null,
              h(
                'span',
                { style: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                label.length > 10 ? label.slice(0, 10) + '…' : label,
              ),
              h('span', { style: { opacity: 0.62 } }, String(ITEM_STATUS_LABEL[status] ?? status)),
            ),
      )
    }

    function PreviewBadge(props) {
      const run = props.run
      const total = isNumber(run.total) ? run.total : 0
      const done = isNumber(run.completed) ? run.completed : 0
      const failed = isNumber(run.failed) ? run.failed : 0
      const active = isActive(run.status)
      const label =
        (active ? '生图进行中 ' : '生图' + String(RUN_STATUS_LABEL[run.status] ?? run.status) + ' ') +
        String(done) +
        '/' +
        String(total)

      return h(
        'button',
        {
          type: 'button',
          className: 'pxm-btn pxm-badge',
          onClick: props.onExpand,
          'aria-label': label + '，点击展开预览',
          title: label,
          style: {
            font: 'inherit',
            fontSize: '12px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 10px',
            borderRadius: '999px',
            cursor: 'pointer',
            color: 'inherit',
            background: 'Canvas',
            border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
            boxShadow: '0 6px 20px rgba(0, 0, 0, 0.22)',
          },
        },
        active ? h(Spinner, null) : h('span', { 'aria-hidden': 'true' }, failed > 0 ? '!' : '✓'),
        h('span', null, String(done) + '/' + String(total)),
        failed > 0 ? h(Pill, null, '失败 ' + String(failed)) : null,
      )
    }

    function PreviewCard(props) {
      const run = props.run
      const total = isNumber(run.total) ? run.total : 0
      const done = isNumber(run.completed) ? run.completed : 0
      const failed = isNumber(run.failed) ? run.failed : 0
      const items = isArray(run.items) ? run.items.filter(isObject) : []
      const active = isActive(run.status)
      const others = isArray(props.activeRuns)
        ? props.activeRuns.filter((other) => isObject(other) && other.runId !== run.runId)
        : []
      const [cancelling, setCancelling] = React.useState(false)

      const live =
        '生图进度 ' +
        String(done) +
        ' / ' +
        String(total) +
        (failed > 0 ? '，失败 ' + String(failed) : '') +
        (active ? '，当前 ' + String(run.currentLabel ?? '—') : '') +
        '，状态 ' +
        String(RUN_STATUS_LABEL[run.status] ?? run.status)

      const onCancel = () => {
        setCancelling(true)
        Promise.resolve(props.onCancel(run.runId)).then(
          () => setCancelling(false),
          () => setCancelling(false),
        )
      }

      return h(
        'div',
        {
          className: 'pxm-card',
          'aria-label': 'PixMart 生图预览',
          style: {
            width: 'min(320px, calc(100vw - 24px))',
            maxHeight: '40vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            borderRadius: '12px',
            border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
            background: 'Canvas',
            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.28)',
            fontSize: '12px',
          },
        },

        // 头部：计数 + 当前模块 + 取消 / 收起
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 10px',
              borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
            },
          },
          h(ProgressRing, { completed: done, failed, total }),
          h(
            'div',
            { style: { flex: '1 1 auto', minWidth: 0 } },
            h(
              'div',
              {
                style: {
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              String(run.projectName ?? 'PixMart 生图'),
            ),
            h(
              'div',
              {
                style: {
                  opacity: 0.7,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              String(RUN_STATUS_LABEL[run.status] ?? run.status) +
                ' · ' +
                String(done) +
                '/' +
                String(total) +
                (active && isString(run.currentLabel) ? ' · ' + run.currentLabel : ''),
            ),
          ),
          active
            ? h(
                Btn,
                { onClick: onCancel, disabled: cancelling, title: '取消这次运行（已产出的图保留）' },
                cancelling ? '取消中…' : '取消',
              )
            : h('span', { style: { opacity: 0.7, whiteSpace: 'nowrap' } }, isTerminal(run.status) ? '已结束' : ''),
          h(Btn, { onClick: props.onCollapse, title: '收起为徽标（Esc）' }, '收起'),
        ),

        // stale 徽标：刷新失败时保留最后一次成功快照
        props.stale === true
          ? h(
              'div',
              {
                role: 'status',
                style: {
                  padding: '4px 10px',
                  background: 'color-mix(in srgb, #f59e0b 18%, transparent)',
                  borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
                },
              },
              '数据可能过期：最近一次刷新失败，显示最后一次成功快照。',
            )
          : null,

        // 多任务：同会话最多 1 张卡 + +N 计数，点击切换
        others.length > 0
          ? h(
              'div',
              { style: { padding: '6px 10px 0', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
              h('span', { style: { opacity: 0.7 } }, '+' + String(others.length) + ' 进行中：'),
              others.map((other) =>
                h(
                  'button',
                  {
                    key: String(other.runId),
                    type: 'button',
                    className: 'pxm-btn',
                    onClick: () => props.onSelect(other),
                    title: String(other.projectName ?? other.runId),
                    style: {
                      font: 'inherit',
                      fontSize: '11px',
                      padding: '1px 6px',
                      borderRadius: '999px',
                      color: 'inherit',
                      cursor: 'pointer',
                      border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
                      background: 'color-mix(in srgb, currentColor 8%, transparent)',
                    },
                  },
                  String(other.completed ?? 0) + '/' + String(other.total ?? 0),
                ),
              ),
            )
          : null,

        // 内容区：内部滚动，逐格点亮缩略图
        h(
          'div',
          {
            className: 'pxm-scroll',
            style: {
              display: 'flex',
              gap: '6px',
              padding: '8px 10px',
              overflow: 'auto',
              minHeight: 0,
              flex: '1 1 auto',
            },
          },
          items.length === 0
            ? h('span', { style: { opacity: 0.7 } }, '正在准备任务…')
            : items.map((item, index) => h(ItemChip, { key: String(item.index ?? index), run, item })),
        ),

        h(
          'div',
          {
            style: {
              padding: '6px 10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
            },
          },
          h(
            'span',
            {
              style: {
                opacity: 0.7,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            String(run.provider ?? '') + ' · ' + String(run.model ?? '') + ' · ' + String(run.size ?? ''),
          ),
          h(
            'span',
            { className: 'pxm-visually-hidden', 'aria-live': 'polite', 'aria-atomic': 'true' },
            live,
          ),
        ),
      )
    }

    /**
     * `shell.overlay` 贡献者。
     *
     * - 空闲（宿主里没有运行记录）时**不渲染任何 DOM**，且轮询停表。
     * - 有运行在跑：展开卡片，1s 轮询；结束收成徽标并保留（不自动消失、不撑大）。
     * - 首屏恢复不自动展开：由「运行开始时刻 vs 本页面加载基线」判定（§8.5.5），
     *   只有本页面加载之后新开始的运行才自动展开；用户的展开/收起手动覆盖优先。
     * - 点击穿透：外层容器 `pointer-events:none`，只有卡片/徽标自己 `auto`。
     */
    function PreviewOverlay() {
      const state = useStore(previewState)
      const run = state.run

      /**
       * 手动覆盖：`{ runId, expanded }`。
       * runId 不匹配当前运行即视为过期，回到自动策略。
       */
      const [override, setOverride] = React.useState(null)
      const [escaped, setEscaped] = React.useState(false)

      React.useEffect(() => {
        runPoller.start()
        const onVisible = () => {
          if (document.hidden !== true) runPoller.refresh()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          document.removeEventListener('visibilitychange', onVisible)
          runPoller.stop()
        }
      }, [])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') setEscaped(true)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      if (run === null || run === undefined) return null

      // 自动策略（§8.5.5 / D12「运行中展开；结束后收成徽标并保留，用户可固定展开」）：
      //   - 本页面加载之后新开始 **且仍在跑** → 自动展开；
      //   - 首屏已存在的运行（恢复）→ 只显示徽标，避免首轮请求回来时大幅位移；
      //   - 结束（done / failed / cancelled / interrupted）→ 收回徽标，不留在展开态。
      // 手动覆盖（override）优先于自动策略，所以「用户手动展开 = 固定展开」。
      const startedAfterLoad =
        isNumber(state.firstSeenAt) && isNumber(baseline.mountedAt)
          ? state.firstSeenAt >= baseline.mountedAt
          : false
      const autoExpanded = startedAfterLoad && isActive(run.status) && !escaped
      const expanded =
        override !== null && override.runId === run.runId ? override.expanded : autoExpanded

      const setExpanded = (next) => {
        setEscaped(false)
        setOverride({ runId: run.runId, expanded: next })
      }

      return h(
        'div',
        {
          className: 'pxm-overlay',
          'data-plugin': PLUGIN,
          style: {
            position: 'fixed',
            right: '16px',
            bottom: '16px',
            zIndex: 60,
            pointerEvents: 'none',
            display: 'flex',
            justifyContent: 'flex-end',
          },
        },
        expanded
          ? h(PreviewCard, {
              run,
              stale: state.stale,
              activeRuns: state.activeRuns,
              onCollapse: () => setExpanded(false),
              onCancel: (runId) => runPoller.cancel(runId),
              onSelect: (other) => runPoller.selectRun(other),
            })
          : h(PreviewBadge, {
              run,
              onExpand: () => setExpanded(true),
            }),
      )
    }

    // ── 样式：自建 <style data-plugin="dsh-pixmart">，随 disposer 移除 ───────

    const CSS = [
      '.pxm-overlay>div,.pxm-overlay>button{pointer-events:auto;}',
      '.pxm-card{animation:pxm-in .16s ease-out;}',
      '@keyframes pxm-in{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}',
      '.pxm-spin{animation:pxm-turn 1s linear infinite;}',
      '@keyframes pxm-turn{to{transform:rotate(360deg);}}',
      '.pxm-chip-running{animation:pxm-pulse 1.4s ease-in-out infinite;}',
      '@keyframes pxm-pulse{0%,100%{opacity:1;}50%{opacity:.62;}}',
      '.pxm-scroll{scrollbar-width:thin;}',
      '.pxm-btn:focus-visible,.pxm-tile:focus-visible,.pxm-badge:focus-visible{outline:2px solid currentColor;outline-offset:2px;}',
      '.pxm-visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;}',
      /* 窄屏（<640px）：退化为底部整宽 + 另设更小高度上限 */
      '@media (max-width:640px){',
      '.pxm-overlay{left:0;right:0;bottom:0;justify-content:center;align-items:flex-end;padding:0 8px 8px;}',
      '.pxm-card{width:100%!important;max-width:none!important;max-height:32vh!important;border-radius:12px 12px 0 0;}',
      '}',
      '@media (prefers-reduced-motion:reduce){',
      '.pxm-card{animation:none!important;}',
      '.pxm-spin{animation:none!important;}',
      '.pxm-chip-running{animation:none!important;}',
      '}',
    ].join('\n')

    function mountStyle() {
      if (typeof document === 'undefined' || document.head === null) return () => {}
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) existing.remove()
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-plugin', PLUGIN)
      style.textContent = CSS
      document.head.appendChild(style)
      return () => {
        style.remove()
      }
    }

    // ── 注册 ────────────────────────────────────────────────────────────────

    const name = PLUGIN
    const inject = ['slots']

    function warn(where, err) {
      const detail = err && err.message ? err.message : String(err)
      try {
        console.warn('[dsh-pixmart] ' + where + ' 失败：' + detail)
      } catch {
        /* 控制台不可用也无所谓 */
      }
    }

    /**
     * 每个插槽独立注册、独立 try/catch：
     * 宿主版本旧、插槽不存在或注册签名变化时，**只让该功能缺失**，绝不冒泡到设置面板。
     */
    function registerSlot(ctx, slotName, params, Component, effectLabel) {
      ctx.effect(() => {
        let dispose = null
        try {
          dispose = ctx.slots.inject(slotName, () => {
            try {
              return ctx.slots.register(params, Component)
            } catch (err) {
              warn('register ' + slotName, err)
              return undefined
            }
          })
        } catch (err) {
          warn('inject ' + slotName, err)
          return undefined
        }
        return () => {
          if (typeof dispose === 'function') {
            try {
              dispose()
            } catch (err) {
              warn('dispose ' + slotName, err)
            }
          }
        }
      }, effectLabel)
    }

    function apply(ctx) {
      // 样式随 fiber 清理
      ctx.effect(() => mountStyle(), 'dsh-pixmart: styles')

      // ① 设置页：settings.section
      registerSlot(
        ctx,
        'settings.section',
        { name: 'settings.section', id: SETTINGS_ID, order: 30, label: SLOT_LABEL },
        ProvidersSection,
        'dsh-pixmart: settings section',
      )

      // ② 侧边栏图标（id 与 main 的 key 一一对应）
      registerSlot(
        ctx,
        'sidebar.panellist',
        { name: 'sidebar.panellist', id: PANEL_KEY, order: 10, label: SLOT_LABEL },
        PanelIcon,
        'dsh-pixmart: sidebar panel icon',
      )

      // ② 中央主面板作品库
      registerSlot(
        ctx,
        'main',
        { name: 'main', key: PANEL_KEY },
        WorkbenchPanel,
        'dsh-pixmart: main panel',
      )

      // ③ 实时预览浮层
      registerSlot(
        ctx,
        'shell.overlay',
        { name: 'shell.overlay', id: OVERLAY_ID, order: 50 },
        PreviewOverlay,
        'dsh-pixmart: run preview overlay',
      )

      // 轮询器随 fiber 彻底停表（fiber 重建后可重新 start）
      ctx.effect(
        () => () => {
          runPoller.halt()
        },
        'dsh-pixmart: run poller',
      )
    }

    /**
     * 测试入口（jsdom lane 专用）。
     *
     * `test/client-dom.test.mjs` 要真的把组件挂进 jsdom、按毫秒推进 mock timer，
     * 再检查轮询节奏与浮层状态机，因此这里把组件与状态机内部件一并挂出来。
     * **生产路径只读 `name` / `inject` / `apply` 三个键，永远不会碰这个 `__test__`**，
     * 所以多挂一个键对宿主是安全的；它不参与任何注册、也不在被测逻辑里被读取。
     */
    const __test__ = {
      // 组件
      PreviewOverlay,
      PreviewCard,
      PreviewBadge,
      ProvidersSection,
      WorkbenchPanel,
      PanelIcon,
      // 状态机 / 轮询器：jsdom lane 用来读快照、推进一次同步
      runPoller,
      previewState,
      selectedProject,
      previewEmptyState,
      // 纯函数与常量
      fileUrl,
      relativeUrl,
      isActive,
      isTerminal,
      POLL_ACTIVE_MS,
      POLL_IDLE_MS,
    }

    return { name, inject, apply, __test__ }
  },
})
