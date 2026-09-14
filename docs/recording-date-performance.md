# Recording-date discovery: speed experiments

**Recommendation:** use a small parallel request pool and a recording-date cache
for the existing useradmin workflow. Investigate bulk API metadata as a separate
way to make the first scan faster, after verifying authentication, date semantics
and complete pagination. Four workers are a conservative starting point to tune;
they are not a proven optimum or a documented useradmin limit.

These are research prototypes and benchmarks. The packaged v0.2 extension still
uses its existing upload-date scan; these optimizations and recording-date
filtering have not been integrated into that build.

## Routes are the unit of discovery

A route page contains recording metadata and file links for many segments. Read
it once, find the recording date, and collect matching file links from that same
response. Metadata discovery does not require downloading the rlogs or videos.
For example, 600 rlogs spread over 30 routes can need 30 detail reads, plus listing
pages, rather than 600 metadata reads. The later ZIP preparation still downloads
every selected file.

The experiments deliberately cover **300 and 1,000 routes**, a heavier discovery
workload than hundreds of files within a few routes. The localhost fixture has
120 file links per route and selects 20 rlogs per matching route. At 1,000 routes,
all four strategies found the same 114 routes and 2,280 rlogs.

## Measured local experiment

A real HTTP server bound only to localhost served invented listing and route
HTML. Requests incurred an artificial 15 ms response delay. Node fetched the
pages; linkedom parsed them, using the extension's existing route and file
parsers plus an experimental recording-date extractor. Assertions checked exact
selected route IDs, file counts, request counts and bounded concurrency.

| Strategy | 300 routes | 1,000 routes | Requests at 1,000 |
| --- | ---: | ---: | ---: |
| Sequential, first scan | 6.74 s | 20.34 s | 1,020 |
| 4 parallel reads, first scan | 2.54 s | 7.17 s | 1,020 |
| 8 parallel reads, first scan | 1.72 s | 5.33 s | 1,020 |
| Mostly cached, 4 parallel reads | 0.58 s | 1.90 s | 245 |

The repeat-scan fixture had 868 usable date entries out of 1,000 routes. Missing,
unknown, live and expired metadata was refetched. Selected route pages were also
refetched for current download links, with no duplicate read when a newly
examined route matched. This reduced total requests from 1,020 to 245 and response
data from about 17.1 MiB to 3.9 MiB.

These are single-run **Node/localhost measurements**, not timings from Firefox,
Android or comma's servers. The loopback run has no mobile bandwidth bottleneck
or rate limiter. Cache storage and account lifecycle are simulated. It establishes
that the scheduling/parsing approach works and reduces requests; it does not
establish live scan duration. Raw evidence: [local-results.json](../bench/recording-discovery/local-results.json).

## Network simulation

A separate deterministic event model varies latency, shared bandwidth, serial
HTML parsing and server pressure. Its ordinary profile assumes 180 ms round-trip
latency, 4 MiB/s shared bandwidth and invented route pages averaging about 70 KiB.
It also includes sequential listing-page reads and fresh selected-route pages.
The following numbers are **modeled predictions under those assumptions**:

| Strategy | Modeled seconds, 1,000 routes | Detail pages | Total requests |
| --- | ---: | ---: | ---: |
| Sequential | 205.20 | 1,000 | 1,010 |
| 4 workers | 53.37 | 1,000 | 1,010 |
| 6 workers | 37.06 | 1,000 | 1,010 |
| 8 workers | 29.64 | 1,000 | 1,010 |
| 95% initially cached, 4 workers | 11.89 | 190 | 200 |
| Bulk metadata + 4 workers, access/contract unverified | 8.20 | 114 | 125 |

More parallel requests do not always improve speed. At an assumed 0.75 MiB/s,
six workers took 93.76 modeled seconds and eight took 93.67. A separate,
**hypothetical** four-slot server stress case made eight workers slower than four:
55.43 versus 53.37 seconds, with 92 additional HTTP 429 responses. This is a
reason to tune concurrency and back off on pressure, not evidence that comma's
HTML server has four slots. Adaptive concurrency itself is not yet benchmarked.

