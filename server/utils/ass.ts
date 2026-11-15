import { Buffer, isUtf8 } from 'node:buffer';
import type { SubtitleBlock } from '../../types/subtitle';

/**
 * 通用 ASS/SSA 解析器。
 *
 * 支持 ASS v4.00+（[V4+ Styles]）与 SSA v4（[V4 Styles]），不依赖字段顺序，
 * 所有字段均按 Format 行声明的名字取值。解析结果与原始字幕文件互不影响，
 * 供服务端构造时间轴使用。
 */

/** ASS Styles 段中的一条 Style 记录 */
export interface AssStyle {
    /** 所属样式段的原始名称，例如 "V4+ Styles" / "V4 Styles" */
    section: string;
    /** Style 名称（Name 字段） */
    name: string;
    /** 生成该记录时生效的 Format 字段名列表 */
    format: string[];
    /** 字段名（已知字段统一为 ASS 标准写法）到字段值的映射 */
    fields: Record<string, string>;
    /** 原始 Style 行（已 trim） */
    raw: string;
}

/** ASS Events 段中的一条 Dialogue / Comment 记录 */
export interface AssEvent {
    type: 'Dialogue' | 'Comment';
    /** 生成该记录时生效的 Format 字段名列表 */
    format: string[];
    /** 字段名（已知字段统一为 ASS 标准写法）到字段值的映射 */
    fields: Record<string, string>;
    /** 开始时间（秒），已解析并校验 */
    startTime: number;
    /** 结束时间（秒），已解析并校验 */
    endTime: number;
    /** 去掉 override tags、换行转义并 trim 后的纯文本 */
    text: string;
    /** Layer / Marked 字段数值（缺失或非法时为 0） */
    layer: number;
    /** 原始事件行（已 trim） */
    raw: string;
}

/** parseAssContent 的完整解析结果 */
export interface ParsedAss {
    /** [Script Info] 键值对（键保留原大小写） */
    scriptInfo: Record<string, string>;
    /** 文件中出现过的所有段名（去重前的顺序列表） */
    sections: string[];
    /** 最后一个 Styles 段的段名，例如 "V4+ Styles"；没有样式段时为 null */
    styleSection: string | null;
    /** 最后一个 Styles 段的 Format 字段名；没有时为 null */
    styleFormat: string[] | null;
    /** 所有样式段中的 Style 记录 */
    styles: AssStyle[];
    /** [Events] 段的 Format 字段名；没有时为 null */
    eventFormat: string[] | null;
    /** 可播放的 Dialogue 事件（时间非法的事件已跳过，按文件顺序） */
    events: AssEvent[];
    /** Comment 事件（时间非法的事件已跳过，不参与时间轴） */
    comments: AssEvent[];
}

const DEFAULT_V4_PLUS_STYLE_FORMAT = [
    'Name',
    'Fontname',
    'Fontsize',
    'PrimaryColour',
    'SecondaryColour',
    'OutlineColour',
    'BackColour',
    'Bold',
    'Italic',
    'Underline',
    'StrikeOut',
    'ScaleX',
    'ScaleY',
    'Spacing',
    'Angle',
    'BorderStyle',
    'Outline',
    'Shadow',
    'Alignment',
    'MarginL',
    'MarginR',
    'MarginV',
    'Encoding',
];

const DEFAULT_V4_STYLE_FORMAT = [
    'Name',
    'Fontname',
    'Fontsize',
    'PrimaryColour',
    'SecondaryColour',
    'TertiaryColour',
    'BackColour',
    'Bold',
    'Italic',
    'BorderStyle',
    'Outline',
    'Shadow',
    'Alignment',
    'MarginL',
    'MarginR',
    'MarginV',
    'AlphaLevel',
    'Encoding',
];

const DEFAULT_EVENT_FORMAT = [
    'Layer',
    'Start',
    'End',
    'Style',
    'Name',
    'MarginL',
    'MarginR',
    'MarginV',
    'Effect',
    'Text',
];

