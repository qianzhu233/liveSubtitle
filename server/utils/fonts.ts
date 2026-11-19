import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FontOption } from '../../types/subtitle';

/**
 * 系统字体元数据解析。
 *
 * 字体下拉不再扫描 public/fonts，而是读取操作系统已安装的字体：
 * - Windows：%WINDIR%\Fonts 与 %LOCALAPPDATA%\Microsoft\Windows\Fonts
 * - macOS：System/Library/Fonts、Library/Fonts 与用户字体目录
 * - Linux：/usr/share/fonts 等常见字体目录
 *
 * 从 TTF / OTF（sfnt，包含 'OTTO'）与 TTC / OTC（'ttcf'）的 'name' 表中
 * 读取字体族名、本地化族名、全名与 PostScript 名，供控制端下拉展示与
 * 展示端按 ASS Fontname 匹配使用；同时读取 OS/2 表判断字重/斜体，
 * 为同一字体族挑选常规字重作为主文件。
 */

const SFNT_VERSION_TRUETYPE = 0x00010000;
const SFNT_VERSION_OTTO = 0x4f54544f; // 'OTTO'
const SFNT_VERSION_TRUE = 0x74727565; // 'true'（旧 Apple TrueType）
const TTC_TAG = 'ttcf';

/** nameID 1 = Family（Windows 字体选择器使用的 GDI 族名），16 = Typographic Family，21 = WWS Family */
const FAMILY_NAME_IDS = [1, 16, 21];
/** nameID 17 = Typographic Subfamily，2 = Subfamily */
const STYLE_NAME_IDS = [17, 2];
/** 参与匹配的 name 记录：族名、全名、PostScript 名 */
const ALIAS_NAME_IDS = new Set([1, 4, 6, 16, 21]);
/** 解析时需要的 name 记录（额外包含 Subfamily，用于判断字重/斜体） */
const PARSED_NAME_IDS = new Set([...ALIAS_NAME_IDS, 2, 17]);

const MAX_TABLES = 4096;
const MAX_NAME_RECORDS = 4096;
const NAME_RECORD_SIZE = 12;
const TABLE_RECORD_SIZE = 16;
const MAX_TTC_FONTS = 256;
/** name 表一般远小于该值；异常文件直接跳过，避免一次性读入超大字体 */
const MAX_NAME_TABLE_BYTES = 8 * 1024 * 1024;
const MAX_OS2_TABLE_BYTES = 128;

const MAX_SCAN_DEPTH = 6;
const MAX_SCANNED_FILES = 5000;
/** 最多返回同一字体族的几个文件（常规/粗体/细体等），避免一次加载过多 */
const MAX_FONT_FILES_PER_FAMILY = 6;
const MAX_FONT_ALIASES = 64;
const MAX_FALLBACK_FONTS = 3;

const DEFAULT_CACHE_TTL_MS = 30_000;

const FONT_FILE_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc']);

/** 优先作为 ASS 缺字回退的字体族（按平台） */
const FALLBACK_FAMILIES: Record<string, string[]> = {
    win32: [
        'Microsoft YaHei UI',
        'Microsoft YaHei',
        'Yu Gothic UI',
        'Meiryo UI',
        'SimHei',
        'Segoe UI',
    ],
    darwin: [
        'PingFang SC',
        'Hiragino Sans GB',
        'Hiragino Sans',
        'Helvetica Neue',
        'Arial Unicode MS',
    ],
    linux: [
        'Noto Sans CJK SC',
        'Noto Sans SC',
        'WenQuanYi Micro Hei',
        'Source Han Sans SC',
        'DejaVu Sans',
    ],
};

export interface FontScanOptions {
    /** 覆盖扫描目录（测试用）；不传时按平台读取系统字体目录 */
    fontDirs?: string[];
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
    /** 字体列表缓存时长，0 表示不缓存 */
    cacheTtlMs?: number;
}