The simulation uses a different, larger-page fixture than the local experiment;
its absolute timings are not directly comparable. It excludes file transfers,
ZIP preparation, rendering, cache I/O and connection setup. Raw assumptions and
all scenarios: [simulation-results.json](../bench/recording-discovery/simulation-results.json).

## Shortcuts checked for correctness

**Use upload dates as recording dates:** rejected. In the 1,000-route simulation,
a past custom range lost 45 correct routes uploaded later and included 45 wrong
ones. Recording dates are deliberately unsorted relative to uploads.

**Use only an upload lower bound, then read recording metadata:** conditionally
useful. With trustworthy, comparable clocks, an upload cannot precede recording;
checking only upload >= range start keeps later uploads beyond a custom range's
end. The model reduced cold detail reads to 244 and retained the correct routes.
However, an explicit clock/calendar mismatch made this rule miss a route. It is
not a safe universal exclusion rule with the current timestamp guarantees.

**Decode or sort route IDs:** rejected as a general solution. Modern openpilot
builds identifiers from a route counter and random hex, so the identifier cannot
supply a recording date. Older timestamp names can also inherit device-clock
problems. See [openpilot logger source](https://github.com/commaai/openpilot/blob/26899177578542b7eb7b8b2795f755e73bd17b1c/openpilot/system/loggerd/logger.cc).

**Cache recording metadata:** effective for repeat scans, subject to freshness.
Store dates, provenance, version and refresh time, not signed URLs or page HTML.
The model expires active entries quickly and retries unknown dates. Completed
entries are assumed stable within a 24-hour TTL; an upstream correction can
invalidate that assumption. Refresh must be available. Durable entries should
be scoped to account/device and cleared appropriately; use a session cache until
account identity can be established reliably. Re-read selected pages for fresh
links, then recheck their recording dates before accepting files.

## Bulk metadata: promising, not yet integrated

Comma's current Connect client calls `routes_segments` with start, end and limit
parameters and consumes route/segment recording timestamps. This supports
investigating a bulk catalog instead of individual HTML pages. The public client
alone does not prove backend filtering semantics, result caps or complete route
coverage. See the [API client](https://github.com/commaai/connect/blob/734fb4afa49b60f27575220aa09de03e39f31b86/src/api.js)
and [recording-time consumer](https://github.com/commaai/connect/blob/734fb4afa49b60f27575220aa09de03e39f31b86/src/actions/index.js).

The [official API specification](https://api.comma.ai/#segments) also documents
bulk segment metadata with GPS-derived recording timestamps. Segment overlap
with a date range does not by itself prove that a whole route started inside it.
API calls require JWT authentication; existing useradmin cookies are not verified
to grant that access. The [files endpoint](https://api.comma.ai/#files) is documented
at five requests per minute, so moving file discovery to that endpoint is not an
automatic speed improvement. Metadata and file-link retrieval need separate
validation. No account endpoint was called during this research.

## Implementation that follows from the results

1. Add Recorded / Uploaded, with recording start date and timezone meaning explicit.
2. Discover listing pages completely; enqueue unique route metadata reads in a
   bounded pool. Reuse each response for metadata and selected file links.
3. Add a small date cache with refresh/expiry and explicit unknown-date reporting.
   Keep signed URLs temporary and revalidate selected cached dates.
4. Start with four workers; honor Retry-After, reduce pressure on errors and bound
   retries. Keep cancellation effective for queued and active reads.
5. Replace the current combined 100-page guard with separate bounded discovery
   budgets and resumable progress. A narrow recording range alone cannot reduce
   a cold metadata scan. Never present a stopped scan as complete.
6. Validate the revised scanner on Firefox Android with thousands of synthetic
   routes, then measure live authorized page latency before tuning further.
   Reuse the established ZIP tests; these experiments optimize discovery only.

## Reproduce

From the repository root, with dependencies installed:

```sh
node bench/recording-discovery/local-benchmark.cjs > bench/recording-discovery/local-results.json
node bench/recording-discovery/simulate.cjs --json > bench/recording-discovery/simulation-results.json
```

The local run opens a temporary loopback server and makes only loopback requests.
The event model sends no requests. Both use invented data and correctness
assertions. Supplied private captures, identifiers, URLs and page contents are
absent from these scripts, reports and fixtures. No production extension files,
permissions or installation packages were changed by this experiment.
