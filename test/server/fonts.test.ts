import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { getFontOptions, readFontFamilyName } from '../../server/utils/fonts';

const projectRoot = process.cwd();
const fontsDir = path.join(projectRoot, 'public', 'fonts');
const TTF_FILE_NAME = 'FZFWZhuZiAYuanJWB.TTF';
const TTC_FILE_NAME = 'TsukushiAMaruGothic.ttc';

const readFontBuffer = (fileName: string): Buffer => fs.readFileSync(path.join(fontsDir, fileName));

let tempRoot: string;

beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'livesubtitle-fonts-'));
});

afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('readFontFamilyName 真实字体', () => {
    it('解析 TTF 的 name 表并返回 Windows 英文族名', () => {
        expect(readFontFamilyName(readFontBuffer(TTF_FILE_NAME))).toBe('FZFW ZhuZi A YuanS');
    });

    it('解析 TTC 并取第一个字体的族名', () => {
        expect(readFontFamilyName(readFontBuffer(TTC_FILE_NAME))).toBe('Tsukushi A Round Gothic');
    });
});

describe('readFontFamilyName 容错', () => {
    it('非字体数据返回 null 且不抛异常', () => {
        expect(readFontFamilyName(Buffer.alloc(0))).toBeNull();
        expect(readFontFamilyName(Buffer.from('not a font file', 'utf8'))).toBeNull();
        expect(
            readFontFamilyName(Buffer.from([0x74, 0x74, 0x63, 0x66, 0x00, 0x02, 0x00, 0x00])),
        ).toBeNull();

        // 'ttcf' 头但 numFonts 为 0
        const emptyTtc = Buffer.alloc(12);
        emptyTtc.write('ttcf', 0, 'latin1');
        emptyTtc.writeUInt32BE(0, 8);
        expect(readFontFamilyName(emptyTtc)).toBeNull();
    });

    it('截断的字体数据返回 null', () => {
        const ttfBuffer = readFontBuffer(TTF_FILE_NAME);

        expect(readFontFamilyName(ttfBuffer.subarray(0, 4))).toBeNull();
        expect(readFontFamilyName(ttfBuffer.subarray(0, 12))).toBeNull();
        expect(readFontFamilyName(ttfBuffer.subarray(0, 64))).toBeNull();
        expect(readFontFamilyName(ttfBuffer.subarray(0, 200))).toBeNull();
    });

    it('任意二进制数据都不会抛异常', () => {
        const randomBuffer = Buffer.from(
            Array.from({ length: 512 }, (_value, index) => (index * 37 + 11) % 256),
        );

        expect(() => readFontFamilyName(randomBuffer)).not.toThrow();
        expect(readFontFamilyName(randomBuffer)).toBeNull();
    });
});

describe('getFontOptions 字体选项', () => {
    it('从项目根目录返回 public/fonts 中的真实字体，按文件名排序', () => {
        const expectedFileNames = fs
            .readdirSync(fontsDir)
            .filter((fileName) => /\.(ttf|otf|ttc)$/i.test(fileName))
            .sort();

        const options = getFontOptions(projectRoot);

        expect(options.map((option) => option.fileName)).toEqual(expectedFileNames);
        expect(expectedFileNames.length).toBeGreaterThanOrEqual(2);

        expect(options.find((option) => option.fileName === TTF_FILE_NAME)).toEqual({
            fileName: TTF_FILE_NAME,
            familyName: 'FZFW ZhuZi A YuanS',
            url: `/fonts/${TTF_FILE_NAME}`,
        });
        expect(options.find((option) => option.fileName === TTC_FILE_NAME)).toEqual({
            fileName: TTC_FILE_NAME,
            familyName: 'Tsukushi A Round Gothic',
            url: `/fonts/${TTC_FILE_NAME}`,
        });

        // 同一字体族的多个字重使用相同 familyName，由控制端用文件名区分。
        // 仓库内置 GenSenRounded2PJP 的多个字重，可直接断言；
        // HarmonyOS Sans SC 等本机字体只在放入 public/fonts 时额外校验，
        // 避免测试依赖开发者本地的字体文件。
        const genSenOptions = options.filter((option) =>
            option.fileName.startsWith('GenSenRounded2PJP-'),
        );
        expect(genSenOptions.length).toBeGreaterThan(1);
        expect(new Set(genSenOptions.map((option) => option.familyName))).toEqual(
            new Set(['GenSenRounded2 PJP']),
        );

        const harmonyOptions = options.filter((option) =>
            option.fileName.startsWith('HarmonyOS_Sans_SC_'),
        );
        if (harmonyOptions.length > 0) {
            expect(
                harmonyOptions.every((option) => option.familyName === 'HarmonyOS Sans SC'),
            ).toBe(true);
        }

        expect(options.every((option) => option.url === `/fonts/${option.fileName}`)).toBe(true);
    });

    it('临时空目录返回空数组', () => {
        // 没有 public/fonts 目录
        expect(getFontOptions(tempRoot)).toEqual([]);

        // 有空的 public/fonts 目录
        fs.mkdirSync(path.join(tempRoot, 'public', 'fonts'), { recursive: true });
        expect(getFontOptions(tempRoot)).toEqual([]);
    });

    it('无法解析的字体回退为去掉扩展名的文件名，非 ttf/otf/ttc 被忽略', () => {
        const fontsPath = path.join(tempRoot, 'public', 'fonts');
        fs.mkdirSync(fontsPath, { recursive: true });
        fs.writeFileSync(path.join(fontsPath, 'Broken.ttf'), Buffer.from('garbage data'));
        fs.writeFileSync(path.join(fontsPath, 'Fake.OTF'), Buffer.from('garbage data'));
        fs.writeFileSync(path.join(fontsPath, 'Ignored.woff2'), Buffer.from('garbage data'));
        fs.writeFileSync(path.join(fontsPath, 'Ignored.txt'), 'hello');

        const options = getFontOptions(tempRoot);

        expect(options).toHaveLength(2);
        expect(options.map((option) => option.fileName)).toEqual(['Broken.ttf', 'Fake.OTF']);
        expect(options[0]).toEqual({
            fileName: 'Broken.ttf',
            familyName: 'Broken',
            url: '/fonts/Broken.ttf',
        });
        expect(options[1]!.familyName).toBe('Fake');
    });
});
