<template>
    <div class="timeline-container">
        <div class="timeline-scroll-container">
            <div
                class="timeline-ruler"
                :style="{
                    width: `${((selectedFile?.duration || 100) / maxDuration) * 100}%`,
                }"
            >
                <div
                    v-for="tick in timeTicks"
                    :key="tick"
                    class="time-tick"
                    :style="{
                        left: `${(tick / (selectedFile?.duration || 100)) * 100}%`,
                    }"
                >
                    <div class="tick-line"></div>
                    <span class="tick-label">{{ formatTime(tick) }}</span>
                </div>
            </div>

            <div
                class="tracks-container"
                :style="{
                    width: `${((selectedFile?.duration || 100) / maxDuration) * 100}%`,
                }"
            >
                <div class="track track-1">
                    <div class="track-content">
                        <div
                            v-for="block in track1Blocks"
                            v-memo="[isBlockActive(block)]"
                            :key="block.id"
                            class="subtitle-block block-track1"
                            :class="{ 'block-active': isBlockActive(block) }"
                            :style="{
                                left: `${(block.startTime / (selectedFile?.duration || 100)) * 100}%`,
                                width: `${((block.endTime - block.startTime) / (selectedFile?.duration || 100)) * 100}%`,
                            }"
                            @click="seekToTime(block.startTime)"
                        >
                            <span class="block-text">{{ block.text }}</span>
                        </div>
                    </div>
                </div>

                <div class="track track-2">
                    <div class="track-content">
                        <div
                            v-for="block in track2Blocks"
                            v-memo="[isBlockActive(block)]"
                            :key="block.id"
                            class="subtitle-block block-track2"
                            :class="{ 'block-active': isBlockActive(block) }"
                            :style="{
                                left: `${(block.startTime / (selectedFile?.duration || 100)) * 100}%`,
                                width: `${((block.endTime - block.startTime) / (selectedFile?.duration || 100)) * 100}%`,
                            }"
                            @click="seekToTime(block.startTime)"
                        >
                            <span class="block-text">{{ block.text }}</span>
                        </div>
                    </div>
                </div>

                <div v-if="selectedFile" ref="playheadRef" class="playhead">
                    <div class="playhead-handle"></div>
                </div>
            </div>
        </div>

        <div class="time-controls">
            <div class="current-time-display">
                <span class="time-label">当前时间:</span>
                <span class="time-value">{{ formatTimeWithMs(currentTime) }}</span>
            </div>
            <div class="time-adjustment">
                <button @click="adjustTime(-0.1)" class="time-btn" title="后退100ms">-100ms</button>
                <button @click="adjustTime(-0.05)" class="time-btn" title="后退50ms">-50ms</button>
                <button @click="adjustTime(0.05)" class="time-btn" title="前进50ms">+50ms</button>
                <button @click="adjustTime(0.1)" class="time-btn" title="前进100ms">+100ms</button>
            </div>
        </div>

        <div class="shortcut-controls" aria-label="快捷键按钮">
            <span class="shortcut-heading">快捷键</span>

            <button
                type="button"
                class="shortcut-btn shortcut-btn-play"
                data-shortcut="toggle-playback"
                :disabled="!selectedFile"
                :title="isPlaying ? '暂停（空格）' : '播放（空格）'"
                @click="runShortcut(togglePlayback)"
            >
                <kbd class="shortcut-key">空格</kbd>
                <span>{{ isPlaying ? '暂停' : '播放' }}</span>
            </button>

            <span class="shortcut-divider" aria-hidden="true"></span>
            <span class="shortcut-group-label">轨道 1</span>

            <button
                type="button"
                class="shortcut-btn"
                :class="{ 'shortcut-btn-active': subtitlesHidden }"
                data-shortcut="toggle-subtitles-left"
                :disabled="!selectedFile"
                :title="subtitlesHidden ? '恢复显示所有字幕（←）' : '暂时隐藏所有字幕渲染层（←）'"
                @click="runShortcut(toggleSubtitlesHidden)"
            >
                <kbd class="shortcut-key">←</kbd>
                <span>{{ subtitlesHidden ? '显示' : '隐藏' }}</span>
            </button>
            <button
                type="button"
                class="shortcut-btn"
                data-shortcut="track1-prev"
                :disabled="!selectedFile"
                title="轨道 1：导航到上一条字幕并播放（↑）"
                @click="runShortcut(() => playPreviousBlock(1))"
            >
                <kbd class="shortcut-key">↑</kbd>
                <span>上一条</span>
            </button>
            <button
                type="button"
                class="shortcut-btn"
                data-shortcut="track1-next"
                :disabled="!selectedFile"
                title="轨道 1：播放下一条字幕（↓）"
                @click="runShortcut(() => playNextBlock(1))"
            >
                <kbd class="shortcut-key">↓</kbd>
                <span>下一条</span>
            </button>

            <span class="shortcut-divider" aria-hidden="true"></span>
            <span class="shortcut-group-label">轨道 2</span>

            <button
                type="button"
                class="shortcut-btn"
                :class="{ 'shortcut-btn-active': subtitlesHidden }"
                data-shortcut="toggle-subtitles-a"
                :disabled="!selectedFile"
                :title="subtitlesHidden ? '恢复显示所有字幕（A）' : '暂时隐藏所有字幕渲染层（A）'"
                @click="runShortcut(toggleSubtitlesHidden)"
            >
                <kbd class="shortcut-key">A</kbd>
                <span>{{ subtitlesHidden ? '显示' : '隐藏' }}</span>
            </button>
            <button
                type="button"
                class="shortcut-btn"
                data-shortcut="track2-prev"
                :disabled="!selectedFile"
                title="轨道 2：导航到上一条字幕并播放（W）"
                @click="runShortcut(() => playPreviousBlock(2))"
            >
                <kbd class="shortcut-key">W</kbd>
                <span>上一条</span>
            </button>
            <button
                type="button"
                class="shortcut-btn"
                data-shortcut="track2-next"
                :disabled="!selectedFile"
                title="轨道 2：播放下一条字幕（S）"
                @click="runShortcut(() => playNextBlock(2))"
            >
                <kbd class="shortcut-key">S</kbd>
                <span>下一条</span>
            </button>
        </div>

        <div class="zoom-controls">
            <button @click="zoomOut" class="zoom-btn">-</button>
            <span class="zoom-level">{{ Math.round(zoomLevel * 100) }}%</span>
            <button @click="zoomIn" class="zoom-btn">+</button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch, ref, nextTick } from 'vue';
