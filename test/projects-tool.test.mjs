/**
 * `pixmart_projects` 工具的删除语义测试（软删 / 永久删 / 恢复）。
 *
 * 背景：作品库的 UI/HTTP 路径早已是**软删 + 回收站**（可恢复），但 Agent 这条路的
 * `delete` 一直是硬删 `rmSync` —— 两个入口语义相反，而"把那些测试项目删掉"这类话
 * 恰恰最容易走到 Agent 路径上。这里钉住三条：
 *
 *   1. 默认 = 软删（原目录消失、出现在回收站、可用 `restore` 恢复）；
 *   2. 只有 `permanent: true` 才真删，且真删后**回收站里也没有**；
 *   3. 两种模式都仍要求 `confirm: true`，缺了就拒绝且**不碰磁盘**。
 *
 * 另外钉住 `export` 的目标口径与 HTTP 完全一致：入参 `dir` 覆盖 > 配置里的
 * 「作品库导出路径」> 失败，落点固定 `<目标>/<项目 id>/`；返回字段仍叫 `targetDir`
 * （不再是会与配置项 `exportDir` 撞概念的那个名字），且**不再**有数据目录内的
 * `exports/` 这条隐式落点。以及 `list` 绝不把回收站条目混进项目列表。
 *
 * 全程不联网、不调用厂商：项目直接由 `ProjectStore` 造出来（要的是删除语义，不是生图）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRuntime } from '../lib/tools/runtime.js'
import { createProjectsTool } from '../lib/tools/projects.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

const stubContext = {
  tools: { register: () => () => {}, schemas: () => [] },
  get: () => undefined,
  effect: () => {},
  on: () => () => {},
}

const stubExec = {
  callId: 'test',
  signal: new AbortController().signal,
  deferContext: () => {},
  concludeTurn: () => {},
}

/** 造一个临时数据目录 + 真实 runtime（配置里不需要任何厂商）。 */
function makeRuntime(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pixmart-projects-tool-'))
  const config = {
    version: 1,
    providers: [],
    defaults: { provider: '', model: '', size: '1:1', n: 1 },
    limits: { maxConcurrency: 2, maxBatchItems: 20, maxRetries: 0, retentionDays: 0 },
    promptOverrides: {},
    attachmentInConversation: false,
    // 默认**未配置**「作品库导出路径」：导出因此必须具备显式目标，否则明确失败。
    exportDir: options.exportDir ?? '',
  }
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
  return { dir, runtime: createRuntime(stubContext, { dataDir: dir }) }
}

/** 直接落盘一个"有 1 张图"的完整项目。 */
async function seedProject(runtime, name) {
  const record = await runtime.projectStore.create(name, 'mock', 'test-image-model', 1_700_000_000_000)
  const stored = await runtime.projectStore.saveImage(record.id, PNG, 'image/png', 'shot')
  await runtime.projectStore.appendItem(record.id, {
    module: 'main.white-bg',
    label: '主图',
    prompt: '白底主图',
    size: '1:1',
    provider: 'mock',
    model: 'test-image-model',
    apiMode: 'images-generations',
    status: 'ok',
    // 只把记录字段塞进去：`absolutePath` 是 saveImage 给调用方的额外信息，不属于记录。
    images: [
      {
        file: stored.file,
        bytes: stored.bytes,
        width: stored.width,
        height: stored.height,
        sha256: stored.sha256,
        mediaType: stored.mediaType,
      },
    ],
    ms: 12,
    createdAt: 1_700_000_000_100,
  })
  return record
}

/** 跑一次 render，拿回纯文本（工具渲染是断言"用户/模型看到什么"的唯一入口）。 */
function renderText(tool, args, value) {
  const blocks = tool.output.render(args, value)
  return blocks.map((block) => String(block.text ?? '')).join('\n')
}

