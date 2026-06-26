Handoff: Twitter/X bookmarks connector

State:
- Branch: main
- Commit: 562cf6d Add Twitter bookmark import connector
- Patch artifact: twitter-x-bookmarks-connector.patch
- Worktree note: .agents/ was pre-existing untracked workspace context and was left untouched.

What shipped:
- Added src/content_hoarder/connectors/twitter.py.
- Registered source id twitter as "Twitter / X Bookmarks".
- Imports browser-side JSON/CSV bookmark exports into twitter:<tweet_id> items.
- Parses both flat exporter rows and nested X GraphQL tweet_result objects.
- Captures text, author handle/display name, canonical permalink, created time, media URLs, and bookmark_index when only export order exists.
- Normalizes pbs.twimg.com media images to ?name=orig.
- Added Twitter source badge/token support in static/core/render.js and token CSS.
- Added fixtures/twitter/bookmarks.json and fixtures/twitter/bookmarks.csv.
- Added tests/test_twitter.py and updated tests/test_connectors.py.
- Updated README.md and docs/IMPORTING.md with the import path.

Verification:
- python -m pytest tests/test_twitter.py tests/test_connectors.py tests/test_pipeline.py -q
- Result: 23 passed
- python -m py_compile src\content_hoarder\connectors\twitter.py src\content_hoarder\connectors\__init__.py
- python -m content_hoarder sources shows twitter.

Important context:
- Connector is parser-only by design: no X API calls, no sync, no DB writes.
- Dispatch order intentionally checks Twitter before Reddit because Reddit has broad JSON sniffing.
- Media archiving is not implemented yet; Twitter media URLs are stored in metadata.media_urls for a later archive-media extension.
- Quote-tweet/thread context, NSFW handling, and YouTube promotion from tweet text remain backlog follow-ups.
