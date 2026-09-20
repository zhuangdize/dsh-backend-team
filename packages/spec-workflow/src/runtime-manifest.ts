export interface RuntimeArtifact { readonly component: string; readonly version: string; readonly license: string; readonly source: string; readonly url: string; readonly bytes: number; readonly sha256: string; readonly allowedHosts: readonly string[]; readonly destination: string }
export type UvArtifact = RuntimeArtifact
export interface UvManifest { readonly component: 'uv'; readonly version: string; readonly license: string; readonly source: string; readonly artifacts: Readonly<{ 'darwin-arm64': UvArtifact; 'darwin-x64': UvArtifact }> }
export interface SpecKitManifest { readonly component: 'specify-cli'; readonly version: string; readonly source: string; readonly license: string; readonly python: string; readonly executable: string; readonly expectedVersion: string; readonly artifacts: Readonly<{ common: readonly RuntimeArtifact[]; 'darwin-arm64': readonly RuntimeArtifact[]; 'darwin-x64': readonly RuntimeArtifact[] }> }
export interface RuntimeManifest { readonly uv: UvManifest; readonly specKit: SpecKitManifest }

export function parseUvManifest(value: unknown): UvManifest {
  if (!isRecord(value) || !exactKeys(value, ['artifacts', 'component', 'license', 'source', 'version']) || value.component !== 'uv' || value.version !== '0.12.3' || value.license !== 'Apache-2.0 OR MIT' || value.source !== 'https://github.com/astral-sh/uv/releases/tag/0.12.3' || !isRecord(value.artifacts) || !exactKeys(value.artifacts, ['darwin-arm64', 'darwin-x64'])) throw new Error('invalid uv runtime manifest')
  const arm64 = parseArtifact(value.artifacts['darwin-arm64'])
  const x64 = parseArtifact(value.artifacts['darwin-x64'])
  assertExactArtifact(arm64, EXPECTED_UV_ARM64)
  assertExactArtifact(x64, EXPECTED_UV_X64)
  return Object.freeze({ component: 'uv', version: value.version, license: value.license, source: value.source, artifacts: Object.freeze({ 'darwin-arm64': arm64, 'darwin-x64': x64 }) })
}

export function parseSpecKitManifest(value: unknown): SpecKitManifest {
  if (!isRecord(value) || !exactKeys(value, ['artifacts', 'component', 'executable', 'expectedVersion', 'license', 'python', 'source', 'version']) || value.component !== 'specify-cli' || value.version !== '0.16.5' || value.source !== 'https://github.com/github/spec-kit/tree/v0.16.5' || value.license !== 'MIT' || value.python !== '3.13.15' || value.executable !== 'specify' || value.expectedVersion !== '0.16.5' || !isRecord(value.artifacts) || !exactKeys(value.artifacts, ['common', 'darwin-arm64', 'darwin-x64'])) throw new Error('invalid spec-kit runtime manifest')
  const common = parseArtifacts(value.artifacts.common); const arm64 = parseArtifacts(value.artifacts['darwin-arm64']); const x64 = parseArtifacts(value.artifacts['darwin-x64'])
  if (common.length === 0 || arm64.length === 0 || x64.length === 0) throw new Error('spec-kit runtime manifest must include the complete artifact closure')
  for (const artifact of [...common, ...arm64, ...x64]) if (artifact.component !== 'specify-cli' && artifact.component !== 'python' && artifact.component !== 'python-dependency') throw new Error('invalid spec-kit artifact component')
  assertSpecKitClosure(common, arm64, x64)
  return Object.freeze({ component: 'specify-cli', version: value.version, source: value.source, license: value.license, python: value.python, executable: value.executable, expectedVersion: value.expectedVersion, artifacts: Object.freeze({ common, 'darwin-arm64': arm64, 'darwin-x64': x64 }) })
}

export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  if (!isRecord(value) || !exactKeys(value, ['specKit', 'uv'])) throw new Error('invalid runtime manifest')
  return Object.freeze({ uv: parseUvManifest(value.uv), specKit: parseSpecKitManifest(value.specKit) })
}

