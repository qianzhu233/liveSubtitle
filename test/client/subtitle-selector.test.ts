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
    (globalThis as any).useSocketIOStore = () => ({ emit });
    return { emit };
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
        fileName: 'FZFWZhuZiAYuanJWB.TTF',
        familyName: 'FZFW ZhuZi A YuanS',
        url: '/fonts/FZFWZhuZiAYuanJWB.TTF',
    },
    {
        fileName: 'TsukushiAMaruGothic.ttc',
        familyName: 'Tsukushi A Round Gothic',
        url: '/fonts/TsukushiAMaruGothic.ttc',
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

beforeEach(async () => {
    pinia = createPinia();
    setActivePinia(pinia);

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

    it('字体下拉选项来自 /api/font-options 且在挂载后加载', () => {
        const store = useSubtitleStore(pinia);

        expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/font-options')).toBe(
            true,
        );
        expect(store.fontOptions).toHaveLength(2);
        expect(store.subtitleFiles).toHaveLength(1);

        const fontSelect = wrapper!.find('select.font-select');
        expect(fontSelect.exists()).toBe(true);

        const optionTexts = fontSelect.findAll('option').map((option) => option.text());
        expect(optionTexts[0]).toBe('默认（原样式）');
        expect(optionTexts).toContain('FZFW ZhuZi A YuanS');
        expect(optionTexts).toContain('Tsukushi A Round Gothic');
    });

    it('选择文件时下发原始 ASS（颜色不改写），并携带当前全局字体', async () => {
        const store = useSubtitleStore(pinia);
        store.selectedFont = 'Tsukushi A Round Gothic';
        socketMock.emit.mockClear();

        store.selectFile(testFile);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await flushAll();

        const fileSelectedCalls = emitCalls('file-selected');
        expect(fileSelectedCalls).toHaveLength(1);
        expect(fileSelectedCalls[0]![1]).toMatchObject({
            file: testFile,
            fontFamily: 'Tsukushi A Round Gothic',
        });

        const assUpdateCalls = emitCalls('ass-content-update');
        expect(assUpdateCalls).toHaveLength(1);
        expect((assUpdateCalls[0]![1] as { assContent: string }).assContent).toBe(ASS_CONTENT);
    });
});

describe('SubtitleSelector 字体全局切换', () => {
    it('修改字体下拉后发出 font-change 事件（不再重发 ASS），并移走焦点', async () => {
        const store = useSubtitleStore(pinia);
        socketMock.emit.mockClear();

        const fontSelect = wrapper!.find('select.font-select');
        (fontSelect.element as HTMLSelectElement).focus();
        expect(document.activeElement).toBe(fontSelect.element);

        await fontSelect.setValue('FZFW ZhuZi A YuanS');
        await flushAll();

        expect(store.selectedFont).toBe('FZFW ZhuZi A YuanS');
        expect(emitCalls('font-change')).toHaveLength(1);
        expect(emitCalls('font-change')[0]![1]).toEqual({ fontFamily: 'FZFW ZhuZi A YuanS' });
        // 字体由展示端全局应用，切换字体时不需要重新发送 ASS
        expect(emitCalls('ass-content-update')).toHaveLength(0);
        // 焦点已离开下拉框，空格键可以继续用于暂停
        expect((document.activeElement as HTMLElement | null)?.tagName).toBe('BODY');
    });

    it('切回「默认（原样式）」时发出空字体事件', async () => {
        const store = useSubtitleStore(pinia);
        const fontSelect = wrapper!.find('select.font-select');

        await fontSelect.setValue('Tsukushi A Round Gothic');
        await flushAll();
        socketMock.emit.mockClear();

        await fontSelect.setValue('');
        await flushAll();

        expect(store.selectedFont).toBe('');
        expect(emitCalls('font-change')).toHaveLength(1);
        expect(emitCalls('font-change')[0]![1]).toEqual({ fontFamily: '' });
    });
});
