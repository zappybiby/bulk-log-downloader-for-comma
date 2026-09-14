/* Local-only diagnostic. Supply external HTML files as CLI arguments.
 * Never copies the inputs or prints page content, titles, URLs, or filenames.
 * Do not run this against private inputs in remote CI.
 */
const fs = require("node:fs");
const { parseHTML } = require("linkedom");
const P = require("../firefox/parser.js");

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error("Usage: node tests/private-pages-check.cjs <local-html-path> [...]");
  process.exitCode = 2;
}

for (const [index, input] of inputs.entries()) {
  try {
    const { document } = parseHTML(fs.readFileSync(input, "utf8"));
    const base = `${P.PAGE_ORIGIN}/?onebox=invented-local-check-device`;
    const all = P.collectLogFiles(document, ["rlog", "qlog"], base);
    const table = document.querySelector("#table_routes");
    if (table) {
      const tableRoutes = P.collectRouteLinks(table, base);
      if (P.collectRouteLinks(document, base).length !== tableRoutes.length) throw new Error("Route table scope failed.");
    }
    for (const file of all) {
      if (!P.isAllowedDownloadUrl(file.url) || file.targetPath.split("/").length !== 3
          || /(?:^|\/)\.{1,2}(?:\/|$)|\\|[\x00-\x1f]/.test(file.targetPath)) {
        throw new Error("Download validation failed.");
      }
    }
    try {
      const result = P.snapshot(document, base, ["rlog", "qlog"]);
      if (result.files.length !== all.length) throw new Error("Snapshot file count differs.");
      console.log(JSON.stringify({ input: index + 1, status: "pass", kind: result.pageKind,
        routes: result.routes.length, datedRoutes: result.routes.filter(route => Number.isFinite(route.uploadedAt)).length,
        rlogFiles: result.files.filter(file => file.typeKey === "rlog").length,
        qlogFiles: result.files.filter(file => file.typeKey === "qlog").length,
        hasNextPage: Boolean(result.nextPageUrl) }));
    } catch (error) {
      if (!table && !all.length && /^This is a log viewer\./.test(error.message)) {
        console.log(JSON.stringify({ input: index + 1, status: "pass", kind: "log-viewer", supportedSource: false }));
      } else {
        throw error;
      }
    }
  } catch {
    // Do not print the underlying error: a file or parser error can include
    // private paths, page strings, and signed URL values.
    console.error(JSON.stringify({ input: index + 1, status: "failed", message: "Local page validation did not pass." }));
    process.exitCode = 1;
  }
}
