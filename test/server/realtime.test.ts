import { describe, it, expect, beforeEach } from 'vitest';
import { attachRealtime, type RealtimeController } from '../../server/utils/realtime';
import type { SubtitleFile } from '../../types/subtitle';

type Listener = (...args: any[]) => void;

class FakeSocket {
    readonly data: Record<string, any> = {};
    readonly rooms = new Set<string>();
    received: Array<[string, any]> = [];
    private listeners = new Map<string, Listener[]>();

    constructor(
        private readonly io: FakeIo,
        readonly id: string,
    ) {}

    get broadcast() {
        return {
            emit: (event: string, payload: any) => this.io.broadcastFrom(this, event, payload),
        };
    }

    on(event: string, listener: Listener) {
        const list = this.listeners.get(event) ?? [];
        list.push(listener);
        this.listeners.set(event, list);
    }

    join(room: string) {
        this.rooms.add(room);
    }

    emit(event: string, payload: any) {
        this.received.push([event, payload]);
    }

    trigger(event: string, payload?: any) {
        for (const listener of this.listeners.get(event) ?? []) {
            listener(payload);
        }
    }

    events(event: string): any[] {
        return this.received.filter(([name]) => name === event).map(([, payload]) => payload);
    }

    clear() {
        this.received = [];
    }
}

class FakeIo {
    readonly sockets: FakeSocket[] = [];
    private connectionListeners: Listener[] = [];

    on(event: string, listener: Listener) {
        if (event === 'connection') {
            this.connectionListeners.push(listener);
        }
    }

    connect(id: string): FakeSocket {
        const socket = new FakeSocket(this, id);
        this.sockets.push(socket);
        for (const listener of this.connectionListeners) {
            listener(socket);
        }
        return socket;
    }

    emit(event: string, payload: any) {
        for (const socket of this.sockets) {
            socket.received.push([event, payload]);
        }
    }

    to(room: string) {
        return {
            emit: (event: string, payload: any) => {
                for (const socket of this.sockets) {
                    if (socket.rooms.has(room)) {
                        socket.received.push([event, payload]);
                    }
                }
            },
        };
    }

    broadcastFrom(sender: FakeSocket, event: string, payload: any) {
        for (const socket of this.sockets) {
            if (socket !== sender) {
                socket.received.push([event, payload]);
            }
        }
    }
}

/** 手动调度的时钟，配合可控的 now() 精确验证服务端外推 */
class ManualClock {
    private handlers = new Map<number, () => void>();
    private nextId = 1;

    setIntervalFn = (handler: () => void): any => {
        const id = this.nextId++;
        this.handlers.set(id, handler);
        return { id, unref: () => {} };
    };

    clearIntervalFn = (handle: any) => {
        this.handlers.delete(handle.id);
    };

    get running(): boolean {
        return this.handlers.size > 0;
    }

    fire() {
        for (const handler of [...this.handlers.values()]) {
            handler();
        }
    }
}

const testFile: SubtitleFile = {
    id: 'song',
    name: 'song',
    duration: 30,
    blocks: [],
    createdAt: '',
    updatedAt: '',
};

const filePayload = {
    file: testFile,
    fontFile: 'regular.ttf',
    fontFamily: 'Test Font',
    fontUrl: '/api/font-file/regular',
    fontUrls: ['/api/font-file/regular'],
};

let io: FakeIo;
let clock: ManualClock;
let nowMs: number;
let realtime: RealtimeController;

const register = (id: string, role: 'control' | 'display' = 'control'): FakeSocket => {
    const socket = io.connect(id);
    socket.trigger('register', { role });
    return socket;
};

beforeEach(() => {
    io = new FakeIo();
    clock = new ManualClock();
    nowMs = 0;
    realtime = attachRealtime(io, {
        now: () => nowMs,
        setIntervalFn: clock.setIntervalFn,
        clearIntervalFn: clock.clearIntervalFn,
        log: () => {},
    });
});