import { useSubtitleStore } from '~/stores/subtitle';
import { isEditableTarget, isPlaybackToggleShortcut } from '~/utils/keyboard';
import type { SubtitleBlock } from '~/types/subtitle';

const store = useSubtitleStore();

const zoomLevel = ref(1);
const playheadRef = ref<HTMLDivElement | null>(null);

const selectedFile = computed(() => store.selectedFile);
const currentTime = computed(() => store.currentTime);
const isPlaying = computed(() => store.isPlaying);
const subtitlesHidden = computed(() => store.subtitlesHidden);

// 播放头直接写 DOM 位置，避免每个动画帧都触发整个时间轴（几百个字幕块）重新渲染
const updatePlayheadPosition = (time: number) => {
    if (!playheadRef.value || !selectedFile.value) return;
    const duration = selectedFile.value.duration || 100;
    const percent = Math.min(100, Math.max(0, (time / duration) * 100));
    playheadRef.value.style.left = `${percent}%`;
};

const maxDuration = computed(() => {
    if (!selectedFile.value) return 100;
    return selectedFile.value.duration / (zoomLevel.value * 6);
});

const timeTicks = computed(() => {
    if (!selectedFile.value) return [];

    const ticks = [];
    const totalDuration = selectedFile.value.duration;
    const interval = Math.max(1, Math.ceil(totalDuration / (zoomLevel.value * 20)));

    for (let i = 0; i <= totalDuration; i += interval) {
        ticks.push(i);
    }
    return ticks;
});

const track1Blocks = computed(
    () => selectedFile.value?.blocks.filter((block: SubtitleBlock) => block.track === 1) || [],
);

const track2Blocks = computed(
    () => selectedFile.value?.blocks.filter((block: SubtitleBlock) => block.track === 2) || [],
);

const formatTime = (seconds: number): string => {
    return store.formatTime(seconds);
};

