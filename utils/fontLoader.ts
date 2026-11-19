import type { FontOption } from '~/types/subtitle';

// 动态加载系统字体文件
//
// 展示端无法直接使用操作系统的字体，必须由服务端把系统字体文件读出来，
// 再交给 libass（JavascriptSubtitlesOctopus）：
// - 控制端强制指定了系统字体时，只加载该字体族的文件（含同族字重）；
// - 控制端选择「跟随原字幕」时，按 ASS 样式实际引用的 Fontname / \fn 标签，
//   在系统字体列表中按族名/本地化名/全名匹配后加载；
// - 无论选中/匹配到哪款字体，都额外加载一款系统 CJK 回退字体：
//   主字体缺少个别汉字/假名时 libass 会自动回退，避免出现豆腐块。
// 加载前还会逐个 HEAD 校验，跳过无法访问的字体，避免个别字体 404 拖垮整个字幕渲染器。

/** 客户端缓存的系统字体列表，避免每次重建渲染器都重新拉取 */
let fontOptionsCache: FontOption[] | null = null;

async function isFontAvailable(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        return response.ok;
    } catch {
        return false;
    }
}

async function fetchFontOptions(): Promise<FontOption[]> {
    if (fontOptionsCache) {
        return fontOptionsCache;
    }

    try {
        const response = await fetch('/api/font-options', { cache: 'no-store' });
        if (!response.ok) return [];
        const data = (await response.json()) as FontOption[];
        if (!Array.isArray(data)) return [];
        fontOptionsCache = data;
        return data;
    } catch {
        return [];
    }
}

/** 清除字体列表缓存（系统字体变化后可由调用方触发） */
export function clearFontOptionsCache(): void {
    fontOptionsCache = null;
}

/** 归一化 ASS Fontname：去掉竖排前缀 @、首尾空白并忽略大小写 */
function normalizeFontName(name: string): string {
    return name.trim().replace(/^@+/, '').toLowerCase();
}

function getOptionNames(option: FontOption): string[] {
    return [option.familyName, ...(option.aliases ?? [])];
}

function optionMatches(option: FontOption, normalizedNames: Set<string>): boolean {
    return getOptionNames(option).some((name) => normalizedNames.has(normalizeFontName(name)));
}

/** 按 Format 行解析 ASS 样式实际引用的 Fontname，并补充对话中的 \fn 覆盖 */
function extractAssFontNames(assContent: string): string[] {
    if (!assContent) return [];

    const names = new Set<string>();
    let section = '';
    let format: string[] | null = null;
    let fontIndex = -1;

    for (const rawLine of assContent.split(/\r?\n/)) {
        const line = rawLine.trim();

        const sectionMatch = /^\[([^\]]*)\]$/.exec(line);
        if (sectionMatch) {
            section = (sectionMatch[1] ?? '').trim().toLowerCase();
            format = null;
            fontIndex = -1;
            continue;
        }

        if (section !== 'v4+ styles' && section !== 'v4 styles') continue;

        const colonIndex = line.indexOf(':');
        if (colonIndex < 0) continue;

        const keyword = line.slice(0, colonIndex).trim().toLowerCase();
        const payload = line.slice(colonIndex + 1);

        if (keyword === 'format') {
            format = payload.split(',').map((field) => field.trim().toLowerCase());
            fontIndex = format.indexOf('fontname');
            continue;
        }

        if (keyword !== 'style') continue;

        // 兼容「Style 行出现在 Format 行之前」的 ASS：按标准列顺序读取 Fontname
        const targetIndex = fontIndex >= 0 ? fontIndex : 1;
        const columns = payload.split(',');
        const fontName = (columns[targetIndex] ?? '').trim();
        if (fontName) {
            names.add(fontName);
        }
    }

    // 行内覆盖标签（如 {\fnMicrosoft YaHei}）同样会请求系统字体
    for (const match of assContent.matchAll(/\\fn([^\\}]+)/gi)) {
        const fontName = match[1]?.trim();
        if (fontName) {
            names.add(fontName);
        }
    }

    return [...names];
}

