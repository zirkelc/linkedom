# Performance campaign: linkedom (perf/autoresearch)

## Repo

linkedom: a DOM for Node built on a triple-linked list (start, end and attribute nodes in
one list). Plain JS sources in `esm/`. `cjs/`, `types/` and `worker.js` are generated and
committed (`npm run build`: tsc, ascjs, rollup, test). npm, Node 24.

Tests: `npm test` (~3 s) runs eslint on `esm/`, `npm run hello`, a w3c benchmark with MO and
CE, and `c8 node test/index.js`, which runs every test twice (`linkedom` and
`linkedom/cached`) against `cjs/`. So `npm run cjs` must run after each `esm/` change.
Coverage: 100% lines and branches, 99.75% functions (one function in `cjs/interface/element.js`
is not covered on main already).

Benchmark: `test/benchmark/*.js`, custom `console.time` scripts, lower is better. Phases:
parse, normalize, crawl childNodes/children, cloneNode(true), querySelectorAll('div'),
getElementsByTagName('p'), remove all divs, clone again, outerHTML, innerHTML round trip,
heap after each phase. Inputs: w3c.html 32 KB, dom.html 2.3 MB, html.html 12 MB.
`benchmark:html` takes ~4.4 s. One version per process, 1-2 iterations: cross-check only.
jsdom and basichtml are not installed.

