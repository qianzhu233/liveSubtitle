// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import Timeline from '../../components/Timeline.vue';
import { useSubtitleStore } from '../../stores/subtitle';
import type { SubtitleFile } from '../../types/subtitle';

// Timeline 依赖 Nuxt 自动导入的 socket store，这里提供一个最小替身
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
        { id: 'test-song-3', startTime: 12, endTime: 14, text: 'track2 line', track: 2 },
        { id: 'test-song-4', startTime: 16, endTime: 18, text: 'track2 line 2', track: 2 },
    ],
    createdAt: '',
    updatedAt: '',
};

let pinia: Pinia;
let wrapper: VueWrapper | null = null;

const store = () => useSubtitleStore(pinia);

const pressKey = (init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
    const event = new KeyboardEvent('keydown', {
        code: 'Space',
        key: ' ',
        bubbles: true,
        cancelable: true,
        ...init,
    });
    target.dispatchEvent(event);
    return event;
};

const playStateEmits = () =>
    socketMock.emit.mock.calls.filter(([eventName]) => eventName === 'play-state-change');

const timeSyncEmits = () =>
    socketMock.emit.mock.calls.filter(([eventName]) => eventName === 'time-sync');

const visibilityEmits = () =>
    socketMock.emit.mock.calls.filter(([eventName]) => eventName === 'subtitle-visibility-change');

const trigger = (eventName: string, ...args: unknown[]) => {
    for (const handler of socketMock.handlers.get(eventName) ?? []) {
        handler(...args);
    }
};

const shortcutButton = (name: string) => wrapper!.get(`[data-shortcut="${name}"]`);

beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);

    socketMock.handlers.clear();
    socketMock.on.mockClear();
    socketMock.emit.mockClear();

    const subtitleStore = useSubtitleStore(pinia);
    subtitleStore.selectedFile = { ...testFile };
    subtitleStore.isPlaying = false;
    subtitleStore.currentTime = 0;

    wrapper = mount(Timeline, { global: { plugins: [pinia] } });
});

afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
});

describe('Timeline 空格键播放控制', () => {
    it('暂停时按空格开始播放并广播状态', () => {
        const event = pressKey();

        expect(store().isPlaying).toBe(true);
        expect(event.defaultPrevented).toBe(true);
        expect(playStateEmits()).toHaveLength(1);
        expect(playStateEmits()[0]![1]).toEqual({ isPlaying: true, currentTime: 0 });
    });

    it('播放时按空格暂停并广播精确进度', () => {
        store().isPlaying = true;

        const event = pressKey();

        expect(store().isPlaying).toBe(false);
        expect(event.defaultPrevented).toBe(true);

        const payload = playStateEmits().at(-1)![1] as Record<string, unknown>;
        expect(payload).toMatchObject({ isPlaying: false });
        expect(payload.currentTime).toBeCloseTo(0, 3);
    });

    it('焦点在搜索框等输入控件时不拦截空格', () => {
        const input = document.createElement('input');
        input.className = 'search-input';
        document.body.appendChild(input);

        const event = pressKey({}, input);

        expect(store().isPlaying).toBe(false);
        expect(playStateEmits()).toHaveLength(0);
        expect(event.defaultPrevented).toBe(false);

        input.remove();
    });

    it('焦点在按钮上时不拦截空格，保留按钮自身行为', () => {
        const button = document.createElement('button');
        document.body.appendChild(button);

        const event = pressKey({}, button);

        expect(store().isPlaying).toBe(false);
        expect(playStateEmits()).toHaveLength(0);
        expect(event.defaultPrevented).toBe(false);

        button.remove();
    });

    it('长按重复触发、输入法组合与修饰键组合不切换播放状态', () => {
        pressKey({ repeat: true });
        pressKey({ isComposing: true });
        pressKey({ ctrlKey: true });

        expect(store().isPlaying).toBe(false);
        expect(playStateEmits()).toHaveLength(0);
    });

    it('未选择字幕文件时按空格不改变播放状态', () => {
        store().selectedFile = null;

        pressKey();

        expect(store().isPlaying).toBe(false);
        expect(playStateEmits()).toHaveLength(0);
    });

    it('其它按键不触发播放/暂停', () => {
        pressKey({ code: 'Enter', key: 'Enter' });

        expect(store().isPlaying).toBe(false);
        expect(playStateEmits()).toHaveLength(0);
    });
});

