#!/usr/bin/env node
/**
 * @file LRC 歌词 → liveSubtitle 字幕包生成器（零依赖，Node >= 18）。
 *
 * 读取 .lrc 歌词文件，生成 liveSubtitle 项目可直接使用的字幕目录：
 *   <out>/<歌曲名>/config.txt   时间轴（轨道,开始时间,结束时间,文本）
 *   <out>/<歌曲名>/subtitle.ass ASS 字幕（[Script Info] + [V4+ Styles] + [Events]）
 *   <out>/<歌曲名>/lyrics.txt   仅当提供 --translation 时生成（中/日成对歌词）
 * 可选把歌曲追加到 <out>/filter-config.json 的筛选器中。
 *
 * @author liveSubtitle
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 增强型 LRC 的词时间戳。
 * @typedef {Object} LrcWord
 * @property {number} timeMs
 * @property {string} text
 */

/**
 * 一行已解析的歌词。
 * @typedef {Object} LrcLine
 * @property {number} startMs
 * @property {string} text
 * @property {LrcWord[]} words
 */

/**
 * @typedef {Object} LrcMetadata
 * @property {string} title       [ti:]
 * @property {string} artist      [ar:]
 * @property {string} album       [al:]
 * @property {string} by          [by:]
 * @property {number} offsetMs    [offset:]，毫秒
 * @property {number} lengthMs    [length:]，毫秒（0 表示未知）
 * @property {Record<string, string>} raw 全部原始元数据键值（键小写）
 */

/**
 * @typedef {Object} ParsedLrc
 * @property {LrcMetadata} metadata
 * @property {LrcLine[]} lines
 * @property {string[]} warnings
 */

/**
 * 允许参与时间轴计算的输入行（words 可省略）。
 * @typedef {Object} TimelineInputLine
 * @property {number} startMs
 * @property {string} text
 * @property {string} [translation]
 * @property {string} [lang]            原文语言（ja/zh/en），用于块级覆盖
 * @property {string} [translationLang] 译文语言（ja/zh/en），用于块级覆盖
 * @property {LrcWord[]} [words]
 */

/**
 * @typedef {Object} TimelineLine
 * @property {number} startMs
 * @property {number} endMs
 * @property {string} text
 * @property {string} translation
 * @property {string} [lang]
 * @property {string} [translationLang]
 * @property {LrcWord[]} [words]
 */

/**
 * @typedef {Object} FilterConfigPlan
 * @property {string} path
 * @property {any[]} config
 * @property {boolean} changed
 * @property {boolean} created
 * @property {boolean} addedEntry
 * @property {boolean} addedSong
 * @property {boolean} typeMismatch
 * @property {string[]} warnings
 */

/**
 * @typedef {Object} CliIo
 * @property {string} [cwd]
 * @property {(text: string) => void} [stdout]
 * @property {(text: string) => void} [stderr]
 */

/** 字幕轨道允许的取值 */
const VALID_TRACKS = [1, 2];
/** filter-config.json 允许的筛选器类型 */
const VALID_FILTER_TYPES = ['album', 'unit', 'live', 'solo'];
/** 最后一行默认展示时长 */
const LAST_LINE_DURATION_MS = 5000;
/** 相邻两行时间戳重复时的最小行时长 */
const MIN_LINE_DURATION_MS = 500;
/** 翻译配对默认容差 */
const TRANSLATION_TOLERANCE_MS = 100;
/** 英文样式使用的字体（不单独提供 --font-en） */
const EN_FONT = 'Arial';

/** 语言 → 样式前缀 / ASS 竖直位置 / 字号，位置取自 scripts/lyrics2ass.js */
const LANGUAGE_CONFIG = {
    ja: { prefix: '日文', position: 1075, mainSize: 54, outerSize: 45, fSize: 30 },
    zh: { prefix: '中文', position: 1020, mainSize: 64, outerSize: 39, fSize: 30 },
    en: { prefix: '英文', position: 1075, mainSize: 54, outerSize: 45, fSize: 30 },
};

/** 生成样式表时使用的稳定语言顺序 */
const LANGUAGE_ORDER = ['ja', 'zh', 'en'];

/** 假名（平假名 / 片假名 / 半角片假名） */
const KANA_PATTERN = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9d]/;
/** 汉字（CJK 统一表意文字与兼容区） */
const HAN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005\u3007]/;
/** 拉丁字母 */
const LATIN_PATTERN = /[A-Za-z]/;

/** credits / 制作信息行：行首常见标签 + 冒号（半角或全角） */
const CREDIT_LINE_PATTERN =
    /^(作词|作曲|编曲|制作人|监制|出品|混音|母带|录音|和声|吉他|贝斯|鼓|弦乐|键盘|演唱|原唱|翻唱|策划|发行|版权|OP|SP|词|曲|Lyrics|Composer|Arranger|Producer|Mixing|Mastering|Recorded|Vocals?|Guitar|Bass|Drums|Strings|Label|Publishing|Engineer)\s*[:：]/i;

/** 自动双语配对判定阈值：候选 2 行组数量、候选组占比、语言混合占比 */
const BILINGUAL_MIN_PAIR_GROUPS = 3;
const BILINGUAL_MIN_PAIR_RATIO = 0.5;
const BILINGUAL_MIN_MIXED_RATIO = 0.8;

/** --lang / --translation-lang 接受的语言别名 → 内部语言代码 */
const LANGUAGE_ALIASES = {
    ja: 'ja',
    jp: 'ja',
    japanese: 'ja',
    日文: 'ja',
    日语: 'ja',
    zh: 'zh',
    cn: 'zh',
    chinese: 'zh',
    中文: 'zh',
    汉语: 'zh',
    en: 'en',
    english: 'en',
    英文: 'en',
    英语: 'en',
};

/** 样式模板中的演唱者与描边颜色，取自 scripts/lyrics2ass.js（Liella 使用 --color） */
const SINGER_STYLES = [
    { name: 'Liella', color: null },
    { name: 'Kanon', color: '#FF7F27' },
    { name: 'Keke', color: '#43D1D9' },
    { name: 'Chisato', color: '#FF6E90' },
    { name: 'Sumire', color: '#4B9C40' },
    { name: 'Ren', color: '#0000A0' },
    { name: 'Kinako', color: '#31B1C1' },
    { name: 'Mei', color: '#FF3535' },
    { name: 'Shiki', color: '#7FB0A6' },
    { name: 'Natsumi', color: '#FF51C4' },
    { name: 'Margarete', color: '#D895F0' },
    { name: 'Tomari', color: '#27A7AE' },
];

/** ASS [V4+ Styles] 的 Format 行（与 scripts/lyrics2ass.js 保持一致） */
const ASS_STYLE_FORMAT_LINE =
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, ' +
    'BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, ' +
    'BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';

/** ASS [Events] 的 Format 行 */
const ASS_EVENT_FORMAT_LINE =
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';

/** 默认参数 */
const DEFAULT_OPTIONS = {
    name: '',
    out: 'subtitleFiles',
    track: 1,
    offsetMs: 0,
    lang: 'auto',
    translation: '',
    translationLang: 'auto',
    color: '#A5469C',
    fontJa: 'Tsukushi A Round Gothic',
    fontZh: 'FZFW ZhuZi A YuanS',
    filter: '',
    filterType: 'album',
    force: false,
    dryRun: false,
    noAutoPair: false,
    keepCredits: false,
    help: false,
};

/** 需要取值的 CLI 选项 */
const VALUE_OPTIONS = new Set([
    '--name',
    '--out',
    '--track',
    '--offset-ms',
    '--lang',
    '--translation',
    '--translation-lang',
    '--color',
    '--font-ja',
    '--font-zh',
    '--filter',
    '--filter-type',
]);

