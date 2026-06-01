# Privacy

Useradmin Route Log Downloader runs only on `useradmin.comma.ai`.

The extension reads the current useradmin page to find route links and selected segment file links. When a download is started, it fetches the selected files from comma-hosted blob storage and writes them to the folder selected in Chrome.

The selected file-type preference is stored locally in Chrome extension storage.

The extension does not collect, sell, share, or transmit user data to any service other than the comma.ai pages and storage URLs needed for the selected downloads. It does not use analytics, advertising, tracking, or external telemetry.

The selected download folder is accessed only through Chrome's folder picker permission for the current browser session.
