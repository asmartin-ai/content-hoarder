# Try the demo

The [hosted demo](https://demo.khaosapp.tech) is an invite-only pilot with a separate library for each tester. Ask for an invite link, or run the synthetic demo locally:

```sh
./scripts/demo.sh
```

Open <http://127.0.0.1:8791/>. The script creates a temporary library of fictional saves and generated media, and enables offline mode. It does not open your personal database. Stop the server with Ctrl+C; remove the temporary directory printed by the script when finished.

## Walkthrough

1. On **Today**, choose a round size and start clearing.
2. Read a card, then choose **Done**, **Archive**, **Keep**, or **Not now**. Open a card in the reader for more detail.
3. Undo a decision, then finish the round to see your receipt.
4. Open **Library** to search, filter by source, and find a saved item again.
5. Return to Today and try **Let a pile go** when a suggested pile is available; undo it from the toast.

The offline demo cannot fetch Reddit threads or use AI suggestions. To import your own content into a normal local library, see the [quickstart](../README.md#local-quickstart) and [import guide](IMPORTING.md).
