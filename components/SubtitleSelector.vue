<template>
    <div class="subtitle-selector card">
        <div class="header">
            <h2 class="title">字幕选择</h2>
            <div class="search-container">
                <input
                    v-model="searchText"
                    type="text"
                    placeholder="搜索歌曲..."
                    class="search-input"
                />
            </div>
        </div>

        <div class="control-options">
            <div class="filter-type-selector">
                <label class="filter-label">筛选类型:</label>
                <select
                    v-model="selectedFilterType"
                    @change="handleFilterTypeChange"
                    class="filter-select"
                >
                    <option value="">全部类型</option>
                    <option value="unit">小组</option>
                    <option value="album">专辑</option>
                    <option value="live">演出</option>
                    <option value="solo">solo</option>
                </select>
            </div>

            <div class="subtitle-color-toggle">
                <label class="toggle-label">色彩:</label>
                <span class="color-follow-hint">跟随 ASS 本身</span>
            </div>

            <div class="font-selector">
                <label class="font-label">字体:</label>
                <select v-model="store.selectedFont" @change="handleFontChange" class="font-select">
                    <option value="">默认（原样式）</option>
                    <option
                        v-for="font in store.fontOptions"
                        :key="font.fileName"
                        :value="font.fileName"
                    >
                        {{ getFontOptionLabel(font) }}
                    </option>
                </select>
            </div>
        </div>

        <div class="preset-filters">
            <div
                class="preset-item"
                @click="selectPreset('all')"
                :class="{ active: currentPreset === 'all' }"
            >
                全部
            </div>
            <div
                v-for="filter in filteredFilters"
                :key="filter.name"
                class="preset-item"
                @click="selectPreset(filter.name)"
                :class="{ active: currentPreset === filter.name }"
            >
                {{ filter.name }}
            </div>
        </div>

        <div class="subtitle-list">
            <div class="list-header">
                <h3 class="list-title">字幕文件 ({{ filteredFiles.length }})</h3>
            </div>

            <div v-if="store.isLoading" class="loading-state">
                <div class="loading-text">正在加载字幕文件...</div>
            </div>

            <div class="files-grid">
                <div
                    v-for="file in filteredFiles"
                    :key="file.id"
                    class="file-item"
                    :class="{ 'file-item-selected': isSelected(file) }"
                    @click="selectFile(file)"
                >
                    <div class="file-content">
                        <div class="file-name">{{ file.name }}</div>
                        <div class="file-preview">
                            {{ getPreviewText(file) }}
                        </div>
                    </div>
                    <div class="file-status">
                        <div v-if="isSelected(file)" class="selected-indicator">✓</div>
                    </div>
                </div>
            </div>

            <div v-if="!store.isLoading && filteredFiles.length === 0" class="empty-state">
                <div class="empty-text">没有找到匹配的字幕</div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useSubtitleStore } from '~/stores/subtitle';
import type { FontOption, SubtitleFile } from '~/types/subtitle';

const store = useSubtitleStore();

const currentPreset = ref('all');
const selectedFilterType = ref('');
const searchText = ref('');

const filteredFilters = computed(() => {
    let filters = store.filters;

    if (selectedFilterType.value) {
        filters = filters.filter((filter) => filter.type === selectedFilterType.value);
    }

    return filters;
});

const filteredFiles = computed(() => {
    let files = store.subtitleFiles;

    if (searchText.value) {
        files = files.filter((file) =>
            file.name.toLowerCase().includes(searchText.value.toLowerCase()),
        );
    }

    if (currentPreset.value === 'all') {
        return files;
    }

    const selectedFilter = store.filters.find((filter) => filter.name === currentPreset.value);
    if (selectedFilter) {
        const filteredFiles = files.filter((file) => selectedFilter.songs.includes(file.name));

        return filteredFiles.sort((a, b) => {
            const indexA = selectedFilter.songs.indexOf(a.name);
            const indexB = selectedFilter.songs.indexOf(b.name);
            return indexA - indexB;
        });
    }

    return files;
});

const selectedFile = computed(() => store.selectedFile);

const selectFile = (file: SubtitleFile) => {
    store.selectFile(file);
};

const isSelected = (file: SubtitleFile): boolean => {
    return selectedFile.value?.id === file.id;
};

const selectPreset = (preset: string) => {
    currentPreset.value = preset;
};

// 切换设置后主动移走焦点：否则空格键会激活下拉框/按钮，而不是暂停字幕
const blurActiveControl = () => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
        activeElement.blur();
    }
};

const handleFilterTypeChange = () => {
    currentPreset.value = 'all';
    blurActiveControl();
};

const handleFontChange = () => {
    store.broadcastFontChange();
    blurActiveControl();
};

