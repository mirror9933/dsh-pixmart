/**
 * dsh-pixmart client 半 —— 作品库 / 设置页 / 生图实时预览。
 *
 * 装载契约（见 docs/contract-notes.md §3.1）：
 *   - 产物是 `window.__ModuleLoader__.load({ id:'dsh-pixmart', factory })`；
 *   - `factory(require)` **只收到 require**，没有 `host.call`。
 *     因此与宿主通信**只能**走本插件自己的 HTTP 路由（§3.2 的 RPC 机制修正）。
 *
 * 三处落点（技术方案 §8.2）：
 *   ① settings.section    → 设置面板左导航多一项「PixMart」：厂商/默认值/数据目录/累计用量
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
    /**
     * 两处插槽共用的显示名：设置面板左导航的一项 + 左侧栏面板图标那一项。
     * 用产品名 `PixMart`（与页面标题、包名一致）。若要两处叫不同名字，拆成两个常量即可。
     */
    const SLOT_LABEL = 'PixMart'
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

    /**
     * 把宿主的内部错误翻译成**用户能据以行动**的提示。
     *
     * 背景：DSH 的两半不对称——客户端刷新即生效，宿主必须重启。宿主还是旧代码时，
     * 新接口会落到路由兜底并回 `unknown_route`，而它的 message 是内部路由片段
     * （如 `/providers/ofox/test`）。那条文案看起来像客户端拼错了 URL，
     * 实际是"宿主没重启"。这个歧义已经让用户白测过一轮，这里翻译掉。
     */
    const HOST_STALE_HINT = '宿主未加载此接口，请重启 DeepSeek Harness 后重试'

    function explainHostError(code, message) {
      if (code === 'unknown_route') return HOST_STALE_HINT
      return message
    }

    /**
     * 作品库写动作（导出 / 删除）失败时的**可行动**提示。
     *
     * 入参直接用 `apiPost` 返回的 `{ error, code }`（error 已经是可读文案）。
     *
     * `no_export_dir` 是语义变更后新增的一条：生图不再自动复制，导出必须由用户
     * 显式触发，因此"没配导出路径"是**正常分支**而不是异常。这里把它翻成一句
     * 指向设置页的话——**绝不静默失败**（方案里对复制提示词按钮的同一条红线）。
     */
    function explainProjectActionError(code, message) {
      const text = isString(message) ? message : ''
      if (code === 'no_export_dir') {
        return (
          '还没有配置「作品库导出路径」：请到 设置 → PixMart → 作品库导出路径 填一个绝对路径，再回来点「导出图片」。' +
          (text === '' ? '' : '（宿主原话：' + text + '）')
        )
      }
      return text === '' ? '操作失败' : text
    }

    /** 取数助手：no-store + 形状校验 + 不抛异常。 */
    async function apiGet(path, validate) {
      if (BASE === null) return { ok: false, error: '无法解析插件基址' }
      const url = relativeUrl(path)
      if (url === null) return { ok: false, error: '无法解析请求地址' }
      try {
        const response = await fetch(url, { cache: 'no-store' })
        if (!response.ok) {
          // 失败响应里也可能带结构化 error（例如 unknown_route），先试着读出来，
          // 否则 GET 只会给一个干巴巴的 "HTTP 404"。
          const payload = await response.json().catch(() => null)
          const detail = isObject(payload) && isObject(payload.error) ? payload.error : {}
          const code = isString(detail.code) ? detail.code : 'http_' + String(response.status)
          const raw = isString(detail.message)
            ? detail.message
            : 'HTTP ' + String(response.status)
          return { ok: false, error: explainHostError(code, raw), code, status: response.status }
        }
        const body = await response.json().catch(() => null)
        if (typeof validate === 'function' && !validate(body)) {
          return { ok: false, error: '响应形状不符合预期' }
        }
        return { ok: true, data: body }
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : '请求失败' }
      }
    }

    /** 写请求：把宿主结构化 error 的 code/message 提出来，便于在卡片里显示可读原因。 */
    async function apiPost(path, body, validate) {
      if (BASE === null) return { ok: false, error: '无法解析插件基址' }
      const url = relativeUrl(path)
      if (url === null) return { ok: false, error: '无法解析请求地址' }
      try {
        const response = await fetch(url, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body === undefined ? {} : body),
        })
        const payload = await response.json().catch(() => null)
        if (!isObject(payload)) {
          return { ok: false, error: 'HTTP ' + String(response.status) + '：响应不是 JSON' }
        }
        if (payload.ok !== true) {
          const detail = isObject(payload.error) ? payload.error : {}
          const code = isString(detail.code) ? detail.code : 'http_' + String(response.status)
          // 把宿主的结构化 error 提到顶层，调用方不必再解一层。这里只搬
          // `code` / `message` 两个字符串，**绝不把整个 payload 当文案**。
          const message = isString(detail.message)
            ? detail.message
            : 'HTTP ' + String(response.status) + '：请求失败'
          return {
            ok: false,
            error: explainHostError(code, message),
            code,
            status: response.status,
            data: payload,
          }
        }
        if (typeof validate === 'function' && !validate(payload)) {
          return { ok: false, error: '响应形状不符合预期', status: response.status }
        }
        return { ok: true, data: payload, status: response.status }
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : '请求失败' }
      }
    }

    const isRunList = (v) => isObject(v) && v.ok === true && isArray(v.runs)
    const isRunDetail = (v) => isObject(v) && v.ok === true && isObject(v.run) && isArray(v.run.items)
    const isProjectList = (v) => isObject(v) && v.ok === true && isArray(v.projects)
    const isProjectDetail = (v) => isObject(v) && v.ok === true && isObject(v.project)
    const isTrashList = (v) => isObject(v) && v.ok === true && isArray(v.trash)
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
          className: isString(props.className) ? 'pxm-btn ' + props.className : 'pxm-btn',
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

    // ── ① settings.section：厂商（可写）/ 默认值（可写）/ 数据目录 / 累计用量 ──

    /** 「结果」小字：成功一行、失败一行；**绝不把任何密钥值放进来**。 */
    function Msg(props) {
      if (!isObject(props.result)) return null
      const failed = props.result.ok !== true
      return h(
        'span',
        {
          role: failed ? 'alert' : 'status',
          style: {
            fontSize: '12px',
            lineHeight: 1.6,
            color: failed ? '#ef4444' : '#22c55e',
            wordBreak: 'break-word',
          },
        },
        String(props.result.text ?? ''),
      )
    }

    function Field(props) {
      return h(
        'label',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '3px',
            fontSize: '12px',
            flex: '1 1 180px',
            minWidth: 0,
            // 允许调用方覆盖布局（例如让某个字段独占一行）
            ...(isObject(props.style) ? props.style : {}),
          },
        },
        h('span', { style: { opacity: 0.7 } }, props.label),
        ...(isArray(props.children) ? props.children : [props.children]),
      )
    }

    const inputStyle = {
      font: 'inherit',
      fontSize: '12px',
      padding: '3px 6px',
      borderRadius: '6px',
      color: 'inherit',
      background: 'transparent',
      border: '1px solid color-mix(in srgb, currentColor 24%, transparent)',
      width: '100%',
      boxSizing: 'border-box',
    }

    function TextInput(props) {
      return h('input', {
        type: props.type ?? 'text',
        style: inputStyle,
        value: props.value ?? '',
        placeholder: props.placeholder,
        disabled: props.disabled === true,
        autoComplete: props.autoComplete ?? 'off',
        spellCheck: false,
        onChange: props.onChange,
        onBlur: props.onBlur,
      })
    }

    function Select(props) {
      const options = isArray(props.options) ? props.options : []
      return h(
        'select',
        {
          style: inputStyle,
          value: props.value ?? '',
          disabled: props.disabled === true,
          onChange: props.onChange,
        },
        ...options.map((option, index) =>
          h('option', { key: 'o' + String(index), value: option.value }, option.label),
        ),
      )
    }

    /**
     * 一次写操作的公共状态：`busy`（按钮禁用，防重复提交）+ `result`（卡片内提示）。
     * 组件卸载后落地的响应直接丢弃，避免对已卸载组件 setState。
     */
    function useMutation() {
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const alive = React.useRef(true)
      React.useEffect(
        () => () => {
          alive.current = false
        },
        [],
      )
      const run = React.useCallback(async (fn) => {
        setBusy(true)
        setResult(null)
        let outcome
        try {
          outcome = await fn()
        } catch (err) {
          // 任何意外都收敛成卡片内提示，绝不冒泡成白屏
          outcome = { ok: false, error: err && err.message ? err.message : '请求失败' }
        }
        if (!alive.current) return outcome
        setBusy(false)
        if (isObject(outcome)) setResult(outcome)
        return outcome
      }, [])
      return { busy, result, run }
    }

    /** 把 `apiPost` 的返回统一成 `{ok, text}`。 */
    function postResult(outcome, okText) {
      if (isObject(outcome) && outcome.ok === true) return { ok: true, text: okText }
      const detail = isObject(outcome) && isString(outcome.error) ? outcome.error : '请求失败'
      const code = isObject(outcome) && isString(outcome.code) ? '（' + outcome.code + '）' : ''
      return { ok: false, text: detail + code }
    }

    /**
     * 图像模型名的**启发式**判据（纯客户端本地判断，不依赖厂商元数据）。
     *
     * 为什么必须靠名字猜：聚合商的模型目录里没有任何"能不能生图"的字段，而实测
     * Ofox 一次返回 150 个模型、其中绝大多数是纯文本模型。用户真正想要的往往是
     * 其中个位数的图像模型，所以这里给一个「只选图像模型」的快捷判据。
     * 覆盖主流命名：gemini.*image / imagen / nano-banana / gpt-image / dall-e /
     * qwen.*image / seedream / wan.*image / flux / stable-diffusion / kolors。
     * 它是**启发式**——漏判只让那一行少一个「图像」标记，不会丢模型。
     */
    const IMAGE_MODEL_PATTERNS = [
      /gemini.*image/i,
      /imagen/i,
      /nano-?banana/i,
      /gpt-image/i,
      /dall-?e/i,
      /qwen.*image/i,
      /seedream/i,
      /wan.*image/i,
      /flux/i,
      /stable-?diffusion/i,
      /kolors/i,
    ]

    /** 模型名是否像图像模型。 */
    function isImageModel(name) {
      const text = String(name)
      return IMAGE_MODEL_PATTERNS.some((pattern) => pattern.test(text))
    }

    /** 「模型」行：超过 8 个只列前 8 个（全量在拉取面板里看），避免一行被 150 项撑爆。 */
    function describeModels(raw) {
      const list = isArray(raw) ? raw.map(String) : []
      if (list.length === 0) return '未声明（可点「拉取模型」）'
      const head = list.slice(0, 8)
      return (
        head.join(' / ') +
        (list.length > head.length ? ' …（共 ' + String(list.length) + ' 个）' : '')
      )
    }

    /**
     * 模型选择面板：拉取结果只读展示 + 复选 + 显式保存。
     *
     * 三处「作用域」必须写在界面上，否则 150 行的列表很容易让人以为选的是全部：
     *   - 搜索框：按**子串**过滤（大小写不敏感）；
     *   - 「全选 / 全不选」：只作用于**当前筛选结果**，按钮文案带数量；
     *   - 「只选图像模型」：按上面的启发式**重设**选择（不是追加），命中的行带「图像」标记。
     *
     * 列表内部滚动（`max-height: 240px`）：150 项不能把卡片撑爆。
     * 本组件自己**不发请求**：保存交给父级的 mutation，失败原因也在面板内显示。
     */
    function ModelPickerPanel(props) {
      const list = isArray(props.models) ? props.models.map(String) : []
      const initial = isArray(props.initial) ? props.initial.map(String) : []
      const [search, setSearch] = React.useState('')
      const [selected, setSelected] = React.useState(() =>
        initial.filter((name) => list.indexOf(name) >= 0),
      )

      const keyword = search.trim().toLowerCase()
      const visible =
        keyword === '' ? list : list.filter((name) => name.toLowerCase().indexOf(keyword) >= 0)
      const chosen = new Set(selected)
      const imageCount = list.filter(isImageModel).length
      const busy = props.busy === true

      const toggle = (name) =>
        setSelected((prev) =>
          prev.indexOf(name) >= 0 ? prev.filter((item) => item !== name) : prev.concat([name]),
        )

      /** 只加不减：不动筛选结果之外的选择。 */
      const selectAllVisible = () =>
        setSelected((prev) => {
          const next = prev.slice()
          for (const name of visible) if (next.indexOf(name) < 0) next.push(name)
          return next
        })

      /** 只减不加：同样只作用于当前筛选结果。 */
      const clearVisible = () =>
        setSelected((prev) => prev.filter((name) => visible.indexOf(name) < 0))

      const onlyImage = () => setSelected(list.filter(isImageModel))

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            padding: '8px',
            borderRadius: '8px',
            border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
            background: 'color-mix(in srgb, currentColor 4%, transparent)',
          },
        },
        h(
          'div',
          { style: { ...skin.row, gap: '8px' } },
          h(
            'span',
            { style: { fontSize: '12px', fontWeight: 600 } },
            '选择要保留的模型',
          ),
          h(
            'span',
            { style: { fontSize: '12px', opacity: 0.8 } },
            '已选 ' + String(selected.length) + ' / 共 ' + String(list.length) +
              (keyword === '' ? '' : '（筛选后 ' + String(visible.length) + ' 项）'),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' } },
          h('div', { style: { flex: '1 1 160px', minWidth: 0 } },
            h(TextInput, {
              value: search,
              disabled: busy,
              placeholder: '搜索模型…',
              onChange: (event) => setSearch(event.target.value),
            })),
          h(
            Btn,
            {
              disabled: busy || visible.length === 0,
              onClick: selectAllVisible,
              title: '只选中当前搜索结果里的模型，不影响其他行',
            },
            '全选（当前 ' + String(visible.length) + ' 个）',
          ),
          h(
            Btn,
            {
              disabled: busy || visible.length === 0,
              onClick: clearVisible,
              title: '只取消当前搜索结果里的模型，不影响其他行',
            },
            '全不选（当前 ' + String(visible.length) + ' 个）',
          ),
          h(
            Btn,
            {
              disabled: busy || imageCount === 0,
              onClick: onlyImage,
              title: '按模型名启发式选中全部图像模型（会替换当前选择）',
            },
            '只选图像模型（' + String(imageCount) + ' 个）',
          ),
        ),
        h(
          'div',
          {
            style: {
              maxHeight: '240px',
              overflowY: 'auto',
              border: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
              borderRadius: '6px',
              padding: '4px 6px',
              display: 'flex',
              flexDirection: 'column',
            },
          },
          visible.length === 0
            ? h('span', { style: { fontSize: '12px', opacity: 0.7 } }, '没有匹配的模型')
            : visible.map((name) =>
                h(
                  'label',
                  {
                    key: name,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '12px',
                      lineHeight: 1.8,
                      cursor: busy ? 'not-allowed' : 'pointer',
                    },
                  },
                  h('input', {
                    type: 'checkbox',
                    checked: chosen.has(name),
                    disabled: busy,
                    onChange: () => toggle(name),
                  }),
                  h('span', { style: { wordBreak: 'break-all' } }, name),
                  isImageModel(name) ? h(Pill, null, '图像') : null,
                ),
              ),
        ),
        h(
          'div',
          { style: { ...skin.row, gap: '8px' } },
          h(
            Btn,
            {
              disabled: busy || selected.length === 0,
              onClick: () => props.onSave(list.filter((name) => chosen.has(name))),
              title: '只把已选中的模型写进 config.json（拉取本身不写配置）',
            },
            busy ? '保存中…' : '保存选择',
          ),
          h(Btn, { disabled: busy, onClick: () => props.onCancel() }, '取消'),
          busy ? h(Spinner, { label: '保存中' }) : null,
        ),
        h(Msg, { result: props.result }),
      )
    }

    /** 单个厂商的凭据表单：baseUrl / apiKey / 拉取模型 / 选择模型 / 测试连接。 */
    function ProviderCard(props) {
      const provider = props.provider
      const id = isString(provider.id) ? provider.id : ''
      const hasKey = provider.hasApiKey === true
      const keyFromEnv = provider.apiKeySource === 'env'

      const [baseUrl, setBaseUrl] = React.useState(String(provider.baseUrl ?? ''))
      const [nativeUrl, setNativeUrl] = React.useState(String(provider.geminiNativeBaseUrl ?? ''))
      // 不再暴露 `apiKeyEnv`：环境变量会**优先于**本页填写的密钥，只留字段却藏掉输入框
      // 会变成"哪天环境变量被设上，界面里的 key 就静默失效且无从察觉"。
      // 因此保存凭据时显式清空它（见 writeCredentials 的调用点）。
      const [keyValue, setKeyValue] = React.useState('')
      const creds = useMutation()
      const models = useMutation()
      const probe = useMutation()
      const picker = useMutation()

      /**
       * 拉取结果与面板开合是**两件事**：取消只收起面板，不必再向厂商拉一次。
       * `seq` 每拉一次 +1，用作面板的 key —— 让面板重新挂载、选择状态从最新配置重算。
       */
      const [pull, setPull] = React.useState(null)
      const [pickerOpen, setPickerOpen] = React.useState(false)
      const pullSeq = React.useRef(0)

      /** 卸载后不再 setState：await 之后的 `setPull` / `setPickerOpen` 都要过这一关。 */
      const mounted = React.useRef(true)
      React.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      // 宿主的视图变了（例如拉取模型后重取成功）→ 同步输入框的初值
      React.useEffect(() => {
        setBaseUrl(String(provider.baseUrl ?? ''))
        setNativeUrl(String(provider.geminiNativeBaseUrl ?? ''))
      }, [provider.id, provider.baseUrl, provider.geminiNativeBaseUrl])

      const endpoint = 'api/providers/' + encodeURIComponent(id) + '/'

      const writeCredentials = (payload) =>
        creds.run(async () => {
          const outcome = await apiPost(endpoint + 'credentials', payload)
          if (outcome.ok !== true) return postResult(outcome, '')
          setKeyValue('')
          return postResult(outcome, '已保存')
        }).then((outcome) => {
          if (outcome.ok === true) props.reload()
          return outcome
        })

      /**
       * 拉取模型 —— **只读**。
       *
       * 宿主侧 `refresh-models` 已改为纯读（不写配置），所以这里拿到结果后只做两件事：
       * 展开选择面板、重取 `api/providers` 让「模型」行与配置保持一致。
       * 真正落盘要等用户点面板里的「保存选择」。
       */
      const onRefresh = () =>
        models.run(async () => {
          const outcome = await apiPost(endpoint + 'refresh-models', {})
          if (outcome.ok !== true) return postResult(outcome, '')
          const list = isArray(outcome.data.models) ? outcome.data.models.map(String) : []
          return {
            ok: true,
            text: '已拉取 ' + String(list.length) + ' 个模型',
            models: list,
          }
        }).then((outcome) => {
          if (!mounted.current) return outcome
          if (outcome.ok === true && isArray(outcome.models)) {
            setPull({ models: outcome.models, seq: (pullSeq.current += 1) })
            setPickerOpen(true)
            props.reload()
          }
          return outcome
        })

      /**
       * 保存选择 —— 唯一会写 `provider.models` 的入口。
       * 只提交**已选子集**（面板按拉取列表顺序给出），成功后重取、收起面板、给成功提示。
       */
      const onSaveModels = (chosen) =>
        picker.run(async () => {
          const outcome = await apiPost(endpoint + 'models', { models: chosen })
          if (outcome.ok !== true) return postResult(outcome, '')
          return postResult(outcome, '已保存 ' + String(chosen.length) + ' 个模型')
        }).then((outcome) => {
          if (!mounted.current) return outcome
          if (outcome.ok === true) {
            setPickerOpen(false)
            props.reload()
          }
          return outcome
        })

      const onTest = () =>
        probe.run(async () => {
          const outcome = await apiPost(endpoint + 'test', {})
          if (isObject(outcome) && outcome.ok === true && isObject(outcome.data)) {
            return postResult(outcome, '连接正常')
          }
          const data = isObject(outcome) ? outcome.data : null
          const failure = isObject(data) && isObject(data.error) ? data.error : null
          const message = failure !== null && isString(failure.message) ? failure.message : '连接失败'
          const code = failure !== null && isString(failure.code) ? '（' + failure.code + '）' : ''
          return { ok: false, text: message + code }
        })

      const disableCredentials = creds.busy || id === ''

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            paddingTop: props.index === 0 ? '0' : '10px',
            borderTop:
              props.index === 0
                ? 'none'
                : '1px solid color-mix(in srgb, currentColor 10%, transparent)',
          },
        },
        h(
          'div',
          { style: skin.row },
          h('strong', { style: { fontSize: '13px' } }, String(provider.label ?? id ?? '未命名')),
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
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
          h(
            Field,
            { label: 'Base URL' },
            h(TextInput, {
              value: baseUrl,
              disabled: creds.busy,
              placeholder: 'https://api.example.com/v1',
              onChange: (event) => setBaseUrl(event.target.value),
              onBlur: () => {
                const next = baseUrl.trim()
                if (next !== String(provider.baseUrl ?? '')) writeCredentials({ baseUrl: next })
              },
            }),
          ),
          h(
            Field,
            { label: 'Gemini 原生 Base URL（可选）' },
            h(TextInput, {
              value: nativeUrl,
              disabled: creds.busy,
              placeholder: 'https://api.example.com/gemini/v1beta',
              onChange: (event) => setNativeUrl(event.target.value),
              onBlur: () => {
                const next = nativeUrl.trim()
                if (next !== String(provider.geminiNativeBaseUrl ?? '')) {
                  writeCredentials({ geminiNativeBaseUrl: next })
                }
              },
            }),
          ),
          h(
            Field,
            { label: 'API Key（留空表示不修改）', style: { flex: '1 0 100%' } },
            h(TextInput, {
              type: 'password',
              value: keyValue,
              disabled: creds.busy,
              placeholder: hasKey ? '已就位，留空不改动' : '粘贴密钥',
              autoComplete: 'new-password',
              onChange: (event) => setKeyValue(event.target.value),
            }),
          ),
        ),
        h(
          'div',
          { style: skin.row },
          h(
            Btn,
            {
              disabled: disableCredentials || keyValue === '',
              // 同时清空 apiKeyEnv：环境变量优先级高于本页填写的密钥，
              // 只留字段会变成"哪天环境变量被设上，这里的 key 就静默失效"。
              onClick: () => writeCredentials({ apiKey: keyValue, apiKeyEnv: '' }),
              title: '把上面填写的密钥写入本机配置；同时清空配置里的环境变量名，避免它静默覆盖',
            },
            creds.busy ? '保存中…' : '保存',
          ),
          h(
            Btn,
            {
              disabled: disableCredentials,
              onClick: () => writeCredentials({ apiKey: '', apiKeyEnv: '' }),
              title: '清除本机配置里的密钥与环境变量名',
            },
            '清除密钥',
          ),
          h(
            Btn,
            {
              disabled: models.busy,
              onClick: onRefresh,
              title: 'GET {baseUrl}/models：只拉取，不写配置（写入要显式保存选择）',
            },
            models.busy ? '拉取中…' : '拉取模型',
          ),
          // 取消过面板后还能回来接着选，不必再向厂商拉一次。
          pull !== null && !pickerOpen
            ? h(
                Btn,
                { disabled: picker.busy, onClick: () => setPickerOpen(true) },
                '选择模型（' + String(pull.models.length) + ' 个）',
              )
            : null,
          h(
            Btn,
            { disabled: probe.busy, onClick: onTest, title: '发一次探测请求，不写配置' },
            probe.busy ? '测试中…' : '测试连接',
          ),
          keyFromEnv
            ? h(
                'span',
                { style: { fontSize: '12px', opacity: 0.7 } },
                '当前密钥来自环境变量，清除本页填写不会生效',
              )
            : null,
        ),
        h(Msg, { result: creds.result }),
        h(Msg, { result: models.result }),
        h(Msg, { result: probe.result }),
        h(Msg, { result: picker.result }),
        pull !== null && pickerOpen
          ? h(ModelPickerPanel, {
              key: 'pick-' + String(pull.seq),
              models: pull.models,
              initial: (isArray(provider.models) ? provider.models.map(String) : []).filter(
                (name) => pull.models.indexOf(name) >= 0,
              ),
              busy: picker.busy,
              result: picker.result,
              onSave: onSaveModels,
              onCancel: () => setPickerOpen(false),
            })
          : null,
        h(
          'span',
          { style: { fontSize: '12px', opacity: 0.7, lineHeight: 1.6 } },
          '模型：' + describeModels(provider.models),
        ),
      )
    }

    /** 默认值卡片：provider / model / size 为可选下拉，保存后回传解析过的默认值。 */
    function DefaultsCard(props) {
      const providers = props.providers
      const defaults = props.defaults
      const [provider, setProvider] = React.useState(String(defaults.provider ?? ''))
      const [model, setModel] = React.useState(String(defaults.model ?? ''))
      const [size, setSize] = React.useState(String(defaults.size ?? '1:1'))
      const [n, setN] = React.useState(String(defaults.n ?? 1))
      const save = useMutation()

      React.useEffect(() => {
        setProvider(String(defaults.provider ?? ''))
        setModel(String(defaults.model ?? ''))
        setSize(String(defaults.size ?? '1:1'))
        setN(String(defaults.n ?? 1))
      }, [defaults.provider, defaults.model, defaults.size, defaults.n])

      const current = providers.find((item) => isObject(item) && item.id === provider)
      const models = isObject(current) && isArray(current.models) ? current.models : []
      const sizes =
        isObject(current) && isArray(current.allowedSizes) && current.allowedSizes.length > 0
          ? current.allowedSizes.map(String)
          : ['1:1', '3:4', '4:3', '9:16', '16:9']

      const onProvider = (next) => {
        setProvider(next)
        // 换厂商时若当前模型不在新厂商列表里，就退回该厂商的第一个模型，
        // 避免直接撞上「unknown_model」的 400。
        const target = providers.find((item) => isObject(item) && item.id === next)
        const list = isObject(target) && isArray(target.models) ? target.models.map(String) : []
        if (list.length > 0 && list.indexOf(model) < 0) setModel(list[0])
      }

      const nValue = Number(n)
      const nValid = Number.isInteger(nValue) && nValue >= 1 && nValue <= 4

      const onSave = () =>
        save.run(async () => {
          const payload = { provider, size }
          if (model !== '') payload.model = model
          if (nValid) payload.n = nValue
          const outcome = await apiPost('api/defaults', payload, (payloadShape) =>
            isObject(payloadShape.defaults),
          )
          if (outcome.ok !== true) return postResult(outcome, '')
          return postResult(outcome, '已保存')
        }).then((outcome) => {
          if (outcome.ok === true) props.reload()
          return outcome
        })

      return h(
        'div',
        { style: skin.card },
        h(
          'div',
          { style: skin.row },
          h('strong', { style: { fontSize: '13px' } }, '默认值'),
          h(Pill, null, '生图不带参数时用这一套'),
        ),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
          h(
            Field,
            { label: '厂商' },
            h(Select, {
              value: provider,
              disabled: save.busy,
              options: providers.map((item) => ({
                value: String(item.id ?? ''),
                label: String(item.label ?? item.id ?? '—'),
              })),
              onChange: (event) => onProvider(event.target.value),
            }),
          ),
          h(
            Field,
            { label: '模型' },
            h(Select, {
              value: model,
              disabled: save.busy,
              options: [
                { value: '', label: '（用该厂商的第一个模型）' },
                ...models.map((name) => ({ value: String(name), label: String(name) })),
                // 当前默认模型不在列表里时也显示出来，避免界面与配置不一致
                ...(model !== '' && models.indexOf(model) < 0
                  ? [{ value: model, label: model + '（不在列表里）' }]
                  : []),
              ],
              onChange: (event) => setModel(event.target.value),
            }),
            // 光靠下拉里的「（不在列表里）」不够：那要展开才看得到。
            // 拉取后窄化模型列表就会落到这个状态，所以这里显式提示一句。
            model !== '' && models.indexOf(model) < 0
              ? h(
                  'span',
                  { style: { fontSize: '11px', color: '#b45309', lineHeight: 1.5 } },
                  '该模型不在当前厂商的模型列表里（拉取后窄化列表会这样），建议重新选择',
                )
              : null,
          ),
          h(
            Field,
            { label: '尺寸' },
            h(Select, {
              value: size,
              disabled: save.busy,
              options: sizes.map((name) => ({ value: name, label: name })),
              onChange: (event) => setSize(event.target.value),
            }),
          ),
          h(
            Field,
            { label: '每次张数（1–4）' },
            h(TextInput, {
              type: 'number',
              value: n,
              disabled: save.busy,
              onChange: (event) => setN(event.target.value),
            }),
          ),
        ),
        h(
          'div',
          { style: skin.row },
          h(
            Btn,
            { disabled: save.busy || !nValid, onClick: onSave, title: '写入 config.json 的 defaults' },
            save.busy ? '保存中…' : '保存默认值',
          ),
          nValid ? null : h('span', { style: { fontSize: '12px', color: '#ef4444' } }, '张数应为 1–4 的整数'),
        ),
        h(Msg, { result: save.result }),
      )
    }

    /**
     * 「作品库导出路径」卡片：配置 `exportDir`。
     *
     * 语义变更：这里以前是「产物保存」——配好后每张成功的图都会被**自动复制**一份过去。
     * 那条自动复制已经**取消**（生成不该有未经请求的副作用：图片只落数据目录）。
     * 现在这个路径唯一的用途是：用户在作品库点「导出」时，把该项目的图片复制到
     * `<该路径>/<项目 id>/`。
     *
     * 语义：**留空 = 未配置**（导出按钮会提示先去这里填）；非空必须是绝对路径
     * （宿主侧也会校验并回 `invalid_export_dir`）。失焦与点「保存」等价，
     * 成功后重取 `api/providers`。
     */
    function ExportDirCard(props) {
      const current = isString(props.exportDir) ? props.exportDir : ''
      const [value, setValue] = React.useState(current)
      const save = useMutation()
      /**
       * 「清除」要压过「失焦即保存」。
       *
       * 真实浏览器里点按钮会先让输入框失焦（blur 先于 click），于是"输入了新路径
       * 再点清除"会变成"把新路径保存了"。这里在按钮的 mousedown 上打个标记，
       * 让紧随其后的 blur 让位给显式的清除动作。
       */
      const skipBlur = React.useRef(false)

      // 宿主的视图变了（保存/清除成功后的重取）→ 同步输入框
      React.useEffect(() => {
        setValue(current)
      }, [current])

      const submit = (next) =>
        save.run(async () => {
          const outcome = await apiPost('api/settings/export-dir', { exportDir: next }, (payload) =>
            isString(payload.exportDir),
          )
          if (outcome.ok !== true) return postResult(outcome, '')
          return postResult(outcome, next === '' ? '已清除，导出前需要重新配置' : '已保存')
        }).then((outcome) => {
          if (isObject(outcome) && outcome.ok === true && typeof props.reload === 'function') {
            props.reload()
          }
          return outcome
        })

      const trimmed = value.trim()
      const dirty = trimmed !== current

      return h(
        'div',
        { style: skin.card },
        h(
          'div',
          { style: skin.row },
          h('strong', { style: { fontSize: '13px' } }, '作品库导出路径'),
          h(Pill, null, current === '' ? '未设置' : '已设置'),
        ),
        h(
          'p',
          { style: skin.muted },
          '生成时不再自动复制任何文件：图片只写在插件数据目录，从侧边栏「PixMart → 作品库」查看。' +
            '只有你在作品库点「导出」时，才会把该项目的图片复制到 该路径/<项目 id>/（原件始终保留）。' +
            '留空 = 未配置，导出按钮会提示你先来这里填。',
        ),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
          h(
            Field,
            // 路径可能很长：独占一行，别让「标签 + 值」被 flex 拆散。
            { label: '作品库导出路径（须为绝对路径）', style: { flex: '1 0 100%' } },
            h(TextInput, {
              value,
              disabled: save.busy,
              placeholder: '绝对路径，如 D:/PixMartExport（留空 = 未配置）',
              onChange: (event) => setValue(event.target.value),
              onBlur: () => {
                if (skipBlur.current) {
                  skipBlur.current = false
                  return
                }
                if (trimmed !== current) submit(trimmed)
              },
            }),
          ),
        ),
        h(
          'div',
          { style: skin.row },
          h(
            Btn,
            {
              disabled: save.busy || !dirty,
              onClick: () => submit(trimmed),
              title: '写入 config.json 的 exportDir；只在作品库点「导出」时使用',
            },
            save.busy ? '保存中…' : '保存',
          ),
          // 包一层只为接 mousedown（见 skipBlur 的说明），不改变按钮本身的样子。
          h(
            'span',
            {
              style: { display: 'inline-flex' },
              onMouseDown: () => {
                skipBlur.current = true
              },
            },
            h(
              Btn,
              {
                disabled: save.busy || current === '',
                onClick: () => submit(''),
                title: '清空该设置：回到"未配置"，导出前需要重新填写',
              },
              '清除',
            ),
          ),
          save.busy ? h(Spinner, { label: '保存中' }) : null,
        ),
        h(Msg, { result: save.result }),
      )
    }

    function ProvidersSection(props) {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null })

      /** 卸载后不再 setState（`reload` 会被卡片在 await 之后调用）。 */
      const alive = React.useRef(true)
      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const reload = React.useCallback(
        () =>
          apiGet('api/providers', isProviders).then((result) => {
            if (!alive.current) return
            if (result.ok) setState({ phase: 'ready', data: result.data, error: null })
            else setState({ phase: 'error', data: null, error: result.error })
          }),
        [],
      )

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
            h(
              'div',
              { style: skin.row },
              h(Btn, { onClick: () => reload() }, '重试'),
              h('p', { style: skin.muted }, '宿主路由可能尚未就绪，或插件未加载到当前 profile。'),
            ),
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

      const providers = data.providers.filter(isObject)

      return h(
        'div',
        { style: skin.wrap },
        header,
        h(
          'p',
          { style: skin.muted },
          '在此填写密钥与端点、拉取模型、测试连接，并选定默认生图模型。' +
            '密钥只以「是否就位」的形式回显，任何时候都不会显示内容。',
        ),

        h(DefaultsCard, {
          providers,
          defaults,
          reload,
        }),

        h(
          'div',
          { style: skin.card },
          h(
            'div',
            { style: skin.row },
            h('strong', { style: { fontSize: '13px' } }, '厂商'),
            h(Pill, null, providers.length + ' 个'),
            h(Btn, { onClick: () => reload(), title: '重新读取厂商与模型' }, '刷新'),
          ),
          providers.length === 0
            ? h('p', { style: skin.muted }, '未配置任何厂商。可在插件配置中补充 provider 条目。')
            : providers.map((provider, index) =>
                h(ProviderCard, {
                  key: isString(provider.id) ? provider.id : 'p' + String(index),
                  provider,
                  index,
                  reload,
                }),
              ),
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
          h('div', { style: skin.row }, field('数据目录', String(data.dataDir ?? '—'))),
        ),

        // 放在最后：厂商卡片里已有按钮文案为「保存」，这里再出现一个「保存」
        // 不该改变既有卡片在 DOM 中的先后（设置页的自动化测试按文案取按钮）。
        h(ExportDirCard, { exportDir: data.exportDir, reload }),

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

    // ── 作品库：时间格式 + 生产记录（第 1 批） + 软删/回收站/导出（第 2 批无费用部分） ──

    function pad2(value) {
      const text = String(value)
      return text.length >= 2 ? text : '0' + text
    }

    /**
     * 时间戳 → `YYYY-MM-DD HH:mm`（本地时区）。
     *
     * 特意不用 `toLocaleString`：它随浏览器语言与时区变，既让用户看到的格式不可预期，
     * 也让测试写不出稳定断言。取不到就显示 `—`，**绝不显示 "Invalid Date"**。
     */
    function formatDateTime(ms) {
      if (!isNumber(ms) || ms <= 0) return '—'
      const date = new Date(ms)
      if (!isNumber(date.getTime())) return '—'
      return (
        String(date.getFullYear()) +
        '-' +
        pad2(date.getMonth() + 1) +
        '-' +
        pad2(date.getDate()) +
        ' ' +
        pad2(date.getHours()) +
        ':' +
        pad2(date.getMinutes())
      )
    }

    /** 耗时：<1s 用毫秒，否则一位小数的秒。 */
    function formatDuration(ms) {
      if (!isNumber(ms) || ms < 0) return '—'
      if (ms < 1000) return String(Math.round(ms)) + ' ms'
      return (ms / 1000).toFixed(1) + ' s'
    }

    /**
     * 「复制提示词」。
     *
     * 红线（作品库优化方案 §第 1 批）：复制失败**不能静默**——降级成一段可选中文本，
     * 并把失败原因显示出来。`navigator.clipboard` 在非安全上下文（非 https / 非 localhost）
     * 与老浏览器上根本不存在，这不是异常情况，而是必须处理的正常分支。
     */
    function CopyPromptButton(props) {
      const prompt = isString(props.prompt) ? props.prompt : ''
      const [result, setResult] = React.useState(null)

      if (prompt === '') return null

      const onCopy = () => {
        const clipboard =
          typeof navigator === 'undefined' || navigator === null ? null : navigator.clipboard
        let pending = null
        try {
          pending =
            clipboard !== null && typeof clipboard === 'object' && typeof clipboard.writeText === 'function'
              ? clipboard.writeText(prompt)
              : null
        } catch (err) {
          setResult({ ok: false, error: err && err.message ? err.message : '剪贴板调用失败' })
          return
        }
        if (pending === null || typeof pending.then !== 'function') {
          setResult({ ok: false, error: '当前环境不支持剪贴板 API' })
          return
        }
        pending.then(
          () => setResult({ ok: true, error: null }),
          (err) => setResult({ ok: false, error: err && err.message ? err.message : '复制被拒绝' }),
        )
      }

      const failed = result !== null && result.ok !== true

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h(
          'div',
          { style: skin.row },
          h(
            Btn,
            { className: 'pxm-copy-btn', onClick: onCopy, title: '复制这条提示词，便于复用同参数' },
            result !== null && result.ok === true ? '已复制' : '复制提示词',
          ),
        ),
        failed
          ? h(
              'div',
              { role: 'alert', style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              h(
                'span',
                { style: { fontSize: '12px', lineHeight: 1.6, color: '#ef4444', wordBreak: 'break-word' } },
                '复制失败：' + String(result.error) + '（已展开为可选中文本，请手动复制）',
              ),
              h('textarea', {
                readOnly: true,
                className: 'pxm-copy-fallback',
                'aria-label': '提示词（可手动复制）',
                value: prompt,
                onFocus: (event) => {
                  try {
                    event.target.select()
                  } catch {
                    /* 选择失败不影响文本可选 */
                  }
                },
                style: {
                  width: '100%',
                  minHeight: '64px',
                  font: 'inherit',
                  fontSize: '12px',
                  lineHeight: 1.6,
                  padding: '6px 8px',
                  borderRadius: '6px',
                  color: 'inherit',
                  background: 'color-mix(in srgb, currentColor 6%, transparent)',
                  border: '1px solid color-mix(in srgb, currentColor 24%, transparent)',
                },
              }),
            )
          : null,
      )
    }

    /** 「标签：值」的一行元信息。 */
    function MetaRow(props) {
      return h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '12px' } },
        h('span', { style: { ...skin.key, minWidth: '60px', flex: '0 0 auto' } }, props.label),
        h('span', { style: { wordBreak: 'break-word', opacity: 0.86 } }, props.children),
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
        // 创建时间（第 1 批：卡片上补时间）
        h(
          'span',
          { className: 'pxm-tile-time', style: { fontSize: '12px', opacity: 0.6 } },
          formatDateTime(project.createdAt),
        ),
      )
    }

    /**
     * 项目详情 = **生产记录**。
     *
     * 每个模块都显示：提示词（可复制）· 模型 · 耗时 · 时间 · 降级标记 · 失败原因。
     * 这些都是 `project.json` 里一直有、以前被 HTTP 层丢掉的信息（优化方案 §1.2）。
     *
     * 破坏性动作（删除）一律**二次确认**；导出只复制、不动原件。
     */
    function ProjectDetail(props) {
      const state = props.state
      const project = state.data
      const items = isObject(project) && isArray(project.items) ? project.items : []
      const projectId = isObject(project) && isString(project.id) ? project.id : ''
      const [action, setAction] = React.useState({ busy: null, error: null, note: null })
      const [confirming, setConfirming] = React.useState(false)

      const busy = action.busy
      const exportDir = isString(props.exportDir) ? props.exportDir : ''

      const onExport = () => {
        if (projectId === '' || busy !== null) return
        setAction({ busy: 'export', error: null, note: null })
        // 导出目录由配置决定（宿主侧也会回退到配置里再校验一遍）；
        // 界面**不**猜任何路径，未配置时把宿主给出的可读原因原样显示出来。
        const body = exportDir === '' ? {} : { dir: exportDir }
        apiPost('api/projects/' + encodeURIComponent(projectId) + '/export', body).then((result) => {
          if (result.ok !== true) {
            setAction({
              busy: null,
              error: explainProjectActionError(result.code, result.error),
              note: null,
            })
            return
          }
          const data = isObject(result.data) ? result.data : {}
          const warnings = isArray(data.warnings) ? data.warnings.length : 0
          setAction({
            busy: null,
            error: null,
            note:
              '已导出 ' +
              String(data.count ?? 0) +
              ' 个文件到 ' +
              String(data.dir ?? '') +
              (warnings > 0 ? '（' + String(warnings) + ' 张失败，原件未受影响）' : ''),
          })
        })
      }

      const onDelete = () => {
        if (projectId === '' || busy !== null) return
        setAction({ busy: 'delete', error: null, note: null })
        apiPost('api/projects/' + encodeURIComponent(projectId) + '/delete', { confirm: true }).then(
          (result) => {
            if (result.ok !== true) {
              setAction({ busy: null, error: result.error, note: null })
              return
            }
            setConfirming(false)
            setAction({ busy: null, error: null, note: null })
            if (typeof props.onDeleted === 'function') props.onDeleted(projectId)
          },
        )
      }

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
        state.phase === 'ready'
          ? h(
              'div',
              { style: { ...skin.row, fontSize: '12px', opacity: 0.72 } },
              h('span', null, '创建于 ' + formatDateTime(project?.createdAt)),
              h('span', null, '·'),
              h('span', null, String(project?.provider ?? '—') + ' / ' + String(project?.model ?? '—')),
            )
          : null,
        state.phase === 'ready'
          ? h(
              'div',
              { style: skin.row },
              h(
                Btn,
                {
                  className: 'pxm-export-btn',
                  onClick: onExport,
                  disabled: busy !== null || projectId === '',
                  title:
                    exportDir === ''
                      ? '把项目图片复制到「作品库导出路径」（尚未配置，请先到设置里填）'
                      : '把项目图片复制到 ' + exportDir + '/<项目 id>/，原件不动',
                },
                busy === 'export' ? '导出中…' : '导出图片',
              ),
              h(
                Btn,
                {
                  className: 'pxm-delete-btn',
                  onClick: () => setConfirming(true),
                  disabled: busy !== null || projectId === '' || confirming,
                  title: '移入回收站，可恢复',
                },
                '删除项目',
              ),
            )
          : null,
        state.phase === 'ready' && confirming
          ? h(
              Notice,
              {
                role: 'alert',
                title: '确认删除这个项目？',
                detail: '会移入回收站（projects/.trash），之后仍可恢复；清空回收站才会真正删除。',
              },
              h(
                'div',
                { style: skin.row },
                h(
                  Btn,
                  {
                    className: 'pxm-confirm-delete',
                    onClick: onDelete,
                    disabled: busy !== null,
                  },
                  busy === 'delete' ? '删除中…' : '确认删除',
                ),
                h(Btn, { onClick: () => setConfirming(false), disabled: busy !== null }, '取消'),
              ),
            )
          : null,
        action.error !== null && action.error !== undefined
          ? h(Notice, { role: 'alert', title: '操作失败', detail: action.error })
          : null,
        action.note !== null && action.note !== undefined
          ? h(Notice, { role: 'status', title: '已完成', detail: action.note })
          : null,
        state.phase === 'loading' ? h(LoadingRow, { text: '正在读取项目…' }) : null,
        state.phase === 'error' ? h(Notice, { role: 'alert', title: '读取失败', detail: state.error }) : null,
        state.phase === 'ready' && items.length === 0
          ? h(Notice, { title: '这个项目还没有产出', detail: '生图完成后图片会出现在这里。' })
          : null,
        state.phase === 'ready'
          ? items.map((item, index) => {
              const prompt = isString(item?.prompt) ? item.prompt : ''
              const degraded = isArray(item?.degraded) ? item.degraded.filter(isString) : []
              const error = isString(item?.error) && item.error !== '' ? item.error : null
              const images = isArray(item?.images) ? item.images.filter(isString) : []
              return h(
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
                  isString(item?.apiMode) && item.apiMode !== ''
                    ? h(Pill, { key: 'api' }, item.apiMode)
                    : null,
                ),
                // 失败原因放在最前面：这是用户最需要知道、以前完全看不到的东西。
                error === null
                  ? null
                  : h(
                      'p',
                      {
                        role: 'alert',
                        className: 'pxm-item-error',
                        style: { margin: 0, fontSize: '12px', lineHeight: 1.6, color: '#ef4444', wordBreak: 'break-word' },
                      },
                      '失败原因：' + error,
                    ),
                degraded.length > 0
                  ? h(
                      'div',
                      { className: 'pxm-item-degraded', style: skin.row },
                      h(Pill, null, '降级'),
                      h(
                        'span',
                        { style: { fontSize: '12px', opacity: 0.86, wordBreak: 'break-word' } },
                        degraded.join(' · '),
                      ),
                    )
                  : null,
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                  h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                    h('span', { style: skin.key }, '提示词'),
                    prompt === ''
                      ? h('p', { style: skin.muted }, '这个模块没有留下提示词。')
                      : h(
                          'p',
                          {
                            className: 'pxm-prompt',
                            style: {
                              margin: 0,
                              fontSize: '12px',
                              lineHeight: 1.7,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              padding: '6px 8px',
                              borderRadius: '6px',
                              background: 'color-mix(in srgb, currentColor 6%, transparent)',
                            },
                          },
                          prompt,
                        ),
                    h(CopyPromptButton, { prompt }),
                  ),
                  h(MetaRow, { label: '模型' }, String(item?.model ?? project?.model ?? '—')),
                  h(MetaRow, { label: '耗时' }, formatDuration(item?.ms)),
                  h(MetaRow, { label: '时间' }, formatDateTime(item?.createdAt)),
                ),
                images.length > 0
                  ? h(
                      'div',
                      {
                        style: {
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                          gap: '8px',
                        },
                      },
                      images.map((imageName, ii) => {
                        const url = fileUrl(projectId, imageName)
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
              )
            })
          : null,
      )
    }

    /**
     * 回收站面板：列出、逐个恢复、整体清空。
     *
     * 「清空回收站」不可恢复，所以和删除一样走**二次确认**；
     * 任何一步失败都只在面板内显示可读原因（不抛异常、不白屏）。
     */
    function TrashPanel(props) {
      const state = props.state
      const [action, setAction] = React.useState({ busy: null, error: null, note: null })
      const [confirming, setConfirming] = React.useState(false)
      const entries =
        state.phase === 'ready' && isObject(state.data) && isArray(state.data.trash)
          ? state.data.trash.filter(isObject)
          : []
      const busy = action.busy

      const onRestore = (id) => {
        if (busy !== null) return
        setAction({ busy: id, error: null, note: null })
        apiPost('api/trash/' + encodeURIComponent(id) + '/restore', {}).then((result) => {
          if (result.ok !== true) {
            setAction({ busy: null, error: result.error, note: null })
            return
          }
          setAction({ busy: null, error: null, note: '已恢复 ' + id })
          if (typeof props.onChanged === 'function') props.onChanged()
        })
      }

      const onPurge = () => {
        if (busy !== null) return
        setAction({ busy: 'purge', error: null, note: null })
        apiPost('api/trash/purge', { confirm: true }).then((result) => {
          if (result.ok !== true) {
            setAction({ busy: null, error: result.error, note: null })
            return
          }
          const data = isObject(result.data) ? result.data : {}
          setConfirming(false)
          setAction({ busy: null, error: null, note: '已清空 ' + String(data.purged ?? 0) + ' 个项目' })
          if (typeof props.onChanged === 'function') props.onChanged()
        })
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(
          'div',
          { style: skin.row },
          h(Btn, { onClick: props.onBack }, '← 作品库'),
          h('h2', { style: skin.title }, '回收站'),
          state.phase === 'ready' ? h(Pill, null, entries.length + ' 个项目') : null,
        ),
        h('p', { style: skin.muted }, '删除的项目先移到这里，可随时恢复；清空之后才真正从磁盘删除。'),
        state.phase === 'loading' ? h(LoadingRow, { text: '正在读取回收站…' }) : null,
        state.phase === 'error'
          ? h(
              Notice,
              { role: 'alert', title: '读取回收站失败', detail: state.error },
              h(Btn, { onClick: props.onReload }, '重试'),
            )
          : null,
        state.phase === 'ready' && entries.length === 0
          ? h(Notice, { title: '回收站是空的', detail: '在项目详情里删除的项目会出现在这里。' })
          : null,
        state.phase === 'ready' && entries.length > 0
          ? h(
              'div',
              { style: skin.row },
              confirming
                ? h(
                    'span',
                    { style: skin.row },
                    h('span', { style: { fontSize: '12px', color: '#ef4444' } }, '清空后不可恢复，确认？'),
                    h(
                      Btn,
                      {
                        className: 'pxm-confirm-purge',
                        onClick: onPurge,
                        disabled: busy !== null,
                      },
                      busy === 'purge' ? '清空中…' : '确认清空',
                    ),
                    h(Btn, { onClick: () => setConfirming(false), disabled: busy !== null }, '取消'),
                  )
                : h(
                    Btn,
                    {
                      className: 'pxm-purge-btn',
                      onClick: () => setConfirming(true),
                      disabled: busy !== null,
                    },
                    '清空回收站',
                  ),
            )
          : null,
        action.error !== null && action.error !== undefined
          ? h(Notice, { role: 'alert', title: '操作失败', detail: action.error })
          : null,
        action.note !== null && action.note !== undefined
          ? h(Notice, { role: 'status', title: '已完成', detail: action.note })
          : null,
        state.phase === 'ready'
          ? entries.map((entry, index) =>
              h(
                'div',
                {
                  key: String(entry?.id ?? index),
                  className: 'pxm-trash-item',
                  style: { ...skin.card, gap: '6px' },
                },
                h(
                  'div',
                  { style: { ...skin.row, justifyContent: 'space-between' } },
                  h(
                    'strong',
                    { style: { fontSize: '13px' } },
                    String(entry?.name ?? entry?.id ?? '未命名项目'),
                  ),
                  h(
                    Btn,
                    {
                      className: 'pxm-restore-btn',
                      onClick: () => onRestore(String(entry?.id ?? '')),
                      disabled: busy !== null || !isString(entry?.id),
                    },
                    busy === entry?.id ? '恢复中…' : '恢复',
                  ),
                ),
                h(
                  'span',
                  { style: { fontSize: '12px', opacity: 0.72 } },
                  String(entry?.imageCount ?? 0) +
                    ' 张 · ' +
                    String(entry?.provider ?? '—') +
                    ' · 删除于 ' +
                    formatDateTime(entry?.deletedAt),
                ),
              ),
            )
          : null,
      )
    }

    function WorkbenchPanel() {
      const selected = useStore(selectedProject)
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null })
      const [detail, setDetail] = React.useState({ phase: 'idle', data: null, error: null })
      const [trash, setTrash] = React.useState({ phase: 'idle', data: null, error: null })
      const [showTrash, setShowTrash] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      /** 配置里的作品库导出路径；空串 = 未配置（导出时宿主会回 400 并给出指引）。 */
      const [exportDir, setExportDir] = React.useState('')

      const loadList = React.useCallback(
        () =>
          apiGet('api/projects?limit=' + String(PROJECT_LIST_LIMIT), isProjectList).then((result) => {
            if (result.ok) setState({ phase: 'ready', data: result.data, error: null })
            else setState({ phase: 'error', data: null, error: result.error })
          }),
        [],
      )

      const loadTrash = React.useCallback(
        () =>
          apiGet('api/trash', isTrashList).then((result) => {
            if (result.ok) setTrash({ phase: 'ready', data: result.data, error: null })
            else setTrash({ phase: 'error', data: null, error: result.error })
          }),
        [],
      )

      React.useEffect(() => {
        loadList()
      }, [loadList])

      /**
       * 详情里要显示"导出会落到哪"，因此顺手把配置里的「作品库导出路径」取回来。
       *
       * 取不到不是错误：导出请求照样会发出去，由宿主给出**可读的** 400 提示
       * （`no_export_dir`），界面再把它翻成"先去设置里配"。界面**不猜**任何默认路径。
       */
      React.useEffect(() => {
        let alive = true
        apiGet('api/providers', isProviders).then((result) => {
          if (!alive || !result.ok) return
          setExportDir(isString(result.data.exportDir) ? result.data.exportDir : '')
        })
        return () => {
          alive = false
        }
      }, [])

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
        h('h2', { style: skin.title }, showTrash ? '回收站' : '作品库'),
        h(
          'div',
          { style: skin.row },
          h(
            Btn,
            {
              className: 'pxm-trash-toggle',
              onClick: () => {
                setNotice(null)
                if (showTrash) {
                  setShowTrash(false)
                  loadList()
                } else {
                  selectedProject.set(null)
                  setShowTrash(true)
                  setTrash({ phase: 'loading', data: null, error: null })
                  loadTrash()
                }
              },
            },
            showTrash ? '返回作品库' : '回收站',
          ),
          h(
            Btn,
            {
              onClick: () => {
                setNotice(null)
                if (showTrash) loadTrash()
                else loadList()
              },
            },
            '刷新',
          ),
        ),
      )

      if (showTrash) {
        return h(
          'div',
          { style: skin.wrap },
          header,
          h(TrashPanel, {
            state: trash,
            onBack: () => {
              setShowTrash(false)
              loadList()
            },
            onReload: loadTrash,
            onChanged: () => {
              loadTrash()
              loadList()
            },
          }),
        )
      }

      if (selected !== null) {
        return h(
          'div',
          { style: skin.wrap },
          header,
          h(ProjectDetail, {
            state: detail,
            exportDir,
            onBack: () => selectedProject.set(null),
            onDeleted: (id) => {
              selectedProject.set(null)
              setNotice('已把「' + id + '」移入回收站，可在「回收站」里恢复。')
              loadList()
            },
          }),
        )
      }

      const projects = state.phase === 'ready' ? state.data.projects.filter(isObject) : []

      return h(
        'div',
        { style: skin.wrap },
        header,
        notice === null ? null : h(Notice, { role: 'status', title: '已删除', detail: notice }),
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
                  onOpen: (id) => {
                    setNotice(null)
                    selectedProject.set(id)
                  },
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
      ProviderCard,
      DefaultsCard,
      OutputDirCard: ExportDirCard,
      // 语义变更后仍在 `__test__` 里保留旧键（指向同一个组件），
      // 免得只为改名而动无关的测试。
      ExportDirCard,
      WorkbenchPanel,
      ProjectCard,
      ProjectDetail,
      TrashPanel,
      CopyPromptButton,
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
      explainHostError,
      explainProjectActionError,
      formatDateTime,
      formatDuration,
      HOST_STALE_HINT,
      POLL_ACTIVE_MS,
      POLL_IDLE_MS,
    }

    return { name, inject, apply, __test__ }
  },
})