describe('多前端同步：角色登记与快照', () => {
    it('控制端/展示端登记后都收到空会话快照', () => {
        const control = register('control-1');
        const display = register('display-1', 'display');

        expect(control.events('state-sync')).toEqual([
            expect.objectContaining({
                selectedFile: null,
                isPlaying: false,
                currentTime: 0,
                fontFamily: '',
            }),
        ]);
        expect(display.events('state-sync')).toHaveLength(1);
        expect(control.rooms.has('control')).toBe(true);
        expect(display.rooms.has('display')).toBe(true);
    });

    it('request-sync 只向请求者补发快照', () => {
        const control = register('control-1');
        const other = register('control-2');
        control.clear();
        other.clear();

        control.trigger('request-sync');

        expect(control.events('state-sync')).toHaveLength(1);
        expect(other.events('state-sync')).toHaveLength(0);
    });

    it('播放中后加入的控制端拿到按服务端时间外推的进度', () => {
        const control = register('control-1');
        control.trigger('file-selected', filePayload);
        nowMs = 1000;
        control.trigger('play-state-change', { isPlaying: true, currentTime: 10 });

        nowMs = 3000;
        const late = register('late-control');

        expect(late.events('state-sync')[0]).toMatchObject({
            selectedFile: expect.objectContaining({ id: 'song' }),
            isPlaying: true,
            currentTime: 12,
            duration: 30,
        });
    });
});

describe('多前端同步：操作转发', () => {
    it('选文件转发给其它控制端与展示端，发送者不回显', () => {
        const control = register('control-1');
        const other = register('control-2');
        const display = register('display-1', 'display');
        control.clear();
        other.clear();
        display.clear();

        control.trigger('file-selected', filePayload);

        for (const target of [other, display]) {
            expect(target.events('file-selected')).toEqual([
                expect.objectContaining({
                    file: expect.objectContaining({ id: 'song' }),
                    fontFamily: 'Test Font',
                    fontUrls: ['/api/font-file/regular'],
                }),
            ]);
        }
        expect(control.events('file-selected')).toHaveLength(0);
        expect(realtime.state.selectedFile?.id).toBe('song');
    });

    it('播放/暂停带上服务端进度并转发', () => {
        const control = register('control-1');
        const other = register('control-2');
        const display = register('display-1', 'display');
        control.trigger('file-selected', filePayload);
        other.clear();
        display.clear();

        nowMs = 1000;
        control.trigger('play-state-change', { isPlaying: true, currentTime: 10 });

        expect(other.events('play-state-change')).toEqual([{ isPlaying: true, currentTime: 10 }]);
        expect(display.events('play-state-change')).toEqual([{ isPlaying: true, currentTime: 10 }]);

        other.clear();
        display.clear();
        nowMs = 3000;
        control.trigger('play-state-change', { isPlaying: false, currentTime: 12.5 });

        expect(other.events('play-state-change')).toEqual([
            { isPlaying: false, currentTime: 12.5 },
        ]);
        expect(display.events('play-state-change')).toEqual([
            { isPlaying: false, currentTime: 12.5 },
        ]);
    });

    it('显式跳转转发给所有其它前端并更新锚点', () => {
        const control = register('control-1');
        const other = register('control-2');
        const display = register('display-1', 'display');
        control.trigger('file-selected', filePayload);
        other.clear();
        display.clear();

        nowMs = 1000;
        other.trigger('time-sync', { currentTime: 20 });

        expect(control.events('time-sync')).toEqual([{ currentTime: 20, serverTime: 1000 }]);
        expect(display.events('time-sync')).toEqual([{ currentTime: 20, serverTime: 1000 }]);

        nowMs = 3000;
        expect(register('late-control').events('state-sync')[0]).toMatchObject({
            currentTime: 20,
            isPlaying: false,
        });
    });

    it('字体切换转发最新的完整字体负载', () => {
        const control = register('control-1');
        const other = register('control-2');
        const display = register('display-1', 'display');
        other.clear();
        display.clear();

        control.trigger('font-change', {
            fontFamily: 'Test Font',
            fontFile: 'regular.ttf',
            fontUrl: '/api/font-file/regular',
            fontUrls: ['/api/font-file/regular', '/api/font-file/bold'],
        });

        for (const target of [other, display]) {
            expect(target.events('font-change')[0]).toEqual({
                fontFile: 'regular.ttf',
                fontFamily: 'Test Font',
                fontUrl: '/api/font-file/regular',
                fontUrls: ['/api/font-file/regular', '/api/font-file/bold'],
            });
        }
    });

    it('临时隐藏/恢复字幕转发给其它控制端与展示端，发送者不回显', () => {
        const control = register('control-1');
        const other = register('control-2');
        const display = register('display-1', 'display');
        control.trigger('file-selected', filePayload);
        control.clear();
        other.clear();
        display.clear();

        control.trigger('subtitle-visibility-change', { hidden: true });

        expect(control.events('subtitle-visibility-change')).toHaveLength(0);
        expect(other.events('subtitle-visibility-change')).toEqual([{ hidden: true }]);
        expect(display.events('subtitle-visibility-change')).toEqual([{ hidden: true }]);

        // 相同状态不重复广播
        other.clear();
        display.clear();
        control.trigger('subtitle-visibility-change', { hidden: true });
        expect(other.events('subtitle-visibility-change')).toHaveLength(0);
        expect(display.events('subtitle-visibility-change')).toHaveLength(0);

        control.trigger('subtitle-visibility-change', { hidden: false });
        expect(other.events('subtitle-visibility-change')).toEqual([{ hidden: false }]);
        expect(display.events('subtitle-visibility-change')).toEqual([{ hidden: false }]);
    });

    it('临时隐藏状态进入快照，切换字幕文件后恢复显示', () => {
        const control = register('control-1');
        const display = register('display-1', 'display');
        control.trigger('file-selected', filePayload);
        control.trigger('subtitle-visibility-change', { hidden: true });

        expect(register('late-control').events('state-sync')[0]).toMatchObject({
            subtitlesHidden: true,
        });
        expect(register('late-display', 'display').events('state-sync')[0]).toMatchObject({
            subtitlesHidden: true,
        });

        display.clear();
        control.trigger('file-selected', filePayload);

        expect(display.events('file-selected')[0]).toMatchObject({ subtitlesHidden: false });
        expect(register('after-file').events('state-sync')[0]).toMatchObject({
            subtitlesHidden: false,
        });
    });

    it('ASS 内容更新只转发给其它前端', () => {
        const control = register('control-1');
        const display = register('display-1', 'display');
        display.clear();

        control.trigger('ass-content-update', { assContent: '[Script Info]' });

        expect(display.events('ass-content-update')).toEqual([{ assContent: '[Script Info]' }]);
        expect(control.events('ass-content-update')).toHaveLength(0);
    });
});

