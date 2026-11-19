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

const FONT_OPTIONS = [
    {
        fileName: 'FZFWZhuZiAYuanJWB.TTF',
        familyName: 'FZFW ZhuZi A YuanS',
        url: '/fonts/FZFWZhuZiAYuanJWB.TTF',
    },
    {
        fileName: 'HarmonyOS_Sans_SC_Black.ttf',
        familyName: 'HarmonyOS Sans SC',
        url: '/fonts/HarmonyOS_Sans_SC_Black.ttf',
    },
    {
        fileName: 'HarmonyOS_Sans_SC_Thin.ttf',
        familyName: 'HarmonyOS Sans SC',
        url: '/fonts/HarmonyOS_Sans_SC_Thin.ttf',
    },
];

const ASS_CONTENT = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour
Style: Default,HarmonyOS Sans SC,50,&H00FFFFFF

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,测试
`;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('loadFonts 基本容错', () => {
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

describe('loadFonts 按需加载字体文件', () => {
    it('选中具体字体文件时只加载该文件（同族字重不会互相覆盖）', async () => {
        silenceConsole();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === '/fonts/HarmonyOS_Sans_SC_Thin.ttf') {
                return statusResponse(true);
            }
            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            loadFonts({ selectedFontUrl: '/fonts/HarmonyOS_Sans_SC_Thin.ttf' }),
        ).resolves.toEqual(['/fonts/HarmonyOS_Sans_SC_Thin.ttf']);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('未选字体时按 ASS 引用加载对应字体，同族只加载一个文件', async () => {
        silenceConsole();
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url === '/api/font-options') {
                    return jsonResponse(FONT_OPTIONS);
                }
                if (url === '/fonts/HarmonyOS_Sans_SC_Black.ttf') {
                    return statusResponse(true);
                }
                throw new Error(`unexpected url: ${url}`);
            }),
        );

        // ASS 引用 HarmonyOS Sans SC，同族有 Black/Thin 两个文件，只取第一个
        const result = await loadFonts({ assContent: ASS_CONTENT });
        expect(result).toEqual(['/fonts/HarmonyOS_Sans_SC_Black.ttf']);
    });

    it('Style 行在 Format 行之前时也能识别 ASS 引用的字体', async () => {
        silenceConsole();
        const assContent = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Style: 歌曲字幕,HarmonyOS Sans SC,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3.5,2,2,10,10,10,1
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic
Style: orig,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,00:00:01.00,00:00:02.00,歌曲字幕,,0,0,0,,测试
`;
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url === '/api/font-options') {
                    return jsonResponse(FONT_OPTIONS);
                }
                if (url === '/fonts/HarmonyOS_Sans_SC_Black.ttf') {
                    return statusResponse(true);
                }
                throw new Error(`unexpected url: ${url}`);
            }),
        );

        await expect(loadFonts({ assContent })).resolves.toEqual([
            '/fonts/HarmonyOS_Sans_SC_Black.ttf',
        ]);
    });

    it('ASS 引用的字体匹配不到时只回退加载少量默认字体', async () => {
        silenceConsole();
        const assContent = ASS_CONTENT.replace('HarmonyOS Sans SC', 'Unknown Font');
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url === '/api/font-options') {
                    return jsonResponse(FONT_OPTIONS);
                }
                if (url === '/api/fonts') {
                    return jsonResponse(['fallback.ttf']);
                }
                if (url === '/fonts/fallback.ttf') {
                    return statusResponse(true);
                }
                throw new Error(`unexpected url: ${url}`);
            }),
        );

        await expect(loadFonts({ assContent })).resolves.toEqual(['/fonts/fallback.ttf']);
    });

    it('选中的字体文件不可访问时回退到按 ASS/全部字体加载', async () => {
        silenceConsole();
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url === '/fonts/HarmonyOS_Sans_SC_Black.ttf') {
                    return statusResponse(false);
                }
                if (url === '/api/fonts') {
                    return jsonResponse(['fallback.ttf']);
                }
                if (url === '/fonts/fallback.ttf') {
                    return statusResponse(true);
                }
                throw new Error(`unexpected url: ${url}`);
            }),
        );

        await expect(
            loadFonts({ selectedFontUrl: '/fonts/HarmonyOS_Sans_SC_Black.ttf' }),
        ).resolves.toEqual(['/fonts/fallback.ttf']);
    });
});
