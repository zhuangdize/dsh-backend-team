import { describe, expect, it, vi } from 'vitest'
import { installImagePicker } from '../src/attachment-picker.js'

function fakeReact() {
  return {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
    useState: <T>(initial: T | (() => T)) => [typeof initial === 'function' ? (initial as () => T)() : initial, vi.fn()] as const,
    useEffect: vi.fn(),
  }
}

describe('image picker', () => {
  it('uses the official conversation attachment service and input action', () => {
    let render: ((props: unknown) => unknown) | undefined
    const images = [{ id: 'img-1' }]
    const createDraftImages = vi.fn(() => images)
    const releaseDraftImages = vi.fn()
    const addImages = vi.fn(() => true)
    const context = {
      conversationEvents: { register: vi.fn(() => vi.fn()) },
      get: vi.fn(() => ({ createDraftImages, releaseDraftImages })),
      slots: {
        inject: vi.fn((_name: string, factory: () => unknown) => { factory(); return vi.fn() }),
        register: vi.fn((_definition: unknown, view: (props: unknown) => unknown) => { render = view; return vi.fn() }),
      },
    }

    installImagePicker(context, fakeReact())
    const tree = render!({ inputActions: { addImages } }) as { children: Array<{ props: Record<string, unknown> }> }
    const input = tree.children[1]!
    const file = { type: 'image/png', name: 'diagram.png' } as File
    ;(input.props.onChange as (event: unknown) => void)({ currentTarget: { files: [file], value: 'selected' } })

    expect(createDraftImages).toHaveBeenCalledWith([file])
    expect(addImages).toHaveBeenCalledWith(['img-1'])
    expect(releaseDraftImages).not.toHaveBeenCalled()
  })

  it('releases attachments when the session input rejects them', () => {
    let render: ((props: unknown) => unknown) | undefined
    const images = [{ id: 'img-1' }]
    const releaseDraftImages = vi.fn()
    const context = {
      conversationEvents: { register: vi.fn(() => vi.fn()) },
      get: () => ({ createDraftImages: () => images, releaseDraftImages }),
      slots: { inject: (_name: string, factory: () => unknown) => { factory(); return vi.fn() }, register: (_definition: unknown, view: (props: unknown) => unknown) => { render = view; return vi.fn() } },
    }
    installImagePicker(context, fakeReact())
    const tree = render!({ inputActions: { addImages: () => false } }) as { children: Array<{ props: Record<string, unknown> }> }
    ;(tree.children[1]!.props.onChange as (event: unknown) => void)({ currentTarget: { files: [{}], value: 'selected' } })
    expect(releaseDraftImages).toHaveBeenCalledWith(images)
  })
})
