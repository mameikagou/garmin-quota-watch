# Garmin Quota Watch

在 Garmin vívoactive 5 上查看 AI 订阅额度、各周期重置时间和 Tibo 重置预告。GPT 与 Claude 分别提供独立的 glance，点开后使用同一份完整额度列表。

主页按 GPT、Claude、AGY、Devin、OpenCode、ZCode、WorkBuddy 排列，支持滑动和分账号详情。主数值 28px，概览数值 46px，包含界面实际使用的简体中文字形。Claude 显示美元余额；AGY 合并两个 Gemini 账号，最多 200%；ZCode 显示 GLM-5.3；WorkBuddy 显示剩余 credits/上限。只有来源返回的周期和重置时间会显示。

## 数据流

本机的 `upload.mjs` 每五分钟从 Magpie 和独立的 Antigravity CLI 读取额度，将摘要上传到 Cloudflare Worker + KV。`refresh.mjs` 每十五秒检查一次按需刷新队列；进入详情页会先显示缓存，再请求这一组来源，采集完成后手表自动重读。定时采集和按需采集共用本地采集记录与同一把分组锁：每组距离最近一次真实采集不足五分钟时直接使用本地结果，同时到达的请求等待正在执行的采集，失败也记入五分钟冷却且不自动重试。手表通过手机联网读取 Worker；账号身份只在本地映射成标签。

五分钟冷却使同一家上游在任意连续一天最多被真实采集 288 次，包含定时和按需两种入口，按需刷新不会提高原有定时任务的最坏请求数。同组的多个账号各自最多也是 288 次。

按十五秒轮询计算，本机刷新进程每天向 Worker 发 5,760 次请求。队列和按需结果由 SQLite Durable Object 保存，因此轮询产生 0 次 KV 读取、0 次 KV 写入、0 次 KV 列举；原有五分钟上传每天最多写 KV 288 次，只有 Tibo 缺失时才读取旧值，最多再读 KV 288 次。手表每次进入详情页另有一次触发请求和最多八次 KV 读取。达到七组每五分钟各采集一次的上限，并按每次采集对应一次详情请求、读满八次计算，Worker 与 Durable Object 请求、Durable Object 行读取均不超过 26,208 次，Durable Object 行写入不超过 4,320 次，KV 读取不超过 16,416 次，KV 写入固定为 288 次，KV 列举和删除均为 0 次，均低于免费额度。冷却期内重复进入详情页，每次只增加两次 Worker 与 Durable Object 请求、一次 KV 读取，不增加存储写入或上游采集。额度依据 [Workers KV](https://developers.cloudflare.com/kv/platform/pricing/) 与 [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/) 的免费方案。

Tibo 公告来自 [AIHOT 的公开 API](https://aihot.news/openapi-v1.json)，匿名访问，每十分钟最多请求一次，支持 ETag、压缩和失败保留。有效预告显示为一行醒目的“Tibo 2h 后”倒计时，没有预告时留空。使用该接口须遵守来源的个人非商业使用条件。

## 本机与 Worker

需要 Node.js 24+、Linux/WSL、`flock`，以及自己已登录的 Magpie/Antigravity CLI。

```sh
npm ci
cp sources.example.json sources.json
cp wrangler.example.jsonc wrangler.jsonc
node setup.mjs
npx wrangler login
npx wrangler kv namespace create QUOTA_KV
```

在本地 `wrangler.jsonc` 填入上一步的 KV namespace id，按需修改 Worker 名字。默认使用自己的 `workers.dev` 地址；自定义域名可在 Cloudflare 后台配置。运行：

```sh
node setup.mjs --secrets
npm run deploy
export QUOTA_ENDPOINT=https://quota.example.com
export MAGPIE_BIN=/path/to/magpie
npm run upload
npm run verify
```

把 `QUOTA_ENDPOINT` 换成自己的服务根地址。可参考 `.env.example` 设置环境变量；这些命令使用进程环境，不会自动读取 `.env`。本地开发使用 `npm run dev`，凭据由 `setup.mjs` 写入 `.dev.vars`。

`sources.json` 中的 provider 必须与自己的 Magpie 配置对应。可增删条目或设置 `enabled: false`。多个账号可指定不含个人信息的 `account` 标签；Antigravity 条目的 `command` 填写自己 CLI 的绝对路径或 PATH 中的命令。示例命令名需自行替换。支持的分组键见 `watch/source/QuotaData.mc`。

本地状态默认保存在 `~/.config/quota-watch/`。`QUOTA_CONFIG_DIR` 可改变整个目录，`QUOTA_SOURCES` 可指向独立的渠道配置文件。账号标签、Tibo 缓存、读写凭据和开发者签名私钥均属于本地配置。

需要定时上传和按需刷新时，修改两个 service 的 `WorkingDirectory`，在 `~/.config/quota-watch/upload.env` 填入 `QUOTA_ENDPOINT` 和包含 Node/CLI 的 `PATH`，再将 service、timer 安装到自己的 systemd 用户目录，启用 `quota-watch-upload.timer` 与 `quota-watch-refresh.service`。

## 编译两个手表应用

需要 Garmin Connect IQ SDK、vívoactive 5 设备包、Java、`uv`、`fonttools`、`fontbm` 和 Noto Sans CJK 字体。Debian/Ubuntu 可安装 `fonts-noto-cjk`；构建脚本使用系统的 Regular/Bold TTC 简体中文 face，自动提取界面中文字形。

将 Connect IQ SDK 路径设为 `CONNECTIQ_SDK`，将 fontbm 路径设为 `FONTBM`。默认路径分别是 `~/.local/share/garmin-connectiq/sdk` 和 `~/.local/bin/fontbm`。

自行准备两个有权使用的 PNG 图标，放到：

```text
watch/resources/icons/gpt.png
watch/resources/icons/cc.png
```

GPT/OpenAI 与 Claude 的官方标志属于各自权利人的商标。公开仓库提供源码，图标由使用者自行替换和取得使用许可。

```sh
export QUOTA_ENDPOINT=https://quota.example.com
npm run build:watch
```

构建后得到 `watch/bin/GPT.prg` 和 `watch/bin/Claude.prg`，两者使用不同 app id、同一份界面代码；由使用者自行安装到手表。首次构建会在本地配置目录生成签名私钥。`--package` 生成 IQ 包。`node watch/build.mjs --preview-announcement` 生成独立的预告截图应用，只在本地将 Tibo 公告替换成两小时倒计时，额度仍读取真实接口，也不会上传。

**PRG 和 IQ 包会嵌入自己的读取凭据，只用于个人安装。** `watch/private/`、`watch/bin/`、本地配置目录和自行添加的图标均不纳入 Git。

## 模拟器预览页面

Worker 的 `/design` 使用 `design/quota-v5.html`。在自己的模拟器中运行两款应用，截图文件名为：

```text
simulator.png
simulator-detail.png
simulator-gpt-announced.png
simulator-gpt.png
simulator-claude.png
```

可把自行生成的截图放入忽略的 `public/` 目录，随自己的 Worker 部署。个人 PRG 如需同页下载，也可自行放入此目录；该目录内的文件会公开可读，因此只应发布自己明确准备公开的内容。`npm run verify -- --artifacts` 可检查自己的下载文件与本地构建是否一致。

## 许可

源码使用 [MIT](LICENSE)。`watch/resources/fonts/` 的位图字形由 Noto Sans CJK SC 转换并取子集，使用独立的 [SIL OFL 1.1](watch/resources/fonts/OFL.txt)，版权和来源见 [NOTICE](watch/resources/fonts/NOTICE.txt)。品牌名称及商标归各自权利人所有。
