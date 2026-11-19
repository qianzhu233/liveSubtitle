<template>
    <div class="subtitle-view">
        <div class="subtitle-container">
            <canvas
                ref="canvas"
                class="subtitle-canvas"
                :class="{ 'subtitle-canvas-hidden': subtitlesHidden }"
            ></canvas>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import type { SubtitleFile } from '~/types/subtitle';
import { applyAssFont } from '~/utils/assFont';
import { loadFonts } from '~/utils/fontLoader';

const canvas = ref<HTMLCanvasElement>();
const currentTime = ref(0);
const isPlaying = ref(false);
const selectedFile = ref<SubtitleFile | null>(null);
// 控制端可临时隐藏所有字幕渲染层：只隐藏画布，渲染器与播放进度保持运行
const subtitlesHidden = ref(false);

// 字体为展示端的全局设置：切换歌曲、更新 ASS 内容时都统一应用
// fontUrls 指向系统字体文件（同族可能有多个字重），由服务端 /api/font-file 提供
const fontFamily = ref('');
const fontUrls = ref<string[]>([]);
let currentAssContent = '';
let rendererRequestId = 0;

// auto-imported by @xarenas107/nuxt-socket-io
const socket: any = useSocketIO();

let subtitleRenderer: any = null;
let internalTimer: number | null = null;
let disposeSocketListeners: (() => void) | null = null;

const applyCurrentFont = (assContent: string): string =>
    fontFamily.value ? applyAssFont(assContent, fontFamily.value) : assContent;

/** 兼容旧负载：优先读 fontUrls，其次退回单个 fontUrl */
const readFontUrls = (data: any): string[] => {
    if (Array.isArray(data?.fontUrls)) {
        const urls = data.fontUrls.filter(
            (url: unknown): url is string => typeof url === 'string' && url.length > 0,
        );
        if (urls.length > 0) {
            return urls;
        }
    }
    if (typeof data?.fontUrl === 'string' && data.fontUrl) {
        return [data.fontUrl];
    }
    return [];
};

/**
 * 应用服务端权威快照：一次性恢复字幕文件、全局字体、播放进度与播放状态。
 * 展示端本身不保存会话，重连后完全以服务端为准。
 */
const applySnapshot = (data: any) => {
    subtitlesHidden.value = data?.subtitlesHidden === true;

    const file = data?.selectedFile as SubtitleFile | undefined;
    if (!file) return;

    stopInternalTimer();
    isPlaying.value = false;
    currentTime.value = 0;
    selectedFile.value = file;

    if (typeof data.fontFamily === 'string') {
        fontFamily.value = data.fontFamily;
    }
    fontUrls.value = readFontUrls(data);

    void loadSubtitleFile(file).then(() => {
        if (typeof data.currentTime === 'number' && Number.isFinite(data.currentTime)) {
            currentTime.value = data.currentTime;
        }
        updateSubtitles();

        if (data.isPlaying) {
            isPlaying.value = true;
            startInternalTimer();
        }
    });
};

