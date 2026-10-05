/**
 * 作品库优化方案**批次 A** 的宿主侧契约测试（真实路由 + 真实 ProjectStore）。
 *
 * 覆盖两件事：
 *   ① 第 1 批「把已丢弃的信息显示出来」：详情响应新增 6 个字段，**原有字段一个都不能少**；
 *   ② 第 2 批的无费用部分：软删 + 回收站（列表 / 恢复 / 清空）+ 导出项目。
 *
 * 为什么走真实路由而不是直接调 store：本批次新增的全部是 **HTTP 契约**，
 * 而"GET 打写路由必须 405""缺 confirm 必须 400""非环回必须 403"这些红线
 * 只在路由层成立。写法沿用 `historical.test.mjs` 的假 webServer + 假 req/res。
 *
 * **零真实网络、零厂商调用**：本文件不碰 fetch。
 */
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerRoutes } from '../lib/routes.js'
import { ProjectStore, moveDir } from '../lib/store/project-store.js'
import { RunStore } from '../lib/store/run-store.js'
import { UsageLog } from '../lib/log/usage.js'
import { createRuntime } from '../lib/tools/runtime.js'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')

const CREATED_AT = Date.UTC(2026, 9, 5, 12, 0, 0)
/** 详情里出现的提示词：断言时按子串查，避免和渲染格式耦合。 */
const PROMPT = '纯白背景，柔和阴影，陶瓷马克杯'
const FAIL_REASON = '厂商拒绝：HTTP 400 invalid size'

// ── 假宿主面 ────────────────────────────────────────────────────────────────

/** 捕获 handler 的假 webServer。 */
function makeFakeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
}

/**
 * 只提供路由需要的那几个面的假运行时；projectStore 是**真的**。
 *
 * `exportDir` 默认给空串（未配置）——导出路由因此必须回 400 `no_export_dir`。
 * 需要导出成功的用例用 `makeFakeRuntime(dir, { exportDir })` 显式配一个绝对路径。
 */
function makeFakeRuntime(dataDir, options = {}) {
  return {
    ctx: undefined,
    dataDir,
    dataDirNotes: [],
    configStore: {},
    projectStore: new ProjectStore(dataDir),
    runStore: new RunStore(dataDir),
    usage: new UsageLog(dataDir),
    config: async () => ({
      exportDir: options.exportDir ?? '',
      providers: [
        {
          id: 'ofox',
          label: 'Ofox',
          group: 'aggregator',
          baseUrl: 'https://api.example.test/v1',
          geminiNativeBaseUrl: '',
          dialect: 'standard',
          apiMode: 'images-generations',
          apiKeyEnv: '',
          apiKey: 'sk-must-never-leak',
          models: [],
          allowedSizes: ['1:1'],
          sizeMode: 'whitelist',
          timeoutMs: 1000,
          extraHeaders: {},
        },
      ],
      defaults: {},
      limits: {},
    }),
    configWarnings: () => [],
  }
}

/**
 * 假请求：`readJsonBody` 要的是 `on('data'|'end'|'error')`，
 * 所以这里用真 EventEmitter，并在**下一个微任务**里发数据——
 * 那时 handler 已经在同一个同步块里挂好了监听（`await readBody()` 之前没有 await）。
 */
function makeRequest({ method, url, remoteAddress = '127.0.0.1', body }) {
  const request = new EventEmitter()
  request.method = method
  request.url = url
  request.socket = { remoteAddress }
  queueMicrotask(() => {
    if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    request.emit('end')
  })
  return request
}

function makeResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.status = code
      this.headers = headers ?? null
    },
    end(data) {
      if (typeof data === 'string') this.body = data
      else if (data !== undefined) this.body = Buffer.from(data).toString('utf8')
    },
  }
}

/** 走一次真实路由。 */
async function call(webServer, runtime, path, options = {}) {
  registerRoutes({ get: (name) => (name === 'webServer' ? webServer : undefined) }, runtime)
  const route = webServer.routes.find((entry) => path.startsWith(entry.path))
  assert.ok(route, `没有匹配 ${path} 的路由`)

  const response = makeResponse()
  await route.handler(
    makeRequest({
      method: options.method ?? 'GET',
      url: path,
      body: options.body,
      ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
    }),
    response,
  )
  let json = null
  if (response.body !== '') {
    try {
      json = JSON.parse(response.body)
    } catch {
      json = null
    }
  }
  return { status: response.status, json, text: response.body, response }
}

