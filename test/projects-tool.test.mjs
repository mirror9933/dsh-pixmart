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
 * 另外钉住两次收敛后的边界（contract-notes §16.5 / §16.6）：
 *   1. `pixmart_projects` **没有** `export` action——Agent 侧不存在任何写文件的落点，
 *      调 `export` 只走未知 action 的既有失败路径，磁盘一个字节都不动（含**不得**产生
 *      数据目录下的 `exports/`）；
 *   2. Agent 要"知道文件在哪"靠 `action=get` 报出的**会话暂存目录**
 *      （`<工作区>/pixmart-out/<项目 id>` + `exists` 标志）——只探测、绝不创建，
 *      拿不到工作区时该字段**缺省**（不编造路径）。
 * 以及 `list` 绝不把回收站条目混进项目列表。
 *
 * 全程不联网、不调用厂商：项目直接由 `ProjectStore` 造出来（要的是删除语义，不是生图）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

/**
 * 带会话工作区的执行上下文：形状与宿主一致（`agent.session.header.cwd`）。
 * 与 `test/pixmart-out.test.mjs` 同一套取证（见 src/tools/workspace-copy.ts 顶部）。
 */
function execIn(workspace) {
  return { ...stubExec, agent: { id: 'agent-test', session: { header: { cwd: workspace } } } }
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

describe('pixmart_projects：export 能力已被删除（Agent 没有任何写文件的落点）', () => {
  it('action=export → 走未知 action 的既有失败路径，且不写任何文件', async () => {
    await withRuntime(async ({ dir, runtime, tool }) => {
      const record = await seedProject(runtime, 'A')
      const before = readdirSync(dir).sort()

      const refused = await tool.execute(
        { action: 'export', id: record.id, dir: join(dir, 'agent-target') },
        stubExec,
      )

      assert.equal(refused.ok, false)
      assert.equal(refused.error.code, 'invalid_args')
      assert.match(refused.error.message, /未知 action/)
      assert.match(refused.error.message, /export/)
      // 失败不碰磁盘：连空目录都不许造（那条 `dir` 入参本身也已经不存在了）
      assert.deepEqual(readdirSync(dir).sort(), before, '被拒的 export 不许凭空造目录')
      assert.equal(existsSync(join(dir, 'agent-target')), false)
      assert.equal(existsSync(join(dir, 'exports')), false, '数据目录下不得有 exports/')
      // 渲染文本走失败分支（说清错误码），不得宣称"已导出"
      const text = renderText(tool, {}, refused)
      assert.match(text, /invalid_args/)
      assert.equal(/已导出/.test(text), false)
    })
  })

  it('即使配了「作品库导出路径」，export 仍被拒且那个用户目录不被创建', async () => {
    const exportRoot = mkdtempSync(join(tmpdir(), 'pixmart-agent-export-root-'))
    try {
      await withRuntime(
        async ({ dir, runtime, tool }) => {
          const record = await seedProject(runtime, 'A')
          const refused = await tool.execute({ action: 'export', id: record.id }, stubExec)

          assert.equal(refused.ok, false)
          assert.equal(refused.error.code, 'invalid_args')
          assert.equal(
            existsSync(join(exportRoot, record.id)),
            false,
            'Agent 侧不得写进用户配置的作品库导出路径',
          )
          assert.deepEqual(readdirSync(exportRoot), [], '用户配置的目录必须一个字节都没被碰')
          assert.equal(existsSync(join(dir, 'exports')), false)
        },
        { exportDir: exportRoot },
      )
    } finally {
      rmSync(exportRoot, { recursive: true, force: true })
    }
  })

  it('在干净临时数据目录里跑一遍全部只读/回收站动作：不产生 exports/', async () => {
    await withRuntime(async ({ dir, runtime, tool }) => {
      const record = await seedProject(runtime, 'A')
      assert.equal(existsSync(join(dir, 'exports')), false, '一开始就不该有')

      await tool.execute({ action: 'list' }, stubExec)
      await tool.execute({ action: 'get', id: record.id }, stubExec)
      await tool.execute({ action: 'usage' }, stubExec)
      await tool.execute({ action: 'export', id: record.id, dir: join(dir, 'nope') }, stubExec)
      await tool.execute({ action: 'delete', ids: [record.id], confirm: true }, stubExec)
      await tool.execute({ action: 'restore', ids: [record.id] }, stubExec)

      assert.equal(existsSync(join(dir, 'exports')), false, '数据目录下必须始终没有 exports/')
      assert.equal(existsSync(join(dir, 'nope')), false)
    })
  })
})

describe('pixmart_projects：get 给出会话暂存目录（替代原来的导出）', () => {
  it('能取到工作区 → 回 <工作区>/pixmart-out/<项目 id> 与 exists 标志；只探测不创建', async () => {
    await withRuntime(async ({ runtime, tool }) => {
      const record = await seedProject(runtime, 'A')
      const workspace = mkdtempSync(join(tmpdir(), 'pixmart-get-workspace-'))
      try {
        const first = await tool.execute({ action: 'get', id: record.id }, execIn(workspace))
        assert.equal(first.ok, true)
        assert.equal(first.workspaceOut.workspace, workspace)
        assert.equal(first.workspaceOut.dir, join(workspace, 'pixmart-out', record.id))
        assert.equal(first.workspaceOut.exists, false, '本会话还没生成过 → 目录不存在')
        assert.equal(existsSync(first.workspaceOut.dir), false, 'get 只探测，绝不创建目录')

        // 造出副本目录（等价于此前 generate 留下的那一份）→ exists 必须翻真
        mkdirSync(first.workspaceOut.dir, { recursive: true })
        const second = await tool.execute({ action: 'get', id: record.id }, execIn(workspace))
        assert.equal(second.workspaceOut.exists, true)
        assert.equal(second.workspaceOut.dir, first.workspaceOut.dir)

        // 渲染文本三件事：原件在数据目录、暂存副本路径、本工具不导出到用户目录
        const text = renderText(tool, {}, second)
        assert.match(text, /pixmart-out/)
        assert.equal(text.includes(second.workspaceOut.dir), true, '必须给出暂存目录的完整路径')
        assert.equal(text.includes(join(runtime.dataDir, 'projects', record.id, 'images')), true)
        assert.match(text, /作品库可浏览/)
        assert.match(text, /不会把图片导出到设置里/)
        assert.equal(/exports\//.test(text), false)
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    })
  })

  it('取不到工作区（无 agent / 相对路径）→ 字段缺省，不编造路径', async () => {
    await withRuntime(async ({ runtime, tool }) => {
      const record = await seedProject(runtime, 'A')
      for (const exec of [stubExec, execIn('relative/ws')]) {
        const got = await tool.execute({ action: 'get', id: record.id }, exec)
        assert.equal(got.ok, true)
        assert.equal('workspaceOut' in got, false, '拿不到工作区时该字段必须缺省')
        const text = renderText(tool, {}, got)
        assert.equal(/pixmart-out/.test(text), false, '文本里不得出现编造的工作区路径')
        assert.match(text, /拿不到会话工作区/, '必须说出来，别让模型把缺失读成空路径')
      }
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
  it('action 列表里没有 export；permanent 可选、是 boolean；action 含 restore；描述不宣称任何写文件能力', () => {
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

      // ① action 列表里不再有 export（逐项断言，避免"漏了一个"被 in 掩盖）
      assert.deepEqual(
        [...schema.properties.action.enum],
        ['list', 'get', 'delete', 'restore', 'usage'],
        'action 枚举必须恰好是这五个',
      )
      assert.equal(schema.properties.action.enum.includes('export'), false)
      // ② export 的入参 `dir` 一并消失（留着它等于暗示"还能指定落点"）
      assert.equal('dir' in schema.properties, false, 'dir 入参必须随 export 一起删除')

      const description = String(tool.description)
      assert.match(description, /软删/, '描述必须说明 delete 默认是软删')
      assert.match(description, /permanent: true/, '描述必须说明永久删的开关')
      assert.match(description, /restore/, '描述必须提到可恢复')
      // ③ 描述里不得再出现 exports/、exportDir，也不得宣称 Agent 能导出/写入其它落点
      assert.equal(/exports\//.test(description), false, '描述不得宣称数据目录里的 exports/')
      assert.equal(/exportDir/.test(description), false, '描述不得出现配置项 exportDir')
      assert.equal(
        description.includes('export'),
        false,
        '描述里不得再出现 export（含 action=export 与任何"把文件写到某处"的说法）',
      )
      assert.equal(description.includes('pixmart-out'), true, '描述必须给出会话暂存目录的位置')
    } finally {
      // 这里只读 schema，没写过任何东西；仍清掉临时目录。
      const dir = runtime.dataDir
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
