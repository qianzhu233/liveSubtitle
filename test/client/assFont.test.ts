import { describe, it, expect } from 'vitest';
import { applyAssFont, buildAssUpdate } from '../../utils/assFont';

const styleLines = (assContent: string): string[] =>
    assContent.split(/\r?\n/).filter((line) => line.trim().toLowerCase().startsWith('style:'));

const nonStyleLines = (assContent: string): string[] =>
    assContent.split(/\r?\n/).filter((line) => !line.trim().toLowerCase().startsWith('style:'));

const V4_PLUS_ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic
Style: 日文-Liella,Old Japanese Font,54,&H00FFFFFF,&H000000FF,&H009C46A5,&H00000000,-1,0
Style: 中文-Liella,Old Chinese Font,64,&H00FFFFFF,&H000000FF,&H009C46A5,&H00000000,-1,0

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,日文-Liella,,0,0,0,,第一句
`;

const SSA_V4_ASS = `[Script Info]
ScriptType: v4.00

[V4 Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic
Style: Default,Old SSA Font,48,&H00FFFFFF,&H000000FF,&H009C46A5,&H00000000,-1,0

[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,SSA 第一句
`;

describe('applyAssFont ASS v4.00+', () => {
    it('替换所有 Style 行的 Fontname，其它列不变', () => {
        const result = applyAssFont(V4_PLUS_ASS, 'FZFW ZhuZi A YuanS');

        expect(styleLines(result)).toEqual([
            'Style: 日文-Liella,FZFW ZhuZi A YuanS,54,&H00FFFFFF,&H000000FF,&H009C46A5,&H00000000,-1,0',
            'Style: 中文-Liella,FZFW ZhuZi A YuanS,64,&H00FFFFFF,&H000000FF,&H009C46A5,&H00000000,-1,0',
        ]);
    });

    it('只改 Style 行，其它内容与换行保持不变', () => {
        const result = applyAssFont(V4_PLUS_ASS, 'Tsukushi A Round Gothic');

        expect(nonStyleLines(result)).toEqual(nonStyleLines(V4_PLUS_ASS));
        expect(result.endsWith('\n')).toBe(true);
        expect(result).toContain('Dialogue: 0,0:00:01.00,0:00:02.00,日文-Liella,,0,0,0,,第一句');
    });

    it('保留 CRLF 换行', () => {
        const crlfAss = V4_PLUS_ASS.replace(/\n/g, '\r\n');
        const result = applyAssFont(crlfAss, 'FZFW ZhuZi A YuanS');

        expect(result.split('\r\n')).toHaveLength(crlfAss.split('\r\n').length);
        expect(/(?<!\r)\n/.test(result)).toBe(false);
        expect(result.endsWith('\r\n')).toBe(true);
        expect(result).toContain('Style: 日文-Liella,FZFW ZhuZi A YuanS,54,');
    });

    it('按 Format 动态定位 Fontname 列（字段顺序打乱）', () => {
        const content = `[V4+ Styles]
Format: Name, Fontsize, Fontname, PrimaryColour, SecondaryColour
Style: Default,48,My Old Font,&H00FFFFFF,&H000000FF
`;
        const result = applyAssFont(content, 'New Font');

        expect(styleLines(result)).toEqual(['Style: Default,48,New Font,&H00FFFFFF,&H000000FF']);
    });

    it('Format 中找不到 Fontname 时回退下标 1', () => {
        // FontFamily 不在已知字段名中
        const content = `[V4+ Styles]
Format: Name, FontFamily, Fontsize, PrimaryColour
Style: Default,My Old Font,48,&H00FFFFFF
`;
        const result = applyAssFont(content, 'New Font');

        expect(styleLines(result)).toEqual(['Style: Default,New Font,48,&H00FFFFFF']);
    });

    it('样式段内的注释行与空行不影响后续 Style 行替换', () => {
        const content = `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour
; 注释行
Style: Default,My Old Font,48,&H00FFFFFF
`;
        const result = applyAssFont(content, 'New Font');

        expect(result).toContain('; 注释行');
        expect(styleLines(result)).toEqual(['Style: Default,New Font,48,&H00FFFFFF']);
    });
});

describe('applyAssFont SSA v4', () => {
    it('替换 [V4 Styles] 的 Fontname', () => {
        const result = applyAssFont(SSA_V4_ASS, 'Tsukushi A Round Gothic');

        expect(styleLines(result)).toEqual([
            'Style: Default,Tsukushi A Round Gothic,48,&H00FFFFFF,&H000000FF,&H009C46A5,&H00000000,-1,0',
        ]);
    });
});

describe('applyAssFont 边界', () => {
    it('字体名为空或只有空白时原样返回', () => {
        expect(applyAssFont(V4_PLUS_ASS, '')).toBe(V4_PLUS_ASS);
        expect(applyAssFont(V4_PLUS_ASS, '   ')).toBe(V4_PLUS_ASS);
    });

    it('没有样式段时原样返回', () => {
        const content = `[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,无样式段
`;
        expect(applyAssFont(content, 'New Font')).toBe(content);
    });

    it('有样式段但没有 Format 行时原样返回', () => {
        const content = `[V4+ Styles]
Style: Default,My Old Font,48,&H00FFFFFF
`;
        expect(applyAssFont(content, 'New Font')).toBe(content);
    });

    it('空字符串输入原样返回', () => {
        expect(applyAssFont('', 'New Font')).toBe('');
    });
});

describe('buildAssUpdate 颜色与字体组合', () => {
    it('分词开启且未选字体时原样返回', () => {
        expect(buildAssUpdate(V4_PLUS_ASS, { colorEnabled: true, colorHex: '#A5469C' })).toBe(
            V4_PLUS_ASS,
        );
    });

    it('分词关闭时应用选中颜色（OutlineColour）', () => {
        const result = buildAssUpdate(V4_PLUS_ASS, {
            colorEnabled: false,
            colorHex: '#A5469C',
        });

        const firstStyle = styleLines(result)[0]!;
        expect(firstStyle.split(',')[5]).toBe('&H009C46A5');
        expect(firstStyle.split(',')[1]).toBe('Old Japanese Font');
    });

    it('分词开启时只应用字体', () => {
        const result = buildAssUpdate(V4_PLUS_ASS, {
            colorEnabled: true,
            colorHex: '#A5469C',
            fontFamily: 'FZFW ZhuZi A YuanS',
        });

        for (const styleLine of styleLines(result)) {
            expect(styleLine.split(',')[1]).toBe('FZFW ZhuZi A YuanS');
            expect(styleLine.split(',')[5]).toBe('&H009C46A5');
        }
    });

    it('分词关闭 + 选中字体时颜色与字体同时生效', () => {
        const result = buildAssUpdate(V4_PLUS_ASS, {
            colorEnabled: false,
            colorHex: '#FF3535',
            fontFamily: 'Tsukushi A Round Gothic',
        });

        const lines = styleLines(result);
        expect(lines).toHaveLength(2);
        for (const styleLine of lines) {
            expect(styleLine.split(',')[1]).toBe('Tsukushi A Round Gothic');
            expect(styleLine.split(',')[5]).toBe('&H003535FF');
        }
    });

    it('SSA v4 样式段同时应用 TertiaryColour 与字体', () => {
        const result = buildAssUpdate(SSA_V4_ASS, {
            colorEnabled: false,
            colorHex: '#A5469C',
            fontFamily: 'Tsukushi A Round Gothic',
        });

        const styleLine = styleLines(result)[0]!;
        expect(styleLine.split(',')[1]).toBe('Tsukushi A Round Gothic');
        expect(styleLine.split(',')[5]).toBe('&H009C46A5');
    });

    it('分词关闭但没有颜色值时原样返回', () => {
        expect(buildAssUpdate(V4_PLUS_ASS, { colorEnabled: false })).toBe(V4_PLUS_ASS);
        expect(buildAssUpdate(V4_PLUS_ASS, { colorEnabled: false, fontFamily: '   ' })).toBe(
            V4_PLUS_ASS,
        );
    });
});
