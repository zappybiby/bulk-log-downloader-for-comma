# Privacy

This extension reads the useradmin page you select and requests the route pages
and comma-hosted blob files needed for your chosen download. It uses your normal
browser session for useradmin. The archive is assembled locally in the browser
and saved only when you choose Save ZIP.

The extension sends no logs or page contents to a developer, analytics provider,
archive server or other third party. It does not add telemetry, advertising or
tracking. Requests to useradmin and its blob storage are necessary to retrieve
the selected files.

File-type and date preferences are stored in local extension storage. Recording
dates are not cached between scans; page requests bypass the browser HTTP cache. Route
selection and download URLs are held in memory. Temporary ZIP bytes may be kept
in the extension's browser-private disk storage; clearing the prepared archive
removes that temporary copy. Closing or crashing the browser can leave temporary
data until browser data is cleared. Saved ZIP files are managed by Firefox and
Android and are not removed when temporary data is cleared.

The permissions are limited to local extension storage, useradmin.comma.ai, and
commadata2.blob.core.windows.net. No access to all browsing sites is requested.