const SECTION_PATTERN = /^\[([^\]]*)\]\s*$/;
const ASS_TIME_PATTERN = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/;
const OVERRIDE_TAG_PATTERN = /\{[^}]*\}/g;
const LINE_BREAK_PATTERN = /\\[Nnh]/g;

const KNOWN_FIELD_NAMES = [
    ...DEFAULT_V4_PLUS_STYLE_FORMAT,
    ...DEFAULT_V4_STYLE_FORMAT,
    ...DEFAULT_EVENT_FORMAT,
    'Marked',
    'Actor',
];

const CANONICAL_FIELD_NAMES: Record<string, string> = {};
for (const fieldName of KNOWN_FIELD_NAMES) {
    CANONICAL_FIELD_NAMES[fieldName.toLowerCase()] = fieldName;
}

/** 按字段名大小写不敏感地从 fields 中取值 */
export function getAssField(
    fields: Record<string, string>,
    fieldName: string,
    caseSensitive = false,
): string | undefined {
    if (caseSensitive) {
        return fields[fieldName];
    }

    const target = fieldName.toLowerCase();
    for (const [key, value] of Object.entries(fields)) {
        if (key.trim().toLowerCase() === target) {
            return value;
        }
    }

    return undefined;
}

/**
 * 解析 ASS/SSA 时间戳，例如 "0:00:30.59"、"0:01:05.2"、"1:02:03.456"。
 * 小数部分为 1-3 位；格式非法、分钟或秒超出范围时返回 null。
 */
export function parseAssTime(value: string | undefined): number | null {
    if (!value) {
        return null;
    }

    const match = ASS_TIME_PATTERN.exec(value.trim());
    if (!match) {
        return null;
    }

    const hours = Number.parseInt(match[1]!, 10);
    const minutes = Number.parseInt(match[2]!, 10);
    const seconds = Number.parseInt(match[3]!, 10);
    const fraction = match[4] ?? '';

    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
        return null;
    }
    if (minutes > 59 || seconds > 59) {
        return null;
    }

    // 与 config.txt 的 parseFloat 保持一致：整秒 + 小数部分
    const secondsWithFraction = fraction ? Number.parseFloat(`${seconds}.${fraction}`) : seconds;

    return hours * 3600 + minutes * 60 + secondsWithFraction;
}

/**
 * 清理 ASS 文本：去掉 {…} override tags，把 \N \n \h 转成空格，并去掉首尾空白。
 * 不压缩内部空白，避免破坏全角空格等排版字符。
 */
export function cleanAssText(text: string): string {
    return text.replace(OVERRIDE_TAG_PATTERN, '').replace(LINE_BREAK_PATTERN, ' ').trim();
}

/** 把事件 Layer / Marked 字段转成数字；兼容 "Marked=1" 这类写法 */
function parseLayerValue(value: string | undefined): number {
    if (!value) {
        return 0;
    }

    const match = /-?\d+/.exec(value);
    if (!match) {
        return 0;
    }

    const layer = Number.parseInt(match[0], 10);
    return Number.isFinite(layer) ? layer : 0;
}

/** 按逗号拆分并 trim 出 Format 字段名；已知字段统一成 ASS 标准大小写 */
function parseFormatFields(payload: string): string[] {
    return payload
        .split(',')
        .map((field) => field.trim())
        .filter((field) => field.length > 0)
        .map((field) => CANONICAL_FIELD_NAMES[field.toLowerCase()] ?? field);
}

/**
 * 按固定列数拆分逗号分隔内容，多出来的逗号合并进最后一列。
 * 用于 Events 的 Text（最后一列可能包含逗号）与 Styles 的最后一个字段。
 */
function splitFields(payload: string, columnCount: number): string[] {
    if (columnCount <= 0) {
        return [payload];
    }

    const columns: string[] = [];
    let rest = payload;

    while (columns.length < columnCount - 1) {
        const commaIndex = rest.indexOf(',');
        if (commaIndex < 0) {
            break;
        }
        columns.push(rest.slice(0, commaIndex));
        rest = rest.slice(commaIndex + 1);
    }
    columns.push(rest);

    return columns;
}

