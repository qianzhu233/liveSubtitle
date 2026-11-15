import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
    appendFilterConfig,
    buildAss,
    buildConfigTxt,
    buildLyricsTxt,
    buildTimeline,
    detectDominantLanguage,
    detectLanguage,
    formatTimestamp,
    pairTranslations,
    parseLrc,
    runCli,
} from '../../scripts/lrc2subtitle.js';

const fixtureDir = fileURLToPath(new URL('../fixtures/lrc/', import.meta.url));

const readFixture = (fileName: string): string =>
    fs.readFileSync(path.join(fixtureDir, fileName), 'utf-8');

const tempDirs: string[] = [];

const makeTempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrc2subtitle-'));
    tempDirs.push(dir);
    return dir;
};

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

type FilterEntry = { name: string; type: string; songs: string[] };

const readFilterConfig = (filePath: string): FilterEntry[] =>
    JSON.parse(fs.readFileSync(filePath, 'utf-8')) as FilterEntry[];

type CliCapture = {
    stdout: string[];
    stderr: string[];
    io: {
        cwd: string;
        stdout: (text: string) => void;
        stderr: (text: string) => void;
    };
};

const captureCli = (cwd: string): CliCapture => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
        stdout,
        stderr,
        io: {
            cwd,
            stdout: (text) => {
                stdout.push(text);
            },
            stderr: (text) => {
                stderr.push(text);
            },
        },
    };
};

/** basic.lrc 与 basic.zh.lrc 配对、建好时间轴的字幕块 */
const buildBasicBlocks = () => {
    const primary = parseLrc(readFixture('basic.lrc'));
    const translation = parseLrc(readFixture('basic.zh.lrc'));
    return buildTimeline(pairTranslations(primary.lines, translation.lines).lines).lines;
};

describe('formatTimestamp', () => {
    it('输出 H:MM:SS.CC 格式', () => {
        expect(formatTimestamp(0)).toBe('0:00:00.00');
        expect(formatTimestamp(500)).toBe('0:00:00.50');
        expect(formatTimestamp(7210)).toBe('0:00:07.21');
        expect(formatTimestamp(3723456)).toBe('1:02:03.46');
        expect(formatTimestamp(36000000)).toBe('10:00:00.00');
    });

    it('负数与非法值按 0 处理', () => {
        expect(formatTimestamp(-100)).toBe('0:00:00.00');
        expect(formatTimestamp(Number.NaN)).toBe('0:00:00.00');
    });
});

describe('parseLrc', () => {
    it('解析元数据与基础歌词行', () => {
        const parsed = parseLrc(readFixture('basic.lrc'));
        expect(parsed.metadata.title).toBe('始まりは君の空');
        expect(parsed.metadata.artist).toBe('Liella!');
        expect(parsed.metadata.album).toBe('始まりは君の空');
        expect(parsed.metadata.by).toBe('依然洳雪');
        expect(parsed.metadata.raw.al).toBe('始まりは君の空');
        expect(parsed.lines).toHaveLength(5);
        expect(parsed.lines[0]?.startMs).toBe(500);
        expect(parsed.lines[0]?.text).toBe('なにか目覚めそうだよ');
    });

    it('一行多个时间戳展开为多行并按时间排序', () => {
        const parsed = parseLrc('[00:05.00]后\n[00:01.00][00:03.00]前');
        expect(parsed.lines.map((line) => line.startMs)).toEqual([1000, 3000, 5000]);
        expect(parsed.lines.filter((line) => line.text === '前')).toHaveLength(2);
    });

    it('解析增强型词时间戳并从正文中剥离标签', () => {
        const parsed = parseLrc(readFixture('basic.lrc'));
        const enhanced = parsed.lines.find((line) => line.startMs === 5000);
        expect(enhanced).toBeDefined();
        expect(enhanced?.text).toBe('まだ名もないキモチが');
        expect(enhanced?.words.map((word) => word.timeMs)).toEqual([5000, 5400]);
        expect(enhanced?.words[0]?.text).toBe('まだ名もない');
    });

    it('支持 [offset:] 元数据与 --offset-ms 叠加，负时间截断为 0', () => {
        const parsed = parseLrc(readFixture('offset.lrc'));
        expect(parsed.metadata.offsetMs).toBe(500);
        expect(parsed.metadata.lengthMs).toBe(10000);
        expect(parsed.lines.map((line) => line.startMs)).toEqual([1500, 8500]);

        const shifted = parseLrc('[offset:500]\n[00:01.00]歌词', { offsetMs: -2000 });
        expect(shifted.lines[0]?.startMs).toBe(0);
        expect(shifted.warnings.some((warning) => warning.includes('负数'))).toBe(true);
    });

    it('忽略空行、无时间戳行与空文本行', () => {
        const parsed = parseLrc('\n[00:01.00]\n没有时间戳的行\n[00:02.00]有效行\n');
        expect(parsed.lines).toHaveLength(1);
        expect(parsed.lines[0]?.text).toBe('有效行');
    });

    it('无法解析的 [offset:]/[length:] 给出提示', () => {
        const parsed = parseLrc('[offset:abc]\n[length:??]\n[00:01.00]行');
        expect(parsed.metadata.offsetMs).toBe(0);
        expect(parsed.metadata.lengthMs).toBe(0);
        expect(parsed.warnings).toHaveLength(2);
        expect(parsed.warnings.some((warning) => warning.includes('[offset:'))).toBe(true);
        expect(parsed.warnings.some((warning) => warning.includes('[length:'))).toBe(true);
    });

    it('支持 H:MM:SS.CC 形式的时间标签', () => {
        const parsed = parseLrc('[1:02:03.45]长时间');
        expect(parsed.lines[0]?.startMs).toBe(3723450);
    });
});