describe('Timeline 播放头', () => {
    it('时间变化时直接更新播放头位置', async () => {
        store().setCurrentTime(15);
        await nextTick();

        const playhead = wrapper!.find('.playhead').element as HTMLElement;
        expect(playhead.style.left).toBe('50%');
    });

    it('切换文件后播放头回到起点', async () => {
        store().setCurrentTime(15);
        await nextTick();

        store().selectFile({ ...testFile, id: 'another-song', name: 'another-song' });
        await nextTick();
        await nextTick();

        const playhead = wrapper!.find('.playhead').element as HTMLElement;
        expect(playhead.style.left).toBe('0%');
    });
});

describe('Timeline 多控制端同步', () => {
    it('收到其它控制端暂停时不回发时间，避免事件回环', async () => {
        store().isPlaying = true;
        await nextTick();

        socketMock.emit.mockClear();
        trigger('play-state-change', { isPlaying: false, currentTime: 6 });
        await nextTick();

        expect(store().isPlaying).toBe(false);
        expect(store().currentTime).toBe(6);
        expect(timeSyncEmits()).toHaveLength(0);
        expect(playStateEmits()).toHaveLength(0);
    });

    it('收到其它控制端跳转时只更新本地进度，不回发', async () => {
        store().isPlaying = true;
        await nextTick();

        socketMock.emit.mockClear();
        trigger('time-sync', { currentTime: 20 });
        await nextTick();

        expect(store().currentTime).toBe(20);
        expect(timeSyncEmits()).toHaveLength(0);
    });

    it('收到其它控制端选文件时不重置播放状态回发', async () => {
        socketMock.emit.mockClear();
        trigger('file-selected', {
            file: { ...testFile, id: 'remote-song', name: 'remote-song' },
            fontFamily: '',
        });
        await nextTick();

        expect(store().selectedFile?.id).toBe('remote-song');
        expect(store().isPlaying).toBe(false);
        expect(playStateEmits()).toHaveLength(0);
        expect(timeSyncEmits()).toHaveLength(0);
    });
});

