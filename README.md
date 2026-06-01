# Comma Log Downloader

Chrome extension for downloading selected comma useradmin route segment files into local route and file-type folders.

This project is not affiliated with comma.ai.

## Features

- Downloads `rlog.zst`, `qlog.zst`, `qcamera.ts`, `fcamera.hevc`, `ecamera.hevc`, and `dcamera.hevc` files exposed by comma useradmin route pages.
- Writes each route to a folder named like `dongle__route`.
- Writes each selected file type to its own subfolder under the route folder.
- Skips files already present in the selected download folder.
- Supports one route, all visible route pages, recent routes, or a custom upload-date range.
- Restores the selected file-type preference with Chrome extension storage.

## Install For Local Use

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Choose Load unpacked.
5. Select this repository folder.

## Usage

Open `https://useradmin.comma.ai/` while signed in.

`Select DL Folder` selects the root destination for the current page session and indexes existing target paths before downloads begin.

`D/L Route` appears on route pages with supported segment files and downloads the route shown on the page.

`D/L Routes` appears on device pages with route links, follows additional route-list pages when useradmin exposes a Load more link, and downloads selected file types for each matching route.

Keep the useradmin page open while downloads are running.

## Package

Run this from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\package.ps1
```

The release ZIP is written to `dist/`. Build output is intentionally ignored by git; attach the ZIP to a GitHub release or upload it to the Chrome Web Store.

## Privacy And Permissions

The extension runs only on `https://useradmin.comma.ai/*` and downloads files from `https://commadata2.blob.core.windows.net/*`. It stores only the selected file-type preference in local Chrome extension storage.

See [PRIVACY.md](PRIVACY.md) for the full privacy statement.

## Development

There are no npm dependencies. The source files are plain Manifest V3 extension files:

- `manifest.json`
- `content.js`
- `worker.js`
- `styles.css`
- `icons/`

GitHub Actions validates JSON parsing, PowerShell packaging, release ZIP creation, and LF line endings.

## License

No license has been selected yet. Choose and add a `LICENSE` file before publishing this as an open-source repository.
