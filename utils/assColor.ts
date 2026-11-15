/**
 * ASS 样式颜色处理。
 *
 * 颜色开关会把 ASS/SSA 的描边颜色统一替换成客户端选中的颜色：
 * - ASS v4.00+（[V4+ Styles]）使用 OutlineColour；
 * - SSA v4（[V4 Styles]）使用 TertiaryColour。
 * 目标列按 Format 行动态定位，不依赖字段顺序。
 */

const HEX_COLOR_PATTERN = /^#?([0-9a-fA-F]{6})$/;
const SECTION_PATTERN = /^\[([^\]]*)\]\s*$/;

/** 样式段名（小写）到目标颜色字段名 */
const TARGET_FIELD_BY_SECTION: Record<string, string> = {
    'v4+ styles': 'OutlineColour',
    'v4 styles': 'TertiaryColour',
};

/** Format 中找不到目标字段名时回退的列下标（与旧实现保持一致） */
const FALLBACK_COLUMN_INDEX = 5;

/**
 * 把 #RRGGBB / RRGGBB 转成 ASS 颜色字面量 &H00BBGGRR。
 * 颜色值非法时返回 null。
 */
export function hexToAssColor(colorHex: string): string | null {
    const match = HEX_COLOR_PATTERN.exec(colorHex.trim());
    if (!match) {
        return null;
    }

    const hex = match[1]!.toUpperCase();
    const red = hex.slice(0, 2);
    const green = hex.slice(2, 4);
    const blue = hex.slice(4, 6);

    return `&H00${blue}${green}${red}`;
}

/**
 * 替换 ASS/SSA 样式描边颜色。
 *
 * - 支持 [V4+ Styles]（OutlineColour）与 [V4 Styles]（TertiaryColour）；
 * - 按 Format 行定位目标列，找不到已知字段名时回退下标 5；
 * - 只改 Style: 行，其余内容与换行保持不变；
 * - 颜色非法、没有样式段或没有 Format 行时原样返回。
 */
export function applyAssColor(assContent: string, colorHex: string): string {
    const assColor = hexToAssColor(colorHex);
    if (!assColor) {
        return assContent;
    }

    // 拆出换行分隔符，保证处理后的换行符与原文完全一致
    const segments = assContent.split(/(\r\n|\n|\r)/);
    let targetFieldName: string | null = null;
    let formatFields: string[] | null = null;

    for (let index = 0; index < segments.length; index += 2) {
        const line = segments[index] ?? '';
        const trimmedLine = line.trim();

        const sectionMatch = SECTION_PATTERN.exec(trimmedLine);
        if (sectionMatch) {
            const sectionName = (sectionMatch[1] ?? '').trim().toLowerCase();
            targetFieldName = TARGET_FIELD_BY_SECTION[sectionName] ?? null;
            formatFields = null;
            continue;
        }

        if (!targetFieldName || trimmedLine.length === 0 || trimmedLine.startsWith(';')) {
            continue;
        }

        const colonIndex = line.indexOf(':');
        if (colonIndex < 0) {
            continue;
        }

        const keyword = line.slice(0, colonIndex).trim().toLowerCase();
        const payload = line.slice(colonIndex + 1);

        if (keyword === 'format') {
            formatFields = payload
                .split(',')
                .map((field) => field.trim())
                .filter((field) => field.length > 0);
            continue;
        }

        if (keyword !== 'style' || !formatFields || formatFields.length === 0) {
            continue;
        }

        const fieldIndex = formatFields.findIndex(
            (field) => field.toLowerCase() === targetFieldName!.toLowerCase(),
        );
        const targetIndex = fieldIndex >= 0 ? fieldIndex : FALLBACK_COLUMN_INDEX;

        const columns = payload.split(',');
        if (targetIndex >= columns.length) {
            continue;
        }

        // 只替换目标列的值，保留该列前后的空白与其它列原样内容
        const rawColumn = columns[targetIndex] ?? '';
        const leadingWhitespace = /^\s*/.exec(rawColumn)?.[0] ?? '';
        const trailingWhitespace = /\s*$/.exec(rawColumn)?.[0] ?? '';
        columns[targetIndex] = `${leadingWhitespace}${assColor}${trailingWhitespace}`;

        segments[index] = `${line.slice(0, colonIndex + 1)}${columns.join(',')}`;
    }

    return segments.join('');
}
