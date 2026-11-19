import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import {
    clearFontOptionsCache,
    encodeFontFileToken,
    getFontOptions,
    getSystemFontDirs,
    readFontFacesFromBuffer,
    readFontFacesFromFile,
    readFontFamilyName,
    resolveFontFileToken,
} from '../../server/utils/fonts';

/** 用最小 sfnt 数据构造测试字体，避免测试依赖系统或仓库里的真实字体文件 */

interface TestName {
    nameID: number;
    value: string;
    platformID?: number;
    languageID?: number;
}

interface TestFaceOptions {
    family: string;
    style?: string;
    fullName?: string;
    postScriptName?: string;
    weight?: number;
    italic?: boolean;
    withoutOs2?: boolean;
    extraNames?: TestName[];
}

function buildNameTable(names: TestName[]): Buffer {
    const headerSize = 6;
    const recordSize = 12;
    const stringOffset = headerSize + names.length * recordSize;

    const header = Buffer.alloc(headerSize);
    header.writeUInt16BE(0, 0);
    header.writeUInt16BE(names.length, 2);
    header.writeUInt16BE(stringOffset, 4);

    const records: Buffer[] = [];
    const strings: Buffer[] = [];
    let currentStringOffset = 0;

    for (const name of names) {
        const encoded = Buffer.from(name.value, 'utf16le').swap16();
        const record = Buffer.alloc(recordSize);
        record.writeUInt16BE(name.platformID ?? 3, 0);
        record.writeUInt16BE(1, 2);
        record.writeUInt16BE(name.languageID ?? 0x409, 4);
        record.writeUInt16BE(name.nameID, 6);
        record.writeUInt16BE(encoded.length, 8);
        record.writeUInt16BE(currentStringOffset, 10);
        records.push(record);
        strings.push(encoded);
        currentStringOffset += encoded.length;
    }

    return Buffer.concat([header, ...records, ...strings]);
}

function buildOs2Table(weight: number, italic: boolean): Buffer {
    const os2 = Buffer.alloc(96);
    os2.writeUInt16BE(4, 0);
    os2.writeUInt16BE(weight, 4);
    os2.writeUInt16BE(italic ? 0x01 : 0x00, 62);
    return os2;
}

/** 构造单字面 sfnt；baseOffset 用于拼进 TTC 时把表偏移改成文件绝对偏移 */
function buildTestFont(options: TestFaceOptions, baseOffset = 0): Buffer {
    const style = options.style ?? 'Regular';
    const names: TestName[] = [
        { nameID: 1, value: options.family },
        { nameID: 2, value: style },
        { nameID: 4, value: options.fullName ?? `${options.family} ${style}`.trim() },
        {
            nameID: 6,
            value: options.postScriptName ?? `${options.family.replace(/\s+/g, '')}-${style}`,
        },
        ...(options.extraNames ?? []),
    ];

    const tables = [
        { tag: 'name', data: buildNameTable(names) },
        ...(options.withoutOs2
            ? []
            : [
                  {
                      tag: 'OS/2',
                      data: buildOs2Table(options.weight ?? 400, options.italic ?? false),
                  },
              ]),
    ];

    const directorySize = tables.length * 16;
    let tableOffset = baseOffset + 12 + directorySize;
    const directory = Buffer.alloc(directorySize);

    tables.forEach((table, index) => {
        const record = directory.subarray(index * 16, (index + 1) * 16);
        record.write(table.tag, 0, 'latin1');
        record.writeUInt32BE(tableOffset, 8);
        record.writeUInt32BE(table.data.length, 12);
        tableOffset += table.data.length;
    });

    const header = Buffer.alloc(12);
    header.writeUInt32BE(0x00010000, 0);
    header.writeUInt16BE(tables.length, 4);

    return Buffer.concat([header, directory, ...tables.map((table) => table.data)]);
}

function buildTestTtc(faces: TestFaceOptions[]): Buffer {
    const headerSize = 12 + faces.length * 4;
    const lengths = faces.map((face) => buildTestFont(face).length);
    const offsets: number[] = [];
    let cursor = headerSize;

    for (const length of lengths) {
        offsets.push(cursor);
        cursor += length;
    }

    const header = Buffer.alloc(headerSize);
    header.write('ttcf', 0, 'latin1');
    header.writeUInt32BE(0x00010000, 4);
    header.writeUInt32BE(faces.length, 8);
    offsets.forEach((offset, index) => header.writeUInt32BE(offset, 12 + index * 4));

    return Buffer.concat([
        header,
        ...faces.map((face, index) => buildTestFont(face, offsets[index])),
    ]);
}

let tempRoot: string;
let fontsDir: string;

const writeFont = (relativePath: string, options: TestFaceOptions): string => {
    const filePath = path.join(fontsDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buildTestFont(options));
    return filePath;
};

beforeEach(() => {
    clearFontOptionsCache();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'livesubtitle-fonts-'));
    fontsDir = path.join(tempRoot, 'fonts');
    fs.mkdirSync(fontsDir, { recursive: true });
});

