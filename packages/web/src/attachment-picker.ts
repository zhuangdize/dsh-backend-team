import { Image } from './ui/icons.js'
import { createShadcnComponents } from './ui/primitives.js'
import type { BackendTeamReactLike } from './client-overlay.js'
import type { ClientContext } from './client.js'

interface DraftImage {
  readonly id: string
}

interface ConversationAttachments {
  createDraftImages(files: readonly File[]): readonly DraftImage[]
  releaseDraftImages(images: readonly DraftImage[]): void
}

interface InputActions {
  addImages(ids: readonly string[]): boolean
}

/**
 * Adds the missing file-picker affordance to the official DSH composer.
 * Image bytes still stay in ui-conversation's browser-owned attachment store;
 * this surface only calls its public create/add/release methods.
 */
export function installImagePicker(context: ClientContext, react: BackendTeamReactLike): () => void {
  const h = react.createElement
  const ui = createShadcnComponents(react)
  const dispose = context.slots.inject('conversation.input.left', () => context.slots.register({ name: 'conversation.input.left', id: 'backend-team-image-picker', order: 20, label: '添加图片' }, (props: unknown) => {
    const inputActions = readInputActions(props)
    const [error, setError] = react.useState('')
    let inputElement: HTMLInputElement | null = null
    const selectFiles = (event: { readonly currentTarget: { files: FileList | null; value: string } }): void => {
      const files = Array.from(event.currentTarget.files ?? [])
      event.currentTarget.value = ''
      if (files.length === 0 || inputActions === undefined) return
      const conversation = readConversation(context)
      if (conversation === undefined) {
        setError('图片入口暂不可用，请刷新后重试。')
        return
      }
      try {
        const images = conversation.createDraftImages(files)
        if (!inputActions.addImages(images.map(image => image.id))) conversation.releaseDraftImages(images)
        setError('')
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : '图片添加失败，请重试。')
      }
    }
    const openPicker = (): void => { inputElement?.click() }
    return h('span', { className: 'bt-ui bt-attachment-picker' },
      h(ui.Button, { variant: 'ghost', size: 'icon', 'aria-label': '添加图片', title: '添加图片', disabled: inputActions === undefined, onMouseDown: (event: { preventDefault(): void }) => event.preventDefault(), onClick: openPicker }, h(Image, { 'aria-hidden': true })),
      h('input', { ref: (element: HTMLInputElement | null) => { inputElement = element }, type: 'file', accept: 'image/*', multiple: true, tabIndex: -1, 'aria-hidden': true, className: 'bt-attachment-input', onChange: selectFiles }),
      error ? h('span', { role: 'alert', className: 'bt-attachment-error' }, error) : null,
    )
  }))
  return dispose
}

function readInputActions(value: unknown): InputActions | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = Reflect.get(value, 'inputActions')
  return candidate !== null && typeof candidate === 'object' && typeof Reflect.get(candidate, 'addImages') === 'function' ? candidate as InputActions : undefined
}

function readConversation(context: ClientContext): ConversationAttachments | undefined {
  if (typeof context.get !== 'function') return undefined
  try {
    const candidate = context.get('conversation')
    return candidate !== null && typeof candidate === 'object' && typeof Reflect.get(candidate, 'createDraftImages') === 'function' && typeof Reflect.get(candidate, 'releaseDraftImages') === 'function' ? candidate as ConversationAttachments : undefined
  } catch {
    return undefined
  }
}
