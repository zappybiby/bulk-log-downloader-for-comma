# Bulk recording metadata: contract investigation

Research checked on 2026-09-14. No live account requests, credentials or private
captures were used. These findings do not change the packaged extension.

## What the current clients actually establish

Connect calls `GET /v1/devices/:id/routes_segments` with `start`, `end`, `limit`
and optional `route_str`. Its real-backend adapter forwards these unchanged.
Connect consumes route names, route recording timestamps and arrays of segment
numbers/start/end times. This is stronger evidence than the older segment-only
API documentation, but the client does not define server caps, inclusive bounds,
filter predicates or a cursor contract.
Sources: [API wrapper](https://github.com/commaai/connect/blob/734fb4afa49b60f27575220aa09de03e39f31b86/src/api.js),
[real adapter](https://github.com/commaai/connect/blob/734fb4afa49b60f27575220aa09de03e39f31b86/src/api/backend.js).

Connect's “load more” is cumulative: it requests the same window with limits
5, 10, 15 and so on. It assumes a response shorter than the requested limit means
exhaustion. There is no offset or cursor in this caller. It also sorts displayed
routes by `create_time`, so screen order cannot establish recording chronology.
For playback, it starts with the first segment time and contains a special repair
when that differs from the route timestamp by more than 24 hours while the end
timestamps nearly agree. Those are client behaviors, not proof of backend truth.
Source: [route loading and normalization](https://github.com/commaai/connect/blob/734fb4afa49b60f27575220aa09de03e39f31b86/src/actions/index.js).

Connect's metadata cache only checks whether the requested device and time window
fit its loaded state. It has no expiry check in that predicate. The 45-minute
cache in its API wrapper applies to file-URL responses, not recording dates.
Neither mechanism is a suitable freshness contract for a complete export scan.
Sources: [metadata cache predicate](https://github.com/commaai/connect/blob/734fb4afa49b60f27575220aa09de03e39f31b86/src/timeline/segments.js),
[file-URL cache](https://github.com/commaai/connect/blob/734fb4afa49b60f27575220aa09de03e39f31b86/src/api.js).

Current openpilot/Cabana independently calls the same bulk endpoint with start
and end, without a limit or a pagination loop. Its route dialog reads the route
summary timestamp directly. This confirms another real consumer but does not
establish that omitting `limit` guarantees complete results. It also supports
`/routes/preserved`, whose ISO start/end fields serve only the preserved subset.
Sources: [Cabana API calls](https://github.com/commaai/openpilot/blob/26899177578542b7eb7b8b2795f755e73bd17b1c/openpilot/tools/lib/file_downloader.py),
[Cabana timestamp parser](https://github.com/commaai/openpilot/blob/26899177578542b7eb7b8b2795f755e73bd17b1c/openpilot/tools/cabana/routes.cc).

The documented device `/segments` endpoint has millisecond bounds and
GPS-derived segment start/end fields; its `create_time` is an upload event.
Segment membership does not prove the whole drive started in the chosen range,
especially when segment zero is missing. The documentation provides no reliable
route-catalog cursor or cap guarantee. The route `/files` endpoint is documented
at five calls per minute, so it is not an automatic replacement for HTML file
discovery. Source: [official API documentation](https://api.comma.ai/#segments).

## Authentication is a separate integration

Connect offers Google, Apple and GitHub sign-in, sends the provider code to
`/v2/auth/`, stores the returned JWT and supplies it on API requests. Its auth
helper uses origin-local browser storage. That does not establish that a
useradmin cookie grants this API access, or that an extension-origin OAuth
callback is supported. A bulk API provider therefore needs a deliberate,
user-visible connection flow; do not assume or silently copy credentials.
Sources: [login screen](https://github.com/commaai/connect/blob/734fb4afa49b60f27575220aa09de03e39f31b86/src/components/anonymous.jsx),
[code exchange setup](https://github.com/commaai/connect/blob/734fb4afa49b60f27575220aa09de03e39f31b86/src/App.jsx),
[token storage helper](https://github.com/commaai/my-comma-auth/blob/e34f624b8d3e05a4b28a0fbdb44cf7c67ff96999/storage.js).

## Nine offline checks and their implications

Run `node bench/recording-discovery/bulk-contract.cjs`. All nine scenarios passed
their assertions. These are adversarial models, not measured API behavior or
phone timings. [Raw results](../bench/recording-discovery/bulk-contract-results.json).

| Model, with 1,000 invented routes | Result |
| --- | --- |
| Stable complete prefix, cumulative limit +5 | 201 calls; 101,500 route rows transferred |
| Same model, doubling limits | 9 calls; 2,275 rows transferred |
| Hypothetical silent cap of 250 | The shorter-than-limit rule wrongly declares completion with 750 routes absent |
| Timestamp-only cursor; 100 rows share one boundary timestamp | A 50-row page followed by an exclusive time cursor skips 50 rows |
| Split windows under a containment predicate | A drive spanning the split appears in neither window |
| Missing segment zero, epoch-only clock, conflicting corrected clock | All require fallback in the conservative prototype |

Doubling is more efficient under a stable-prefix contract; it does not repair
an unknown cap. Neither timestamp cursors nor recursive time splitting should be
implemented until their necessary server semantics are known. Connect's own
demo explicitly includes routes with boot-relative, epoch-like clocks, so
unknown real dates are a real design case, not just malformed JSON.
Source: [upstream missing-data demo](https://github.com/commaai/connect/blob/734fb4afa49b60f27575220aa09de03e39f31b86/src/api/demo.js).

## A useful API accelerator without trusting completeness

Keep the completely enumerated useradmin route IDs as the scan's membership
catalog. Join bulk metadata by exact route ID. Missing IDs, conflicting duplicate
records, foreign IDs, missing segment-zero evidence and ambiguous dates must not
silently exclude a drive. Read the corresponding route page when needed.

Crucially, a query returning **only matching dates** cannot justify skipping all
other catalog IDs until completeness is validated. Every absent ID still needs
a detail read. Broad metadata is useful because it supplies known nonmatches.

The join simulations all found the same 224 selected drives:

| API metadata supplied | Detail-page reads still needed |
| --- | ---: |
| Complete broad catalog with usable dates | 224 |
| Only the 224 matching rows, completeness unverified | 1,000 |
| 250 rows, including 25 ambiguous rows | 825 |
| Full catalog plus one conflicting duplicate and a foreign ID | 224 |

Selected routes still need fresh file links. A missing metadata row can obtain
its date and files in that same single detail response. These counts exclude
listing pages, API calls, retries and file transfers.

This protects against missing API rows, **not incorrect but plausible dates**.
Before enabling exclusion, API timestamps must be shown to represent the same
recording-start meaning and timezone as our chosen UI contract. Cache freshness
and upstream corrections remain separate concerns. If even the fallback page
has no trustworthy date, report an unknown date rather than calling the scan
complete for that route.

The practical next step remains the HTML reader with a bounded request pool and
date cache. The bulk provider becomes worthwhile after a supported connection
flow and trustworthy date fields are verified; it can then accelerate that
reader without replacing its completeness fallback.