describe('多前端同步：服务端时钟', () => {
    it('播放时只向展示端下发时钟，控制端不收到', () => {
        const control = register('control-1');
        const other = register('control-2');
        const display = register('display-1', 'display');
        control.trigger('file-selected', filePayload);
        nowMs = 1000;
        control.trigger('play-state-change', { isPlaying: true, currentTime: 10 });
        other.clear();
        display.clear();

        nowMs = 2000;
        clock.fire();

        expect(display.events('time-sync')).toEqual([{ currentTime: 11, serverTime: 2000 }]);
        expect(control.events('time-sync')).toHaveLength(0);
        expect(other.events('time-sync')).toHaveLength(0);
        expect(clock.running).toBe(true);
    });

    it('暂停后停止时钟且不再推进', () => {
        const control = register('control-1');
        const display = register('display-1', 'display');
        control.trigger('file-selected', filePayload);
        nowMs = 1000;
        control.trigger('play-state-change', { isPlaying: true, currentTime: 10 });
        nowMs = 2000;
        control.trigger('play-state-change', { isPlaying: false, currentTime: 11 });

        expect(clock.running).toBe(false);

        display.clear();
        nowMs = 5000;
        clock.fire();
        expect(display.events('time-sync')).toHaveLength(0);
        expect(realtime.state.currentTime).toBe(11);
    });

    it('到达结尾时向所有前端广播暂停（回到起点）并停止时钟', () => {
        const control = register('control-1');
        const other = register('control-2');
        const display = register('display-1', 'display');
        control.trigger('file-selected', filePayload);
        nowMs = 1000;
        control.trigger('play-state-change', { isPlaying: true, currentTime: 29 });
        control.clear();
        other.clear();
        display.clear();

        nowMs = 3000;
        clock.fire();

        expect(clock.running).toBe(false);
        for (const target of [control, other, display]) {
            expect(target.events('play-state-change')).toEqual([
                { isPlaying: false, currentTime: 0 },
            ]);
        }
        expect(realtime.state.isPlaying).toBe(false);
        expect(realtime.state.currentTime).toBe(0);
    });

    it('停止后不会残留定时器', () => {
        const control = register('control-1');
        control.trigger('file-selected', filePayload);
        nowMs = 1000;
        control.trigger('play-state-change', { isPlaying: true, currentTime: 10 });

        expect(clock.running).toBe(true);
        realtime.stop();
        expect(clock.running).toBe(false);
    });
});
