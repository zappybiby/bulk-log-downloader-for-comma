# Comma Bulk Logs for Firefox

Experimental Firefox Android extension for collecting **logs and optional camera files**
from useradmin.comma.ai into a ZIP. The Chrome extension in the repository root is
independent of this Firefox build.

## Use

1. Sign in to useradmin normally and open a device page or route page.
2. Open Firefox's extension menu and choose **Comma Bulk Logs for Firefox**.
3. Choose **This route** or **Device routes**, file types and upload dates.
4. Scan, review the file count, and prepare the ZIP.
5. Choose **Save ZIP**, then check Firefox Downloads before closing this tab.

Some routes expose only qlogs. A log viewer page is not a route download page;
open its route or device page before starting. From a route page, **Device routes**
can read that device's route list to apply a date filter.

## Date and file selection

Date filtering uses the **upload time** column in the device's route table,
matching the original extension's date source. Recording `start_time` and
`end_time`, `create_time`, firmware dates and timestamps embedded in route IDs
do not determine which routes match.

The filter compares calendar dates **as shown on the device page**. The site
captures do not declare a timezone, so displayed timestamps are not converted
to UTC or interpreted as a recording time. Today follows your phone's calendar.

- **Today**, **Last 7 days**, **Last 30 days**, **All**, and **Custom** are quick choices.
- An arbitrary number of days is also available, like the original extension.
- Last 7 days includes today and the previous six calendar dates. The exact
  inclusive range is displayed. This avoids the original extension's extra-day
  behavior, where its past-7 calculation covered eight calendar dates.
- Custom ranges include both the From and Through dates. Editing a date selects
  Custom; editing the day count selects the recent range.
- Routes with no readable upload date are excluded from date-filtered scans.
  **All** includes them. Dates apply to **Device routes**; **This route** collects
  the files on the open route page.

All six original file types are available: **rlog**, **qlog**, **qcamera**,
**fcamera**, **ecamera**, and **dcamera**. Camera choices are in a compact
disclosure. Only files already uploaded to comma can be collected. All matched
files of the selected types are included; individual route/segment picking is
not part of the original workflow or this version.

The compact page groups results by route and keeps Scan, Prepare ZIP and Save
ZIP in the bottom action bar. File names and supplementary help can be expanded
when needed.

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
  scanned; the original extension's folder picker and skip-existing behavior
  do not apply to ZIP output. There is no background resume in this version.
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
