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

// 实时同步角色：控制端可操作，展示端只负责渲染
export type ClientRole = 'control' | 'display';

// 控制端下发的全局字体设置（系统字体文件由服务端 /api/font-file 提供）
export interface FontPayload {
    fontFile: string;
    fontFamily: string;
    fontUrl: string;
    fontUrls: string[];
}

// 服务端权威会话快照：客户端连接、重连或主动请求同步时下发
export interface SessionSnapshot extends FontPayload {
    selectedFile: SubtitleFile | null;
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    // 临时隐藏所有字幕渲染层（展示端据此隐藏画布），切换字幕文件时恢复显示
    subtitlesHidden: boolean;
    // 快照生成时的服务端时间戳（ms），客户端可据此估算网络延迟
    serverTime: number;
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
