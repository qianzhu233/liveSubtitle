// 字幕块类型
export interface SubtitleBlock {
    id: string;
    startTime: number;
    endTime: number;
    text: string;
    track: number;
}

// 字幕文件类型
export interface SubtitleFile {
    id: string;
    name: string;
    artist?: string;
    album?: string;
    duration: number;
    blocks: SubtitleBlock[];
    createdAt: string;
    updatedAt: string;
}

// 播放状态类型
export interface PlaybackState {
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    selectedFile: SubtitleFile | null;
}

// 筛选选项类型
export interface FilterOptions {
    searchText: string;
}

// 筛选器类型
export interface Filter {
    name: string;
    type: 'album' | 'unit' | 'live' | 'solo';
    songs: string[];
}

// 筛选配置类型
export type FilterConfig = Filter[];

// 字体选项类型（由服务端枚举系统已安装字体得到）
export interface FontOption {
    /** 展示用字体族名，优先英文名 */
    familyName: string;
    /** 主字体文件名（常规字重），仅用于展示/调试 */
    fileName: string;
    /** 主字体文件访问地址 */
    url: string;
    /** 同族字体文件（常规/粗体/细体等），展示端强制字体时会全部加载 */
    urls: string[];
    /** 本地化族名、全名、PostScript 名，用于匹配 ASS Fontname */
    aliases: string[];
    /** ASS 指定字体缺失时是否作为回退字体 */
    fallback?: boolean;
}
