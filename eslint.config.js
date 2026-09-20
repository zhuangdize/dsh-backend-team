import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/dist/**', 'packages/bundle/lib/**', '**/coverage/**', '**/.backend-team/**', 'package-lock.json'],
  },
  tseslint.configs.recommended,
)
