import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import {
    readAllSubtitleFiles,
    readAssFile,
    readFilterConfig,
    resolveSubtitleFilesDir,
} from '../../server/utils/subtitle';

const V4_PLUS_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H009C46A5,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,2,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const SSA_V4_HEADER = `[Script Info]
ScriptType: v4.00

[V4 Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H009C46A5,&H00000000,-1,0,1,3,0,2,0,0,0,1

[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

function dialogueLine(layer: number, start: string, end: string, text: string): string {
    return `Dialogue: ${layer},${start},${end},Default,,0,0,0,,${text}`;
}

function createV4PlusAss(dialogueLines: string[]): string {
    return `${V4_PLUS_HEADER}${dialogueLines.join('\n')}${dialogueLines.length > 0 ? '\n' : ''}`;
}

function createSsaV4Ass(dialogueLines: string[]): string {
    return `${SSA_V4_HEADER}${dialogueLines.join('\n')}${dialogueLines.length > 0 ? '\n' : ''}`;
}

function encodeUtf16LeWithBom(content: string): Buffer {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]);
}

function encodeGbk(text: string): Buffer {
    // 仅用于测试的固定 GBK 字节表
    const gbkBytes: Record<string, number[]> = {
        中: [0xd6, 0xd0],
        文: [0xce, 0xc4],
        字: [0xd7, 0xd6],
        幕: [0xc4, 0xbb],
        你: [0xc4, 0xe3],
        好: [0xba, 0xc3],
    };

    const bytes: number[] = [];
    for (const char of text) {
        const encoded = gbkBytes[char];
        if (!encoded) {
            bytes.push(...Buffer.from(char, 'utf8'));
        } else {
            bytes.push(...encoded);
        }
    }
    return Buffer.from(bytes);
}

let rootDir: string;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function createRootDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livesubtitle-generic-'));
    fs.mkdirSync(path.join(dir, 'subtitleFiles'), { recursive: true });
    return dir;
}

function writeFixture(relativePath: string, content: string | Buffer): string {
    const filePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
}

beforeEach(() => {
    rootDir = createRootDir();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('readAllSubtitleFiles 通用 ASS/SSA 回退', () => {
    it('没有 config.txt 时识别任意文件名的 ASS', () => {
        writeFixture(
            'subtitleFiles/Only Ass/任意名字.ass',
            createV4PlusAss([
                dialogueLine(0, '0:00:01.00', '0:00:02.50', '第一句'),
                dialogueLine(0, '0:00:03.00', '0:00:04.00', '第二句'),
            ]),
        );

        const files = readAllSubtitleFiles(rootDir);

        expect(files).toHaveLength(1);
        const file = files[0]!;
        expect(file.id).toBe('Only Ass');
        expect(file.name).toBe('Only Ass');
        expect(file.blocks).toHaveLength(2);
        expect(file.blocks[0]!.id).toBe('Only Ass-1');
        expect(file.blocks[0]!.text).toBe('第一句');
        expect(file.blocks[0]!.track).toBe(1);
        expect(file.duration).toBe(4);
        expect(new Date(file.createdAt).getTime()).not.toBeNaN();
        expect(new Date(file.updatedAt).getTime()).not.toBeNaN();
    });

    it('subtitle.ass 优先于其它 *.ass', () => {
        writeFixture(
            'subtitleFiles/priority/subtitle.ass',
            createV4PlusAss([dialogueLine(0, '0:00:01.00', '0:00:02.00', '来自 subtitle.ass')]),
        );
        writeFixture(
            'subtitleFiles/priority/zzz.ass',
            createV4PlusAss([dialogueLine(0, '0:00:01.00', '0:00:02.00', '来自 zzz.ass')]),
        );

        const files = readAllSubtitleFiles(rootDir);
        expect(files[0]!.blocks[0]!.text).toBe('来自 subtitle.ass');
    });

    it('没有 subtitle.ass 时其它 *.ass 按文件名排序选取', () => {
        writeFixture(
            'subtitleFiles/sorted/zzz.ass',
            createV4PlusAss([dialogueLine(0, '0:00:01.00', '0:00:02.00', '来自 zzz.ass')]),
        );
        writeFixture(
            'subtitleFiles/sorted/aaa.ass',
            createV4PlusAss([dialogueLine(0, '0:00:01.00', '0:00:02.00', '来自 aaa.ass')]),
        );

        const files = readAllSubtitleFiles(rootDir);
        expect(files[0]!.blocks[0]!.text).toBe('来自 aaa.ass');
    });

    it('识别任意文件名的 SSA v4 并按 Marked 映射轨道', () => {
        writeFixture(
            'subtitleFiles/ssa-song/lyrics.ssa',
            createSsaV4Ass([
                'Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,SSA 普通',
                'Dialogue: Marked=1,0:00:03.00,0:00:04.00,Default,,0,0,0,,SSA 轨道 2',
            ]),
        );

        const files = readAllSubtitleFiles(rootDir);
        expect(files).toHaveLength(1);
        expect(files[0]!.blocks).toHaveLength(2);
        expect(files[0]!.blocks[0]!.track).toBe(1);
        expect(files[0]!.blocks[1]!.track).toBe(2);
        expect(files[0]!.duration).toBe(4);
    });

    it('config.txt 存在时优先使用 config（原有行为）', () => {
        writeFixture(
            'subtitleFiles/config-first/config.txt',
            '1,0:00:01.00,0:00:02.00,配置文本一\n2,0:00:03.00,0:00:05.00,配置文本二\n',
        );
        writeFixture(
            'subtitleFiles/config-first/subtitle.ass',
            createV4PlusAss([dialogueLine(0, '0:00:01.00', '0:00:02.00', 'ASS 文本')]),
        );

        const files = readAllSubtitleFiles(rootDir);
        expect(files).toHaveLength(1);
        expect(files[0]!.blocks).toHaveLength(2);
        expect(files[0]!.blocks[0]!.text).toBe('配置文本一');
        expect(files[0]!.blocks[0]!.id).toBe('config-first-1');
        expect(files[0]!.duration).toBe(5);
    });

    it('config.txt 解析不到 block 时回退 ASS', () => {
        writeFixture('subtitleFiles/fallback/config.txt', '这不是有效配置\n\n');
        writeFixture(
            'subtitleFiles/fallback/subtitle.ass',
            createV4PlusAss([dialogueLine(0, '0:00:01.00', '0:00:02.00', '回退的 ASS')]),
        );

        const files = readAllSubtitleFiles(rootDir);
        expect(files).toHaveLength(1);
        expect(files[0]!.blocks[0]!.text).toBe('回退的 ASS');
    });

    it('空 config 与无事件的 ASS 都不产生字幕时跳过目录', () => {
        writeFixture('subtitleFiles/empty-config/config.txt', '');
        writeFixture('subtitleFiles/empty-config/subtitle.ass', createV4PlusAss([]));
        writeFixture('subtitleFiles/comments-only/subtitle.ass', `${V4_PLUS_HEADER}`);
        writeFixture('subtitleFiles/only-text/lyrics.txt', '只有歌词文本');
        fs.mkdirSync(path.join(rootDir, 'subtitleFiles', 'empty-dir'), { recursive: true });

        expect(readAllSubtitleFiles(rootDir)).toEqual([]);
    });

    it('subtitle.ass 无有效事件时回退到其它 ASS 文件', () => {
        writeFixture(
            'subtitleFiles/broken-subtitle/subtitle.ass',
            '[Script Info]\nTitle: 空文件\n',
        );
        writeFixture(
            'subtitleFiles/broken-subtitle/valid.ass',
            createV4PlusAss([dialogueLine(0, '0:00:01.00', '0:00:02.00', '有效字幕')]),
        );

        const files = readAllSubtitleFiles(rootDir);
        expect(files).toHaveLength(1);
        expect(files[0]!.blocks[0]!.text).toBe('有效字幕');
    });

    it('duration 等于最大 endTime，事件按开始时间排序', () => {
        writeFixture(
            'subtitleFiles/duration-song/subtitle.ass',
            createV4PlusAss([
                dialogueLine(0, '0:00:05.00', '0:00:06.50', '第二句'),
                dialogueLine(0, '0:00:01.00', '0:00:02.25', '第一句'),
                dialogueLine(0, '0:00:08.00', '0:00:10.25', '第三句'),
            ]),
        );

        const files = readAllSubtitleFiles(rootDir);
        const file = files[0]!;
        expect(file.duration).toBe(10.25);
        expect(file.blocks.map((block) => block.text)).toEqual(['第一句', '第二句', '第三句']);
        expect(file.blocks.map((block) => block.startTime)).toEqual([1, 5, 8]);
    });

    it('UTF-16LE BOM 与 UTF-8 BOM 文件都能被识别', () => {
        writeFixture(
            'subtitleFiles/utf16-song/subtitle.ass',
            encodeUtf16LeWithBom(
                createV4PlusAss([dialogueLine(0, '0:00:01.00', '0:00:02.00', 'UTF-16 文本')]),
            ),
        );
        writeFixture(
            'subtitleFiles/utf8-bom-song/subtitle.ass',
            Buffer.concat([
                Buffer.from([0xef, 0xbb, 0xbf]),
                Buffer.from(
                    createV4PlusAss([
                        dialogueLine(0, '0:00:01.00', '0:00:02.00', 'UTF-8 BOM 文本'),
                    ]),
                    'utf8',
                ),
            ]),
        );

        const files = readAllSubtitleFiles(rootDir);
        const byId = new Map(files.map((file) => [file.id, file]));
        expect(byId.get('utf16-song')!.blocks[0]!.text).toBe('UTF-16 文本');
        expect(byId.get('utf8-bom-song')!.blocks[0]!.text).toBe('UTF-8 BOM 文本');
    });

    it('同时扫描多个歌曲目录，忽略 subtitleFiles 根下的配置文件', () => {
        writeFixture(
            'subtitleFiles/alpha/subtitle.ass',
            createV4PlusAss([dialogueLine(0, '0:00:01.00', '0:00:02.00', 'alpha')]),
        );
        writeFixture(
            'subtitleFiles/beta/subtitle.ass',
            createV4PlusAss([dialogueLine(0, '0:00:01.00', '0:00:02.00', 'beta')]),
        );
        writeFixture('subtitleFiles/filter-config.json', '[]');

        const files = readAllSubtitleFiles(rootDir);
        const ids = files.map((file) => file.id).sort();
        expect(ids).toEqual(['alpha', 'beta']);
    });

    it('subtitleFiles 目录不存在时返回空数组', () => {
        fs.rmSync(path.join(rootDir, 'subtitleFiles'), { recursive: true, force: true });

        expect(readAllSubtitleFiles(rootDir)).toEqual([]);
    });
});

describe('readAssFile 查找与解码', () => {
    it('返回 subtitle.ass 解码后的原始内容', () => {
        const assContent = createV4PlusAss([
            dialogueLine(0, '0:00:01.00', '0:00:02.00', '读取内容'),
        ]);
        writeFixture('subtitleFiles/read-ass/subtitle.ass', assContent);

        const content = readAssFile('read-ass', rootDir);
        expect(content).toBe(assContent);
        expect(content).toContain('[Script Info]');
        expect(content).toContain('[Events]');
    });

    it('没有 subtitle.ass 时按同名规则查找其它 ASS/SSA', () => {
        writeFixture(
            'subtitleFiles/other-name/我的字幕.ass',
            createV4PlusAss([dialogueLine(0, '0:00:01.00', '0:00:02.00', '任意文件名')]),
        );
        writeFixture(
            'subtitleFiles/ssa-only/subtitle.ssa',
            createSsaV4Ass(['Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,SSA 内容']),
        );

        expect(readAssFile('other-name', rootDir)).toContain('任意文件名');
        expect(readAssFile('ssa-only', rootDir)).toContain('SSA 内容');
    });

    it('subtitle.ass 无有效事件时读取其它 ASS 文件', () => {
        writeFixture('subtitleFiles/try-next/subtitle.ass', '[Script Info]\nTitle: 空\n');
        writeFixture(
            'subtitleFiles/try-next/valid.ass',
            createV4PlusAss([dialogueLine(0, '0:00:01.00', '0:00:02.00', '下一个文件')]),
        );

        expect(readAssFile('try-next', rootDir)).toContain('下一个文件');
    });

    it('正确解码 UTF-16LE BOM 文件', () => {
        writeFixture(
            'subtitleFiles/utf16-read/subtitle.ass',
            encodeUtf16LeWithBom(
                createV4PlusAss([dialogueLine(0, '0:00:01.00', '0:00:02.00', 'UTF-16 读取')]),
            ),
        );

        const content = readAssFile('utf16-read', rootDir);
        expect(content).not.toBeNull();
        expect(content!.startsWith('\uFEFF')).toBe(false);
        expect(content).toContain('UTF-16 读取');
    });

    it('正确解码 GBK 文件', () => {
        const prefix = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname
Style: Default,Arial

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,`;
        writeFixture(
            'subtitleFiles/gbk-song/subtitle.ass',
            Buffer.concat([Buffer.from(prefix, 'utf8'), encodeGbk('中文字幕')]),
        );

        expect(readAssFile('gbk-song', rootDir)).toContain('中文字幕');
        const files = readAllSubtitleFiles(rootDir);
        expect(files[0]!.blocks[0]!.text).toBe('中文字幕');
    });

    it('找不到字幕文件时返回 null', () => {
        writeFixture('subtitleFiles/config-only/config.txt', '1,0:00:01.00,0:00:02.00,仅配置\n');

        expect(readAssFile('config-only', rootDir)).toBeNull();
        expect(readAssFile('non-existing-song', rootDir)).toBeNull();
    });
});

