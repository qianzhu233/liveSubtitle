// 动态加载字体文件
//
// 展示端会先逐个校验字体文件是否真的可访问：浏览器（尤其 OBS 内置浏览器）可能缓存了
// 已删除字体的旧列表，而 SubtitlesOctopus 只要有一个字体加载失败就会让整个 worker 报错、
// 字幕不显示。这里直接跳过无法访问的字体，避免单个坏字体导致整块字幕消失。
const FONT_FILE_PATTERN = /\.(ttf|otf|ttc|woff2?)$/i;

async function isFontAvailable(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        return response.ok;
    } catch {
        return false;
    }
}

export async function loadFonts(): Promise<string[]> {
    try {
        const response = await fetch('/api/fonts', { cache: 'no-store' });
        if (!response.ok) {
            console.error('获取字体列表失败:', response.status);
            return [];
        }

        const fonts = (await response.json()) as string[];
        console.log('找到字体文件:', fonts);

        const fontPaths = fonts
            .filter((font) => FONT_FILE_PATTERN.test(font))
            .map((font) => `/fonts/${font}`);

        const availability = await Promise.all(
            fontPaths.map(async (url) => ((await isFontAvailable(url)) ? url : null)),
        );
        const availableFonts = availability.filter((url): url is string => url !== null);

        const missingCount = fontPaths.length - availableFonts.length;
        if (missingCount > 0) {
            console.warn(`有 ${missingCount} 个字体文件无法访问，已跳过这些字体`);
        }

        return availableFonts;
    } catch (error) {
        console.error('加载字体失败:', error);
        return [];
    }
}
