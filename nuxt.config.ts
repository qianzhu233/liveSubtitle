// https://nuxt.com/docs/api/configuration/nuxt-config
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const currentDir = dirname(fileURLToPath(import.meta.url));
const outputSubtitleDir = resolve(currentDir, '.output', 'subtitleFiles');

// 构建会清空 .output；字幕运行时数据放在 .output/subtitleFiles，
// 构建前备份、构建结束（close）后恢复，避免发布用的字幕被 build 删掉。
let outputSubtitleBackupDir: string | null = null;

function restoreOutputSubtitles() {
    if (!outputSubtitleBackupDir) {
        return;
    }
    try {
        fs.mkdirSync(dirname(outputSubtitleDir), { recursive: true });
        fs.cpSync(outputSubtitleBackupDir, outputSubtitleDir, {
            recursive: true,
            force: true,
        });
    } finally {
        discardOutputSubtitleBackup();
    }
}

function discardOutputSubtitleBackup() {
    if (!outputSubtitleBackupDir) {
        return;
    }
    fs.rmSync(outputSubtitleBackupDir, { recursive: true, force: true });
    outputSubtitleBackupDir = null;
}

function directoryHasEntries(directory: string): boolean {
    try {
        return fs.readdirSync(directory).length > 0;
    } catch {
        return false;
    }
}

export default defineNuxtConfig({
    compatibilityDate: '2026-07-28',
    devtools: { enabled: false },

    hooks: {
        'build:before': () => {
            // 已有发布字幕时原样保留；首次构建/目录为空时用项目根目录初始化
            const sourceDir = directoryHasEntries(outputSubtitleDir)
                ? outputSubtitleDir
                : resolve(currentDir, 'subtitleFiles');

            if (!directoryHasEntries(sourceDir)) {
                return;
            }
            outputSubtitleBackupDir = fs.mkdtempSync(
                join(os.tmpdir(), 'livesubtitle-output-subtitles-'),
            );
            fs.cpSync(sourceDir, outputSubtitleBackupDir, { recursive: true });
        },
        // Nitro 在 Nuxt build:done 之后才写入/清理 .output，必须等 close 再恢复。
        // dev 模式不恢复，避免退出开发服务器时覆盖开发期间对 .output 的修改。
        close: (nuxt) => {
            if (nuxt?.options?.dev) {
                discardOutputSubtitleBackup();
                return;
            }
            restoreOutputSubtitles();
        },
    },

    css: ['~/assets/main.css'],

    modules: ['@pinia/nuxt', '@xarenas107/nuxt-socket-io'],

    // OBS 浏览器来源会缓存页面；禁止展示端 HTML 被缓存，避免部署新版本后 OBS 仍运行旧页面
    routeRules: {
        '/subtitle': {
            headers: { 'cache-control': 'no-store, max-age=0' },
        },
    },

    vite: {
        plugins: [
            {
                name: 'fix-debug-esm',
                enforce: 'pre',
                resolveId(id, _importer, options) {
                    // engine.io-client's esm-debug imports the 'debug' CJS module.
                    // Vite can't CJS→ESM convert browser.js, so replace with ESM shim.
                    // Only client side — server-side uses the real debug module.
                    if (id === 'debug' && !(options as any)?.ssr) {
                        return resolve(currentDir, 'shims/debug.mjs');
                    }
                },
            },
        ],
    },

    nitro: {
        experimental: {
            openAPI: true,
        },
    },

    typescript: {
        strict: true,
        tsConfig: {
            compilerOptions: {
                noUncheckedIndexedAccess: false,
                esModuleInterop: true,
            },
        },
    },
});
