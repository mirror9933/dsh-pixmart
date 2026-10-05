/**
 * P2 验收测试：批量（A5）、运行注册表、用量硬计数、项目库工具。
 *
 * A5 用真实 mock 端点端到端跑：8 项 / 并发 2 / 全部落盘 / 文件名不冲突。
 * 全程零真实花费。
 */
import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RunStore } from '../lib/store/run-store.js'
import { UsageLog } from '../lib/log/usage.js'
import { createRuntime } from '../lib/tools/runtime.js'
import { createBatchTool } from '../lib/tools/batch.js'
import { createProjectsTool } from '../lib/tools/projects.js'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')

const stubContext = {
  tools: { register: () => () => {}, schemas: () => [] },
  get: () => undefined,
  effect: () => {},
  on: () => () => {},
}

const stubExec = {
  callId: 'test',
  signal: { aborted: false, addEventListener: () => {} },
  deferContext: () => {},
  concludeTurn: () => {},
}

let server
let port
let requests

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests += 1
      // 每次返回**不同字节**（在 IEND 后追加一个唯一标记），
      // 否则内容寻址会把 8 次产出折叠成同一个文件，测不到命名冲突逻辑。
      const unique = Buffer.concat([PNG, Buffer.from(`\n<!-- #${requests} -->`)])
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: unique.toString('base64') }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(() => {
  requests = 0
})

/** 造一个指向 mock 端点的数据目录 + 运行时。 */
function makeRuntime(tweaks = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pixmart-p2-'))
  const config = {
    version: 1,
    providers: [
      {
        id: 'mock',
        label: 'Mock',
        group: 'aggregator',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        geminiNativeBaseUrl: '',
        dialect: 'standard',
        apiMode: 'images-generations',
        apiKeyEnv: '',
        apiKey: 'test-key',
        models: ['test-image-model'],
        // 覆盖各模块的默认尺寸：白名单太窄会让部分项按设计失败（那是正确行为，
        // 但会掩盖本用例真正要测的"8 项全部落盘"）。
        allowedSizes: ['1:1', '3:4', '4:3', '9:16', '16:9', '4:5'],
        sizeMode: 'whitelist',
        extraHeaders: {},
        timeoutMs: 30_000,
        ...(tweaks.provider ?? {}),
      },
    ],
    defaults: { provider: 'mock', model: 'test-image-model', size: '1:1', n: 1 },
    limits: { maxConcurrency: 2, maxBatchItems: 20, maxRetries: 0, retentionDays: 0 },
    promptOverrides: {},
    exportToWorkspace: false,
    attachmentInConversation: false,
    ...(tweaks.config ?? {}),
  }
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2))
  return { dir, runtime: createRuntime(stubContext, { dataDir: dir }) }
}

