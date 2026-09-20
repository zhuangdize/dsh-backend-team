/** Native wait capabilities stay outside all model-authored UI descriptions. */
export interface TeamQuestion {
  id: string
  question: string
  header?: string
  detail?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}
export interface ReviewWait {
  kind: string
  key: string
  sessionId: string
  payload: { questions: TeamQuestion[] }
  respond(result: unknown): Promise<{ accepted: boolean; reason?: string }>
}
export interface ReviewEntry {
  wait: ReviewWait
  comment: string
  status: 'pending' | 'sending' | 'submitted' | 'expired'
  outcome?: 'feedback' | 'decision'
  error: string
  inspectedHash?: string
}
export function createReviewSessionStore() {
  const entries = new Map<string, ReviewEntry>()
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    get(sessionId: string) { return entries.get(sessionId) },
    attach(wait: ReviewWait) {
      const previous = entries.get(wait.sessionId)
      if (previous?.wait.key === wait.key) { previous.wait = wait; if (previous.status === 'expired') { previous.status = 'pending'; notify() }; return }
      entries.set(wait.sessionId, { wait, comment: '', status: 'pending', error: '' }); notify()
    },
    detach(wait: ReviewWait) {
      const entry = entries.get(wait.sessionId)
      if (entry?.wait.key === wait.key && entry.status === 'pending') { entry.status = 'expired'; notify() }
    },
    comment(sessionId: string, value: string) {
      const entry = entries.get(sessionId)
      if (entry?.status === 'pending') { entry.comment = value.slice(0, 8000); notify() }
    },
    inspected(sessionId: string, waitKey: string, hash: string) {
      const entry = entries.get(sessionId)
      if (entry?.wait.key === waitKey && entry.inspectedHash !== hash) { entry.inspectedHash = hash; notify() }
    },
    clearInspection(sessionId: string, waitKey: string) {
      const entry = entries.get(sessionId)
      if (entry?.wait.key === waitKey && entry.inspectedHash) { delete entry.inspectedHash; notify() }
    },
    async submit(sessionId: string, mode: 'approve' | 'feedback') {
      const entry = entries.get(sessionId)
      if (!entry || entry.status !== 'pending') return
      if (!entry.inspectedHash) throw new Error('请先加载并查看当前方案。')
      const comment = entry.comment.trim()
      if (mode === 'feedback' && !comment) throw new Error('请填写修改意见。')
      if (mode === 'approve' && comment) throw new Error('请先提交修改意见，修订后再确认。')
      entry.status = 'sending'; entry.error = ''; notify()
      try {
        const receipt = await entry.wait.respond({ ok: true, value: { sessionId, answer: { answers: [{ id: entry.wait.payload.questions[0]!.id, selected: mode === 'approve' ? ['确认通过'] : [], ...(mode === 'feedback' ? { custom: comment } : {}) }] } } })
        if (!receipt.accepted) throw new Error('此确认已失效，请查看最新方案。')
        entry.status = 'submitted'; entry.outcome = mode === 'feedback' ? 'feedback' : 'decision'
      } catch (cause) {
        entry.status = 'pending'; entry.error = cause instanceof Error ? cause.message : '提交失败，请重试。'
      }
      notify()
    },
    dispose() { entries.clear(); listeners.clear() },
  }
}
export type ReviewSessionStore = ReturnType<typeof createReviewSessionStore>
