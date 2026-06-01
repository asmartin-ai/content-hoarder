"""Reddit content recovery from public web archives (PullPush.io + Arctic-Shift).

Optional, removable, network-only and non-destructive. Driven by the CLI:
``content_hoarder enrich --source reddit --archives``.
"""
from content_hoarder.archival.providers import (
    ArcticShiftProvider,
    PullPushProvider,
    default_providers,
)
from content_hoarder.archival.service import count_targets, recover

__all__ = [
    "recover",
    "count_targets",
    "default_providers",
    "PullPushProvider",
    "ArcticShiftProvider",
]
