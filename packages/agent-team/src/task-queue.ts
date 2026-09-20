export type TaskPriority = 'blocking' | 'normal'

interface Entry<T> { readonly value: T; readonly priority: TaskPriority }

/** Stable two-priority FIFO queue. A caller must not skip the head within a lane. */
export class TaskQueue<T> {
  private readonly blocking: Entry<T>[] = []
  private readonly normal: Entry<T>[] = []

  enqueue(value: T, priority: TaskPriority): void { (priority === 'blocking' ? this.blocking : this.normal).push({ value, priority }) }
  get size(): number { return this.blocking.length + this.normal.length }
  has(predicate: (value: T) => boolean): boolean {
    return this.blocking.some((entry) => predicate(entry.value)) || this.normal.some((entry) => predicate(entry.value))
  }
  peek(): T | undefined { return this.blocking[0]?.value ?? this.normal[0]?.value }
  peekPriority(): TaskPriority | undefined { return this.blocking.length > 0 ? 'blocking' : this.normal.length > 0 ? 'normal' : undefined }
  takeHead(predicate: (value: T) => boolean): T | undefined {
    const queue = this.blocking.length > 0 ? this.blocking : this.normal
    const head = queue[0]
    if (head === undefined || !predicate(head.value)) return undefined
    return queue.shift()?.value
  }
  take(predicate: (value: T) => boolean): T | undefined {
    return this.takeHead(predicate)
  }
  remove(predicate: (value: T) => boolean): T | undefined {
    for (const queue of [this.blocking, this.normal]) {
      const index = queue.findIndex((entry) => predicate(entry.value))
      if (index >= 0) return queue.splice(index, 1)[0]?.value
    }
    return undefined
  }
}
