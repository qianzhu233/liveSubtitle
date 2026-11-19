// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearFontOptionsCache, loadFonts } from '../../utils/fontLoader';

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
        familyName: 'HarmonyOS Sans SC',
        fileName: 'HarmonyOS_Sans_SC_Regular.ttf',
        url: '/api/font-file/harmony-regular',
        urls: ['/api/font-file/harmony-regular', '/api/font-file/harmony-bold'],
        aliases: ['HarmonyOS Sans SC', 'HarmonyOS Sans SC Regular', 'HarmonyOSSansSC'],
    },
    {
        familyName: 'Microsoft YaHei',
        fileName: 'msyh.ttc',
        url: '/api/font-file/msyh',
        urls: ['/api/font-file/msyh', '/api/font-file/msyhbd'],
        aliases: ['Microsoft YaHei', '微软雅黑'],
        fallback: true,
    },
    {
        familyName: 'Arial Narrow',
        fileName: 'ARIALN.TTF',
        url: '/api/font-file/arialn',
        urls: ['/api/font-file/arialn'],
        aliases: ['Arial Narrow', 'ArialNarrow'],
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

beforeEach(() => {
    clearFontOptionsCache();
});

afterEach(() => {
    clearFontOptionsCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('loadFonts 基本容错', () => {
    it('只返回可访问的字体文件，跳过 404 字体', async () => {
        silenceConsole();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === '/api/font-file/arialn') {
                return statusResponse(true);
            }
            if (url === '/api/font-file/missing') {
                return statusResponse(false);
            }
            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            loadFonts({ selectedFontUrls: ['/api/font-file/arialn', '/api/font-file/missing'] }),
        ).resolves.toEqual(['/api/font-file/arialn']);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('1 个字体文件无法访问'));
    });

    it('HEAD 请求抛错时也跳过该字体', async () => {
        silenceConsole();
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url === '/api/font-file/arialn') {
                    return statusResponse(true);
                }
                throw new TypeError('network error');
            }),
        );

        await expect(
            loadFonts({ selectedFontUrls: ['/api/font-file/arialn', '/api/font-file/broken'] }),
        ).resolves.toEqual(['/api/font-file/arialn']);
    });

    it('字体列表接口失败时返回空数组', async () => {
        silenceConsole();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => jsonResponse([], false)),
        );

        await expect(loadFonts({ assContent: ASS_CONTENT })).resolves.toEqual([]);
    });

    it('字体列表为空时返回空数组', async () => {
        silenceConsole();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => jsonResponse([])),
        );

        await expect(loadFonts({ assContent: ASS_CONTENT })).resolves.toEqual([]);
    });
});

describe('loadFonts 强制系统字体', () => {
    it('选中字体时加载该字体族的全部字重文件，并去重', async () => {
        silenceConsole();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.startsWith('/api/font-file/')) {
                return statusResponse(true);
            }
            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            loadFonts({
                selectedFontUrls: [
                    '/api/font-file/harmony-regular',
                    '/api/font-file/harmony-bold',
                    '/api/font-file/harmony-regular',
                ],
            }),
        ).resolves.toEqual(['/api/font-file/harmony-regular', '/api/font-file/harmony-bold']);
    });

    it('选中字体时同时加载 CJK 回退字体，避免主字体缺字时出现豆腐块', async () => {
        silenceConsole();
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url === '/api/font-options') {
                    return jsonResponse(FONT_OPTIONS);
                }
                if (url === '/api/font-file/harmony-regular') {
                    return statusResponse(true);
                }
                if (url === '/api/font-file/msyh') {
                    return statusResponse(true);
                }
                throw new Error(`unexpected url: ${url}`);
            }),
        );

        await expect(
            loadFonts({ selectedFontUrls: ['/api/font-file/harmony-regular'] }),
        ).resolves.toEqual(['/api/font-file/harmony-regular', '/api/font-file/msyh']);
    });

    it('选中的字体全部不可访问时回退到按 ASS 引用匹配', async () => {
        silenceConsole();
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url === '/api/font-options') {
                    return jsonResponse(FONT_OPTIONS);
                }
                if (url === '/api/font-file/missing') {
                    return statusResponse(false);
                }
                if (url === '/api/font-file/harmony-regular') {
                    return statusResponse(true);
                }
                throw new Error(`unexpected url: ${url}`);
            }),
        );

        await expect(
            loadFonts({
                selectedFontUrls: ['/api/font-file/missing'],
                assContent: ASS_CONTENT,
            }),
        ).resolves.toEqual(['/api/font-file/harmony-regular']);
    });
});

describe('loadFonts 跟随原字幕', () => {
    it('按 ASS 引用的字体族名匹配系统字体，同族只加载主文件', async () => {
        silenceConsole();
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url === '/api/font-options') {
                    return jsonResponse(FONT_OPTIONS);
                }
                if (url === '/api/font-file/harmony-regular') {
                    return statusResponse(true);
                }
                throw new Error(`unexpected url: ${url}`);
            }),
        );

        await expect(loadFonts({ assContent: ASS_CONTENT })).resolves.toEqual([
            '/api/font-file/harmony-regular',
        ]);
    });

    it('跟随 ASS 匹配字体时也加载 CJK 回退字体', async () => {
        silenceConsole();
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url === '/api/font-options') {
                    return jsonResponse(FONT_OPTIONS);
                }
                if (url === '/api/font-file/harmony-regular' || url === '/api/font-file/msyh') {
                    return statusResponse(true);
                }
                throw new Error(`unexpected url: ${url}`);
            }),
        );

        await expect(loadFonts({ assContent: ASS_CONTENT })).resolves.toEqual([
            '/api/font-file/harmony-regular',
            '/api/font-file/msyh',
        ]);
    });

    it('支持本地化族名与竖排 @ 前缀', async () => {
        silenceConsole();
        const assContent = ASS_CONTENT.replace('HarmonyOS Sans SC', '@微软雅黑');
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === '/api/font-options') {
                return jsonResponse(FONT_OPTIONS);
            }
            if (url === '/api/font-file/msyh') {
                return statusResponse(true);
            }
            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(loadFonts({ assContent })).resolves.toEqual(['/api/font-file/msyh']);
    });

    it('匹配 ASS 行内 \\fn 覆盖标签', async () => {
        silenceConsole();
        const assContent = ASS_CONTENT.replace(
            'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,测试',
            'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\fnArial Narrow}测试',
        );
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url === '/api/font-options') {
                    return jsonResponse(FONT_OPTIONS);
                }
                if (url === '/api/font-file/arialn') {
                    return statusResponse(true);
                }
                throw new Error(`unexpected url: ${url}`);
            }),
        );

        await expect(loadFonts({ assContent })).resolves.toEqual(['/api/font-file/arialn']);
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
                if (url === '/api/font-file/harmony-regular') {
                    return statusResponse(true);
                }
                throw new Error(`unexpected url: ${url}`);
            }),
        );

        await expect(loadFonts({ assContent })).resolves.toEqual([
            '/api/font-file/harmony-regular',
        ]);
    });

    it('ASS 引用的字体匹配不到时加载服务端标记的回退字体', async () => {
        silenceConsole();
        const assContent = ASS_CONTENT.replace('HarmonyOS Sans SC', 'Unknown Font');
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url === '/api/font-options') {
                    return jsonResponse(FONT_OPTIONS);
                }
                if (url === '/api/font-file/msyh') {
                    return statusResponse(true);
                }
                throw new Error(`unexpected url: ${url}`);
            }),
        );

        await expect(loadFonts({ assContent })).resolves.toEqual(['/api/font-file/msyh']);
    });
});
