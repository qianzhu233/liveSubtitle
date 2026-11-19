// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import SubtitleSelector from '../../components/SubtitleSelector.vue';
import { useSubtitleStore } from '../../stores/subtitle';
import type { FontOption, SubtitleFile } from '../../types/subtitle';

// SubtitleSelector 依赖 Nuxt 自动导入的 socket store，这里提供一个最小替身
const socketMock = vi.hoisted(() => {
    const emit = vi.fn();
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const on = vi.fn((event: string, handler: (...args: any[]) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
    });
    (globalThis as any).useSocketIOStore = () => ({ emit, on });
    return { emit, on, handlers };
});

const testFile: SubtitleFile = {
    id: 'test-song',
    name: 'test-song',
    duration: 30,
    blocks: [
        { id: 'test-song-1', startTime: 0, endTime: 5, text: 'line 1', track: 1 },
        { id: 'test-song-2', startTime: 5, endTime: 10, text: 'line 2', track: 1 },
    ],
    createdAt: '',
    updatedAt: '',
};

const FONT_OPTIONS: FontOption[] = [
    {
        familyName: 'FZFW ZhuZi A YuanS',
        fileName: 'FZFWZhuZiAYuanJWB.TTF',
        url: '/api/font-file/fzfw',
        urls: ['/api/font-file/fzfw'],
        aliases: ['FZFW ZhuZi A YuanS', 'FZFWZhuZiAYuanJWB'],
    },
    {
        familyName: 'HarmonyOS Sans SC',
        fileName: 'HarmonyOS_Sans_SC_Regular.ttf',
        url: '/api/font-file/harmony-regular',
        urls: [
            '/api/font-file/harmony-regular',
            '/api/font-file/harmony-bold',
            '/api/font-file/harmony-thin',
        ],
        aliases: ['HarmonyOS Sans SC', 'HarmonyOS Sans SC Regular'],
    },
    {
        familyName: 'Microsoft YaHei',
        fileName: 'msyh.ttc',
        url: '/api/font-file/msyh',
        urls: ['/api/font-file/msyh', '/api/font-file/msyhbd'],
        aliases: ['Microsoft YaHei', '微软雅黑'],
        fallback: true,
    },
];

