const tseslintPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

/** @type {import('eslint').FlatConfig.Config[]} */
module.exports = [
    { ignores: ['dist/**'] },
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 'latest',
            sourceType: 'module',
        },
        plugins: {
            '@typescript-eslint': tseslintPlugin,
        },
        rules: {
            // basic TS hygiene
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'warn',
            // project rule from previous config
            'object-curly-spacing': ['error', 'always'],
        },
    },
];
