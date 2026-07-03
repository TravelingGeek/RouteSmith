# Python → TypeScript Conversion Notes

## File mapping

| Python | TypeScript | Notes |
|---|---|---|
| `gpx_parser.py` | `src/gpxParser.ts` | Uses DOMParser (browser/Workers) instead of xml.etree; fflate for ZIP |
| `statistics.py` | `src/statistics.ts` | Pure functions, identical logic |
| `rules.py` | `src/rules.ts` | Rule registry + evaluator, same structure |
| `state_data.py` | `src/referenceLists.ts` + `src/types.ts` | STATE_COUNTY_TOTALS in types.ts; GPX loader in referenceLists.ts |
| `generate.py` | `src/pipeline.ts` | Orchestrator, no I/O |
| `report.py` (CSS + charts) | `src/charts.ts` | SVG generators, identical output |
| `report.py` (renderers) | `src/renderer.ts` | HTML renderer, identical output |
| `icons.py` | _deferred_ | SVG icon embedding; v1 can inline via R2-stored SVGs or skip icons |
| `render_pdf.py` | _not needed_ | Browser print-to-PDF is the v1 approach |
| _(new)_ | `src/types.ts` | Shared type definitions |
| _(new)_ | `src/worker.ts` | Cloudflare Worker entry point |

## Key behavioral differences

### Date handling
Python uses tz-naive datetimes throughout (stripping tzinfo after parse).
TypeScript uses JavaScript Date objects (always UTC internally). All
comparisons use `date.toISOString().slice(0, 10)` (the "YYYY-MM-DD" string)
to get equivalent tz-naive UTC day comparison semantics. This matches Python's
`wpt.find_date.date()` behavior exactly.

### County keys
Python uses `(county, state)` tuples as dict keys. TypeScript uses
`"county|state"` string keys (the `countyKey()` function in types.ts).
The pipe character is safe because county and state names never contain it.

### XML parsing
Python uses `xml.etree.ElementTree`. TypeScript uses the browser's built-in
`DOMParser` with `getElementsByTagNameNS()`. Both handle the same GPX
namespace variants (GPX 1/0 and 1/1, groundspeak 1/0/1, gsak 1/6).

### ZIP decompression
Python uses the stdlib `zipfile` module. TypeScript uses `fflate` (a pure-JS
ZIP library that runs in Workers without native bindings). The `parseGpxZip()`
function is async; the synchronous `parseGpxTexts()` covers the non-ZIP path.

### Module loading
Python's `state_data.py` lazy-loads bookmark GPX files from disk on first
access. TypeScript fetches them from R2 at the start of each pipeline run
(`fetchReferenceListsFromR2()`), which is appropriate for a stateless Worker.
Reference lists are loaded once per request, not cached between requests in v1.
Add Workers KV caching later if reference list fetch latency becomes a concern.

### Icon embedding
`icons.py` loads SVG files from `cache_icons/` at module load time and
embeds them inline in the cache-type chart. In TypeScript v1, the icon
SVGs should be stored in R2 under `assets/icons/cache_icon_type_*.svg` and
fetched as needed. The `chartCacheTypes()` function in `charts.ts` currently
omits icons (matching the simplified approach). Add icon embedding in a
follow-up pass once the R2 asset pipeline is in place.

### `enabled_rules` bug fix
The Python v0.6 had a bug where old JSON files with unknown rule IDs would
silently filter out all rules. The TypeScript implementation reproduces the
fix: unknown IDs produce a warning but don't cause the entire rule list to
be discarded (only the specific unknown IDs are ignored).

## What's production-ready

- `types.ts` — complete, ready to use
- `gpxParser.ts` — complete, functionally equivalent to Python
- `statistics.ts` — complete, pure functions, fully testable
- `rules.ts` — complete, all v1 rules including mega/giga event (new)
- `referenceLists.ts` — complete, R2 fetch + GPX parse
- `pipeline.ts` — complete orchestrator, ready to wire to auth + storage
- `charts.ts` — complete SVG generators, output matches Python
- `renderer.ts` — complete HTML renderer, output matches Python
- `worker.ts` — skeleton Worker with correct routing; wire auth middleware

## What's deferred

- Cache type icon embedding in the chart (needs R2 asset pipeline first)
- Workers KV caching for reference lists (add if fetch latency matters)
- `render_pdf.py` equivalent (browser print-to-PDF is the v1 approach)
- Dashboard API endpoints beyond `/api/report/run` and `/api/report/data`
- Auth middleware (Clerk JWT validation in the Worker)
- D1 schema and trip persistence (separate schema migration file needed)

## Testing approach

Since all pipeline logic is in pure functions (no I/O), unit tests can run
in Node.js with a DOMParser polyfill (`@xmldom/xmldom`):

```typescript
import { DOMParser } from '@xmldom/xmldom';
import { parseGpxText } from './src/gpxParser.js';

const waypoints = parseGpxText(gpxString, 'TravelingGeek', new DOMParser());
```

The Python reference implementation serves as the acceptance test oracle:
given identical GPX input, the TypeScript pipeline should produce identical
statistics, rule results, and HTML structure.
