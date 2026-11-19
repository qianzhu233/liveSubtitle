import { describe, it, expect } from 'vitest';
import {
    advancePlayback,
    applyFileSelected,
    applyFontChange,
    applyPlayStateChange,
    applyTimeSync,
    applyVisibilityChange,
    createSessionState,
    createSnapshot,
    projectCurrentTime,
} from '../../server/utils/session';
import type { SubtitleFile } from '../../types/subtitle';

const testFile: SubtitleFile = {
    id: 'song',
    name: 'song',
    duration: 100,
    blocks: [],
    createdAt: '',
    updatedAt: '',
};

const filePayload = {
    file: testFile,
    fontFile: 'regular.ttf',
    fontFamily: 'Test Font',
    fontUrl: '/api/font-file/regular',
    fontUrls: ['/api/font-file/regular', '/api/font-file/bold'],
};

describe('会话状态：字幕文件', () => {
    it('选择文件时重置进度/播放状态并保存字体', () => {
        const state = createSessionState();
        state.currentTime = 30;
        state.isPlaying = true;
        state.subtitlesHidden = true;

        expect(applyFileSelected(state, filePayload, 1000)).toBe(true);
        expect(state.selectedFile).toBe(testFile);
        expect(state.currentTime).toBe(0);
        expect(state.isPlaying).toBe(false);
        expect(state.subtitlesHidden).toBe(false);
        expect(state.anchorAt).toBe(1000);
        expect(state.font).toEqual({
            fontFile: 'regular.ttf',
            fontFamily: 'Test Font',
            fontUrl: '/api/font-file/regular',
            fontUrls: ['/api/font-file/regular', '/api/font-file/bold'],
        });
        expect(state.revision).toBe(1);
    });

    it('忽略没有有效 id 的文件负载', () => {
        const state = createSessionState();

        expect(applyFileSelected(state, {}, 1000)).toBe(false);
        expect(applyFileSelected(state, { file: { name: 'x' } }, 1000)).toBe(false);
        expect(state.selectedFile).toBeNull();
        expect(state.revision).toBe(0);
    });
});

describe('会话状态：播放锚点', () => {
    it('播放中按服务端时间外推进度', () => {
        const state = createSessionState();
        applyFileSelected(state, filePayload, 0);
        applyPlayStateChange(state, { isPlaying: true, currentTime: 10 }, 1000);

        expect(projectCurrentTime(state, 1000)).toBe(10);
        expect(projectCurrentTime(state, 3500)).toBe(12.5);
        expect(createSnapshot(state, 3500).currentTime).toBe(12.5);
    });

    it('暂停时冻结在外推进度，之后不再变化', () => {
        const state = createSessionState();
        applyFileSelected(state, filePayload, 0);
        applyPlayStateChange(state, { isPlaying: true, currentTime: 10 }, 1000);

        applyPlayStateChange(state, { isPlaying: false }, 3000);
        expect(state.currentTime).toBe(12);
        expect(projectCurrentTime(state, 9000)).toBe(12);
        expect(createSnapshot(state, 9000).isPlaying).toBe(false);
    });

    it('显式传入的进度优先于外推值', () => {
        const state = createSessionState();
        applyFileSelected(state, filePayload, 0);
        applyPlayStateChange(state, { isPlaying: true, currentTime: 10 }, 1000);

        applyPlayStateChange(state, { isPlaying: true, currentTime: 40 }, 2000);
        expect(projectCurrentTime(state, 2000)).toBe(40);
    });

    it('进度不会越过字幕时长', () => {
        const state = createSessionState();
        applyFileSelected(state, filePayload, 0);
        applyPlayStateChange(state, { isPlaying: true, currentTime: 99 }, 1000);

        expect(projectCurrentTime(state, 10000)).toBe(100);
        expect(createSnapshot(state, 10000).currentTime).toBe(100);
    });

    it('未选择文件时不接受播放状态/时间同步', () => {
        const state = createSessionState();

        expect(applyPlayStateChange(state, { isPlaying: true, currentTime: 5 })).toBe(false);
        expect(applyTimeSync(state, { currentTime: 5 })).toBe(false);
        expect(state.isPlaying).toBe(false);
        expect(state.currentTime).toBe(0);
    });
});

describe('会话状态：显式跳转', () => {
    it('跳转更新锚点并夹取到合法范围', () => {
        const state = createSessionState();
        applyFileSelected(state, filePayload, 0);

        expect(applyTimeSync(state, { currentTime: 25.5 }, 1000)).toBe(true);
        expect(state.currentTime).toBe(25.5);
        expect(state.anchorAt).toBe(1000);
        expect(projectCurrentTime(state, 5000)).toBe(25.5);

        applyTimeSync(state, { currentTime: -3 }, 6000);
        expect(state.currentTime).toBe(0);

        applyTimeSync(state, { currentTime: 999 }, 7000);
        expect(state.currentTime).toBe(100);
    });

    it('非数字进度被忽略', () => {
        const state = createSessionState();
        applyFileSelected(state, filePayload, 0);
        const revision = state.revision;

        expect(applyTimeSync(state, { currentTime: 'abc' }, 1000)).toBe(false);
        expect(state.revision).toBe(revision);
    });
});

