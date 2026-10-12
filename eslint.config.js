import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['node_modules', 'data'] },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        location: 'readonly',
        FormData: 'readonly',
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
