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

    const selectFile = (file: SubtitleFile) => {
        selectedFile.value = file;
        currentTime.value = 0;
        isPlaying.value = false;
        broadcastFileSelect(file);
    };

    const play = () => {
        if (selectedFile.value) {
            isPlaying.value = true;
            broadcastPlayStateChange();
        }
    };

    const pause = () => {
        isPlaying.value = false;
        broadcastPlayStateChange();
    };

    const setCurrentTime = (time: number) => {
        if (selectedFile.value) {
            currentTime.value = Math.max(0, Math.min(time, selectedFile.value.duration));
            broadcastTimeSync();
        }
    };

    const updateFilter = (newFilter: Partial<FilterOptions>) => {
        filterOptions.value = { ...filterOptions.value, ...newFilter };
    };

    const formatTime = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    const broadcastPlayStateChange = () => {
        socket.emit('play-state-change', { isPlaying: isPlaying.value });
    };

    const broadcastTimeSync = () => {
        socket.emit('time-sync', { currentTime: currentTime.value });
    };

    const broadcastFileSelect = (file: SubtitleFile) => {
        // 字体是展示端的全局设置，随文件选择一起下发，保证切换歌曲后仍然生效
        socket.emit('file-selected', { file, ...selectedFontPayload.value });
    };

    // 字体设置对全局生效：单独通知展示端，由展示端应用到所有字幕内容上
    const broadcastFontChange = () => {
        socket.emit('font-change', selectedFontPayload.value);
    };

    // 展示端刷新/重连后主动请求同步，避免 OBS 页面重载后一直空白
    const resyncDisplay = () => {
        if (!selectedFile.value) return;
        socket.emit('file-selected', {
            file: selectedFile.value,
            ...selectedFontPayload.value,
        });
        socket.emit('play-state-change', { isPlaying: isPlaying.value });
        socket.emit('time-sync', { currentTime: currentTime.value });
    };

    socket.on('request-sync', () => {
        console.log('[socket.io] 展示端请求同步状态');
        resyncDisplay();
    });
    socket.on('connect', () => {
        // 控制端重连时也补发一次状态，防止服务重启后两端状态不一致
        if (selectedFile.value) {
            resyncDisplay();
        }
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
            if (selectedFont.value && !selectedFontOption.value) {
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
        filteredFiles,
        filters,
        filterTypes,
        currentBlocks,
        selectFile,
        play,
        pause,
        setCurrentTime,
        updateFilter,
        formatTime,
        loadSubtitleFiles,
        loadFontOptions,
        broadcastPlayStateChange,
        broadcastTimeSync,
        broadcastFontChange,
    };
});