export interface FontNameRecord {
    nameID: number;
    platformID: number;
    languageID: number;
    order: number;
    value: string;
}

export interface FontFaceMetadata {
    /** 展示用族名，优先 Windows 英文名 */
    familyName: string;
    /** 该族名的平台优先级（0 最高） */
    familyRank: number;
    /** 该族的所有本地化名称 */
    familyNames: string[];
    /** 全名、PostScript 名等，供 ASS Fontname 匹配 */
    aliases: string[];
    styleName: string;
    weight: number;
    italic: boolean;
}

interface TableRecord {
    offset: number;
    length: number;
}

interface FontFileEntry {
    fileName: string;
    filePath: string;
    weight: number;
    italic: boolean;
    styleName: string;
}

interface FamilyGroup {
    familyName: string;
    familyRank: number;
    aliases: Set<string>;
    aliasKeys: Set<string>;
    files: Map<string, FontFileEntry>;
}

interface FontOptionsCacheEntry {
    key: string;
    expiresAt: number;
    options: FontOption[];
}

let fontOptionsCache: FontOptionsCacheEntry | null = null;

function readUInt16BE(buffer: Buffer, offset: number): number | null {
    if (offset < 0 || offset + 2 > buffer.length) {
        return null;
    }
    return buffer.readUInt16BE(offset);
}

function readUInt32BE(buffer: Buffer, offset: number): number | null {
    if (offset < 0 || offset + 4 > buffer.length) {
        return null;
    }
    return buffer.readUInt32BE(offset);
}

function isSfntVersion(version: number): boolean {
    return (
        version === SFNT_VERSION_TRUETYPE ||
        version === SFNT_VERSION_OTTO ||
        version === SFNT_VERSION_TRUE
    );
}

/** 从表目录（header 之后的 TableRecord 数组）读取 tag → 偏移/长度 */
function readTableRecords(
    buffer: Buffer,
    recordsStart: number,
    numTables: number,
): Map<string, TableRecord> | null {
    if (numTables === 0 || numTables > MAX_TABLES) {
        return null;
    }
    if (recordsStart + numTables * TABLE_RECORD_SIZE > buffer.length) {
        return null;
    }

    const tables = new Map<string, TableRecord>();

    for (let index = 0; index < numTables; index++) {
        const recordStart = recordsStart + index * TABLE_RECORD_SIZE;
        const tag = buffer.toString('latin1', recordStart, recordStart + 4);
        const offset = readUInt32BE(buffer, recordStart + 8);
        const length = readUInt32BE(buffer, recordStart + 12);
        if (offset === null || length === null) {
            continue;
        }
        tables.set(tag, { offset, length });
    }

    return tables;
}

/** 在 sfnt（含 TTC 中字体）中读取表目录；fontOffset 为字体头部的绝对偏移 */
function readTableDirectory(buffer: Buffer, fontOffset: number): Map<string, TableRecord> | null {
    const sfntVersion = readUInt32BE(buffer, fontOffset);
    if (sfntVersion === null || !isSfntVersion(sfntVersion)) {
        return null;
    }

    const numTables = readUInt16BE(buffer, fontOffset + 4);
    if (numTables === null) {
        return null;
    }

    return readTableRecords(buffer, fontOffset + 12, numTables);
}

/** 解码一条 name 记录：Windows/Unicode 为 UTF-16BE，Mac 按 latin1 */
function decodeNameString(
    buffer: Buffer,
    start: number,
    length: number,
    platformID: number,
): string | null {
    if (length <= 0 || start < 0 || start + length > buffer.length) {
        return null;
    }

    const raw = buffer.subarray(start, start + length);
    let text: string;

    if (platformID === 1) {
        text = raw.toString('latin1');
    } else {
        const evenLength = length - (length % 2);
        if (evenLength <= 0) {
            return null;
        }
        // name 字符串为 UTF-16BE：交换字节序后按 utf16le 解码
        text = Buffer.from(raw.subarray(0, evenLength)).swap16().toString('utf16le');
    }

    const cleaned = text
        .replace(/\u0000+$/g, '')
        .replace(/^\uFEFF/, '')
        .trim();
    return cleaned.length > 0 ? cleaned : null;
}