describe('其它工具函数的 rootDir 参数', () => {
    it('readFilterConfig 从指定根目录读取过滤器配置', () => {
        writeFixture(
            'subtitleFiles/filter-config.json',
            JSON.stringify([{ name: '测试筛选', type: 'unit', songs: ['歌一'] }]),
        );

        const config = readFilterConfig(rootDir);
        expect(config).toHaveLength(1);
        expect(config[0]!.name).toBe('测试筛选');
        expect(config[0]!.songs).toEqual(['歌一']);
    });

    it('readFilterConfig 对缺失或非法 JSON 返回空数组', () => {
        expect(readFilterConfig(rootDir)).toEqual([]);

        writeFixture('subtitleFiles/filter-config.json', '{ not valid json');
        expect(readFilterConfig(rootDir)).toEqual([]);
    });

    it('优先解析编译产物下的 .output/subtitleFiles', () => {
        const projectDir = path.join(rootDir, 'project');
        const outputSubtitles = path.join(projectDir, '.output', 'subtitleFiles');
        fs.mkdirSync(outputSubtitles, { recursive: true });

        expect(
            resolveSubtitleFilesDir({ cwd: projectDir, moduleDir: projectDir, entryPath: '' }),
        ).toBe(outputSubtitles);

        // 服务从其它 cwd 启动时，仍能按服务端模块位置找到 .output/subtitleFiles
        const elsewhere = path.join(rootDir, 'elsewhere');
        fs.mkdirSync(elsewhere, { recursive: true });
        expect(
            resolveSubtitleFilesDir({
                cwd: elsewhere,
                moduleDir: path.join(projectDir, 'server', 'chunks'),
                entryPath: '',
            }),
        ).toBe(outputSubtitles);

        // 直接从 .output 内启动
        expect(
            resolveSubtitleFilesDir({
                cwd: path.join(projectDir, '.output'),
                moduleDir: '',
                entryPath: '',
            }),
        ).toBe(outputSubtitles);

        // 没有编译产物时回退到 <cwd>/subtitleFiles
        const plainDir = path.join(rootDir, 'plain');
        fs.mkdirSync(plainDir, { recursive: true });
        expect(resolveSubtitleFilesDir({ cwd: plainDir, moduleDir: plainDir, entryPath: '' })).toBe(
            path.join(plainDir, 'subtitleFiles'),
        );

        // 环境变量可覆盖
        const customDir = path.join(rootDir, 'custom-subtitles');
        fs.mkdirSync(customDir, { recursive: true });
        expect(
            resolveSubtitleFilesDir({
                cwd: plainDir,
                moduleDir: plainDir,
                entryPath: '',
                envDir: customDir,
            }),
        ).toBe(customDir);
    });

    it('不传 rootDir 时解析编译产物字幕目录', () => {
        expect(Array.isArray(readAllSubtitleFiles())).toBe(true);
        expect(Array.isArray(readFilterConfig())).toBe(true);
        expect(readAssFile('non-existing-song-for-compat')).toBeNull();
    });
});