describe('Timeline 快捷键按钮', () => {
    const shortcuts = [
        'toggle-playback',
        'toggle-subtitles-left',
        'track1-prev',
        'track1-next',
        'toggle-subtitles-a',
        'track2-prev',
        'track2-next',
    ];

    it('每个键盘快捷键都有对应的按钮', () => {
        for (const shortcut of shortcuts) {
            expect(wrapper!.find(`[data-shortcut="${shortcut}"]`).exists()).toBe(true);
        }
    });

    it('点击播放按钮切换播放状态', async () => {
        await shortcutButton('toggle-playback').trigger('click');

        expect(store().isPlaying).toBe(true);
        expect(playStateEmits()[0]![1]).toMatchObject({ isPlaying: true });

        await shortcutButton('toggle-playback').trigger('click');

        expect(store().isPlaying).toBe(false);
        expect(playStateEmits().at(-1)![1]).toMatchObject({ isPlaying: false });
    });

    it('点击轨道 1 下一条与按 ↓ 等价：跳到下一条并播放', async () => {
        store().currentTime = 2.5;

        await shortcutButton('track1-next').trigger('click');

        expect(store().currentTime).toBe(5);
        expect(store().isPlaying).toBe(true);
        expect(playStateEmits().at(-1)![1]).toEqual({ isPlaying: true, currentTime: 5 });
    });

    it('点击隐藏按钮暂时隐藏所有字幕，再点恢复，且不改变进度/播放状态', async () => {
        store().currentTime = 2.5;
        store().isPlaying = true;
        await nextTick();

        const leftButton = shortcutButton('toggle-subtitles-left');
        const aButton = shortcutButton('toggle-subtitles-a');

        expect(leftButton.text()).toContain('隐藏');

        await leftButton.trigger('click');

        expect(store().subtitlesHidden).toBe(true);
        expect(store().currentTime).toBe(2.5);
        expect(store().isPlaying).toBe(true);
        expect(timeSyncEmits()).toHaveLength(0);
        expect(visibilityEmits()).toEqual([['subtitle-visibility-change', { hidden: true }]]);
        expect(leftButton.text()).toContain('显示');
        expect(aButton.text()).toContain('显示');

        await aButton.trigger('click');

        expect(store().subtitlesHidden).toBe(false);
        expect(store().currentTime).toBe(2.5);
        expect(store().isPlaying).toBe(true);
        expect(visibilityEmits().at(-1)).toEqual(['subtitle-visibility-change', { hidden: false }]);
    });

    it('点击轨道 1 上一条与按 ↑ 等价：导航到上一条字幕并播放', async () => {
        store().currentTime = 7;

        await shortcutButton('track1-prev').trigger('click');

        expect(store().currentTime).toBe(0);
        expect(store().isPlaying).toBe(true);
        expect(playStateEmits().at(-1)![1]).toEqual({ isPlaying: true, currentTime: 0 });
    });

    it('没有上一条字幕时不动作', async () => {
        store().currentTime = 2.5;

        await shortcutButton('track1-prev').trigger('click');

        expect(store().currentTime).toBe(2.5);
        expect(store().isPlaying).toBe(false);
        expect(playStateEmits()).toHaveLength(0);
        expect(timeSyncEmits()).toHaveLength(0);
    });

    it('点击轨道 2 上一条/下一条导航到轨道 2 的相邻字幕', async () => {
        store().currentTime = 17;

        await shortcutButton('track2-prev').trigger('click');
        expect(store().currentTime).toBe(12);
        expect(store().isPlaying).toBe(true);

        store().currentTime = 11;
        await shortcutButton('track2-next').trigger('click');
        expect(store().currentTime).toBe(12);
        expect(store().isPlaying).toBe(true);
    });

    it('没有选择字幕文件时按钮禁用', async () => {
        store().selectedFile = null;
        await nextTick();

        expect(shortcutButton('track1-next').attributes('disabled')).toBeDefined();
        expect(shortcutButton('toggle-playback').attributes('disabled')).toBeDefined();
        expect(shortcutButton('toggle-subtitles-left').attributes('disabled')).toBeDefined();
    });
});

describe('Timeline 方向键与 W 键', () => {
    it('↑ 导航到上一条字幕并播放', () => {
        store().currentTime = 7;

        const event = pressKey({ code: 'ArrowUp', key: 'ArrowUp' });

        expect(store().currentTime).toBe(0);
        expect(store().isPlaying).toBe(true);
        expect(event.defaultPrevented).toBe(true);
    });

    it('W 导航到轨道 2 的上一条字幕并播放', () => {
        store().currentTime = 17;

        pressKey({ code: 'KeyW', key: 'w' });

        expect(store().currentTime).toBe(12);
        expect(store().isPlaying).toBe(true);
    });

    it('← 与 A 切换字幕隐藏状态，不改变进度与播放状态', () => {
        store().currentTime = 7;

        const left = pressKey({ code: 'ArrowLeft', key: 'ArrowLeft' });

        expect(left.defaultPrevented).toBe(true);
        expect(store().subtitlesHidden).toBe(true);
        expect(store().currentTime).toBe(7);
        expect(store().isPlaying).toBe(false);

        pressKey({ code: 'KeyA', key: 'a' });

        expect(store().subtitlesHidden).toBe(false);
        expect(store().currentTime).toBe(7);
        expect(store().isPlaying).toBe(false);
    });

    it('Ctrl+A 等组合键不触发快捷键', () => {
        store().currentTime = 13;

        pressKey({ code: 'KeyA', key: 'a', ctrlKey: true });

        expect(store().subtitlesHidden).toBe(false);
        expect(store().currentTime).toBe(13);
        expect(store().isPlaying).toBe(false);
        expect(playStateEmits()).toHaveLength(0);
    });
});
