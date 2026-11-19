import { defineNitroPlugin } from 'nitropack/runtime';
import { attachRealtime } from '../utils/realtime';

export default defineNitroPlugin((nitro) => {
    // @ts-expect-error - custom hook from @xarenas107/nuxt-socket-io
    nitro.hooks.hook('io:server:done', (io: any) => {
        const realtime = attachRealtime(io);

        // 服务关闭时清掉服务端时钟，避免残留定时器
        nitro.hooks.hook('close', realtime.stop);
    });
});
