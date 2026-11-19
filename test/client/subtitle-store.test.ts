import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { toRaw } from 'vue';
import { useSubtitleStore } from '../../stores/subtitle';
import type { FontOption, SubtitleFile } from '../../types/subtitle';

// store 依赖 Nuxt 自动导入的 socket store，这里提供可触发事件的替身
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
    blocks: [{ id: 'test-song-1', startTime: 0, endTime: 5, text: 'line 1', track: 1 }],
    createdAt: '',
    updatedAt: '',
};

const otherFile: SubtitleFile = {
    ...testFile,
    id: 'other-song',
    name: 'other-song',
};

const FONT_OPTIONS: FontOption[] = [
    {
        familyName: 'HarmonyOS Sans SC',
        fileName: 'HarmonyOS_Sans_SC_Regular.ttf',
        url: '/api/font-file/harmony-regular',
        urls: ['/api/font-file/harmony-regular', '/api/font-file/harmony-bold'],
        aliases: ['HarmonyOS Sans SC'],
    },
];

let pinia: Pinia;
let store: ReturnType<typeof useSubtitleStore>;

const emitCalls = (eventName: string) =>
    socketMock.emit.mock.calls.filter(([name]) => name === eventName);

const trigger = (eventName: string, ...args: unknown[]) => {
    for (const handler of socketMock.handlers.get(eventName) ?? []) {
        handler(...args);
    }
};

beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);

    socketMock.handlers.clear();
    socketMock.on.mockClear();
    socketMock.emit.mockClear();

    store = useSubtitleStore(pinia);
    store.fontOptions = FONT_OPTIONS;
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('控制端注册与快照', () => {
    it('连接后登记为控制端', () => {
        trigger('connect');

        expect(emitCalls('register')).toEqual([['register', { role: 'control' }]]);
    });

    it('应用服务端快照：文件、进度、播放状态与字体', () => {
        trigger('state-sync', {
            selectedFile: testFile,
            isPlaying: true,
            currentTime: 12.5,
            duration: 30,
            serverTime: Date.now(),
            fontFile: 'HarmonyOS_Sans_SC_Regular.ttf',
            fontFamily: 'HarmonyOS Sans SC',
            fontUrl: '/api/font-file/harmony-regular',
            fontUrls: ['/api/font-file/harmony-regular'],
        });

        expect(store.selectedFile?.id).toBe('test-song');
        expect(store.currentTime).toBe(12.5);
        expect(store.isPlaying).toBe(true);
        expect(store.selectedFont).toBe('HarmonyOS Sans SC');
        expect(store.seekVersion).toBe(1);
        // 应用远端状态不能再广播，否则多控制端会互相回环
        expect(socketMock.emit).not.toHaveBeenCalled();
    });

    it('同一首歌重连时保留文件对象，避免重置时间轴视图', () => {
        store.selectedFile = testFile;
        store.currentTime = 7;

        trigger('state-sync', {
            selectedFile: { ...testFile },
            isPlaying: false,
            currentTime: 7,
            duration: 30,
        });

        expect(toRaw(store.selectedFile!)).toBe(testFile);
        expect(store.currentTime).toBe(7);
    });

    it('服务端没有会话时用本地状态重新播种', () => {
        store.selectedFile = testFile;
        store.currentTime = 9;
        store.selectedFont = 'HarmonyOS Sans SC';
        socketMock.emit.mockClear();

        trigger('state-sync', {
            selectedFile: null,
            isPlaying: false,
            currentTime: 0,
            duration: 0,
            fontFamily: '',
        });

        expect(emitCalls('file-selected')).toHaveLength(1);
        expect(emitCalls('file-selected')[0]![1]).toMatchObject({
            file: testFile,
            fontFamily: 'HarmonyOS Sans SC',
        });
        expect(emitCalls('play-state-change')).toEqual([
            ['play-state-change', { isPlaying: false, currentTime: 9 }],
        ]);
    });

    it('服务端快照优先于本地状态', () => {
        store.selectedFile = otherFile;

        trigger('state-sync', {
            selectedFile: testFile,
            isPlaying: false,
            currentTime: 0,
            duration: 30,
        });

        expect(store.selectedFile?.id).toBe('test-song');
        expect(emitCalls('file-selected')).toHaveLength(0);
    });
});

