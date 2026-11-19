// 动态加载字体文件
//
// 展示端会按需加载字体：
// - 控制端选了具体字体文件时，只加载该文件，避免同族不同字重互相覆盖（Black/Thin 等才能生效）；
// - 未选字体时，按 ASS 样式实际引用的字体族名加载对应字体文件；
// - 匹配不到时回退为加载 public/fonts 下的全部字体。
// 加载前还会逐个 HEAD 校验，跳过无法访问的字体，避免个别字体 404 拖垮整个字幕渲染器。
const FONT_FILE_PATTERN = /\.(ttf|otf|ttc|woff2?)$/i;

/** 回退时优先加载的项目默认字体（比一次加载 public/fonts 全部字体轻得多） */
const PREFERRED_FALLBACK_FILES = ['FZFWZhuZiAYuanJWB.TTF', 'TsukushiAMaruGothic.ttc'];
/** 回退时最多加载的字体数量 */
const MAX_FALLBACK_FONTS = 2;

interface FontOption {
    fileName: string;
    familyName: string;
    url: string;
}

async function isFontAvailable(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        return response.ok;
    } catch {
        return false;
    }
}

async function fetchFontOptions(): Promise<FontOption[]> {
    try {
        const response = await fetch('/api/font-options', { cache: 'no-store' });
        if (!response.ok) return [];
        return (await response.json()) as FontOption[];
    } catch {
        return [];
    }
}

/** 按 Format 行解析 ASS 样式实际引用的 Fontname 列表 */
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

    return [...names];
}

export interface LoadFontsOptions {
    /** 控制端选中的具体字体文件 URL；非空时只加载该文件 */
    selectedFontUrl?: string;
    /** 当前 ASS 内容，用于按样式引用的字体族名匹配需要加载的字体文件 */
    assContent?: string;
}

export async function loadFonts(options: LoadFontsOptions = {}): Promise<string[]> {
    try {
        let fontPaths: string[] = [];

        if (options.selectedFontUrl) {
            fontPaths = [options.selectedFontUrl];
        } else {
            const assFontNames = extractAssFontNames(options.assContent ?? '');
            if (assFontNames.length > 0) {
                const fontOptions = await fetchFontOptions();
                const normalizedNames = assFontNames.map((name) => name.toLowerCase());
                // 同族字体只取一个文件：ASS 的风格字体通常是一个家族，
                // 全部加载同族字重会白白拉取几十上百 MB（还可能拖慢/拖垮渲染器）
                const seenFamilies = new Set<string>();
                for (const option of fontOptions) {
                    const family = option.familyName.trim().toLowerCase();
                    if (!normalizedNames.includes(family) || seenFamilies.has(family)) {
                        continue;
                    }
                    seenFamilies.add(family);
                    fontPaths.push(option.url);
                }
            }

            if (fontPaths.length === 0) {
                const response = await fetch('/api/fonts', { cache: 'no-store' });
                if (!response.ok) {
                    console.error('获取字体列表失败:', response.status);
                    return [];
                }
                const fonts = (await response.json()) as string[];
                const fontFiles = fonts.filter((font) => FONT_FILE_PATTERN.test(font));
                const preferredFiles = PREFERRED_FALLBACK_FILES.filter((fileName) =>
                    fontFiles.includes(fileName),
                );
                const fallbackFiles =
                    preferredFiles.length > 0
                        ? preferredFiles
                        : fontFiles.slice(0, MAX_FALLBACK_FONTS);
                console.log('使用回退字体:', fallbackFiles);
                fontPaths = fallbackFiles.map((font) => `/fonts/${font}`);
            }
        }

        const availability = await Promise.all(
            fontPaths.map(async (url) => ((await isFontAvailable(url)) ? url : null)),
        );
        const availableFonts = availability.filter((url): url is string => url !== null);

        const missingCount = fontPaths.length - availableFonts.length;
        if (missingCount > 0) {
            console.warn(`有 ${missingCount} 个字体文件无法访问，已跳过这些字体`);
        }

        // 选中的字体文件不可用时，回退为按 ASS 引用/全部字体加载，避免字幕彻底没有字体
        if (options.selectedFontUrl && availableFonts.length === 0) {
            return loadFonts({ assContent: options.assContent });
        }

        return availableFonts;
    } catch (error) {
        console.error('加载字体失败:', error);
        return [];
    }
}