/** 平台优先级：Windows 英文(0x409) > Windows 其它语言 > Unicode > Mac */
function getPlatformRank(platformID: number, languageID: number): number {
    if (platformID === 3) {
        return languageID === 0x409 ? 0 : 1;
    }
    if (platformID === 0) {
        return 2;
    }
    if (platformID === 1) {
        return 3;
    }
    return -1;
}

/** 解析 name 表，返回所有可用于族名/别名匹配的记录 */
function parseNameCandidates(buffer: Buffer, nameTableOffset: number): FontNameRecord[] {
    const count = readUInt16BE(buffer, nameTableOffset + 2);
    const stringOffset = readUInt16BE(buffer, nameTableOffset + 4);
    if (count === null || stringOffset === null || count === 0 || count > MAX_NAME_RECORDS) {
        return [];
    }

    const recordsStart = nameTableOffset + 6;
    if (recordsStart + count * NAME_RECORD_SIZE > buffer.length) {
        return [];
    }

    const stringStorageStart = nameTableOffset + stringOffset;
    const candidates: FontNameRecord[] = [];

    for (let index = 0; index < count; index++) {
        const recordStart = recordsStart + index * NAME_RECORD_SIZE;
        const platformID = readUInt16BE(buffer, recordStart);
        const languageID = readUInt16BE(buffer, recordStart + 4);
        const nameID = readUInt16BE(buffer, recordStart + 6);
        const length = readUInt16BE(buffer, recordStart + 8);
        const offset = readUInt16BE(buffer, recordStart + 10);

        if (
            platformID === null ||
            languageID === null ||
            nameID === null ||
            length === null ||
            offset === null
        ) {
            continue;
        }
        if (!PARSED_NAME_IDS.has(nameID)) {
            continue;
        }
        if (getPlatformRank(platformID, languageID) < 0) {
            continue;
        }

        const value = decodeNameString(buffer, stringStorageStart + offset, length, platformID);
        if (!value) {
            continue;
        }

        candidates.push({ nameID, platformID, languageID, order: index, value });
    }

    return candidates;
}

function sortCandidates(left: FontNameRecord, right: FontNameRecord): number {
    const rankDiff =
        getPlatformRank(left.platformID, left.languageID) -
        getPlatformRank(right.platformID, right.languageID);
    return rankDiff !== 0 ? rankDiff : left.order - right.order;
}

function pickName(candidates: FontNameRecord[], nameIDs: number[]): FontNameRecord | null {
    for (const targetNameID of nameIDs) {
        const best = candidates
            .filter((candidate) => candidate.nameID === targetNameID)
            .sort(sortCandidates)[0];
        if (best) {
            return best;
        }
    }
    return null;
}

/**
 * 选族名：先按语言优先级（英文优先），再按 nameID 优先级。
 * 这样 Arial Narrow 这类「nameID 1 = Arial Narrow、nameID 16 = Arial」的字体
 * 会以 Windows 字体选择器中的 Arial Narrow 展示，而不是被并进 Arial。
 */
function pickFamilyName(candidates: FontNameRecord[]): FontNameRecord | null {
    const matches = candidates
        .filter((candidate) => FAMILY_NAME_IDS.includes(candidate.nameID))
        .sort((left, right) => {
            const rankDiff =
                getPlatformRank(left.platformID, left.languageID) -
                getPlatformRank(right.platformID, right.languageID);
            if (rankDiff !== 0) {
                return rankDiff;
            }
            const nameIdDiff =
                FAMILY_NAME_IDS.indexOf(left.nameID) - FAMILY_NAME_IDS.indexOf(right.nameID);
            if (nameIdDiff !== 0) {
                return nameIdDiff;
            }
            return left.order - right.order;
        });

    return matches[0] ?? null;
}