const ASS_CONTENT = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic
Style: Default,OriginalFont,48,&H00111111,&H00222222,&H009C46A5,&H00000000,-1,0
Style: 中文-测试,OriginalFont,64,&H00111111,&H00222222,&H009C46A5,&H00000000,-1,0

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,第一句
`;

const jsonResponse = (data: unknown) => ({
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => '',
});

const textResponse = (text: string) => ({
    ok: true,
    status: 200,
    json: async () => null,
    text: async () => text,
});

const createFetchMock = () =>
    vi.fn(async (input: RequestInfo | URL) => {
        const url =
            typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

        if (url === '/api/subtitles') {
            return jsonResponse([testFile]);
        }
        if (url === '/api/filter-config') {
            return jsonResponse([]);
        }
        if (url === '/api/font-options') {
            return jsonResponse(FONT_OPTIONS);
        }
        if (url === '/api/subtitle-file/test-song') {
            return textResponse(ASS_CONTENT);
        }
        if (url === '/api/subtitles/test-song') {
            return jsonResponse(testFile);
        }

        return { ok: false, status: 404, json: async () => null, text: async () => '' };
    });

let pinia: Pinia;
let wrapper: VueWrapper | null = null;
let fetchMock: ReturnType<typeof createFetchMock>;

const flushAll = async () => {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();
};

const emitCalls = (eventName: string) =>
    socketMock.emit.mock.calls.filter(([name]) => name === eventName);

const triggerSocketEvent = (eventName: string, ...args: unknown[]) => {
    for (const handler of socketMock.handlers.get(eventName) ?? []) {
        handler(...args);
    }
};

beforeEach(async () => {
    pinia = createPinia();
    setActivePinia(pinia);

    socketMock.handlers.clear();
    socketMock.on.mockClear();
    socketMock.emit.mockClear();
    fetchMock = createFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    wrapper = mount(SubtitleSelector, {
        attachTo: document.body,
        global: { plugins: [pinia] },
    });
    await flushAll();
});

afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('SubtitleSelector 颜色与字体', () => {
    it('颜色跟随 ASS 本身：不再提供颜色改写控件', () => {
        expect(wrapper!.find('select.color-select').exists()).toBe(false);
        expect(wrapper!.find('button.toggle-btn').exists()).toBe(false);
        expect(wrapper!.text()).toContain('跟随 ASS 本身');
    });

    it('字体下拉列出系统字体族，并保留「跟随原字幕」选项', () => {
        const store = useSubtitleStore(pinia);

        expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/font-options')).toBe(
            true,
        );
        expect(store.fontOptions).toHaveLength(3);
        expect(store.subtitleFiles).toHaveLength(1);

        const fontSelect = wrapper!.find('select.font-select');
        expect(fontSelect.exists()).toBe(true);

        const optionTexts = fontSelect.findAll('option').map((option) => option.text());
        expect(optionTexts[0]).toBe('跟随原字幕');
        expect(optionTexts).toContain('FZFW ZhuZi A YuanS');
        expect(optionTexts).toContain('HarmonyOS Sans SC');
        expect(optionTexts).toContain('Microsoft YaHei');

        const optionValues = fontSelect
            .findAll('option')
            .map((option) => (option.element as HTMLOptionElement).value);
        expect(optionValues).toContain('HarmonyOS Sans SC');
        expect(optionValues).toContain('Microsoft YaHei');
    });

    it('选择文件时携带当前全局字体（ASS 由展示端自行拉取）', async () => {
        const store = useSubtitleStore(pinia);
        store.selectedFont = 'HarmonyOS Sans SC';
        socketMock.emit.mockClear();

        store.selectFile(testFile);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await flushAll();

        const fileSelectedCalls = emitCalls('file-selected');
        expect(fileSelectedCalls).toHaveLength(1);
        expect(fileSelectedCalls[0]![1]).toMatchObject({
            file: testFile,
            fontFile: 'HarmonyOS_Sans_SC_Regular.ttf',
            fontFamily: 'HarmonyOS Sans SC',
            fontUrl: '/api/font-file/harmony-regular',
            fontUrls: [
                '/api/font-file/harmony-regular',
                '/api/font-file/harmony-bold',
                '/api/font-file/harmony-thin',
            ],
        });

        const assUpdateCalls = emitCalls('ass-content-update');
        // 选文件时展示端自己拉取 ASS，不再重复发送一次内容
        expect(assUpdateCalls).toHaveLength(0);
    });

    it('展示端请求同步时补发当前选中的字幕/字体/播放状态', async () => {
        const store = useSubtitleStore(pinia);
        store.selectFile(testFile);
        store.play();
        store.setCurrentTime(3);
        socketMock.emit.mockClear();

        triggerSocketEvent('request-sync');

        const fileSelectedCalls = emitCalls('file-selected');
        expect(fileSelectedCalls).toHaveLength(1);
        expect(fileSelectedCalls[0]![1]).toMatchObject({ file: testFile });

        const playStateCalls = emitCalls('play-state-change');
        expect(playStateCalls).toHaveLength(1);
        expect(playStateCalls[0]![1]).toEqual({ isPlaying: true });

        const timeSyncCalls = emitCalls('time-sync');
        expect(timeSyncCalls).toHaveLength(1);
        expect(timeSyncCalls[0]![1]).toEqual({ currentTime: 3 });
    });
});

describe('SubtitleSelector 字体全局切换', () => {
    it('修改字体下拉后发出 font-change 事件（含系统字体文件），并移走焦点', async () => {
        const store = useSubtitleStore(pinia);
        socketMock.emit.mockClear();

        const fontSelect = wrapper!.find('select.font-select');
        (fontSelect.element as HTMLSelectElement).focus();
        expect(document.activeElement).toBe(fontSelect.element);

        await fontSelect.setValue('HarmonyOS Sans SC');
        await flushAll();

        expect(store.selectedFont).toBe('HarmonyOS Sans SC');
        expect(emitCalls('font-change')).toHaveLength(1);
        expect(emitCalls('font-change')[0]![1]).toEqual({
            fontFile: 'HarmonyOS_Sans_SC_Regular.ttf',
            fontFamily: 'HarmonyOS Sans SC',
            fontUrl: '/api/font-file/harmony-regular',
            fontUrls: [
                '/api/font-file/harmony-regular',
                '/api/font-file/harmony-bold',
                '/api/font-file/harmony-thin',
            ],
        });
        // 字体由展示端全局应用，切换字体时不需要重新发送 ASS
        expect(emitCalls('ass-content-update')).toHaveLength(0);
        // 焦点已离开下拉框，空格键可以继续用于暂停
        expect((document.activeElement as HTMLElement | null)?.tagName).toBe('BODY');
    });

    it('切换不同系统字体时下发对应的字体族与全部字重文件', async () => {
        const fontSelect = wrapper!.find('select.font-select');

        await fontSelect.setValue('FZFW ZhuZi A YuanS');
        await flushAll();
        const fzfwPayload = emitCalls('font-change').at(-1)![1] as Record<string, unknown>;

        socketMock.emit.mockClear();
        await fontSelect.setValue('HarmonyOS Sans SC');
        await flushAll();
        const harmonyPayload = emitCalls('font-change').at(-1)![1] as Record<string, unknown>;

        expect(fzfwPayload.fontFamily).toBe('FZFW ZhuZi A YuanS');
        expect(fzfwPayload.fontUrls).toEqual(['/api/font-file/fzfw']);
        expect(harmonyPayload.fontFamily).toBe('HarmonyOS Sans SC');
        expect(harmonyPayload.fontUrls).toEqual([
            '/api/font-file/harmony-regular',
            '/api/font-file/harmony-bold',
            '/api/font-file/harmony-thin',
        ]);
    });

    it('字体搜索支持族名与本地化别名，并保留当前选中项', async () => {
        const store = useSubtitleStore(pinia);
        const searchInput = wrapper!.find('input.font-search-input');
        const optionTexts = () =>
            wrapper!
                .find('select.font-select')
                .findAll('option')
                .map((option) => option.text());

        expect(searchInput.exists()).toBe(true);

        await searchInput.setValue('微软');
        expect(optionTexts()).toContain('Microsoft YaHei');
        expect(optionTexts()).not.toContain('HarmonyOS Sans SC');

        // 当前选中的字体即使不匹配搜索词也保留，避免下拉框显示为空
        store.selectedFont = 'FZFW ZhuZi A YuanS';
        await flushAll();
        expect(optionTexts()).toContain('FZFW ZhuZi A YuanS');

        await searchInput.setValue('harmony');
        socketMock.emit.mockClear();
        expect(optionTexts()).toContain('HarmonyOS Sans SC');
        expect(optionTexts()).not.toContain('Microsoft YaHei');

        // 回车直接选中筛选结果里的第一款字体
        await searchInput.trigger('keydown.enter');
        await flushAll();
        expect(store.selectedFont).toBe('HarmonyOS Sans SC');
        expect(emitCalls('font-change')).toHaveLength(1);
    });

    it('切回「跟随原字幕」时发出空字体事件', async () => {
        const store = useSubtitleStore(pinia);
        const fontSelect = wrapper!.find('select.font-select');

        await fontSelect.setValue('HarmonyOS Sans SC');
        await flushAll();
        socketMock.emit.mockClear();

        await fontSelect.setValue('');
        await flushAll();

        expect(store.selectedFont).toBe('');
        expect(emitCalls('font-change')).toHaveLength(1);
        expect(emitCalls('font-change')[0]![1]).toEqual({
            fontFile: '',
            fontFamily: '',
            fontUrl: '',
            fontUrls: [],
        });
    });
});
