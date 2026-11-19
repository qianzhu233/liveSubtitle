import type { SessionState } from './session';
import {
    advancePlayback,
    applyFileSelected,
    applyFontChange,
    applyPlayStateChange,
    applyTimeSync,
    applyVisibilityChange,
    createSessionState,
    createSnapshot,
    projectCurrentTime,
} from './session';

export const CONTROL_ROOM = 'control';
export const DISPLAY_ROOM = 'display';
/** 展示端播放进度由服务端统一按 10Hz 下发，避免多个控制端各自发时钟互相打架 */
export const CLOCK_INTERVAL_MS = 100;

export interface RealtimeOptions {
    now?: () => number;
    setIntervalFn?: (handler: () => void, timeout: number) => any;
    clearIntervalFn?: (handle: any) => void;
    log?: (...args: any[]) => void;
}

export interface RealtimeController {
    state: SessionState;
    /** 停止服务端时钟（服务关闭/测试清理时调用） */
    stop: () => void;
}

/**
 * 把多前端同步逻辑挂到一个 socket.io server 上。
 *
 * 服务端保存唯一权威会话状态：
 * - 控制端登记为 control，可发送 file-selected / play-state-change / time-sync / font-change；
 *   服务端更新状态后转发给除发送者外的所有客户端（其它控制端 + 展示端）。
 * - 展示端登记为 display，只接收事件与服务端 10Hz 时钟，不作为状态来源。
 * - 新客户端连接时通过 state-sync 拿到完整快照；服务端时钟在播放期间持续外推进度，
 *   因此控制端关闭/后台节流后展示端仍能正常播放。
 */
export function attachRealtime(io: any, options: RealtimeOptions = {}): RealtimeController {
    const now = options.now ?? (() => Date.now());
    const setIntervalFn =
        options.setIntervalFn ??
        ((handler: () => void, timeout: number) => setInterval(handler, timeout));
    const clearIntervalFn = options.clearIntervalFn ?? ((handle: any) => clearInterval(handle));
    const log = options.log ?? ((...args: any[]) => console.log(...args));

    const session = createSessionState();
    let clock: any = null;

    const stopClock = () => {
        if (clock !== null) {
            clearIntervalFn(clock);
            clock = null;
        }
    };

    const tick = () => {
        const playback = advancePlayback(session, now());

        if (playback.finished) {
            log('[socket.io] 字幕播放结束');
            io.emit('play-state-change', {
                isPlaying: false,
                currentTime: playback.currentTime,
            });
            stopClock();
            return;
        }

        // 只驱动展示端；控制端各自从同一锚点外推，避免收到时钟后再回发
        io.to(DISPLAY_ROOM).emit('time-sync', {
            currentTime: playback.currentTime,
            serverTime: now(),
        });
    };

    const startClock = () => {
        if (clock !== null) return;
        clock = setIntervalFn(tick, CLOCK_INTERVAL_MS);
        (clock as any)?.unref?.();
    };

    const syncClock = () => {
        if (session.isPlaying) {
            startClock();
        } else {
            stopClock();
        }
    };

    io.on('connection', (socket: any) => {
        log('[socket.io] 客户端已连接:', socket.id);
        socket.data.role = '';

        // 连接后登记角色：展示端进入 display 房间，控制端进入 control 房间
        socket.on('register', (data: any) => {
            const role = data?.role === 'display' ? 'display' : 'control';
            socket.data.role = role;
            socket.join(role === 'display' ? DISPLAY_ROOM : CONTROL_ROOM);
            socket.emit('state-sync', createSnapshot(session, now()));
            syncClock();
        });

        // 主动请求补发状态（断线重连/手动刷新也可以走这里）
        socket.on('request-sync', () => {
            socket.emit('state-sync', createSnapshot(session, now()));
        });

        socket.on('file-selected', (data: any) => {
            if (!applyFileSelected(session, data, now())) return;
            log('[socket.io] 字幕文件已切换:', session.selectedFile?.id);
            socket.broadcast.emit('file-selected', {
                file: session.selectedFile,
                ...session.font,
                subtitlesHidden: session.subtitlesHidden,
            });
            syncClock();
        });

        socket.on('play-state-change', (data: any) => {
            if (!applyPlayStateChange(session, data, now())) return;
            socket.broadcast.emit('play-state-change', {
                isPlaying: session.isPlaying,
                currentTime: projectCurrentTime(session, now()),
            });
            syncClock();
        });

        socket.on('time-sync', (data: any) => {
            if (!applyTimeSync(session, data, now())) return;
            socket.broadcast.emit('time-sync', {
                currentTime: session.currentTime,
                serverTime: now(),
            });
        });

        socket.on('font-change', (data: any) => {
            if (!applyFontChange(session, data)) return;
            socket.broadcast.emit('font-change', session.font);
        });

        // 临时隐藏/恢复所有字幕渲染层：只同步可见性，不改变播放状态
        socket.on('subtitle-visibility-change', (data: any) => {
            if (!applyVisibilityChange(session, data)) return;
            socket.broadcast.emit('subtitle-visibility-change', {
                hidden: session.subtitlesHidden,
            });
        });

        socket.on('ass-content-update', (data: any) => {
            log('[socket.io] 收到ASS内容更新');
            socket.broadcast.emit('ass-content-update', data);
        });

        socket.on('disconnect', () => {
            log('[socket.io] 客户端已断开:', socket.id);
        });
    });

    return { state: session, stop: stopClock };
}
