import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const URL_TO_OPEN = process.argv[2] ?? 'http://localhost:3001/';
const OUT = process.argv[3] ?? 'art/tmp-control.png';
const DEBUG_PORT = 9334;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livesubtitle-shot-'));
const chrome = spawn(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    [
        '--headless=new',
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--hide-scrollbars',
        '--mute-audio',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--window-size=1600,900',
        URL_TO_OPEN,
    ],
    { stdio: 'ignore' },
);

let ws;
try {
    let page;
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
            const list = await response.json();
            page = list.find((item) => item.type === 'page' && item.url.includes('localhost:3001'));
            if (page) break;
        } catch {
            // Chrome 尚未就绪
        }
        await sleep(200);
    }
    if (!page) throw new Error('找不到页面');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (!message.id) return;
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
        else waiter?.resolve(message.result);
    });
    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
        });

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
        width: 1600,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
    });
    await sleep(8000);

    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, Buffer.from(data, 'base64'));
    console.log(`截图已保存: ${OUT}`);
} finally {
    try {
        ws?.close();
    } catch {
        // ignore
    }
    chrome.kill();
    await sleep(500);
    try {
        fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
        // ignore
    }
}
