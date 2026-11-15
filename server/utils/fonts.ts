import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import type { FontOption } from '../../types/subtitle';
import { getFontList } from './subtitle';

/**
 * 字体元数据解析。
 *
 * 从 TTF / OTF（sfnt，包含 'OTTO'）与 TTC（'ttcf'，取第一个字体）文件的
 * 'name' 表中读取字体族名，供控制端「字体」下拉展示。
 */

const SFNT_VERSION_TRUETYPE = 0x00010000;
const SFNT_VERSION_OTTO = 0x4f54544f; // 'OTTO'
const SFNT_VERSION_TRUE = 0x74727565; // 'true'（旧 Apple TrueType）
const TTC_TAG = 'ttcf';

/** nameID 16 = Typographic Family，nameID 1 = Family */
const NAME_IDS = [16, 1];

const MAX_TABLES = 4096;
const MAX_NAME_RECORDS = 4096;
const NAME_RECORD_SIZE = 12;
const TABLE_RECORD_SIZE = 16;

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

/** 在 sfnt（含 TTC 中字体）中定位 'name' 表，返回表头在文件中的绝对偏移 */
function findNameTable(buffer: Buffer, fontOffset: number): { offset: number } | null {
    const sfntVersion = readUInt32BE(buffer, fontOffset);
    if (sfntVersion === null) {
        return null;
    }
    if (
        sfntVersion !== SFNT_VERSION_TRUETYPE &&
        sfntVersion !== SFNT_VERSION_OTTO &&
        sfntVersion !== SFNT_VERSION_TRUE
    ) {
        return null;
    }

    const numTables = readUInt16BE(buffer, fontOffset + 4);
    if (numTables === null || numTables === 0 || numTables > MAX_TABLES) {
        return null;
    }

    const tableRecordsStart = fontOffset + 12;
    if (tableRecordsStart + numTables * TABLE_RECORD_SIZE > buffer.length) {
        return null;
    }

    for (let index = 0; index < numTables; index++) {
        const recordStart = tableRecordsStart + index * TABLE_RECORD_SIZE;
        const tag = buffer.toString('latin1', recordStart, recordStart + 4);
        if (tag !== 'name') {
            continue;
        }

        // TTC 中的表偏移同样相对于文件开头，因此直接使用绝对偏移
        const offset = readUInt32BE(buffer, recordStart + 8);
        if (offset === null) {
            return null;
        }
        return { offset };
    }

    return null;
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

/** 从 'name' 表头读取字体族名：优先 nameID 16，回退 nameID 1 */
function extractFamilyName(buffer: Buffer, nameTableOffset: number): string | null {
    const count = readUInt16BE(buffer, nameTableOffset + 2);
    const stringOffset = readUInt16BE(buffer, nameTableOffset + 4);
    if (count === null || stringOffset === null || count === 0 || count > MAX_NAME_RECORDS) {
        return null;
    }

    const recordsStart = nameTableOffset + 6;
    if (recordsStart + count * NAME_RECORD_SIZE > buffer.length) {
        return null;
    }

    const stringStorageStart = nameTableOffset + stringOffset;
    const candidates: Array<{
        nameID: number;
        platformID: number;
        languageID: number;
        order: number;
        value: string;
    }> = [];

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
        if (nameID !== 1 && nameID !== 16) {
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

    for (const targetNameID of NAME_IDS) {
        const matches = candidates
            .filter((candidate) => candidate.nameID === targetNameID)
            .sort((left, right) => {
                const rankDiff =
                    getPlatformRank(left.platformID, left.languageID) -
                    getPlatformRank(right.platformID, right.languageID);
                return rankDiff !== 0 ? rankDiff : left.order - right.order;
            });

        const best = matches[0];
        if (best) {
            return best.value;
        }
    }

    return null;
}

/**
 * 读取字体族名（familyName）。
 * 解析失败、数据越界或不是字体文件时返回 null，不抛异常。
 */
export function readFontFamilyName(buffer: Buffer): string | null {
    try {
        if (!buffer || buffer.length < 12) {
            return null;
        }

        let fontOffset = 0;
        const headerTag = buffer.toString('latin1', 0, 4);
        if (headerTag === TTC_TAG) {
            const numFonts = readUInt32BE(buffer, 8);
            if (numFonts === null || numFonts < 1) {
                return null;
            }
            const firstFontOffset = readUInt32BE(buffer, 12);
            if (firstFontOffset === null) {
                return null;
            }
            fontOffset = firstFontOffset;
        }

        const nameTable = findNameTable(buffer, fontOffset);
        if (!nameTable) {
            return null;
        }

        return extractFamilyName(buffer, nameTable.offset);
    } catch {
        return null;
    }
}

/**
 * 扫描 public/fonts 生成字体下拉选项。
 * 解析不到 familyName 时回退为去掉扩展名的文件名。
 * @param rootDir 项目根目录，默认为 process.cwd()（测试可传临时目录）
 */
export function getFontOptions(rootDir: string = process.cwd()): FontOption[] {
    const fontsDir = path.join(rootDir, 'public', 'fonts');
    if (!fs.existsSync(fontsDir)) {
        return [];
    }

    const fontFiles = getFontList(rootDir)
        .filter((fileName) => /\.(ttf|otf|ttc)$/i.test(fileName))
        .sort();

    return fontFiles.map((fileName) => {
        let familyName = '';

        try {
            familyName = readFontFamilyName(fs.readFileSync(path.join(fontsDir, fileName))) ?? '';
        } catch (error) {
            console.error(`读取字体信息失败 ${fileName}:`, error);
        }

        return {
            fileName,
            familyName: familyName || path.basename(fileName, path.extname(fileName)),
            url: `/fonts/${fileName}`,
        };
    });
}
