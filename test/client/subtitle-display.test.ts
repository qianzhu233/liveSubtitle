// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import SubtitleDisplay from '../../pages/subtitle.vue';

// 展示端依赖 Nuxt 自动导入的 socket；这里提供可手动触发事件的替身
const socketMock = vi.hoisted(() => {
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const on = vi.fn((event: string, handler: (...args: any[]) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
    });
    const socket = {
        on,
        off: vi.fn(),
        emit: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        connected: false,
        id: 'display-test',
    };
    (globalThis as any).useSocketIO = () => socket;
    return { socket, handlers, on };
});

const trigger = (eventName: string, ...args: unknown[]) => {
    for (const handler of socketMock.handlers.get(eventName) ?? []) {
        handler(...args);
    }
};

let wrapper: VueWrapper | null = null;

beforeEach(() => {
    socketMock.handlers.clear();
    socketMock.on.mockClear();
    wrapper = mount(SubtitleDisplay);
});

afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
});

describe('展示端字幕可见性', () => {
    it('默认显示字幕画布', () => {
        const canvas = wrapper!.get('.subtitle-canvas');

        expect(canvas.classes()).not.toContain('subtitle-canvas-hidden');
    });

    it('收到隐藏事件后隐藏画布，恢复后重新显示', async () => {
        const canvas = wrapper!.get('.subtitle-canvas');

        trigger('subtitle-visibility-change', { hidden: true });
        await nextTick();
        expect(canvas.classes()).toContain('subtitle-canvas-hidden');

        trigger('subtitle-visibility-change', { hidden: false });
        await nextTick();
        expect(canvas.classes()).not.toContain('subtitle-canvas-hidden');
    });

    it('服务端快照中的隐藏状态同样生效', async () => {
        const canvas = wrapper!.get('.subtitle-canvas');

        trigger('state-sync', {
            selectedFile: null,
            isPlaying: false,
            currentTime: 0,
            subtitlesHidden: true,
        });
        await nextTick();

        expect(canvas.classes()).toContain('subtitle-canvas-hidden');
    });
});