/** 把列数组按 Format 字段名映射成对象；缺失的列补空字符串 */
function mapFields(format: string[], columns: string[]): Record<string, string> {
    const fields: Record<string, string> = {};
    format.forEach((fieldName, index) => {
        fields[fieldName] = (columns[index] ?? '').trim();
    });
    return fields;
}

function defaultStyleFormat(sectionName: string): string[] {
    return sectionName.toLowerCase() === 'v4 styles'
        ? DEFAULT_V4_STYLE_FORMAT
        : DEFAULT_V4_PLUS_STYLE_FORMAT;
}

function parseEventLine(
    type: 'Dialogue' | 'Comment',
    payload: string,
    format: string[] | null,
    raw: string,
): AssEvent | null {
    const effectiveFormat = format && format.length > 0 ? format : DEFAULT_EVENT_FORMAT;
    const columns = splitFields(payload, effectiveFormat.length);
    const fields = mapFields(effectiveFormat, columns);

    const startTime = parseAssTime(getAssField(fields, 'Start'));
    const endTime = parseAssTime(getAssField(fields, 'End'));
    if (startTime === null || endTime === null) {
        return null;
    }

    // Text 固定为最后一列，splitFields 已把多余的逗号保留在最后一列中
    const textColumn = columns.at(-1) ?? '';
    const layerValue = getAssField(fields, 'Layer') ?? getAssField(fields, 'Marked');

    return {
        type,
        format: [...effectiveFormat],
        fields,
        startTime,
        endTime,
        text: cleanAssText(textColumn),
        layer: parseLayerValue(layerValue),
        raw,
    };
}

/**
 * 解析 ASS/SSA 文本内容。
 *
 * - 段名与 Format/Style/Dialogue/Comment 关键字大小写不敏感；
 * - 兼容 CRLF 与 BOM；
 * - Format 字段顺序任意，按字段名取值；
 * - Text 视为最后一列，允许文本内部含逗号；
 * - Comment 行记录到 comments，不参与时间轴；
 * - 时间非法的 Dialogue/Comment 会被跳过。
 */
export function parseAssContent(content: string): ParsedAss {
    const parsed: ParsedAss = {
        scriptInfo: {},
        sections: [],
        styleSection: null,
        styleFormat: null,
        styles: [],
        eventFormat: null,
        events: [],
        comments: [],
    };

    if (!content) {
        return parsed;
    }

    const normalized = content.replace(/^\uFEFF/, '');
    const lines = normalized.split(/\r\n|\n|\r/);
    let currentSection = '';

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.length === 0) {
            continue;
        }

        const sectionMatch = SECTION_PATTERN.exec(line);
        if (sectionMatch) {
            currentSection = (sectionMatch[1] ?? '').trim();
            parsed.sections.push(currentSection);
            continue;
        }

        // 注释行（; 开头）在所有段中都不参与解析
        if (line.startsWith(';')) {
            continue;
        }

        const colonIndex = line.indexOf(':');
        if (colonIndex < 0) {
            continue;
        }

        const keyword = line.slice(0, colonIndex).trim().toLowerCase();
        const payload = line.slice(colonIndex + 1);
        const sectionKey = currentSection.toLowerCase();

        if (sectionKey === 'script info') {
            const key = line.slice(0, colonIndex).trim();
            if (key.length > 0) {
                parsed.scriptInfo[key] = payload.trim();
            }
            continue;
        }

        if (sectionKey === 'v4+ styles' || sectionKey === 'v4 styles') {
            if (keyword === 'format') {
                parsed.styleSection = currentSection;
                parsed.styleFormat = parseFormatFields(payload);
                continue;
            }

            if (keyword === 'style') {
                const format = parsed.styleFormat ?? defaultStyleFormat(currentSection);
                const columns = splitFields(payload, format.length);
                const fields = mapFields(format, columns);
                parsed.styles.push({
                    section: currentSection,
                    name: getAssField(fields, 'Name') ?? '',
                    format: [...format],
                    fields,
                    raw: line,
                });
            }
            continue;
        }

        if (sectionKey === 'events') {
            if (keyword === 'format') {
                parsed.eventFormat = parseFormatFields(payload);
                continue;
            }

            if (keyword === 'dialogue' || keyword === 'comment') {
                const type = keyword === 'comment' ? 'Comment' : 'Dialogue';
                const event = parseEventLine(type, payload, parsed.eventFormat, line);
                if (!event) {
                    continue;
                }
                if (type === 'Comment') {
                    parsed.comments.push(event);
                } else {
                    parsed.events.push(event);
                }
            }
        }
    }

    return parsed;
}

