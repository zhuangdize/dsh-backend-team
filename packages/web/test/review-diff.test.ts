import { expect, it } from 'vitest'
import { reviewDiff } from '../src/review-diff.js'
it('preserves real changed content and trims shared surrounding lines', () => {
 expect(reviewDiff('标题\n旧内容\n结尾', '标题\n新内容\n结尾')).toEqual({before:'旧内容',after:'新内容',firstLine:2})
 expect(reviewDiff('a\nb','a\n新增\nb').after).toBe('新增')
 expect(reviewDiff('a\nb','a\nb').after).toBe('')
})

it('groups exact section changes without inventing a summary', async () => {
  const { reviewSections } = await import('../src/review-diff.js')
  expect(reviewSections('# 方案\n## 字段\n联系人必填。\n## 删除项\n旧规则', '# 方案\n## 字段\n联系人选填。\n## 验收\n新增测试')).toEqual([
    { title: '字段', before: '联系人必填。', after: '联系人选填。', kind: '调整' },
    { title: '验收', before: '', after: '新增测试', kind: '新增' },
    { title: '删除项', before: '旧规则', after: '', kind: '移除' },
  ])
})
