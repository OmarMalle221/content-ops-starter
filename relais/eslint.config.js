import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/**', 'dev-dist/**', 'node_modules/**', 'playwright-report/**', 'test-results/**', '.tmp/**'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    jsxA11y.flatConfigs.recommended,
    {
        files: ['**/*.{ts,tsx}'],
        languageOptions: { globals: { ...globals.browser } },
        plugins: { 'react-hooks': reactHooks },
        rules: {
            ...reactHooks.configs.recommended.rules,
            '@typescript-eslint/no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }
            ],
            // Règle 5 : rien ne s'écrit dans la console hors du journaliseur à liste blanche (src/lib/log.ts).
            'no-console': 'error'
        }
    },
    {
        files: ['src/lib/log.ts', 'supabase/functions/_shared/log.ts'],
        rules: { 'no-console': 'off' }
    },
    {
        // Fonctions Edge (Deno) : pas de DOM ; le code de l'application ne doit pas les importer.
        files: ['supabase/functions/**/*.ts'],
        languageOptions: { globals: { ...globals.node } }
    },
    {
        files: ['src/**/*.{ts,tsx}'],
        rules: {
            'no-restricted-imports': [
                'error',
                { patterns: [{ group: ['**/supabase/functions/**'], message: 'Code serveur : jamais dans l’application.' }] }
            ]
        }
    },
    {
        // Scripts, configuration et tests de bout en bout : sortie console autorisée (aucune donnée réelle).
        files: ['scripts/**/*.mjs', 'tests/e2e/**/*.{mjs,ts}', 'tests/deno/**/*.mjs', 'tests/integration/**/*.ts', '*.config.{js,ts}'],
        languageOptions: { globals: { ...globals.node } },
        rules: { 'no-console': 'off' }
    },
    {
        // Les fixtures Playwright reçoivent une fonction `use` qui n'est pas un hook React.
        files: ['tests/e2e/**/*.ts'],
        rules: { 'react-hooks/rules-of-hooks': 'off' }
    }
);