const formatTimeWithMs = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);

    if (hours > 0) {
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
    } else {
        return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
    }
};

const isBlockActive = (block: SubtitleBlock): boolean => {
    return currentTime.value >= block.startTime && currentTime.value <= block.endTime;
};

const seekToTime = (time: number) => {
    store.setCurrentTime(time);
    store.play();
    realignPlaybackAnchor(time);
};

const zoomIn = () => {
    zoomLevel.value = Math.min(zoomLevel.value * 1.5, 3.33);
};

const zoomOut = () => {
    zoomLevel.value = Math.max(zoomLevel.value / 1.5, 0.083);
};

const adjustTime = (adjustment: number) => {
    if (!selectedFile.value) return;

    const newTime = Math.max(
        0,
        Math.min(selectedFile.value.duration, currentTime.value + adjustment),
    );
    store.setCurrentTime(newTime);
    realignPlaybackAnchor(newTime);
};

let playRafId: number | null = null;
let playSyncIntervalId: number | null = null;
let playStartTime: number | null = null;
let playStartCurrentTime: number | null = null;

// 播放头动画走 requestAnimationFrame，时间状态按低频写回 store：
// 既保证指针顺滑，又避免每帧重渲染几百个字幕块、每帧都发 socket。
const PLAYBACK_SYNC_INTERVAL_MS = 100;

const getPlaybackTime = (): number | null => {
    if (playStartTime === null || playStartCurrentTime === null) return null;
    return playStartCurrentTime + (performance.now() - playStartTime) / 1000;
};

const finishPlayback = () => {
    playStartTime = null;
    playStartCurrentTime = null;
    // 暂停并把进度归零一起广播，其它控制端/展示端才能同步回到起点
    store.pause(0);
};

// 每帧只改播放头 DOM，不触发整条时间轴重渲染
const animatePlayhead = () => {
    playRafId = null;

    if (!isPlaying.value || !selectedFile.value) return;

    const time = getPlaybackTime();
    if (time === null) return;
    if (time >= selectedFile.value.duration) {
        finishPlayback();
        return;
    }

    updatePlayheadPosition(time);
    playRafId = requestAnimationFrame(animatePlayhead);
};

// 低频同步时间/播放状态（页面在后台时 rAF 会暂停，这个定时器仍能让时间和展示端同步继续推进）
const syncPlaybackTime = () => {
    if (!isPlaying.value || !selectedFile.value) return;

    const time = getPlaybackTime();
    if (time === null) return;
    if (time >= selectedFile.value.duration) {
        finishPlayback();
        return;
    }

    store.updatePlaybackTime(time);
};

const startAutoPlay = () => {
    if (playRafId !== null || playSyncIntervalId !== null) return;

    playStartTime = performance.now();
    playStartCurrentTime = currentTime.value;
    playRafId = requestAnimationFrame(animatePlayhead);
    playSyncIntervalId = window.setInterval(syncPlaybackTime, PLAYBACK_SYNC_INTERVAL_MS);
};

const stopAutoPlay = () => {
    if (playRafId !== null) {
        cancelAnimationFrame(playRafId);
        playRafId = null;
    }
    if (playSyncIntervalId !== null) {
        clearInterval(playSyncIntervalId);
        playSyncIntervalId = null;
    }

    // 只清理本地播放锚点，不再回写/广播时间：
    // 远端暂停时这里若广播，会把本地锚点算出的旧时间发回服务端，形成回环。
    // 暂停所需的精确时间由 pause(time) 的调用方负责传入。
    playStartTime = null;
    playStartCurrentTime = null;
};

const startWatching = () => {
    if (isPlaying.value) {
        startAutoPlay();
    } else {
        stopAutoPlay();
    }
};

// 播放中主动跳转后必须重新对齐本地播放锚点，否则下一帧会用旧锚点把时间拉回去
const realignPlaybackAnchor = (time: number) => {
    if (playRafId === null) return;
    playStartTime = performance.now();
    playStartCurrentTime = time;
};

/** 快捷键公共动作：跳转并保持播放 */
const seekAndPlay = (time: number) => {
    store.setCurrentTime(time);
    store.play();
    realignPlaybackAnchor(time);
};

