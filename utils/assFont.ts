import { applyAssColor } from './assColor';

/**
 * ASS 字体改写与颜色/字体组合更新。
 *
 * 控制端把颜色开关与字体下拉的选择统一转换成一份新的 ASS 内容，
 * 再通过 socket 的 ass-content-update 发给展示端。
 */

const SECTION_PATTERN = /^\[([^\]]*)\]\s*$/;

/** Format 中找不到 Fontname 列时回退的列下标（与旧版 ASS 样式一致） */
const FALLBACK_FONT_COLUMN_INDEX = 1;

/**
 * 把 ASS/SSA 所有样式的 Fontname 替换为 fontFamily。
 *
 * - 同时支持 [V4+ Styles] 与 [V4 Styles]；
 * - 按 Format 行动态定位 Fontname 列，找不到时回退下标 1；
 * - 只改 Style: 行，其它列/空白/换行保持不变；
 * - 字体名为空、没有样式段或没有 Format 行时原样返回。
 */
export function applyAssFont(assContent: string, fontFamily: string): string {
    const fontName = fontFamily.trim();
    if (!fontName) {
        return assContent;
    }

    // 拆出换行分隔符，保证处理后的换行符与原文完全一致
    const segments = assContent.split(/(\r\n|\n|\r)/);
    let inStyleSection = false;
    let formatFields: string[] | null = null;

    for (let index = 0; index < segments.length; index += 2) {
        const line = segments[index] ?? '';
        const trimmedLine = line.trim();

        const sectionMatch = SECTION_PATTERN.exec(trimmedLine);
        if (sectionMatch) {
            const sectionName = (sectionMatch[1] ?? '').trim().toLowerCase();
            inStyleSection = sectionName === 'v4+ styles' || sectionName === 'v4 styles';
            formatFields = null;
            continue;
        }

        if (!inStyleSection || trimmedLine.length === 0 || trimmedLine.startsWith(';')) {
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

        const fieldIndex = formatFields.findIndex((field) => field.toLowerCase() === 'fontname');
        const targetIndex = fieldIndex >= 0 ? fieldIndex : FALLBACK_FONT_COLUMN_INDEX;

        const columns = payload.split(',');
        if (targetIndex >= columns.length) {
            continue;
        }

        // 只替换目标列的值，保留该列前后的空白与其它列原样内容
        const rawColumn = columns[targetIndex] ?? '';
        const leadingWhitespace = /^\s*/.exec(rawColumn)?.[0] ?? '';
        const trailingWhitespace = /\s*$/.exec(rawColumn)?.[0] ?? '';
        columns[targetIndex] = `${leadingWhitespace}${fontName}${trailingWhitespace}`;

        segments[index] = `${line.slice(0, colonIndex + 1)}${columns.join(',')}`;
    }

    return segments.join('');
}

export interface BuildAssUpdateOptions {
    /** 是否启用颜色改写：true 时保持 ASS 原色，false 时应用选中颜色（通用工具，控制端当前不使用颜色改写） */
    colorEnabled: boolean;
    /** 选中颜色（#RRGGBB / RRGGBB），colorEnabled=false 时生效 */
    colorHex?: string;
    /** 选中字体族名，非空时生效 */
    fontFamily?: string;
}

/**
 * 通用 ASS 更新工具：可选地应用颜色、字体。
 * 控制端当前为了让颜色跟随 ASS 本身，只调用 applyAssFont；该函数保留给脚本或后续扩展使用。
 */
export function buildAssUpdate(assContent: string, options: BuildAssUpdateOptions): string {
    let result = assContent;

    if (!options.colorEnabled) {
        result = applyAssColor(result, options.colorHex ?? '');
    }

    if (options.fontFamily && options.fontFamily.trim()) {
        result = applyAssFont(result, options.fontFamily);
    }

    return result;
}