describe('pairTranslations', () => {
    it('按时间戳配对，允许 100ms 容差', () => {
        const primary = parseLrc(readFixture('basic.lrc'));
        const translation = parseLrc(readFixture('basic.zh.lrc'));
        const paired = pairTranslations(primary.lines, translation.lines);
        expect(paired.matchedCount).toBe(5);
        expect(paired.unusedTranslationCount).toBe(0);
        expect(paired.lines[0]?.translation).toBe('似乎有什么就要觉醒');
        expect(paired.lines[1]?.translation).toBe('同样的话说两遍');
        expect(paired.warnings).toHaveLength(0);
    });

    it('超出容差不匹配并给出提示', () => {
        const paired = pairTranslations(
            parseLrc('[00:01.00]原文').lines,
            parseLrc('[00:05.00]译文').lines,
        );
        expect(paired.matchedCount).toBe(0);
        expect(paired.lines[0]?.translation).toBe('');
        expect(paired.warnings.length).toBeGreaterThan(0);
    });

    it('容差可配置', () => {
        const paired = pairTranslations(
            parseLrc('[00:01.00]原文').lines,
            parseLrc('[00:01.03]译文').lines,
            { toleranceMs: 0 },
        );
        expect(paired.matchedCount).toBe(0);
        expect(paired.unusedTranslationCount).toBe(1);
    });
});

describe('buildTimeline', () => {
    it('结束时间 = 下一行开始时间，最后一行 = 开始 + 5 秒', () => {
        const timeline = buildTimeline(parseLrc(readFixture('basic.lrc')).lines);
        expect(timeline.lines).toHaveLength(5);
        expect(timeline.lines[0]?.endMs).toBe(2000);
        expect(timeline.lines[2]?.endMs).toBe(5000);
        expect(timeline.lines[4]?.startMs).toBe(7200);
        expect(timeline.lines[4]?.endMs).toBe(12200);
        expect(timeline.warnings).toHaveLength(0);
    });

    it('时间戳重复时保证 end > start 并提示', () => {
        const timeline = buildTimeline([
            { startMs: 1000, text: '第一句' },
            { startMs: 1000, text: '第二句' },
        ]);
        expect(timeline.lines[0]?.endMs).toBe(1500);
        expect(timeline.lines[1]?.endMs).toBe(6000);
        expect(timeline.warnings.length).toBeGreaterThan(0);
    });

    it('超出 [length:] 歌曲时长时提示', () => {
        const timeline = buildTimeline(parseLrc(readFixture('offset.lrc')).lines, {
            lengthMs: 10000,
        });
        expect(timeline.warnings.some((warning) => warning.includes('超出'))).toBe(true);
    });
});

describe('buildConfigTxt', () => {
    it('生成 轨道,开始时间,结束时间,文本 格式', () => {
        const blocks = buildTimeline(parseLrc(readFixture('basic.lrc')).lines).lines;
        const lines = buildConfigTxt(blocks, { track: 2 }).trimEnd().split('\n');
        expect(lines).toHaveLength(5);
        expect(lines[0]).toBe('2,0:00:00.50,0:00:02.00,なにか目覚めそうだよ');
        expect(lines[2]).toBe('2,0:00:03.50,0:00:05.00,同じ言葉を二度');
        expect(lines[4]).toBe('2,0:00:07.20,0:00:12.20,コンマ, を含む行');
    });

    it('每行都符合 轨道,时间,时间,文本 结构且 end > start', () => {
        const blocks = buildTimeline(parseLrc(readFixture('basic.lrc')).lines).lines;
        const lines = buildConfigTxt(blocks).trimEnd().split('\n');
        for (const line of lines) {
            const parts = line.split(',');
            expect(parts.length).toBeGreaterThanOrEqual(4);
            expect(parts[0]).toBe('1');
            expect(parts[1]).toMatch(/^\d+:\d{2}:\d{2}\.\d{2}$/);
            expect(parts[2]).toMatch(/^\d+:\d{2}:\d{2}\.\d{2}$/);
            expect(parts[1] < parts[2]).toBe(true);
        }
    });

    it('非法轨道抛错', () => {
        expect(() => buildConfigTxt([], { track: 3 })).toThrow();
    });
});