// ── 夹具 ────────────────────────────────────────────────────────────────────

let dataDir
let runtime
let webServer

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pixmart-workbench-'))
  runtime = makeFakeRuntime(dataDir)
  webServer = makeFakeWebServer()
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

/** 造一个带 1 张图 + 1 条失败项的项目（用真实 store API，形状与生图路径一致）。 */
async function seedProject(store = runtime.projectStore) {
  const record = await store.create('工作台', 'ofox', 'gpt-image-1', CREATED_AT)
  const saved = await store.saveImage(record.id, new Uint8Array(PNG), 'image/png', 'white-bg')
  const { absolutePath, ...image } = saved

  await store.appendItem(record.id, {
    module: 'main.white-bg',
    label: '白底主图',
    prompt: PROMPT,
    size: '1:1',
    provider: 'ofox',
    model: 'gpt-image-1',
    apiMode: 'images-generations',
    status: 'ok',
    images: [image],
    degraded: ['openai-compat → gemini-native 回退'],
    ms: 12345,
    createdAt: Date.UTC(2026, 9, 5, 12, 1, 0),
  })
  await store.appendItem(record.id, {
    module: 'detail.hero',
    label: '详情首屏',
    prompt: '详情首屏，暖光',
    size: '3:4',
    provider: 'ofox',
    model: 'gpt-image-1',
    apiMode: 'images-edits',
    status: 'failed',
    images: [],
    error: FAIL_REASON,
    ms: 812,
    createdAt: Date.UTC(2026, 9, 5, 12, 2, 0),
  })

  return { id: record.id, absolutePath, fileName: image.file.split('/').pop() }
}

const trashDirOf = (id) => join(dataDir, 'projects', '.trash', id)
const projectDirOf = (id) => join(dataDir, 'projects', id)

// ── ① 详情：已丢弃的信息 ─────────────────────────────────────────────────────

describe('GET /pixmart/api/projects/<id> —— 新增字段齐全且不动老字段', () => {
  it('每项都带 prompt/model/ms/createdAt/degraded，失败项带 error', async () => {
    const { id } = await seedProject()

    const { status, json, text } = await call(webServer, runtime, `/pixmart/api/projects/${id}`)
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.equal(json.project.id, id)
    assert.equal(json.project.name, '工作台')
    assert.equal(json.project.createdAt, CREATED_AT)
    assert.equal(json.project.provider, 'ofox')
    assert.equal(json.project.model, 'gpt-image-1')
    assert.equal(json.project.items.length, 2)

    const okItem = json.project.items[0]
    // 老字段一个都不能少（不改名、不删除）
    assert.equal(okItem.module, 'main.white-bg')
    assert.equal(okItem.label, '白底主图')
    assert.equal(okItem.status, 'ok')
    assert.equal(okItem.size, '1:1')
    assert.equal(okItem.apiMode, 'images-generations')
    assert.equal(okItem.images.length, 1)
    assert.equal(okItem.width, 1)
    assert.equal(okItem.height, 1)
    // 新增字段
    assert.equal(okItem.prompt, PROMPT)
    assert.equal(okItem.model, 'gpt-image-1')
    assert.equal(okItem.ms, 12345)
    assert.equal(okItem.createdAt, Date.UTC(2026, 9, 5, 12, 1, 0))
    assert.deepEqual(okItem.degraded, ['openai-compat → gemini-native 回退'])
    assert.equal('error' in okItem, false, '成功项不该带 error')

    const failedItem = json.project.items[1]
    assert.equal(failedItem.status, 'failed')
    assert.equal(failedItem.error, FAIL_REASON, '失败原因必须透出，否则用户看不出为什么失败')
    assert.deepEqual(failedItem.degraded, [], 'degraded 恒定是数组，客户端不必再判空')
    assert.equal(failedItem.prompt, '详情首屏，暖光')

    assert.equal(text.includes('sk-must-never-leak'), false, '响应体不得包含 apiKey')
  })

  it('回收站列表里的项目在详情路由上是 404（不是 500）', async () => {
    const { id } = await seedProject()
    await call(webServer, runtime, `/pixmart/api/projects/${id}/delete`, {
      method: 'POST',
      body: { confirm: true },
    })
    const { status, json } = await call(webServer, runtime, `/pixmart/api/projects/${id}`)
    assert.equal(status, 404)
    assert.equal(json.error.code, 'not_found')
  })
})