const initSocketListeners = () => {
    // 记录监听器，卸载时精确移除，避免页面来回切换后重复注册、重复加载字幕
    const socketCleanups: Array<() => void> = [];
    const handleSocketEvent = (event: string, handler: (...args: any[]) => void) => {
        socket.on(event, handler);
        socketCleanups.push(() => socket.off(event, handler));
    };

    const registerDisplay = () => {
        console.log('展示端已连接到服务器，Socket ID:', socket.id);
        // 登记为展示端：服务端会立即下发权威快照（字幕、字体、播放进度），
        // 因此 OBS 浏览器来源刷新/断线重连后不再需要向控制端请求补发。
        socket.emit('register', { role: 'display' });
    };

    handleSocketEvent('connect', registerDisplay);
    // 从控制端页面跳转过来时 socket 可能仍然保持连接，不会再次触发 connect
    if (socket.connected) {
        registerDisplay();
    }

    // 服务端权威快照：新连接、重连、服务端重启后的首次连接都会收到
    handleSocketEvent('state-sync', (data: any) => {
        console.log('收到会话快照:', data?.selectedFile?.id ?? '(空)');
        applySnapshot(data);
    });

    handleSocketEvent('play-state-change', (data: any) => {
        console.log('收到播放状态变化:', data);
        isPlaying.value = data.isPlaying;

        // 暂停事件携带精确进度；播放事件携带当前锚点，避免重连后从错误位置继续
        if (typeof data.currentTime === 'number' && Number.isFinite(data.currentTime)) {
            currentTime.value = data.currentTime;
            updateSubtitles();
        }

        if (data.isPlaying) {
            startInternalTimer();
        } else {
            stopInternalTimer();
        }
    });

    handleSocketEvent('time-sync', (data: any) => {
        console.log('收到时间同步:', data);
        currentTime.value = data.currentTime;
        updateSubtitles();

        if (isPlaying.value) {
            startInternalTimer();
        }
    });

    handleSocketEvent('ass-content-update', (data: any) => {
        console.log('收到ASS文件更新:', data);
        if (!data.assContent) return;

        currentAssContent = data.assContent;
        reinitWithCurrentContent();
    });

    handleSocketEvent('font-change', (data: any) => {
        console.log('收到字体变化:', data);
        fontFamily.value = String(data?.fontFamily ?? '');
        fontUrls.value = readFontUrls(data);
        reinitWithCurrentContent();
    });

    handleSocketEvent('subtitle-visibility-change', (data: any) => {
        console.log('收到字幕可见性变化:', data);
        subtitlesHidden.value = data?.hidden === true;
    });

    handleSocketEvent('file-selected', (data: any) => {
        console.log('收到文件选择:', data);
        // 切换字幕时先停掉旧字幕的计时器，避免旧时间线残留（之后由控制端的播放状态/时间同步驱动）
        stopInternalTimer();
        isPlaying.value = false;
        currentTime.value = 0;
        selectedFile.value = data.file;
        // 新歌默认显示字幕
        subtitlesHidden.value = data?.subtitlesHidden === true;
        // 字体设置随文件选择一起同步，保证切换歌曲后字体仍然全局生效
        if (typeof data.fontFamily === 'string') {
            fontFamily.value = data.fontFamily;
        }
        fontUrls.value = readFontUrls(data);
        loadSubtitleFile(data.file);
    });

    handleSocketEvent('disconnect', () => {
        console.log('与服务器断开连接');
        stopInternalTimer();
    });

    handleSocketEvent('connect_error', (error: any) => {
        console.error('Socket.io 连接错误:', error);
    });

    return () => {
        for (const cleanup of socketCleanups.splice(0)) {
            cleanup();
        }
    };
};

const loadSubtitleFile = async (file: SubtitleFile) => {
    if (!file) return;

    try {
        console.log('加载字幕文件:', file.id);
        const response = await fetch(`/api/subtitle-file/${file.id}`);
        if (!response.ok) {
            console.error('获取字幕文件失败:', response.status);
            return;
        }

        const assContent = await response.text();
        currentAssContent = assContent;

        await initSubtitleRenderers(applyCurrentFont(assContent));

        // 加载期间可能已收到补发的时间同步（展示端刷新/重连场景），保留它而不是强制归零
        updateSubtitles();
    } catch (error) {
        console.error('加载字幕文件失败:', error);
    }
};

