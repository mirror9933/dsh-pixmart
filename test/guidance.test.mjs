/**
 * 系统提示贡献的测试。
 *
 * 这段文本是插件「被模型发现」的唯一途径：没有它，模型只能靠工具描述自己推断
 * 什么时候该用 pixmart_*，而且**计费约束全靠自觉**。所以它值得被钉住——
 * 但只钉"有没有注册、放在哪、讲了哪几条硬规则"，不钉具体措辞（措辞会演化）。
 *
 * 另外这里也钉住**注册路径**：必须经 `ctx.inject(['systemPrompt'], …)`。
 * 早先路由那次 404 的成因就是在 `apply()` 里 `ctx.get()` 探测可选服务，
 * 拿到 undefined 后静默跳过注册。同一个坑不能踩第二遍。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { GUIDANCE_ORDER, GUIDANCE_SECTION, GUIDANCE_TEXT, installGuidance } from '../lib/guidance.js'
import { apply } from '../lib/index.js'

function fakeHost(services, { onInject } = {}) {
  return {
    tools: { register: () => () => {}, schemas: () => [] },
    effect: (cb) => {
      cb()
    },
    on: () => () => {},
    get: (name) => services[name],
    inject: (names, callback) => {
      const child = fakeHost(
        Object.fromEntries(names.map((name) => [name, services[name]])),
        { onInject },
      )
      onInject?.(names, child)
      callback(child)
    },
  }
}

describe('installGuidance', () => {
  it('注册区段：名字稳定、order 落在工具说明带', () => {
    const sections = []
    const host = fakeHost({ systemPrompt: { section: (s) => (sections.push(s), () => {}) } })

    assert.equal(installGuidance(host), true)
    assert.equal(sections.length, 1)

    const section = sections[0]
    assert.equal(section.name, GUIDANCE_SECTION)
    assert.equal(section.name, 'dsh-pixmart')
    // 官方布局：1000–3000 是各工具说明，3100 起是 MCP。我们应落在两者之间。
    assert.ok(
      section.order > 3000 && section.order < 3100,
      `order ${section.order} 应落在工具说明带末尾（3000–3100）`,
    )
    assert.equal(section.order, GUIDANCE_ORDER)
  })

  it('服务缺失时返回 false 而不是抛异常', () => {
    assert.equal(installGuidance(fakeHost({})), false)
    assert.equal(installGuidance(fakeHost({ systemPrompt: {} })), false)
  })

  it('文本覆盖四条硬规则（发现、计费顺序、模块、无密钥指引）', () => {
    // 1) 让模型知道何时用它
    assert.match(GUIDANCE_TEXT, /电商商品图/)
    // 2) 计费：哪两个免费、哪些计费
    assert.match(GUIDANCE_TEXT, /pixmart_prompt/)
    assert.match(GUIDANCE_TEXT, /不产生任何费用/)
    assert.match(GUIDANCE_TEXT, /计费/)
    // 3) 模块体系与获取全量的方式
    assert.match(GUIDANCE_TEXT, /24 个/)
    assert.match(GUIDANCE_TEXT, /listModules/)
    // 4) 没有密钥时不要反复重试
    assert.match(GUIDANCE_TEXT, /不要反复重试/)
    assert.match(GUIDANCE_TEXT, /设置 → PixMart/)
    // 参考图场景必须走 edit，而不是文生图
    assert.match(GUIDANCE_TEXT, /pixmart_edit/)
    // 5) 模块选择映射：实战中曾误用 main.white-bg 做"基于参考图的白底图"，故点名正确模块
    assert.match(GUIDANCE_TEXT, /tool\.white-bg/)
    assert.match(GUIDANCE_TEXT, /tool\.style-replica/)
    assert.match(GUIDANCE_TEXT, /detail\.hero/)
    // 6) 耗时预期：单张实测达分钟级，避免被误判为卡死而重复调用（重复计费）
    assert.match(GUIDANCE_TEXT, /1–3 分钟/)
    assert.match(GUIDANCE_TEXT, /不要重复调用/)
    // 7) 产物保存路径：配了就直接 present 那个路径，别再手动往工作区里拷
    assert.match(GUIDANCE_TEXT, /产物保存路径/)
    assert.match(GUIDANCE_TEXT, /另行复制/)
    assert.match(GUIDANCE_TEXT, /不要用 `pwsh`/)
  })

  it('文本保持精简（系统提示预算要留给高信号内容）', () => {
    const lines = GUIDANCE_TEXT.split('\n').length
    assert.ok(lines <= 36, `说明不应超过 36 行，实际 ${lines} 行`)
  })
})

describe('apply() 的注册路径', () => {
  it('经 ctx.inject 惰性注册 guidance 与 webServer（绝不在 apply 里直接 get）', () => {
    const injected = []
    const sections = []
    const routes = []

    const host = fakeHost(
      {
        systemPrompt: { section: (s) => (sections.push(s), () => {}) },
        webServer: { register: (route) => (routes.push(route), () => {}) },
      },
      { onInject: (names) => injected.push(...names) },
    )

    apply(host, {})

    assert.ok(injected.includes('systemPrompt'), 'guidance 必须走 inject')
    assert.ok(injected.includes('webServer'), '路由必须走 inject')
    assert.equal(sections.length, 1, 'guidance 应已注册')
    assert.equal(routes.length, 2, 'api 与 file 两条路由都应注册')
  })
})