function withRuntime(fn, options) {
  const { dir, runtime } = makeRuntime(options)
  return Promise.resolve()
    .then(() => fn({ dir, runtime, tool: createProjectsTool(runtime) }))
    .finally(() => rmSync(dir, { recursive: true, force: true }))
}

describe('pixmart_projects：delete 默认软删', () => {
  it('默认 → 项目从 list() 消失、出现在回收站、原目录不在', async () => {
    await withRuntime(async ({ runtime, tool }) => {
      const record = await seedProject(runtime, 'A')
      const result = await tool.execute({ action: 'delete', ids: [record.id], confirm: true }, stubExec)

      assert.equal(result.ok, true)
      // 返回形状不变：`deleted` 仍在，且就是被删的 id。
      assert.deepEqual([...result.deleted], [record.id])
      assert.equal(result.permanent, false, '默认必须是软删')

      assert.equal(runtime.projectStore.has(record.id), false)
      assert.equal(runtime.projectStore.list().length, 0, '软删后不该再出现在 list()')
      assert.equal(
        existsSync(join(runtime.projectStore.projectsRoot, record.id)),
        false,
        '原目录必须已经不在 projects/ 下了',
      )

      const trash = runtime.projectStore.listTrash()
      assert.equal(trash.length, 1, '必须出现在回收站里')
      assert.equal(trash[0].projectId, record.id)
      assert.equal(existsSync(join(runtime.projectStore.trashRoot, trash[0].id)), true)

      // 渲染文本必须说清"去哪了"和"怎么恢复"。
      const text = renderText(tool, {}, result)
      assert.match(text, /已移入回收站 1 个项目/)
      assert.match(text, /action=restore/)
      assert.match(text, /permanent: true/)
    })
  })

  it('软删失败时原项目必须仍在（不得删一半）', async () => {
    await withRuntime(async ({ runtime, tool }) => {
      const record = await seedProject(runtime, 'A')
      const original = runtime.projectStore.moveToTrash.bind(runtime.projectStore)
      // 强制走失败分支（例如跨设备复制到一半失败）。
      runtime.projectStore.moveToTrash = async () => {
        throw new Error('模拟移动失败')
      }
      try {
        const result = await tool.execute(
          { action: 'delete', ids: [record.id], confirm: true },
          stubExec,
        )
        assert.deepEqual([...result.deleted], [], '失败的条目不能算删成功')
        assert.equal(result.skipped.length, 1)
        assert.match(String(result.skipped[0].reason), /模拟移动失败/)
      } finally {
        runtime.projectStore.moveToTrash = original
      }

      assert.equal(runtime.projectStore.has(record.id), true, '原项目必须仍在')
      assert.equal(runtime.projectStore.list().length, 1)
      assert.equal(runtime.projectStore.listTrash().length, 0)
    })
  })
})

