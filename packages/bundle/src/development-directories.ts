import { lstat, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { DevelopmentPlan } from '@dsh-backend-team/development'

/** Read-only checks run during planning, where the planner can still repair tasks.md. */
export async function validateDevelopmentPaths(root: string, plan: DevelopmentPlan, writeRoots: readonly string[]): Promise<void> {
  if (await realpath(root) !== root) throw new Error('开发工作区路径不安全。')
  const paths = [...new Set(plan.slices.flatMap(slice => slice.expectedPaths))]
  for (const file of paths) {
    const parts = file.split('/')
    if (!writeRoots.includes(parts[0]!) || parts.length < 2 || parts.some(part => !part || part.startsWith('.') || /[\\:\u0000-\u001f\u007f]/u.test(part))) throw new Error(`计划输出 ${file} 不在配置的写入目录内（允许：${writeRoots.join('、')}）。请在聊天中修正任务计划；如需改变已批准设计，请先修改需求并重新确认。尚未开始开发。`)
    if (paths.some(other => other.startsWith(file + '/'))) throw new Error(`计划输出 ${file} 同时被当作文件和目录，请修正任务计划。`)
  }
  for (const file of paths) {
    const parts = file.split('/')
    let path = root
    for (let index = 0; index < parts.length; index++) {
      path = join(path, parts[index]!)
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
      if (info === undefined) break
      if (info.isSymbolicLink() || await realpath(path) !== path) throw new Error(`开发输出目录不安全：${file} 包含符号链接。请选用工作区内的实际路径。`)
      if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) throw new Error(`开发输出路径冲突：${file} 的现有文件类型不符合计划。请修正任务路径，不要删除已有内容。`)
    }
  }
}

/** Prepare only parents of declared outputs after the whole plan passes read-only checks. */
export async function prepareDevelopmentDirectories(root: string, plan: DevelopmentPlan, writeRoots: readonly string[]) {
  await validateDevelopmentPaths(root, plan, writeRoots)
  const paths = [...new Set(plan.slices.flatMap(slice => slice.expectedPaths))]
  for (const file of paths) {
    const parts = file.split('/')
    let directory = root
    for (const part of parts.slice(0, -1)) {
      directory = join(directory, part)
      await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error('开发输出目录不安全。')
    }
  }
}
