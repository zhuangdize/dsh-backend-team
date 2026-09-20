/// <reference lib="dom" />
/** rc.6 exposes open/close only. Adapt its existing grid while our details seat
 * is mounted; do not replace the shell or reach into private store state. */
export function resourceWidth(viewport: number, sidebar: number, preference?: number): number {
  const available = viewport - sidebar
  return Math.max(0, Math.min(preference ?? Math.min(600, Math.round(viewport * 0.36)), Math.max(280, available - 440)))
}
export function attachResourceLayout(panel: HTMLElement): () => void {
  let frame = panel.parentElement
  while (frame && !frame.style.gridTemplateColumns) frame = frame.parentElement
  if (!frame) return () => {}
  const root = frame
  let preferred: number | undefined
  let dragging = false
  const sync = () => {
    const sidebar = Number.parseFloat(root.style.gridTemplateColumns) || 0
    const width = resourceWidth(root.clientWidth, sidebar, preferred)
    root.style.setProperty('--bt-resource-sidebar', `${sidebar}px`)
    root.style.setProperty('--bt-resource-columns', `${sidebar}px minmax(0, 1fr) ${width}px`)
    root.style.setProperty('--bt-resource-width', `${width}px`)
  }
  root.dataset.btResources = ''
  sync()
  // Avoid self-triggering: observe the host's column value, not our variables.
  let hostColumns = root.style.gridTemplateColumns
  const mutations = new MutationObserver(() => { if (root.style.gridTemplateColumns !== hostColumns) { hostColumns = root.style.gridTemplateColumns; sync() } })
  mutations.observe(root, { attributes: true, attributeFilter: ['style'] })
  const resize = new ResizeObserver(sync); resize.observe(root)
  const handle = root.querySelector<HTMLElement>('[data-side="details"]')
  const move = (event: PointerEvent) => { if (!dragging) return; preferred = Math.max(320, Math.min(720, root.getBoundingClientRect().right - event.clientX)); sync() }
  const stop = () => { dragging = false; root.removeAttribute('data-bt-resizing'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
  const start = (event: PointerEvent) => { event.preventDefault(); event.stopImmediatePropagation(); dragging = true; root.dataset.btResizing = ''; window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop) }
  handle?.addEventListener('pointerdown', start, true)
  return () => { stop(); resize.disconnect(); mutations.disconnect(); handle?.removeEventListener('pointerdown', start, true); delete root.dataset.btResources; root.style.removeProperty('--bt-resource-columns'); root.style.removeProperty('--bt-resource-width'); root.style.removeProperty('--bt-resource-sidebar') }
}
