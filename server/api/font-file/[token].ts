import fs from 'node:fs';
import path from 'node:path';
import { resolveFontFileToken } from '../../utils/fonts';

const FONT_MIME_TYPES: Record<string, string> = {
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.ttc': 'font/collection',
    '.otc': 'font/collection',
};

/**
 * 系统字体文件访问端点。
 *
 * 展示端（libass WASM）无法直接使用操作系统字体，必须拿到字体文件本身，
 * 因此服务端把系统字体以只读方式提供给浏览器。token 是字体绝对路径的
 * base64url 编码，服务端会再次校验路径必须位于系统字体目录内。
 */
export default defineEventHandler((event) => {
    const method = getMethod(event);

    if (method !== 'GET' && method !== 'HEAD') {
        throw createError({
            statusCode: 405,
            statusMessage: 'Method Not Allowed',
            headers: { Allow: 'GET, HEAD' },
        });
    }

    const token = getRouterParam(event, 'token') ?? '';
    const filePath = resolveFontFileToken(token);

    if (!filePath) {
        throw createError({ statusCode: 404, statusMessage: 'Font not found' });
    }

    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch {
        throw createError({ statusCode: 404, statusMessage: 'Font not found' });
    }

    if (!stat.isFile()) {
        throw createError({ statusCode: 404, statusMessage: 'Font not found' });
    }
    const extension = path.extname(filePath).toLowerCase();

    setHeader(event, 'Content-Type', FONT_MIME_TYPES[extension] ?? 'application/octet-stream');
    setHeader(event, 'Content-Length', stat.size);
    // 字体文件很少变化：允许浏览器/OBS 缓存，避免每次切换字体都重新下载
    setHeader(event, 'Cache-Control', 'public, max-age=86400');

    if (method === 'HEAD') {
        // 保留 Content-Type / Content-Length，仅结束响应（返回 null 会被 h3 改成 204）
        sendNoContent(event, 200);
        return;
    }

    return sendStream(event, fs.createReadStream(filePath));
});
