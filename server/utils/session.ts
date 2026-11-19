import type { FontPayload, SessionSnapshot, SubtitleFile } from '../../types/subtitle';

/**
 * 服务端权威会话状态。
 *
 * 多控制端场景下，由服务端保存唯一的一份「当前字幕 / 播放状态 / 全局字体」，
 * 所有控制端只负责下发操作指令，展示端与控制端都从服务端拿到同一份状态，
 * 避免多个控制端各自维护状态导致互相覆盖。
 *
 * 播放进度不按帧写入状态，而是记录「某个时刻的进度」这个锚点：
 * 播放中按服务端时间外推，暂停时冻结，因此即使控制端页面在后台被节流，
 * 展示端和后来加入的控制端仍然能拿到准确的进度。
 */
export interface SessionState {
    selectedFile: SubtitleFile | null;
    font: FontPayload;
    isPlaying: boolean;
    /** 锚点时刻的播放进度（秒） */
    currentTime: number;
    /** 临时隐藏所有字幕渲染层；切换字幕文件时恢复显示 */
    subtitlesHidden: boolean;
    /** 锚点对应的服务端时间戳（ms） */
    anchorAt: number;
    /** 每次状态变更递增，便于排查事件乱序 */
    revision: number;
}

export const EMPTY_FONT_PAYLOAD: FontPayload = {
    fontFile: '',
    fontFamily: '',
    fontUrl: '',
    fontUrls: [],
};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const readFontPayload = (data: any): FontPayload => {
    const urls = Array.isArray(data?.fontUrls)
        ? data.fontUrls.filter(
              (url: unknown): url is string => typeof url === 'string' && url.length > 0,
          )
        : [];
    if (urls.length === 0 && typeof data?.fontUrl === 'string' && data.fontUrl) {
        urls.push(data.fontUrl);
    }

    return {
        fontFile: asString(data?.fontFile),
        fontFamily: asString(data?.fontFamily),
        fontUrl: asString(data?.fontUrl),
        fontUrls: urls,
    };
};

const durationOf = (state: SessionState): number => state.selectedFile?.duration ?? 0;

const clampTime = (time: number, duration: number): number => {
    if (!Number.isFinite(time)) {
        return 0;
    }
    return Math.max(0, Math.min(time, duration));
};

export const createSessionState = (): SessionState => ({
    selectedFile: null,
    font: { ...EMPTY_FONT_PAYLOAD, fontUrls: [] },
    isPlaying: false,
    currentTime: 0,
    subtitlesHidden: false,
    anchorAt: 0,
    revision: 0,
});

/** 当前进度：播放中按锚点外推，暂停时沿用锚点值 */
export function projectCurrentTime(state: SessionState, now: number = Date.now()): number {
    if (!state.isPlaying) {
        return state.currentTime;
    }

    const elapsed = Math.max(0, now - state.anchorAt) / 1000;
    return clampTime(state.currentTime + elapsed, durationOf(state));
}

/** 选择字幕文件：重置进度并暂停，同时更新全局字体 */
export function applyFileSelected(
    state: SessionState,
    data: any,
    now: number = Date.now(),
): boolean {
    const file = data?.file as SubtitleFile | undefined;
    if (!file || typeof file.id !== 'string') {
        return false;
    }

    state.selectedFile = file;
    state.font = readFontPayload(data);
    state.isPlaying = false;
    state.currentTime = 0;
    // 新歌默认显示字幕，避免上一首的临时隐藏状态延续到下一首
    state.subtitlesHidden = false;
    state.anchorAt = now;
    state.revision++;
    return true;
}

/** 播放/暂停：优先采用控制端上报的当前进度，暂停时缺省取外推值 */
export function applyPlayStateChange(
    state: SessionState,
    data: any,
    now: number = Date.now(),
): boolean {
    if (!state.selectedFile) {
        return false;
    }

    const requested = Number(data?.currentTime);
    const fallback = projectCurrentTime(state, now);
    state.currentTime = clampTime(
        Number.isFinite(requested) ? requested : fallback,
        durationOf(state),
    );
    state.isPlaying = data?.isPlaying === true;
    state.anchorAt = now;
    state.revision++;
    return true;
}

/** 显式跳转（点击字幕块、微调时间、快捷键回退等） */
export function applyTimeSync(state: SessionState, data: any, now: number = Date.now()): boolean {
    if (!state.selectedFile) {
        return false;
    }

    const requested = Number(data?.currentTime);
    if (!Number.isFinite(requested)) {
        return false;
    }

    state.currentTime = clampTime(requested, durationOf(state));
    state.anchorAt = now;
    state.revision++;
    return true;
}

/** 全局字体切换；空字体族表示「跟随原字幕」 */
export function applyFontChange(state: SessionState, data: any): boolean {
    if (!data || typeof data !== 'object') {
        return false;
    }

    state.font = readFontPayload(data);
    state.revision++;
    return true;
}

/**
 * 临时隐藏/恢复所有字幕渲染层。
 * 只影响展示端的可见性，不改变播放进度与播放状态；没有字幕文件时忽略。
 */
export function applyVisibilityChange(state: SessionState, data: any): boolean {
    if (!state.selectedFile) {
        return false;
    }

    const hidden = data?.hidden === true;
    if (state.subtitlesHidden === hidden) {
        return false;
    }

    state.subtitlesHidden = hidden;
    state.revision++;
    return true;
}

/** 供新连接/重连客户端使用的完整快照（不会修改状态） */
export function createSnapshot(state: SessionState, now: number = Date.now()): SessionSnapshot {
    return {
        selectedFile: state.selectedFile,
        isPlaying: state.isPlaying,
        currentTime: projectCurrentTime(state, now),
        duration: durationOf(state),
        subtitlesHidden: state.subtitlesHidden,
        serverTime: now,
        ...state.font,
        fontUrls: [...state.font.fontUrls],
    };
}

export interface PlaybackTick {
    isPlaying: boolean;
    currentTime: number;
    /** 本次推进是否到达字幕结尾 */
    finished: boolean;
}

/**
 * 服务端时钟推进：播放中返回外推进度；到达结尾时按控制端原有行为回到起点并标记结束。
 * 这样即使控制端页面关闭或后台被节流，展示端仍能持续得到正确进度。
 */
export function advancePlayback(state: SessionState, now: number = Date.now()): PlaybackTick {
    if (!state.isPlaying || !state.selectedFile) {
        return { isPlaying: false, currentTime: state.currentTime, finished: false };
    }

    const duration = durationOf(state);
    const time = projectCurrentTime(state, now);
    if (duration > 0 && time >= duration) {
        state.isPlaying = false;
        // 与控制端 finishPlayback 保持一致：播放结束后回到起点
        state.currentTime = 0;
        state.anchorAt = now;
        state.revision++;
        return { isPlaying: false, currentTime: 0, finished: true };
    }

    return { isPlaying: true, currentTime: time, finished: false };
}
