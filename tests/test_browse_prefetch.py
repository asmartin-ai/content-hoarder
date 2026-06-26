"""Browse /items first-page prefetch cache.

Node-backed because the policy lives in static/browse/prefetch.js and is pure
ES module code. Skips when node is unavailable.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

STATIC = Path(__file__).resolve().parents[1] / "src" / "content_hoarder" / "static"


def _node(script: str) -> str:
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    r = subprocess.run(
        [node, "--input-type=module", "-e", script],
        cwd=STATIC,
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def test_prefetch_builds_bounded_blank_first_page_combinations():
    out = _node(
        """
        import assert from 'node:assert/strict';
        import { buildFirstPageWarmParams } from './browse/prefetch.js';
        const limits = { SOURCES: 3, SORTS: 2, SLICE_SIZE: 40 };
        const params = buildFirstPageWarmParams(
          { status:'inbox', safe:true, sort:'smart:desc' },
          [{ id:'reddit' }, { id:'youtube' }, { id:'hackernews' }, { id:'keep' }],
          ['first_seen_utc:desc', 'created_utc:desc'],
          limits,
        );
        assert.equal(params.length, 6);
        assert.deepEqual(params.map((p) => p.get('source')), [null, null, 'reddit', 'reddit', 'youtube', 'youtube']);
        assert(params.every((p) => p.get('limit') === '40' && p.get('offset') === '0'));
        assert(params.every((p) => p.get('status') === 'inbox' && p.get('safe') === '1'));
        assert.equal(buildFirstPageWarmParams({ q:'needle' }, ['reddit'], ['smart:desc'], limits).length, 0);
        assert.equal(buildFirstPageWarmParams({ exact:true }, ['reddit'], ['smart:desc'], limits).length, 0);
        assert.equal(buildFirstPageWarmParams({ focus:true }, ['reddit'], ['smart:desc'], limits).length, 0);
        console.log('ok');
        """
    )
    assert out == "ok"


def test_first_page_cache_ttl_lru_and_cacheability():
    out = _node(
        """
        import assert from 'node:assert/strict';
        import { createFirstPageCache } from './browse/prefetch.js';
        let now = 1000;
        const cache = createFirstPageCache({ now: () => now, limits: { TTL_MS: 10, MAX_ENTRIES: 2, SLICE_SIZE: 50 } });
        const p1 = new URLSearchParams('sort=smart&order=desc&limit=50&offset=0');
        const p2 = new URLSearchParams('sort=created_utc&order=desc&limit=50&offset=0');
        const p3 = new URLSearchParams('sort=first_seen_utc&order=desc&limit=50&offset=0');
        cache.set(p1, { items: ['a'] });
        assert.deepEqual(cache.get(p1).items, ['a']);
        now += 11;
        assert.equal(cache.get(p1), null);
        cache.set(new URLSearchParams('sort=smart&order=desc&limit=50&offset=50'), { items: ['bad'] });
        assert.equal(cache.size(), 0);
        cache.set(p1, { items: ['a'] });
        cache.set(p2, { items: ['b'] });
        cache.get(p1);
        cache.set(p3, { items: ['c'] });
        assert(cache.keys().some((k) => k.includes('sort=smart')));
        assert(!cache.keys().some((k) => k.includes('created_utc')));
        console.log('ok');
        """
    )
    assert out == "ok"


def test_prefetch_warmer_respects_concurrency_cap():
    out = _node(
        """
        import assert from 'node:assert/strict';
        import { buildFirstPageWarmParams, createFirstPageCache, createFirstPagePrefetcher } from './browse/prefetch.js';
        const limits = { SOURCES: 4, SORTS: 2, SLICE_SIZE: 50, CONCURRENCY: 2, MAX_ENTRIES: 24, TTL_MS: 1000 };
        let active = 0, maxActive = 0, calls = 0;
        const cache = createFirstPageCache({ limits });
        const warmer = createFirstPagePrefetcher({
          cache,
          limits,
          fetchJSON: async () => {
            calls += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            return { items: [], has_more: false };
          },
        });
        const params = buildFirstPageWarmParams(
          { status:'inbox', safe:true, sort:'smart:desc' },
          ['reddit', 'youtube', 'hackernews'],
          ['first_seen_utc:desc'],
          limits,
        );
        await warmer.warm(params);
        assert.equal(calls, params.length);
        assert(maxActive <= 2);
        assert.equal(cache.size(), params.length);
        console.log('ok');
        """
    )
    assert out == "ok"