const initSubtitleRenderers = async (assContent: string): Promise<void> => {
    if (!canvas.value) return;

    // 递增请求序号：并发重建时只保留最后一次的渲染结果，避免旧内容覆盖新字体/新 ASS
    const requestId = ++rendererRequestId;
    console.log('初始化字幕渲染器');

    if (subtitleRenderer) {
        subtitleRenderer.dispose();
        subtitleRenderer = null;
    }

    return new Promise((resolve, reject) => {
        try {
            if (canvas.value) {
                canvas.value.width = 1920;
                canvas.value.height = 1080;
            }

            loadFonts({ selectedFontUrls: fontUrls.value, assContent })
                .then((fonts) => {
                    if (requestId !== rendererRequestId) {
                        // 已有更新的渲染请求，丢弃本次过期结果
                        resolve();
                        return;
                    }

                    subtitleRenderer = new (window as any).SubtitlesOctopus({
                        canvas: canvas.value,
                        subContent: assContent,
                        fonts: fonts,
                        workerUrl: '/js/subtitles-octopus-worker.js',
                        legacyWorkerUrl: '/js/subtitles-octopus-worker-legacy.js',
                        debug: true,
                        onReady: () => {
                            console.log('字幕渲染器就绪');
                            resolve();
                        },
                        onError: (error: any) => {
                            console.error('字幕渲染器错误:', error);
                            reject(error);
                        },
                    });
                })
                .catch((error) => {
                    console.error('加载字体失败:', error);
                    reject(error);
                });
        } catch (error) {
            console.error('初始化字幕渲染器失败:', error);
            reject(error);
        }
    });
};

// 用当前 ASS + 全局字体重建渲染器，并保留当前时间与播放状态
const reinitWithCurrentContent = () => {
    if (!currentAssContent) return;

    const wasPlaying = isPlaying.value;
    const currentTimeBeforeUpdate = currentTime.value;

    initSubtitleRenderers(applyCurrentFont(currentAssContent)).then(() => {
        // 重建渲染器后必须恢复当前时间：
        // 否则暂停状态下切换字体时画面会停在 0 秒，导致字幕“消失”
        currentTime.value = currentTimeBeforeUpdate;
        updateSubtitles();

        if (wasPlaying) {
            startInternalTimer();
        }
    });
};

const startInternalTimer = () => {
    if (internalTimer) {
        stopInternalTimer();
    }

    console.log('启动内部计时器');
    const startTime = Date.now();
    const startCurrentTime = currentTime.value;

    internalTimer = window.setInterval(() => {
        if (isPlaying.value && selectedFile.value) {
            const elapsed = (Date.now() - startTime) / 1000;
            currentTime.value = startCurrentTime + elapsed;

            if (currentTime.value > selectedFile.value.duration) {
                currentTime.value = selectedFile.value.duration;
                stopInternalTimer();
            }
            updateSubtitles();
        }
    }, 16);
};

const stopInternalTimer = () => {
    if (internalTimer) {
        console.log('停止内部计时器');
        clearInterval(internalTimer);
        internalTimer = null;
    }
};

const updateSubtitles = () => {
    try {
        if (subtitleRenderer) {
            subtitleRenderer.setCurrentTime(currentTime.value);
        }
    } catch (error) {
        console.error('更新字幕失败:', error);
    }
};

onMounted(() => {
    console.log('展示端组件挂载');
    // 先注册监听再连接，避免连接过快时漏掉 register 对应的快照
    disposeSocketListeners = initSocketListeners();
    socket.connect();
    const script = document.createElement('script');
    script.src = '/js/subtitles-octopus.js';
    script.onload = () => {
        console.log('JavascriptSubtitlesOctopus 加载完成');
    };
    script.onerror = (error) => {
        console.error('JavascriptSubtitlesOctopus 加载失败:', error);
    };
    document.head.appendChild(script);
});

onUnmounted(() => {
    stopInternalTimer();
    disposeSocketListeners?.();
    disposeSocketListeners = null;
    socket.disconnect();
    if (subtitleRenderer) {
        subtitleRenderer.dispose();
    }
});
</script>

<style scoped>
.subtitle-view {
    width: 1920px;
    height: 1080px;
    background-color: transparent;
    position: relative;
    overflow: hidden;
}

.subtitle-container {
    position: absolute;
    width: 100%;
    height: 100%;
    pointer-events: none;
}

.subtitle-canvas {
    width: 1920px;
    height: 1080px;
    background-color: transparent;
}

/* 使用 visibility 而不是 v-if：隐藏期间渲染器继续工作，恢复时立即显示当前帧 */
.subtitle-canvas-hidden {
    visibility: hidden;
}
</style>