describe('会话状态：全局字体', () => {
    it('保存字体负载与全部字重文件', () => {
        const state = createSessionState();

        expect(applyFontChange(state, filePayload)).toBe(true);
        expect(state.font.fontFamily).toBe('Test Font');
        expect(state.font.fontUrls).toEqual(['/api/font-file/regular', '/api/font-file/bold']);
    });

    it('只有单个 fontUrl 时自动补成数组，空字体表示跟随原字幕', () => {
        const state = createSessionState();
        applyFontChange(state, {
            fontFamily: 'Single',
            fontUrl: '/api/font-file/single',
        });
        expect(state.font.fontUrls).toEqual(['/api/font-file/single']);

        applyFontChange(state, { fontFamily: '' });
        expect(state.font).toEqual({
            fontFile: '',
            fontFamily: '',
            fontUrl: '',
            fontUrls: [],
        });
    });
});

describe('会话状态：临时隐藏字幕', () => {
    it('隐藏/恢复只改变可见性，状态变化时递增版本', () => {
        const state = createSessionState();
        applyFileSelected(state, filePayload, 0);
        const revision = state.revision;
        const currentTime = state.currentTime;
        const isPlaying = state.isPlaying;

        expect(state.subtitlesHidden).toBe(false);
        expect(applyVisibilityChange(state, { hidden: true })).toBe(true);
        expect(state.subtitlesHidden).toBe(true);
        expect(state.revision).toBe(revision + 1);
        expect(state.currentTime).toBe(currentTime);
        expect(state.isPlaying).toBe(isPlaying);
        expect(createSnapshot(state, 0).subtitlesHidden).toBe(true);

        expect(applyVisibilityChange(state, { hidden: true })).toBe(false);
        expect(applyVisibilityChange(state, { hidden: false })).toBe(true);
        expect(state.subtitlesHidden).toBe(false);
        expect(createSnapshot(state, 0).subtitlesHidden).toBe(false);
    });

    it('没有选择字幕文件时忽略', () => {
        const state = createSessionState();

        expect(applyVisibilityChange(state, { hidden: true })).toBe(false);
        expect(state.subtitlesHidden).toBe(false);
        expect(state.revision).toBe(0);
    });

    it('切换字幕文件后恢复显示', () => {
        const state = createSessionState();
        applyFileSelected(state, filePayload, 0);
        applyVisibilityChange(state, { hidden: true });

        applyFileSelected(state, filePayload, 1000);

        expect(state.subtitlesHidden).toBe(false);
        expect(createSnapshot(state, 1000).subtitlesHidden).toBe(false);
    });
});

describe('服务端时钟推进', () => {
    it('播放中返回外推时间', () => {
        const state = createSessionState();
        applyFileSelected(state, filePayload, 0);
        applyPlayStateChange(state, { isPlaying: true, currentTime: 10 }, 1000);

        const tick = advancePlayback(state, 2500);
        expect(tick).toEqual({ isPlaying: true, currentTime: 11.5, finished: false });
        expect(state.isPlaying).toBe(true);
    });

    it('到达结尾时回到起点并标记结束', () => {
        const state = createSessionState();
        applyFileSelected(state, filePayload, 0);
        applyPlayStateChange(state, { isPlaying: true, currentTime: 99 }, 1000);

        const tick = advancePlayback(state, 5000);
        expect(tick).toEqual({ isPlaying: false, currentTime: 0, finished: true });
        expect(state.isPlaying).toBe(false);
        expect(state.currentTime).toBe(0);
        expect(createSnapshot(state, 6000).currentTime).toBe(0);
    });

    it('暂停状态下推进不会改变进度', () => {
        const state = createSessionState();
        applyFileSelected(state, filePayload, 0);
        applyTimeSync(state, { currentTime: 20 }, 1000);

        expect(advancePlayback(state, 5000)).toEqual({
            isPlaying: false,
            currentTime: 20,
            finished: false,
        });
    });
});

describe('会话快照', () => {
    it('包含文件、字体、播放状态与服务端时间，且不修改状态', () => {
        const state = createSessionState();
        applyFileSelected(state, filePayload, 0);
        applyPlayStateChange(state, { isPlaying: true, currentTime: 10 }, 1000);
        const revision = state.revision;
        const anchorAt = state.anchorAt;

        const snapshot = createSnapshot(state, 3000);
        expect(snapshot).toMatchObject({
            selectedFile: testFile,
            isPlaying: true,
            currentTime: 12,
            duration: 100,
            subtitlesHidden: false,
            serverTime: 3000,
            fontFile: 'regular.ttf',
            fontFamily: 'Test Font',
            fontUrl: '/api/font-file/regular',
            fontUrls: ['/api/font-file/regular', '/api/font-file/bold'],
        });
        expect(state.revision).toBe(revision);
        expect(state.anchorAt).toBe(anchorAt);
    });

    it('空会话返回空文件与零进度', () => {
        const state = createSessionState();

        expect(createSnapshot(state, 1234)).toMatchObject({
            selectedFile: null,
            isPlaying: false,
            currentTime: 0,
            duration: 0,
            subtitlesHidden: false,
            serverTime: 1234,
            fontFamily: '',
        });
    });
});
