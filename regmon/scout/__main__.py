"""Scout command line.

  python -m regmon.scout sweep [--regulator all|ID[,ID]] [--trigger scheduled|manual]
  python -m regmon.scout review --event "$GITHUB_EVENT_PATH"
  python -m regmon.scout rebuild-review
  python -m regmon.scout validate
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from regmon.scout.profiles import ConfigError, load_config


def _outputs(path: str | None, values: dict) -> None:
    if not path:
        return
    with open(path, "a", encoding="utf-8") as stream:
        for key, value in values.items():
            stream.write(f"{key}={value}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m regmon.scout", description="Discover new regulator URLs worth monitoring.")
    parser.add_argument("command", choices=["sweep", "review", "rebuild-review", "validate"])
    parser.add_argument("--config", default="config/scout.json")
    parser.add_argument("--data-dir", default="data/scout")
    parser.add_argument("--sources-config", default="config/sources.json")
    parser.add_argument("--latest", default="data/latest.json", help="The monitor's URL inventory, used to mark known URLs")
    parser.add_argument("--regulator", default="all")
    parser.add_argument("--trigger", default="manual")
    parser.add_argument("--event", help="GitHub issue event JSON for the review command")
    parser.add_argument("--output", help="Write a JSON result here")
    parser.add_argument("--github-output", default=os.environ.get("GITHUB_OUTPUT"))
    args = parser.parse_args(argv)

    try:
        config = load_config(args.config)
    except ConfigError as exc:
        print(f"Scout configuration error: {exc}", file=sys.stderr)
        return 2
    data_dir = Path(args.data_dir)

    if args.command == "sweep":
        from regmon.scout.sweep import run

        latest = run(config, data_dir, sources_config=Path(args.sources_config), latest_path=Path(args.latest),
                     regulator=args.regulator, trigger=args.trigger)
        totals = latest["totals"]
        print(f"Scout sweep {latest['sweep_id']}: {latest['status']}; {totals['new']} new "
              f"({totals['new_relevant']} relevant, {totals['new_uncertain']} uncertain), {totals['requests']} requests")
        for entry in latest["regulators"]:
            if entry.get("sweep_id") == latest["sweep_id"]:
                print(f"  {entry['short_name']}: {entry['status']} - {entry['status_reason']}")
        _outputs(args.github_output, {"status": latest["status"], "new": totals["new"], "sweep_id": latest["sweep_id"]})
        if args.output:
            Path(args.output).write_text(json.dumps(latest, indent=1), encoding="utf-8")
        return 0

    if args.command == "review":
        from regmon.scout.review import ReviewError, apply_event, load_event
        from regmon.scout.sweep import rebuild_review

        if not args.event:
            parser.error("review needs --event")
        try:
            result = apply_event(load_event(args.event), data_dir)
        except ReviewError as exc:
            print(f"Scout review rejected: {exc}", file=sys.stderr)
            _outputs(args.github_output, {"error": str(exc).replace("\n", " ")})
            return 3
        rebuild_review(config, data_dir, sources_config=Path(args.sources_config), latest_path=Path(args.latest))
        print(f"Recorded {result['decision']} for {result['count']} candidate(s)")
        _outputs(args.github_output, {"decision": result["decision"], "count": result["count"]})
        if args.output:
            Path(args.output).write_text(json.dumps(result, indent=1), encoding="utf-8")
        return 0

    if args.command == "rebuild-review":
        from regmon.scout.sweep import rebuild_review

        review = rebuild_review(config, data_dir, sources_config=Path(args.sources_config), latest_path=Path(args.latest))
        print(f"Rebuilt the Scout review queue: {len(review['candidates'])} candidate(s)")
        return 0

    from regmon.scout.validate import validate

    problems = validate(config, data_dir)
    for problem in problems:
        print(f"Scout state problem: {problem}", file=sys.stderr)
    if problems:
        return 1
    print("Scout state is valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