// ── ② 软删 + 回收站 ─────────────────────────────────────────────────────────

describe('软删 + 回收站', () => {
  it('缺 confirm → 400，且项目一个字节都没动', async () => {
    const { id } = await seedProject()

    const bare = await call(webServer, runtime, `/pixmart/api/projects/${id}/delete`, { method: 'POST' })
    assert.equal(bare.status, 400)
    assert.equal(bare.json.error.code, 'confirm_required')

    const wrong = await call(webServer, runtime, `/pixmart/api/projects/${id}/delete`, {
      method: 'POST',
      body: { confirm: 'true' },
    })
    assert.equal(wrong.status, 400, '字符串 "true" 不算显式确认')

    assert.equal(existsSync(join(projectDirOf(id), 'project.json')), true)
    assert.equal(runtime.projectStore.has(id), true)
    assert.equal(runtime.projectStore.list().length, 1)
  })

  it('confirm:true → 目录改名进 .trash：列表消失、原目录不在、回收站里有', async () => {
    const { id } = await seedProject()

    const { status, json } = await call(webServer, runtime, `/pixmart/api/projects/${id}/delete`, {
      method: 'POST',
      body: { confirm: true },
    })
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.equal(json.trashed, true)
    assert.equal(json.trashId, id)
    assert.equal(json.mode, 'rename', '同盘删除应走改名（跨设备才回退复制）')

    assert.equal(existsSync(projectDirOf(id)), false, '原目录必须不在')
    assert.equal(existsSync(join(trashDirOf(id), 'project.json')), true)
    assert.equal(runtime.projectStore.list().length, 0)

    const trash = await call(webServer, runtime, '/pixmart/api/trash')
    assert.equal(trash.status, 200)
    assert.equal(trash.json.count, 1)
    assert.equal(trash.json.trash[0].id, id)
    assert.equal(trash.json.trash[0].name, '工作台')
    assert.equal(trash.json.trash[0].imageCount, 1)
    assert.ok(trash.json.trash[0].deletedAt > 0, '删除时刻应可读')
  })

  it('`.trash` 绝不会被 list() 当成项目（即使它下面有 project.json）', async () => {
    const { id } = await seedProject()
    await call(webServer, runtime, `/pixmart/api/projects/${id}/delete`, {
      method: 'POST',
      body: { confirm: true },
    })

    // 最坏情况：有人往回收站根目录塞了一份 project.json。
    // 目录扫描若只按"读得到 project.json 就算项目"来判，就会把它列出来。
    writeFileSync(
      join(dataDir, 'projects', '.trash', 'project.json'),
      JSON.stringify({ version: 1, id: '.trash', name: '假的', createdAt: 1, provider: 'x', model: 'y', items: [] }),
      'utf8',
    )

    const listed = runtime.projectStore.list()
    assert.equal(listed.length, 0, '回收站整体不该出现在列表里')
    assert.equal(listed.some((entry) => entry.id === '.trash'), false)

    const http = await call(webServer, runtime, '/pixmart/api/projects?limit=50')
    assert.equal(http.json.count, 0)
    assert.equal(http.json.projects.some((entry) => entry.id === '.trash'), false)

    // 回收站自己的列表照常工作
    const trash = await call(webServer, runtime, '/pixmart/api/trash')
    assert.equal(trash.json.count, 1)
  })

  it('删除后图片文件路由立刻 404（不只是列表消失）', async () => {
    const { id, fileName } = await seedProject()

    const before = await call(webServer, runtime, `/pixmart/file/${id}/${fileName}`)
    assert.equal(before.status, 200)
    assert.equal(before.response.headers['content-type'], 'image/png')
    assert.equal(before.text.length > 0, true)

    await call(webServer, runtime, `/pixmart/api/projects/${id}/delete`, {
      method: 'POST',
      body: { confirm: true },
    })

    const after = await call(webServer, runtime, `/pixmart/file/${id}/${fileName}`)
    assert.equal(after.status, 404, '项目被移走后图片必须立即不可读')
    assert.equal(after.json.error.code, 'not_found')
  })

  it('恢复：回到 projects/ 且重新可见（列表 / 详情 / 图片都回来）', async () => {
    const { id, fileName } = await seedProject()
    await call(webServer, runtime, `/pixmart/api/projects/${id}/delete`, {
      method: 'POST',
      body: { confirm: true },
    })

    const restored = await call(webServer, runtime, `/pixmart/api/trash/${id}/restore`, { method: 'POST' })
    assert.equal(restored.status, 200)
    assert.equal(restored.json.restored, true)
    assert.equal(restored.json.id, id)
    assert.equal(restored.json.mode, 'rename')

    assert.equal(existsSync(join(projectDirOf(id), 'project.json')), true)
    assert.equal(existsSync(trashDirOf(id)), false)
    assert.equal(runtime.projectStore.list().length, 1)

    const detail = await call(webServer, runtime, `/pixmart/api/projects/${id}`)
    assert.equal(detail.status, 200)
    const file = await call(webServer, runtime, `/pixmart/file/${id}/${fileName}`)
    assert.equal(file.status, 200)

    const trash = await call(webServer, runtime, '/pixmart/api/trash')
    assert.equal(trash.json.count, 0)
  })

  it('恢复时原 id 被占用 → 409，条目仍留在回收站', async () => {
    const { id } = await seedProject()
    await call(webServer, runtime, `/pixmart/api/projects/${id}/delete`, {
      method: 'POST',
      body: { confirm: true },
    })
    // 手工把同名目录放回去（模拟"删了又建了同名项目"）
    mkdirSync(join(projectDirOf(id), 'images'), { recursive: true })
    writeFileSync(join(projectDirOf(id), 'project.json'), '{"version":1,"id":"x","items":[]}', 'utf8')

    const { status, json } = await call(webServer, runtime, `/pixmart/api/trash/${id}/restore`, {
      method: 'POST',
    })
    assert.equal(status, 409)
    assert.equal(json.error.code, 'already_exists')
    assert.equal(existsSync(join(trashDirOf(id), 'project.json')), true)
  })

  it('purge 缺 confirm → 400 且回收站还在；带 confirm → 目录被清空', async () => {
    const { id } = await seedProject()
    await call(webServer, runtime, `/pixmart/api/projects/${id}/delete`, {
      method: 'POST',
      body: { confirm: true },
    })

    const refused = await call(webServer, runtime, '/pixmart/api/trash/purge', { method: 'POST' })
    assert.equal(refused.status, 400)
    assert.equal(refused.json.error.code, 'confirm_required')
    assert.equal(existsSync(join(trashDirOf(id), 'project.json')), true)

    const purged = await call(webServer, runtime, '/pixmart/api/trash/purge', {
      method: 'POST',
      body: { confirm: true },
    })
    assert.equal(purged.status, 200)
    assert.equal(purged.json.purged, 1)
    assert.equal(readdirSync(join(dataDir, 'projects', '.trash')).length, 0)
    assert.equal(runtime.projectStore.listTrash().length, 0)
  })

  it('回收站为空时 purge 也是 200（幂等，不报错）', async () => {
    const { status, json } = await call(webServer, runtime, '/pixmart/api/trash/purge', {
      method: 'POST',
      body: { confirm: true },
    })
    assert.equal(status, 200)
    assert.equal(json.purged, 0)
  })

  it('同名项目删两次不互相覆盖（回收站退避成 <id>-2）', async () => {
    const first = await seedProject()
    await call(webServer, runtime, `/pixmart/api/projects/${first.id}/delete`, {
      method: 'POST',
      body: { confirm: true },
    })
    // 再建一个同 id 的项目（直接把目录写回去），然后删第二次
    mkdirSync(join(projectDirOf(first.id), 'images'), { recursive: true })
    writeFileSync(
      join(projectDirOf(first.id), 'project.json'),
      JSON.stringify({ version: 1, id: first.id, name: '工作台', createdAt: 2, provider: 'ofox', model: 'm', items: [] }),
      'utf8',
    )
    const second = await call(webServer, runtime, `/pixmart/api/projects/${first.id}/delete`, {
      method: 'POST',
      body: { confirm: true },
    })
    assert.equal(second.status, 200)
    assert.equal(second.json.trashId, `${first.id}-2`)
    assert.equal(existsSync(join(trashDirOf(first.id), 'project.json')), true)
    assert.equal(existsSync(join(trashDirOf(`${first.id}-2`), 'project.json')), true)
    assert.equal(runtime.projectStore.listTrash().length, 2)
  })
})

