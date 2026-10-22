# 哈哈阅读

纯本地、零依赖的 Web 电子书阅读器。支持 TXT 与 EPUB，可安装为 PWA 离线使用；书籍只保存在浏览器 IndexedDB 里，不上传、不联网。

![阅读器界面](docs/screenshot.png)

## 快速开始

需要 Node.js 20+（本项目零 npm 依赖，不用 `npm install`）。

```bash
node tools/serve.mjs
# 打开 http://127.0.0.1:5173
```

也可以指定端口：`node tools/serve.mjs 8080`。

想让同一 Wi-Fi 下的手机访问：`node tools/serve.mjs 5173 . 0.0.0.0`，启动后终端会打印局域网地址。注意局域网 http 不是安全上下文，Service Worker 不会注册，不能安装/离线；要装到手机请用 HTTPS 部署。

导入方式：点「导入书籍」选择文件，或直接把 `.txt` / `.epub` 拖进页面。TXT 会自动识别 UTF-8（含 BOM）与 GB18030。**手机上**先用微信/网盘/数据线把书保存到系统「文件」或「下载」目录，再点导入；文件选择器不按 MIME 过滤，避免 Android 把 EPUB 标成 `application/octet-stream` 后无法选中。

**安装成应用**：用 Chrome / Edge 打开后，地址栏右侧会出现安装图标（或菜单里的「应用 → 安装此站点」）。装好后可以独立窗口运行，断网也能继续读。

## 测试

环境里只需要 Node.js，不依赖 npm 安装任何东西：

```bash
# 单元测试：TXT 解码/切章/分段、EPUB 解析、ZIP、XML、SW 清单、搜索、进度计算（72 项）
node --test --test-isolation=none "tests/*.test.mjs"

# 静态冒烟：静态服务器、资源 MIME、manifest、SW、图标、404、路径穿越防护（33 项）
node tests/smoke.mjs

# 端到端：真实 Edge 无头浏览器，覆盖 TXT + EPUB + 书签 + 搜索 + PWA 离线（41 项）
node tests/e2e.mjs

# 性能基准：解析 / 单章渲染 / 搜索索引耗时
node tools/bench.mjs .tools/samples/hongloumeng.epub
```

如果本机装了 npm，也可以 `npm test`、`npm run smoke`、`npm run e2e`。

`tests/e2e.mjs` 需要浏览器能创建命名管道；在受限沙箱里会以退出码 2 跳过。

## 目录结构

```
index.html            单页外壳
manifest.webmanifest  PWA 清单（名称、图标、standalone）
sw.js                 Service Worker：预缓存外壳，离线可用
assets/style.css      样式与主题（CSS 变量）
assets/icon-*.png     PWA 图标（由 tools/make-icons.py 生成）
src/app.js            hash 路由：书架 / 阅读器
src/db.js             IndexedDB：books、files、progress
src/txt.js            TXT 解码、章节切分、段落重组（纯函数）
src/zip.js            ZIP 中央目录解析 + DecompressionStream 解压
src/xml.js            轻量 XML 解析/序列化（浏览器与 Node 共用）
src/epub.js           EPUB 解析：OPF / spine / nav / NCX / 封面 / 资源改写
src/epub-view.js      章节 iframe 挂载与高度自适应
src/library.js        书架、导入、封面、删除
src/reader.js         阅读器：滚动、进度、目录、书签、搜索、排版设置
src/search.js         全文搜索：索引提取、命中片段、结果截断
src/settings.js       排版设置、主题色、字体栈
src/format.js         百分比 / 大小 / 时间 / 转义
src/ui.js             toast 提示
tools/serve.mjs       开发用静态服务器
tools/make-icons.py   生成 PWA 图标
tools/bench.mjs       性能基准脚本
tests/*.test.mjs      单元测试（node:test）
tests/smoke.mjs       静态冒烟
tests/e2e.mjs         浏览器端到端
tests/fixtures/       EPUB 样书与生成脚本
docs/MVP.md           MVP 范围与架构
```

## 已实现

**M0 · TXT**

- 导入 TXT（UTF-8 / GB18030），章节自动切分，三种段落风格自适应
- 书架：进度百分比、最近阅读排序、删除（连带清除进度与文件）
- 阅读：单章滚动、上一章/下一章、键盘 ← → 与 Esc
- 排版：字号、行距、页边距、字体、浅色/护眼/夜间主题，全部持久化
- 进度：章节 + 章内比例，刷新/重开后恢复

**M1 · EPUB**

- 解析 ZIP（store/deflate）、container.xml、OPF、spine、nav（EPUB 3）与 NCX（EPUB 2）
- 目录抽屉直接使用书内目录标题，点击跳转并高亮当前章
- 章节内容放进同源 iframe 渲染：书内 CSS 不会污染阅读器界面，脚本一律不执行
- iframe 高度随内容自适应，外层仍是普通滚动容器，进度算法与 TXT 完全一致
- 图片、字体、CSS 中的 `url()` 全部改写为 blob URL，书内资源正常显示
- 提取封面并在书架显示；EPUB 原始文件单独存 `files` store，列表不加载大文件
- 切主题/字号会按当前进度重新排版，位置不丢
- **大文件自动按回拆分**：一个 XHTML 里塞了十几回的公版书（如 Gutenberg 中文书），按「第X回」拆成独立章节
- **纯文本型 EPUB 回退**：段落巨大、只有硬换行没有分段的"伪 EPUB"，提取纯文本走 TXT 的分章/分段引擎，读完照样是多段排版

![EPUB 阅读界面](docs/screenshot-epub.png)

**M2 · PWA 离线**

- `manifest.webmanifest`：名称、主题色、standalone 显示方式、192/512 与 maskable 图标
- Service Worker 预缓存整个应用外壳（HTML/CSS/JS/manifest/图标），刷新后老缓存自动清理
- 页面导航回退到缓存外壳，断网时照样能打开书架、读书
- 书籍数据本来就在 IndexedDB，离线不影响阅读与进度
- 浏览器安装条件检查零错误，可装到桌面 / 主屏独立运行
- 注册仅在安全上下文（https 或 localhost）进行，避免在 file:// 下报错

> 开发者注意：改动 `src/`、`assets/` 等静态资源后，记得递增 `sw.js` 里的 `VERSION`，否则老客户端会继续用旧缓存。

**M2 · 书签与全文搜索**

![搜索结果](docs/screenshot-search.png)

- 书签：任意位置收藏，面板内按章节顺序排列，点击跳回、可删除；删书时一并清理
- 全文搜索：首次搜索按章建立纯文本索引并存入 IndexedDB，之后直接复用；结果带上下文片段，点击跳到命中处并高亮
- 索引分片让出主线程（每 20 章一次），大书不会卡住页面
- 书签、搜索索引都在 DB v3 的两个新 store 里，与书籍数据同生命周期

**性能**

`node tools/bench.mjs <book.epub>` 可复现：

| 场景 | 结果 |
|---|---|
| 打开 1000 章 EPUB（解压 + spine + 目录） | ~270 ms |
| 单章 HTML 生成（红楼梦） | ~0.9 ms |
| 红楼梦搜索索引（896K 字） | ~70 ms |
| 搜索一次（1000 章书） | ~1 ms |

优化点：只对含多个「第X回/章」标记的文档做 DOM 解析（1000 章那种一章一文件的书直接跳过）、搜索索引按书缓存、同一文件的多回共享一次解析。

## 后续

M0–M2 已完成。下一步候选：目录虚拟滚动（几千章时更顺）、书内链接跳转、导出/备份书架、阅读统计。详见 [docs/MVP.md](docs/MVP.md)。
