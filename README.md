# PageNexus

PageNexus 是一个本地优先的桌面知识库应用。你可以创建知识库、上传文档、把文档交给 MinerU 精准解析，然后让 `pi-coding-agent` 直接在本地解析产物上做 `ls` / `find` / `grep` / `read` / `bash` 检索并回答。

当前实现重点：

- 桌面端：Tauri 2 + React + Vite
- 模型调用：PackyAPI
- 文档解析：MinerU precise parse API
- 检索方式：agent native filesystem retrieval
- 存储：本地 SQLite + 应用数据目录

## 功能

- 创建多个知识库
- 上传文档并解析
- 大 PDF 自动切块后上传到 MinerU
- 按 MinerU 原始 `content_list.json` 结构合并结果
- 生成适合 agent 检索的 `pages.json`、`fulltext.txt`、`parsed/full.md`
- 通过 `pi-coding-agent` 直接在本地文件上问答

## 技术栈

- Tauri 2
- React + Vite
- Tailwind CSS
- Rust
- `@mariozechner/pi-coding-agent`
- MinerU precise parse API
- SQLite

## 目录结构

```text
.
├── frontend/        React 桌面端 UI
├── node/            pi-coding-agent RPC wrapper
├── src-tauri/       Rust 后端与打包配置
├── .github/         GitHub Actions
└── pi-mono/         参考源码，不参与主应用运行
```

## 开发环境

本地需要这些基础环境：

- Node.js 20+
- npm
- Rust stable
- Cargo
- Tauri CLI 依赖

macOS 如果没有装 Rust：

```bash
curl https://sh.rustup.rs -sSf | sh
```

安装项目依赖：

```bash
cd /Users/llm/Desktop/Code/PageNexus
npm install
npm --prefix frontend install
```

运行测试：

```bash
cd /Users/llm/Desktop/Code/PageNexus
npm test
```

## 本地运行

开发模式启动：

```bash
cd /Users/llm/Desktop/Code/PageNexus
npm run dev
```

首次启动后，先进入 `Settings` 填这几个值：

- `PackyAPI API Key`
- `API Base URL`
- `Model ID`
- `MinerU API Token`

这些值会写到本地应用数据目录，不会写死在仓库里。

## 使用方式

1. 启动应用
2. 进入 `Settings` 保存 PackyAPI 和 MinerU 配置
3. 新建一个知识库
4. 上传文档
5. 等左侧状态从 `parsing` 变成 `parsed`
6. 在中间对话区直接提问

上传后，后端会做这些事：

1. 如果是大 PDF，先按大小和页数自适应切块
2. 调用 MinerU precise parse 批量上传和轮询
3. 下载每个 chunk 的结果 zip
4. 按原始 `content_list.json` 结构合并
5. 写入：
   - `pages.json`
   - `fulltext.txt`
   - `parsed/full.md`
   - `parsed/content_list.json`
   - `parsed/layout.json`
   - `parsed/images/`
6. 更新知识库根目录下的 `KB_INDEX.md`

agent 之后会优先基于这些解析结果进行检索。

## 本地打包

项目根目录已经配好 Tauri 打包。

直接打包：

```bash
cd /Users/llm/Desktop/Code/PageNexus
npm run build
```

只打 macOS DMG：

```bash
cd /Users/llm/Desktop/Code/PageNexus
cargo tauri build --bundles dmg
```

只打 Windows NSIS 安装器：

```bash
cd /Users/llm/Desktop/Code/PageNexus
cargo tauri build --bundles nsis
```

产物一般会在：

- `src-tauri/target/release/bundle/dmg/`
- `src-tauri/target/release/bundle/macos/`
- `src-tauri/target/release/bundle/nsis/`

## GitHub Actions 自动打包

现在可以自动打包，但触发方式只有两种：

- 手动触发 `workflow_dispatch`
- 推送 tag，格式为 `pagenexus-v*`

工作流文件：

- [.github/workflows/pagenexus-desktop-build.yml](/Users/llm/Desktop/Code/PageNexus/.github/workflows/pagenexus-desktop-build.yml)

当前会自动构建：

- macOS `.dmg`
- Windows `nsis` 安装器
- tag 构建成功后会把安装包上传到 GitHub Release assets

普通 `git push` 到分支不会自动打包。

如果你要发版并触发自动构建：

```bash
git tag pagenexus-v0.1.0
git push origin pagenexus-v0.1.0
```

## 当前打包逻辑说明

当前打包逻辑是对的，和现在仓库实现一致：

- 不再依赖 Python runtime
- 不再执行旧的 PyMuPDF bootstrap
- 打包资源只包含 Node sidecar
- 文档解析全部由 Rust + MinerU 驱动

我已经把 GitHub Actions 里残留的旧 Python bootstrap 步骤移除了。

## 运行时说明

PackyAPI 和 MinerU 的 key 都来自应用设置页。

所以：

- 本地开发不需要把 key 写进代码
- GitHub Actions 打包也不需要运行时 key
- 真正使用应用时，用户自己在设置页填入

## 注意事项

- `pi-mono/` 只是参考源码，不参与主应用运行
- 当前工作区里如果还有旧的本地应用数据，agent 可能会受旧 session 影响；必要时可清理应用数据目录
- KaTeX 字体在前端 build 时会有 warning，但不影响当前桌面应用主链路
