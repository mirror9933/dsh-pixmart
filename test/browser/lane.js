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
    if (p === '/pixmart/api/trash') return jsonResponse({ ok: true, count: 0, trash: [] })
    if (p === '/pixmart/api/providers') return jsonResponse(fixture.providers)
    if (p === '/pixmart/api/runs') return jsonResponse({ ok: true, runs: [], count: 0 })
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

  /** 「默认值」卡片里每个字段：标签与它的控件各自的矩形。 */
  function defaultsFields() {
    var card = findDefaultsCard()
    if (card === null || card === document.body) return null
    return Array.prototype.map.call(card.querySelectorAll('label'), function (label) {
      var labelSpan = label.children[0]
      var control = label.children[1]
      return {
        label: (labelSpan && labelSpan.textContent ? labelSpan.textContent : '').trim(),
        labelRect: labelSpan ? rectOf(labelSpan) : null,
        controlRect: control ? rectOf(control) : null,
        fieldRect: rectOf(label),
        controlTag: control ? control.tagName : null,
      }
    })
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

  /** 换一组 token（深色用例）：写在 `:root` 的行内样式上，优先于样式表里的 `:root`。 */
  function setTokens(values) {
    var root = document.documentElement
    Object.keys(values || {}).forEach(function (name) {
      root.style.setProperty(name, values[name])
    })
    return tokenVar(Object.keys(values || {}))
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
    panelScroll: panelScroll,
    viewer: viewer,
    // 主题 token：计算样式 / token 解析值 / 声明值 / 换一组 token
    computed: computed,
    resolveCss: resolveCss,
    tokenVar: tokenVar,
    setTokens: setTokens,
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
