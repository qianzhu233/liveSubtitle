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

    if (playRafId !== null) {
        playStartTime = performance.now();
        playStartCurrentTime = time;
        latestAutoTime = time;
    }
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

    if (isPlaying.value && playRafId !== null) {
        playStartTime = performance.now();
        playStartCurrentTime = newTime;
        latestAutoTime = newTime;
    }
};

let playRafId: number | null = null;
let playSyncIntervalId: number | null = null;
let playStartTime: number | null = null;
let playStartCurrentTime: number | null = null;
let latestAutoTime: number | null = null;

// 播放头动画走 requestAnimationFrame，时间状态按低频写回 store：
// 既保证指针顺滑，又避免每帧重渲染几百个字幕块、每帧都发 socket。
const PLAYBACK_SYNC_INTERVAL_MS = 100;

const getPlaybackTime = (): number | null => {
    if (playStartTime === null || playStartCurrentTime === null) return null;
    return playStartCurrentTime + (performance.now() - playStartTime) / 1000;
};

const finishPlayback = () => {
    const duration = selectedFile.value?.duration ?? 0;
    latestAutoTime = null;
    playStartTime = null;
    playStartCurrentTime = null;
    updatePlayheadPosition(duration);
    store.pause();
    store.setCurrentTime(0);
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

    latestAutoTime = time;
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

    latestAutoTime = time;
    store.setCurrentTime(time);
};