/**
 * 把解析结果转成服务端时间轴使用的 SubtitleBlock 列表。
 *
 * - 只保留 startTime < endTime 且文本非空的事件；
 * - Layer / Marked > 0 的事件 track 为 2，否则为 1；
 * - 按开始时间稳定排序，id 按排序后的顺序编号。
 */
export function assToBlocks(parsed: ParsedAss, songName: string): SubtitleBlock[] {
    return parsed.events
        .filter((event) => event.startTime < event.endTime && event.text.length > 0)
        .sort((left, right) => left.startTime - right.startTime)
        .map((event, index) => ({
            id: `${songName}-${index + 1}`,
            startTime: event.startTime,
            endTime: event.endTime,
            text: event.text,
            track: event.layer > 0 ? 2 : 1,
        }));
}

/** 去掉字符串开头的 BOM 字符 */
function stripBom(text: string): string {
    return text.replace(/^\uFEFF/, '');
}

/** 无 BOM 时根据 NUL 字节分布猜测 UTF-16LE / UTF-16BE */
function detectUtf16WithoutBom(buffer: Buffer): 'utf-16le' | 'utf-16be' | null {
    if (buffer.length < 4 || buffer.length % 2 !== 0) {
        return null;
    }

    const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
    let zeroOnEven = 0;
    let zeroOnOdd = 0;

    for (let index = 0; index < sample.length; index++) {
        if (sample[index] === 0) {
            if (index % 2 === 0) {
                zeroOnEven++;
            } else {
                zeroOnOdd++;
            }
        }
    }

    if (zeroOnOdd >= sample.length / 4 && zeroOnOdd > zeroOnEven * 4) {
        return 'utf-16le';
    }
    if (zeroOnEven >= sample.length / 4 && zeroOnEven > zeroOnOdd * 4) {
        return 'utf-16be';
    }

    return null;
}

function decodeWithFallback(buffer: Buffer): string {
    for (const encoding of ['gb18030', 'gbk']) {
        try {
            return stripBom(new TextDecoder(encoding).decode(buffer));
        } catch {
            // 当前 Node 构建不支持该编码时继续尝试下一个
        }
    }

    return stripBom(new TextDecoder('utf-8').decode(buffer));
}

/**
 * 解码 ASS/SSA 文件内容。
 *
 * 依次识别 UTF-8 BOM、UTF-16LE BOM、UTF-16BE BOM、无 BOM UTF-16 特征，
 * 然后优先按 UTF-8 解码；不是合法 UTF-8 时回退 GB18030 / GBK。
 */
export function decodeAssBuffer(buffer: Buffer): string {
    if (!buffer || buffer.length === 0) {
        return '';
    }

    const bytes = buffer;

    // UTF-8 BOM
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return stripBom(new TextDecoder('utf-8').decode(bytes));
    }

    // UTF-16LE BOM
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return stripBom(new TextDecoder('utf-16le').decode(bytes));
    }

    // UTF-16BE BOM
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return stripBom(new TextDecoder('utf-16be').decode(bytes));
    }

    const utf16Encoding = detectUtf16WithoutBom(bytes);
    if (utf16Encoding) {
        return stripBom(new TextDecoder(utf16Encoding).decode(bytes));
    }

    if (isUtf8(bytes)) {
        return stripBom(new TextDecoder('utf-8').decode(bytes));
    }

    return decodeWithFallback(bytes);
}
