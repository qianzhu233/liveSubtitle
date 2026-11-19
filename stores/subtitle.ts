import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { SubtitleFile, FilterOptions, FilterConfig, FontOption } from '~/types/subtitle';
import { fetchSubtitleFiles, fetchFilterConfig, fetchFontOptions } from '~/utils/api';

export const useSubtitleStore = defineStore('subtitle', () => {
    // 状态
    const subtitleFiles = ref<SubtitleFile[]>([]);
    const isLoading = ref(false);
    const selectedFile = ref<SubtitleFile | null>(null);
    const isPlaying = ref(false);
    const currentTime = ref(0);
    const fontOptions = ref<FontOption[]>([]);
    // 空字符串 = 跟随原字幕（ASS 样式）；非空时存字体族名，字体文件由系统字体列表提供
    const selectedFont = ref('');
    const selectedFontOption = computed(
        () => fontOptions.value.find((option) => option.familyName === selectedFont.value) ?? null,
    );
    const selectedFontPayload = computed(() => {
        const option = selectedFontOption.value;
        const urls = option
            ? option.urls && option.urls.length > 0
                ? option.urls
                : option.url
                  ? [option.url]
                  : []
            : [];
        return {
            fontFile: option?.fileName ?? '',
            fontFamily: option?.familyName ?? '',
            fontUrl: option?.url ?? '',
            fontUrls: [...urls],
        };
    });
    const filterOptions = ref<FilterOptions>({
        searchText: '',
    });
    const filterConfig = ref<FilterConfig>([]);
    // 远端（其它控制端/服务端快照）跳转时间时递增；Timeline 用它重新对齐播放锚点
    const seekVersion = ref(0);
    // 临时隐藏所有字幕渲染层（展示端生效），不改变播放进度与播放状态
    const subtitlesHidden = ref(false);

    // socket.io - auto-imported by @xarenas107/nuxt-socket-io
    const socket: any = useSocketIOStore();

    const filteredFiles = computed(() => {
        return subtitleFiles.value.filter((file) => {
            const matchesSearch =
                !filterOptions.value.searchText ||
                file.name.toLowerCase().includes(filterOptions.value.searchText.toLowerCase());
            return matchesSearch;
        });
    });

    const filters = computed(() => {
        return filterConfig.value || [];
    });

    const filterTypes = computed(() => {
        return ['unit', 'album', 'live', 'solo'];
    });

    const currentBlocks = computed(() => {
        if (!selectedFile.value) return [];
        return selectedFile.value.blocks.filter(
            (block) => currentTime.value >= block.startTime && currentTime.value <= block.endTime,
        );
    });

    const clampCurrentTime = (time: number): number => {
        if (!Number.isFinite(time)) return 0;
        const duration = selectedFile.value?.duration ?? 0;
        return Math.max(0, Math.min(time, duration));
    };

    // ---------------------------------------------------------------------
    // 远端状态应用：只更新本地状态，绝不回发 socket。
    // 多控制端同时在线时，回发会形成事件风暴（A 收到 B → A 再广播 → B 再广播…）。
    // ---------------------------------------------------------------------
    const applyRemoteFontFamily = (fontFamily: unknown) => {
        if (typeof fontFamily === 'string') {
            selectedFont.value = fontFamily;
        }
    };

    const applyRemoteFileSelection = (data: any): boolean => {
        const file = data?.file as SubtitleFile | undefined;
        if (!file || typeof file.id !== 'string') return false;

        selectedFile.value = file;
        currentTime.value = 0;
        isPlaying.value = false;
        subtitlesHidden.value = false;
        applyRemoteFontFamily(data?.fontFamily);
        return true;
    };

    const applyRemoteTime = (time: unknown): boolean => {
        const value = Number(time);
        if (!selectedFile.value || !Number.isFinite(value)) return false;

        currentTime.value = clampCurrentTime(value);
        seekVersion.value++;
        return true;
    };

    const applyRemotePlayState = (data: any) => {
        if (!selectedFile.value) return;

        applyRemoteTime(data?.currentTime);
        isPlaying.value = data?.isPlaying === true;
    };

    const applyRemoteFontChange = (data: any) => {
        applyRemoteFontFamily(data?.fontFamily);
    };

    const applyRemoteVisibility = (data: any) => {
        subtitlesHidden.value = data?.hidden === true;
    };

    /** 连接/重连时由服务端下发：服务端是权威状态，本地直接对齐 */
    const applySnapshot = (snapshot: any): boolean => {
        const file = snapshot?.selectedFile as SubtitleFile | undefined;
        if (!file || typeof file.id !== 'string') return false;

        // 同一首歌重连时不替换对象，避免 Timeline 把缩放和滚动位置重置
        const sameFile = selectedFile.value?.id === file.id;
        if (!sameFile) {
            selectedFile.value = file;
        }
        currentTime.value = clampCurrentTime(Number(snapshot.currentTime));
        applyRemoteFontFamily(snapshot.fontFamily);
        subtitlesHidden.value = snapshot?.subtitlesHidden === true;
        seekVersion.value++;
        isPlaying.value = snapshot.isPlaying === true;
        return true;
    };

    // ---------------------------------------------------------------------
    // 本地操作：更新本地状态并广播给服务端（服务端再转发给其它前端）
    // ---------------------------------------------------------------------
    const selectFile = (file: SubtitleFile) => {
        selectedFile.value = file;
        currentTime.value = 0;
        isPlaying.value = false;
        subtitlesHidden.value = false;
        socket.emit('file-selected', { file, ...selectedFontPayload.value });
    };

    const play = () => {
        if (!selectedFile.value) return;
        isPlaying.value = true;
        socket.emit('play-state-change', {
            isPlaying: true,
            currentTime: currentTime.value,
        });
    };

    /**
     * 暂停并广播。传入精确进度时以它为准：Timeline 的播放锚点比 store 里的
     * 低频同步值更精确，暂停瞬间把锚点时间一起发出去，其它前端才能停在同一帧。
     */
    const pause = (time?: number) => {
        if (!selectedFile.value) return;
        if (typeof time === 'number') {
            currentTime.value = clampCurrentTime(time);
        }
        isPlaying.value = false;
        socket.emit('play-state-change', {
            isPlaying: false,
            currentTime: currentTime.value,
        });
    };

    const setCurrentTime = (time: number) => {
        if (!selectedFile.value) return;
        currentTime.value = clampCurrentTime(time);
        socket.emit('time-sync', { currentTime: currentTime.value });
    };

    /**
     * 播放过程中的本地进度推进：只改本地，不广播。
     * 展示端由服务端时钟按 10Hz 统一驱动；控制端各自从同一锚点外推，
     * 因此多个控制端之间不会互发时间、也不会因为后台节流产生回环。
     */
    const updatePlaybackTime = (time: number) => {
        if (!selectedFile.value) return;
        currentTime.value = clampCurrentTime(time);
    };

    const updateFilter = (newFilter: Partial<FilterOptions>) => {
        filterOptions.value = { ...filterOptions.value, ...newFilter };
    };

    const formatTime = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    // 字体设置对全局生效：单独通知展示端，由展示端应用到所有字幕内容上
    const broadcastFontChange = () => {
        socket.emit('font-change', selectedFontPayload.value);
    };

    /**
     * 临时隐藏/恢复所有字幕渲染层。只广播可见性，不影响播放进度与播放状态。
     * 相同状态不重复广播；没有选择字幕文件时忽略。
     */
    const setSubtitlesHidden = (hidden: boolean) => {
        if (!selectedFile.value || subtitlesHidden.value === hidden) return;
        subtitlesHidden.value = hidden;
        socket.emit('subtitle-visibility-change', { hidden });
    };

    const toggleSubtitlesHidden = () => {
        setSubtitlesHidden(!subtitlesHidden.value);
    };

    // 服务端没有权威状态时（通常是服务重启），用本地状态重新播种
    const seedServer = () => {
        if (!selectedFile.value) return;
        socket.emit('file-selected', {
            file: selectedFile.value,
            ...selectedFontPayload.value,
        });
        socket.emit('play-state-change', {
            isPlaying: isPlaying.value,
            currentTime: currentTime.value,
        });
        // 服务端重启后恢复临时隐藏状态，避免展示端重新连上时字幕突然出现
        if (subtitlesHidden.value) {
            socket.emit('subtitle-visibility-change', { hidden: true });
        }
    };

    // 连接后登记为控制端，服务端会立即下发权威快照
    const registerControl = () => {
        console.log('[socket.io] 控制端登记角色 control');
        socket.emit('register', { role: 'control' });
    };
    socket.on('connect', registerControl);
    // 页面切换/HMR 等场景下 socket 可能已经连接，仍需补登记一次
    if (socket.status?.connected) {
        registerControl();
    }

    socket.on('state-sync', (snapshot: any) => {
        console.log('[socket.io] 收到会话快照');
        if (applySnapshot(snapshot)) {
            return;
        }
        // 服务端没有会话、但本页已有状态：把本地状态补回服务端，避免服务重启后丢失
        seedServer();
    });

    socket.on('file-selected', (data: any) => {
        console.log('[socket.io] 其它控制端切换了字幕文件');
        applyRemoteFileSelection(data);
    });

    socket.on('play-state-change', (data: any) => {
        console.log('[socket.io] 其它控制端切换了播放状态');
        applyRemotePlayState(data);
    });

    socket.on('time-sync', (data: any) => {
        applyRemoteTime(data?.currentTime);
    });

    socket.on('font-change', (data: any) => {
        console.log('[socket.io] 其它控制端切换了字体');
        applyRemoteFontChange(data);
    });

    socket.on('subtitle-visibility-change', (data: any) => {
        console.log('[socket.io] 其它控制端切换了字幕可见性');
        applyRemoteVisibility(data);
    });

    const loadSubtitleFiles = async () => {
        isLoading.value = true;
        try {
            const [files, config] = await Promise.all([fetchSubtitleFiles(), fetchFilterConfig()]);
            subtitleFiles.value = files;
            filterConfig.value = config;
        } catch (error) {
            console.error('加载数据失败:', error);
        } finally {
            isLoading.value = false;
        }
    };

    const loadFontOptions = async () => {
        try {
            fontOptions.value = await fetchFontOptions();
            // 之前选中的字体族如果已不存在，回到跟随原字幕
            if (selectedFont.value && fontOptions.value.length > 0 && !selectedFontOption.value) {
                selectedFont.value = '';
            }
        } catch (error) {
            console.error('加载字体选项失败:', error);
            fontOptions.value = [];
        }
    };

    return {
        subtitleFiles,
        selectedFile,
        isPlaying,
        currentTime,
        fontOptions,
        selectedFont,
        selectedFontOption,
        selectedFontPayload,
        filterOptions,
        filterConfig,
        isLoading,
        seekVersion,
        subtitlesHidden,
        filteredFiles,
        filters,
        filterTypes,
        currentBlocks,
        selectFile,
        play,
        pause,
        setCurrentTime,
        updatePlaybackTime,
        updateFilter,
        formatTime,
        loadSubtitleFiles,
        loadFontOptions,
        broadcastFontChange,
        setSubtitlesHidden,
        toggleSubtitlesHidden,
    };
});