const startAutoPlay = () => {
    if (playRafId !== null || playSyncIntervalId !== null) return;

    playStartTime = performance.now();
    playStartCurrentTime = currentTime.value;
    latestAutoTime = currentTime.value;
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

    // 暂停瞬间把精确时间补写回 store（即使页面在后台、rAF 被暂停也能取到正确值）
    if (playStartTime !== null && playStartCurrentTime !== null && selectedFile.value) {
        const elapsed = (performance.now() - playStartTime) / 1000;
        const finalTime = Math.min(playStartCurrentTime + elapsed, selectedFile.value.duration);
        store.setCurrentTime(finalTime);
    }
    latestAutoTime = null;
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

watch(selectedFile, (newFile) => {
    if (newFile) {
        // 先停掉上一首的播放循环，避免把旧时间写进新文件
        stopAutoPlay();
        latestAutoTime = null;
        store.setCurrentTime(0);
        store.pause();
        zoomLevel.value = 1;
        nextTick(() => {
            updatePlayheadPosition(0);
            const scrollContainer = document.querySelector('.timeline-scroll-container');
            if (scrollContainer) {
                scrollContainer.scrollLeft = 0;
            }
        });
    }
});

const handleKeyDown = (event: KeyboardEvent) => {
    if (!selectedFile.value) return;

    if (isEditableTarget(event.target)) {
        return;
    }

    if (isPlaybackToggleShortcut(event)) {
        event.preventDefault();

        if (isPlaying.value) {
            store.pause();
        } else {
            store.play();
        }
        return;
    }

    const currentTime = store.currentTime;

    if (
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight' ||
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown'
    ) {
        event.preventDefault();
    }

    if (event.key === 'ArrowLeft') {
        const track1Blocks = selectedFile.value.blocks.filter((block) => block.track === 1);
        const currentBlock = track1Blocks.find(
            (block) => currentTime >= block.startTime && currentTime <= block.endTime,
        );

        if (currentBlock) {
            store.setCurrentTime(currentBlock.startTime);
            store.pause();
        } else {
            let targetBlock = null;
            for (let i = track1Blocks.length - 1; i >= 0; i--) {
                if (track1Blocks[i].endTime <= currentTime) {
                    targetBlock = track1Blocks[i];
                    break;
                }
            }

            if (targetBlock) {
                store.setCurrentTime(targetBlock.endTime);
                store.pause();
            } else if (track1Blocks.length > 0) {
                store.setCurrentTime(track1Blocks[0].startTime);
                store.pause();
            }
        }
    } else if (event.key === 'ArrowDown') {
        const track1Blocks = selectedFile.value.blocks.filter((block) => block.track === 1);

        let currentBlockIndex = -1;
        for (let i = 0; i < track1Blocks.length; i++) {
            const block = track1Blocks[i];
            if (currentTime >= block.startTime && currentTime <= block.endTime) {
                currentBlockIndex = i;
                break;
            }
        }

        if (currentBlockIndex === -1) {
            let nextBlockIndex = -1;
            for (let i = 0; i < track1Blocks.length; i++) {
                if (currentTime < track1Blocks[i].startTime) {
                    nextBlockIndex = i;
                    break;
                }
            }

            if (nextBlockIndex !== -1) {
                const nextBlock = track1Blocks[nextBlockIndex];
                store.setCurrentTime(nextBlock.startTime);
                store.play();
                if (playRafId !== null) {
                    playStartTime = performance.now();
                    playStartCurrentTime = nextBlock.startTime;
                }
            } else if (track1Blocks.length > 0) {
                store.setCurrentTime(track1Blocks[0].startTime);
                store.play();
                if (playRafId !== null) {
                    playStartTime = performance.now();
                    playStartCurrentTime = track1Blocks[0].startTime;
                }
            }
        } else {
            const currentBlock = track1Blocks[currentBlockIndex];
            if (currentTime === currentBlock.startTime) {
                store.play();
                if (playRafId !== null) {
                    playStartTime = performance.now();
                    playStartCurrentTime = currentTime;
                }
            } else {
                if (currentBlockIndex < track1Blocks.length - 1) {
                    const nextBlock = track1Blocks[currentBlockIndex + 1];
                    store.setCurrentTime(nextBlock.startTime);
                    store.play();
                    if (playRafId !== null) {
                        playStartTime = performance.now();
                        playStartCurrentTime = nextBlock.startTime;
                    }
                }
            }
        }
    } else if (event.key === 'a' || event.key === 'A') {
        const track2Blocks = selectedFile.value.blocks.filter((block) => block.track === 2);
        const currentBlock = track2Blocks.find(
            (block) => currentTime >= block.startTime && currentTime <= block.endTime,
        );
        if (currentBlock) {
            store.setCurrentTime(currentBlock.startTime);
            store.pause();
        }
    } else if (event.key === 's' || event.key === 'S') {
        const track2Blocks = selectedFile.value.blocks.filter((block) => block.track === 2);

        let currentBlockIndex = -1;
        for (let i = 0; i < track2Blocks.length; i++) {
            const block = track2Blocks[i];
            if (currentTime >= block.startTime && currentTime <= block.endTime) {
                currentBlockIndex = i;
                break;
            }
        }

        if (currentBlockIndex === -1) {
            let nextBlockIndex = -1;
            for (let i = 0; i < track2Blocks.length; i++) {
                if (currentTime < track2Blocks[i].startTime) {
                    nextBlockIndex = i;
                    break;
                }
            }

            if (nextBlockIndex !== -1) {
                const nextBlock = track2Blocks[nextBlockIndex];
                store.setCurrentTime(nextBlock.startTime);
                store.play();
                if (playRafId !== null) {
                    playStartTime = performance.now();
                    playStartCurrentTime = nextBlock.startTime;
                }
            } else if (track2Blocks.length > 0) {
                store.setCurrentTime(track2Blocks[0].startTime);
                store.play();
                if (playRafId !== null) {
                    playStartTime = performance.now();
                    playStartCurrentTime = track2Blocks[0].startTime;
                }
            }
        } else {
            const currentBlock = track2Blocks[currentBlockIndex];
            if (currentTime === currentBlock.startTime) {
                store.play();
                if (playRafId !== null) {
                    playStartTime = performance.now();
                    playStartCurrentTime = currentTime;
                }
            } else {
                if (currentBlockIndex < track2Blocks.length - 1) {
                    const nextBlock = track2Blocks[currentBlockIndex + 1];
                    store.setCurrentTime(nextBlock.startTime);
                    store.play();
                    if (playRafId !== null) {
                        playStartTime = performance.now();
                        playStartCurrentTime = nextBlock.startTime;
                    }
                }
            }
        }
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
    height: 132px;
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