Maintainer (WebReflection): accepts outside PRs (10 of 20 merged in 2 years, mostly small
fixes); no outside perf PR exists. Values, in order: hot-path wall-clock time, heap/RAM,
bundle size and worker compatibility, simplicity. Rejected PRs that slowed hot paths
(#306, #331). Asked for "PR welcomed with benchmark attached", before/after with
`test/benchmark/` on the same hardware. Rules: 100% coverage, no new deps, small focused PRs,
regenerated cjs/types included. Said in #177 that crawling huge sites is "not the main goal":
frame PRs on his benchmark phases (parse, clone, query, crawl), scraper numbers as support.

## Harness

`perf/` from the autoresearch node-ts runtime. Node 24 strips types natively, no `tsx`.
Entry `esm/index.js`, archived paths `esm`, `commonjs` (canvas shim). Adaptations:
- `ab.mts`: 30 iterations, 3 warm-ups, probe stops after 3 runs for bodies over 20 ms,
  forced `gc()` before every timed run (children run with `--expose-gc`), per-case
  `setup()`/`teardown()` so parsed documents live only while their case runs, delta from the
  median of paired ratios, GEOMEAN line (every case weighted equally).
- `profile.mts`: `--deps` keeps htmlparser2 and css-select frames (linkedom hands its parse
  and match loops to them).

Fixtures: 14 real Shopify storefront pages (7 `/pages/*`, 5 product, 2 home; 9 shops;
13 MB) in `perf/fixtures/`, untracked (third-party content), recreated by
`perf/fetch-fixtures.sh`. Plus `test/benchmark/w3c.html` and `dom.html`.

Cases:
- `extract-pages`, `extract-products`, `extract-home`: the production extractor (skip-link and `main`
  detection, contains, compareDocumentPosition, section cloneNode(true) on `/pages/*`, ten
  removal passes by selector, `outerHTML` for the Markdown converter).
- `parse-shop`, `query-scraper` (every extractor selector, read-only),
  `query-first`, `query-simple`, `contains-position`, `clone-deep`, `crawl`, `serialize`,
  `text-content`.
- `bench-dom`, `bench-w3c`: the full `content.js` sequence. `bench-w3c` has `alloc()` for
  `mem.mts` (retained bytes per parsed document).

Canary (busy loop in compareDocumentPosition): contains-position +2396%, extract-pages +0.8%
(~50 calls), others within noise. Harness measures the right revision.

## Calibration (identical code both sides, 3 runs)

Machine: Apple M5, 4 performance + 6 efficiency cores, shared with the user's other work
(load average 6-12 during the campaign). A pure CPU loop varies by 11% at the median.
First attempts with min-per-side deltas gave per-case swings of +-20% on identical code, so
`ab.mts` now reports the **median of the paired ratios** (A and B run back to back in each
iteration, so both see the same machine state), combined over both load orders.

GEOMEAN: +0.89%, -0.08%, -1.77% -> noise floor 1.8%
TOTAL:   +1.76%, +1.81%, -1.41% -> noise floor 1.8%
Per-case noise: large cases (extract*, parse-shop, query-scraper, query-simple, clone-deep,
crawl, serialize, bench-dom) +-3%; short cases (query-first, contains-position, text-content,
bench-w3c) +-9%.

**Keep bar: GEOMEAN and TOTAL <= -3.5%, confirmed by a second run.**
Per-case rule: targeted case <= -6% (large cases) or <= -18% (short cases) in both runs, and
the total does not regress.

One A/B run takes about 4.5 minutes (30 iterations, 1 child per load order).

## Baseline (A column of calibration run 3, ms)

| case | time |
|---|---|
| extract-pages | 74.02 |
| extract-products | 89.11 |
| extract-home | 49.02 |
| parse-shop | 30.97 |
| query-scraper | 43.78 |
| query-first | 1.30 |
| query-simple | 16.07 |
| contains-position | 0.057 |
| clone-deep | 103.72 |
| crawl | 18.17 |
| serialize | 25.43 |
| text-content | 1.03 |
| bench-dom | 508.02 |
| bench-w3c | 6.44 |
| TOTAL | 967.14 |

Retained heap per parsed w3c document (mem.mts, 300 instances): 633,093 bytes.

Profile summary (extract cases): GC 29%, `DOMEventTarget` constructor 10% self,
`DOMTokenList get value` 9%, htmlparser2 ~15%, css-select ~8%.
- clone-deep: GC 64%, `DOMEventTarget` 21%.
- bench-dom: GC 48%, `DOMEventTarget` 15%.
- query-scraper: `DOMTokenList get value` 34%, css-select compile closure 20%,
  `getAttributeValue` 7%, `getAttribute` 5%.
- serialize/crawl: `Element.toString` 36%, `get childNodes` 12%, `Attr.toString` 7%,
  `escape` 7%, `get children` 6%.

## Candidates

1. EventTarget: `wm.set(this, new Map)` in the constructor of every node. Create the map on
   the first `addEventListener`. Expected: large on clone, parse, bench-dom; also heap.
2. Class selectors: `getAttributeValue(el, 'class')` returns `classList.value`, which joins
   the Set on every call. Cache or read the (already normalised) attribute value.
3. Parse: each `class` attribute builds a DOMTokenList, splits and writes back through the
   `Attr` value setter (MO/CE callbacks). Normalise without the Set.
4. `childNodes`/`children` getters build a NodeList per access; crawl and css-select's
   `getChildren` hit it. Cheaper walk in the adapter (findOne/findAll/existsOne).
5. `Element.toString` / serialisation: string building, `escape`, attribute toString.
6. css-select adapter: `isTag` destructures, `getName` lowercases per call.
7. `querySelectorAll`: `template` check on every node, `localName` compare.
8. `compareDocumentPosition` for siblings builds two childNodes lists and indexOf.

## Decision items (behaviour changes, not attempted)

- **Attribute nodes are full Node instances.** Every attribute of every element allocates an
  Attr (about ten fields) in the linked list. On a Shopify page that is tens of thousands of
  objects and a large part of the remaining GC time. Creating them lazily is a redesign of the
  list, so it needs the maintainer's decision.
- **Duplicate mutation records for `class`.** Setting a class attribute through the shared
  `setAttribute` fires the attribute callbacks twice (once from the token list writing the
  normalised value back, once from `setAttribute` itself). The kept parser change avoids the
  second path only inside the parser, where no record was observable. Fixing it everywhere
  changes what a MutationObserver sees.
- **Selector matching reads the token list, not the attribute.** After a direct
  `attr.value = ...` the two differ. Reading the attribute would match what a browser does,
  but it measured slower (experiment 16), so the question is correctness, not speed.

## Experiment notes

1. **EventTarget listeners map (kept).** `wm.set(this, new Map)` ran in the constructor of
   every node, so each node carried a Map and a WeakMap entry (an ephemeron, expensive for the
   GC) although almost no node ever gets a listener. Creating it on the first
   `addEventListener` cost two lines. GC time in the extract profile fell from 29% to 6%.
2. **DOMTokenList value cache (kept).** Every class selector test asked for `classList.value`,
   which joined the token Set again. The cache is dropped in every mutating path (`add`,
   `remove`, `toggle`, `replace`, and the inherited `clear`/`delete`, which are now overridden),
   so the observable value cannot drift.
3. **Class normalisation in the shared setAttribute (discarded).** No effect: the parser has
   its own attribute path and never calls it.
4. **Class normalisation in the parser (discarded, later kept in a bundle).** Real but under the
   bar alone (parse-shop -4.2%, TOTAL -2.3%).
5. **Escape fast path (kept).** `escape` ran a regex replace with a callback over every text
   node and attribute value; most contain nothing to escape. A non-global test regex decides
   first (a `test` on the global regex would move `lastIndex`). `Attr.toString` skips its
   quote replace the same way.
6. **childNodes/children in one pass (kept).** Both getters called `nextSibling`/
   `nextElementSibling` per entry. Walking the list and jumping over an element with its end
   marker removed a helper import as well.
7. **Compiled selector cache (discarded).** Compilation is minor next to matching
   (query-scraper -0.9%), and it needed an extra test for the cache-clear branch.
8. **Element.toString as one string (kept).** Pushing thousands of pieces into an array and
   joining them was replaced by concatenation, which V8 keeps as a rope. serialize 1.74x in
   both runs, and the code got shorter.
9. **textContent/innerText/wholeText (kept, per-case rule).** Same change for the text
   getters. text-content 1.52x and 1.31x, TOTAL neutral inside the noise band.
10. **Parser bundle (kept).** The class normalisation from experiment 4 plus a single
    `htmlClasses.get` instead of `has` + `get`. Together they cleared the bar.
11. **End marker as a class (discarded).** clone-deep 1.82x, but every tree walk regressed
    16-31%: the walks read `nodeType` from nodes and markers, and the new marker shape hurt
    those sites. Discarded although TOTAL improved 6%.
12. **End marker without symbol keys in the literal (kept).** The same allocation win without
    the walk regressions: an object literal whose keys are symbols allocates through a slow
    path. clone-deep 1.71-1.74x, bench-dom 1.22x. Cost: serialize regresses 8-9%, because the
    serializer reads the marker's symbol links, which now live outside the object.
13. **Symbol keys back in the literal, after the string keys (discarded).** Worse
    (clone-deep +26%): the position of the symbol keys does not matter, their presence does.
14. **Symbol-key literals in Element.toString and Document.query (discarded).** Those objects
    are created per call, not per node: TOTAL +0.2%.
15. **Open elements on a stack in toString (discarded).** Recovered only 3.8% of the 8-9%
    serialize cost of experiment 12.
16. **Selector adapter reads the class attribute (discarded).** Slower (query-scraper +7.4%):
    `getAttribute` walks the attribute list, while the token value is cached since
    experiment 2.
17. **innerHTML getter and setter without child collection (discarded).** No effect: the round
    trip is dominated by re-parsing.
18. **One nodeType check per node in the query walks (discarded).** query-scraper -4.4%, under
    the bar.

## Final summary

Kept: 8 of 18 experiments (1, 2, 5, 6, 8, 9, 10, 12).

Cumulative, pre-loop commit (ed0e7ea) against the final commit, two runs:

| case | base ms | branch ms | run 1 | run 2 | speed-up |
|---|---|---|---|---|---|
| extract-pages | 73.5 | 47.0 | -36.1% | -34.9% | 1.55x |
| extract-products | 96.8 | 65.8 | -32.0% | -32.6% | 1.48x |
| extract-home | 53.6 | 37.3 | -30.5% | -28.9% | 1.42x |
| parse-shop | 32.8 | 24.1 | -26.7% | -27.9% | 1.37x |
| query-scraper | 45.5 | 32.3 | -29.0% | -28.7% | 1.40x |
| query-first | 1.65 | 1.39 | -15.6% | -13.3% | 1.17x |
| query-simple | 16.0 | 15.8 | -1.4% | +0.7% | 1.00x |
| contains-position | 0.070 | 0.075 | +7.1% | +8.4% | 0.92x |
| clone-deep | 100.7 | 17.9 | -82.2% | -82.4% | 5.64x |
| crawl | 17.7 | 14.6 | -18.0% | -16.9% | 1.21x |
| serialize | 26.0 | 14.3 | -45.2% | -45.9% | 1.84x |
| text-content | 0.98 | 0.49 | -49.6% | -47.0% | 1.94x |
| bench-dom | 502.7 | 207.0 | -58.8% | -58.5% | 2.42x |
| bench-w3c | 6.40 | 3.53 | -44.8% | -41.8% | 1.76x |
| **TOTAL** | **974.6** | **481.5** | **-50.6%** | **-50.6%** | **2.02x** |
| GEOMEAN | | | -37.8% | -37.0% | 1.60x |

`contains-position` (a 70 microsecond case) is the only case that is not faster; its two runs
sit inside its noise band.

Retained heap per parsed w3c document: 675,283 -> 254,212 bytes, **-62.4%**.

External cross-check, the repo's own `npm run benchmark:html` (12 MB page), two runs per side.
These are standalone runs, not paired, so they carry cross-run drift; the effects are far
larger than that drift.

| phase | base | branch |
|---|---|---|
| parsing | 767 / 711 ms | 259 / 235 ms |
| heap after parse | 320.7 MB | 129.0 MB |
| crawling childNodes (cold/hot) | 91 / 47 ms | 54 / 45 ms |
| cloneNode(true) | 591 / 527 ms | 84 / 85 ms |
| querySelectorAll('div') | 20 ms | 19 ms |
| getElementsByTagName('p') | 21 ms | 19 ms |
| outerHTML (hot) | 92 / 94 ms | 67 / 66 ms |
| innerHTML round trip | 472 / 496 ms | 225 / 221 ms |
| total benchmark time | 4.23 / 4.09 s | 2.43 / 2.41 s |
| total heap | 1134 MB | 587 MB |

Worth trying next:
- Recover the 8-9% serialize cost of the marker change (experiment 15 got 3.8% of it).
- Lazy attribute nodes (see decision items): the largest remaining allocation source.
- The selector engine itself (css-select is 17% of the extract profile): a fast path for
  simple selectors (single tag, single class, single id) would skip it.
- htmlparser2 is 13-24% of parse profiles. Not linkedom's code, but a tokenizer fast path for
  plain text runs could be raised upstream.
