/**
 * 浏览器 lane 的**页面侧 harness**（只在测试页里跑，不进产物、不参与打包）。
 *
 * 它做四件事：
 *   1. 在 `client.js` 之前定义 `window.__ModuleLoader__`，把 load 到的 entry 收下来；
 *   2. 用 `factory(require)` 拿到插槽组件（`require('react')` → 页面里的真 React UMD），
 *      再用一个最小假 `ctx` 调 `apply(ctx)` —— **走真实注册路径**，而不是直接读 `__test__`；
 *   3. 把注册到的组件挂进 shell 骨架的槽锚点（`display:contents`，见 shell.html）；
 *   4. 暴露量**真实几何**的探针（rect / scrollTop / scrollWidth / elementFromPoint /
 *      computed overflow），供 Node 侧断言。
 *
 * **这里没有断言**：只把"看得见摸得着"的事实交出去。断言全在 `layout.test.mjs`。
 * 任何"读内联样式字符串"的检查都不该出现在这里——inline style 在 jsdom 里就能查，
 * 那正是本 lane 存在的意义之外的东西。
 */
;(function () {
  'use strict'

  /** 收 `window.__ModuleLoader__.load({id, factory})` 的 entry。 */
  var entries = []
  window.__ModuleLoader__ = {
    load: function (entry) {
      entries.push(entry)
    },
  }

  var fixture = null
  var exported = null
  var registrations = []
  var roots = {}

  // ── 假宿主：路由 → 夹具（零真实网络；图片走静态服务的真 PNG） ─────────────────

  function jsonResponse(body, status) {
    var code = status === undefined ? 200 : status
    return {
      ok: code >= 200 && code < 300,
      status: code,
      json: function () {
        return Promise.resolve(body)
      },
    }
  }

  function projectPage(url) {
    var all = fixture.projects || []
    var limit = Number(url.searchParams.get('limit')) || 24
    var offset = Number(url.searchParams.get('offset')) || 0
    var q = String(url.searchParams.get('q') || '').toLowerCase()
    var sort = String(url.searchParams.get('sort') || 'createdAt:desc')
    var items = all.slice()
    if (q !== '') {
      items = items.filter(function (item) {
        return (
          String(item.name || '').toLowerCase().indexOf(q) >= 0 ||
          String(item.id || '').toLowerCase().indexOf(q) >= 0
        )
      })
    }
    if (sort === 'name:asc') items.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0 })
    else if (sort === 'createdAt:asc') items.sort(function (a, b) { return a.createdAt - b.createdAt })
    else if (sort === 'images:desc') items.sort(function (a, b) { return b.imageCount - a.imageCount })
    else items.sort(function (a, b) { return b.createdAt - a.createdAt })
    var page = items.slice(offset, offset + limit)
    return {
      ok: true,
      count: page.length,
      total: items.length,
      hasMore: offset + page.length < items.length,
      offset: offset,
      limit: limit,
      projects: page,
    }
  }

  function route(url, init) {
    var u = new URL(url, window.location.href)
    var p = u.pathname
    var method = String((init && init.method) || 'GET').toUpperCase()
    if (method !== 'GET') return jsonResponse({ ok: true })
    if (p === '/pixmart/api/projects') return jsonResponse(projectPage(u))
    if (p.indexOf('/pixmart/api/projects/') === 0) return jsonResponse(fixture.detail)
    // 回收站：默认空（既有用例不受影响）；要测"回收站里有项目"时夹具给 `trash` 即可
    // （形状与宿主 `GET /pixmart/api/trash` 一致：`{ ok, count, trash }`）。
    if (p === '/pixmart/api/trash') {
      if (fixture.trash) return jsonResponse(fixture.trash)
      return jsonResponse({ ok: true, count: 0, trash: [] })
    }
    if (p === '/pixmart/api/providers') return jsonResponse(fixture.providers)
    // 运行列表 / 详情：默认都为空（既有用例不受影响）；要测「运行中」的预览卡时，
    // 夹具里给 `runs`（摘要列表）与 `runDetail`（带 items 的详情）即可。
    if (p === '/pixmart/api/runs') {
      return jsonResponse({ ok: true, runs: fixture.runs || [], count: (fixture.runs || []).length })
    }
    if (p.indexOf('/pixmart/api/runs/') === 0) {
      if (!fixture.runDetail) return jsonResponse({ ok: false, error: { code: 'not_found', message: p } }, 404)
      return jsonResponse({ ok: true, run: fixture.runDetail })
    }
    return jsonResponse({ ok: false, error: { code: 'unknown_route', message: p } }, 404)
  }

  // ── 装载与挂载 ──────────────────────────────────────────────────────────────

  function install(next) {
    fixture = next || {}
    var entry = entries[0]
    if (!entry) throw new Error('client.js 没有调用 window.__ModuleLoader__.load（加载顺序错了吗？）')
    // 真 React UMD 通过 require 注入：与 react-dom 是同一个实例。
    exported = entry.factory(function (name) {
      if (name === 'react') return window.React
      if (name === 'react-dom') return window.ReactDOM
      throw new Error('未预期的 require("' + String(name) + '")')
    })
    var ctx = {
      slots: {
        inject: function (slotName, callback) {
          var dispose = callback()
          return typeof dispose === 'function' ? dispose : function () {}
        },
        register: function (params, Component) {
          registrations.push({
            name: params && params.name ? params.name : null,
            key: params && params.key ? params.key : null,
            id: params && params.id ? params.id : null,
            Component: Component,
          })
          return function () {}
        },
      },
      effect: function (callback) {
        var dispose = callback()
        return typeof dispose === 'function' ? dispose : function () {}
      },
      on: function () {
        return function () {}
      },
      get: function (name) {
        return name === 'slots' ? ctx.slots : undefined
      },
    }
    exported.apply(ctx)
    window.fetch = function (input, init) {
      return Promise.resolve(route(String(input), init))
    }
    return {
      id: entry.id,
      name: exported.name,
      inject: exported.inject,
      slots: registrations.map(function (reg) { return reg.name }),
    }
  }

  function anchorFor(slot) {
    if (slot === 'settings.section') {
      document.getElementById('settingsDialog').hidden = false
      return document.getElementById('settingsAnchor')
    }
    return document.getElementById('panelAnchor')
  }

  function mount(slot, props) {
    var reg = registrations.filter(function (item) { return item.name === slot })[0]
    if (!reg) throw new Error('apply() 没有注册插槽 ' + String(slot))
    var host = document.getElementById('host:' + slot)
    if (!host) {
      host = document.createElement('div')
      host.id = 'host:' + slot
      host.className = 'slot-anchor'
      anchorFor(slot).appendChild(host)
    }
    if (roots[slot]) roots[slot].unmount()
    roots[slot] = window.ReactDOM.createRoot(host)
    roots[slot].render(window.React.createElement(reg.Component, props || {}))
    return true
  }

  function unmount(slot) {
    if (roots[slot]) {
      roots[slot].unmount()
      delete roots[slot]
    }
    return true
  }

  // ── 几何探针（只有事实，没有判断） ──────────────────────────────────────────

  function rectOf(element) {
    var r = element.getBoundingClientRect()
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
  }

  function rect(selector) {
    var el = document.querySelector(selector)
    return el === null ? null : rectOf(el)
  }

  function rects(selector) {
    return Array.prototype.map.call(document.querySelectorAll(selector), function (el) {
      return { text: (el.textContent || '').slice(0, 40), rect: rectOf(el) }
    })
  }

  /** 一个盒子：滚动量 + 真实几何 + 计算后的 overflow（不是内联样式字符串）。 */
  function box(selector) {
    var el = document.querySelector(selector)
    if (el === null) return null
    var cs = window.getComputedStyle(el)
    return {
      scrollTop: el.scrollTop,
      scrollLeft: el.scrollLeft,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      offsetWidth: el.offsetWidth,
      rect: rectOf(el),
      computedOverflowY: cs.overflowY,
      computedOverflowX: cs.overflowX,
      inlineOverflowY: el.style.overflowY,
      scrollbarGutter: cs.scrollbarGutter,
    }
  }

  function metrics() {
    var doc = document.documentElement
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }
  }

  /** 一张 <img> 到底解码出来没有（"真图片"而不是坏图）。 */
  /**
   * 找出"自己直接持有这段文字"的元素（跳过整条祖先链），量它的横向是否被裁。
   *
   * 用于超长英文串：不是按类名找，而是按**内容**找——夹具里的长串是唯一的，
   * 因此能精确定位到真正被撑开的那个盒子（提示词 / 模型名 / 项目名）。
   */
  function textOverflow(token) {
    var out = []
    Array.prototype.forEach.call(document.querySelectorAll('body *'), function (el) {
      var own = ''
      Array.prototype.forEach.call(el.childNodes, function (node) {
        if (node.nodeType === 3) own += node.textContent || ''
      })
      if (own.indexOf(token) < 0) return
      out.push({
        tag: el.tagName,
        className: typeof el.className === 'string' ? el.className : '',
        text: own.slice(0, 24),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        rect: rectOf(el),
        clipped: el.scrollWidth > el.clientWidth + 1,
      })
    })
    return out
  }

  /**
   * 元素中心的命中测试：被别的层盖住（例如标题栏带）时命中的不会是它自己。
   *
   * 这是"顶栏被窗口 chrome 盖住"最硬的证据——几何位置只是推测层级，命中测试是事实。
   */
  function hitTest(selector) {
    var el = document.querySelector(selector)
    if (el === null) return null
    var r = el.getBoundingClientRect()
    var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return {
      hitInsideSelf: hit !== null && el.contains(hit),
      hitTag: hit === null ? null : hit.tagName,
      hitClass: hit === null ? null : hit.className,
      hitText: hit === null ? null : (hit.textContent || '').slice(0, 20),
    }
  }

  function imageProbe() {
    return Array.prototype.map.call(document.querySelectorAll('img'), function (img) {
      return { src: String(img.currentSrc || img.src).slice(-40), naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, complete: img.complete }
    })
  }

  // ── 设置页专用：标签 / 值的几何 ─────────────────────────────────────────────

  function findDefaultsCard() {
    var strong = Array.prototype.filter.call(document.querySelectorAll('strong'), function (node) {
      return (node.textContent || '').trim() === '默认值'
    })[0]
    if (!strong) return null
    var node = strong.parentElement
    while (node && node.querySelectorAll('label').length < 3 && node !== document.body) node = node.parentElement
    return node
  }

  /** 「默认值」卡片里每个字段：左列（标签/说明）与右列（控件）各自的矩形。 */
  function defaultsFields() {
    var card = findDefaultsCard()
    if (card === null || card === document.body) return null
    return Array.prototype.map.call(card.querySelectorAll('[data-pxm-field]'), function (field) {
      var label = field.querySelector('[data-pxm-field-label]')
      var desc = field.querySelector('[data-pxm-field-desc]')
      var control = field.querySelector('[data-pxm-field-control]')
      return {
        label: (label && label.textContent ? label.textContent : '').trim(),
        labelRect: label ? rectOf(label) : null,
        descRect: desc ? rectOf(desc) : null,
        hasDesc: desc !== null,
        controlRect: control ? rectOf(control) : null,
        fieldRect: rectOf(field),
        controlTag: control && control.firstElementChild ? control.firstElementChild.tagName : null,
      }
    })
  }

  /**
   * 单个字段（按标签文本找）：左列标签、说明、右列控件的矩形。
   *
   * 与 `defaultsFields` 同一套 DOM 契约（`data-pxm-field*`），但可以按标签点名，
   * 供"某个具体字段是不是行式"这类断言使用。
   */
  function fieldRow(labelText) {
    var fields = Array.prototype.slice.call(document.querySelectorAll('[data-pxm-field]'))
    var field = fields.filter(function (node) {
      var label = node.querySelector('[data-pxm-field-label]')
      return label !== null && (label.textContent || '').indexOf(labelText) >= 0
    })[0]
    if (!field) return null
    var label = field.querySelector('[data-pxm-field-label]')
    var desc = field.querySelector('[data-pxm-field-desc]')
    var control = field.querySelector('[data-pxm-field-control]')
    return {
      fieldRect: rectOf(field),
      labelRect: label ? rectOf(label) : null,
      descRect: desc ? rectOf(desc) : null,
      controlRect: control ? rectOf(control) : null,
      hasDesc: desc !== null,
    }
  }

  /**
   * 自绘下拉（`SelectField`）：触发器 / chevron / 弹层 / 选项 / ✓ 的事实。
   *
   * 只在展开时才返回 `list`；`checks` 是"哪几个选项带 ✓"（带 `data-pxm-icon="check"`）。
   * 仍然只有事实，判断留在用例里。
   */
  function selectFacts(labelText) {
    var fields = Array.prototype.slice.call(document.querySelectorAll('[data-pxm-field]'))
    var field = labelText
      ? fields.filter(function (node) {
          var label = node.querySelector('[data-pxm-field-label]')
          return label !== null && (label.textContent || '').indexOf(labelText) >= 0
        })[0]
      : fields[0]
    if (!field) return null
    var trigger = field.querySelector('[data-pxm-role="select"]')
    if (!trigger) return null
    var list = field.querySelector('[data-pxm-select-list]')
    var options = list
      ? Array.prototype.map.call(list.querySelectorAll('[data-pxm-option]'), function (node) {
          return {
            value: node.getAttribute('data-pxm-option'),
            checked: node.getAttribute('aria-checked'),
            hasCheck: node.querySelector('[data-pxm-icon="check"]') !== null,
            rect: rectOf(node),
          }
        })
      : []
    return {
      triggerRect: rectOf(trigger),
      triggerTag: trigger.tagName,
      expanded: trigger.getAttribute('aria-expanded'),
      hasPopup: trigger.getAttribute('aria-haspopup'),
      text: (trigger.textContent || '').trim(),
      hasChevron: trigger.querySelector('[data-pxm-icon="chevron"]') !== null,
      listRole: list === null ? null : list.getAttribute('role'),
      listRect: list === null ? null : rectOf(list),
      options: options,
      activeTag: document.activeElement === null ? null : document.activeElement.tagName,
      activeOption: document.activeElement === null ? null : document.activeElement.getAttribute('data-pxm-option'),
    }
  }

  /**
   * 数字步进器（`NumberStepper`）：值 / 单位 / 两枚 chevron 按钮的尺寸与禁用态。
   */
  function stepperFacts(labelText) {
    var fields = Array.prototype.slice.call(document.querySelectorAll('[data-pxm-field]'))
    var field = labelText
      ? fields.filter(function (node) {
          var label = node.querySelector('[data-pxm-field-label]')
          return label !== null && (label.textContent || '').indexOf(labelText) >= 0
        })[0]
      : fields[0]
    if (!field) return null
    var stepper = field.querySelector('[data-pxm-role="stepper"]')
    if (!stepper) return null
    var value = stepper.querySelector('[data-pxm-stepper-value]')
    var unit = stepper.querySelector('[data-pxm-stepper-unit]')
    var up = stepper.querySelector('[data-pxm-stepper-up]')
    var down = stepper.querySelector('[data-pxm-stepper-down]')
    return {
      stepperRect: rectOf(stepper),
      value: value === null ? null : (value.textContent || '').trim(),
      valueRect: value === null ? null : rectOf(value),
      unit: unit === null ? null : (unit.textContent || '').trim(),
      upRect: up === null ? null : rectOf(up),
      downRect: down === null ? null : rectOf(down),
      upDisabled: up === null ? null : up.disabled,
      downDisabled: down === null ? null : down.disabled,
      upChevron: up !== null && up.querySelector('[data-pxm-icon="stepper-up"]') !== null,
      downChevron: down !== null && down.querySelector('[data-pxm-icon="stepper-down"]') !== null,
    }
  }

  /**
   * 搜索框（`SearchInput`）：整宽 + 前置图标的事实。
   *
   * 前置图标是搜索框**内部**的 `[data-pxm-icon="search"]`（`position:absolute; left:12px`），
   * 只认搜索框里的那一枚，不认别处可能出现的同名图标。
   */
  function searchFacts(selector) {
    var box = document.querySelector(selector || '.pxm-search-box')
    if (box === null) return null
    var input = box.querySelector('input')
    var icon = box.querySelector('[data-pxm-icon="search"]')
    return {
      boxRect: rectOf(box),
      inputRect: input === null ? null : rectOf(input),
      iconRect: icon === null ? null : rectOf(icon),
      iconPointerEvents: icon === null ? null : window.getComputedStyle(icon).pointerEvents,
      placeholder: input === null ? null : input.getAttribute('placeholder'),
      tag: input === null ? null : input.tagName,
    }
  }

  /**
   * 键盘事件辅助：在某个元素上按下某个键（用例自己决定按下之后看什么）。
   *
   * 与 `page.keyboard.press` 的关键差别：这里补上 `keyCode` / `which`。
   * 真实按键在 Chromium 里带这两个属性，而 `document.dispatchEvent(new KeyboardEvent(...))`
   * 造出来的事件默认是 0；React 对 `keydown` 的按键归一化会读 `keyCode`，
   * 只派发一个"没有 keyCode"的合成事件与真实键盘并不等价。
   * 返回 `defaultPrevented`：用例靠它判断"这个键有没有被页面接管"。
   */
  function pressKey(selector, key, options) {
    var target = document.querySelector(selector)
    if (target === null) return null
    var opts = options || {}
    var KEY_CODES = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27, ' ': 32, Home: 36, End: 35 }
    var event = new KeyboardEvent('keydown', {
      key: key,
      bubbles: true,
      cancelable: true,
      shiftKey: opts.shiftKey === true,
    })
    if (Object.prototype.hasOwnProperty.call(KEY_CODES, key)) {
      try {
        Object.defineProperty(event, 'keyCode', { get: function () { return KEY_CODES[key] } })
        Object.defineProperty(event, 'which', { get: function () { return KEY_CODES[key] } })
      } catch (err) {
        /* 只读属性挡住的浏览器上退化成"只有 key"——用例仍会通过 key 分支工作 */
      }
    }
    target.dispatchEvent(event)
    return event.defaultPrevented
  }

  /**
   * 作品库**单行工具条**（2026-10-10 布局改动）的事实。
   *
   * 只交事实，判断在断言里：这一行的容器矩形、行内剩余空间（有没有折行由
   * `freeSpaceY` 体现）、以及四枚控件的矩形。
   *
   * 控件按**语义锚点**找，不按类名找：`[data-pxm-role="sort"]` / `"select-all"` /
   * `"select-none"` / `"search"` 是控件自己声明的角色（与设置页 `data-pxm-role="select"`
   * 同一做法，见 `settingsSlots` 的注释）。类名是实现细节，换个名字不该让断言失效。
   *
   * `topLabels`：工具条行里**还留着的**字段标签/说明文字。原来那三行是靠
   * `[data-pxm-field-label]` / `[data-pxm-field-desc]` 承载的，删干净之后这里必须是空数组
   * —— 变异成三行或把标签加回来时它会立刻非空。
   */
  function toolbarRow() {
    var row = document.querySelector('[data-pxm-toolbar]')
    if (row === null) return null
    var insideRow = function (role) {
      var el = row.querySelector('[data-pxm-role="' + role + '"]')
      return {
        present: el !== null,
        rect: el === null ? null : rectOf(el),
        text: el === null ? null : (el.textContent || '').trim(),
      }
    }
    // 搜索框的角色标在内层 `<input>` 上（`SearchInput` 的 `data-pxm-role="search"`），
    // 量它的**盒子**（`.pxm-search-box`）才有意义（输入框自己可能是被压缩过的）。
    var searchBox = row.querySelector('.pxm-search-box')
    var searchInput = row.querySelector('[data-pxm-role="search"]')
    return {
      className: typeof row.className === 'string' ? row.className : '',
      rowRect: rectOf(row),
      rowDisplay: window.getComputedStyle(row).display,
      rowFlexWrap: window.getComputedStyle(row).flexWrap,
      scrollWidth: row.scrollWidth,
      clientWidth: row.clientWidth,
      // 行内内容占用的纵向高度 > 单行高度 ⇒ 折行了（断言换行时用）。
      childCount: row.children.length,
      sort: insideRow('sort'),
      selectAll: insideRow('select-all'),
      selectNone: insideRow('select-none'),
      search: {
        present: searchInput !== null,
        rect: searchBox === null ? rectOf(searchInput) : rectOf(searchBox),
        inputRect: searchInput === null ? null : rectOf(searchInput),
        placeholder: searchInput === null ? null : searchInput.getAttribute('placeholder'),
      },
      topLabels: Array.prototype.map.call(
        row.querySelectorAll('[data-pxm-field-label],[data-pxm-field-desc]'),
        function (node) { return (node.textContent || '').trim() },
      ),
    }
  }

  /** 从 `document.body` 里读出"页面上有没有这段文字"（按整页文本找，不按类名）。 */
  function bodyHasText(text) {
    return (document.body.textContent || '').indexOf(text) >= 0
  }

  /** 在某个坐标点派发一次真实的 `pointerdown`（用于"点击外部关闭"）。 */
  function pointerDownAt(x, y) {
    var target = document.elementFromPoint(x, y)
    if (target === null) return null
    target.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    )
    return { tag: target.tagName, className: String(target.className || '') }
  }

  /** 「标签 + 值」成组的那一对（累计用量卡片里的数据目录）。 */
  function groupedPair(labelText) {
    var label = Array.prototype.filter.call(document.querySelectorAll('span'), function (node) {
      return (node.textContent || '').trim() === labelText && node.children.length === 0
    })[0]
    if (!label) return null
    var group = label.parentElement
    var value = group.children[1]
    if (!value) return null
    return {
      labelRect: rectOf(label),
      valueRect: rectOf(value),
      groupRect: rectOf(group),
      groupDisplay: window.getComputedStyle(group).display,
      valueTag: value.tagName,
      valueScrollWidth: value.scrollWidth,
      valueClientWidth: value.clientWidth,
    }
  }

  /** 面板滚动层 + 它的锁状态（查看器打开时会写 inline overflowY）。 */
  function panelScroll() {
    return box('.pxm-scroll')
  }

  function viewer() {
    return {
      root: box('.pxm-viewer'),
      bar: rect('.pxm-viewer-bar'),
      close: rect('.pxm-viewer-close'),
      closeHit: hitTest('.pxm-viewer-close'),
      inner: box('.pxm-viewer-scroll'),
      image: rect('.pxm-viewer-img'),
    }
  }

  // ── 主题 token 探针（给 theme.test.mjs 用；仍然只有事实，没有判断） ────────────

  /**
   * 一个元素的计算样式值。
   *
   * 注意这里量的是 `getComputedStyle`，**不是** `element.style`（内联字符串）：
   * 内联字符串只能证明"我们写了 var(--dsw-…)"，证明不了"浏览器真的把它解析成了主题色"。
   */
  function computed(selector, props) {
    var el = document.querySelector(selector)
    if (el === null) return null
    var cs = window.getComputedStyle(el)
    var out = {}
    ;(props || []).forEach(function (name) {
      out[name] = cs[name]
    })
    return out
  }

  /**
   * 把若干段 CSS 值交给浏览器解析，返回解析后的颜色。
   *
   * 入参是 `[{ key, prop, value }]`，**按目标属性本身**（`color` / `backgroundColor` /
   * `borderTopColor`）解析，而不是一律塞进 `color`。原因：同一个颜色经 `color-mix` 之后，
   * 不同属性上的序列化形式可能不同（实测 `color` 会给 `color(srgb …)`，
   * `backgroundColor` 可能给 `rgba(…)`）；用同一个属性解析，两边才是同一个序列化器出的字符串，
   * 比较才有意义。
   *
   * 这是"token 解析值"的**权威来源**：不是测试自己把 hex 换算成 rgb，而是让浏览器按当前
   * `:root` 上的 token 现场算一遍。
   */
  function resolveCss(items) {
    var out = {}
    ;(items || []).forEach(function (item) {
      var probe = document.createElement('span')
      // 边框色在没有边框时也应按"计算值"返回，但给一根实线边框更贴近真实元素。
      if (item.prop === 'borderTopColor') {
        probe.style.borderTopStyle = 'solid'
        probe.style.borderTopWidth = '1px'
      }
      probe.style[item.prop] = item.value
      document.body.appendChild(probe)
      out[item.key] = window.getComputedStyle(probe)[item.prop]
      probe.remove()
    })
    return out
  }

  /** `:root` 上 token 的**声明值**（字符串，用于确认"输入真的换了"）。 */
  function tokenVar(names) {
    var cs = window.getComputedStyle(document.documentElement)
    var out = {}
    ;(names || []).forEach(function (name) {
      out[name] = cs.getPropertyValue(name).trim()
    })
    return out
  }

  /**
   * **官方表面色**：把一组 `var(--dsw-…)` 当作 `color` 交给浏览器解析。
   *
   * 为什么走 `color` 而不是 `backgroundColor`：目标表面可能是"没有自己的背景"
   * （官方设置页 section 就是这样的——它继承弹窗面板那一层）。那时
   * `backgroundColor` 会是 `rgba(0,0,0,0)`，和任何 token 的解析值都不相等，
   * 断言就变成"永远红"或者要靠特例绕开。`color` 是**继承属性**，量出来的是
   * "这个 token 到底解析成什么颜色"，正好是"官方同语义表面用的是什么色"的答案。
   * （`color-mix()` 会让 `backgroundColor` 变成 `color(srgb …)` 序列化形式，
   * 用 `color` 也就顺带把两边的序列化器统一了。）
   */
  function officialSurfaces(items) {
    var out = {}
    ;(items || []).forEach(function (item) {
      var probe = document.createElement('span')
      probe.style.color = item.value
      document.body.appendChild(probe)
      out[item.key] = window.getComputedStyle(probe).color
      probe.remove()
    })
    return out
  }

  /** 换一组 token（深色用例）：写在 `:root` 的行内样式上，优先于样式表里的 `:root`。 */
  function setTokens(values) {
    var root = document.documentElement
    Object.keys(values || {}).forEach(function (name) {
      root.style.setProperty(name, values[name])
    })
    return tokenVar(Object.keys(values || {}))
  }

  // ── 设置页：官方同语义控件的选择器（尺寸对齐用例用；仍然只有事实） ──────────

  /**
   * 把设置面板里的官方同语义控件找出来。
   *
   * 按**语义角色**找，不按类名找：类名是本插件自己的实现细节，换个类名不该让断言失效；
   * 而"表单里的文本框 / 密码框 / 下拉 / 按钮 / 胶囊标签"是官方也有的角色。
   *
   * 返回 `{ role, selector }` 列表（不返回元素本身 —— 探针只交事实）。
   * 注意 `selector` 是**真实 CSS 选择器**，供 `computed()` 使用；`:nth-of-type` 之类
   * 在这里够用，因为官方规则本来也只区分"第几个控件"这种位置。
   */
  function settingsSlots() {
    var root = document.querySelector('.pxm-settings')
    if (root === null) return null
    var out = []
    var push = function (role, el) {
      if (el === null || el === undefined) return
      el.setAttribute('data-pxm-role', role)
      out.push({ role: role })
    }
    // 设置页的 `<h2>` 就是本插件注册到 settings.section 的那块面板的标题。
    push('pageTitle', root.querySelector('h2'))
    push('textInput', root.querySelector('input[type="text"]'))
    push('passwordInput', root.querySelector('input[type="password"]'))
    /*
     * 下拉：2026-10-09 控件形态复刻后设置页是**自绘**触发器（`<button>` + 弹层），
     * 不再是原生 `<select>`（官方 client 侧本来也没有）。仍然按**语义角色**找：
     * `data-pxm-role="select"` 是触发器自己声明的角色，不是样式类名。
     */
    push('select', root.querySelector('[data-pxm-role="select"]'))
    // 行内动作按钮：**必须**避开上面那枚自绘下拉触发器与步进器的两枚 chevron
    // （它们也是 `<button>`，形状完全不同）。`.pxm-btn` 是本插件按钮自己的类。
    push('button', root.querySelector('button.pxm-btn'))
    // 胶囊标签：**必须在 `.pxm-settings` 里面找**。`.pxm-pill` 在页面里可能有多处
    // （例如折叠态的实时预览徽标里就嵌了一枚），文档级查询会绑到那一枚上。
    push('tag', root.querySelector('.pxm-pill'))
    return out
  }

  /** 作品库面板的工具条 / 卡片 / 查看器里的官方同语义控件。 */
  function workbenchSlots() {
    var root = document.querySelector('.pxm-workbench')
    if (root === null) return null
    var out = []
    var push = function (role, el) {
      if (el === null || el === undefined) return
      el.setAttribute('data-pxm-role', role)
      out.push({ role: role })
    }
    push('toolbarButton', root.querySelector('.pxm-trash-toggle'))
    push('searchInput', root.querySelector('.pxm-search'))
    push('sortSelect', root.querySelector('.pxm-sort'))
    push('card', root.querySelector('.pxm-trash-item'))
    return out
  }

  /**
   * 查看器（`position: fixed` 的模态层）里的官方同语义控件。
   *
   * 它只在作品库**点开一张图之后**才存在，所以与 `workbenchSlots` 分开：
   * 尺寸用例要在同一次会话里先点开缩略图，再调这个探针。
   */
  function viewerSlots() {
    var root = document.querySelector('.pxm-viewer')
    if (root === null) return null
    var out = []
    var push = function (role, el) {
      if (el === null || el === undefined) return
      el.setAttribute('data-pxm-role', role)
      out.push({ role: role })
    }
    push('viewerButton', root.querySelector('.pxm-viewer-close'))
    // 信息卡 = 滚动区里最后一个直接子节点（尺寸 / 模型 / 模块 / 提示词那一块）。
    push('viewerCard', root.querySelector('.pxm-viewer-scroll > div:last-child'))
    return out
  }

  /**
   * 实时预览那枚**徽标**（`.pxm-badge`）。
   *
   * 它也是"官方 Pill 的同语义物"（可点的胶囊），但在折叠态才存在，
   * 所以单独一个探针，好让尺寸用例能把它和设置页里的 `.pxm-pill` 分开量。
   */
  function overlaySlots() {
    var el = document.querySelector('.pxm-badge')
    if (el === null) return null
    el.setAttribute('data-pxm-role', 'badge')
    return [{ role: 'badge' }]
  }

  /**
   * 一个元素的**盒模型事实**（尺寸对齐用例用）：几何 + 计算样式 + **内联声明值**。
   *
   * 和 `computed()` 一样，量的都是 `getComputedStyle`；这里额外给出：
   *   - 真实几何（`getBoundingClientRect().height`），好让"计算高度 28px 是不是真的画成了
   *     28px"这件事也有事实可查——`height` 被内容压过时，两者会不一致；
   *   - `declared`：这个元素**内联声明**的样式值（`element.style`）。为什么需要它：
   *     浏览器会把**亚像素**值量化掉——实测 Chromium DPR=1 下 `border:.5px` 的计算值
   *     就是 `1px`（`getComputedStyle(el).borderTopWidth === '1px'`），于是"我们声明的是官方
   *     那根 0.5px 发丝线"这件事在计算样式里**根本区分不出来**（0.5px 与 1px 同值）。
   *     这种"平台会量化"的属性只能断言声明值；判断（这个值对不对）仍然在 test 侧。
   */
  function boxMetrics(selector) {
    var el = document.querySelector(selector)
    if (el === null) return null
    var cs = window.getComputedStyle(el)
    var DECLARED = [
      'height',
      'padding',
      'fontSize',
      'lineHeight',
      'fontWeight',
      'borderRadius',
      'border',
      'borderTopWidth',
      'boxSizing',
      'display',
    ]
    var declared = {}
    DECLARED.forEach(function (name) {
      var value = el.style[name]
      if (value !== undefined && value !== '') declared[name] = value
    })
    /*
     * 描边的**显式声明**单独取一次：`el.style.borderTopWidth` 在"从未写过任何边框"时
     * Chromium 会回 `medium`（UA 初始值），与"显式声明成 medium"在 `declared` 里
     * 长得一样，分不出"没描边"与"描边宽度是 medium"。这里按 CSS 声明的原始事实取：
     * `border` 简写为空 且 `borderTopWidth` 为空或 `medium` ⇒ 这一处没有声明描边。
     */
    var declaredBorder = {
      shorthand: el.style.getPropertyValue('border'),
      topWidth: el.style.getPropertyValue('border-top-width'),
    }
    return {
      tag: el.tagName,
      className: typeof el.className === 'string' ? el.className : '',
      text: (el.textContent || '').slice(0, 30),
      display: cs.display,
      boxSizing: cs.boxSizing,
      height: cs.height,
      paddingTop: cs.paddingTop,
      paddingRight: cs.paddingRight,
      paddingBottom: cs.paddingBottom,
      paddingLeft: cs.paddingLeft,
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      fontWeight: cs.fontWeight,
      borderRadius: cs.borderRadius,
      borderTopWidth: cs.borderTopWidth,
      declared: declared,
      declaredBorder: declaredBorder,
      rect: rectOf(el),
    }
  }

  /**
   * 把若干段 CSS 值交给浏览器解析，返回解析后的**非颜色**属性值。
   *
   * `resolveCss` 是为颜色写的（它比较的是"同一个序列化器"，颜色在不同属性上会给出不同形式）；
   * 尺寸这边需要的是"`var(--dsw-radius-md)` 到底解析成多少像素"，所以用 `width` 这个
   * 接受长度值、且序列化稳定的属性来锚：把待解析值喂给一个 `span` 的 `width`，
   * 再读它的计算 `width`（`auto` 会露馅 → 断言就该红，而不是静默相等）。
   */
  function resolveSize(items) {
    var out = {}
    ;(items || []).forEach(function (item) {
      var probe = document.createElement('span')
      probe.style.position = 'absolute'
      probe.style.visibility = 'hidden'
      probe.style.setProperty(item.prop, item.value)
      document.body.appendChild(probe)
      out[item.key] = window.getComputedStyle(probe)[item.prop]
      probe.remove()
    })
    return out
  }

  window.__pxmLane = {
    version: 1,
    install: install,
    mount: mount,
    unmount: unmount,
    slots: function () {
      return registrations.map(function (reg) {
        return { name: reg.name, key: reg.key, id: reg.id }
      })
    },
    rect: rect,
    rects: rects,
    box: box,
    metrics: metrics,
    textOverflow: textOverflow,
    hitTest: hitTest,
    imageProbe: imageProbe,
    defaultsFields: defaultsFields,
    groupedPair: groupedPair,
    // 控件形态（2026-10-09 复刻）：行式字段 / 自绘下拉 / 数字步进器 / 搜索框 / 键盘
    fieldRow: fieldRow,
    selectFacts: selectFacts,
    stepperFacts: stepperFacts,
    searchFacts: searchFacts,
    toolbarRow: toolbarRow,
    bodyHasText: bodyHasText,
    pressKey: pressKey,
    pointerDownAt: pointerDownAt,
    panelScroll: panelScroll,
    viewer: viewer,
    // 主题 token：计算样式 / token 解析值 / 声明值 / 换一组 token / 官方表面色
    computed: computed,
    resolveCss: resolveCss,
    tokenVar: tokenVar,
    setTokens: setTokens,
    officialSurfaces: officialSurfaces,
    // 尺寸对齐：官方同语义控件的选择器 / 盒模型事实 / 非颜色值解析
    settingsSlots: settingsSlots,
    workbenchSlots: workbenchSlots,
    viewerSlots: viewerSlots,
    overlaySlots: overlaySlots,
    boxMetrics: boxMetrics,
    resolveSize: resolveSize,
    titlebarTop: function () {
      var el = document.getElementById('dsh-titlebar')
      return el === null ? null : rectOf(el)
    },
    chromeTopVar: function () {
      return window.getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-chrome-top').trim()
    },
    /** 元素中心在**视口坐标**里的位置：给 page.mouse.move 用。 */
    point: function (selector) {
      var el = document.querySelector(selector)
      if (el === null) return null
      var r = el.getBoundingClientRect()
      return {
        x: Math.min(Math.max(r.left + r.width / 2, 4), window.innerWidth - 4),
        y: Math.min(Math.max(r.top + r.height / 2, 4), window.innerHeight - 4),
      }
    },
  }
})()
