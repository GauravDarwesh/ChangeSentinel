"""Scout: weekly discovery of new regulator URLs worth monitoring.

The monitor (regmon.engine) watches pages that are already configured. Scout
answers a different question: which pages has a regulator published that
ChangeSentinel does not know about yet?

Three decisions stay separate:

* finding a URL (sitemaps, feeds and listing pages declared per regulator),
* judging whether it looks relevant (deterministic, explainable evidence rules),
* registering it for monitoring (a person, through the existing owner-only
  registration workflow).

Scout never writes monitoring state. Its own state lives under data/scout/.
This package imports only the standard library at module level so the review
workflow can run without installing the crawler stack.
"""

RULES_VERSION = "scout-rules-1"
SCHEMA_VERSION = 1
