export interface VerifiedClientBinding { readonly verifiedProvenance: true; register(surface: { readonly id: string; readonly dispose: () => void }): () => void }
export function applyClient(binding: VerifiedClientBinding, dispose: () => void): () => void {
  if (binding.verifiedProvenance !== true) throw new Error('client binding provenance is not verified')
  let localDisposed = false
  const disposeOnce = () => { if (localDisposed) return; localDisposed = true; dispose() }
  const remove = binding.register({ id: 'backend-team', dispose: disposeOnce })
  let removed = false
  return () => { if (removed) return; removed = true; remove(); disposeOnce() }
}