describe('pixmart_projects：restore 从回收站恢复', () => {
  it('delete 后 restore → 回到 list()，内容和图片文件都完整', async () => {
    await withRuntime(async ({ runtime, tool }) => {
      const record = await seedProject(runtime, 'A')
      const before = readFileSync(
        join(runtime.projectStore.projectsRoot, record.id, 'project.json'),
        'utf8',
      )

      await tool.execute({ action: 'delete', ids: [record.id], confirm: true }, stubExec)
      assert.equal(runtime.projectStore.list().length, 0)

      // 用**原项目 id** 恢复（Agent 手上通常只有这个）。
      const restored = await tool.execute({ action: 'restore', ids: [record.id] }, stubExec)
      assert.equal(restored.ok, true)
      assert.deepEqual([...restored.restored], [record.id])

      assert.equal(runtime.projectStore.has(record.id), true)
      assert.equal(runtime.projectStore.list().length, 1)
      assert.deepEqual(runtime.projectStore.list().map((entry) => entry.id), [record.id])
      assert.equal(runtime.projectStore.listTrash().length, 0, '恢复后回收站里不该还有它')

      const after = readFileSync(
        join(runtime.projectStore.projectsRoot, record.id, 'project.json'),
        'utf8',
      )
      assert.equal(after, before, '恢复必须逐字节还原记录')
      const read = runtime.projectStore.read(record.id)
      assert.equal(read.items.length, 1)
      assert.equal(read.items[0].images.length, 1)
      const imagePath = join(runtime.projectStore.imagesDir(record.id), read.items[0].images[0].file.split('/').pop())
      assert.equal(existsSync(imagePath), true, '图片文件也必须跟着回来')

      assert.match(renderText(tool, {}, restored), /已从回收站恢复 1 个项目/)
    })
  })

  it('回收站条目 id（list 报出的那个）也能恢复；不在回收站则逐条跳过', async () => {
    await withRuntime(async ({ runtime, tool }) => {
      const record = await seedProject(runtime, 'A')
      await tool.execute({ action: 'delete', ids: [record.id], confirm: true }, stubExec)
      const trashId = runtime.projectStore.listTrash()[0].id

      const missing = await tool.execute({ action: 'restore', ids: ['nonexistent'] }, stubExec)
      assert.deepEqual([...missing.restored], [])
      assert.equal(missing.skipped.length, 1)

      const restored = await tool.execute({ action: 'restore', ids: [trashId] }, stubExec)
      assert.deepEqual([...restored.restored], [record.id])
      assert.equal(runtime.projectStore.has(record.id), true)
    })
  })
})

describe('pixmart_projects：delete permanent: true 才是真删', () => {
  it('永久删除 → 不在回收站（真删）', async () => {
    await withRuntime(async ({ runtime, tool }) => {
      const record = await seedProject(runtime, 'A')
      const result = await tool.execute(
        { action: 'delete', ids: [record.id], confirm: true, permanent: true },
        stubExec,
      )

      assert.equal(result.ok, true)
      assert.deepEqual([...result.deleted], [record.id])
      assert.equal(result.permanent, true)
      assert.equal(runtime.projectStore.has(record.id), false)
      assert.equal(
        existsSync(join(runtime.projectStore.projectsRoot, record.id)),
        false,
      )
      assert.equal(runtime.projectStore.listTrash().length, 0, '永久删不得留下回收站条目')

      const text = renderText(tool, {}, result)
      assert.match(text, /已永久删除 1 个项目/)
      assert.match(text, /不可恢复/)
    })
  })
})

describe('pixmart_projects：confirm 红线（两种模式都要）', () => {
  it('缺 confirm → 软删被拒，且项目与回收站都没动', async () => {
    await withRuntime(async ({ runtime, tool }) => {
      const record = await seedProject(runtime, 'A')
      const refused = await tool.execute({ action: 'delete', ids: [record.id] }, stubExec)

      assert.equal(refused.ok, false)
      assert.equal(refused.error.code, 'confirm_required')
      assert.equal(runtime.projectStore.has(record.id), true)
      assert.equal(runtime.projectStore.listTrash().length, 0)
    })
  })

  it('缺 confirm → permanent: true 也被拒，项目仍在', async () => {
    await withRuntime(async ({ runtime, tool }) => {
      const record = await seedProject(runtime, 'A')
      const refused = await tool.execute(
        { action: 'delete', ids: [record.id], permanent: true },
        stubExec,
      )

      assert.equal(refused.ok, false)
      assert.equal(refused.error.code, 'confirm_required')
      assert.equal(runtime.projectStore.has(record.id), true)
      assert.equal(runtime.projectStore.list().length, 1)
    })
  })

  it('confirm 只认布尔 true（字符串 "true" 不算）', async () => {
    await withRuntime(async ({ runtime, tool }) => {
      const record = await seedProject(runtime, 'A')
      const refused = await tool.execute(
        { action: 'delete', ids: [record.id], confirm: 'true' },
        stubExec,
      )
      assert.equal(refused.ok, false)
      assert.equal(refused.error.code, 'confirm_required')
      assert.equal(runtime.projectStore.has(record.id), true)
    })
  })
})

