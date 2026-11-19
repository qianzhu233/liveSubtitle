import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// scripts/lrc2subtitle.js starts with a node shebang so it can be executed
// directly. Vite's transform rejects the hashbang when tests import the
// generator, so strip it before the regular transforms run.
const stripShebang = {
    name: 'strip-shebang',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
        if (id.endsWith('.js') && code.startsWith('#!')) {
            return code.replace(/^#![^\n]*\n/, '');
        }
    },
};

export default defineConfig({
    plugins: [stripShebang, vue()],
    resolve: {
        alias: {
            '~': fileURLToPath(new URL('.', import.meta.url)),
        },
    },
    test: {
        globals: true,
    },
});