// ── ③ 导出 ──────────────────────────────────────────────────────────────────

describe('导出项目', () => {
  it('未配置导出路径且未带 dir → 400 no_export_dir，且磁盘上什么都没多出来', async () => {
    const { id, absolutePath } = await seedProject()
    const bytesBefore = readFileSync(absolutePath)

    const { status, json } = await call(webServer, runtime, `/pixmart/api/projects/${id}/export`, {
      method: 'POST',
    })
    assert.equal(status, 400)
    assert.equal(json.error.code, 'no_export_dir')
    assert.match(json.error.message, /设置/)
    // 语义变更：不再有"默认落到 <dataDir>/exports/<id>"这条兜底
    assert.equal(existsSync(join(dataDir, 'exports')), false)
    assert.equal(existsSync(absolutePath), true)
    assert.equal(readFileSync(absolutePath).equals(bytesBefore), true)
  })

  it('配了 exportDir → 落到 <exportDir>/<id>/：文件真的落盘，原件仍在', async () => {
    const { id, absolutePath } = await seedProject()
    const bytesBefore = readFileSync(absolutePath)
    const exportDir = mkdtempSync(join(tmpdir(), 'pixmart-export-dir-'))
    try {
      const configured = makeFakeRuntime(dataDir, { exportDir })
      const { status, json } = await call(
        makeFakeWebServer(),
        configured,
        `/pixmart/api/projects/${id}/export`,
        { method: 'POST' },
      )
      assert.equal(status, 200)
      assert.equal(json.count, 1)
      assert.equal(json.files.length, 1)
      assert.equal(json.warnings.length, 0)
      assert.equal(json.dir, join(exportDir, id))
      assert.equal(existsSync(json.files[0]), true)
      assert.equal(readFileSync(json.files[0]).equals(bytesBefore), true, '导出的是同一份字节')

      // **原件仍在**：导出是复制，不是移动
      assert.equal(existsSync(absolutePath), true)
      assert.equal(readFileSync(absolutePath).equals(bytesBefore), true)
      assert.equal(configured.projectStore.list().length, 1)
    } finally {
      rmSync(exportDir, { recursive: true, force: true })
    }
  })

  it('带 dir 时覆盖配置：落点仍是 <dir>/<id>，配置目录不被创建', async () => {
    const { id } = await seedProject()
    const configured = mkdtempSync(join(tmpdir(), 'pixmart-export-cfg-'))
    const override = mkdtempSync(join(tmpdir(), 'pixmart-export-override-'))
    try {
      const { status, json } = await call(
        makeFakeWebServer(),
        makeFakeRuntime(dataDir, { exportDir: configured }),
        `/pixmart/api/projects/${id}/export`,
        { method: 'POST', body: { dir: override } },
      )
      assert.equal(status, 200)
      assert.equal(json.dir, join(override, id))
      assert.equal(existsSync(json.files[0]), true)
      assert.equal(json.files[0].startsWith(join(override, id)), true)
      assert.equal(readdirSync(configured).length, 0, '被覆盖的配置目录不该被写入')
    } finally {
      rmSync(configured, { recursive: true, force: true })
      rmSync(override, { recursive: true, force: true })
    }
  })

  it('相对路径的 dir → 400（落点取决于进程 cwd，不可预期）', async () => {
    const { id } = await seedProject()
    const { status, json } = await call(webServer, runtime, `/pixmart/api/projects/${id}/export`, {
      method: 'POST',
      body: { dir: 'exports/relative' },
    })
    assert.equal(status, 400)
    assert.equal(json.error.code, 'invalid_export_dir')
  })

  it('不存在的项目 → 404（不会凭空造目录）', async () => {
    const configured = mkdtempSync(join(tmpdir(), 'pixmart-export-none-'))
    try {
      const { status, json } = await call(
        makeFakeWebServer(),
        makeFakeRuntime(dataDir, { exportDir: configured }),
        '/pixmart/api/projects/nope/export',
        { method: 'POST' },
      )
      assert.equal(status, 404)
      assert.equal(json.error.code, 'not_found')
      assert.equal(existsSync(join(configured, 'nope')), false)
    } finally {
      rmSync(configured, { recursive: true, force: true })
    }
  })
})