describe('A5 —— 批量生成', () => {
  it('8 项 / 并发 2：全部落盘、逐项状态、文件名不冲突', async () => {
    const { dir, runtime } = makeRuntime()
    try {
      const tool = createBatchTool(runtime)
      const items = [
        'main.white-bg',
        'main.scene',
        'main.selling-point',
        'main.detail',
        'main.size-spec',
        'detail.hero',
        'detail.scene',
        'detail.ambience',
      ].map((module) => ({ module }))

      const result = await tool.execute({ items, project: 'A5', concurrency: 2 }, stubExec)

      assert.equal(result.ok, true)
      assert.equal(result.total, 8)
      assert.equal(result.completed, 8)
      assert.equal(result.failed, 0)
      assert.equal(result.requests, 8)

      // 磁盘上确实是 8 个互不相同的文件
      const imagesDir = runtime.projectStore.imagesDir(result.projectId)
      const files = readdirSync(imagesDir)
      assert.equal(files.length, 8, `期望 8 个文件，实际 ${files.length}`)
      assert.equal(new Set(files).size, 8)

      // 每项都有产出
      for (const entry of result.items) {
        assert.equal(entry.status, 'done', `${entry.module} 应成功`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('单项失败不影响其余（未知模块被跳过）', async () => {
    const { dir, runtime } = makeRuntime()
    try {
      const tool = createBatchTool(runtime)
      const result = await tool.execute(
        { items: [{ module: 'main.white-bg' }, { module: 'not.a.module' }], project: 'A5b' },
        stubExec,
      )

      assert.equal(result.ok, true)
      assert.equal(result.completed, 1)
      assert.equal(result.failed, 1)
      const failed = result.items.find((entry) => entry.status === 'failed')
      assert.match(String(failed.error), /未知模块/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('超出 maxBatchItems 直接拒绝，不发请求', async () => {
    const { dir, runtime } = makeRuntime({ config: { limits: { maxConcurrency: 2, maxBatchItems: 3, maxRetries: 0, retentionDays: 0 } } })
    try {
      const tool = createBatchTool(runtime)
      const result = await tool.execute(
        { items: Array.from({ length: 5 }, () => ({ module: 'main.white-bg' })) },
        stubExec,
      )
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'too_many_items')
      assert.equal(requests, 0, '被拦截的批量不应发出任何厂商请求')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('运行注册表', () => {
  it('记录逐项状态并在结束时汇总', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixmart-run-'))
    try {
      const store = new RunStore(dir)
      const run = await store.create({
        tool: 'batch',
        provider: 'mock',
        model: 'm',
        apiMode: 'images-generations',
        size: '1:1',
        total: 2,
        items: [{ module: 'a', label: 'A' }, { module: 'b', label: 'B' }],
      })
      assert.equal(run.status, 'running')
      assert.equal(run.items.length, 2)

      await store.setItem(run.runId, 0, { status: 'done', file: 'images/x.png' })
      await store.setItem(run.runId, 1, { status: 'failed', error: { code: 'x', message: 'y' } })
      const finished = await store.finish(run.runId, 'done')

      assert.equal(finished.completed, 1)
      assert.equal(finished.failed, 1)
      assert.equal(finished.status, 'done')

      const listed = store.list()
      assert.equal(listed.length, 1)
      assert.equal(listed[0].runId, run.runId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('boot 时把遗留的 running 改判为 interrupted（绝不假装还在跑）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixmart-run-'))
    try {
      const store = new RunStore(dir)
      const run = await store.create({
        tool: 'generate',
        provider: 'mock',
        model: 'm',
        apiMode: 'images-generations',
        size: '1:1',
        total: 1,
        items: [{ module: 'a', label: 'A' }],
      })
      assert.equal(store.read(run.runId).status, 'running')

      // 模拟"新进程启动"
      const booted = new RunStore(dir)
      const touched = await booted.markInterruptedOnBoot()

      assert.deepEqual([...touched], [run.runId])
      assert.equal(booted.read(run.runId).status, 'interrupted')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prune 只保留最近 N 条', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixmart-run-'))
    try {
      const store = new RunStore(dir)
      for (let i = 0; i < 5; i += 1) {
        await store.create({
          tool: 'generate',
          provider: 'mock',
          model: 'm',
          apiMode: 'images-generations',
          size: '1:1',
          total: 1,
          items: [{ module: 'a', label: 'A' }],
        })
      }
      assert.equal(store.list(100).length, 5)
      const removed = await store.prune(2)
      assert.equal(removed, 3)
      assert.equal(store.list(100).length, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('用量硬计数', () => {
  it('append + summary 聚合，且容忍撕裂尾行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixmart-usage-'))
    try {
      const log = new UsageLog(dir)
      log.append({ ts: 1, provider: 'ofox', model: 'm1', apiMode: 'gemini-native', size: '1:1', n: 1, images: 1, ok: true, ms: 100 })
      log.append({ ts: 2, provider: 'ofox', model: 'm1', apiMode: 'gemini-native', size: '1:1', n: 1, images: 1, ok: true, ms: 120 })
      log.append({ ts: 3, provider: 'ofox', model: 'm2', apiMode: 'images-generations', size: '1:1', n: 1, images: 0, ok: false, ms: 30, errorCode: 'auth' })

      const summary = log.summary()
      assert.equal(summary.requests, 3)
      assert.equal(summary.ok, 2)
      assert.equal(summary.failed, 1)
      assert.equal(summary.images, 2)
      assert.equal(summary.byModel['ofox/m1'], 2)

      // 撕裂尾行：写入半截 JSON，读取应跳过而不炸
      writeFileSync(log.file, readFileSync(log.file, 'utf8') + '{"ts":4,"provider":', 'utf8')
      assert.equal(log.summary().requests, 3)
      assert.equal(existsSync(log.file), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('pixmart_projects', () => {
  it('list / get / usage 可用；delete 必须显式确认', async () => {
    const { dir, runtime } = makeRuntime({ config: { attachmentInConversation: false } })
    try {
      // 先造一个项目
      const batch = createBatchTool(runtime)
      const made = await batch.execute(
        { items: [{ module: 'main.white-bg' }], project: 'PROJ' },
        stubExec,
      )
      assert.equal(made.ok, true)

      const tool = createProjectsTool(runtime)

      const listed = await tool.execute({ action: 'list' }, stubExec)
      assert.equal(listed.ok, true)
      assert.equal(listed.count, 1)
      assert.equal(listed.projects[0].id, made.projectId)

      const got = await tool.execute({ action: 'get', id: made.projectId }, stubExec)
      assert.equal(got.ok, true)
      assert.equal(got.project.items.length, 1)

      // 用量：批量那 1 次请求被记下来了
      const usage = await tool.execute({ action: 'usage' }, stubExec)
      assert.equal(usage.summary.requests, 1)
      assert.equal(usage.summary.images, 1)

      // 导出
      const exported = await tool.execute({ action: 'export', id: made.projectId }, stubExec)
      assert.equal(exported.ok, true)
      assert.equal(exported.count, 1)
      assert.ok(existsSync(exported.files[0]))

      // 未确认的删除被拒绝，且项目仍在
      const refused = await tool.execute({ action: 'delete', ids: [made.projectId] }, stubExec)
      assert.equal(refused.ok, false)
      assert.equal(refused.error.code, 'confirm_required')
      assert.equal(runtime.projectStore.has(made.projectId), true)

      // 确认后删除
      const deleted = await tool.execute(
        { action: 'delete', ids: [made.projectId], confirm: true },
        stubExec,
      )
      assert.equal(deleted.ok, true)
      assert.deepEqual([...deleted.deleted], [made.projectId])
      assert.equal(runtime.projectStore.has(made.projectId), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