function collectNames(candidates: FontNameRecord[], nameIDs: number[]): string[] {
    const values: string[] = [];
    const seen = new Set<string>();

    for (const nameID of nameIDs) {
        for (const candidate of candidates) {
            if (candidate.nameID !== nameID) {
                continue;
            }
            const key = candidate.value.trim().toLowerCase();
            if (!key || seen.has(key)) {
                continue;
            }
            seen.add(key);
            values.push(candidate.value);
        }
    }

    return values;
}

/** OS/2 表：usWeightClass 在 +4，fsSelection 在 +62（最低位表示斜体） */
function parseOs2(
    buffer: Buffer,
    os2TableOffset: number,
): { weight: number; italic: boolean } | null {
    const weight = readUInt16BE(buffer, os2TableOffset + 4);
    const fsSelection = readUInt16BE(buffer, os2TableOffset + 62);
    if (weight === null || fsSelection === null) {
        return null;
    }
    return {
        weight: weight > 0 ? weight : 400,
        italic: (fsSelection & 0x01) !== 0,
    };
}

/** OS/2 缺失时从 Subfamily 名称推断字重/斜体 */
function inferStyle(styleName: string | null): { weight: number; italic: boolean } {
    const style = (styleName ?? '').toLowerCase();
    const italic = /italic|oblique|kursiv|斜体/.test(style);

    if (/thin|hairline|extra ?light|ultra ?light/.test(style)) {
        return { weight: 100, italic };
    }
    if (/semi ?light|demi ?light/.test(style)) {
        return { weight: 350, italic };
    }
    if (/extra ?bold|ultra ?bold|black|heavy/.test(style)) {
        return { weight: 900, italic };
    }
    if (/semi ?bold|demi ?bold/.test(style)) {
        return { weight: 600, italic };
    }
    if (/bold|fett/.test(style)) {
        return { weight: 700, italic };
    }
    if (/light|mager/.test(style)) {
        return { weight: 300, italic };
    }
    if (/medium/.test(style)) {
        return { weight: 500, italic };
    }

    return { weight: 400, italic };
}

/** 合并 name 表与 OS/2 信息，得到单个字面的元数据 */
function buildFaceMetadata(
    candidates: FontNameRecord[],
    os2: { weight: number; italic: boolean } | null,
): FontFaceMetadata | null {
    const familyRecord = pickFamilyName(candidates);
    if (!familyRecord) {
        return null;
    }

    const styleRecord = pickName(candidates, STYLE_NAME_IDS);
    const styleName = styleRecord?.value ?? '';
    const inferred = inferStyle(styleRecord?.value ?? null);

    const familyNames = collectNames(candidates, FAMILY_NAME_IDS);
    const aliases = collectNames(candidates, [...ALIAS_NAME_IDS]);
    const aliasKeys = new Set<string>();
    const uniqueAliases: string[] = [];

    for (const alias of aliases) {
        const key = alias.trim().toLowerCase();
        if (!key || aliasKeys.has(key)) {
            continue;
        }
        aliasKeys.add(key);
        uniqueAliases.push(alias.trim());
        if (uniqueAliases.length >= MAX_FONT_ALIASES) {
            break;
        }
    }

    return {
        familyName: familyRecord.value.trim(),
        familyRank: getPlatformRank(familyRecord.platformID, familyRecord.languageID),
        familyNames,
        aliases: uniqueAliases,
        styleName,
        weight: os2?.weight ?? inferred.weight,
        italic: os2?.italic ?? inferred.italic,
    };
}

