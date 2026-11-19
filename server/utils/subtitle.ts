import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FilterConfig, SubtitleBlock, SubtitleFile } from '../../types/subtitle';
import { assToBlocks, decodeAssBuffer, parseAssContent } from './ass';

const SUBTITLE_FILES_DIR = 'subtitleFiles';
const OUTPUT_DIR_NAME = '.output';
const CONFIG_FILE_NAME = 'config.txt';

/** 字幕目录解析参数（主要供测试注入，生产环境按 cwd / 服务端模块位置自动查找） */
export interface SubtitleDirOptions {
    cwd?: string;
    moduleDir?: string;
    entryPath?: string;
    /** 直接指定 subtitleFiles 目录；也可通过环境变量 SUBTITLE_FILES_DIR 设置 */
    envDir?: string;
}

function isDirectory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}

/**
 * 从起始目录向上查找编译产物中的 .output/subtitleFiles。
 * 这样无论服务从项目根目录、.output 还是其它 cwd 启动，都优先读取构建产物里的字幕数据。
 */
function findOutputSubtitleDir(startDir: string): string | null {
    if (!startDir) {
        return null;
    }

    let current = path.resolve(startDir);

    for (let depth = 0; depth < 8; depth++) {
        if (path.basename(current) === OUTPUT_DIR_NAME) {
            const candidate = path.join(current, SUBTITLE_FILES_DIR);
            if (isDirectory(candidate)) {
                return candidate;
            }
        }

        const candidate = path.join(current, OUTPUT_DIR_NAME, SUBTITLE_FILES_DIR);
        if (isDirectory(candidate)) {
            return candidate;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }

    return null;
}

function getModuleDirectory(): string {
    try {
        return path.dirname(fileURLToPath(import.meta.url));
    } catch {
        return '';
    }
}

/**
 * 解析实际使用的 subtitleFiles 目录：
 * 1. 环境变量 SUBTITLE_FILES_DIR（直接指向字幕目录）
 * 2. 当前工作目录 / 服务端模块位置 / 入口脚本位置附近的 .output/subtitleFiles
 * 3. 项目根目录下的 subtitleFiles（未构建时的开发回退）
 */
export function resolveSubtitleFilesDir(options: SubtitleDirOptions = {}): string {
    const envDir = options.envDir ?? process.env.SUBTITLE_FILES_DIR;
    if (envDir) {
        return path.resolve(envDir);
    }

    const cwd = options.cwd ?? process.cwd();
    const moduleDir = options.moduleDir ?? getModuleDirectory();
    const entryDir = options.entryPath ? path.dirname(options.entryPath) : '';

    for (const startDir of [cwd, moduleDir, entryDir]) {
        const found = findOutputSubtitleDir(startDir);
        if (found) {
            return found;
        }
    }

    return path.join(cwd, SUBTITLE_FILES_DIR);
}

/** 显式传入 rootDir 时按 <rootDir>/subtitleFiles 读取（测试用），否则按编译产物解析 */
function getSubtitleFilesDir(rootDir?: string): string {
    return rootDir ? path.join(rootDir, SUBTITLE_FILES_DIR) : resolveSubtitleFilesDir();
}

function timeToSeconds(timeStr: string | undefined): number {
    if (!timeStr) {
        return Number.NaN;
    }

    const parts = timeStr.split(':');
    return (
        Number.parseInt(parts[0] ?? '', 10) * 3600 +
        Number.parseInt(parts[1] ?? '', 10) * 60 +
        Number.parseFloat(parts[2] ?? '')
    );
}

function createSubtitleFile(
    songName: string,
    blocks: SubtitleBlock[],
    duration: number,
): SubtitleFile {
    return {
        id: songName,
        name: songName,
        duration,
        blocks,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

/**
 * 读取 config.txt（原有字幕配置格式）。
 * 文件不存在或解析不到任何 block 时返回 null，由 ASS/SSA 解析回退处理。
 */
function loadSubtitleFileFromConfig(folderPath: string, songName: string): SubtitleFile | null {
    const configPath = path.join(folderPath, CONFIG_FILE_NAME);
    if (!fs.existsSync(configPath)) {
        return null;
    }

    const content = fs.readFileSync(configPath, 'utf-8');
    const lines = content.split(/\r?\n/);

    const blocks: SubtitleBlock[] = [];
    let maxEndTime = 0;

    lines.forEach((rawLine, index) => {
        const line = rawLine.trim();
        if (line.length === 0) {
            return;
        }

        const parts = line.split(',');
        if (parts.length < 4) {
            return;
        }

        const track = Number.parseInt(parts[0] ?? '', 10);
        const startTime = timeToSeconds(parts[1]);
        const endTime = timeToSeconds(parts[2]);
        if (!Number.isFinite(track) || !Number.isFinite(startTime) || !Number.isFinite(endTime)) {
            return;
        }

        blocks.push({
            id: `${songName}-${index + 1}`,
            startTime,
            endTime,
            text: parts.slice(3).join(','),
            track,
        });

        maxEndTime = Math.max(maxEndTime, endTime);
    });

    if (blocks.length === 0) {
        return null;
    }

    return createSubtitleFile(songName, blocks, maxEndTime);
}

/**
 * 按约定的优先级列出目录下的 ASS/SSA 文件：
 * subtitle.ass → 其它 *.ass（按文件名排序）→ *.ssa（按文件名排序）。
 */
function listSubtitleFileCandidates(folderPath: string): string[] {
    let fileNames: string[];

    try {
        fileNames = fs
            .readdirSync(folderPath, { withFileTypes: true })
            .filter((dirent) => dirent.isFile())
            .map((dirent) => dirent.name);
    } catch {
        return [];
    }

    const assFiles = fileNames.filter((fileName) => fileName.toLowerCase().endsWith('.ass')).sort();
    const ssaFiles = fileNames.filter((fileName) => fileName.toLowerCase().endsWith('.ssa')).sort();

    const candidates: string[] = [];
    const preferredAss = assFiles.find((fileName) => fileName.toLowerCase() === 'subtitle.ass');
    if (preferredAss) {
        candidates.push(preferredAss);
    }
    for (const fileName of assFiles) {
        if (fileName !== preferredAss) {
            candidates.push(fileName);
        }
    }
    candidates.push(...ssaFiles);

    return candidates;
}

function readDecodedFile(filePath: string): string {
    return decodeAssBuffer(fs.readFileSync(filePath));
}

/**
 * 从目录中的 ASS/SSA 文件解析出字幕块（无 config.txt 时的回退路径）。
 * 按候选优先级逐个尝试，返回第一个能解析出 block 的字幕文件；都失败时返回 null。
 */
function loadSubtitleFileFromAss(folderPath: string, songName: string): SubtitleFile | null {
    for (const fileName of listSubtitleFileCandidates(folderPath)) {
        try {
            const content = readDecodedFile(path.join(folderPath, fileName));
            const blocks = assToBlocks(parseAssContent(content), songName);
            if (blocks.length === 0) {
                continue;
            }

            const duration = blocks.reduce((max, block) => Math.max(max, block.endTime), 0);
            return createSubtitleFile(songName, blocks, duration);
        } catch (error) {
            console.error(`解析字幕文件失败 ${songName}/${fileName}:`, error);
        }
    }

    return null;
}

/**
 * 读取单个歌曲目录：优先 config.txt（原有行为），
 * 没有 config.txt 或解析不到 block 时自动回退到 ASS/SSA 文件。
 */
function loadSubtitleFile(folderPath: string, songName: string): SubtitleFile | null {
    return (
        loadSubtitleFileFromConfig(folderPath, songName) ??
        loadSubtitleFileFromAss(folderPath, songName)
    );
}

/**
 * 读取 subtitleFiles 下所有歌曲目录的字幕文件。
 * 不传 rootDir 时优先读取编译产物中的 .output/subtitleFiles。
 * @param rootDir 显式指定项目根目录（测试用）
 */
export function readAllSubtitleFiles(rootDir?: string): SubtitleFile[] {
    const subtitleFilesDir = getSubtitleFilesDir(rootDir);

    if (!fs.existsSync(subtitleFilesDir)) {
        console.warn(`subtitleFiles 文件夹不存在: ${subtitleFilesDir}`);
        return [];
    }

    const songFolders = fs
        .readdirSync(subtitleFilesDir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);

    const subtitleFiles: SubtitleFile[] = [];

    songFolders.forEach((songName) => {
        try {
            const folderPath = path.join(subtitleFilesDir, songName);
            const subtitleFile = loadSubtitleFile(folderPath, songName);
            if (subtitleFile) {
                subtitleFiles.push(subtitleFile);
            }
        } catch (error) {
            console.error(`读取字幕文件失败 ${songName}:`, error);
        }
    });

    return subtitleFiles;
}

/**
 * 读取过滤器配置。
 * 不传 rootDir 时优先读取编译产物中的 .output/subtitleFiles。
 * @param rootDir 显式指定项目根目录（测试用）
 */
export function readFilterConfig(rootDir?: string): FilterConfig {
    const configPath = path.join(getSubtitleFilesDir(rootDir), 'filter-config.json');

    if (!fs.existsSync(configPath)) {
        console.warn('过滤器配置文件不存在，返回空配置');
        return [];
    }

    try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const config: unknown = JSON.parse(content);
        return Array.isArray(config) ? (config as FilterConfig) : [];
    } catch (error) {
        console.error('读取过滤器配置失败:', error);
        return [];
    }
}

/**
 * 读取指定歌曲目录的 ASS/SSA 原始内容（已按文件编码解码为字符串）。
 * 查找规则与 readAllSubtitleFiles 的 ASS 回退一致：
 * subtitle.ass → 其它 *.ass → *.ssa。
 * 不传 rootDir 时优先读取编译产物中的 .output/subtitleFiles。
 * @param rootDir 显式指定项目根目录（测试用）
 */
export function readAssFile(id: string, rootDir?: string): string | null {
    const folderPath = path.join(getSubtitleFilesDir(rootDir), id);
    const candidates = listSubtitleFileCandidates(folderPath);
    if (candidates.length === 0) {
        return null;
    }

    let fallbackContent: string | null = null;

    for (const fileName of candidates) {
        try {
            const content = readDecodedFile(path.join(folderPath, fileName));
            fallbackContent ??= content;

            // 优先返回能真正构成时间轴的字幕文件
            if (assToBlocks(parseAssContent(content), id).length > 0) {
                return content;
            }
        } catch (error) {
            console.error(`读取字幕文件失败 ${id}/${fileName}:`, error);
        }
    }

    return fallbackContent;
}
