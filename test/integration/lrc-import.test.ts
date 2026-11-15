import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../../scripts/lrc2subtitle.js';
import { readAllSubtitleFiles, readAssFile } from '../../server/utils/subtitle';
import { parseAssContent } from '../../server/utils/ass';
import { applyAssColor } from '../../utils/assColor';

/**
 * 端到端集成测试：LRC →（scripts/lrc2subtitle.js）→ 字幕包 →（server/utils）→ 时间轴 / ASS。
 * 同时覆盖“无 config.txt 的任意 ASS/SSA 直接放入 subtitleFiles”的通用字幕路径。
 */

const FIXTURES = path.resolve(process.cwd(), 'test/fixtures/lrc');

const tempDirs: string[] = [];

function createTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-subtitle-integration-'));
    tempDirs.push(dir);
    return dir;
}

function runConverter(argv: string[], cwd: string) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = runCli(argv, {
        cwd,
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
    });
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('LRC → 字幕包 → 服务端时间轴', () => {
    it('生成双语字幕包并直接作为项目字幕被读取', () => {
        const tmp = createTempDir();
        const outRoot = path.join(tmp, 'subtitleFiles');

        const result = runConverter(
            [
                path.join(FIXTURES, 'basic.lrc'),
                '--translation',
                path.join(FIXTURES, 'basic.zh.lrc'),
                '--name',
                '始まりは君の空',
                '--out',
                outRoot,
                '--filter',
                '测试筛选',
                '--filter-type',
                'album',
            ],
            tmp,
        );

        expect(result.code).toBe(0);
        expect(result.stderr).not.toContain('错误');

        // 生成目录结构符合项目约定
        const songDir = path.join(outRoot, '始まりは君の空');
        expect(fs.existsSync(path.join(songDir, 'config.txt'))).toBe(true);
        expect(fs.existsSync(path.join(songDir, 'subtitle.ass'))).toBe(true);
        expect(fs.existsSync(path.join(songDir, 'lyrics.txt'))).toBe(true);

        // filter-config.json 被追加，歌曲出现在对应的筛选器里
        const filterConfig = JSON.parse(
            fs.readFileSync(path.join(outRoot, 'filter-config.json'), 'utf-8'),
        );
        expect(filterConfig).toEqual([
            { name: '测试筛选', type: 'album', songs: ['始まりは君の空'] },
        ]);

        // 服务端扫描：直接放入 subtitleFiles 即可被读取（无需额外导入步骤）
        const subtitleFiles = readAllSubtitleFiles(tmp);
        expect(subtitleFiles.map((file) => file.id)).toEqual(['始まりは君の空']);

        const song = subtitleFiles[0]!;
        expect(song.duration).toBeCloseTo(12.2, 5);
        expect(song.blocks).toHaveLength(5);
        expect(song.blocks[0]).toEqual({
            id: '始まりは君の空-1',
            startTime: 0.5,
            endTime: 2,
            text: 'なにか目覚めそうだよ',
            track: 1,
        });
        // 含半角逗号的歌词文本不能被 config.txt 的分隔符破坏
        expect(song.blocks[4]!.text).toBe('コンマ, を含む行');
        expect(song.blocks[4]!.endTime).toBeCloseTo(12.2, 5);

        // 生成的 ASS 与服务端时间轴一致：每块一行原文 + 一行翻译
        const assContent = readAssFile('始まりは君の空', tmp);
        expect(assContent).toBeTruthy();
        const parsed = parseAssContent(assContent!);
        expect(parsed.events).toHaveLength(10);
        expect(parsed.styles.some((style) => style.name === '日文-Liella')).toBe(true);
        expect(parsed.styles.some((style) => style.name === '中文-Liella')).toBe(true);
        expect(parsed.scriptInfo.PlayResX).toBe('1920');
        expect(parsed.scriptInfo.PlayResY).toBe('1080');

        const primaryEvents = parsed.events.filter((event) => event.fields.Style === '日文-Liella');
        expect(primaryEvents.map((event) => event.startTime)).toEqual(
            song.blocks.map((block) => block.startTime),
        );
        expect(primaryEvents.map((event) => event.endTime)).toEqual(
            song.blocks.map((block) => block.endTime),
        );
        expect(primaryEvents.map((event) => event.text)).toEqual(
            song.blocks.map((block) => block.text),
        );

        // 颜色开关（分词）可以直接作用于生成的双语 ASS
        const recolored = applyAssColor(assContent!, '#FF7F27');
        const recoloredStyles = parseAssContent(recolored).styles;
        expect(recoloredStyles.length).toBeGreaterThan(0);
        expect(recoloredStyles.every((style) => style.fields.OutlineColour === '&H00277FFF')).toBe(
            true,
        );
    });

    it('纯中文 LRC 使用 --lang zh 时只生成中文样式与中文行', () => {
        const tmp = createTempDir();
        const lrcPath = path.join(tmp, 'chinese.lrc');
        fs.writeFileSync(
            lrcPath,
            [
                '[ti:纯中文测试曲]',
                '[ar:测试歌手]',
                '[by:测试译者]',
                '',
                '[00:01.00]第一句中文歌词',
                '[00:04.20]第二句，带全角逗号',
                '[00:07.50]第三句, 带半角逗号',
                '[00:11.00]最后一句',
                '',
            ].join('\n'),
            'utf-8',
        );

        const outRoot = path.join(tmp, 'subtitleFiles');
        const result = runConverter(
            [lrcPath, '--lang', 'zh', '--out', outRoot, '--name', '纯中文测试曲'],
            tmp,
        );

        expect(result.code).toBe(0);
        // 未提供翻译时不生成 lyrics.txt
        expect(fs.existsSync(path.join(outRoot, '纯中文测试曲', 'lyrics.txt'))).toBe(false);

        const song = readAllSubtitleFiles(tmp)[0]!;
        expect(song.blocks).toHaveLength(4);
        expect(song.blocks.map((block) => block.text)).toEqual([
            '第一句中文歌词',
            '第二句，带全角逗号',
            '第三句, 带半角逗号',
            '最后一句',
        ]);
        expect(song.blocks.every((block) => block.track === 1)).toBe(true);

        const assContent = readAssFile('纯中文测试曲', tmp)!;
        const parsed = parseAssContent(assContent);
        // 只生成中文样式（25 条：12 位成员 × 主/注音 + 1 条画外音），字体使用中文字体
        expect(parsed.styles).toHaveLength(25);
        expect(parsed.styles.every((style) => style.name.startsWith('中文-'))).toBe(true);
        expect(parsed.styles.every((style) => style.fields.Fontname === 'FZFW ZhuZi A YuanS')).toBe(
            true,
        );

        // 所有 Dialogue 使用中文样式与中文位置
        expect(parsed.events).toHaveLength(4);
        expect(parsed.events.every((event) => event.fields.Style.startsWith('中文-'))).toBe(true);
        expect(parsed.events.every((event) => event.raw.includes('\\pos(960,1020)'))).toBe(true);
        expect(parsed.events.map((event) => event.text)).toEqual(song.blocks.map((b) => b.text));
    });

    it('单个 LRC 内的中英双语会被自动识别、配对并生成双语字幕', () => {
        const tmp = createTempDir();
        const lrcPath = path.join(tmp, 'bilingual.lrc');
        fs.writeFileSync(
            lrcPath,
            [
                '[00:00.000]作词 : 测试作者',
                '[00:00.000]作曲 : 测试作者',
                '[00:01.00]Hello, world',
                '[00:01.00]你好，世界',
                '[00:04.00]Second line',
                '[00:04.00]第二句',
                '[00:07.00]Third line',
                '[00:07.00]第三句',
                '[00:10.00]Fourth line',
                '[00:10.00]第四句',
                '[00:13.00]Fifth line',
                '[00:13.00]第五句',
                '[00:16.00]Same language',
                '[00:16.00]WOW',
                '',
            ].join('\n'),
            'utf-8',
        );

        const outRoot = path.join(tmp, 'subtitleFiles');
        const result = runConverter([lrcPath, '--out', outRoot, '--name', '中英双语测试'], tmp);

        expect(result.code).toBe(0);
        expect(result.stderr).toContain('自动识别原文语言: 英文');
        expect(result.stderr).toContain('自动配对');
        expect(result.stderr).toContain('credits');

        // credits 行不进入字幕，双语对合并为同一块
        const song = readAllSubtitleFiles(tmp)[0]!;
        expect(song.blocks).toHaveLength(6);
        expect(song.blocks.map((block) => block.text)).toEqual([
            'Hello, world',
            'Second line',
            'Third line',
            'Fourth line',
            'Fifth line',
            'Same language',
        ]);
        expect(song.duration).toBeCloseTo(21, 5);

        // ASS：英文 + 中文两套样式；每块两行，原文 1075，译文 1020（同语言对换槽）
        const assContent = readAssFile('中英双语测试', tmp)!;
        const parsed = parseAssContent(assContent);
        expect(parsed.styles).toHaveLength(50);
        expect(parsed.styles.filter((style) => style.name.startsWith('英文-'))).toHaveLength(25);
        expect(parsed.styles.filter((style) => style.name.startsWith('中文-'))).toHaveLength(25);
        expect(parsed.events).toHaveLength(12);
        expect(parsed.events.filter((event) => event.raw.includes('\\pos(960,1075)'))).toHaveLength(
            6,
        );
        expect(parsed.events.filter((event) => event.raw.includes('\\pos(960,1020)'))).toHaveLength(
            6,
        );

        // 自动生成 lyrics.txt：4 行头 + 中英成对歌词（中文在前）
        const lyricsPath = path.join(outRoot, '中英双语测试', 'lyrics.txt');
        expect(fs.existsSync(lyricsPath)).toBe(true);
        const lyricLines = fs.readFileSync(lyricsPath, 'utf-8').trimEnd().split('\n');
        expect(lyricLines[0]).toBe('中英双语测试');
        expect(lyricLines.slice(4, 8)).toEqual([
            '你好，世界',
            'Hello, world',
            '第二句',
            'Second line',
        ]);

        // 生成的字幕包可直接被服务端读取，且不含 credits 文本
        const configText = fs.readFileSync(
            path.join(outRoot, '中英双语测试', 'config.txt'),
            'utf-8',
        );
        expect(configText).not.toContain('作词');
        expect(assContent).not.toContain('作词');
    });

    it('支持 [offset:] 元数据、手工偏移与轨道参数', () => {
        const tmp = createTempDir();
        const outRoot = path.join(tmp, 'subtitleFiles');

        const result = runConverter(
            [
                path.join(FIXTURES, 'offset.lrc'),
                '--out',
                outRoot,
                '--name',
                '偏移测试',
                '--offset-ms',
                '-200',
                '--track',
                '2',
            ],
            tmp,
        );

        expect(result.code).toBe(0);

        const song = readAllSubtitleFiles(tmp)[0]!;
        // [offset:+500] 与 --offset-ms -200 叠加 => +300ms
        expect(song.blocks.map((block) => block.startTime)).toEqual([1.3, 8.3]);
        expect(song.blocks.every((block) => block.track === 2)).toBe(true);
        // 最后一行结束时间 = 开始时间 + 5 秒
        expect(song.duration).toBeCloseTo(13.3, 5);
    });

    it('--dry-run 不写入任何文件', () => {
        const tmp = createTempDir();
        const outRoot = path.join(tmp, 'subtitleFiles');

        const result = runConverter(
            [path.join(FIXTURES, 'basic.lrc'), '--out', outRoot, '--dry-run'],
            tmp,
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('[dry-run]');
        expect(fs.existsSync(outRoot)).toBe(false);
    });

    it('已存在同名目录时拒绝覆盖，--force 后才写入', () => {
        const tmp = createTempDir();
        const outRoot = path.join(tmp, 'subtitleFiles');
        const argv = [path.join(FIXTURES, 'basic.lrc'), '--out', outRoot, '--name', '测试曲'];

        expect(runConverter(argv, tmp).code).toBe(0);

        const second = runConverter(argv, tmp);
        expect(second.code).toBe(1);
        expect(second.stderr).toContain('已存在');

        expect(runConverter([...argv, '--force'], tmp).code).toBe(0);
    });
});

describe('通用 ASS/SSA 字幕直接导入', () => {
    it('无 config.txt 的任意 ASS（BOM + CRLF + 标签）也能生成时间轴', () => {
        const tmp = createTempDir();
        const songDir = path.join(tmp, 'subtitleFiles', '外部字幕');
        fs.mkdirSync(songDir, { recursive: true });

        const assContent = [
            '[Script Info]',
            'ScriptType: v4.00+',
            'PlayResX: 1920',
            'PlayResY: 1080',
            '',
            '[V4+ Styles]',
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
            'Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1',
            '',
            '[Events]',
            'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
            'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\pos(960,1020)}第一句, 带逗号',
            'Dialogue: 1,0:00:04.00,0:00:06.00,Default,,0,0,0,,第二句\\N换行',
            'Comment: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,注释行不参与时间轴',
        ].join('\r\n');

        // 写入带 UTF-8 BOM 的 ASS，文件名也可以任意
        fs.writeFileSync(path.join(songDir, '任意名字.ass'), `\uFEFF${assContent}`, 'utf-8');

        const subtitleFiles = readAllSubtitleFiles(tmp);
        expect(subtitleFiles.map((file) => file.id)).toEqual(['外部字幕']);

        const song = subtitleFiles[0]!;
        expect(song.blocks.map((block) => block.text)).toEqual(['第一句, 带逗号', '第二句 换行']);
        expect(song.blocks.map((block) => block.startTime)).toEqual([1, 4]);
        // Layer > 0 的事件进入轨道 2
        expect(song.blocks.map((block) => block.track)).toEqual([1, 2]);
        expect(song.duration).toBe(6);

        const content = readAssFile('外部字幕', tmp);
        expect(content).toBeTruthy();
        expect(content!.startsWith('\uFEFF')).toBe(false);
        expect(content).toContain('第一句, 带逗号');
    });

    it('config.txt 与 ASS 同时存在时优先沿用 config.txt', () => {
        const tmp = createTempDir();
        const songDir = path.join(tmp, 'subtitleFiles', '两者都有');
        fs.mkdirSync(songDir, { recursive: true });

        fs.writeFileSync(
            path.join(songDir, 'config.txt'),
            '1,0:00:02.00,0:00:04.00,来自config\n',
            'utf-8',
        );
        fs.writeFileSync(
            path.join(songDir, 'subtitle.ass'),
            [
                '[Script Info]',
                'ScriptType: v4.00+',
                '',
                '[Events]',
                'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
                'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,来自ass',
            ].join('\n'),
            'utf-8',
        );

        const song = readAllSubtitleFiles(tmp)[0]!;
        expect(song.blocks).toHaveLength(1);
        expect(song.blocks[0]!.text).toBe('来自config');
        expect(song.blocks[0]!.startTime).toBe(2);
    });
});