afterEach(() => {
    clearFontOptionsCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('readFontFaces 字体元数据', () => {
    it('解析 TTF 的 family / 全名 / PostScript 名与字重', () => {
        const buffer = buildTestFont({
            family: 'Test Font',
            style: 'Bold',
            weight: 700,
            extraNames: [
                { nameID: 1, value: '测试字体', platformID: 3, languageID: 0x804 },
                { nameID: 16, value: 'Test Font Display' },
            ],
        });

        const faces = readFontFacesFromBuffer(buffer);

        expect(faces).toHaveLength(1);
        expect(faces[0]).toMatchObject({
            familyName: 'Test Font',
            styleName: 'Bold',
            weight: 700,
            italic: false,
        });
        expect(faces[0]!.familyNames).toContain('测试字体');
        expect(faces[0]!.familyNames).toContain('Test Font Display');
        expect(faces[0]!.aliases).toContain('Test Font Display');
        expect(faces[0]!.aliases).toContain('TestFont-Bold');
    });

    it('解析 TTC 中的所有字面，而不是只取第一个', () => {
        const ttc = buildTestTtc([
            { family: 'First Font', style: 'Regular' },
            { family: 'Second Font', style: 'Regular' },
        ]);

        const faces = readFontFacesFromBuffer(ttc);
        expect(faces.map((face) => face.familyName)).toEqual(['First Font', 'Second Font']);
        expect(readFontFamilyName(ttc)).toBe('First Font');
    });

    it('OS/2 缺失时从 Subfamily 推断粗体/斜体', () => {
        const buffer = buildTestFont({ family: 'No OS2', style: 'Bold Italic', withoutOs2: true });
        const faces = readFontFacesFromBuffer(buffer);

        expect(faces[0]!.weight).toBe(700);
        expect(faces[0]!.italic).toBe(true);
    });

    it('非字体数据与截断数据返回空结果且不抛异常', () => {
        expect(readFontFacesFromBuffer(Buffer.alloc(0))).toEqual([]);
        expect(readFontFacesFromBuffer(Buffer.from('not a font file', 'utf8'))).toEqual([]);

        const ttf = buildTestFont({ family: 'Truncated' });
        expect(readFontFacesFromBuffer(ttf.subarray(0, 4))).toEqual([]);
        expect(readFontFacesFromBuffer(ttf.subarray(0, 12))).toEqual([]);
        expect(readFontFacesFromBuffer(ttf.subarray(0, 64))).toEqual([]);
        expect(readFontFamilyName(ttf.subarray(0, 64))).toBeNull();

        const emptyTtc = Buffer.alloc(12);
        emptyTtc.write('ttcf', 0, 'latin1');
        emptyTtc.writeUInt32BE(0, 8);
        expect(readFontFacesFromBuffer(emptyTtc)).toEqual([]);
    });

    it('任意二进制数据都不会抛异常', () => {
        const random = Buffer.from(
            Array.from({ length: 512 }, (_value, index) => (index * 37 + 11) % 256),
        );

        expect(() => readFontFacesFromBuffer(random)).not.toThrow();
        expect(readFontFacesFromBuffer(random)).toEqual([]);
    });
});

describe('readFontFacesFromFile', () => {
    it('只读表目录也能解析 TTF / TTC 文件', () => {
        const ttfPath = writeFont('Regular.ttf', { family: 'File Font' });
        expect(readFontFacesFromFile(ttfPath).map((face) => face.familyName)).toEqual([
            'File Font',
        ]);

        const ttcPath = path.join(fontsDir, 'Collection.ttc');
        fs.writeFileSync(
            ttcPath,
            buildTestTtc([{ family: 'Collection A' }, { family: 'Collection B' }]),
        );
        expect(readFontFacesFromFile(ttcPath).map((face) => face.familyName)).toEqual([
            'Collection A',
            'Collection B',
        ]);
    });

    it('损坏、空文件或不存在时返回空数组', () => {
        const brokenPath = path.join(fontsDir, 'Broken.ttf');
        fs.writeFileSync(brokenPath, Buffer.from('garbage data'));
        expect(readFontFacesFromFile(brokenPath)).toEqual([]);

        const emptyPath = path.join(fontsDir, 'Empty.otf');
        fs.writeFileSync(emptyPath, Buffer.alloc(0));
        expect(readFontFacesFromFile(emptyPath)).toEqual([]);
        expect(readFontFacesFromFile(path.join(fontsDir, 'Missing.ttf'))).toEqual([]);
    });
});

describe('getFontOptions 系统字体选项', () => {
    it('扫描系统字体目录，按字体族合并字重并生成安全的文件 URL', () => {
        writeFont('Regular.ttf', {
            family: 'Test Font',
            style: 'Regular',
            weight: 400,
            extraNames: [{ nameID: 1, value: '测试字体', platformID: 3, languageID: 0x804 }],
        });
        writeFont('Bold.ttf', { family: 'Test Font', style: 'Bold', weight: 700 });
        writeFont('Other.otf', { family: 'Another Font' });
        writeFont(path.join('nested', 'Nested.ttf'), { family: 'Nested Font' });
        fs.writeFileSync(path.join(fontsDir, 'Broken.ttf'), Buffer.from('garbage data'));
        fs.writeFileSync(path.join(fontsDir, 'Ignored.woff2'), Buffer.from('garbage data'));

        const options = getFontOptions({ fontDirs: [fontsDir], platform: 'linux', cacheTtlMs: 0 });

        expect(options.map((option) => option.familyName)).toEqual([
            'Another Font',
            'Nested Font',
            'Test Font',
        ]);

        const testFont = options.find((option) => option.familyName === 'Test Font')!;
        expect(testFont.fileName).toBe('Regular.ttf');
        expect(testFont.urls).toHaveLength(2);
        expect(testFont.url).toBe(testFont.urls[0]);
        expect(testFont.urls[0]).toBe(
            `/api/font-file/${encodeFontFileToken(path.join(fontsDir, 'Regular.ttf'))}`,
        );
        expect(testFont.aliases).toContain('测试字体');
        expect(testFont.aliases).toContain('Test Font');

        for (const option of options) {
            expect(option.urls.length).toBeGreaterThan(0);
            expect(option.url).toBe(option.urls[0]);
            expect(option.url.startsWith('/api/font-file/')).toBe(true);
        }
    });

    it('目录不存在或为空时返回空数组', () => {
        expect(
            getFontOptions({
                fontDirs: [path.join(tempRoot, 'missing')],
                platform: 'linux',
                cacheTtlMs: 0,
            }),
        ).toEqual([]);
        expect(getFontOptions({ fontDirs: [fontsDir], platform: 'linux', cacheTtlMs: 0 })).toEqual(
            [],
        );
    });

    it('优先标记系统常用 CJK 字体作为 ASS 缺字回退', () => {
        writeFont('YaHei.ttf', { family: 'Microsoft YaHei' });
        writeFont('Other.ttf', { family: 'Other Font' });

        const options = getFontOptions({ fontDirs: [fontsDir], platform: 'win32', cacheTtlMs: 0 });
        expect(options.find((option) => option.familyName === 'Microsoft YaHei')?.fallback).toBe(
            true,
        );
    });

    it('同一批目录会复用缓存，清除后重新扫描', () => {
        writeFont('First.ttf', { family: 'First Font' });
        const first = getFontOptions({ fontDirs: [fontsDir], platform: 'linux' });

        writeFont('Second.ttf', { family: 'Second Font' });
        expect(getFontOptions({ fontDirs: [fontsDir], platform: 'linux' })).toBe(first);

        clearFontOptionsCache();
        expect(
            getFontOptions({ fontDirs: [fontsDir], platform: 'linux' }).map(
                (option) => option.familyName,
            ),
        ).toEqual(['First Font', 'Second Font']);
    });
});

describe('resolveFontFileToken 安全校验', () => {
    it('只允许访问字体目录内的 ttf/otf/ttc/otc 文件', () => {
        const fontPath = writeFont('Regular.ttf', { family: 'Token Font' });
        const token = encodeFontFileToken(fontPath);

        expect(resolveFontFileToken(token, [fontsDir])).toBe(fs.realpathSync(fontPath));

        const outsidePath = path.join(tempRoot, 'outside.ttf');
        fs.writeFileSync(outsidePath, buildTestFont({ family: 'Outside' }));
        expect(resolveFontFileToken(encodeFontFileToken(outsidePath), [fontsDir])).toBeNull();

        const textPath = path.join(fontsDir, 'note.txt');
        fs.writeFileSync(textPath, 'hello');
        expect(resolveFontFileToken(encodeFontFileToken(textPath), [fontsDir])).toBeNull();

        expect(
            resolveFontFileToken(encodeFontFileToken(path.join(fontsDir, 'missing.ttf')), [
                fontsDir,
            ]),
        ).toBeNull();
        expect(resolveFontFileToken('not-a-token', [fontsDir])).toBeNull();
        expect(resolveFontFileToken('', [fontsDir])).toBeNull();
    });
});

describe('getSystemFontDirs', () => {
    it('按平台返回系统字体目录', () => {
        const win32Dirs = getSystemFontDirs({
            platform: 'win32',
            env: { WINDIR: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
            home: 'C:\\Users\\x',
        });
        expect(win32Dirs).toHaveLength(2);
        expect(win32Dirs[0]).toMatch(/Fonts$/);
        expect(win32Dirs[1]).toMatch(/Fonts$/);

        const macDirs = getSystemFontDirs({ platform: 'darwin', home: '/Users/x' });
        expect(macDirs).toContain('/System/Library/Fonts');
        expect(macDirs).toContain('/Users/x/Library/Fonts');

        const linuxDirs = getSystemFontDirs({ platform: 'linux', home: '/home/x' });
        expect(linuxDirs).toContain('/usr/share/fonts');
        expect(linuxDirs).toContain('/home/x/.local/share/fonts');

        expect(getSystemFontDirs({ fontDirs: ['/a', '/a', '/b'] })).toEqual(['/a', '/b']);
    });
});
