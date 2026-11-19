import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const PORT = 3001;
const BASE = `http://localhost:${PORT}`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 9333;
const OUT = process.argv[2] ?? 'art/tmp-render-follow.png';
const ASS_FILE_NAME = process.argv[3] ?? '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return response.json();
}

async function waitForDebugger() {
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            const list = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
            const page = list.find((item) => item.type === 'page' && item.url.includes('/subtitle'));
            if (page) return page;
        } catch {
            // Chrome 还没启动好
        }
        await sleep(200);
    }
    throw new Error('Chrome 调试端口未就绪');
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livesubtitle-chrome-'));
const chrome = spawn(
    CHROME,
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
        '--window-size=1920,1080',
        `${BASE}/subtitle`,
    ],
    { stdio: 'ignore' },
);

const consoleLines = [];
let socket;
let ws;

try {
    const page = await waitForDebugger();
    ws = new WebSocket(page.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });

    let nextId = 0;
    const pending = new Map();

    ws.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id) {
            const waiter = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
            else waiter?.resolve(message.result);
            return;
        }

        if (message.method === 'Runtime.consoleAPICalled') {
            const text = (message.params.args ?? [])
                .map((arg) => arg.value ?? arg.description ?? '')
                .join(' ');
            consoleLines.push(`[console.${message.params.type}] ${text}`);
        }
        if (message.method === 'Log.entryAdded') {
            consoleLines.push(`[log.${message.params.entry.level}] ${message.params.entry.text}`);
        }
        if (message.method === 'Runtime.exceptionThrown') {
            consoleLines.push(
                `[exception] ${message.params.exceptionDetails?.text} ${
                    message.params.exceptionDetails?.exception?.description ?? ''
                }`,
            );
        }
    });

    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
        });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', {
        width: 1920,
        height: 1080,
        deviceScaleFactor: 1,
        mobile: false,
    });
    await send('Emulation.setDefaultBackgroundColorOverride', {
        color: { r: 255, g: 255, b: 255, a: 1 },
    });

    // 等页面挂载、socket 连上、octopus 脚本加载
    for (let attempt = 0; attempt < 60; attempt++) {
        const { result } = await send('Runtime.evaluate', {
            expression: 'Boolean(window.SubtitlesOctopus)',
            returnByValue: true,
        });
        if (result.value) break;
        await sleep(200);
    }
    await sleep(2500);

    socket = io(BASE, { transports: ['websocket'], path: '/websocket', reconnection: false });
    await new Promise((resolve, reject) => {
        socket.on('connect', resolve);
        socket.on('connect_error', reject);
    });

    const files = await fetchJson(`${BASE}/api/subtitles`);
    const file =
        (ASS_FILE_NAME && files.find((item) => item.id === ASS_FILE_NAME)) ||
        files.find((item) => item.name === '揺らぐわ') ||
        files.find((item) => item.blocks.some((block) => block.text.length >= 5)) ||
        files[0];

    if (!file) throw new Error('没有可用字幕文件');

    const block =
        file.blocks.find((item) => item.text.length >= 5 && item.startTime > 0.5) ??
        file.blocks.find((item) => item.text.length >= 5) ??
        file.blocks[0];

    console.log(`使用字幕文件: ${file.name} (${file.id}), 时间 ${block?.startTime}`);

    let fontPayload = {
        fontFile: '',
        fontFamily: '',
        fontUrl: '',
        fontUrls: [],
    };

    const forceFontFamily = process.env.FORCE_FONT ?? '';
    if (forceFontFamily) {
        const fontOptions = await fetchJson(`${BASE}/api/font-options`);
        const option = fontOptions.find((item) => item.familyName === forceFontFamily);
        if (!option) throw new Error(`系统字体列表中没有 ${forceFontFamily}`);
        fontPayload = {
            fontFile: option.fileName,
            fontFamily: option.familyName,
            fontUrl: option.url,
            fontUrls: option.urls,
        };
        console.log(
            `强制字体: ${option.familyName}, 文件: ${option.fileName}, URL 数: ${option.urls.length}`,
        );
    }

    socket.emit('file-selected', {
        file,
        ...fontPayload,
    });

    // 等 ASS 与字体下载、渲染器初始化完成
    await sleep(12000);

    if (block) {
        socket.emit('time-sync', { currentTime: block.startTime + 0.3 });
    }
    await sleep(2500);

    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, Buffer.from(data, 'base64'));
    console.log(`截图已保存: ${OUT}`);
} finally {
    socket?.disconnect();
    try {
        ws?.close();
    } catch {
        // ignore
    }
    chrome.kill();
    await sleep(500);
    if (consoleLines.length > 0) {
        console.log('--- 页面日志 ---');
        console.log(consoleLines.slice(-80).join('\n'));
    }
    try {
        fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
        // ignore
    }
}
