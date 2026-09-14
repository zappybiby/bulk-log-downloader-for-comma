# Comma Bulk Logs for Firefox

Experimental Firefox Android extension for collecting **rlogs and qlogs** from
useradmin.comma.ai into a ZIP. The Chrome extension in the repository root is
independent of this Firefox build.

## Use

1. Sign in to useradmin normally and open a device page or route page.
2. Open Firefox's extension menu and choose **Comma Bulk Logs for Firefox**.
3. In the new tab, select current route or listed routes, log types and dates.
4. Scan, review the file count, and prepare the ZIP.
5. Choose **Save ZIP**, then check Firefox Downloads before closing this tab.

Some routes expose only qlogs. A log viewer page is not a route download page;
open its route or device page before starting. Date filters use the upload dates
shown on useradmin, interpreted in your device's local time.

Keep both the source tab and downloader open while scanning; keep the downloader
in the foreground while preparing and saving. Preparation progress measures
fetching/archiving, not Firefox's final save. Android may suspend the process.
Signing into useradmin requires your existing account; the extension does not
store passwords or request a separate API token.

## Limits of this prototype

- Up to 256 MiB per archive by default, including ZIP headers. Choose fewer
  routes, a narrower date range or fewer log types if the limit is reached.
- Uses temporary browser disk storage when available; otherwise a memory
  fallback is capped at 32 MiB. Free space is needed for temporary and saved copies.
- ZIPs preserve route/type/segment filenames. Existing phone folders are not
  scanned. There is no camera support or background resume in this version.
- Cancel or a failed fetch discards the unfinished ZIP. Retry prepares the
  selection again. A failed/partial scan is not offered as a complete selection.
- Reading depends on useradmin's page markup and access permissions. Site
  changes may require parser updates.

## Development installation

This source and its packaged ZIP are **unsigned**. Firefox's ordinary install
flow requires Mozilla signing; renaming a ZIP to XPI does not sign it.

For an Android emulator or development device with adb, Nightly installed and
Remote debugging via USB enabled:

```sh
npm ci
npx web-ext run --source-dir firefox --target firefox-android --firefox-apk org.mozilla.fenix
```

For desktop development use `about:debugging` → This Firefox → Load Temporary
Add-on → `firefox/manifest.json`. This does not establish Android compatibility.

The manifest targets Firefox desktop 140+ and Android 142+, including current
Nightly. Actual Android evidence is produced by the synthetic emulator workflow
in this repository. Check its results before treating this prototype as validated.

## Build and check

```sh
npm test
npm run lint:firefox
npm run package:firefox
```

The packager includes only a named list of extension files. It excludes test
fixtures, captured pages, local artifacts and development dependencies.

For normal installation, submit the ZIP to Mozilla for unlisted signing, then
install the signed result using Firefox Android's Install Extension from File
option. See [Mozilla's Android testing guide](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/)
and [self-distributed installation guide](https://extensionworkshop.com/documentation/publish/install-self-distributed/).