/** 布尔 CLI 选项 */
const FLAG_OPTIONS = new Set([
    '--force',
    '--dry-run',
    '--no-auto-pair',
    '--keep-credits',
    '--help',
]);

/** 增强型词时间戳，如 <00:12.34> */
const WORD_TAG_RE = /<(\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)>/g;

/**
 * 把毫秒格式化为 liveSubtitle / ASS 通用的 H:MM:SS.CC。
 * @param {number} ms
 * @returns {string}
 */
export function formatTimestamp(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
        return '0:00:00.00';
    }
    const totalCentiseconds = Math.round(ms / 10);
    const centiseconds = totalCentiseconds % 100;
    const totalSeconds = Math.floor(totalCentiseconds / 100);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(
        centiseconds,
    ).padStart(2, '0')}`;
}

/**
 * 把 #RRGGBB 转换为 ASS 的 &H00BBGGRR。
 * @param {string} hexColor
 * @returns {string}
 */
function colorToAss(hexColor) {
    const hex = String(hexColor).replace('#', '').toUpperCase();
    const red = hex.slice(0, 2);
    const green = hex.slice(2, 4);
    const blue = hex.slice(4, 6);
    return `&H00${blue}${green}${red}`;
}

/**
 * 校验并规范化 #RRGGBB 颜色。
 * @param {string} value
 * @returns {string}
 */
function normalizeColor(value) {
    const match = /^#?([0-9a-fA-F]{6})$/.exec(String(value).trim());
    if (!match) {
        throw new Error(`颜色格式应为 #RRGGBB，收到 "${value}"`);
    }
    return `#${match[1].toUpperCase()}`;
}

/**
 * 把 --lang / --translation-lang 的取值解析为内部语言代码。
 * @param {string} value
 * @returns {string}
 */
function resolveLanguage(value) {
    const normalized = String(value).trim().toLowerCase();
    const language = LANGUAGE_ALIASES[normalized];
    if (!language) {
        throw new Error(`不支持的语言 "${value}"，可选 auto、ja、zh、en（或 日文/中文/英文）`);
    }
    return language;
}

/**
 * 解析 --lang / --translation-lang 的取值，允许 auto。
 * @param {string} value
 * @returns {string} auto / ja / zh / en
 */
function resolveLanguageOption(value) {
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'auto') {
        return 'auto';
    }
    return resolveLanguage(value);
}

/**
 * 语言代码 → 面向用户的中文名称。
 * @param {string} language
 * @returns {string}
 */
function languageName(language) {
    if (language === 'ja') {
        return '日文';
    }
    if (language === 'zh') {
        return '中文';
    }
    if (language === 'en') {
        return '英文';
    }
    return '其他';
}

/**
 * 按行识别语言：出现假名 → ja；无假名有汉字 → zh；无汉字/假名有拉丁字母 → en；否则 other。
 * @param {string} text
 * @returns {string} ja / zh / en / other
 */
export function detectLanguage(text) {
    const value = String(text ?? '');
    if (KANA_PATTERN.test(value)) {
        return 'ja';
    }
    if (HAN_PATTERN.test(value)) {
        return 'zh';
    }
    if (LATIN_PATTERN.test(value)) {
        return 'en';
    }
    return 'other';
}

/**
 * 整体识别语言：统计各行语言，出现最多者胜出，平票取先出现者。
 * @param {string[]} texts
 * @returns {string} ja / zh / en / other
 */
export function detectDominantLanguage(texts) {
    /** @type {Map<string, { count: number, firstIndex: number }>} */
    const stats = new Map();
    texts.forEach((text, index) => {
        const language = detectLanguage(text);
        if (language === 'other') {
            return;
        }
        const stat = stats.get(language);
        if (stat) {
            stat.count += 1;
        } else {
            stats.set(language, { count: 1, firstIndex: index });
        }
    });
    let best = 'other';
    let bestCount = 0;
    let bestFirstIndex = Number.POSITIVE_INFINITY;
    for (const [language, stat] of stats) {
        if (
            stat.count > bestCount ||
            (stat.count === bestCount && stat.firstIndex < bestFirstIndex)
        ) {
            best = language;
            bestCount = stat.count;
            bestFirstIndex = stat.firstIndex;
        }
    }
    return best;
}

/**
 * 判断一行是否为 credits / 制作信息（行首常见标签 + 冒号）。
 * @param {string} text
 * @returns {boolean}
 */
function isCreditLine(text) {
    return CREDIT_LINE_PATTERN.test(String(text ?? '').trim());
}

/**
 * 过滤 credits / 制作信息行。
 * @param {TimelineInputLine[]} lines
 * @returns {{ lines: TimelineInputLine[], skippedCount: number }}
 */
function filterCreditLines(lines) {
    const kept = lines.filter((line) => !isCreditLine(line.text));
    return { lines: kept, skippedCount: lines.length - kept.length };
}

/**
 * 去除同一时间戳下完全相同的重复行（保留先出现的一行）。
 * @param {TimelineInputLine[]} lines
 * @returns {{ lines: TimelineInputLine[], removedCount: number }}
 */
