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
    const on = vi.fn();
    (globalThis as any).useSocketIOStore = () => ({ emit, on });
    return { emit, on };
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

beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);

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
        expect(playStateEmits()[0]![1]).toEqual({ isPlaying: true });
    });

    it('播放时按空格暂停并广播状态', () => {
        store().isPlaying = true;

        const event = pressKey();

        expect(store().isPlaying).toBe(false);
        expect(event.defaultPrevented).toBe(true);

        const emits = playStateEmits();
        expect(emits[emits.length - 1]![1]).toEqual({ isPlaying: false });
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

        store().selectedFile = { ...testFile, id: 'another-song', name: 'another-song' };
        await nextTick();
        await nextTick();

        const playhead = wrapper!.find('.playhead').element as HTMLElement;
        expect(playhead.style.left).toBe('0%');
    });
});