const trackBlocks = (track: 1 | 2): SubtitleBlock[] =>
    selectedFile.value?.blocks.filter((block: SubtitleBlock) => block.track === track) ?? [];

const isTimeInBlock = (block: SubtitleBlock, time: number): boolean =>
    time >= block.startTime && time <= block.endTime;

/** 空格：播放 / 暂停切换；暂停时带上精确锚点时间，让其它控制端/展示端停在同一帧 */
const togglePlayback = () => {
    if (!selectedFile.value) return;

    if (isPlaying.value) {
        store.pause(getPlaybackTime() ?? store.currentTime);
    } else {
        store.play();
    }
};

/** ← / A：临时隐藏/恢复所有字幕渲染层；不改变进度与播放状态 */
const toggleSubtitlesHidden = () => {
    store.toggleSubtitlesHidden();
};

/** ↓ / S：播放下一条；已经停在句首时重播当前句 */
const playNextBlock = (track: 1 | 2) => {
    const blocks = trackBlocks(track);
    if (blocks.length === 0) return;

    const time = store.currentTime;
    const index = blocks.findIndex((block) => isTimeInBlock(block, time));

    if (index === -1) {
        const nextBlock = blocks.find((block) => block.startTime > time);
        seekAndPlay(nextBlock ? nextBlock.startTime : blocks[0]!.startTime);
        return;
    }

    const activeBlock = blocks[index]!;
    if (time === activeBlock.startTime) {
        store.play();
        realignPlaybackAnchor(time);
        return;
    }
    if (index < blocks.length - 1) {
        seekAndPlay(blocks[index + 1]!.startTime);
    }
};

/**
 * 找出当前时间对应的「上一条」字幕：
 * 当前时间在某条字幕内（含句首/句尾边界）时取它前面的一条；
 * 已经过了某条字幕时取最近结束的那条；在第一条字幕之前时没有上一条。
 */
const findPreviousBlock = (blocks: SubtitleBlock[], time: number): SubtitleBlock | undefined => {
    let currentIndex = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i]!.startTime <= time) {
            currentIndex = i;
            break;
        }
    }

    if (currentIndex === -1) return undefined;

    const currentBlock = blocks[currentIndex]!;
    if (time <= currentBlock.endTime) {
        return currentIndex > 0 ? blocks[currentIndex - 1] : undefined;
    }
    return currentBlock;
};

/** ↑ / W：导航到上一条字幕并播放；没有上一条时不动作 */
const playPreviousBlock = (track: 1 | 2) => {
    const previousBlock = findPreviousBlock(trackBlocks(track), store.currentTime);
    if (!previousBlock) return;
    seekAndPlay(previousBlock.startTime);
};

/**
 * 快捷键按钮：执行与键盘完全相同的动作，然后把焦点移出按钮。
 * 否则按钮会一直保持焦点，下一次空格会再次点击按钮，而不是切换播放。
 */
const runShortcut = (action: () => void) => {
    action();
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
        activeElement.blur();
    }
};

watch(selectedFile, (newFile) => {
    if (!newFile) return;

    // 先停掉上一首的播放循环，避免把旧时间写进新文件。
    // 文件、进度与播放状态已由 store 的本地选择/远端快照统一重置，这里只处理视图。
    stopAutoPlay();
    zoomLevel.value = 1;
    nextTick(() => {
        updatePlayheadPosition(store.currentTime);
        const scrollContainer = document.querySelector('.timeline-scroll-container');
        if (scrollContainer) {
            scrollContainer.scrollLeft = 0;
        }
    });
});

const handleKeyDown = (event: KeyboardEvent) => {
    if (!selectedFile.value) return;

    if (isEditableTarget(event.target)) {
        return;
    }

    if (isPlaybackToggleShortcut(event)) {
        event.preventDefault();
        togglePlayback();
        return;
    }

    // Ctrl+S 保存、Ctrl+A 全选等组合键交还给浏览器
    if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
    }

    if (event.key.startsWith('Arrow')) {
        event.preventDefault();
    }

    switch (event.key) {
        case 'ArrowLeft':
            toggleSubtitlesHidden();
            break;
        case 'ArrowUp':
            playPreviousBlock(1);
            break;
        case 'ArrowDown':
            playNextBlock(1);
            break;
        case 'a':
        case 'A':
            toggleSubtitlesHidden();
            break;
        case 'w':
        case 'W':
            playPreviousBlock(2);
            break;
        case 's':
        case 'S':
            playNextBlock(2);
            break;
    }
};