describe('pixmart_projects：export 的目标与 HTTP 同一口径', () => {
  it('给了 dir → 落 <dir>/<项目 id>/；数据目录下**不再**产生 exports/', async () => {
    await withRuntime(async ({ dir, runtime, tool }) => {
      const record = await seedProject(runtime, 'A')
      const target = join(dir, 'explicit-target')
      const exported = await tool.execute(
        { action: 'export', id: record.id, dir: target },
        stubExec,
      )

      assert.equal(exported.ok, true)
      assert.equal(exported.count, 1)
      assert.equal(exported.targetDir, join(target, record.id), '落点必须是 <dir>/<项目 id>')
      assert.equal('exportDir' in exported, false, '不得再回传与配置项撞名的 exportDir')
      assert.deepEqual([...exported.warnings], [], '正常导出不该有警告')
      assert.equal(existsSync(exported.files[0]), true)
      assert.equal(readFileSync(exported.files[0]).equals(PNG), true, '导出的是同一份字节')

      // ① 只复制、不移动：原件仍在数据目录的 images/ 里
      const stored = runtime.projectStore.read(record.id).items[0].images[0].file.split('/').pop()
      assert.equal(existsSync(join(runtime.projectStore.imagesDir(record.id), stored)), true)
      // ② 插件不再自作主张往数据目录里写 exports/（那是被取消的隐式默认落点）
      assert.equal(existsSync(join(dir, 'exports')), false, '数据目录下不得有 exports/')

      const text = renderText(tool, {}, exported)
      assert.match(text, /已导出 1 个文件到/)
      assert.match(text, /explicit-target/)
      assert.equal(/exports/.test(text), false, '渲染文本不得再宣称 exports/')
    })
  })

  it('只配了 exportDir → 用配置里的「作品库导出路径」，落 <exportDir>/<项目 id>/', async () => {
    const exportRoot = mkdtempSync(join(tmpdir(), 'pixmart-tool-export-root-'))
    try {
      await withRuntime(
        async ({ dir, runtime, tool }) => {
          const record = await seedProject(runtime, 'A')
          const exported = await tool.execute({ action: 'export', id: record.id }, stubExec)

          assert.equal(exported.ok, true)
          assert.equal(exported.count, 1)
          assert.equal(exported.targetDir, join(exportRoot, record.id))
          assert.equal(existsSync(exported.files[0]), true)
          assert.equal(existsSync(join(dir, 'exports')), false, '配了 exportDir 也不该碰数据目录里的 exports/')
        },
        { exportDir: exportRoot },
      )
    } finally {
      rmSync(exportRoot, { recursive: true, force: true })
    }
  })

  it('两者皆无 → 明确失败（文案指向设置页），且**不写任何文件**', async () => {
    await withRuntime(async ({ dir, runtime, tool }) => {
      const record = await seedProject(runtime, 'A')
      const before = readdirSync(dir).sort()

      const refused = await tool.execute({ action: 'export', id: record.id }, stubExec)

      assert.equal(refused.ok, false)
      assert.equal(refused.error.code, 'no_export_dir')
      assert.match(refused.error.message, /设置/)
      assert.match(refused.error.message, /作品库导出路径/)
      assert.match(refused.error.message, /PixMart/, '文案要指到设置里的具体位置')
      // 失败不碰磁盘：连空目录都不许造
      assert.deepEqual(readdirSync(dir).sort(), before, '没配目录时不许凭空造目录')
      assert.equal(existsSync(join(dir, 'exports')), false)

      const text = renderText(tool, {}, refused)
      assert.match(text, /no_export_dir/)
      assert.match(text, /设置/)
    })
  })

  it('目标不可写 → 仍是 ok: true + warnings，原件一个字节都没丢', async () => {
    await withRuntime(async ({ dir, runtime, tool }) => {
      const record = await seedProject(runtime, 'A')
      // 父级是文件：mkdirSync 一定失败（跨平台都抛）
      const blocker = join(dir, 'blocker')
      writeFileSync(blocker, 'not a directory')

      const exported = await tool.execute(
        { action: 'export', id: record.id, dir: join(blocker, 'out') },
        stubExec,
      )

      assert.equal(exported.ok, true, '复制失败不该把工具变成失败')
      assert.equal(exported.count, 0)
      assert.equal(exported.warnings.length, 1)
      assert.match(exported.warnings[0], /产物复制失败：/)
      assert.match(exported.warnings[0], /原件仍在/)
      const stored = runtime.projectStore.read(record.id).items[0].images[0].file.split('/').pop()
      assert.equal(existsSync(join(runtime.projectStore.imagesDir(record.id), stored)), true)
      assert.match(renderText(tool, {}, exported), /⚠/)
    })
  })
})

