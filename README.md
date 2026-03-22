# PageNexus

PageNexus is a local-first desktop knowledge-base app built with Tauri, React, and `pi-coding-agent`.

Users can:

- create knowledge bases
- upload and parse local documents
- ask questions against parsed materials
- watch the agent use native file tools such as `ls`, `find`, `grep`, `read`, and `bash`

The parser now uses MinerU precise parsing orchestrated from Rust. Large PDFs are split adaptively, uploaded in chunks, then merged back into a single structured result. Runtime keys are configured inside the app, not hardcoded in the repository.

## Stack

- Tauri 2
- React + Vite
- Tailwind CSS
- `@mariozechner/pi-coding-agent`
- MinerU precise parse API
- adaptive PDF split/merge in Rust
- SQLite

## Project Layout

```text
.
├── frontend/        React desktop UI
├── node/            Node wrapper for pi-coding-agent RPC mode
├── src-tauri/       Rust backend and Tauri bundle config
└── .github/         CI workflows
```

## Local Development

Install dependencies:

```bash
npm install
npm --prefix frontend install
```

Run the desktop app:

```bash
npm run dev
```

On first launch, open `Settings` and fill in:

- `PackyAPI API Key`
- `API Base URL`
- `Model ID`
- `MinerU API Token`

Run all tests:

```bash
npm test
```

Build a local production package:

```bash
npm run build
```

## Runtime Settings

After launching the app, open `Settings` and configure:

- `PackyAPI API Key`
- `API Base URL`
- `Model ID`
- `MinerU API Token`

Those values are stored in the app data directory as local settings. Packy settings are used by the coding agent runtime; the MinerU token is used for document parsing.

## Packaging

macOS:

```bash
cargo tauri build --bundles dmg
```

Windows:

```bash
cargo tauri build --bundles nsis
```

## CI

GitHub Actions workflow:

- `.github/workflows/pagenexus-desktop-build.yml`

It builds:

- macOS `.dmg`
- Windows `nsis` installer

The workflow does not require a PackyAPI runtime key, because the packaged app reads that from the local settings UI.