onMounted(() => {
    startWatching();
    updatePlayheadPosition(store.currentTime);
    document.addEventListener('keydown', handleKeyDown);

    const scrollContainer = document.querySelector('.timeline-scroll-container');
    if (scrollContainer) {
        scrollContainer.addEventListener('scroll', () => {
            isUserScrolling = true;
            setTimeout(() => {
                isUserScrolling = false;
            }, 1000);
        });
    }
});

onUnmounted(() => {
    stopAutoPlay();
    document.removeEventListener('keydown', handleKeyDown);
});

watch(isPlaying, startWatching);

// 远端跳转（其它控制端 seek / 服务端快照）后重新对齐本地播放锚点，
// 否则下一帧会用旧锚点把时间拉回去；本地播放推进不会递增 seekVersion。
watch(
    () => store.seekVersion,
    () => {
        if (!isPlaying.value) return;
        playStartTime = performance.now();
        playStartCurrentTime = currentTime.value;
    },
);

let lastAutoScrollTime = 0;
let isUserScrolling = false;

watch(currentTime, (newTime) => {
    updatePlayheadPosition(newTime);

    if (selectedFile.value && isPlaying.value && !isUserScrolling) {
        const now = Date.now();
        if (now - lastAutoScrollTime > 500) {
            nextTick(() => {
                const scrollContainer = document.querySelector('.timeline-scroll-container');
                const playhead = document.querySelector('.playhead');
                if (scrollContainer && playhead && selectedFile.value) {
                    const playheadLeft = (newTime / selectedFile.value.duration) * 100;
                    const containerWidth = scrollContainer.clientWidth;
                    const scrollWidth = scrollContainer.scrollWidth;
                    const playheadPosition = (playheadLeft / 100) * scrollWidth;

                    const margin = containerWidth * 0.1;
                    if (
                        playheadPosition < scrollContainer.scrollLeft + margin ||
                        playheadPosition > scrollContainer.scrollLeft + containerWidth - margin
                    ) {
                        scrollContainer.scrollLeft = playheadPosition - containerWidth / 2;
                        lastAutoScrollTime = now;
                    }
                }
            });
        }
    }
});
</script>

<style scoped>
.timeline-container {
    background-color: #1f2937;
    color: white;
    padding: 4px;
    border-radius: 8px;
    height: 164px;
    display: flex;
    flex-direction: column;
}

.timeline-scroll-container {
    flex: 1;
    min-height: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
    scrollbar-color: #6b7280 #374151;
    scroll-behavior: auto;
    padding-bottom: 12px;
}

.timeline-scroll-container::-webkit-scrollbar {
    height: 8px;
}

.timeline-scroll-container::-webkit-scrollbar-track {
    background: #374151;
    border-radius: 4px;
}

.timeline-scroll-container::-webkit-scrollbar-thumb {
    background: #6b7280;
    border-radius: 4px;
}

.timeline-scroll-container::-webkit-scrollbar-thumb:hover {
    background: #9ca3af;
}

.timeline-ruler {
    position: relative;
    height: 20px;
    margin-bottom: 2px;
    background-color: #374151;
    border-radius: 2px;
    flex-shrink: 0;
    width: 100%;
}

.time-tick {
    position: absolute;
    top: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
}

.tick-line {
    width: 1px;
    height: 8px;
    background-color: #6b7280;
}

.tick-label {
    font-size: 8px;
    color: #9ca3af;
    margin-top: 1px;
}

.tracks-container {
    position: relative;
    flex: 1;
    min-height: 0;
    width: 100%;
}

.track {
    height: 20px;
    background-color: #374151;
    border-radius: 2px;
    margin-bottom: 2px;
    position: relative;
    display: flex;
}

.track-content {
    width: 100%;
    height: 100%;
    position: relative;
    overflow: visible;
    min-width: 100%;
}

