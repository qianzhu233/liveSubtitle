import { describe, it, expect } from 'vitest';
import { applyAssColor, hexToAssColor } from '../../utils/assColor';

const V4_PLUS_ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H009C46A5,&H00000000,-1,0
Style: Second,Arial,40,&H00FFFFFF,&H000000FF,&H00112233,&H00000000,0,0

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,第一句
`;

const SSA_V4_ASS = `[Script Info]
ScriptType: v4.00

[V4 Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H0000FF00,&H00000000,-1,0

[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,SSA 第一句
`;

const styleLines = (content: string): string[] =>
    content.split(/\r?\n/).filter((line) => line.trim().toLowerCase().startsWith('style:'));

const nonStyleLines = (content: string): string[] =>
    content.split(/\r?\n/).filter((line) => !line.trim().toLowerCase().startsWith('style:'));

describe('hexToAssColor 颜色转换', () => {
    it('转换为 ASS 的 &H00BBGGRR 格式', () => {
        expect(hexToAssColor('#A5469C')).toBe('&H009C46A5');
        expect(hexToAssColor('A5469C')).toBe('&H009C46A5');
        expect(hexToAssColor('#000000')).toBe('&H00000000');
        expect(hexToAssColor('#FFFFFF')).toBe('&H00FFFFFF');
        expect(hexToAssColor('#ff7f27')).toBe('&H00277FFF');
    });

    it('非法颜色返回 null', () => {
        expect(hexToAssColor('red')).toBeNull();
        expect(hexToAssColor('#12345')).toBeNull();
        expect(hexToAssColor('#GGGGGG')).toBeNull();
        expect(hexToAssColor('')).toBeNull();
    });
});

describe('applyAssColor ASS v4.00+（OutlineColour）', () => {
    it('替换所有 Style 行的 OutlineColour', () => {
        const result = applyAssColor(V4_PLUS_ASS, '#A5469C');

        expect(styleLines(result)).toEqual([
            'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H009C46A5,&H00000000,-1,0',
            'Style: Second,Arial,40,&H00FFFFFF,&H000000FF,&H009C46A5,&H00000000,0,0',
        ]);
    });

    it('只改 Style 行，其余内容与换行保持不变', () => {
        const result = applyAssColor(V4_PLUS_ASS, '#A5469C');

        expect(nonStyleLines(result)).toEqual(nonStyleLines(V4_PLUS_ASS));
        expect(result.endsWith('\n')).toBe(true);
        expect(result).toContain('Format: Name, Fontname, Fontsize, PrimaryColour');
        expect(result).toContain('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,第一句');
    });

    it('保留 CRLF 换行', () => {
        const crlfAss = V4_PLUS_ASS.replace(/\n/g, '\r\n');
        const result = applyAssColor(crlfAss, '#A5469C');

        expect(result.includes('\r\n')).toBe(true);
        expect(/(?<!\r)\n/.test(result)).toBe(false);
        expect(result.split('\r\n')).toHaveLength(crlfAss.split('\r\n').length);
        expect(result.endsWith('\r\n')).toBe(true);
    });

    it('按 Format 动态定位 OutlineColour 列', () => {
        const content = `[V4+ Styles]
Format: Name, OutlineColour, Fontname, Fontsize, PrimaryColour, SecondaryColour, BackColour
Style: Shuffled,&H00111111,MyFont,40,&H00FFFFFF,&H000000FF,&H00000000
`;
        const result = applyAssColor(content, '#A5469C');

        expect(styleLines(result)).toEqual([
            'Style: Shuffled,&H009C46A5,MyFont,40,&H00FFFFFF,&H000000FF,&H00000000',
        ]);
    });

    it('Format 字段名大小写不敏感', () => {
        const content = `[V4+ Styles]
Format: name, fontname, fontsize, primarycolour, secondarycolour, outlinecolour
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00111111
`;
        const result = applyAssColor(content, '#A5469C');

        expect(styleLines(result)).toEqual([
            'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H009C46A5',
        ]);
    });

    it('找不到已知字段名时回退下标 5', () => {
        // OutlineColor 是拼写错误，不属于已知字段名
        const content = `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColor, BackColour
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00111111,&H00000000
`;
        const result = applyAssColor(content, '#A5469C');

        expect(styleLines(result)).toEqual([
            'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H009C46A5,&H00000000',
        ]);
    });
});

describe('applyAssColor SSA v4（TertiaryColour）', () => {
    it('替换 TertiaryColour 且不改动 PrimaryColour', () => {
        const result = applyAssColor(SSA_V4_ASS, '#FF3535');

        expect(styleLines(result)).toEqual([
            'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H003535FF,&H00000000,-1,0',
        ]);
    });

    it('按 Format 动态定位 TertiaryColour 列', () => {
        const content = `[V4 Styles]
Format: Name, TertiaryColour, Fontname, Fontsize, PrimaryColour, SecondaryColour, BackColour
Style: Shuffled,&H00111111,MyFont,40,&H00FFFFFF,&H000000FF,&H00000000
`;
        const result = applyAssColor(content, '#FF3535');

        expect(styleLines(result)).toEqual([
            'Style: Shuffled,&H003535FF,MyFont,40,&H00FFFFFF,&H000000FF,&H00000000',
        ]);
    });
});

describe('applyAssColor 边界与容错', () => {
    it('同时处理 [V4+ Styles] 与 [V4 Styles] 段', () => {
        const content = `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour
Style: V4Plus,Arial,48,&H00FFFFFF,&H000000FF,&H00111111,&H00000000

[V4 Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour
Style: V4,Arial,48,&H00FFFFFF,&H000000FF,&H00222222,&H00000000
`;
        const result = applyAssColor(content, '#A5469C');

        expect(styleLines(result)).toEqual([
            'Style: V4Plus,Arial,48,&H00FFFFFF,&H000000FF,&H009C46A5,&H00000000',
            'Style: V4,Arial,48,&H00FFFFFF,&H000000FF,&H009C46A5,&H00000000',
        ]);
    });

    it('没有样式段时原样返回', () => {
        const content = `[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,无样式段
`;
        expect(applyAssColor(content, '#A5469C')).toBe(content);
    });

    it('有样式段但没有 Format 行时原样返回', () => {
        const content = `[V4+ Styles]
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00111111
`;
        expect(applyAssColor(content, '#A5469C')).toBe(content);
    });

    it('非法颜色输入时原样返回', () => {
        expect(applyAssColor(V4_PLUS_ASS, 'red')).toBe(V4_PLUS_ASS);
        expect(applyAssColor(V4_PLUS_ASS, '#12345')).toBe(V4_PLUS_ASS);
        expect(applyAssColor(V4_PLUS_ASS, '')).toBe(V4_PLUS_ASS);
    });

    it('样式段内的注释行与空行不影响后续 Style 行替换', () => {
        const content = `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour
; 这是一行注释

Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00111111,&H00000000
`;
        const result = applyAssColor(content, '#A5469C');

        expect(result).toContain('; 这是一行注释');
        expect(styleLines(result)).toEqual([
            'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H009C46A5,&H00000000',
        ]);
    });

    it('保留 Style 行中非目标列的原始写法', () => {
        const content = `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour
Style: Default,My Font,48,&H00FFFFFF,&H000000FF,&H00111111,&H00000000
`;
        const result = applyAssColor(content, '#A5469C');

        expect(result).toContain('Style: Default,My Font,48,');
        expect(result).toContain('&H009C46A5,&H00000000');
    });

    it('空字符串输入原样返回', () => {
        expect(applyAssColor('', '#A5469C')).toBe('');
    });
});
