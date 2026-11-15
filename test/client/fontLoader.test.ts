// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadFonts } from '../../utils/fontLoader';

const jsonResponse = (data: unknown, ok = true) =>
    ({ ok, status: ok ? 200 : 500, json: async () => data }) as Response;

const statusResponse = (ok: boolean) => ({ ok, status: ok ? 200 : 404 }) as Response;

function silenceConsole() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('loadFonts', () => {
    it('只返回可访问的字体文件，跳过 404 字体与非字体文件', async () => {
        silenceConsole();
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url === '/api/fonts') {
                expect(init?.cache).toBe('no-store');
                return jsonResponse(['ok.ttf', 'missing.otf', 'readme.txt']);
            }
            if (url === '/fonts/ok.ttf') {
                return statusResponse(true);
            }
            if (url === '/fonts/missing.otf') {
                return statusResponse(false);
            }
            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(loadFonts()).resolves.toEqual(['/fonts/ok.ttf']);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('1 个字体文件无法访问'));
    });

    it('HEAD 请求抛错时也跳过该字体', async () => {
        silenceConsole();
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url === '/api/fonts') {
                    return jsonResponse(['good.ttc', 'broken.woff2']);
                }
                if (url === '/fonts/good.ttc') {
                    return statusResponse(true);
                }
                throw new TypeError('network error');
            }),
        );

        await expect(loadFonts()).resolves.toEqual(['/fonts/good.ttc']);
    });

    it('字体列表接口失败时返回空数组', async () => {
        silenceConsole();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => jsonResponse([], false)),
        );

        await expect(loadFonts()).resolves.toEqual([]);
    });

    it('字体列表为空时返回空数组', async () => {
        silenceConsole();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => jsonResponse([])),
        );

        await expect(loadFonts()).resolves.toEqual([]);
    });
});