/** 从字体 Buffer（支持 TTC，解析所有字面）提取元数据；失败返回空数组 */
export function readFontFacesFromBuffer(buffer: Buffer): FontFaceMetadata[] {
    try {
        if (!buffer || buffer.length < 12) {
            return [];
        }

        let fontOffsets: number[] = [];
        const headerTag = buffer.toString('latin1', 0, 4);

        if (headerTag === TTC_TAG) {
            const numFonts = readUInt32BE(buffer, 8);
            if (numFonts === null || numFonts < 1) {
                return [];
            }
            const faceCount = Math.min(numFonts, MAX_TTC_FONTS);
            const offsetsStart = 12;
            if (offsetsStart + faceCount * 4 > buffer.length) {
                return [];
            }
            for (let index = 0; index < faceCount; index++) {
                const offset = readUInt32BE(buffer, offsetsStart + index * 4);
                if (offset !== null) {
                    fontOffsets.push(offset);
                }
            }
        } else {
            fontOffsets = [0];
        }

        const faces: FontFaceMetadata[] = [];

        for (const fontOffset of fontOffsets) {
            const tables = readTableDirectory(buffer, fontOffset);
            if (!tables) {
                continue;
            }

            const nameTable = tables.get('name');
            if (!nameTable || nameTable.offset + nameTable.length > buffer.length) {
                continue;
            }

            const candidates = parseNameCandidates(buffer, nameTable.offset);
            const os2Table = tables.get('OS/2');
            const os2 =
                os2Table &&
                os2Table.offset + Math.min(os2Table.length, MAX_OS2_TABLE_BYTES) <= buffer.length
                    ? parseOs2(buffer, os2Table.offset)
                    : null;
            const metadata = buildFaceMetadata(candidates, os2);
            if (metadata) {
                faces.push(metadata);
            }
        }

        return faces;
    } catch {
        return [];
    }
}

/** 读取字体族名（第一个字面），失败返回 null；保留给调用方做轻量探测 */
export function readFontFamilyName(buffer: Buffer): string | null {
    return readFontFacesFromBuffer(buffer)[0]?.familyName ?? null;
}

function readFileRange(fd: number, position: number, length: number): Buffer {
    if (length <= 0) {
        return Buffer.alloc(0);
    }

    const buffer = Buffer.alloc(length);
    let total = 0;

    while (total < length) {
        let bytesRead = 0;
        try {
            bytesRead = fs.readSync(fd, buffer, total, length - total, position + total);
        } catch {
            break;
        }
        if (bytesRead <= 0) {
            break;
        }
        total += bytesRead;
    }

    return total === length ? buffer : buffer.subarray(0, total);
}

/**
 * 从字体文件读取元数据。
 * 只按表目录读取 name / OS/2 表，不会把几十 MB 的 CJK 字体整个读入内存。
 */