export function selectUvArtifact(manifest: UvManifest, architecture: 'arm64' | 'x64'): UvArtifact { return manifest.artifacts[`darwin-${architecture}`] }
export function selectSpecKitArtifacts(manifest: SpecKitManifest, architecture: 'arm64' | 'x64'): readonly RuntimeArtifact[] { return Object.freeze([...manifest.artifacts.common, ...manifest.artifacts[`darwin-${architecture}`]]) }

function parseArtifacts(value: unknown): readonly RuntimeArtifact[] {
  if (!Array.isArray(value)) throw new Error('invalid runtime artifact closure')
  const artifacts = value.map(parseArtifact); const destinations = new Set<string>()
  for (const artifact of artifacts) { if (artifact.destination === undefined || destinations.has(artifact.destination)) throw new Error('runtime artifact destinations must be unique'); destinations.add(artifact.destination) }
  return Object.freeze(artifacts)
}
function parseArtifact(value: unknown): RuntimeArtifact {
  if (!isRecord(value) || !exactKeys(value, ['allowedHosts', 'bytes', 'component', 'destination', 'license', 'sha256', 'source', 'url', 'version']) || !nonEmpty(value.component) || !nonEmpty(value.version) || !nonEmpty(value.license) || !nonEmpty(value.source) || typeof value.url !== 'string' || !safeArtifactUrl(value.url) || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256) || !Array.isArray(value.allowedHosts) || value.allowedHosts.length === 0 || !value.allowedHosts.every(nonEmpty) || !nonEmpty(value.destination) || !workspaceRelative(value.destination)) throw new Error('invalid runtime manifest artifact')
  const url = new URL(value.url); if (!value.allowedHosts.includes(url.hostname)) throw new Error('artifact allowedHosts must include its source host')
  return Object.freeze({ component: value.component, version: value.version, license: value.license, source: value.source, url: value.url, bytes: value.bytes, sha256: value.sha256, allowedHosts: Object.freeze([...value.allowedHosts]), destination: value.destination })
}
function assertSpecKitClosure(common: readonly RuntimeArtifact[], arm64: readonly RuntimeArtifact[], x64: readonly RuntimeArtifact[]): void {
  assertExactArtifacts(common, EXPECTED_SPEC_KIT_COMMON, 'spec-kit common wheel closure is incomplete or mismatched')
  assertExactArtifacts(arm64, EXPECTED_SPEC_KIT_ARM64, 'spec-kit arm64 artifact closure is incomplete or mismatched')
  assertExactArtifacts(x64, EXPECTED_SPEC_KIT_X64, 'spec-kit x64 artifact closure is incomplete or mismatched')
}
type ExactArtifact = readonly [component: string, version: string, license: string, source: string, url: string, bytes: number, sha256: string, allowedHosts: readonly string[], destination: string]
const EXPECTED_UV_ARM64: ExactArtifact = ['uv', '0.12.3', 'Apache-2.0 OR MIT', 'https://github.com/astral-sh/uv/releases/tag/0.12.3', 'https://releases.astral.sh/github/uv/releases/download/0.12.3/uv-aarch64-apple-darwin.tar.gz', 17686637, '546f7f8a6c70ff13a3a9d2bc958db3427298cebf3e0cb756f9177133b7068843', ['releases.astral.sh'], '.backend-team/cache/downloads/uv-0.12.3.tar.gz']
const EXPECTED_UV_X64: ExactArtifact = ['uv', '0.12.3', 'Apache-2.0 OR MIT', 'https://github.com/astral-sh/uv/releases/tag/0.12.3', 'https://releases.astral.sh/github/uv/releases/download/0.12.3/uv-x86_64-apple-darwin.tar.gz', 19547702, '4c9f52262a14da336e4a42ed24992d12d0c956acde87619e4611d321dffa602b', ['releases.astral.sh'], '.backend-team/cache/downloads/uv-0.12.3.tar.gz']
const EXPECTED_SPEC_KIT_COMMON: readonly ExactArtifact[] = [
  ['specify-cli', '0.16.5', 'MIT', 'https://github.com/github/spec-kit/tree/v0.16.5', 'https://files.pythonhosted.org/packages/49/a4/99316c6c6e8030acaf35abbdfbaecb829df4baa5a058b5f58a4f6a29630e/specify_cli-0.16.5-py3-none-any.whl', 841068, '173f55a8bec54ce3539d63a99e8e224e3ead8830383ea22cbf02e2f01f85bad3', ['files.pythonhosted.org'], '.backend-team/cache/wheels/specify_cli-0.16.5-py3-none-any.whl'],
  ['python-dependency', '0.27.1', 'MIT', 'https://pypi.org/project/typer/0.27.1/', 'https://files.pythonhosted.org/packages/43/89/9518bc0c3929bee36b3a4a8e3daddd6e03f92f9961c66d4983b837160543/typer-0.27.1-py3-none-any.whl', 122874, '53150287edd11baeb4e4722c8e394fcdf8181c0ae89485cba8d25c778d5edd56', ['files.pythonhosted.org'], '.backend-team/cache/wheels/typer-0.27.1-py3-none-any.whl'],
  ['python-dependency', '8.4.2', 'BSD-3-Clause', 'https://pypi.org/project/click/8.4.2/', 'https://files.pythonhosted.org/packages/fb/e2/79c688af8b210d232694e31e59da9f6ec747bae31c3f5946e4e9b98860d5/click-8.4.2-py3-none-any.whl', 119243, 'e6f9f66136c816745b9d65817da91d61d957fb16e02e4dcd0552553c5a197b76', ['files.pythonhosted.org'], '.backend-team/cache/wheels/click-8.4.2-py3-none-any.whl'],
  ['python-dependency', '15.0.0', 'MIT', 'https://pypi.org/project/rich/15.0.0/', 'https://files.pythonhosted.org/packages/82/3b/64d4899d73f91ba49a8c18a8ff3f0ea8f1c1d75481760df8c68ef5235bf5/rich-15.0.0-py3-none-any.whl', 310654, '33bd4ef74232fb73fe9279a257718407f169c09b78a87ad3d296f548e27de0bb', ['files.pythonhosted.org'], '.backend-team/cache/wheels/rich-15.0.0-py3-none-any.whl'],
  ['python-dependency', '4.11.4', 'MIT', 'https://pypi.org/project/platformdirs/4.11.4/', 'https://files.pythonhosted.org/packages/28/be/0ff05fcd2938fb58ad9219bd54135968342d214737e012d62d43f06a2dd6/platformdirs-4.11.4-py3-none-any.whl', 23741, 'e34ff91a24bcddc6d939b878bdf3f5c437c9c46fe9e212b1bf455fdf1ee57586', ['files.pythonhosted.org'], '.backend-team/cache/wheels/platformdirs-4.11.4-py3-none-any.whl'],
  ['python-dependency', '4.2.2', 'MIT', 'https://pypi.org/project/readchar/4.2.2/', 'https://files.pythonhosted.org/packages/3d/ca/36133653e00939922dd1416f4c56177361289172a30563fcb9552c9ccde4/readchar-4.2.2-py3-none-any.whl', 9401, '92daf7e42c52b0787e6c75d01ecfb9a94f4ceff3764958b570c1dddedd47b200', ['files.pythonhosted.org'], '.backend-team/cache/wheels/readchar-4.2.2-py3-none-any.whl'],
  ['python-dependency', '26.3', 'Apache-2.0 OR BSD-2-Clause', 'https://pypi.org/project/packaging/26.3/', 'https://files.pythonhosted.org/packages/63/34/ba1c580383c9eada3711951fef0795c80b829a078d72188184bcab9dd527/packaging-26.3-py3-none-any.whl', 129956, 'd7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c', ['files.pythonhosted.org'], '.backend-team/cache/wheels/packaging-26.3-py3-none-any.whl'],
  ['python-dependency', '1.1.1', 'MPL-2.0', 'https://pypi.org/project/pathspec/1.1.1/', 'https://files.pythonhosted.org/packages/f1/d9/7fb5aa316bc299258e68c73ba3bddbc499654a07f151cba08f6153988714/pathspec-1.1.1-py3-none-any.whl', 57328, 'a00ce642f577bf7f473932318056212bc4f8bfdf53128c78bbd5af0b9b20b189', ['files.pythonhosted.org'], '.backend-team/cache/wheels/pathspec-1.1.1-py3-none-any.whl'],
  ['python-dependency', '0.15.0', 'Apache-2.0', 'https://pypi.org/project/json5/0.15.0/', 'https://files.pythonhosted.org/packages/eb/be/59527c99478aade6bb33a68d72e6e18dd4e6ff6eacfc7d01bdb15bc76912/json5-0.15.0-py3-none-any.whl', 36570, '56636a30c0e8a4665fe2179c0212f32eae3796dea89ea6f649b9436ecdb39618', ['files.pythonhosted.org'], '.backend-team/cache/wheels/json5-0.15.0-py3-none-any.whl'],
  ['python-dependency', '1.5.4', 'ISC', 'https://pypi.org/project/shellingham/1.5.4/', 'https://files.pythonhosted.org/packages/e0/f9/0595336914c5619e5f28a1fb793285925a8cd4b432c9da0a987836c7f822/shellingham-1.5.4-py2.py3-none-any.whl', 9755, '7ecfff8f2fd72616f7481040475a65b2bf8af90a56c89140852d1120324e8686', ['files.pythonhosted.org'], '.backend-team/cache/wheels/shellingham-1.5.4-py2.py3-none-any.whl'],
  ['python-dependency', '0.0.5', 'MIT', 'https://pypi.org/project/annotated-doc/0.0.5/', 'https://files.pythonhosted.org/packages/3e/30/e900b21425a860e195f32e37657aa1f7c7f2b1bfb26f03ca209b90933c06/annotated_doc-0.0.5-py3-none-any.whl', 5302, '117bac03a25ede5df5440e855b32d556049ca169ead221505badf432fed4b101', ['files.pythonhosted.org'], '.backend-team/cache/wheels/annotated_doc-0.0.5-py3-none-any.whl'],
  ['python-dependency', '4.2.0', 'MIT', 'https://pypi.org/project/markdown-it-py/4.2.0/', 'https://files.pythonhosted.org/packages/b3/81/4da04ced5a082363ecfa159c010d200ecbd959ae410c10c0264a38cac0f5/markdown_it_py-4.2.0-py3-none-any.whl', 91687, '9f7ebbcd14fe59494226453aed97c1070d83f8d24b6fc3a3bcf9a38092641c4a', ['files.pythonhosted.org'], '.backend-team/cache/wheels/markdown_it_py-4.2.0-py3-none-any.whl'],
  ['python-dependency', '2.21.0', 'BSD-2-Clause', 'https://pypi.org/project/pygments/2.21.0/', 'https://files.pythonhosted.org/packages/71/46/17f022dd3e953bf20a04a028a21ec746d942f8d2af30fa0f124fa0e6a684/pygments-2.21.0-py3-none-any.whl', 1250147, '2363c69b61c4a97c838da3b130dcd6468f4848992b21a82f2a63ec34377137d9', ['files.pythonhosted.org'], '.backend-team/cache/wheels/pygments-2.21.0-py3-none-any.whl'],
  ['python-dependency', '0.1.2', 'MIT', 'https://pypi.org/project/mdurl/0.1.2/', 'https://files.pythonhosted.org/packages/b3/38/89ba8ad64ae25be8de66a6d463314cf1eb366222074cfda9ee839c56a4b4/mdurl-0.1.2-py3-none-any.whl', 9979, '84008a41e51615a49fc9966191ff91509e3c40b939176e643fd50a5c2196b8f8', ['files.pythonhosted.org'], '.backend-team/cache/wheels/mdurl-0.1.2-py3-none-any.whl'],
]
const EXPECTED_SPEC_KIT_ARM64: readonly ExactArtifact[] = [
  ['python', '3.13.15', 'PSF-2.0', 'https://github.com/astral-sh/python-build-standalone/releases/tag/20260807', 'https://github.com/astral-sh/python-build-standalone/releases/download/20260807/cpython-3.13.15%2B20260807-aarch64-apple-darwin-install_only_stripped.tar.gz', 25156281, 'dbadb0ffe46f8bace50daaf8a0c5fc6903c003690776da9eb5269e33c856bb53', ['github.com', 'release-assets.githubusercontent.com'], '.backend-team/cache/python-mirror/20260807/cpython-3.13.15+20260807-aarch64-apple-darwin-install_only_stripped.tar.gz'],
  ['python-dependency', '6.0.3', 'MIT', 'https://pypi.org/project/PyYAML/6.0.3/', 'https://files.pythonhosted.org/packages/b1/16/95309993f1d3748cd644e02e38b75d50cbc0d9561d21f390a76242ce073f/pyyaml-6.0.3-cp313-cp313-macosx_11_0_arm64.whl', 173252, '2283a07e2c21a2aa78d9c4442724ec1eb15f5e42a723b99cb3d822d48f5f7ad1', ['files.pythonhosted.org'], '.backend-team/cache/wheels/pyyaml-6.0.3-cp313-cp313-macosx_11_0_arm64.whl'],
]
const EXPECTED_SPEC_KIT_X64: readonly ExactArtifact[] = [
  ['python', '3.13.15', 'PSF-2.0', 'https://github.com/astral-sh/python-build-standalone/releases/tag/20260807', 'https://github.com/astral-sh/python-build-standalone/releases/download/20260807/cpython-3.13.15%2B20260807-x86_64-apple-darwin-install_only_stripped.tar.gz', 24927967, '187eed2282e9c3a5b6b14953d564ee25a9f35cf2c209c9fa292186ee48b0e4a1', ['github.com', 'release-assets.githubusercontent.com'], '.backend-team/cache/python-mirror/20260807/cpython-3.13.15+20260807-x86_64-apple-darwin-install_only_stripped.tar.gz'],
  ['python-dependency', '6.0.3', 'MIT', 'https://pypi.org/project/PyYAML/6.0.3/', 'https://files.pythonhosted.org/packages/d1/11/0fd08f8192109f7169db964b5707a2f1e8b745d4e239b784a5a1dd80d1db/pyyaml-6.0.3-cp313-cp313-macosx_10_13_x86_64.whl', 181669, '8da9669d359f02c0b91ccc01cac4a67f16afec0dac22c2ad09f46bee0697eba8', ['files.pythonhosted.org'], '.backend-team/cache/wheels/pyyaml-6.0.3-cp313-cp313-macosx_10_13_x86_64.whl'],
]
function assertExactArtifacts(artifacts: readonly RuntimeArtifact[], expected: readonly ExactArtifact[], message: string): void {
  if (artifacts.length !== expected.length || artifacts.some((artifact, index) => !expected[index] || !sameExactArtifact(artifact, expected[index]!))) throw new Error(message)
}
function assertExactArtifact(artifact: RuntimeArtifact, expected: ExactArtifact): void {
  if (!sameExactArtifact(artifact, expected)) throw new Error('runtime artifact metadata does not match the official manifest')
}
function sameExactArtifact(artifact: RuntimeArtifact, expected: ExactArtifact): boolean {
  return artifact.component === expected[0] && artifact.version === expected[1] && artifact.license === expected[2] && artifact.source === expected[3] && artifact.url === expected[4] && artifact.bytes === expected[5] && artifact.sha256 === expected[6] && artifact.allowedHosts.length === expected[7].length && artifact.allowedHosts.every((host, index) => host === expected[7][index]) && artifact.destination === expected[8]
}
function safeArtifactUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === '' } catch { return false } }
function workspaceRelative(value: string): boolean { return !value.includes('\0') && !value.startsWith('/') && !value.split('/').some((part) => part === '' || part === '.' || part === '..') }
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const keys = Object.keys(value).sort(); const sorted = [...expected].sort(); return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]) }