function uniqueUrls(urls: string[]): string[] {
    return [...new Set(urls.filter((url) => typeof url === 'string' && url.length > 0))];
}

async function filterAvailableFonts(urls: string[]): Promise<string[]> {
    const unique = uniqueUrls(urls);
    const availability = await Promise.all(
        unique.map(async (url) => ((await isFontAvailable(url)) ? url : null)),
    );
    const availableFonts = availability.filter((url): url is string => url !== null);

    const missingCount = unique.length - availableFonts.length;
    if (missingCount > 0) {
        console.warn(`有 ${missingCount} 个字体文件无法访问，已跳过这些字体`);
    }

    return availableFonts;
}

function getOptionUrls(option: FontOption): string[] {
    const urls = uniqueUrls(option.urls ?? []);
    if (urls.length > 0) {
        return urls;
    }
    return uniqueUrls([option.url]);
}

/**
 * 始终额外加载一款系统 CJK 回退字体。
 * 选中/ASS 指定的字体可能缺少个别汉字或假名（例如 Yu Gothic UI 缺少部分简体字），
 * 只加载它时 libass 找不到字形就会画豆腐块；把常用 CJK 字体也放进字体列表，
 * libass 会只在主字体缺字时回退到它。
 */
function getFallbackUrls(fontOptions: FontOption[]): string[] {
    if (fontOptions.length === 0) {
        return [];
    }

    const marked = fontOptions.filter((option) => option.fallback);
    const candidates = marked.length > 0 ? marked : fontOptions.slice(0, 1);

    for (const option of candidates) {
        const primaryUrl = getOptionUrls(option)[0];
        if (primaryUrl) {
            return [primaryUrl];
        }
    }

    return [];
}

export interface LoadFontsOptions {
    /** 控制端强制指定的系统字体文件 URL（可含同族多个字重）；非空时优先加载这些文件 */
    selectedFontUrls?: string[];
    /** 当前 ASS 内容，用于按样式引用的字体族名匹配需要加载的系统字体 */
    assContent?: string;
}

export async function loadFonts(options: LoadFontsOptions = {}): Promise<string[]> {
    try {
        const fontOptions = await fetchFontOptions();
        const fallbackUrls = getFallbackUrls(fontOptions);
        const selectedUrls = uniqueUrls(options.selectedFontUrls ?? []);

        if (selectedUrls.length > 0) {
            const availableFonts = await filterAvailableFonts([...selectedUrls, ...fallbackUrls]);
            if (selectedUrls.some((url) => availableFonts.includes(url))) {
                return availableFonts;
            }
            // 选中的字体文件都不可用时，回退为按 ASS 引用匹配，避免字幕彻底没有字体
        }

        if (fontOptions.length === 0) {
            return [];
        }

        const assFontNames = extractAssFontNames(options.assContent ?? '');
        const matchedUrls: string[] = [];

        if (assFontNames.length > 0) {
            const normalizedNames = new Set(assFontNames.map(normalizeFontName));
            const matchedFamilies = new Set<string>();

            for (const option of fontOptions) {
                const familyKey = option.familyName.trim().toLowerCase();
                if (matchedFamilies.has(familyKey) || !optionMatches(option, normalizedNames)) {
                    continue;
                }
                matchedFamilies.add(familyKey);
                // 跟随原字幕时同族只取主文件：同时加载中日文字体的全部字重会拉取上百 MB
                const primaryUrl = getOptionUrls(option)[0];
                if (primaryUrl) {
                    matchedUrls.push(primaryUrl);
                }
            }
        }

        if (matchedUrls.length > 0) {
            const availableFonts = await filterAvailableFonts([...matchedUrls, ...fallbackUrls]);
            if (matchedUrls.some((url) => availableFonts.includes(url))) {
                return availableFonts;
            }
        }

        // ASS 字体缺失或对应文件不可访问时，只加载回退字体
        if (fallbackUrls.length > 0) {
            console.log('使用系统回退字体');
        }

        return filterAvailableFonts(fallbackUrls);
    } catch (error) {
        console.error('加载字体失败:', error);
        return [];
    }
}