export function readFontFacesFromFile(filePath: string): FontFaceMetadata[] {
    let fd: number | null = null;
    const faces: FontFaceMetadata[] = [];

    try {
        fd = fs.openSync(filePath, 'r');
        const size = fs.fstatSync(fd).size;
        if (size < 12) {
            return [];
        }

        const header = readFileRange(fd, 0, 12);
        if (header.length < 12) {
            return [];
        }

        let fontOffsets: number[] = [];

        if (header.toString('latin1', 0, 4) === TTC_TAG) {
            const numFonts = header.readUInt32BE(8);
            if (numFonts < 1) {
                return [];
            }
            const faceCount = Math.min(numFonts, MAX_TTC_FONTS);
            const offsetsBuffer = readFileRange(fd, 12, faceCount * 4);
            if (offsetsBuffer.length < faceCount * 4) {
                return [];
            }
            for (let index = 0; index < faceCount; index++) {
                const rawOffset = offsetsBuffer.readUInt32BE(index * 4);
                if (rawOffset > 0 && rawOffset + 12 <= size) {
                    fontOffsets.push(rawOffset);
                }
            }
        } else {
            fontOffsets = [0];
        }

        for (const fontOffset of fontOffsets) {
            const faceHeader = readFileRange(fd, fontOffset, 12);
            if (faceHeader.length < 12) {
                continue;
            }
            const sfntVersion = faceHeader.readUInt32BE(0);
            if (!isSfntVersion(sfntVersion)) {
                continue;
            }
            const numTables = faceHeader.readUInt16BE(4);
            if (numTables === 0 || numTables > MAX_TABLES) {
                continue;
            }

            const directoryLength = numTables * TABLE_RECORD_SIZE;
            if (fontOffset + 12 + directoryLength > size) {
                continue;
            }
            const directory = readFileRange(fd, fontOffset + 12, directoryLength);
            if (directory.length < directoryLength) {
                continue;
            }

            const tables = readTableRecords(directory, 0, numTables);
            if (!tables) {
                continue;
            }

            const nameTable = tables.get('name');
            if (
                !nameTable ||
                nameTable.length <= 0 ||
                nameTable.length > MAX_NAME_TABLE_BYTES ||
                nameTable.offset + nameTable.length > size
            ) {
                continue;
            }

            const nameBuffer = readFileRange(fd, nameTable.offset, nameTable.length);
            if (nameBuffer.length < nameTable.length) {
                continue;
            }
            const candidates = parseNameCandidates(nameBuffer, 0);

            let os2: { weight: number; italic: boolean } | null = null;
            const os2Table = tables.get('OS/2');
            if (
                os2Table &&
                os2Table.length > 0 &&
                os2Table.offset + Math.min(os2Table.length, MAX_OS2_TABLE_BYTES) <= size
            ) {
                const os2Buffer = readFileRange(
                    fd,
                    os2Table.offset,
                    Math.min(os2Table.length, MAX_OS2_TABLE_BYTES),
                );
                os2 = parseOs2(os2Buffer, 0);
            }

            const metadata = buildFaceMetadata(candidates, os2);
            if (metadata) {
                faces.push(metadata);
            }
        }

        return faces;
    } catch {
        return [];
    } finally {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            } catch {
                // 忽略关闭失败：读取结果已经确定
            }
        }
    }
}

function dedupePaths(paths: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const item of paths) {
        if (!item) {
            continue;
        }
        const key = process.platform === 'win32' ? item.toLowerCase() : item;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(item);
    }

    return result;
}

/** 按当前平台返回系统字体目录列表 */
export function getSystemFontDirs(options: FontScanOptions = {}): string[] {
    if (options.fontDirs) {
        return dedupePaths(options.fontDirs);
    }

    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const home = options.home ?? os.homedir();

    if (platform === 'win32') {
        const windowsDir = env.WINDIR || env.SystemRoot || 'C:\\Windows';
        const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        return dedupePaths([
            path.join(windowsDir, 'Fonts'),
            path.join(localAppData, 'Microsoft', 'Windows', 'Fonts'),
        ]);
    }

    if (platform === 'darwin') {
        return dedupePaths([
            '/System/Library/Fonts',
            '/System/Library/Fonts/Supplemental',
            '/Library/Fonts',
            path.posix.join(home, 'Library', 'Fonts'),
        ]);
    }

    return dedupePaths([
        '/usr/share/fonts',
        '/usr/local/share/fonts',
        path.posix.join(home, '.local', 'share', 'fonts'),
        path.posix.join(home, '.fonts'),
    ]);
}

function collectFontFiles(directory: string, files: string[], depth = 0): void {
    if (depth > MAX_SCAN_DEPTH || files.length >= MAX_SCANNED_FILES) {
        return;
    }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (files.length >= MAX_SCANNED_FILES) {
            return;
        }

        const fullPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            collectFontFiles(fullPath, files, depth + 1);
            continue;
        }

        if (entry.isFile() && FONT_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            files.push(fullPath);
        }
    }
}

