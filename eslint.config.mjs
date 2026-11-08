import js from '@eslint/js'
import globals from 'globals'
import ts from 'typescript-eslint'
import { importX } from 'eslint-plugin-import-x'
import perfectionist from 'eslint-plugin-perfectionist'
import prettier from 'eslint-plugin-prettier/recommended'
import { defineConfig, globalIgnores } from 'eslint/config'

const byLength = { order: 'asc', type: 'line-length' }

export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/.cache/',
    '**/coverage/',
    'data/',
  ]),
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node,
    },
    plugins: { import: importX, perfectionist },
    rules: {
      'prefer-template': 'error',
      'object-shorthand': 'error',
      'import/first': 'error',
      'import/newline-after-import': 'error',
      'perfectionist/sort-exports': ['error', byLength],
      'perfectionist/sort-named-imports': ['error', byLength],
      'perfectionist/sort-named-exports': ['error', byLength],
      'perfectionist/sort-imports': [
        'error',
        {
          ...byLength,
          newlinesBetween: 1,
          groups: [
            ['type-builtin', 'value-builtin'],
            ['type-external', 'value-external'],
            ['type-internal', 'value-internal', 'tsconfig-path'],
            [
              'type-parent',
              'type-index',
              'value-index',
              'type-sibling',
              'value-parent',
              'value-sibling',
            ],
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts'],
    extends: [ts.configs.recommended],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'perfectionist/sort-interfaces': ['error', byLength],
      'perfectionist/sort-object-types': ['error', byLength],
    },
  },
  prettier,
  {
    rules: { curly: 'error' },
  },
)