.subtitle-block {
    position: absolute;
    height: 16px;
    top: 2px;
    border-radius: 2px;
    padding: 0 2px;
    display: flex;
    align-items: center;
    font-size: 9px;
    cursor: pointer;
    transition: all 0.2s ease;
    background-color: #f59e0b;
    color: #000;
}

.block-track1 {
    background-color: #f59e0b;
}

.block-track1:hover {
    background-color: #d97706;
}

.block-track2 {
    background-color: #8b5cf6;
}

.block-track2:hover {
    background-color: #7c3aed;
}

.block-active {
    background-color: #10b981 !important;
    color: white;
}

.block-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
}

.playhead {
    position: absolute;
    top: 0;
    height: 100%;
    width: 1px;
    background-color: #ef4444;
    z-index: 10;
    pointer-events: none;
    will-change: left;
}

.playhead-handle {
    position: absolute;
    top: 0;
    left: 50%;
    width: 4px;
    height: 4px;
    background-color: #ef4444;
    border-radius: 50%;
    transform: translateX(-50%);
}

.shortcut-controls {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 4px;
    padding: 4px;
    background-color: #111827;
    border-radius: 4px;
    flex-shrink: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
    scrollbar-color: #6b7280 #111827;
}

.shortcut-controls::-webkit-scrollbar {
    height: 6px;
}

.shortcut-controls::-webkit-scrollbar-track {
    background: #111827;
}

.shortcut-controls::-webkit-scrollbar-thumb {
    background: #6b7280;
    border-radius: 3px;
}

.shortcut-heading {
    font-size: 10px;
    color: #9ca3af;
    white-space: nowrap;
}

.shortcut-group-label {
    font-size: 9px;
    color: #9ca3af;
    white-space: nowrap;
}

.shortcut-divider {
    width: 1px;
    height: 14px;
    background-color: #374151;
    flex-shrink: 0;
}

.shortcut-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 6px;
    border: 1px solid #4b5563;
    border-radius: 3px;
    background-color: #374151;
    color: #e5e7eb;
    font-size: 10px;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    transition:
        background-color 0.2s ease,
        border-color 0.2s ease;
}

.shortcut-btn:hover:not(:disabled) {
    background-color: #4b5563;
    border-color: #6b7280;
}

.shortcut-btn:focus-visible {
    outline: 2px solid #93c5fd;
    outline-offset: 1px;
}

.shortcut-btn:active:not(:disabled) {
    background-color: #1f2937;
}

.shortcut-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.shortcut-btn-play {
    border-color: #10b981;
    color: #d1fae5;
}

/* 字幕被临时隐藏时，两个隐藏按钮显示「显示」并高亮，提示当前状态 */
.shortcut-btn-active {
    border-color: #fbbf24;
    color: #fbbf24;
}

.shortcut-key {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 13px;
    padding: 0 4px;
    border-radius: 2px;
    background-color: #111827;
    color: #fbbf24;
    font-family: 'Courier New', monospace;
    font-size: 9px;
    font-weight: 600;
    line-height: 1;
}

.zoom-controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    margin-top: 2px;
    flex-shrink: 0;
}

.zoom-btn {
    width: 16px;
    height: 16px;
    background-color: #4b5563;
    border: none;
    border-radius: 2px;
    color: white;
    font-size: 10px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
}

.zoom-btn:hover {
    background-color: #6b7280;
}

.zoom-level {
    font-size: 8px;
    color: #9ca3af;
    min-width: 24px;
    text-align: center;
}

.time-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
    padding: 4px;
    background-color: #374151;
    border-radius: 4px;
    flex-shrink: 0;
}

.current-time-display {
    display: flex;
    align-items: center;
    gap: 4px;
}

.time-label {
    font-size: 10px;
    color: #9ca3af;
}

.time-value {
    font-size: 12px;
    font-weight: 600;
    color: #fbbf24;
    font-family: 'Courier New', monospace;
}

.time-adjustment {
    display: flex;
    gap: 2px;
}

.time-btn {
    padding: 2px 6px;
    background-color: #4b5563;
    border: none;
    border-radius: 3px;
    color: white;
    font-size: 9px;
    cursor: pointer;
    transition: background-color 0.2s ease;
}

.time-btn:hover {
    background-color: #6b7280;
}

.time-btn:active {
    background-color: #374151;
}
</style>
