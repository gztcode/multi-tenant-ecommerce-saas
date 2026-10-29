// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        // ⚠️ `projectService: true` 要求文件被某个 tsconfig 包含。
        // `test/deploy-test-db.mjs` 是纯 Node 脚本（.mjs —— tsconfig 的 include
        // 只覆盖 .ts），不在任何 tsconfig 里 → 解析报
        // 「was not found by the project service」。
        // `allowDefaultProject` 让它走默认项目（解析通过），
        // 而不是把它加进 ignores —— 后者等于放弃对它的 lint。
        projectService: {
          allowDefaultProject: ['test/*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
);
