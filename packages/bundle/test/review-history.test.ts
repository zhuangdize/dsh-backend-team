import { expect, it } from 'vitest'
import { mkdtemp, rm, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordReviewHistory } from '../src/review-history.js'
it('compares real document versions and keeps a stable baseline on repeated reads', async () => {
 const root = await mkdtemp(join(tmpdir(), 'review-history-'))
 const files = (content: string) => [{ path: 'specs/task-one/plan.md', content, category: '方案文档' }]
 try {
   expect((await recordReviewHistory(root, 'one', files('before'))).available).toBe(false)
   const result = await recordReviewHistory(root, 'one', files('after'))
   expect(result).toMatchObject({ available: true, files: [{ before: 'before', after: 'after' }] })
   expect(await recordReviewHistory(root, 'one', files('after'))).toEqual(result)
   expect((await recordReviewHistory(root, 'two', files('different task'))).available).toBe(false)
 } finally { await rm(root, { recursive: true, force: true }) }
})
it('rejects unsafe history storage and task identifiers', async () => {
 const root = await mkdtemp(join(tmpdir(), 'review-history-'))
 try {
   await mkdir(join(root, '.backend-team'))
   await symlink(tmpdir(), join(root, '.backend-team/review-history'))
   await expect(recordReviewHistory(root, 'one', [{path:'plan.md',content:'x',category:'方案文档'}])).rejects.toThrow('unsafe')
   await expect(recordReviewHistory(root, '../escape', [])).rejects.toThrow('invalid')
 } finally { await rm(root, { recursive: true, force: true }) }
})