// ── ④ 方法与来源两条红线 ────────────────────────────────────────────────────

describe('写路由的方法与来源红线', () => {
  it('GET 打写路由 → 405（绝不落回读逻辑）', async () => {
    const { id } = await seedProject()
    for (const path of [
      `/pixmart/api/projects/${id}/delete`,
      `/pixmart/api/projects/${id}/export`,
      '/pixmart/api/trash/purge',
      `/pixmart/api/trash/${id}/restore`,
    ]) {
      const { status, json } = await call(webServer, runtime, path)
      assert.equal(status, 405, `${path} 应回 405`)
      assert.equal(json.error.code, 'method_not_allowed')
    }
    assert.equal(existsSync(projectDirOf(id)), true)
  })

  it('GET /pixmart/api/trash 是读路由；非环回来源一律 403', async () => {
    const { id } = await seedProject()
    const ok = await call(webServer, runtime, '/pixmart/api/trash')
    assert.equal(ok.status, 200)

    const denied = await call(webServer, runtime, `/pixmart/api/projects/${id}/delete`, {
      method: 'POST',
      body: { confirm: true },
      remoteAddress: '192.168.1.5',
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error.code, 'forbidden')
    assert.equal(existsSync(projectDirOf(id)), true)
  })

  it('回收站路由同样挡目录穿越', async () => {
    const escaped = await call(webServer, runtime, '/pixmart/api/trash/%2E%2E%2F%2E%2E%2Fetc/restore', {
      method: 'POST',
    })
    assert.equal(escaped.status, 400)
    assert.equal(escaped.json.error.code, 'bad_id')

    const dots = await call(webServer, runtime, '/pixmart/api/trash/..%2F..%2Fpwn/restore', { method: 'POST' })
    assert.equal(dots.status, 400)

    const projectEscape = await call(webServer, runtime, '/pixmart/api/projects/%2E%2E%2Fpwn/delete', {
      method: 'POST',
      body: { confirm: true },
    })
    assert.equal(projectEscape.status, 400)
    assert.equal(projectEscape.json.error.code, 'bad_id')
  })
})

// ── ⑤ 移动的跨设备回退（store 级） ──────────────────────────────────────────
describe('moveDir：改名优先、跨设备回退复制', () => {
  it('改名失败 → 复制 + 删原件，源目录消失、目标完整', () => {
    const root = mkdtempSync(join(tmpdir(), 'pixmart-move-'))
    try {
      const from = join(root, 'from')
      const to = join(root, 'to')
      mkdirSync(join(from, 'images'), { recursive: true })
      writeFileSync(join(from, 'images', 'a.png'), 'A', 'utf8')

      const mode = moveDir(from, to, {
        rename: () => {
          throw new Error('EXDEV: cross-device link not permitted')
        },
      })

      assert.equal(mode, 'copy')
      assert.equal(existsSync(from), false)
      assert.equal(readFileSync(join(to, 'images', 'a.png'), 'utf8'), 'A')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('复制失败 → 抛错，且**源目录仍在**（删除不得破坏原项目）', () => {
    const root = mkdtempSync(join(tmpdir(), 'pixmart-move-'))
    try {
      const from = join(root, 'from')
      const to = join(root, 'to')
      mkdirSync(from, { recursive: true })
      writeFileSync(join(from, 'project.json'), '{}', 'utf8')

      assert.throws(
        () =>
          moveDir(from, to, {
            rename: () => {
              throw new Error('EXDEV')
            },
            copy: () => {
              throw new Error('ENOSPC: no space left on device')
            },
          }),
        /复制阶段/,
      )

      assert.equal(existsSync(from), true, '移动失败时原目录必须仍在')
      assert.equal(readFileSync(join(from, 'project.json'), 'utf8'), '{}')
      assert.equal(existsSync(to), false, '半截目标必须被清掉')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('删源失败 → 回滚目标，原目录仍在', () => {
    const root = mkdtempSync(join(tmpdir(), 'pixmart-move-'))
    try {
      const from = join(root, 'from')
      const to = join(root, 'to')
      mkdirSync(from, { recursive: true })
      writeFileSync(join(from, 'project.json'), '{}', 'utf8')

      assert.throws(
        () =>
          moveDir(from, to, {
            rename: () => {
              throw new Error('EXDEV')
            },
            remove: (target) => {
              // 第一次调用是"删源"，之后才是回滚；只让删源失败，回滚仍用真实删除。
              if (target === from) throw new Error('EBUSY')
              rmSync(target, { recursive: true, force: true })
            },
          }),
        /删除原目录阶段/,
      )

      assert.equal(existsSync(from), true)
      assert.equal(existsSync(to), false, '复制出来的副本要回滚掉，不能留半套')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── ⑥ 真实 runtime 上的端到端（防"假 runtime 掩盖真实缺陷"） ────────────────

/**
 * `contract-notes §15.4` 的教训：假 runtime 的 `config()` 直接读内存快照，
 * 于是"写后重取"那个缺陷在假 runtime 上永远测不出来。
 * 这组用例因此用**真实 `createRuntime`** 跑一遍删除 + 导出 + 列表刷新。
 */
describe('真实 runtime：删除 → 回收站 → 恢复 / 导出', () => {
  const stubContext = {
    tools: { register: () => () => {}, schemas: () => [] },
    get: () => undefined,
    effect: () => {},
    on: () => () => {},
  }

  function realRuntime(options = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'pixmart-workbench-real-'))
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        version: 1,
        providers: [],
        defaults: { provider: '', model: '', size: '1:1', n: 1 },
        limits: { maxConcurrency: 2, maxBatchItems: 20, maxRetries: 0, retentionDays: 0 },
        promptOverrides: {},
        exportToWorkspace: false,
        attachmentInConversation: false,
        ...(options.exportDir === undefined ? {} : { exportDir: options.exportDir }),
      }),
      'utf8',
    )
    return { dir, runtime: createRuntime(stubContext, { dataDir: dir }) }
  }

  it('真实 runtime 下：软删后可从回收站恢复，导出只复制', async () => {
    const exportDir = mkdtempSync(join(tmpdir(), 'pixmart-workbench-export-'))
    const { dir, runtime } = realRuntime({ exportDir })
    try {
      const web = makeFakeWebServer()
      const { id, absolutePath, fileName } = await seedProject(runtime.projectStore)

      // 导出落点由配置里的 exportDir 决定：<exportDir>/<项目 id>/
      const exported = await call(web, runtime, `/pixmart/api/projects/${id}/export`, { method: 'POST' })
      assert.equal(exported.status, 200)
      assert.equal(exported.json.count, 1)
      assert.equal(exported.json.dir, join(exportDir, id))
      assert.equal(existsSync(exported.json.files[0]), true)
      assert.equal(existsSync(absolutePath), true, '导出不得动原件')

      // 真实 runtime 的列表读口也看不到被删项目
      const before = await call(web, runtime, '/pixmart/api/projects?limit=50')
      assert.equal(before.json.count, 1)

      const deleted = await call(web, runtime, `/pixmart/api/projects/${id}/delete`, {
        method: 'POST',
        body: { confirm: true },
      })
      assert.equal(deleted.status, 200)
      const after = await call(web, runtime, '/pixmart/api/projects?limit=50')
      assert.equal(after.json.count, 0)
      const lost = await call(web, runtime, `/pixmart/file/${id}/${fileName}`)
      assert.equal(lost.status, 404)

      const restored = await call(web, runtime, `/pixmart/api/trash/${id}/restore`, { method: 'POST' })
      assert.equal(restored.status, 200)
      const back = await call(web, runtime, '/pixmart/api/projects?limit=50')
      assert.equal(back.json.count, 1)
      assert.equal(back.json.projects[0].id, id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(exportDir, { recursive: true, force: true })
    }
  })
})
