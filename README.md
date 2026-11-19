<a name="readme-top"></a>

<div align="center">
<h3 align="center">Live Subtitle</h3>
  <p align="center">
    基于 ASS 字幕的直播实时字幕工具
    <br />
    适用于固定字幕内容的直播（例如演唱会）实时字幕
    <br />
    Nuxt 4 + Nitro + Socket.io + JavascriptSubtitlesOctopus
  </p>
</div>

> 这是 2025 年夏天 [Liella! 频道](https://pd.qq.com/s/7nucz4r4z)对 [Liella! 1<sup>st</sup> Gen Live](https://zh.moegirl.org.cn/LoveLive!Superstar!!_Liella!_First_Generation_LoveLive!_~Wonderful_Starlines~) 进行转播时所用的实时字幕工具，在 2026 年 7 月借助 AI 进行重构与整理并开源。可能存在不合理之处，欢迎提交 Issue 和 Pull Request

> 我们也提供了截至当时所制作的全部字幕文件，包括字幕稿与 ASS 字幕，均经过人工校对，可在 [subtitleFiles](https://github.com/LiellaGuild/liveSubtitle/tree/main/subtitleFiles) 中查看

> 这个版本使用预制时间轴，在转播过程中有更好的效果。我们在 2024 年夏天开源过的版本，使用时需要人工打轴，请查看 [former](https://github.com/LiellaGuild/liveSubtitle/tree/former) 分支

![效果](./art/demo.jpg)

> _始まりは君の空_

<!-- TABLE OF CONTENTS -->
<details>
  <summary>目录</summary>
  <ol>
    <li><a href="#功能特性">功能特性</a></li>
    <li><a href="#技术栈">技术栈</a></li>
    <li><a href="#项目结构">项目结构</a></li>
    <li><a href="#快速开始">快速开始</a></li>
    <li><a href="#使用">使用</a></li>
    <li><a href="#多前端同步">多前端同步</a></li>
    <li><a href="#api-端点">API 端点</a></li>
    <li><a href="#socketio-事件">Socket.io 事件</a></li>
    <li><a href="#键盘控制">键盘控制</a></li>
    <li><a href="#lrc-自动生成字幕包">LRC 自动生成字幕包</a></li>
    <li><a href="#通用-assssa-字幕支持">通用 ASS/SSA 字幕支持</a></li>
    <li><a href="#字幕文件格式">字幕文件格式</a></li>
    <li><a href="#字幕制作工作流">字幕制作工作流</a></li>
    <li><a href="#许可证">许可证</a></li>
  </ol>
</details>

<!-- 功能特性 -->

## 功能特性

### 控制端 (`/`)

- Adobe Premiere Pro 风格的时间轴界面
- 双轨道设计（轨道 1 和轨道 2），可用于画外音、双主唱等字幕的定位
- 实时播放头显示，点击字幕块快速定位
- 自动播放功能
- 紧凑设计，适合小窗口
- 键盘控制支持
- 预设条件快速筛选字幕
- 支持同时打开多个控制端（多窗口 / 多设备），任一端的操作都会实时同步到其它控制端与展示端

### 展示端 (`/subtitle`)

- 1920×1080 全屏展示页面
- 使用 [JavascriptSubtitlesOctopus](https://github.com/libass/JavascriptSubtitlesOctopus) 渲染 ASS 字幕
- 支持大多数 SSA/ASS 功能（libass 所支持的一切）
- 读取系统已安装字体（TTF / OTF / TTC），由服务端按需提供给 libass 渲染
- Socket.io 事件驱动，服务端按 10Hz 下发播放时钟，内部计时器同步
- 断线/页面刷新后自动从服务端恢复当前字幕、字体与播放进度
- 可以同时打开多个展示端，所有展示端画面保持同步
- 透明背景，适合 OBS 叠加

### 字幕选择器

- 基于 JSON 配置的预设条件筛选
- 实时搜索过滤
- 字体下拉：读取系统已安装字体，可选「跟随原字幕」或强制使用某个系统字体；支持按族名/本地化名搜索字体；**全局生效**（切换歌曲后仍保持）
- 颜色直接跟随 ASS 文件本身：展示端按 ASS 样式渲染，控制端不做颜色改写

### 字幕来源

- 预制时间轴：优先读取编译产物中的 `.output/subtitleFiles/`；没有构建产物时才回退到项目根目录的 `subtitleFiles/`
- 通用 ASS/SSA：任意 ASS/SSA 字幕直接放入即可使用；没有 `config.txt` 时自动从 `[Events]` 解析时间轴
- LRC 生成器：`pnpm lrc2subtitle` 从 LRC 歌词一步生成可直接导入的字幕包；自动识别中/日/英语言，单文件内的双语对照会自动配对成原文 + 翻译

> 运行时会优先使用 `.output/subtitleFiles`（即 `D:\rakirGitHubRepos\liveSubtitle\.output\subtitleFiles`）。`pnpm build` 重建 `.output` 时会自动备份并恢复 `.output/subtitleFiles`，发布用的字幕不会因为构建被删除；如果该目录不存在或为空，构建时会用项目根目录的 `subtitleFiles` 初始化。开发时如果 `.output` 已存在，根目录 `subtitleFiles` 的改动不会自动生效；可用环境变量 `SUBTITLE_FILES_DIR` 直接指定实际读取的字幕目录，或把字幕同步到 `.output/subtitleFiles`。

<p align="right">(<a href="#readme-top">回到顶端</a>)</p>

## 技术栈

- **全栈框架**: [Nuxt 4](https://nuxt.com/)（Nitro Server Engine）
- **前端**: [Vue 3](https://vuejs.org/) + TypeScript
- **状态管理**: [Pinia](https://pinia.vuejs.org/)
- **实时通信**: [Socket.io](https://socket.io/) + [@xarenas107/nuxt-socket-io](https://nuxt.com/modules/socket-io)
- **字幕渲染**: [JavascriptSubtitlesOctopus](https://github.com/libass/JavascriptSubtitlesOctopus) (libass WASM)

<p align="right">(<a href="#readme-top">回到顶端</a>)</p>

## 项目结构

```
liveSubtitle_new/
├── pages/                   # 页面（Nuxt 文件路由）
│   ├── index.vue            # 控制端 /
│   └── subtitle.vue         # 展示端 /subtitle
├── components/              # Vue 组件
│   ├── Timeline.vue         # 时间轴组件
│   └── SubtitleSelector.vue # 字幕选择器
├── stores/                  # Pinia 状态管理
│   └── subtitle.ts          # 字幕全局状态
├── server/                  # Nitro 服务端
│   ├── api/                 # API 路由
│   │   ├── subtitles.get.ts         # GET /api/subtitles
│   │   ├── subtitle-file/[id].get.ts # GET /api/subtitle-file/:id
│   │   ├── subtitles/[id].get.ts    # GET /api/subtitles/:id
│   │   ├── filter-config.get.ts     # GET /api/filter-config
│   │   ├── font-options.get.ts      # GET /api/font-options（系统字体族名/别名）
│   │   ├── font-file/[token].ts     # GET /api/font-file/:token（系统字体文件）
│   │   └── health.get.ts            # GET /api/health
│   ├── plugins/
│   │   └── socket.ts        # Socket.io 插件入口（挂载多前端同步）
│   └── utils/
│       ├── ass.ts           # 通用 ASS/SSA 解析器（时间轴回退）
│       ├── fonts.ts         # 系统字体扫描/元数据解析/安全路径校验
│       ├── realtime.ts      # 多前端同步：角色房间、事件转发、服务端播放时钟
│       ├── session.ts       # 服务端权威会话状态（快照与进度锚点外推）
│       └── subtitle.ts      # 字幕数据读取工具
├── types/                   # TypeScript 类型定义
│   └── subtitle.ts
├── utils/                   # 客户端工具
│   ├── api.ts               # API 请求函数
│   ├── assColor.ts          # 通用 ASS 颜色处理工具（运行时不改写颜色）
│   ├── assFont.ts           # ASS 字体处理（字体下拉）
│   ├── fontLoader.ts        # 字体动态加载
│   └── keyboard.ts          # 键盘快捷键判断
├── public/                  # 静态资源
│   ├── js/                  # JavascriptSubtitlesOctopus WASM
│   └── fonts/               # 历史字体文件（新版本不再读取，可自行删除）
├── assets/
│   └── main.css             # 全局样式
├── shims/
│   └── debug.mjs            # debug 模块 ESM shim
├── test/
│   ├── client/              # 客户端工具与组件测试
│   ├── integration/         # LRC → 字幕包 → 服务端集成测试
│   ├── scripts/             # 生成器脚本测试
│   └── server/              # 服务端单元测试
├── scripts/                 # 工具脚本
│   ├── lrc2subtitle.js      # LRC → 可直接导入的字幕包（Node CLI）
│   ├── lyrics2ass.js        # 歌词 → ASS 转换
│   ├── generateConfig.js    # 配置生成
│   └── llwiki.js            # Wiki 数据抓取
├── nuxt.config.ts           # Nuxt 配置
├── tsconfig.json            # TypeScript 配置
├── vitest.config.ts         # Vitest 配置
├── .prettierrc              # Prettier 配置
└── package.json
```

<p align="right">(<a href="#readme-top">回到顶端</a>)</p>

## 快速开始

### 前置条件

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/installation) >= 9

### 安装

```bash
# 安装依赖
pnpm install
```

### 开发

```bash
# 启动开发服务器（前后端一体化）
pnpm dev
```

开发服务器默认运行在 `http://localhost:3000`

### 生产构建

```bash
# 构建
pnpm build

# 预览构建产物
pnpm preview
```

### 测试

```bash
# 运行测试
pnpm test

# 单次运行（CI）
pnpm test:run
```

### 代码格式化

```bash
pnpm lint
```

<p align="right">(<a href="#readme-top">回到顶端</a>)</p>

## 使用

### 展示端（OBS 叠加）

1. OBS Studio → 添加来源 → **浏览器**
2. URL 设为 `http://localhost:3000/subtitle`
3. 宽度 1920，高度 1080
4. 将此来源置于画面最上层

### 控制端

浏览器打开 `http://localhost:3000/`

- 上方时间轴：查看播放进度
- 播放头动画使用 `requestAnimationFrame` 直接更新 DOM，播放时间状态约 10Hz 写回，几百条字幕块的高负载场景下也不易卡顿
- 下方字幕选择器：搜索/筛选/选择字幕文件
- 选择文件后自动开始播放
- 可以同时打开多个控制端页面（不同窗口 / 设备），任一端操作都会同步到其它控制端与展示端，详见 [多前端同步](#多前端同步)
- 字幕颜色：直接跟随 ASS 文件中的样式颜色（控制端不再改色）
- 字体下拉：读取系统已安装字体，可选「跟随原字幕」（使用 ASS 样式里的 Fontname）或强制使用某个系统字体；旁边的搜索框可按族名或本地化名筛选，回车直接选中第一款匹配字体；**全局生效**（切换歌曲后仍保持）；切换后焦点会自动离开下拉框，空格键仍用于播放/暂停
- 字体不需要放进项目目录：展示端通过 `/api/font-file/:token` 只读取所选/ASS 引用到的系统字体文件，未安装的 ASS 字体将由系统回退字体兜底
- 字幕来源：把字幕目录（含任意 ASS/SSA 或 `config.txt`）放入 `.output/subtitleFiles/` 后刷新页面即可；开发环境没有 `.output` 时回退到项目根目录的 `subtitleFiles/`，也可用 `SUBTITLE_FILES_DIR` 指定，详见 [字幕文件格式](#字幕文件格式)

<p align="right">(<a href="#readme-top">回到顶端</a>)</p>

## 多前端同步

同一个服务可以同时连接多个控制端和多个展示端，所有前端共享服务端内存中的唯一会话状态：

- 任意控制端的操作（选字幕、播放/暂停、跳转、切换字体、临时隐藏字幕）先发送给服务端，再由服务端转发给其它控制端与所有展示端；操作者本地不回显，避免多端事件回环。
- 控制端连接、刷新或断线重连后会收到 `state-sync` 快照，立即恢复当前的歌曲、播放进度与全局字体，不需要重新选歌。
- 播放进度由服务端按 10Hz 统一向展示端下发；控制端各自从同一锚点外推进度，因此控制端页面关闭或切到后台被浏览器节流时，展示端仍会继续正常播放。
- 多个展示端（多个 OBS 浏览器来源 / 多个浏览器窗口）收到完全相同的状态与时钟。
- 服务端重启后，已打开的控制端会在重连时把本地状态重新播种给服务端，展示端随后恢复。

> 会话状态只保存在服务端进程内存中，多个服务实例之间不会共享；本工具按单实例部署设计。

<p align="right">(<a href="#readme-top">回到顶端</a>)</p>

## 键盘控制

| 按键   | 功能                                                 |
| ------ | ---------------------------------------------------- |
| `←`    | 暂时隐藏所有字幕渲染层（再按恢复显示）               |
| `↓`    | 轨道 1：播放下一条字幕，自动播放                     |
| `↑`    | 轨道 1：导航到上一条字幕并播放（没有上一条则不动作） |
| `A`    | 暂时隐藏所有字幕渲染层（再按恢复显示）               |
| `S`    | 轨道 2：播放下一条字幕，自动播放                     |
| `W`    | 轨道 2：导航到上一条字幕并播放（没有上一条则不动作） |
| `空格` | 播放 / 暂停切换（暂停后再按继续播放）                |

> 控制端时间轴下方有与上表一一对应的快捷键按钮（播放/暂停、隐藏/显示、上一条、下一条）：键盘不可用、焦点不在页面或使用触屏时可直接点击。按钮执行与按键完全相同的动作，点击后焦点会自动移出，空格键继续用于播放/暂停。
>
> 「隐藏」只隐藏展示端的字幕画布，不改变播放进度与播放状态：再次按 `←` / `A` 或点击按钮（此时按钮显示「显示」）即可恢复；切换字幕文件时也会自动恢复显示。

<p align="right">(<a href="#readme-top">回到顶端</a>)</p>

## LRC 自动生成字幕包

如果已有 `.lrc` 歌词文件，可用 `scripts/lrc2subtitle.js` 自动生成可直接导入项目的字幕目录，省去手工打轴：

```bash
# 单语：自动识别语言（中/日/英），生成 subtitleFiles/<歌曲名>/{config.txt,subtitle.ass}
pnpm lrc2subtitle song.lrc

# 单文件双语（如中英对照）：自动识别并配对原文/翻译，无需 --translation
pnpm lrc2subtitle "Payphone - Maroon 5,Wiz Khalifa.lrc"

# 双语：另附翻译 LRC，并把歌曲直接加入筛选器
pnpm lrc2subtitle song.lrc --translation song.zh.lrc --name "始まりは君の空" --filter "始まりは君の空" --filter-type album

# 纯中文歌曲：也可显式指定 --lang zh
pnpm lrc2subtitle chinese.lrc --lang zh
```

生成结果（默认输出到 `subtitleFiles/`）：

```
subtitleFiles/
├── filter-config.json        # 使用 --filter 时追加/更新
└── 始まりは君の空/
    ├── config.txt            # 时间轴：轨道,开始时间,结束时间,文本（原文）
    ├── subtitle.ass          # ASS 初稿（中文 pos(960,1020)，日文/英文 pos(960,1075)）
    └── lyrics.txt            # 有翻译时生成（--translation 或单文件自动配对）
```

生成后无需其它导入步骤，刷新控制端页面即可在字幕列表中选择。脚本生成的是**初稿**：逐词分词、注音（`日文-f-*`）与演唱者样式仍需在 Aegisub 中按 [字幕制作工作流](#字幕制作工作流) 精修。

### 参数

| 参数 | 说明 |
| --- | --- |
| `--name <名称>` | 歌曲名（同时作为输出目录名），默认取 `[ti:]` 或文件名 |
| `--out <目录>` | 输出根目录，默认 `subtitleFiles` |
| `--track <1\|2>` | 写入 `config.txt` 的轨道编号，默认 `1` |
| `--offset-ms <毫秒>` | 时间偏移（正数延后），叠加在 LRC 的 `[offset:]` 上，同时应用于翻译文件 |
| `--lang <auto\|ja\|zh\|en>` | 原文语言，默认 `auto`（按内容自动识别） |
| `--translation <文件>` | 翻译 LRC 文件；提供后生成双语 `subtitle.ass` 与 `lyrics.txt` |
| `--translation-lang <auto\|语言>` | 翻译语言，默认 `auto`（自动识别翻译文件） |
| `--no-auto-pair` | 关闭单文件内的双语自动识别与配对 |
| `--keep-credits` | 保留 LRC 开头的作词/作曲等制作信息行（默认过滤） |
| `--color <#RRGGBB>` | ASS 描边颜色，默认 `#A5469C`（Liella 紫） |
| `--font-ja <字体>` | 日文字体，默认 `Tsukushi A Round Gothic` |
| `--font-zh <字体>` | 中文字体，默认 `FZFW ZhuZi A YuanS` |
| `--filter <名称>` | 把歌曲追加到 `<out>/filter-config.json` 的指定筛选器 |
| `--filter-type <类型>` | 筛选器类型 `album` / `unit` / `live` / `solo`，默认 `album` |
| `--force` | 输出目录已存在时覆盖生成的文件（不删除目录内其它文件） |
| `--dry-run` | 只打印将生成的文件，不写入磁盘 |
| `--help` | 显示完整帮助 |

补充说明：

- 支持标准 LRC（`[mm:ss.xx]`、一行多个时间戳）、增强型 LRC 词时间戳与 `[ti:]` `[ar:]` `[al:]` `[by:]` `[offset:]` `[length:]` 元数据。
- **语言自动识别**：不传 `--lang` 时按内容识别原文语言（有假名→日文、有汉字→中文、只有拉丁字母→英文），可用 `--lang` 显式覆盖。
- **单文件双语自动配对**：一个 LRC 内同一时间戳下有两行（如中文 + 英文）时，会自动识别语言并配对成「原文 + 翻译」，无需再提供翻译文件；配对要求时间戳完全一致，且需要足够多的双行组（≥3 组、占全部时间戳组 ≥50%、语言混合占比 ≥80%），避免把单语和声/合唱误判为双语。显式 `--translation` 优先；`--no-auto-pair` 可关闭。
- **双语布局**：中文译文在上（`\pos(960,1020)`），英文/日文在下（`\pos(960,1075)`）；同一块两行语言相同时自动换到另一个位置，避免文字重叠。
- **制作信息过滤**：默认过滤行首为作词/作曲/编曲/Lyrics/Composer 等 `标签: 内容` 的 credits 行，并去除同一时间戳的重复行；`--keep-credits` 可保留。
- 纯中文/纯日文/纯英文单语歌曲会自动识别语言，只生成该语言的样式与字幕行；单语字幕默认沿用该语言在双语布局中的竖直位置，如需居中可在生成后调整 ASS 中的 `\pos`。
- 显式翻译文件按开始时间戳配对（容差 100ms）；两份 LRC 时间轴偏差较大时可先用 `--offset-ms` 对齐。
- 每行结束时间 = 下一行开始时间，最后一行 = 开始时间 + 5 秒；`[length:]` 用于检查是否超出歌曲时长。
- `--lang en` 的样式固定使用 Arial 字体；更多参数详见 `node scripts/lrc2subtitle.js --help`。

<p align="right">(<a href="#readme-top">回到顶端</a>)</p>

## API 端点

所有端点均在 Nuxt Nitro 服务端，端口 3000。

| 端点                         | 说明                                                       |
| ---------------------------- | ---------------------------------------------------------- |
| `GET /api/subtitles`         | 获取所有字幕文件列表                                       |
| `GET /api/subtitles/:id`     | 获取单个字幕文件详情                                       |
| `GET /api/subtitle-file/:id` | 获取原始 ASS 字幕文件内容                                  |
| `GET /api/filter-config`     | 获取过滤器配置                                             |
| `GET /api/font-options`      | 获取系统字体选项（族名/别名）                              |
| `GET /api/font-file/:token`  | 获取系统字体文件（仅允许系统字体目录内的 ttf/otf/ttc/otc） |
| `GET /api/health`            | 健康检查                                                   |

<p align="right">(<a href="#readme-top">回到顶端</a>)</p>

## Socket.io 事件

| 事件名 | 方向 | 说明 |
| --- | --- | --- |
| `register` | 任意客户端 → 服务端 | 登记角色 `control` / `display`，服务端随即回发 `state-sync` |
| `state-sync` | 服务端 → 请求方 | 权威会话快照：字幕、字体、播放状态、临时隐藏状态与服务端外推后的进度 |
| `play-state-change` | 控制端 → 服务端 → 其它控制端/展示端 | 播放/暂停状态切换，附带当前进度 |
| `time-sync` | 控制端 → 服务端 → 其它前端；服务端 → 展示端 | 显式跳转（点击/快捷键/微调）；播放中服务端按 10Hz 向展示端下发播放时钟 |
| `file-selected` | 控制端 → 服务端 → 其它控制端/展示端 | 字幕文件选择（附带当前全局字体，并恢复字幕显示） |
| `ass-content-update` | 控制端 → 服务端 → 其它前端 | 手动更新 ASS 内容（选文件时展示端会自行拉取） |
| `font-change` | 控制端 → 服务端 → 其它控制端/展示端 | 字体全局切换，展示端应用到所有字幕 |
| `subtitle-visibility-change` | 控制端 → 服务端 → 其它控制端/展示端 | 临时隐藏/恢复所有字幕渲染层（不改变播放进度），展示端据此隐藏画布 |
| `request-sync` | 任意客户端 → 服务端 | 主动请求 `state-sync` 补发当前状态（服务端直接回复，不再转发给控制端） |

<p align="right">(<a href="#readme-top">回到顶端</a>)</p>

## 字幕文件格式

### 目录结构

```
# 运行时优先使用编译产物中的目录
.output/
└── subtitleFiles/
    ├── filter-config.json      # 过滤器配置
    └── 歌曲名/                 # 每个歌曲一个文件夹
        ├── config.txt          # 时间轴配置（可选：缺省时自动从 ASS/SSA 的 [Events] 解析）
        ├── subtitle.ass        # ASS/SSA 字幕文件（文件名任意，见下方通用支持）
        └── lyrics.txt          # 原歌词文件（可选，不参与运行）

# 没有 .output 时回退到项目根目录（也是字幕制作的源目录）
subtitleFiles/
└── ...
```

目录内的字幕文件按 `subtitle.ass` → 其它 `*.ass` → `*.ssa` 的顺序查找使用；`config.txt` 能解析出时间轴时优先使用它，否则回退到 ASS/SSA。

### 通用 ASS/SSA 字幕支持

本项目的展示端本身使用 libass 渲染，支持 SSA/ASS 的全部表现形式；控制端的预制时间轴也可以直接从任意字幕文件解析，**不需要 `config.txt`**：

- 支持 ASS v4.00+ 与 SSA v4；`[Events]` / `[V4+ Styles]` / `[V4 Styles]` 的 `Format` 字段顺序任意，均按字段名解析。
- 字幕文件名任意（优先 `subtitle.ass`，其次其它 `*.ass`、`*.ssa`），放入 `subtitleFiles/<歌曲名>/` 后刷新控制端即可。
- 文件编码支持 UTF-8（含 BOM）、UTF-16LE、UTF-16BE，非 UTF-8 时回退 GB18030/GBK。
- 时间轴取所有 `Dialogue:` 行（忽略 `Comment:`），去掉 `{...}` 特效标签、把 `\N` / `\n` / `\h` 转为空格；`Layer`（或 SSA 的 `Marked`）大于 0 的事件进入轨道 2。
- 颜色完全由 ASS 文件中的样式决定（渲染端直接使用 ASS 颜色，控制端不做颜色替换）。

> 只有 ASS 而没有 `config.txt` 时，时间轴会包含字幕文件中的每一行（包括双语字幕的两行原文/译文）；需要更干净的轨道与预览文本时，仍建议提供 `config.txt`。

### lyrics.txt 格式

前四行为属性，之后为歌词正文：

```
歌曲名
译者（无译者时填词作者）
歌词来源（通常为 URL）
备注行（可留空）
中文歌词1
日文歌词1
中文歌词2
日文歌词2
```

> 可使用 `scripts/llwiki.js` 从 LLWiki 获取歌词（浏览器控制台执行）。

### subtitle.ass 格式

ASS 字幕样式命名规范：

| 样式模式 | 命名格式                   | 示例             |
| -------- | -------------------------- | ---------------- |
| 一般字幕 | `{语言}-{说话者罗马字}`    | `日文-Keke`      |
| 注音字幕 | `{语言}-f-{说话者罗马字}`  | `日文-f-Keke`    |
| 画外音   | `{语言}-外-{说话者罗马字}` | `中文-外-Liella` |

**分词**：

演出版和 CD 版存在差异的，以演出版为准。两人及以上同时演唱一部分时，使用 Liella 色，小组歌曲同样适用。

**轨道**：

- 轨道 1：主要轨道
- 轨道 2：次要轨道（通常用于画外音、第二主唱）

**歌词**：

非特殊情况以歌词本为准，包括断句。注音依照歌词本，应加于外文字幕正上方。单语字幕应调整竖直位置于双语字幕的垂直中心。

### config.txt 格式

每行用逗号分隔：

```
轨道编号,开始时间,结束时间,歌词文本
```

示例：

```
1,0:00:16.36,0:00:21.14,こんなとこじゃ終われないよ
1,0:00:21.63,0:00:26.08,一滴だけこぼす想い
```

- **轨道编号**: 1 或 2
- **时间格式**: `时:分:秒.毫秒`

> 可使用 `scripts/generateConfig.js` 从 ASS 文件的 `Dialogue:` 行自动生成 `config.txt`（浏览器控制台执行）。

### filter-config.json 格式

```json
[
    {
        "name": "始まりは君の空",
        "type": "album",
        "songs": ["始まりは君の空", "Dancing Heart La-Pa-Pa-Pa!"]
    }
]
```

- `type` 可选值：`album`（专辑/单曲）、`unit`（小组）、`live`（演出）、`solo`（独唱）

### 字体（系统字体）

字体不再从 `public/fonts` 读取，而是列出运行服务器的机器上**已安装的系统字体**：

- Windows：`%WINDIR%\Fonts` 与 `%LOCALAPPDATA%\Microsoft\Windows\Fonts`
- macOS：`/System/Library/Fonts`、`/System/Library/Fonts/Supplemental`、`/Library/Fonts`、`~/Library/Fonts`
- Linux：`/usr/share/fonts`、`/usr/local/share/fonts`、`~/.local/share/fonts`、`~/.fonts`

控制端「字体」下拉有两个选择：

- **跟随原字幕**（默认）：展示端解析 ASS 样式里的 `Fontname`（以及对话中的 `\fn` 行内覆盖），按族名、本地化族名、全名或 PostScript 名到系统字体列表中匹配并加载；同族只加载常规字重文件。
- **强制使用某个系统字体**：把该字体族名写入所有 ASS 样式，并加载该族的常规/粗体/细体等文件，因此同族字重仍能生效。

服务端只读取系统字体目录内的 `.ttf` / `.otf` / `.ttc` / `.otc`，通过 `/api/font-file/:token` 提供给展示端（路径必须位于上述字体目录内，无法读取任意文件）。字体列表按进程缓存 30 秒；新安装字体后最多等待 30 秒或重启服务即可看到。

若 ASS 引用的字体未安装，展示端会加载几款常用 CJK 回退字体（Windows 上优先 Microsoft YaHei UI / Microsoft YaHei / Yu Gothic UI），避免画面完全无字。即使主字体已安装，展示端也会额外加载一款 CJK 回退字体：当主字体缺少个别汉字/假名时，libass 会自动回退到该字体，避免出现豆腐块（例如 Yu Gothic UI 缺少部分简体字）。需要精确还原时，安装对应字体或在控制端强制选择一款系统字体。

`public/fonts/` 中的历史字体文件已不再参与读取，可以自行删除。

切换字体/筛选等设置后控制端会自动移走焦点，避免空格键被下拉框吃掉——之后直接按空格仍然是播放/暂停。

展示端加载字体会先逐个校验文件是否可访问：无法访问的字体自动跳过，避免个别字体缺失导致整个字幕渲染器报错、画面空白；字体列表接口已禁用缓存。若 OBS 浏览器来源仍在使用旧页面，请在来源属性中点击「刷新当前页面的缓存」后重试。

### 颜色

颜色在 ASS 字幕文件本身的样式中定义（`OutlineColour` / `TertiaryColour` 等），展示端直接按 ASS 渲染，控制端不做颜色替换。制作 ASS 时常用配色如下：

- #A5469C Liella
- #FF7F27 Kanon
- #43D1D9 Keke
- #FF6E90 Chisato
- #4B9C40 Sumire
- #0000A0 Ren
- #ABA229 Kinako
- #FF3535 Mei
- #7FB0A6 Shiki
- #FF51C4 Natsumi
- #D895F0 Margarete
- #27A7AE Tomari
- #FF683D SunnyPassion
- #9A1B5A Mao
- #B4AA2B Yuna

<p align="right">(<a href="#readme-top">回到顶端</a>)</p>

## 字幕制作工作流

### 1. 准备歌词

在 `subtitleFiles` 下以歌曲名创建文件夹，新建 `lyrics.txt`。

格式参考上方 [lyrics.txt 格式](#lyricstxt-格式)。对于 LLWiki 来源，可使用 `scripts/llwiki.js` 在浏览器控制台执行来获取歌词。

### 2. 生成 ASS 初稿

将 `scripts/lyrics2ass.js` 于浏览器控制台执行，在 `const lyrics = ``;` 的反引号中粘贴 `lyrics.txt` 全文，即可获得 ASS 字幕初稿。在歌曲文件夹中创建 `subtitle.ass`，粘贴内容。

### 3. 分词

在 VS Code 中打开 `subtitle.ass`。于字幕样式的 `中文-` 或 `日文-` 后输入说话人罗马字。单句内的分词使用 `{\r}` 标签切换样式。

### 4. 打轴

用 [Aegisub](https://github.com/Aegisub/Aegisub) 打开 `subtitle.ass` 文件。导入**演出版**视频，进行打轴。

### 5. 生成配置文件

将 `scripts/generateConfig.js` 于浏览器控制台执行，在 `const ass = ``.split('\n');` 的反引号中粘贴 `subtitle.ass` 中所有 `Dialogue:` 开头的行，生成 `config.txt` 内容。在歌曲文件夹中创建 `config.txt`，视情况调整轨道编号。

> 若已有 LRC 歌词，可用 [LRC 自动生成字幕包](#lrc-自动生成字幕包) 代替第 1、2、5 步：一次生成 ASS 初稿与 `config.txt` 时间轴，再按第 3、4 步做分词和精修；也可以只用 ASS 文件（不提供 `config.txt`），由服务端自动解析时间轴。

### 6. 添加筛选器

在 `subtitleFiles/filter-config.json` 中按 [filter-config.json 格式](#filter-configjson-格式) 添加条目。

### 7. 校对

- 模拟生产环境，在浏览器中检查字幕效果
- 机器校对：中日文标签、`{\r}` 格式、双轨时间一致性

<p align="right">(<a href="#readme-top">回到顶端</a>)</p>

## 许可证

以 MIT 协议开源。查看 [`LICENSE`](LICENSE) 以获取更多信息。

<p align="right">(<a href="#readme-top">回到顶端</a>)</p>