describe('buildAss', () => {
    it('生成完整的 ASS 结构', () => {
        const ass = buildAss({ title: '始まりは君の空', blocks: buildBasicBlocks() });
        expect(ass).toContain('[Script Info]');
        expect(ass).toContain('ScriptType: v4.00+');
        expect(ass).toContain('PlayResX: 1920');
        expect(ass).toContain('PlayResY: 1080');
        expect(ass).toContain('[V4+ Styles]');
        expect(ass).toContain('Format: Name, Fontname, Fontsize, PrimaryColour');
        expect(ass).toContain('[Events]');
        expect(ass).toContain(
            'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        );
        expect(ass.endsWith('\n')).toBe(true);
    });

    it('沿用 lyrics2ass 的样式模板与默认 Liella 颜色', () => {
        const ass = buildAss({ title: 'test', blocks: buildBasicBlocks(), translationLang: 'zh' });
        expect(ass).toContain('Style: 日文-Liella,');
        expect(ass).toContain('Style: 日文-f-Liella,');
        expect(ass).toContain('Style: 日文-外-Liella,');
        expect(ass).toContain('Style: 中文-Liella,');
        expect(ass).toContain('Style: 日文-Kanon,');
        // #A5469C → ASS &H00BBGGRR
        expect(ass).toContain('&H009C46A5');
        expect(ass).toContain(',54,&H00FFFFFF,&H000000FF,&H009C46A5');
    });

    it('样式行连续排列（应用端颜色切换依赖该结构）', () => {
        const ass = buildAss({ title: 'test', blocks: buildBasicBlocks() });
        const stylesStart = ass.indexOf('[V4+ Styles]');
        const eventsStart = ass.indexOf('[Events]');
        const styleBlock = ass.slice(stylesStart, eventsStart).trimEnd();
        const physicalLines = styleBlock.split('\n');
        const firstStyleIndex = physicalLines.findIndex((line) => line.startsWith('Style: '));
        expect(firstStyleIndex).toBeGreaterThan(0);
        expect(
            physicalLines.slice(firstStyleIndex).every((line) => line.startsWith('Style: ')),
        ).toBe(true);
        expect(physicalLines[1]).toContain('Format: Name, Fontname');
    });

    it('Dialogue 行时间格式合法且位置标签符合规范', () => {
        const ass = buildAss({ title: 'test', blocks: buildBasicBlocks(), translationLang: 'zh' });
        const dialogues = ass.split('\n').filter((line) => line.startsWith('Dialogue: '));
        expect(dialogues).toHaveLength(10);
        for (const line of dialogues) {
            expect(line).toMatch(
                /^Dialogue: 0,\d+:\d{2}:\d{2}\.\d{2},\d+:\d{2}:\d{2}\.\d{2},(中文|日文)-Liella,,\d+,\d+,\d+,,\{\\fad\(200,200\)\\pos\(960,(1020|1075)\)\}/,
            );
        }
        expect(ass).toContain(
            'Dialogue: 0,0:00:00.50,0:00:02.00,日文-Liella,,0,0,0,,{\\fad(200,200)\\pos(960,1075)}なにか目覚めそうだよ',
        );
        expect(ass).toContain(
            'Dialogue: 0,0:00:00.50,0:00:02.00,中文-Liella,,0,0,0,,{\\fad(200,200)\\pos(960,1020)}似乎有什么就要觉醒',
        );
    });

    it('支持自定义颜色与字体', () => {
        const ass = buildAss({
            title: 'test',
            blocks: buildBasicBlocks(),
            translationLang: 'zh',
            color: '#123456',
            fontJa: 'CustomJa',
            fontZh: 'CustomZh',
        });
        expect(ass).toContain('&H00563412');
        expect(ass).toContain('Style: 日文-Liella,CustomJa,54,');
        expect(ass).toContain('Style: 中文-Liella,CustomZh,64,');
    });

    it('无翻译时只生成原文：单语 Dialogue 与单一语言样式', () => {
        const blocks = buildTimeline(parseLrc(readFixture('basic.lrc')).lines).lines;
        const ass = buildAss({ title: 'test', blocks });
        expect(ass.split('\n').filter((line) => line.startsWith('Dialogue: '))).toHaveLength(5);
        expect(ass).toContain('Style: 日文-Liella,');
        expect(ass).not.toContain('Style: 中文-');
        expect(ass).not.toContain('pos(960,1020)');
    });

    it('--lang en 时生成英文样式并使用 1075 位置', () => {
        const blocks = buildBasicBlocks();
        const ass = buildAss({ title: 'test', blocks, lang: 'en', translationLang: 'zh' });
        expect(ass).toContain('Style: 英文-Liella,Arial,54,');
        expect(ass).toContain('pos(960,1075)');
        expect(ass).toContain('pos(960,1020)');
    });

    it('非法语言与颜色抛错', () => {
        const blocks = buildTimeline(parseLrc(readFixture('basic.lrc')).lines).lines;
        expect(() => buildAss({ title: 'test', blocks, lang: 'fr' })).toThrow();
        expect(() => buildAss({ title: 'test', blocks, color: 'red' })).toThrow();
    });
});

describe('buildLyricsTxt', () => {
    it('前 4 行为歌曲名/译者/来源/备注，之后为中文/日文成对歌词', () => {
        const lyrics = buildLyricsTxt({
            title: '始まりは君の空',
            translator: '依然洳雪',
            source: 'https://example.com/song',
            remark: '',
            blocks: buildBasicBlocks(),
            lang: 'ja',
            translationLang: 'zh',
        });
        const lines = lyrics.trimEnd().split('\n');
        expect(lines.slice(0, 4)).toEqual([
            '始まりは君の空',
            '依然洳雪',
            'https://example.com/song',
            '',
        ]);
        expect(lines[4]).toBe('似乎有什么就要觉醒');
        expect(lines[5]).toBe('なにか目覚めそうだよ');
        expect(lines).toHaveLength(14);
    });

    it('原文为中文时中文仍然在前', () => {
        const lyrics = buildLyricsTxt({
            title: 't',
            blocks: [{ text: '中文原文', translation: '日本語訳' }],
            lang: 'zh',
            translationLang: 'ja',
        });
        expect(lyrics.trimEnd().split('\n').slice(4)).toEqual(['中文原文', '日本語訳']);
    });
});

describe('appendFilterConfig', () => {
    it('创建 filter-config.json 并保持 4 空格缩进', () => {
        const outDir = makeTempDir();
        const result = appendFilterConfig(outDir, {
            name: '专辑A',
            type: 'album',
            songName: '歌曲1',
        });
        expect(result.created).toBe(true);
        expect(result.addedEntry).toBe(true);
        expect(result.changed).toBe(true);
        const raw = fs.readFileSync(result.path, 'utf-8');
        expect(raw).toBe(
            `${JSON.stringify([{ name: '专辑A', type: 'album', songs: ['歌曲1'] }], null, 4)}\n`,
        );
        expect(raw.startsWith('[\n    {')).toBe(true);
    });

    it('重复追加同一歌曲不会产生重复项', () => {
        const outDir = makeTempDir();
        appendFilterConfig(outDir, { name: '专辑A', type: 'album', songName: '歌曲1' });
        const second = appendFilterConfig(outDir, {
            name: '专辑A',
            type: 'album',
            songName: '歌曲1',
        });
        expect(second.changed).toBe(false);
        expect(readFilterConfig(second.path)[0]?.songs).toEqual(['歌曲1']);
    });

    it('向已有筛选器追加歌曲并保留其它配置', () => {
        const outDir = makeTempDir();
        const filePath = path.join(outDir, 'filter-config.json');
        fs.writeFileSync(
            filePath,
            JSON.stringify(
                [
                    { name: '专辑A', type: 'album', songs: ['歌曲1'] },
                    { name: '小组B', type: 'unit', songs: ['歌曲X'] },
                ],
                null,
                4,
            ),
        );
        const result = appendFilterConfig(outDir, {
            name: '专辑A',
            type: 'album',
            songName: '歌曲2',
        });
        expect(result.addedSong).toBe(true);
        const config = readFilterConfig(result.path);
        expect(config[0]?.songs).toEqual(['歌曲1', '歌曲2']);
        expect(config[1]).toEqual({ name: '小组B', type: 'unit', songs: ['歌曲X'] });
    });

    it('筛选器类型不同时保留原类型并提示', () => {
        const outDir = makeTempDir();
        appendFilterConfig(outDir, { name: '专辑A', type: 'album', songName: '歌曲1' });
        const result = appendFilterConfig(outDir, {
            name: '专辑A',
            type: 'live',
            songName: '歌曲2',
        });
        expect(result.typeMismatch).toBe(true);
        expect(result.warnings.length).toBeGreaterThan(0);
        const config = readFilterConfig(result.path);
        expect(config[0]?.type).toBe('album');
        expect(config[0]?.songs).toEqual(['歌曲1', '歌曲2']);
    });

    it('损坏的 filter-config.json 抛错且不覆盖原文件', () => {
        const outDir = makeTempDir();
        const filePath = path.join(outDir, 'filter-config.json');
        fs.writeFileSync(filePath, '{不是 JSON', 'utf-8');
        expect(() =>
            appendFilterConfig(outDir, { name: '专辑A', type: 'album', songName: '歌曲1' }),
        ).toThrow();
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('{不是 JSON');
    });
});

describe('runCli', () => {
    it('--help 打印用法并退出 0', () => {
        const capture = captureCli(process.cwd());
        expect(runCli(['--help'], capture.io)).toBe(0);
        const output = capture.stdout.join('');
        expect(output).toContain('用法:');
        expect(output).toContain('--translation');
        expect(output).toContain('--dry-run');
    });

    it('缺少输入或文件不存在时退出非 0', () => {
        const missingArg = captureCli(process.cwd());
        expect(runCli([], missingArg.io)).toBe(1);
        expect(missingArg.stderr.join('')).toContain('缺少输入');

        const missingFile = captureCli(process.cwd());
        expect(runCli([path.join(fixtureDir, '不存在.lrc')], missingFile.io)).toBe(1);
        expect(missingFile.stderr.join('')).toContain('找不到输入文件');
    });

    it('默认歌曲名取自 [ti:] 并生成 config.txt / subtitle.ass', () => {
        const outRoot = path.join(makeTempDir(), 'out');
        const capture = captureCli(process.cwd());
        const code = runCli([path.join(fixtureDir, 'basic.lrc'), '--out', outRoot], capture.io);
        expect(code).toBe(0);
        const songDir = path.join(outRoot, '始まりは君の空');
        const configText = fs.readFileSync(path.join(songDir, 'config.txt'), 'utf-8');
        const configLines = configText.trimEnd().split('\n');
        expect(configLines).toHaveLength(5);
        expect(configLines[0]).toBe('1,0:00:00.50,0:00:02.00,なにか目覚めそうだよ');
        const ass = fs.readFileSync(path.join(songDir, 'subtitle.ass'), 'utf-8');
        expect(ass).toContain('Style: 日文-Liella,');
        expect(ass).toContain('pos(960,1075)');
        expect(fs.existsSync(path.join(songDir, 'lyrics.txt'))).toBe(false);
        expect(capture.stdout.join('')).toContain('完成');
        expect(capture.stderr.join('')).toContain('自动识别原文语言: 日文');
    });

    it('提供 --translation 时生成双语 ASS 与 lyrics.txt', () => {
        const outRoot = path.join(makeTempDir(), 'out');
        const capture = captureCli(process.cwd());
        const code = runCli(
            [
                path.join(fixtureDir, 'basic.lrc'),
                '--out',
                outRoot,
                '--translation',
                path.join(fixtureDir, 'basic.zh.lrc'),
            ],
            capture.io,
        );
        expect(code).toBe(0);
        const songDir = path.join(outRoot, '始まりは君の空');
        const ass = fs.readFileSync(path.join(songDir, 'subtitle.ass'), 'utf-8');
        expect(ass).toContain('pos(960,1075)');
        expect(ass).toContain('pos(960,1020)');
        expect(ass.split('\n').filter((line) => line.startsWith('Dialogue: '))).toHaveLength(10);

        const lyrics = fs.readFileSync(path.join(songDir, 'lyrics.txt'), 'utf-8');
        const lyricLines = lyrics.trimEnd().split('\n');
        expect(lyricLines.slice(0, 2)).toEqual(['始まりは君の空', '依然洳雪']);
        expect(lyricLines[4]).toBe('似乎有什么就要觉醒');
        expect(lyricLines[5]).toBe('なにか目覚めそうだよ');
        expect(capture.stdout.join('')).toContain('5 行翻译配对');
        const stderr = capture.stderr.join('');
        expect(stderr).toContain('已提供 --translation，跳过单文件自动配对');
        expect(stderr).toContain('自动识别原文语言: 日文');
        expect(stderr).toContain('自动识别翻译语言: 中文');
        expect(stderr).not.toContain('自动配对 ');
    });

    it('--offset-ms 同时应用于原文与翻译文件并保持配对', () => {
        const outRoot = path.join(makeTempDir(), 'out');
        const capture = captureCli(process.cwd());
        const code = runCli(
            [
                path.join(fixtureDir, 'basic.lrc'),
                '--out',
                outRoot,
                '--translation',
                path.join(fixtureDir, 'basic.zh.lrc'),
                '--offset-ms',
                '100',
            ],
            capture.io,
        );
        expect(code).toBe(0);
        const songDir = path.join(outRoot, '始まりは君の空');
        const configText = fs.readFileSync(path.join(songDir, 'config.txt'), 'utf-8');
        expect(configText.split('\n')[0]).toBe('1,0:00:00.60,0:00:02.10,なにか目覚めそうだよ');
        const ass = fs.readFileSync(path.join(songDir, 'subtitle.ass'), 'utf-8');
        expect(ass.split('\n').filter((line) => line.startsWith('Dialogue: '))).toHaveLength(10);
        expect(capture.stdout.join('')).toContain('5 行翻译配对');
        expect(capture.stderr.join('')).not.toContain('没有匹配');
    });

    it('--track 2 写入轨道编号', () => {
        const outRoot = path.join(makeTempDir(), 'out');
        const capture = captureCli(process.cwd());
        const code = runCli(
            [path.join(fixtureDir, 'basic.lrc'), '--out', outRoot, '--track', '2'],
            capture.io,
        );
        expect(code).toBe(0);
        const configText = fs.readFileSync(
            path.join(outRoot, '始まりは君の空', 'config.txt'),
            'utf-8',
        );
        expect(configText.split('\n')[0]?.startsWith('2,')).toBe(true);
    });

    it('应用 [offset:] 与 [length:]：时间偏移生效并提示超出时长', () => {
        const outRoot = path.join(makeTempDir(), 'out');
        const capture = captureCli(process.cwd());
        const code = runCli([path.join(fixtureDir, 'offset.lrc'), '--out', outRoot], capture.io);
        expect(code).toBe(0);
        const configText = fs.readFileSync(path.join(outRoot, '偏移测试', 'config.txt'), 'utf-8');
        const configLines = configText.trimEnd().split('\n');
        expect(configLines[0]).toBe('1,0:00:01.50,0:00:08.50,偏移后的第一行');
        expect(configLines[1]).toBe('1,0:00:08.50,0:00:13.50,接近结尾');
        const ass = fs.readFileSync(path.join(outRoot, '偏移测试', 'subtitle.ass'), 'utf-8');
        expect(ass).toContain('Style: 中文-Liella,');
        expect(ass).toContain('pos(960,1020)}偏移后的第一行');
        const stderr = capture.stderr.join('');
        expect(stderr).toContain('超出');
        expect(stderr).toContain('自动识别原文语言: 中文');
    });

    it('输出目录已存在时非 0 退出，--force 覆盖且不删除其它文件', () => {
        const outRoot = path.join(makeTempDir(), 'out');
        const args = [path.join(fixtureDir, 'basic.lrc'), '--out', outRoot, '--name', '歌曲'];
        expect(runCli(args, captureCli(process.cwd()).io)).toBe(0);
        const songDir = path.join(outRoot, '歌曲');
        const extraFile = path.join(songDir, 'notes.txt');
        fs.writeFileSync(extraFile, '保留我', 'utf-8');

        const conflict = captureCli(process.cwd());
        expect(runCli(args, conflict.io)).toBe(1);
        expect(conflict.stderr.join('')).toContain('已存在');

        const forced = captureCli(process.cwd());
        expect(runCli([...args, '--force'], forced.io)).toBe(0);
        expect(fs.existsSync(extraFile)).toBe(true);
    });

    it('--dry-run 只打印清单、不写文件', () => {
        const outRoot = path.join(makeTempDir(), 'generated');
        const capture = captureCli(process.cwd());
        const code = runCli(
            [path.join(fixtureDir, 'basic.lrc'), '--out', outRoot, '--dry-run'],
            capture.io,
        );
        expect(code).toBe(0);
        expect(fs.existsSync(outRoot)).toBe(false);
        const output = capture.stdout.join('');
        expect(output).toContain('[dry-run]');
        expect(output).toContain('config.txt');
        expect(output).toContain('subtitle.ass');
    });

    it('--filter 写入 filter-config.json，重复运行不产生重复歌曲', () => {
        const outRoot = path.join(makeTempDir(), 'subtitleFiles');
        const args = [
            path.join(fixtureDir, 'basic.lrc'),
            '--out',
            outRoot,
            '--filter',
            '测试专辑',
            '--filter-type',
            'album',
        ];
        const first = captureCli(process.cwd());
        expect(runCli(args, first.io)).toBe(0);
        const configPath = path.join(outRoot, 'filter-config.json');
        const config = readFilterConfig(configPath);
        expect(config).toHaveLength(1);
        expect(config[0]).toEqual({
            name: '测试专辑',
            type: 'album',
            songs: ['始まりは君の空'],
        });
        expect(fs.readFileSync(configPath, 'utf-8').startsWith('[\n    {')).toBe(true);

        const second = captureCli(process.cwd());
        expect(runCli([...args, '--force'], second.io)).toBe(0);
        expect(readFilterConfig(configPath)[0]?.songs).toEqual(['始まりは君の空']);
        expect(second.stdout.join('')).toContain('保持');
    });

    it('非法参数组合与取值均退出非 0', () => {
        const basicPath = path.join(fixtureDir, 'basic.lrc');
        const cases = [
            [basicPath, '--translation-lang', 'ja'],
            [basicPath, '--filter-type', 'unit'],
            [basicPath, '--track', '3'],
            [basicPath, '--color', 'red'],
            [basicPath, '--name', 'a/b'],
            [basicPath, '--未知选项'],
            [basicPath, path.join(fixtureDir, 'basic.zh.lrc')],
        ];
        for (const args of cases) {
            const capture = captureCli(process.cwd());
            expect(runCli(args, capture.io), args.join(' ')).toBe(1);
            expect(capture.stderr.join('').length, args.join(' ')).toBeGreaterThan(0);
        }
    });
});

type GeneratedPackage = {
    configLines: string[];
    ass: string;
    styleLines: string[];
    dialogueLines: string[];
    lyricsLines: string[];
    hasLyrics: boolean;
};

const readGeneratedPackage = (songDir: string): GeneratedPackage => {
    const configLines = fs
        .readFileSync(path.join(songDir, 'config.txt'), 'utf-8')
        .trimEnd()
        .split('\n');
    const ass = fs.readFileSync(path.join(songDir, 'subtitle.ass'), 'utf-8');
    const lyricsPath = path.join(songDir, 'lyrics.txt');
    const hasLyrics = fs.existsSync(lyricsPath);
    return {
        configLines,
        ass,
        styleLines: ass.split('\n').filter((line) => line.startsWith('Style: ')),
        dialogueLines: ass.split('\n').filter((line) => line.startsWith('Dialogue: ')),
        lyricsLines: hasLyrics ? fs.readFileSync(lyricsPath, 'utf-8').trimEnd().split('\n') : [],
        hasLyrics,
    };
};

const runFixture = (
    fixtureName: string,
    extraArgs: string[] = [],
): { code: number; capture: CliCapture; outRoot: string; songDir: string } => {
    const outRoot = path.join(makeTempDir(), 'out');
    const capture = captureCli(process.cwd());
    const code = runCli(
        [path.join(fixtureDir, fixtureName), '--out', outRoot, ...extraArgs],
        capture.io,
    );
    const dirNames = fs.existsSync(outRoot)
        ? fs
              .readdirSync(outRoot, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
        : [];
    return { code, capture, outRoot, songDir: path.join(outRoot, dirNames[0] ?? '') };
};

describe('detectLanguage / detectDominantLanguage', () => {
    it('按行识别 ja/zh/en/other 与混合文本', () => {
        expect(detectLanguage('なにか目覚めそうだよ')).toBe('ja');
        expect(detectLanguage('似乎有什么就要觉醒')).toBe('zh');
        expect(detectLanguage("I'm at a payphone trying to call home")).toBe('en');
        expect(detectLanguage('1234567890')).toBe('other');
        expect(detectLanguage('     ')).toBe('other');
        expect(detectLanguage('')).toBe('other');
        // 假名优先于汉字
        expect(detectLanguage('これは日本語の歌詞')).toBe('ja');
        // 无假名有汉字 → zh（即使同一行含有拉丁字母）
        expect(detectLanguage('Hello 世界')).toBe('zh');
        expect(detectLanguage('♪ ♪ ♪')).toBe('other');
    });

    it('整体识别取出现最多的语言，平票取先出现', () => {
        expect(detectDominantLanguage(['Hello', 'Hello', '世界'])).toBe('en');
        expect(detectDominantLanguage(['Hello', '世界'])).toBe('en');
        expect(detectDominantLanguage(['世界', 'Hello'])).toBe('zh');
        expect(detectDominantLanguage(['123', 'World'])).toBe('en');
        expect(detectDominantLanguage(['123', '♪'])).toBe('other');
        expect(detectDominantLanguage([])).toBe('other');
    });
});

describe('单文件双语自动识别与配对（CLI）', () => {
    it('英文在前中文在后：自动配对并生成双语 ASS 与 lyrics.txt', () => {
        const run = runFixture('bilingual-en-zh.lrc');
        expect(run.code).toBe(0);
        const generated = readGeneratedPackage(run.songDir);
        expect(generated.configLines).toHaveLength(5);
        expect(generated.configLines[0]).toBe(
            "1,0:00:01.00,0:00:05.00,I'm at a payphone trying to call home",
        );
        expect(generated.styleLines).toHaveLength(50);
        expect(generated.ass).toContain('Style: 英文-Liella,');
        expect(generated.ass).toContain('Style: 中文-Liella,');
        expect(generated.dialogueLines).toHaveLength(10);
        expect(generated.ass).toContain(
            "Dialogue: 0,0:00:01.00,0:00:05.00,英文-Liella,,0,0,0,,{\\fad(200,200)\\pos(960,1075)}I'm at a payphone trying to call home",
        );
        expect(generated.ass).toContain(
            'Dialogue: 0,0:00:01.00,0:00:05.00,中文-Liella,,0,0,0,,{\\fad(200,200)\\pos(960,1020)}我在电话亭里尝试给你打电话',
        );
        expect(generated.hasLyrics).toBe(true);
        expect(generated.lyricsLines.slice(0, 2)).toEqual(['双语测试', '测试译者']);
        expect(generated.lyricsLines[4]).toBe('我在电话亭里尝试给你打电话');
        expect(generated.lyricsLines[5]).toBe("I'm at a payphone trying to call home");
        const stderr = run.capture.stderr.join('');
        expect(stderr).toContain('自动识别原文语言: 英文');
        expect(stderr).toContain('自动配对 5 行翻译（英文 → 中文）');
    });

    it('中文在前英文在后：默认第一行原文，显式 --lang en 覆盖原文', () => {
        const auto = runFixture('bilingual-zh-en.lrc');
        expect(auto.code).toBe(0);
        const autoGenerated = readGeneratedPackage(auto.songDir);
        expect(autoGenerated.configLines).toHaveLength(4);
        expect(autoGenerated.configLines[0]).toBe(
            '1,0:00:01.00,0:00:04.00,我在电话亭里尝试给你打电话',
        );
        expect(autoGenerated.ass).toContain(
            'Dialogue: 0,0:00:01.00,0:00:04.00,中文-Liella,,0,0,0,,{\\fad(200,200)\\pos(960,1020)}我在电话亭里尝试给你打电话',
        );
        expect(autoGenerated.ass).toContain(
            "Dialogue: 0,0:00:01.00,0:00:04.00,英文-Liella,,0,0,0,,{\\fad(200,200)\\pos(960,1075)}I'm at a payphone trying to call home",
        );
        expect(auto.capture.stderr.join('')).toContain('自动配对 4 行翻译（中文 → 英文）');

        const overridden = runFixture('bilingual-zh-en.lrc', ['--lang', 'en']);
        expect(overridden.code).toBe(0);
        const overriddenGenerated = readGeneratedPackage(overridden.songDir);
        expect(overriddenGenerated.configLines[0]).toBe(
            "1,0:00:01.00,0:00:04.00,I'm at a payphone trying to call home",
        );
        expect(overridden.capture.stderr.join('')).not.toContain('自动识别原文语言');
    });

    it('显式 --lang zh 时把中文行作为原文', () => {
        const run = runFixture('bilingual-en-zh.lrc', ['--lang', 'zh']);
        expect(run.code).toBe(0);
        const generated = readGeneratedPackage(run.songDir);
        expect(generated.configLines[0]).toBe('1,0:00:01.00,0:00:05.00,我在电话亭里尝试给你打电话');
        expect(generated.ass).toContain(
            'Dialogue: 0,0:00:01.00,0:00:05.00,中文-Liella,,0,0,0,,{\\fad(200,200)\\pos(960,1020)}我在电话亭里尝试给你打电话',
        );
        expect(generated.ass).toContain(
            "Dialogue: 0,0:00:01.00,0:00:05.00,英文-Liella,,0,0,0,,{\\fad(200,200)\\pos(960,1075)}I'm at a payphone trying to call home",
        );
    });

    it('显式 --lang 覆盖单语文件的自动识别', () => {
        const zhRun = runFixture('basic.lrc', ['--lang', 'zh']);
        expect(zhRun.code).toBe(0);
        const zhGenerated = readGeneratedPackage(zhRun.songDir);
        expect(zhGenerated.ass).toContain('Style: 中文-Liella,');
        expect(zhGenerated.ass).toContain('pos(960,1020)');
        expect(zhRun.capture.stderr.join('')).not.toContain('自动识别原文语言');

        const jaRun = runFixture('basic.lrc', ['--lang', 'ja']);
        expect(jaRun.code).toBe(0);
        const jaGenerated = readGeneratedPackage(jaRun.songDir);
        expect(jaGenerated.ass).toContain('Style: 日文-Liella,');
        expect(jaRun.capture.stderr.join('')).not.toContain('自动识别原文语言');
    });

    it('日中双语：假名行与中文行自动配对', () => {
        const run = runFixture('bilingual-ja-zh.lrc');
        expect(run.code).toBe(0);
        const generated = readGeneratedPackage(run.songDir);
        expect(generated.configLines).toHaveLength(4);
        expect(generated.configLines[0]).toBe('1,0:00:01.00,0:00:04.00,なにか目覚めそうだよ');
        expect(generated.styleLines).toHaveLength(50);
        expect(generated.dialogueLines).toHaveLength(8);
        expect(generated.ass).toContain('Style: 日文-Liella,');
        expect(generated.ass).toContain('Style: 中文-Liella,');
        expect(generated.ass).toContain('pos(960,1075)}なにか目覚めそうだよ');
        expect(generated.ass).toContain('pos(960,1020)}似乎有什么就要觉醒');
        expect(run.capture.stderr.join('')).toContain('自动配对 4 行翻译（日文 → 中文）');
    });

    it('同一对两行语言相同时仍配对，译文换到另一槽位避免重叠', () => {
        const run = runFixture('bilingual-mixed-same-lang.lrc');
        expect(run.code).toBe(0);
        const generated = readGeneratedPackage(run.songDir);
        expect(generated.configLines).toHaveLength(6);
        expect(generated.styleLines).toHaveLength(50);
        expect(generated.dialogueLines).toHaveLength(12);
        expect(generated.ass).toContain(
            'Dialogue: 0,0:00:10.00,0:00:17.00,英文-Liella,,0,0,0,,{\\fad(200,200)\\pos(960,1075)}Wiz Khalifa',
        );
        expect(generated.ass).toContain(
            'Dialogue: 0,0:00:10.00,0:00:17.00,英文-Liella,,0,0,0,,{\\fad(200,200)\\pos(960,1020)}WOW',
        );
        expect(run.capture.stderr.join('')).toContain('自动配对 6 行翻译（英文 → 中文）');
    });

    it('单语文件含同时间戳和声行时不误配对', () => {
        const run = runFixture('monolingual-harmony.lrc');
        expect(run.code).toBe(0);
        const generated = readGeneratedPackage(run.songDir);
        expect(generated.configLines).toHaveLength(7);
        expect(generated.dialogueLines).toHaveLength(7);
        expect(generated.styleLines).toHaveLength(25);
        expect(generated.styleLines.every((line) => line.startsWith('Style: 日文-'))).toBe(true);
        expect(generated.hasLyrics).toBe(false);
        expect(run.capture.stderr.join('')).not.toContain('自动配对 ');
    });

    it('双语证据不足时不配对，并提示可用 --translation', () => {
        const run = runFixture('weak-bilingual.lrc');
        expect(run.code).toBe(0);
        const generated = readGeneratedPackage(run.songDir);
        expect(generated.configLines).toHaveLength(4);
        expect(generated.hasLyrics).toBe(false);
        expect(run.capture.stderr.join('')).toContain('检测到多语言但无法自动配对');
    });

    it('默认过滤 credits，--keep-credits 保留', () => {
        const filtered = runFixture('bilingual-credits.lrc');
        expect(filtered.code).toBe(0);
        const filteredGenerated = readGeneratedPackage(filtered.songDir);
        expect(filteredGenerated.configLines).toHaveLength(6);
        expect(filteredGenerated.configLines.join('\n')).not.toContain('作词');
        expect(filteredGenerated.ass).not.toContain('作曲');
        expect(filtered.capture.stderr.join('')).toContain('已过滤 4 行 credits/制作信息');

        const kept = runFixture('bilingual-credits.lrc', ['--keep-credits']);
        expect(kept.code).toBe(0);
        const keptGenerated = readGeneratedPackage(kept.songDir);
        expect(keptGenerated.configLines.join('\n')).toContain('作词 : 张三');
        expect(keptGenerated.configLines).toHaveLength(15);
        expect(kept.capture.stderr.join('')).not.toContain('已过滤');
    });

    it('同一时间戳完全相同的重复行被去重', () => {
        const run = runFixture('duplicate-lines.lrc');
        expect(run.code).toBe(0);
        const generated = readGeneratedPackage(run.songDir);
        expect(generated.configLines).toHaveLength(5);
        expect(generated.configLines.filter((line) => line.includes('Hello'))).toHaveLength(1);
        expect(generated.configLines[0]).toBe('1,0:00:01.00,0:00:02.00,Hello');
        expect(run.capture.stderr.join('')).toContain('已去除 1 行同一时间戳的重复行');
    });

    it('--no-auto-pair 关闭自动配对，保持单行行为', () => {
        const run = runFixture('bilingual-en-zh.lrc', ['--no-auto-pair']);
        expect(run.code).toBe(0);
        const generated = readGeneratedPackage(run.songDir);
        expect(generated.configLines).toHaveLength(10);
        expect(generated.dialogueLines).toHaveLength(10);
        expect(generated.styleLines).toHaveLength(25);
        expect(generated.hasLyrics).toBe(false);
        const stderr = run.capture.stderr.join('');
        expect(stderr).toContain('已按 --no-auto-pair 关闭单文件自动配对');
        expect(stderr).not.toContain('自动配对 ');
    });

    it('参考文件等价夹具：credits + 双语对 + 同语言对的块数/时长', () => {
        const run = runFixture('bilingual-credits.lrc');
        expect(run.code).toBe(0);
        const generated = readGeneratedPackage(run.songDir);
        expect(generated.configLines).toHaveLength(6);
        expect(generated.configLines[0]).toBe(
            "1,0:00:01.08,0:00:04.28,I'm at a payphone trying to call home",
        );
        expect(generated.configLines[generated.configLines.length - 1]).toBe(
            '1,0:00:20.00,0:00:25.00,But even the sun sets in paradise',
        );
        expect(generated.styleLines).toHaveLength(50);
        expect(generated.dialogueLines).toHaveLength(12);
        expect(generated.hasLyrics).toBe(true);
        expect(generated.lyricsLines).toHaveLength(16);
        expect(run.capture.stderr.join('')).toContain('自动配对 6 行翻译（英文 → 中文）');
    });
});
