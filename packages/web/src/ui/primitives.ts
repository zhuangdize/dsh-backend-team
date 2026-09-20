// shadcn/ui local components (MIT): Button/Textarea/Badge and Radix-backed Tabs.
// Host React stays external; scoped classes replace globally layered utilities.
import { cva } from 'class-variance-authority'
import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import type { BackendTeamReactLike } from '../client-overlay.js'
const twMerge = extendTailwindMerge({ prefix: 'bt' })
export const cn = (...values: ClassValue[]) => twMerge(clsx(values))
const buttonVariants = cva('bt-button', {
  variants: { variant: { default: 'bt-button-primary', outline: 'bt-button-outline', ghost: 'bt-button-ghost' }, size: { default: 'bt-button-default', sm: 'bt-button-sm', icon: 'bt-button-icon' } },
  defaultVariants: { variant: 'default', size: 'default' },
})
export function createShadcnComponents(react: BackendTeamReactLike) {
  const h = react.createElement
  return {
    Button: ({ children, variant = 'outline', size = 'default', className, ...props }: Record<string, unknown>) => h('button', { type: 'button', ...props, className: cn(buttonVariants({ variant: variant as 'outline' | 'default' | 'ghost', size: size as 'default' | 'sm' | 'icon' }), className as string) }, children),
    Textarea: ({ className, ...props }: Record<string, unknown>) => h('textarea', { ...props, className: cn('bt-textarea', className as string) }),
    Badge: ({ children, tone = 'neutral' }: Record<string, unknown>) => h('span', { className: 'bt-badge', 'data-tone': tone }, children),
    Tabs: ({ value, onValueChange, children, scrollKey, offsets }: { value: string; onValueChange: (value: string) => void; children: unknown; scrollKey: string; offsets: Map<string, number> }) => h(TabsPrimitive.Root, { value, onValueChange, className: 'bt-tabs' }, h(TabsPrimitive.List, { className: 'bt-tabs-list', 'aria-label': '文档视图' }, h(TabsPrimitive.Trigger, { value: 'changes', className: 'bt-tabs-trigger' }, '本次变化'), h(TabsPrimitive.Trigger, { value: 'document', className: 'bt-tabs-trigger' }, '完整文档')), h(TabsPrimitive.Content, { value, className: 'bt-tabs-content', ref: (element: HTMLElement | null) => { if (element) element.scrollTop = offsets.get(scrollKey) ?? 0 }, onScroll: (event: { currentTarget: HTMLElement }) => offsets.set(scrollKey, event.currentTarget.scrollTop) }, children)),
  }
}
