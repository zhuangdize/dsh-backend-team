# Third-party notices

The generated Bundle currently contains code from the following third-party
package:

## Zod 4.4.3

Copyright (c) 2025 Colin McDonnell. Zod is distributed under the MIT License.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## shadcn/ui components

Button and Textarea in the team UI are adapted from shadcn/ui's MIT-licensed
new-york registry (https://ui.shadcn.com). Copyright (c) 2023 shadcn.
The MIT permission and warranty text above applies to these components.
The adaptation uses the host React instance and keeps styles scoped to team UI.

## Additional bundled UI dependencies

- class-variance-authority: Apache-2.0, Copyright Joe Bell.
- clsx: MIT, Copyright Luke Edwards.
- tailwind-merge: MIT, Copyright Dany Castillo.
- Tailwind CSS: MIT, Copyright Tailwind Labs, Inc. (compiled styles only).

The corresponding upstream license texts are included alongside this notice.

- Radix UI React primitives: MIT, Copyright (c) 2022 WorkOS; see radix-ui.txt.
- Lucide React icons: ISC (with retained upstream notices), Copyright (c) 2026 Lucide Icons and Contributors; see lucide.txt.

## ignore 5.3.2

Included by the read-only project analyzer. Full license: [ignore.txt](ignore.txt).

## @iarna/toml 2.2.5

Included by the read-only project analyzer. Full license: [iarna-toml.txt](iarna-toml.txt).

## Scoped TypeScript check tooling

The bundle includes its existing build toolchain for read-only file checks:
TypeScript (Apache-2.0), @types/node (MIT), and undici-types (MIT).
Their upstream license files are retained in `lib/tooling/` beside each package.
Exact included versions are recorded in `lib/tooling/versions.json` during the build.
