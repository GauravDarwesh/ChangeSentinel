# Operations

The monitor runs every six hours and can also be started manually.

Required secret for AI:
OPENROUTER_API_KEY

Optional notification secret:
NTFY_TOPIC
Default: RegMonitoringWebCrawlerNTFY

Manual workflow inputs:
- source_id: a configured source id, or all.
- test_notification: sends a controlled ntfy delivery test without altering the monitoring baseline.

GitHub Pages publishes only index.html. The dashboard reads monitoring JSON from the main branch.