describe('应用其它控制端的操作', () => {
    it('其它控制端选择文件时同步文件与字体，但不回发', () => {
        trigger('file-selected', {
            file: testFile,
            fontFamily: 'HarmonyOS Sans SC',
        });

        expect(store.selectedFile?.id).toBe('test-song');
        expect(store.currentTime).toBe(0);
        expect(store.isPlaying).toBe(false);
        expect(store.selectedFont).toBe('HarmonyOS Sans SC');
        expect(socketMock.emit).not.toHaveBeenCalled();
    });

    it('其它控制端播放/暂停时同步播放状态与精确进度', () => {
        store.selectedFile = testFile;

        trigger('play-state-change', { isPlaying: true, currentTime: 5 });
        expect(store.isPlaying).toBe(true);
        expect(store.currentTime).toBe(5);

        trigger('play-state-change', { isPlaying: false, currentTime: 8.25 });
        expect(store.isPlaying).toBe(false);
        expect(store.currentTime).toBe(8.25);
        expect(store.seekVersion).toBe(2);
        expect(socketMock.emit).not.toHaveBeenCalled();
    });

    it('其它控制端跳转时同步进度并递增 seekVersion', () => {
        store.selectedFile = testFile;

        trigger('time-sync', { currentTime: 15 });

        expect(store.currentTime).toBe(15);
        expect(store.seekVersion).toBe(1);
        expect(socketMock.emit).not.toHaveBeenCalled();
    });

    it('其它控制端切换字体时同步字体下拉，但不回发', () => {
        trigger('font-change', {
            fontFamily: 'HarmonyOS Sans SC',
            fontUrls: ['/api/font-file/harmony-regular'],
        });

        expect(store.selectedFont).toBe('HarmonyOS Sans SC');
        expect(socketMock.emit).not.toHaveBeenCalled();
    });
});

describe('本地操作广播', () => {
    it('播放时携带当前进度，暂停时可携带精确锚点', () => {
        store.selectedFile = testFile;
        store.currentTime = 3;

        store.play();
        expect(emitCalls('play-state-change')).toEqual([
            ['play-state-change', { isPlaying: true, currentTime: 3 }],
        ]);

        store.pause(7.5);
        expect(emitCalls('play-state-change').at(-1)).toEqual([
            'play-state-change',
            { isPlaying: false, currentTime: 7.5 },
        ]);
        expect(store.currentTime).toBe(7.5);
    });

    it('显式跳转会广播，播放过程中的本地推进不广播', () => {
        store.selectedFile = testFile;

        store.updatePlaybackTime(4.2);
        expect(store.currentTime).toBe(4.2);
        expect(emitCalls('time-sync')).toHaveLength(0);

        store.setCurrentTime(9.5);
        expect(emitCalls('time-sync')).toEqual([['time-sync', { currentTime: 9.5 }]]);
    });

    it('选择文件时携带全局字体并重置播放状态', () => {
        store.selectedFont = 'HarmonyOS Sans SC';

        store.selectFile(testFile);

        expect(emitCalls('file-selected')).toEqual([
            [
                'file-selected',
                {
                    file: testFile,
                    fontFile: 'HarmonyOS_Sans_SC_Regular.ttf',
                    fontFamily: 'HarmonyOS Sans SC',
                    fontUrl: '/api/font-file/harmony-regular',
                    fontUrls: ['/api/font-file/harmony-regular', '/api/font-file/harmony-bold'],
                },
            ],
        ]);
        expect(store.currentTime).toBe(0);
        expect(store.isPlaying).toBe(false);
    });

    it('进度与播放操作在未选择文件时被忽略', () => {
        store.play();
        store.pause(5);
        store.setCurrentTime(5);
        store.updatePlaybackTime(5);

        expect(store.currentTime).toBe(0);
        expect(store.isPlaying).toBe(false);
        expect(socketMock.emit).not.toHaveBeenCalled();
    });
});