describe('pixmart_projects：list 与回收站分开报', () => {
  it('回收站条目不得混进 list 结果，但要单独报出来（含恢复要用的 id）', async () => {
    await withRuntime(async ({ runtime, tool }) => {
      const keep = await seedProject(runtime, 'Keep')
      const dropped = await seedProject(runtime, 'Drop')
      await tool.execute({ action: 'delete', ids: [dropped.id], confirm: true }, stubExec)

      const listed = await tool.execute({ action: 'list' }, stubExec)
      assert.equal(listed.ok, true)
      assert.equal(listed.count, 1)
      assert.deepEqual(listed.projects.map((entry) => entry.id), [keep.id])
      assert.equal(
        listed.projects.some((entry) => entry.id === dropped.id),
        false,
        '回收站项目绝不能出现在 projects 里',
      )

      assert.equal(listed.trashCount, 1)
      assert.equal(listed.trash.length, 1)
      assert.equal(listed.trash[0].projectId, dropped.id)
      assert.equal(typeof listed.trash[0].id, 'string')

      const text = renderText(tool, {}, listed)
      assert.match(text, new RegExp(`^项目 1 个：`, 'm'))
      assert.match(text, /回收站另有 1 个项目/)
      assert.match(text, /action=restore/)
    })
  })
})

describe('pixmart_projects：工具 schema', () => {
  it('permanent 存在、可选、是 boolean；action 里多了 restore', () => {
    const { runtime } = makeRuntime()
    try {
      const tool = createProjectsTool(runtime)
      const schema = tool.parameters

      assert.equal(schema.properties.permanent.type, 'boolean')
      assert.equal(
        schema.required.includes('permanent'),
        false,
        'permanent 必须是可选参数（缺省即软删）',
      )
      assert.equal(schema.properties.confirm.type, 'boolean')
      assert.equal(schema.required.includes('confirm'), false)
      assert.equal(schema.properties.action.enum.includes('restore'), true)
      assert.equal(schema.properties.action.enum.includes('delete'), true)
      // export 的目标是**显式**的：dir 可覆盖设置里的「作品库导出路径」，且是可选参数
      assert.equal(schema.properties.dir.type, 'string')
      assert.equal(schema.required.includes('dir'), false)

      const description = String(tool.description)
      assert.match(description, /软删/, '描述必须说明 delete 默认是软删')
      assert.match(description, /permanent: true/, '描述必须说明永久删的开关')
      assert.match(description, /restore/, '描述必须提到可恢复')
      assert.match(description, /作品库导出路径/, '描述必须说明 export 的目标从哪来')
      assert.match(description, /dir/, '描述必须说明可以用 dir 显式指定目标')
      assert.equal(/exports\//.test(description), false, '描述不得再宣称数据目录里的 exports/')
    } finally {
      // 这里只读 schema，没写过任何东西；仍清掉临时目录。
      const dir = runtime.dataDir
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
