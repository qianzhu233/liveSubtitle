import { getFontOptions } from '../utils/fonts';

export default defineEventHandler((event) => {
    // 字体列表会随 public/fonts 变化，禁止浏览器（尤其 OBS 内置浏览器）缓存旧列表
    setHeader(event, 'Cache-Control', 'no-store, max-age=0');
    return getFontOptions();
});