const getFontOptionLabel = (font: FontOption): string => {
    const duplicateCount = store.fontOptions.filter(
        (option) => option.familyName === font.familyName,
    ).length;
    if (duplicateCount <= 1) {
        return font.familyName;
    }
    // 同族多字重时带上文件名，方便区分 Black/Thin 等具体字重
    return `${font.familyName}（${font.fileName.replace(/\.[^.]+$/, '')}）`;
};

const getPreviewText = (file: SubtitleFile): string => {
    if (file.blocks.length === 0) return '';
    const firstBlock = file.blocks[0]!;
    return firstBlock.text.length > 20 ? firstBlock.text.substring(0, 20) + '...' : firstBlock.text;
};

onMounted(async () => {
    await Promise.all([store.loadSubtitleFiles(), store.loadFontOptions()]);
});
</script>

<style scoped>
.subtitle-selector {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    flex-shrink: 0;
}

.title {
    font-size: 14px;
    font-weight: bold;
    color: #111827;
}

.search-container {
    flex-shrink: 0;
}

.search-input {
    width: 180px;
    padding: 4px 8px;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    font-size: 12px;
    outline: none;
    transition: border-color 0.2s ease;
}

.search-input:focus {
    border-color: #3b82f6;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
}

.filter-type-selector {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
    flex-shrink: 0;
}

.filter-label {
    font-size: 12px;
    color: #374151;
    font-weight: 500;
}

.filter-select {
    height: 24.5px;
    padding: 3px 6px;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    font-size: 12px;
    outline: none;
    background-color: white;
    cursor: pointer;
}

.filter-select:focus {
    border-color: #3b82f6;
}

.control-options {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 8px;
    flex-shrink: 0;
}

.font-selector {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
}

.font-label {
    font-size: 12px;
    color: #374151;
    font-weight: 500;
    white-space: nowrap;
}

.font-select {
    height: 24.5px;
    max-width: 220px;
    padding: 3px 6px;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    font-size: 12px;
    outline: none;
    background-color: white;
    cursor: pointer;
    text-overflow: ellipsis;
}

.font-select:focus {
    border-color: #3b82f6;
}

.subtitle-color-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
}

.toggle-label {
    font-size: 12px;
    color: #374151;
    font-weight: 500;
    white-space: nowrap;
}

.color-follow-hint {
    font-size: 12px;
    color: #6b7280;
}

.preset-filters {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
    flex-wrap: nowrap;
    flex-shrink: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
    scrollbar-color: #6b7280 #e5e7eb;
    padding-bottom: 12px;
}

.preset-filters::-webkit-scrollbar {
    height: 8px;
}

.preset-filters::-webkit-scrollbar-track {
    background: #e5e7eb;
    border-radius: 4px;
}

.preset-filters::-webkit-scrollbar-thumb {
    background: #6b7280;
    border-radius: 4px;
}

.preset-filters::-webkit-scrollbar-thumb:hover {
    background: #9ca3af;
}

.preset-item {
    padding: 4px 8px;
    background-color: #f3f4f6;
    border: 1px solid #d1d5db;
    border-radius: 12px;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.2s ease;
    white-space: nowrap;
}

.preset-item:hover {
    background-color: #e5e7eb;
}

.preset-item.active {
    background-color: #3b82f6;
    color: white;
    border-color: #3b82f6;
}

.subtitle-list {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
}

.list-header {
    margin-bottom: 6px;
    flex-shrink: 0;
}

.list-title {
    font-size: 12px;
    font-weight: 600;
    color: #111827;
}

.files-grid {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow-y: auto;
    min-height: 0;
}

.file-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 8px;
    border: 1px solid #e5e7eb;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s ease;
    background: white;
    flex-shrink: 0;
}

.file-item:hover {
    border-color: #3b82f6;
    background-color: #f8fafc;
}

.file-item-selected {
    border-color: #3b82f6;
    background-color: #eff6ff;
}

.file-content {
    flex: 1;
    min-width: 0;
}

.file-name {
    font-size: 12px;
    font-weight: 500;
    color: #111827;
    margin-bottom: 1px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.file-preview {
    font-size: 10px;
    color: #6b7280;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.file-status {
    margin-left: 6px;
    flex-shrink: 0;
}

.selected-indicator {
    width: 14px;
    height: 14px;
    background-color: #10b981;
    color: white;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 8px;
    font-weight: bold;
}

.empty-state {
    text-align: center;
    padding: 16px;
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
}

.empty-text {
    color: #6b7280;
    font-size: 12px;
}

.loading-state {
    text-align: center;
    padding: 16px;
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
}

.loading-text {
    color: #6b7280;
    font-size: 12px;
}
</style>