function normalizeAliasKey(value: string): string {
    return value.trim().replace(/^@+/, '').toLowerCase();
}

function fontFileScore(entry: FontFileEntry): number {
    // 常规字重优先，其次非斜体；窄体/宽体等变体排在后面，避免把 Arial Narrow 当作 Arial 主文件
    const widthPenalty = /narrow|condensed|expanded|extended/i.test(entry.styleName) ? 100 : 0;
    return widthPenalty + (entry.italic ? 5000 : 0) + Math.abs(entry.weight - 400);
}

function compareFontFiles(left: FontFileEntry, right: FontFileEntry): number {
    const scoreDiff = fontFileScore(left) - fontFileScore(right);
    if (scoreDiff !== 0) {
        return scoreDiff;
    }
    return left.fileName < right.fileName ? -1 : left.fileName > right.fileName ? 1 : 0;
}

function compareFamilyNames(left: FontOption, right: FontOption): number {
    const leftKey = left.familyName.toLowerCase();
    const rightKey = right.familyName.toLowerCase();
    if (leftKey !== rightKey) {
        return leftKey < rightKey ? -1 : 1;
    }
    return left.familyName < right.familyName ? -1 : left.familyName > right.familyName ? 1 : 0;
}

function addAlias(group: FamilyGroup, value: string): void {
    const trimmed = value.trim();
    if (!trimmed) {
        return;
    }
    const key = normalizeAliasKey(trimmed);
    if (!key || group.aliasKeys.has(key)) {
        return;
    }
    if (group.aliases.size >= MAX_FONT_ALIASES) {
        return;
    }
    group.aliasKeys.add(key);
    group.aliases.add(trimmed);
}

/** 给常用 CJK / 拉丁字体打上回退标记，ASS 字体缺失时展示端用它们兜底 */
function markFallbackOptions(options: FontOption[], platform: NodeJS.Platform): void {
    if (options.length === 0) {
        return;
    }

    const byAlias = new Map<string, FontOption>();
    for (const option of options) {
        for (const name of [option.familyName, ...option.aliases]) {
            const key = normalizeAliasKey(name);
            if (key && !byAlias.has(key)) {
                byAlias.set(key, option);
            }
        }
    }

    const marked = new Set<FontOption>();
    const preferred = FALLBACK_FAMILIES[platform] ?? FALLBACK_FAMILIES.win32 ?? [];

    for (const name of preferred) {
        if (marked.size >= MAX_FALLBACK_FONTS) {
            break;
        }
        const option = byAlias.get(normalizeAliasKey(name));
        if (option && !marked.has(option)) {
            option.fallback = true;
            marked.add(option);
        }
    }

    for (const option of options) {
        if (marked.size >= MAX_FALLBACK_FONTS) {
            break;
        }
        if (!marked.has(option)) {
            option.fallback = true;
            marked.add(option);
        }
    }
}