function dedupeIdenticalLines(lines) {
    const seen = new Set();
    /** @type {TimelineInputLine[]} */
    const kept = [];
    for (const line of lines) {
        const key = `${line.startMs}\u0000${line.text}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        kept.push(line);
    }
    return { lines: kept, removedCount: lines.length - kept.length };
}

/**
 * 按开始时间戳分组（组内保持文件顺序）。
 * @param {TimelineInputLine[]} lines
 * @returns {Array<{ startMs: number, lines: TimelineInputLine[] }>}
 */
function groupLinesByTimestamp(lines) {
    /** @type {Map<number, TimelineInputLine[]>} */
    const groups = new Map();
    for (const line of lines) {
        const group = groups.get(line.startMs);
        if (group) {
            group.push(line);
        } else {
            groups.set(line.startMs, [line]);
        }
    }
    return Array.from(groups, ([startMs, groupLines]) => ({ startMs, lines: groupLines }));
}

/**
 * 判定单文件是否像双语字幕：同时间戳恰好 2 行的组占比足够高，
 * 且其中两行语言不同的组占比足够高，避免把单语和声/合唱误判为双语。
 * @param {TimelineInputLine[]} lines
 * @returns {{
 *     groups: Array<{ startMs: number, lines: TimelineInputLine[] }>,
 *     totalGroups: number,
 *     candidateCount: number,
 *     mixedCandidateCount: number,
 *     candidateRatio: number,
 *     mixedRatio: number,
 *     isBilingual: boolean,
 * }}
 */
function analyzeBilingualGroups(lines) {
    const groups = groupLinesByTimestamp(lines);
    const candidateGroups = groups.filter((group) => group.lines.length === 2);
    const mixedCandidateCount = candidateGroups.filter(
        (group) => detectLanguage(group.lines[0].text) !== detectLanguage(group.lines[1].text),
    ).length;
    const candidateRatio = groups.length === 0 ? 0 : candidateGroups.length / groups.length;
    const mixedRatio =
        candidateGroups.length === 0 ? 0 : mixedCandidateCount / candidateGroups.length;
    const isBilingual =
        candidateGroups.length >= BILINGUAL_MIN_PAIR_GROUPS &&
        candidateRatio >= BILINGUAL_MIN_PAIR_RATIO &&
        mixedRatio >= BILINGUAL_MIN_MIXED_RATIO;
    return {
        groups,
        totalGroups: groups.length,
        candidateCount: candidateGroups.length,
        mixedCandidateCount,
        candidateRatio,
        mixedRatio,
        isBilingual,
    };
}

/**
 * ASS 的两个竖直槽位：中文 1020，日文/英文 1075。
 * @param {number} position
 * @returns {number}
 */
function otherPosition(position) {
    return position === 1020 ? 1075 : 1020;
}

/**
 * 单文件双语配对：对每个同时间戳 2 行组按文件顺序配对（第一行原文、第二行译文），
 * 其余行各自成块；显式 --lang 命中其中一行语言时以该行为原文。
 * @param {TimelineInputLine[]} lines
 * @param {{ explicitLang?: string }} [options]
 * @returns {{
 *     blocks: Array<TimelineInputLine & { lang: string, translationLang: string }>,
 *     primaryLang: string,
 *     translationLang: string,
 *     pairCount: number,
 *     warnings: string[],
 * }}
 */
function pairBilingualLines(lines, options = {}) {
    const explicitLang = options.explicitLang ?? '';
    /** @type {string[]} */
    const warnings = [];
    /** @type {Array<TimelineInputLine & { lang: string, translationLang: string }>} */
    const blocks = [];
    for (const group of groupLinesByTimestamp(lines)) {
        if (group.lines.length === 2) {
            const first = group.lines[0];
            const second = group.lines[1];
            const firstLang = detectLanguage(first.text);
            const secondLang = detectLanguage(second.text);
            let original = first;
            let translation = second;
            if (explicitLang && firstLang !== explicitLang && secondLang === explicitLang) {
                original = second;
                translation = first;
            }
            blocks.push({
                startMs: group.startMs,
                text: original.text,
                words: original.words,
                translation: translation.text,
                lang: detectLanguage(original.text),
                translationLang: detectLanguage(translation.text),
            });
        } else {
            for (const line of group.lines) {
                blocks.push({
                    startMs: line.startMs,
                    text: line.text,
                    words: line.words,
                    translation: '',
                    lang: detectLanguage(line.text),
                    translationLang: '',
                });
            }
        }
    }
    const pairedBlocks = blocks.filter((block) => block.translation !== '');
    const pairCount = pairedBlocks.length;
    const detectedPrimary = detectDominantLanguage(pairedBlocks.map((block) => block.text));
    const detectedTranslation = detectDominantLanguage(
        pairedBlocks.map((block) => block.translation),
    );
    let primaryLang = explicitLang || detectedPrimary;
    if (primaryLang === 'other') {
        primaryLang = detectedTranslation === 'other' ? 'en' : detectedTranslation;
        warnings.push('无法自动识别原文语言，已回退到可用的语言，可用 --lang 指定');
    }
    const translationLang = detectedTranslation === 'other' ? primaryLang : detectedTranslation;
    return { blocks, primaryLang, translationLang, pairCount, warnings };
}

/**
 * 解析 LRC 时间标签为毫秒。
 * @param {string} text
 * @returns {number | null}
 */
function parseTimestampToMs(text) {
    const parts = String(text).trim().split(':');
    if (parts.length < 2 || parts.length > 3) {
        return null;
    }
    let hours = 0;
    let minutes = 0;
    /** @type {string} */
    let secondsPart;
    if (parts.length === 3) {
        if (!/^\d{1,3}$/.test(parts[0]) || !/^\d{1,2}$/.test(parts[1])) {
            return null;
        }
        hours = Number(parts[0]);
        minutes = Number(parts[1]);
        secondsPart = parts[2];
    } else {
        if (!/^\d{1,3}$/.test(parts[0])) {
            return null;
        }
        minutes = Number(parts[0]);
        secondsPart = parts[1];
    }
    const secondsMatch = /^(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(secondsPart);
    if (!secondsMatch) {
        return null;
    }
    const seconds = Number(secondsMatch[1]);
    const fraction = secondsMatch[2] ? Number(`0.${secondsMatch[2]}`) : 0;
    return Math.round(((hours * 60 + minutes) * 60 + seconds + fraction) * 1000);
}

/**
 * 解析 [offset:] 元数据。
 * @param {string | undefined} value
 * @returns {number | null} null 表示格式无效
 */
function parseOffsetMs(value) {
    if (value === undefined || value.trim() === '') {
        return 0;
    }
    const text = value.trim();
    if (!/^[+-]?\d+$/.test(text)) {
        return null;
    }
    return Number(text);
}

/**
 * 解析 [length:] 元数据（mm:ss / h:mm:ss / 纯秒数）。
 * @param {string | undefined} value
 * @returns {number | null} null 表示格式无效
 */
function parseDurationToMs(value) {
    if (value === undefined || value.trim() === '') {
        return 0;
    }
    const text = value.trim();
    if (/^\d+$/.test(text)) {
        return Number(text) * 1000;
    }
    const parsed = parseTimestampToMs(text);
    return parsed;
}

/**
 * 解析增强型 LRC 的词时间戳，返回纯文本与词列表。
 * @param {string} text
 * @returns {{ text: string, words: LrcWord[] }}
 */
function parseEnhancedText(text) {
    WORD_TAG_RE.lastIndex = 0;
    /** @type {LrcWord[]} */
    const words = [];
    let match;
    let lastIndex = 0;
    let currentTime = null;
    let found = false;
    while ((match = WORD_TAG_RE.exec(text)) !== null) {
        found = true;
        const between = text.slice(lastIndex, match.index);
        const timeMs = parseTimestampToMs(match[1]);
        if (currentTime !== null && between !== '') {
            words.push({ timeMs: currentTime, text: between });
        }
        currentTime = timeMs;
        lastIndex = match.index + match[0].length;
    }
    if (!found) {
        return { text, words: [] };
    }
    const tail = text.slice(lastIndex);
    if (currentTime !== null && tail !== '') {
        words.push({ timeMs: currentTime, text: tail });
    }
    return { text: text.replace(WORD_TAG_RE, ''), words };
}

/**
 * 解析 LRC 文本。
 * @param {string} content
 * @param {{ offsetMs?: number }} [options] 手工偏移（叠加在 [offset:] 之上）
 * @returns {ParsedLrc}
 */
export function parseLrc(content, options = {}) {
    const manualOffsetMs = options.offsetMs ?? 0;
    /** @type {Record<string, string>} */
    const rawMetadata = {};
    /** @type {string[]} */
    const warnings = [];
    /** @type {Array<{ timestamps: number[], text: string }>} */
    const rawLines = [];

    const lines = String(content)
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/);
    for (const rawLine of lines) {
        let rest = rawLine.trim();
        if (rest === '') {
            continue;
        }
        /** @type {number[]} */
        const timestamps = [];
        while (rest.startsWith('[')) {
            const closeIndex = rest.indexOf(']');
            if (closeIndex === -1) {
                break;
            }
            const tag = rest.slice(1, closeIndex);
            rest = rest.slice(closeIndex + 1);
            const timestamp = parseTimestampToMs(tag);
            if (timestamp !== null) {
                timestamps.push(timestamp);
                continue;
            }
            const metadataMatch = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*([\s\S]*)$/.exec(tag);
            if (metadataMatch) {
                rawMetadata[metadataMatch[1].toLowerCase()] = metadataMatch[2].trim();
            }
            // 其它 [xxx] 标记（如 [Chorus]）直接忽略
        }
        if (timestamps.length === 0) {
            continue;
        }
        const textInfo = parseEnhancedText(rest);
        const text = textInfo.text.trim();
        if (text === '') {
            continue;
        }
        rawLines.push({ timestamps, text, words: textInfo.words });
    }

    const metadataOffset = parseOffsetMs(rawMetadata.offset);
    let metadataOffsetMs = 0;
    if (metadataOffset === null) {
        warnings.push(`[offset:${rawMetadata.offset}] 无法解析，已按 0 处理`);
    } else {
        metadataOffsetMs = metadataOffset;
    }
    const totalOffsetMs = metadataOffsetMs + manualOffsetMs;

    const lengthMs = parseDurationToMs(rawMetadata.length);
    if (lengthMs === null) {
        warnings.push(`[length:${rawMetadata.length}] 无法解析，跳过歌曲时长校验`);
    }

    /** @type {LrcLine[]} */
    const parsedLines = [];
    let negativeCount = 0;
    for (const rawLine of rawLines) {
        for (const timestamp of rawLine.timestamps) {
            let startMs = timestamp + totalOffsetMs;
            if (startMs < 0) {
                startMs = 0;
                negativeCount += 1;
            }
            parsedLines.push({
                startMs,
                text: rawLine.text,
                words: rawLine.words.map((word) => ({
                    timeMs: Math.max(0, word.timeMs + totalOffsetMs),
                    text: word.text,
                })),
            });
        }
    }
    if (negativeCount > 0) {
        warnings.push(`有 ${negativeCount} 行时间偏移后为负数，已截断为 0`);
    }
    parsedLines.sort((left, right) => left.startMs - right.startMs);

    return {
        metadata: {
            title: rawMetadata.ti ?? '',
            artist: rawMetadata.ar ?? '',
            album: rawMetadata.al ?? '',
            by: rawMetadata.by ?? '',
            offsetMs: metadataOffsetMs,
            lengthMs: lengthMs ?? 0,
            raw: rawMetadata,
        },
        lines: parsedLines,
        warnings,
    };
}

/**
 * 按开始时间戳把翻译歌词配对到原文歌词。
 * @param {LrcLine[]} primaryLines
 * @param {LrcLine[]} translationLines
 * @param {{ toleranceMs?: number }} [options]
 * @returns {{
 *     lines: Array<LrcLine & { translation: string }>,
 *     matchedCount: number,
 *     unusedTranslationCount: number,
 *     warnings: string[],
 * }}
 */
export function pairTranslations(primaryLines, translationLines, options = {}) {
    const toleranceMs = options.toleranceMs ?? TRANSLATION_TOLERANCE_MS;
    const warnings = [];
    const sortedPrimary = [...primaryLines].sort((left, right) => left.startMs - right.startMs);
    const sortedTranslation = [...translationLines].sort(
        (left, right) => left.startMs - right.startMs,
    );
    /** @type {Array<LrcLine & { translation: string }>} */
    const pairedLines = [];
    let unmatchedPrimaryCount = 0;
    let matchedCount = 0;
    let translationIndex = 0;
    for (const line of sortedPrimary) {
        while (
            translationIndex < sortedTranslation.length &&
            sortedTranslation[translationIndex].startMs < line.startMs - toleranceMs
        ) {
            translationIndex += 1;
        }
        const candidate = sortedTranslation[translationIndex];
        if (candidate && Math.abs(candidate.startMs - line.startMs) <= toleranceMs) {
            pairedLines.push({ ...line, translation: candidate.text });
            matchedCount += 1;
            translationIndex += 1;
        } else {
            pairedLines.push({ ...line, translation: '' });
            unmatchedPrimaryCount += 1;
        }
    }
    const unusedTranslationCount = sortedTranslation.length - matchedCount;
    if (unmatchedPrimaryCount > 0) {
        warnings.push(`原文中有 ${unmatchedPrimaryCount} 行没有匹配到翻译`);
    }
    if (unusedTranslationCount > 0) {
        warnings.push(`翻译文件中有 ${unusedTranslationCount} 行没有匹配到原文时间戳`);
    }
    return { lines: pairedLines, matchedCount, unusedTranslationCount, warnings };
}

/**
 * 由歌词行计算时间轴：结束时间 = 下一行开始时间；最后一行 = 开始 + 5 秒。
 * @param {TimelineInputLine[]} lines
 * @param {{ lastLineDurationMs?: number, minDurationMs?: number, lengthMs?: number }} [options]
 * @returns {{ lines: TimelineLine[], warnings: string[] }}
 */
export function buildTimeline(lines, options = {}) {
    const lastLineDurationMs = options.lastLineDurationMs ?? LAST_LINE_DURATION_MS;
    const minDurationMs = options.minDurationMs ?? MIN_LINE_DURATION_MS;
    const lengthMs = options.lengthMs ?? 0;
    const warnings = [];
    const sortedLines = [...lines].sort((left, right) => left.startMs - right.startMs);
    /** @type {TimelineLine[]} */
    const timeline = sortedLines.map((line) => ({
        ...line,
        endMs: 0,
        translation: line.translation ?? '',
    }));
    for (let index = 0; index < timeline.length; index += 1) {
        const line = timeline[index];
        const next = timeline[index + 1];
        if (next) {
            line.endMs = next.startMs;
            if (line.endMs <= line.startMs) {
                line.endMs = line.startMs + minDurationMs;
                warnings.push(
                    `第 ${index + 1} 行与下一行时间戳相同或更早，结束时间已顺延 ${minDurationMs} 毫秒`,
                );
            }
        } else {
            line.endMs = line.startMs + lastLineDurationMs;
        }
    }
    if (lengthMs > 0 && timeline.length > 0) {
        const lastLine = timeline[timeline.length - 1];
        if (lastLine.endMs > lengthMs) {
            warnings.push(
                `最后一行结束时间 ${formatTimestamp(lastLine.endMs)} 超出 [length:] 歌曲时长 ${formatTimestamp(lengthMs)}`,
            );
        }
    }
    return { lines: timeline, warnings };
}

/**
 * 生成 config.txt 内容。
 * @param {Array<{ startMs: number, endMs: number, text: string }>} blocks
 * @param {{ track?: number }} [options]
 * @returns {string}
 */
export function buildConfigTxt(blocks, options = {}) {
    const track = options.track ?? 1;
    if (!VALID_TRACKS.includes(track)) {
        throw new Error(`轨道编号只能是 1 或 2，收到 ${track}`);
    }
    const lines = blocks.map((block) => {
        const text = String(block.text ?? '')
            .replace(/[\r\n]+/g, ' ')
            .trim();
        const endMs = block.endMs > block.startMs ? block.endMs : block.startMs + 1;
        return `${track},${formatTimestamp(block.startMs)},${formatTimestamp(endMs)},${text}`;
    });
    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * 生成一条 ASS 样式行（颜色格式 &H00BBGGRR）。
 * @param {string} name
 * @param {string} font
 * @param {number} size
 * @param {string} outlineColor
 * @param {number} alignment
 * @param {number} marginV
 * @returns {string}
 */
function createStyleLine(name, font, size, outlineColor, alignment, marginV) {
    return `Style: ${name},${font},${size},&H00FFFFFF,&H000000FF,${outlineColor},&H00000000,-1,0,0,0,100,100,0,0,1,3,0,${alignment},0,0,${marginV},1`;
}

/**
 * 按语言生成样式模板（与 scripts/lyrics2ass.js 的样式表一致）。
 * @param {string} language
 * @param {string} color
 * @param {string} fontJa
 * @param {string} fontZh
 * @returns {string[]}
 */
function buildStyleLines(language, color, fontJa, fontZh) {
    const config = LANGUAGE_CONFIG[language];
    const font = language === 'zh' ? fontZh : language === 'ja' ? fontJa : EN_FONT;
    /** @type {string[]} */
    const styleLines = [];
    for (const singer of SINGER_STYLES) {
        const outlineColor = colorToAss(singer.color ?? color);
        styleLines.push(
            createStyleLine(
                `${config.prefix}-${singer.name}`,
                font,
                config.mainSize,
                outlineColor,
                2,
                0,
            ),
        );
        if (singer.name === 'Liella') {
            styleLines.push(
                createStyleLine(
                    `${config.prefix}-外-${singer.name}`,
                    font,
                    config.outerSize,
                    outlineColor,
                    8,
                    language === 'zh' ? 10 : 0,
                ),
            );
        }
        styleLines.push(
            createStyleLine(
                `${config.prefix}-f-${singer.name}`,
                font,
                config.fSize,
                outlineColor,
                2,
                0,
            ),
        );
    }
    return styleLines;
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeAssText(text) {
    return String(text ?? '').replace(/[\r\n]+/g, ' ');
}

/**
 * @param {string} start
 * @param {string} end
 * @param {string} styleName
 * @param {number} position
 * @param {string} text
 * @returns {string}
 */
function createDialogueLine(start, end, styleName, position, text) {
    return `Dialogue: 0,${start},${end},${styleName},,0,0,0,,{\\fad(200,200)\\pos(960,${position})}${normalizeAssText(text)}`;
}

/**
 * 生成 subtitle.ass 内容。
 * 每个块可用 lang / translationLang 覆盖全局语言；同一块两种语言落到同一竖直槽位时，
 * 译文会自动换到另一个槽位，避免文字重叠。
 * @param {{
 *     title: string,
 *     blocks: Array<{
 *         startMs: number,
 *         endMs: number,
 *         text: string,
 *         translation?: string,
 *         lang?: string,
 *         translationLang?: string,
 *     }>,
 *     lang?: string,
 *     translationLang?: string,
 *     color?: string,
 *     fontJa?: string,
 *     fontZh?: string,
 * }} options
 * @returns {string}
 */
export function buildAss(options) {
    const title =
        String(options.title ?? '')
            .replace(/[\r\n]+/g, ' ')
            .trim() || 'liveSubtitle';
    const blocks = options.blocks ?? [];
    const defaultLang = resolveLanguage(options.lang ?? 'ja');
    const defaultTranslationLang = options.translationLang
        ? resolveLanguage(options.translationLang)
        : '';
    const color = normalizeColor(options.color ?? DEFAULT_OPTIONS.color);
    const fontJa = options.fontJa ?? DEFAULT_OPTIONS.fontJa;
    const fontZh = options.fontZh ?? DEFAULT_OPTIONS.fontZh;

    /** @type {Set<string>} */
    const styleLanguageSet = new Set();
    for (const block of blocks) {
        styleLanguageSet.add(block.lang ? resolveLanguage(block.lang) : defaultLang);
        const translation = typeof block.translation === 'string' ? block.translation : '';
        if (translation === '') {
            continue;
        }
        const translationLanguage = block.translationLang
            ? resolveLanguage(block.translationLang)
            : defaultTranslationLang;
        if (translationLanguage) {
            styleLanguageSet.add(translationLanguage);
        }
    }
    if (styleLanguageSet.size === 0) {
        styleLanguageSet.add(defaultLang);
    }
    const languages = [...styleLanguageSet].sort(
        (left, right) => LANGUAGE_ORDER.indexOf(left) - LANGUAGE_ORDER.indexOf(right),
    );
    /** @type {string[]} */
    const styleLines = [];
    for (const language of languages) {
        styleLines.push(...buildStyleLines(language, color, fontJa, fontZh));
    }
    /** @type {string[]} */
    const dialogueLines = [];
    for (const block of blocks) {
        const start = formatTimestamp(block.startMs);
        const end = formatTimestamp(block.endMs);
        const blockLang = block.lang ? resolveLanguage(block.lang) : defaultLang;
        const primaryConfig = LANGUAGE_CONFIG[blockLang];
        dialogueLines.push(
            createDialogueLine(
                start,
                end,
                `${primaryConfig.prefix}-Liella`,
                primaryConfig.position,
                block.text,
            ),
        );
        const translation = typeof block.translation === 'string' ? block.translation : '';
        if (translation === '') {
            continue;
        }
        const translationLanguage = block.translationLang
            ? resolveLanguage(block.translationLang)
            : defaultTranslationLang;
        if (!translationLanguage) {
            continue;
        }
        const translationConfig = LANGUAGE_CONFIG[translationLanguage];
        const translationPosition =
            translationConfig.position === primaryConfig.position
                ? otherPosition(primaryConfig.position)
                : translationConfig.position;
        dialogueLines.push(
            createDialogueLine(
                start,
                end,
                `${translationConfig.prefix}-Liella`,
                translationPosition,
                translation,
            ),
        );
    }
    const assLines = [
        '[Script Info]',
        '; Generated by liveSubtitle scripts/lrc2subtitle.js',
        `Title: ${title}`,
        'ScriptType: v4.00+',
        'WrapStyle: 0',
        'ScaledBorderAndShadow: yes',
        'YCbCr Matrix: TV.709',
        'PlayResX: 1920',
        'PlayResY: 1080',
        '',
        '[V4+ Styles]',
        ASS_STYLE_FORMAT_LINE,
        ...styleLines,
        '',
        '[Events]',
        ASS_EVENT_FORMAT_LINE,
        ...dialogueLines,
        '',
    ];
    return assLines.join('\n');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeLyricText(value) {
    return String(value ?? '')
        .replace(/[\r\n]+/g, ' ')
        .trim();
}

/**
 * 生成 lyrics.txt（前 4 行为歌曲名 / 译者或词作者 / 来源 / 备注，之后为成对歌词）。
 * 中文在前、原文在后；块级 lang / translationLang 可覆盖全局语言。
 * @param {{
 *     title: string,
 *     translator?: string,
 *     source?: string,
 *     remark?: string,
 *     blocks: Array<{ text: string, translation?: string, lang?: string, translationLang?: string }>,
 *     lang?: string,
 *     translationLang?: string,
 * }} options
 * @returns {string}
 */
export function buildLyricsTxt(options) {
    const defaultLang = resolveLanguage(options.lang ?? 'ja');
    const defaultTranslationLang = options.translationLang
        ? resolveLanguage(options.translationLang)
        : '';
    const header = [
        normalizeLyricText(options.title),
        normalizeLyricText(options.translator),
        normalizeLyricText(options.source),
        normalizeLyricText(options.remark),
    ];
    /** @type {string[]} */
    const pairs = [];
    for (const block of options.blocks ?? []) {
        const primaryLanguage = block.lang ? resolveLanguage(block.lang) : defaultLang;
        const translationLanguage = block.translationLang
            ? resolveLanguage(block.translationLang)
            : defaultTranslationLang;
        if (!translationLanguage) {
            continue;
        }
        const primaryText = normalizeLyricText(block.text);
        const translationText = normalizeLyricText(block.translation);
        if (translationLanguage === 'zh' && primaryLanguage !== 'zh') {
            pairs.push(translationText, primaryText);
        } else {
            pairs.push(primaryText, translationText);
        }
    }
    return `${[...header, ...pairs].join('\n')}\n`;
}

/**
 * 读取并计算 filter-config.json 的更新内容（不写盘）。
 * @param {string} outDir
 * @param {{ name: string, type: string, songName: string }} params
 * @returns {FilterConfigPlan}
 */
function planFilterConfigUpdate(outDir, params) {
    const filePath = path.join(outDir, 'filter-config.json');
    /** @type {string[]} */
    const warnings = [];
    /** @type {any[]} */
    let config = [];
    let existed = false;
    if (fs.existsSync(filePath)) {
        existed = true;
        const content = fs.readFileSync(filePath, 'utf-8');
        try {
            config = JSON.parse(content);
        } catch {
            throw new Error(`无法解析筛选器配置（不是合法 JSON）: ${filePath}`);
        }
        if (!Array.isArray(config)) {
            throw new Error(`筛选器配置必须是数组: ${filePath}`);
        }
    }
    let entry = config.find(
        (item) => item && typeof item === 'object' && item.name === params.name,
    );
    let addedEntry = false;
    let addedSong = false;
    let typeMismatch = false;
    if (!entry) {
        entry = { name: params.name, type: params.type, songs: [params.songName] };
        config.push(entry);
        addedEntry = true;
    } else {
        if (!Array.isArray(entry.songs)) {
            throw new Error(`筛选器 "${params.name}" 的 songs 字段不是数组: ${filePath}`);
        }
        if (entry.type !== params.type) {
            typeMismatch = true;
            warnings.push(
                `筛选器 "${params.name}" 已存在且类型为 ${entry.type}，保留原类型（未使用 --filter-type ${params.type}）`,
            );
        }
        if (!entry.songs.includes(params.songName)) {
            entry.songs.push(params.songName);
            addedSong = true;
        }
    }
    return {
        path: filePath,
        config,
        changed: !existed || addedEntry || addedSong,
        created: !existed,
        addedEntry,
        addedSong,
        typeMismatch,
        warnings,
    };
}

/**
 * @param {FilterConfigPlan} plan
 * @returns {void}
 */
function writeFilterConfigUpdate(plan) {
    if (!plan.changed) {
        return;
    }
    fs.mkdirSync(path.dirname(plan.path), { recursive: true });
    fs.writeFileSync(plan.path, `${JSON.stringify(plan.config, null, 4)}\n`, 'utf-8');
}

/**
 * 把歌曲追加到 <out>/filter-config.json（保持 4 空格 JSON 格式）。
 * @param {string} outDir
 * @param {{ name: string, type: string, songName: string }} params
 * @returns {{
 *     path: string,
 *     changed: boolean,
 *     created: boolean,
 *     addedEntry: boolean,
 *     addedSong: boolean,
 *     typeMismatch: boolean,
 *     warnings: string[],
 * }}
 */
export function appendFilterConfig(outDir, params) {
    const plan = planFilterConfigUpdate(outDir, params);
    writeFilterConfigUpdate(plan);
    return {
        path: plan.path,
        changed: plan.changed,
        created: plan.created,
        addedEntry: plan.addedEntry,
        addedSong: plan.addedSong,
        typeMismatch: plan.typeMismatch,
        warnings: plan.warnings,
    };
}

/**
 * @param {string} value
 * @param {string} label
 * @returns {string}
 */
function requireText(value, label) {
    const text = String(value ?? '').trim();
    if (text === '') {
        throw new Error(`${label} 不能为空`);
    }
    return text;
}

/**
 * @param {string} name
 * @returns {string}
 */
function validateSongName(name) {
    const text = requireText(name, '歌曲名').trim();
    if (text === '.' || text === '..') {
        throw new Error('歌曲名不能是 "." 或 ".."');
    }
    if (/[\\/:*?"<>|]/.test(text)) {
        throw new Error(`歌曲名不能包含路径分隔符或 Windows 非法字符: "${text}"`);
    }
    if (/[. ]$/.test(text)) {
        throw new Error('歌曲名不能以空格或句点结尾');
    }
    return text;
}

/**
 * @param {any} options
 * @param {string} key
 * @param {string} value
 * @returns {void}
 */
function applyOption(options, key, value) {
    switch (key) {
        case '--name':
            options.name = requireText(value, '--name');
            break;
        case '--out':
            options.out = requireText(value, '--out');
            break;
        case '--track': {
            const text = String(value).trim();
            if (text !== '1' && text !== '2') {
                throw new Error(`--track 只能是 1 或 2，收到 "${value}"`);
            }
            options.track = Number(text);
            break;
        }
        case '--offset-ms': {
            const text = String(value).trim();
            if (!/^[+-]?\d+$/.test(text)) {
                throw new Error(`--offset-ms 需要整数毫秒，收到 "${value}"`);
            }
            options.offsetMs = Number(text);
            break;
        }
        case '--lang':
            options.lang = resolveLanguageOption(value);
            break;
        case '--translation':
            options.translation = requireText(value, '--translation');
            break;
        case '--translation-lang':
            options.translationLang = resolveLanguageOption(value);
            break;
        case '--color':
            options.color = normalizeColor(value);
            break;
        case '--font-ja':
            options.fontJa = requireText(value, '--font-ja');
            break;
        case '--font-zh':
            options.fontZh = requireText(value, '--font-zh');
            break;
        case '--filter':
            options.filter = requireText(value, '--filter');
            break;
        case '--filter-type': {
            const type = String(value).trim();
            if (!VALID_FILTER_TYPES.includes(type)) {
                throw new Error(
                    `--filter-type 只能是 ${VALID_FILTER_TYPES.join(' / ')}，收到 "${value}"`,
                );
            }
            options.filterType = type;
            break;
        }
        default:
            throw new Error(`未知选项: ${key}`);
    }
}

/**
 * 解析命令行参数。
 * @param {string[]} argv
 * @returns {{ options: any, positionals: string[], provided: Set<string> }}
 */
function parseArgs(argv) {
    /** @type {any} */
    const options = { ...DEFAULT_OPTIONS };
    /** @type {string[]} */
    const positionals = [];
    /** @type {Set<string>} */
    const provided = new Set();
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--') {
            positionals.push(...argv.slice(index + 1));
            break;
        }
        if (!arg.startsWith('--')) {
            positionals.push(arg);
            continue;
        }
        const equalIndex = arg.indexOf('=');
        const key = equalIndex === -1 ? arg : arg.slice(0, equalIndex);
        const inlineValue = equalIndex === -1 ? null : arg.slice(equalIndex + 1);
        if (FLAG_OPTIONS.has(key)) {
            if (inlineValue !== null) {
                throw new Error(`选项 ${key} 不接受取值`);
            }
            provided.add(key);
            if (key === '--force') {
                options.force = true;
            } else if (key === '--dry-run') {
                options.dryRun = true;
            } else if (key === '--no-auto-pair') {
                options.noAutoPair = true;
            } else if (key === '--keep-credits') {
                options.keepCredits = true;
            } else {
                options.help = true;
            }
            continue;
        }
        if (!VALUE_OPTIONS.has(key)) {
            throw new Error(`未知选项: ${key}`);
        }
        let value = inlineValue;
        if (value === null) {
            index += 1;
            if (index >= argv.length) {
                throw new Error(`选项 ${key} 缺少取值`);
            }
            value = argv[index];
        }
        provided.add(key);
        applyOption(options, key, value);
    }
    return { options, positionals, provided };
}

/** CLI 帮助文本 */
const HELP_TEXT = `把 LRC 歌词转换为 liveSubtitle 字幕包（零依赖，Node >= 18）。

用法:
  node scripts/lrc2subtitle.js <歌词.lrc> [选项]

选项:
  --name <名称>              歌曲名，同时用作输出目录名（默认取 [ti:] 或文件名）
  --out <目录>               输出根目录（默认 subtitleFiles）
  --track <1|2>              生成 config.txt 使用的轨道编号（默认 1）
  --offset-ms <毫秒>         时间偏移，正数延后，默认 0；叠加在 LRC [offset:] 之上，并同时
                             应用于 --translation 文件
  --lang <auto|ja|zh|en>     原文语言（默认 auto：自动识别；对应样式前缀 日文/中文/英文）
  --translation <文件>       翻译 LRC 文件（显式指定时优先，禁用单文件自动配对）
  --translation-lang <auto|ja|zh|en>
                             翻译语言（默认 auto：自动识别 --translation 文件的语言）
  --no-auto-pair             关闭单个 LRC 文件内的双语自动识别与配对
  --keep-credits             保留行首「作词: / 作曲: / Lyrics:」等 credits/制作信息行
  --color <#RRGGBB>          字幕描边颜色（默认 #A5469C Liella 紫）
  --font-ja <字体>           日文字体（默认 Tsukushi A Round Gothic）
  --font-zh <字体>           中文字体（默认 FZFW ZhuZi A YuanS）
  --filter <名称>            把歌曲追加到 <out>/filter-config.json 的筛选器
  --filter-type <类型>       筛选器类型 album|unit|live|solo（默认 album）
  --force                    输出目录已存在时覆盖生成的文件
  --dry-run                  只打印将生成的文件，不写入磁盘
  --help                     显示本帮助

输出:
  <out>/<歌曲名>/config.txt    每行 "轨道,开始时间,结束时间,文本"，时间格式 H:MM:SS.CC
  <out>/<歌曲名>/subtitle.ass  [Script Info] + [V4+ Styles] + [Events]；中文 pos(960,1020)、
                               日文/英文 pos(960,1075)
  <out>/<歌曲名>/lyrics.txt    有翻译时自动生成，前 4 行为 歌曲名/译者/来源/备注

单文件双语自动识别:
  - 默认会尝试把同一时间戳下两行语言不同的结构识别为「原文 + 翻译」：例如英文在前、中文在后，
    或中文在前、英文/日文在后。
  - 判定条件：同时间戳恰好 2 行的组至少 3 组、占全部有效组 ≥50%，且其中两行语言不同的组占比
    ≥80%；满足时对所有 2 行组按文件顺序配对（第一行原文、第二行译文）。
  - 用 --lang 显式指定 ja/zh/en 时，命中该语言的那一行作为原文。
  - 同一对两行语言相同时仍算一对：译文使用原文语言的样式，并换到另一个竖直槽位避免重叠。
  - 已显式提供 --translation 时不做单文件自动配对；--no-auto-pair 可完全关闭自动配对。

说明:
  - 支持一行多个时间戳、增强型 LRC 词时间戳与 [ti:]/[ar:]/[al:]/[by:]/[offset:]/[length:] 元数据。
  - 默认过滤行首「作词: / 作曲: / Lyrics: / Composer:」等 credits/制作信息行，并去除同一时间戳
    完全相同的重复行；--keep-credits 保留 credits。
  - --translation 文件按开始时间戳配对（容差 100ms），未配对的行会在 stderr 提示。
  - 每行结束时间 = 下一行开始时间；最后一行 = 开始时间 + 5 秒。
  - 若 LRC 含 [length:] 元数据，会校验结束时间是否超出歌曲时长并提示。
  - 英文样式固定使用 Arial 字体；--force 只覆盖生成的文件，不删除目录中的其它文件。

示例:
  node scripts/lrc2subtitle.js song.lrc
  node scripts/lrc2subtitle.js "Payphone - Maroon 5,Wiz Khalifa.lrc"
  node scripts/lrc2subtitle.js song.lrc --lang zh --no-auto-pair
  node scripts/lrc2subtitle.js song.lrc --translation song.zh.lrc --name "始まりは君の空"
  node scripts/lrc2subtitle.js song.lrc --filter "始まりは君の空" --filter-type album --dry-run`;

/**
 * CLI 入口（可注入 io 以便测试）。
 * @param {string[]} argv
 * @param {CliIo} [io]
 * @returns {number} 退出码：0 成功，1 失败
 */
export function runCli(argv, io = {}) {
    const cwd = io.cwd ?? process.cwd();
    const stdout = io.stdout ?? ((text) => process.stdout.write(text));
    const stderr = io.stderr ?? ((text) => process.stderr.write(text));
    const print = (line = '') => {
        stdout(`${line}\n`);
    };
    const printErr = (line = '') => {
        stderr(`${line}\n`);
    };
    const display = (filePath) => {
        const relative = path.relative(cwd, filePath);
        return relative !== '' && !relative.startsWith('..') ? relative : filePath;
    };

    let parsedArgs;
    try {
        parsedArgs = parseArgs(argv);
    } catch (error) {
        printErr(`错误: ${error instanceof Error ? error.message : String(error)}`);
        printErr('运行 node scripts/lrc2subtitle.js --help 查看用法。');
        return 1;
    }
    const { options, positionals, provided } = parsedArgs;
    if (options.help) {
        stdout(`${HELP_TEXT}\n`);
        return 0;
    }

    try {
        if (positionals.length === 0) {
            throw new Error('缺少输入 LRC 文件路径');
        }
        if (positionals.length > 1) {
            throw new Error('只能指定一个输入 LRC 文件');
        }
        if (provided.has('--translation-lang') && !options.translation) {
            throw new Error('--translation-lang 需要与 --translation 一起使用');
        }
        if (provided.has('--filter-type') && !options.filter) {
            throw new Error('--filter-type 需要与 --filter 一起使用');
        }

        const inputPath = path.resolve(cwd, positionals[0]);
        if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
            throw new Error(`找不到输入文件: ${inputPath}`);
        }
        const primary = parseLrc(fs.readFileSync(inputPath, 'utf-8'), {
            offsetMs: options.offsetMs,
        });
        if (primary.lines.length === 0) {
            throw new Error(`LRC 中没有带时间戳的歌词行: ${inputPath}`);
        }
        const warnings = [...primary.warnings];

        // 1) 过滤 credits / 制作信息，并去除同一时间戳完全相同的重复行
        let sourceLines = primary.lines;
        if (!options.keepCredits) {
            const creditsResult = filterCreditLines(sourceLines);
            if (creditsResult.skippedCount > 0) {
                warnings.push(
                    `已过滤 ${creditsResult.skippedCount} 行 credits/制作信息（可用 --keep-credits 保留）`,
                );
            }
            sourceLines = creditsResult.lines;
        }
        const dedupeResult = dedupeIdenticalLines(sourceLines);
        if (dedupeResult.removedCount > 0) {
            warnings.push(`已去除 ${dedupeResult.removedCount} 行同一时间戳的重复行`);
        }
        sourceLines = dedupeResult.lines;
        if (sourceLines.length === 0) {
            throw new Error(`过滤 credits/重复行后没有可用的歌词行: ${inputPath}`);
        }

        const name = validateSongName(
            options.name ||
                primary.metadata.title ||
                path.basename(inputPath, path.extname(inputPath)),
        );
        const explicitLang = options.lang === 'auto' ? '' : options.lang;
        const explicitTranslationLang =
            options.translationLang === 'auto' ? '' : options.translationLang;

        /** @type {string} */
        let primaryLang = '';
        /** @type {string} */
        let translationLang = '';
        /** @type {TimelineInputLine[]} */
        let sourceBlocks = [];
        let hasTranslation = false;
        let matchedTranslationCount = 0;

        if (options.translation) {
            // 显式 --translation 优先：不做单文件自动配对
            warnings.push('已提供 --translation，跳过单文件自动配对');
            const translationPath = path.resolve(cwd, options.translation);
            if (!fs.existsSync(translationPath) || !fs.statSync(translationPath).isFile()) {
                throw new Error(`找不到翻译文件: ${translationPath}`);
            }
            // 手工偏移同时应用于翻译文件，保证两者按时间戳继续对齐
            const translation = parseLrc(fs.readFileSync(translationPath, 'utf-8'), {
                offsetMs: options.offsetMs,
            });
            let translationLines = translation.lines;
            if (!options.keepCredits) {
                const creditsResult = filterCreditLines(translationLines);
                if (creditsResult.skippedCount > 0) {
                    warnings.push(
                        `翻译文件中已过滤 ${creditsResult.skippedCount} 行 credits/制作信息`,
                    );
                }
                translationLines = creditsResult.lines;
            }
            const translationDedupe = dedupeIdenticalLines(translationLines);
            if (translationDedupe.removedCount > 0) {
                warnings.push(
                    `翻译文件中已去除 ${translationDedupe.removedCount} 行同一时间戳的重复行`,
                );
            }
            translationLines = translationDedupe.lines;
            if (translationLines.length === 0) {
                throw new Error(`翻译 LRC 中没有带时间戳的歌词行: ${translationPath}`);
            }
            warnings.push(...translation.warnings);

            primaryLang =
                explicitLang || detectDominantLanguage(sourceLines.map((line) => line.text));
            if (!explicitLang) {
                if (primaryLang === 'other') {
                    throw new Error('无法自动识别原文语言，请用 --lang 指定');
                }
                warnings.push(`自动识别原文语言: ${languageName(primaryLang)}`);
            }
            translationLang =
                explicitTranslationLang ||
                detectDominantLanguage(translationLines.map((line) => line.text));
            if (!explicitTranslationLang) {
                if (translationLang === 'other') {
                    throw new Error('无法自动识别翻译语言，请用 --translation-lang 指定');
                }
                warnings.push(`自动识别翻译语言: ${languageName(translationLang)}`);
            }
            if (primaryLang === translationLang) {
                throw new Error(
                    '翻译语言不能与原文语言相同，请用 --lang / --translation-lang 指定',
                );
            }

            const paired = pairTranslations(sourceLines, translationLines);
            if (paired.matchedCount === 0) {
                throw new Error('翻译文件与原文的时间戳无法配对（0 行匹配），请检查文件或时间偏移');
            }
            sourceBlocks = paired.lines;
            matchedTranslationCount = paired.matchedCount;
            hasTranslation = true;
            warnings.push(...paired.warnings);
        } else {
            const analysis = analyzeBilingualGroups(sourceLines);
            const autoPairEnabled = !options.noAutoPair;
            if (options.noAutoPair) {
                warnings.push('已按 --no-auto-pair 关闭单文件自动配对');
                if (analysis.isBilingual) {
                    warnings.push('检测到双语结构，但已按 --no-auto-pair 禁用自动配对');
                }
            }
            if (autoPairEnabled && analysis.isBilingual) {
                const paired = pairBilingualLines(sourceLines, { explicitLang });
                primaryLang = paired.primaryLang;
                translationLang = paired.translationLang;
                if (!explicitLang) {
                    warnings.push(`自动识别原文语言: ${languageName(primaryLang)}`);
                }
                warnings.push(
                    `自动配对 ${paired.pairCount} 行翻译（${languageName(primaryLang)} → ${languageName(translationLang)}）`,
                );
                warnings.push(...paired.warnings);
                sourceBlocks = paired.blocks;
                matchedTranslationCount = paired.pairCount;
                hasTranslation = paired.pairCount > 0;
            } else {
                const languages = new Set(
                    sourceLines
                        .map((line) => detectLanguage(line.text))
                        .filter((language) => language !== 'other'),
                );
                if (languages.size > 1 && !options.noAutoPair) {
                    warnings.push('检测到多语言但无法自动配对，可用 --translation 指定翻译文件');
                }
                primaryLang =
                    explicitLang || detectDominantLanguage(sourceLines.map((line) => line.text));
                if (!explicitLang) {
                    if (primaryLang === 'other') {
                        throw new Error('无法自动识别原文语言，请用 --lang 指定');
                    }
                    warnings.push(`自动识别原文语言: ${languageName(primaryLang)}`);
                }
                translationLang = '';
                sourceBlocks = sourceLines.map((line) => ({ ...line, translation: '' }));
            }
        }

        const timeline = buildTimeline(sourceBlocks, { lengthMs: primary.metadata.lengthMs });
        warnings.push(...timeline.warnings);
        const blocks = timeline.lines;

        const outRoot = path.resolve(cwd, options.out);
        const songDir = path.join(outRoot, name);
        const filePaths = {
            config: path.join(songDir, 'config.txt'),
            ass: path.join(songDir, 'subtitle.ass'),
            lyrics: path.join(songDir, 'lyrics.txt'),
        };
        const songDirExists = fs.existsSync(songDir);
        if (songDirExists && !fs.statSync(songDir).isDirectory()) {
            throw new Error(`输出路径已存在且不是目录: ${songDir}`);
        }
        if (songDirExists && !options.force && !options.dryRun) {
            throw new Error(`输出目录已存在: ${display(songDir)}（使用 --force 覆盖）`);
        }

        let filterPlan = null;
        if (options.filter) {
            filterPlan = planFilterConfigUpdate(outRoot, {
                name: options.filter,
                type: options.filterType,
                songName: name,
            });
            warnings.push(...filterPlan.warnings);
        }

        const printWarnings = () => {
            for (const warning of warnings) {
                printErr(`提示: ${warning}`);
            }
        };

        if (options.dryRun) {
            print(`[dry-run] 输入: ${display(inputPath)}`);
            print(
                `[dry-run] 歌曲名: ${name}（原语言 ${languageName(primaryLang)}，${blocks.length} 块字幕）`,
            );
            print(`[dry-run] 将生成: ${display(filePaths.config)}`);
            print(`[dry-run] 将生成: ${display(filePaths.ass)}`);
            if (hasTranslation) {
                print(`[dry-run] 将生成: ${display(filePaths.lyrics)}`);
            }
            if (filterPlan) {
                print(`[dry-run] 将更新: ${display(filterPlan.path)}`);
            }
            if (songDirExists) {
                print('[dry-run] 注意: 输出目录已存在，实际执行需要 --force');
            }
            printWarnings();
            return 0;
        }

        fs.mkdirSync(songDir, { recursive: true });
        const configText = buildConfigTxt(blocks, { track: options.track });
        const assText = buildAss({
            title: name,
            blocks,
            lang: primaryLang,
            translationLang: hasTranslation ? translationLang : '',
            color: options.color,
            fontJa: options.fontJa,
            fontZh: options.fontZh,
        });
        fs.writeFileSync(filePaths.config, configText, 'utf-8');
        fs.writeFileSync(filePaths.ass, assText, 'utf-8');
        print(`生成: ${display(filePaths.config)}（${blocks.length} 块，轨道 ${options.track}）`);
        print(`生成: ${display(filePaths.ass)}`);
        if (hasTranslation) {
            const lyricsText = buildLyricsTxt({
                title: name,
                translator: primary.metadata.by || primary.metadata.artist,
                source:
                    primary.metadata.raw.source ||
                    primary.metadata.raw.url ||
                    primary.metadata.raw.re ||
                    '',
                remark: primary.metadata.raw.remark || primary.metadata.raw.note || '',
                blocks,
                lang: primaryLang,
                translationLang,
            });
            fs.writeFileSync(filePaths.lyrics, lyricsText, 'utf-8');
            print(`生成: ${display(filePaths.lyrics)}（${matchedTranslationCount} 行翻译配对）`);
        }
        if (filterPlan) {
            writeFilterConfigUpdate(filterPlan);
            if (filterPlan.changed) {
                print(`更新: ${display(filterPlan.path)}`);
            } else {
                print(`保持: ${display(filterPlan.path)}（已包含该歌曲）`);
            }
        }
        printWarnings();
        print(`完成: ${display(songDir)}（${blocks.length} 块字幕，轨道 ${options.track}）`);
        return 0;
    } catch (error) {
        printErr(`错误: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }
}

/**
 * 判断当前模块是否被 node 直接执行（而非被测试/其它模块 import）。
 * @returns {boolean}
 */
function isDirectExecution() {
    if (!process.argv[1]) {
        return false;
    }
    const entryUrl = pathToFileURL(path.resolve(process.argv[1])).href;
    if (entryUrl === import.meta.url) {
        return true;
    }
    return process.platform === 'win32' && entryUrl.toLowerCase() === import.meta.url.toLowerCase();
}

if (isDirectExecution()) {
    process.exitCode = runCli(process.argv.slice(2));
}
