/** A bounded contiguous changed excerpt, including unchanged context between edits. */
export function reviewDiff(before: string, after: string) {
  const oldLines = before.split('\n'), newLines = after.split('\n')
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++
  let oldEnd = oldLines.length, newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd-- }
  return { before: oldLines.slice(start, oldEnd).join('\n'), after: newLines.slice(start, newEnd).join('\n'), firstLine: start + 1 }
}

/** Present exact Markdown sections, never model-invented change summaries. */
export function reviewSections(before: string, after: string): Array<{ title: string; before: string; after: string; kind: '新增' | '调整' | '移除' }> {
  const sections = (text: string) => {
    const result: Array<{ key: string; title: string; body: string }> = []
    const counts = new Map<string, number>()
    let current = { key: '正文:0', title: '正文', body: '' }
    for (const line of text.split('\n')) {
      const heading = /^#{1,6}\s+(.+)$/u.exec(line)
      if (heading) {
        if (current.body.trim()) result.push(current)
        const title = heading[1]!.trim(); const count = counts.get(title) ?? 0; counts.set(title, count + 1)
        current = { key: title + ':' + count, title, body: '' }
      } else current.body += line + '\n'
    }
    if (current.body.trim()) result.push(current)
    return result
  }
  const old = sections(before), next = sections(after)
  const rows: ReturnType<typeof reviewSections> = []
  for (const item of next) { const previous = old.find(row => row.key === item.key); if (previous?.body.trim() !== item.body.trim()) rows.push({ title: item.title, before: previous?.body.trim() ?? '', after: item.body.trim(), kind: previous ? '调整' : '新增' }) }
  for (const item of old) if (!next.some(row => row.key === item.key)) rows.push({ title: item.title, before: item.body.trim(), after: '', kind: '移除' })
  // Heading-only changes still need visible evidence, even without body sections.
  if (!rows.length && before !== after) rows.push({ title: '文档内容', before, after, kind: '调整' })
  return rows
}