function scanSystemFonts(fontDirs: string[], platform: NodeJS.Platform): FontOption[] {
    const files: string[] = [];

    for (const directory of fontDirs) {
        collectFontFiles(directory, files);
    }

    const groups = new Map<string, FamilyGroup>();

    for (const filePath of files) {
        const faces = readFontFacesFromFile(filePath);
        if (faces.length === 0) {
            continue;
        }

        for (const face of faces) {
            const familyKey = face.familyName.trim().toLowerCase();
            if (!familyKey) {
                continue;
            }

            let group = groups.get(familyKey);
            if (!group) {
                group = {
                    familyName: face.familyName.trim(),
                    familyRank: face.familyRank,
                    aliases: new Set(),
                    aliasKeys: new Set(),
                    files: new Map(),
                };
                groups.set(familyKey, group);
            } else if (face.familyRank < group.familyRank) {
                // 后读到的字体若带有更优先的英文族名，则用它作为展示名
                group.familyName = face.familyName.trim();
                group.familyRank = face.familyRank;
            }

            for (const name of face.familyNames) {
                addAlias(group, name);
            }
            for (const alias of face.aliases) {
                addAlias(group, alias);
            }

            const fileKey = platform === 'win32' ? filePath.toLowerCase() : filePath;
            const entry: FontFileEntry = {
                fileName: path.basename(filePath),
                filePath,
                weight: face.weight,
                italic: face.italic,
                styleName: face.styleName,
            };
            const existing = group.files.get(fileKey);
            if (!existing || fontFileScore(entry) < fontFileScore(existing)) {
                group.files.set(fileKey, entry);
            }
        }
    }

    const options: FontOption[] = [];

    for (const group of groups.values()) {
        const sortedFiles = [...group.files.values()].sort(compareFontFiles);
        const primary = sortedFiles[0];
        if (!primary) {
            continue;
        }

        const urls = sortedFiles
            .slice(0, MAX_FONT_FILES_PER_FAMILY)
            .map((entry) => buildFontFileUrl(entry.filePath));

        options.push({
            familyName: group.familyName,
            fileName: primary.fileName,
            url: urls[0]!,
            urls,
            aliases: [...group.aliases].slice(0, MAX_FONT_ALIASES),
        });
    }

    options.sort(compareFamilyNames);
    markFallbackOptions(options, platform);

    return options;
}

function buildFontFileUrl(filePath: string): string {
    return `/api/font-file/${encodeFontFileToken(filePath)}`;
}

/** 把字体文件的绝对路径编码成 URL 安全的 token */
export function encodeFontFileToken(filePath: string): string {
    return Buffer.from(path.resolve(filePath), 'utf8').toString('base64url');
}

/** 解析字体文件 token，并校验文件确实位于允许的字体目录内 */
export function resolveFontFileToken(
    token: string,
    fontDirs: string[] = getSystemFontDirs(),
): string | null {
    if (!token || token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) {
        return null;
    }

    try {
        const decoded = Buffer.from(token, 'base64url').toString('utf8');
        if (!decoded || decoded.includes('\0')) {
            return null;
        }

        const candidate = path.resolve(decoded);
        if (!FONT_FILE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) {
            return null;
        }
        if (!fs.statSync(candidate).isFile()) {
            return null;
        }

        const realFile = fs.realpathSync(candidate);
        const realDirs = fontDirs.map((directory) => {
            try {
                return fs.realpathSync(directory);
            } catch {
                return path.resolve(directory);
            }
        });

        if (!realDirs.some((directory) => isPathInside(realFile, directory))) {
            return null;
        }

        return realFile;
    } catch {
        return null;
    }
}

function isPathInside(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    if (relative === '' || path.isAbsolute(relative)) {
        return false;
    }
    return relative.split(path.sep)[0] !== '..';
}

export function clearFontOptionsCache(): void {
    fontOptionsCache = null;
}

/**
 * 扫描系统字体生成字体下拉选项。
 * 同一字体族合并为一个选项：urls 按常规字重优先排列，供展示端加载同族字重；
 * aliases 包含本地化族名、全名与 PostScript 名，用于匹配 ASS Fontname。
 */
export function getFontOptions(options: FontScanOptions = {}): FontOption[] {
    const fontDirs = getSystemFontDirs(options);
    const platform = options.platform ?? process.platform;
    const cacheKey = `${platform}|${fontDirs.join('|')}`;
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const now = Date.now();

    if (
        cacheTtlMs > 0 &&
        fontOptionsCache &&
        fontOptionsCache.key === cacheKey &&
        fontOptionsCache.expiresAt > now
    ) {
        return fontOptionsCache.options;
    }

    const result = scanSystemFonts(fontDirs, platform);

    if (cacheTtlMs > 0) {
        fontOptionsCache = {
            key: cacheKey,
            expiresAt: now + cacheTtlMs,
            options: result,
        };
    }

    return result;
}
