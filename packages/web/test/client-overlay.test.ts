import { describe, expect, it, vi } from 'vitest'
import { createBackendTeamFetchTransport, createBackendTeamOverlayComponent, formatBackendTeamOverlayDiagnostic, isBackendTeamClarificationAvailable, renderBackendTeamDiagnosticFallback } from '../src/client-overlay.js'
import { createBackendTeamPanelModel } from '../src/panel-model.js'

describe('backend team browser overlay', () => {
  it('blocks repeated operations immediately, shows progress, and restores controls after failure', async () => {
    const state = {
      schemaVersion: 1 as const, workspaceId: 'ws', workspaceName: 'demo', phase: 'DISCOVER' as const, compatibility: { mode: 'supported' as const },
      experts: [], risk: { level: 'normal' as const, messages: [] }, database: { runtime: 'stopped' as const, engine: 'PostgreSQL', guiAvailable: false, controlsAvailable: true },
      verification: { total: 0, passed: 0, failed: 0, blocked: 0 }, usage: { activeExperts: 0, activeWorkers: 0, concurrentWriters: 0, remainingTaskBudget: 1 }, lastSequence: 0, stateRevision: 0,
    }
    const model = createBackendTeamPanelModel(state)
    let rejectOperation!: (reason: Error) => void
    const dispatch = vi.fn(() => new Promise((_resolve, reject) => { rejectOperation = reject }))
    const client = { snapshot: () => state, model: () => model, dispatch }
    const states: unknown[] = [client, model, false]
    let hookIndex = 0
    const react = {
      createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
      useEffect: () => undefined,
      useState: <T>(initial: T | (() => T)) => {
        const index = hookIndex++
        if (!(index in states)) states[index] = typeof initial === 'function' ? (initial as () => T)() : initial
        return [states[index] as T, (next: T | ((previous: T) => T)) => { states[index] = typeof next === 'function' ? (next as (previous: T) => T)(states[index] as T) : next }] as const
      },
    }
    const component = createBackendTeamOverlayComponent(react, { workspaceId: 'ws' })
    const render = () => { hookIndex = 0; return component({}) as ElementLike }
    const button = findElement(render(), 'button', '启动数据库')!
    const click = (button.props as { onClick: () => Promise<void> }).onClick
    const first = click()
    await click()
    expect(dispatch).toHaveBeenCalledTimes(1)
    const pending = render()
    expect(findElement(pending, 'button', '启动数据库')?.props).toMatchObject({ disabled: true })
    expect(findElement(pending, 'p', '正在处理，请稍候…')).toBeDefined()
    rejectOperation(new Error('数据库启动失败'))
    await first
    const failed = render()
    expect(findElement(failed, 'button', '启动数据库')?.props).toMatchObject({ disabled: false })
    expect(findElement(failed, 'p', '操作未完成：数据库启动失败')).toBeDefined()
  })
  it('formats a bounded read-only diagnostic without exposing paths', () => {
    expect(formatBackendTeamOverlayDiagnostic({
      mode: 'read-only',
      reason: 'production-agent-runtime-not-wired-in-diagnostic-bundle',
      missing: ['agents', 'session-auth'],
    })).toBe('当前为只读诊断模式。缺少能力：agents、session-auth。原因：production-agent-runtime-not-wired-in-diagnostic-bundle。')
  })

  it('limits diagnostic entries and rejects unsupported modes', () => {
    expect(() => formatBackendTeamOverlayDiagnostic({ mode: 'supported', reason: 'nope' } as never)).toThrow(/read-only/iu)
    const diagnostic = { mode: 'read-only' as const, reason: '/Users/private/project', missing: Array.from({ length: 20 }, (_, index) => `cap-${index}`) }
    const formatted = formatBackendTeamOverlayDiagnostic(diagnostic)
    expect(formatted).not.toContain('/Users/private/project')
    expect(formatted.match(/cap-/gu)).toHaveLength(8)
  })

  it('renders a status-only fallback without an action callback', () => {
    const elements: unknown[] = []
    const react = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => { const element = { type, props, children }; elements.push(element); return element }, useEffect: () => undefined, useState: <T>(initial: T | (() => T)) => [typeof initial === 'function' ? (initial as () => T)() : initial, () => undefined] as const }
    const rendered = renderBackendTeamDiagnosticFallback(react, { mode: 'read-only', reason: 'host seam is unavailable', missing: ['session-auth'] }) as { props?: Record<string, unknown>; children?: unknown[] }
    expect(rendered.props).toMatchObject({ role: 'status', 'aria-live': 'polite' })
    expect(rendered.props).not.toHaveProperty('onClick')
    expect(rendered.children?.join('')).toContain('当前为只读诊断模式')
    expect(elements.some((element) => (element as { type?: unknown }).type === 'button')).toBe(false)
  })

  it('uses same-origin no-store requests and an explicit JSON dispatch body', async () => {
    const calls: Array<{ input: string; init: unknown }> = []
    const transport = createBackendTeamFetchTransport(async (input, init) => {
      calls.push({ input, init })
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }, '/plugins/backend-team/control')

    await transport.getState()
    await transport.dispatch({ type: 'start-database', workspaceId: '/tmp/project', expectedRevision: 0 })

    expect(calls).toEqual([
      { input: '/plugins/backend-team/control/state', init: { credentials: 'same-origin', cache: 'no-store' } },
      {
        input: '/plugins/backend-team/control/dispatch',
        init: {
          credentials: 'same-origin',
          cache: 'no-store',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'start-database', workspaceId: '/tmp/project', expectedRevision: 0 }),
        },
      },
    ])
  })

  it('attaches only a validated current session id to same-origin control requests', async () => {
    const calls: string[] = []
    const transport = createBackendTeamFetchTransport(async (input) => {
      calls.push(input)
      return { ok: true, status: 200, json: async () => ({}) }
    }, '/plugins/backend-team/control', 'session-1234567890')

    await transport.getState()
    expect(calls).toEqual(['/plugins/backend-team/control/state?sessionId=session-1234567890'])
    expect(() => createBackendTeamFetchTransport(async () => ({ ok: true, status: 200, json: async () => ({}) }), '/plugins/backend-team/control', 'short')).toThrow(/session id/iu)
  })

  it('reads the current session through the Harness selector hook', async () => {
    const calls: string[] = []
    const cleanups: Array<() => void> = []
    const react = {
      createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
      useEffect: (effect: () => void | (() => void)) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup) },
      useState: <T>(initial: T | (() => T)) => [typeof initial === 'function' ? (initial as () => T)() : initial, () => undefined] as const,
    }
    const component = createBackendTeamOverlayComponent(react, {
      fetch: async (input) => { calls.push(input); return { ok: false, status: 401, json: async () => ({}) } },
    })

    component({ useSessions: (selector: (state: unknown) => unknown) => selector({ current: 'session-1234567890' }) })
    await Promise.resolve()
    expect(calls).toEqual(['/plugins/backend-team/control/state?sessionId=session-1234567890'])
    cleanups.forEach((cleanup) => cleanup())
  })

  it('rejects unsafe paths and invalid refresh intervals before registration', () => {
    const react = {
      createElement: () => null,
      useEffect: () => undefined,
      useState: <T>(initial: T | (() => T)) => {
        const value = typeof initial === 'function' ? (initial as () => T)() : initial
        return [value, () => undefined] as const
      },
    }
    expect(() => createBackendTeamFetchTransport(async () => ({ ok: true, status: 200, json: async () => ({}) }), 'http://remote')).toThrow(/absolute path/iu)
    expect(() => createBackendTeamOverlayComponent(react, { refreshIntervalMs: 100 })).toThrow(/refresh interval/iu)
  })

  it('requires the minimal Harness-provided React module shape', () => {
    expect(() => createBackendTeamOverlayComponent({} as never)).toThrow(/React module/iu)
  })

  it('allows clarification only in supported idle discovery phases', () => {
    const base = createBackendTeamPanelModel({
      schemaVersion: 1, workspaceName: 'demo', phase: 'DISCOVER', compatibility: { mode: 'supported' },
      experts: [], risk: { level: 'normal', messages: [] }, database: { runtime: 'not-installed', engine: 'PostgreSQL', guiAvailable: false },
      verification: { total: 0, passed: 0, failed: 0, blocked: 0 }, usage: { activeExperts: 0, activeWorkers: 0, concurrentWriters: 0, remainingTaskBudget: 1 }, lastSequence: 0, stateRevision: 0,
    })
    expect(isBackendTeamClarificationAvailable(base)).toBe(true)
    expect(isBackendTeamClarificationAvailable({ ...base, phase: { ...base.phase, value: 'DESIGN' } })).toBe(false)
    expect(isBackendTeamClarificationAvailable({ ...base, diagnostics: { ...base.diagnostics, compatibility: { mode: 'read-only' } } })).toBe(false)
    expect(isBackendTeamClarificationAvailable({ ...base, usage: { ...base.usage, activeWorkers: 1 } })).toBe(false)
    expect(isBackendTeamClarificationAvailable({ ...base, approval: { required: true, id: 'approval-1', kind: 'requirements', summary: 'review', artifactHash: 'a'.repeat(64), viewed: false, canConfirm: false, viewAction: { type: 'open-artifact', label: '查看方案', enabled: true, artifactId: 'a'.repeat(64) }, confirmAction: { type: 'decide-approval', label: '确认并继续', enabled: false, approvalId: 'approval-1', artifactHash: 'a'.repeat(64), expectedRevision: 0 } } })).toBe(false)
  })

  it('submits trimmed clarification text through the authenticated control client', async () => {
    const calls: unknown[] = []
    const state = {
      schemaVersion: 1 as const, workspaceName: 'demo', phase: 'DISCOVER' as const, compatibility: { mode: 'supported' as const },
      experts: [], risk: { level: 'normal' as const, messages: [] }, database: { runtime: 'not-installed' as const, engine: 'PostgreSQL', guiAvailable: false },
      verification: { total: 0, passed: 0, failed: 0, blocked: 0 }, usage: { activeExperts: 0, activeWorkers: 0, concurrentWriters: 0, remainingTaskBudget: 1 }, lastSequence: 0, stateRevision: 0,
    }
    const model = createBackendTeamPanelModel(state)
    const client = {
      snapshot: () => ({ ...state, workspaceId: 'ws' }),
      model: () => model,
      dispatch: async (action: unknown) => { calls.push(action); return { response: { accepted: true, stateRevision: 0 }, state: { ...state, workspaceId: 'ws' } } },
    }
    const states: unknown[] = [client, model, false, undefined, undefined, '']
    let hookIndex = 0
    const react = {
      createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
      useEffect: () => undefined,
      useState: <T>(initial: T | (() => T)) => {
        const index = hookIndex++
        if (states[index] === undefined && index !== 3 && index !== 4) states[index] = typeof initial === 'function' ? (initial as () => T)() : initial
        return [states[index] as T, (next: T | ((previous: T) => T)) => { states[index] = typeof next === 'function' ? (next as (previous: T) => T)(states[index] as T) : next }] as const
      },
    }
    const component = createBackendTeamOverlayComponent(react, { workspaceId: 'ws' })
    const render = () => { hookIndex = 0; return component({}) as ElementLike }
    const first = render()
    const textarea = findElement(first, 'textarea')
    const submit = findElement(first, 'button', '提交补充说明')
    expect(textarea).toBeDefined()
    expect(submit).toBeDefined()
    const change = (textarea?.props as { onChange?: (event: unknown) => void }).onChange
    change?.({ target: { value: '  add pagination  ' } })
    const rerendered = render()
    const updatedSubmit = findElement(rerendered, 'button', '提交补充说明')
    const click = (updatedSubmit?.props as { onClick?: () => Promise<void> }).onClick
    await click?.()
    expect(calls).toEqual([{ type: 'submit-clarification', workspaceId: 'ws', expectedRevision: 0, text: 'add pagination' }])
  })

  it('renders only a hash-matched artifact preview after opening the artifact', async () => {
    const artifactHash = 'a'.repeat(64)
    const state = {
      schemaVersion: 1 as const, workspaceName: 'demo', phase: 'AWAIT_REQUIREMENTS_APPROVAL' as const, compatibility: { mode: 'supported' as const },
      pendingApproval: { id: 'approval-1', kind: 'requirements' as const, summary: '确认需求', artifactHash },
      experts: [], risk: { level: 'normal' as const, messages: [] }, database: { runtime: 'not-installed' as const, engine: 'PostgreSQL', guiAvailable: false },
      verification: { total: 0, passed: 0, failed: 0, blocked: 0 }, usage: { activeExperts: 0, activeWorkers: 0, concurrentWriters: 0, remainingTaskBudget: 1 }, lastSequence: 0, stateRevision: 0,
    }
    const model = createBackendTeamPanelModel(state)
    let inspected = 0
    const client = {
      snapshot: () => ({ ...state, workspaceId: 'ws' }),
      model: () => model,
      inspectApproval: () => { inspected += 1; return model.approval! },
      dispatch: async () => ({ response: { accepted: true, stateRevision: 0, artifactPreview: { artifactHash, files: [{ path: 'spec.md', content: '<safe-as-text>' }] } }, state: { ...state, workspaceId: 'ws' } }),
    }
    const states: unknown[] = [client, model, false, undefined, undefined, '', undefined]
    let hookIndex = 0
    const react = {
      createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
      useEffect: () => undefined,
      useState: <T>(initial: T | (() => T)) => {
        const index = hookIndex++
        if (states[index] === undefined) states[index] = typeof initial === 'function' ? (initial as () => T)() : initial
        return [states[index] as T, (next: T | ((previous: T) => T)) => { states[index] = typeof next === 'function' ? (next as (previous: T) => T)(states[index] as T) : next }] as const
      },
    }
    const component = createBackendTeamOverlayComponent(react, { workspaceId: 'ws' })
    const render = () => { hookIndex = 0; return component({}) as ElementLike }
    const view = findElement(render(), 'button', '查看方案')
    await (view?.props as { onClick?: () => Promise<void> }).onClick?.()
    const preview = findElement(render(), 'pre')
    expect(preview?.children).toEqual(['<safe-as-text>'])
    expect(inspected).toBe(0)
  })


  it('retries initial authentication failures, stops after connecting, and cancels on unmount', async () => {
    vi.useFakeTimers()
    const cleanups: Array<() => void> = []
    try {
      const state = {
        schemaVersion: 1, workspaceId: 'ws', workspaceName: 'demo', phase: 'DISCOVER', compatibility: { mode: 'supported' },
        experts: [], risk: { level: 'normal', messages: [] }, database: { runtime: 'not-installed', engine: 'PostgreSQL', guiAvailable: false },
        verification: { total: 0, passed: 0, failed: 0, blocked: 0 }, usage: { activeExperts: 0, activeWorkers: 0, concurrentWriters: 0, remainingTaskBudget: 1 }, lastSequence: 0, stateRevision: 0,
      }
      const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) }).mockResolvedValue({ ok: true, status: 200, json: async () => state })
      const updates: unknown[] = []
      const react = {
        createElement: () => null,
        useEffect: (effect: () => void | (() => void)) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup) },
        useState: <T>(initial: T | (() => T)) => [typeof initial === 'function' ? (initial as () => T)() : initial, (next: unknown) => { updates.push(next) }] as const,
      }
      const component = createBackendTeamOverlayComponent(react, { fetch: fetcher, refreshIntervalMs: 1000 })
      component({})
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(updates.some((value) => value !== null && typeof value === 'object' && 'refresh' in value)).toBe(true)
      await vi.advanceTimersByTimeAsync(3000)
      expect(fetcher).toHaveBeenCalledTimes(2)
      cleanups.splice(0).forEach((cleanup) => cleanup())
      fetcher.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) })
      component({})
      await vi.advanceTimersByTimeAsync(0)
      cleanups.splice(0).forEach((cleanup) => cleanup())
      await vi.advanceTimersByTimeAsync(3000)
      expect(fetcher).toHaveBeenCalledTimes(3)
    } finally { cleanups.forEach((cleanup) => cleanup()); vi.useRealTimers() }
  })

  it('preserves a failed action message across successful background refreshes', async () => {
    vi.useFakeTimers()
    let cleanup: (() => void) | void = undefined
    try {
      const client = { refresh: async () => undefined, model: () => undefined, snapshot: () => ({ workspaceId: 'ws' }) }
      const states: unknown[] = [client, undefined, false, '操作未完成：执行超时', undefined, '', false, undefined, undefined]
      const effects: Array<() => void | (() => void)> = []
      let index = 0
      const react = {
        createElement: () => null,
        useEffect: (effect: () => void | (() => void)) => { effects.push(effect) },
        useState: <T>(_initial: T | (() => T)) => {
          void _initial
          const current = index++
          return [states[current] as T, (next: T | ((previous: T) => T)) => { states[current] = typeof next === 'function' ? (next as (previous: T) => T)(states[current] as T) : next }] as const
        },
      }
      createBackendTeamOverlayComponent(react, { workspaceId: 'ws', refreshIntervalMs: 1000 })({})
      cleanup = effects[2]!()
      await vi.advanceTimersByTimeAsync(1100)
      expect(states[3]).toBe('操作未完成：执行超时')
    } finally { cleanup?.(); vi.useRealTimers() }
  })
})

interface ElementLike { type?: unknown; props?: unknown; children?: unknown[] }

function findElement(root: unknown, type: string, text?: string): ElementLike | undefined {
  if (root === null || typeof root !== 'object') return undefined
  const element = root as ElementLike
  if (element.type === type && (text === undefined || element.children?.join('') === text)) return element
  for (const child of element.children ?? []) {
    const found = findElement(child, type, text)
    if (found !== undefined) return found
  }
  return undefined
}
