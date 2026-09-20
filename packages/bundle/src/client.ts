/**
 * Browser entry for the Bundle. The host supplies the actual DeepSeek Harness
 * ClientContext and the module loader supplies its singleton React module.
 * Keeping React behind this small adapter prevents the Bundle from shipping a
 * second UI runtime while allowing the shared Web package to stay Node-testable.
 */
import { installTeamReview } from '../../web/src/task-review-card.js'
import { createReviewSessionStore } from '../../web/src/review-session.js'
import { installTeamQuestions } from '../../web/src/team-question-card.js'
import { installTeamProgress } from '../../web/src/team-progress-card.js'
import { installTaskResources } from '../../web/src/task-resource-panel.js'
import { installImagePicker } from '../../web/src/attachment-picker.js'
import { apply as applyWeb, backendTeamConversationDefinition, inject as webInject } from '../../web/src/client.js'
import { createBackendTeamOverlayClient } from '../../web/src/client-overlay.js'
import type { ClientContext } from '../../web/src/client.js'
import type { BackendTeamOverlayProps } from '../../web/src/client-overlay.js'

export { backendTeamConversationDefinition }
export const inject = [...webInject, 'layout'] as const

const backendTeamReadOnlyDiagnostic = Object.freeze({
  mode: 'read-only',
  reason: 'production-agent-runtime-not-wired-in-diagnostic-bundle',
  missing: Object.freeze(['production-agent-runtime', 'host-session-authentication', 'coordinator-handlers']),
})

export function apply(context: ClientContext): () => void {
  const react = requireReact()
  const load = require as unknown as (id: string) => { MarkdownText: unknown }
  const reviews = createReviewSessionStore()
  const resources = installTaskResources(context, react, load('@deepseek-ai/dsh-client-ui-primitives').MarkdownText, reviews)
  const disposeImages = installImagePicker(context, react)
  const overlay = createBackendTeamOverlayClient(react, { diagnostic: backendTeamReadOnlyDiagnostic, openResources: resources.open })
  const disposeWeb = applyWeb(context, (props: unknown) => overlay(resolveOverlayProps(props, context)))
  const disposeReview = installTeamReview(context, react, resources.open, reviews)
  const disposeQuestions = installTeamQuestions(context, react)
  const disposeProgress = installTeamProgress(context, react, resources.open)
  return () => { disposeProgress(); disposeQuestions(); disposeReview(); disposeImages(); resources.dispose(); reviews.dispose(); disposeWeb() }
}

/** The Harness may attach selector hooks to the slot props or the client
 * context. Preserve that host-owned hook while keeping credentials in the
 * browser runtime; absence of a hook remains a read-only/unauthenticated
 * route attempt and never enables local writes. */
function resolveOverlayProps(props: unknown, context: ClientContext): BackendTeamOverlayProps {
  const candidate = isRecord(props) ? props : undefined
  const contextSessionHook = readFunction(context, 'useSessions')
  const propSessionHook = candidate === undefined ? undefined : readFunction(candidate, 'useSessions')
  const useSessions = propSessionHook ?? contextSessionHook
  return useSessions === undefined ? {} : { useSessions }
}

function readFunction(value: object, key: string): ((...args: never[]) => unknown) | undefined {
  try {
    const candidate = Reflect.get(value, key)
    return typeof candidate === 'function' ? candidate as (...args: never[]) => unknown : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function requireReact(): Parameters<typeof createBackendTeamOverlayClient>[0] {
  const module = (require as unknown as (specifier: string) => unknown)('react')
  if (module === null || typeof module !== 'object') throw new Error('DeepSeek Harness React module is unavailable')
  return module as Parameters<typeof createBackendTeamOverlayClient>[0]
}
