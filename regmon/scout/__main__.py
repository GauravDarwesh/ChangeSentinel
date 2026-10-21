"""Scout command line.

  python -m regmon.scout sweep [--regulator all|ID[,ID]] [--trigger scheduled|manual]
  python -m regmon.scout review --event "$GITHUB_EVENT_PATH"
  python -m regmon.scout source --event "$GITHUB_EVENT_PATH"
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
    parser.add_argument("command", choices=["sweep", "review", "source", "rebuild-review", "validate"])
    parser.add_argument("--config", default="config/scout.json")
    parser.add_argument("--data-dir", default="data/scout")
    parser.add_argument("--sources-config", default="config/sources.json")
    parser.add_argument("--latest", default="data/latest.json", help="The monitor's URL inventory, used to mark known URLs")
    parser.add_argument("--regulator", default="all")
    parser.add_argument("--trigger", default="manual")
    parser.add_argument("--event", help="GitHub issue event JSON for the review and source commands")
    parser.add_argument("--no-dns", action="store_true", help="Skip DNS checks of new hosts (tests and offline use)")
    parser.add_argument("--output", help="Write a JSON result here")
    parser.add_argument("--github-output", default=os.environ.get("GITHUB_OUTPUT"))
    args = parser.parse_args(argv)

    if args.command == "source":
        # Runs before loading the configuration: the request changes it.
        from regmon.scout.sources import SourceRequestError, apply_event as apply_source_event
        from regmon.scout.review import load_event

        if not args.event:
            parser.error("source needs --event")
        try:
            summary = apply_source_event(load_event(args.event), Path(args.config), resolve_dns=not args.no_dns)
        except SourceRequestError as exc:
            print(f"Scout source request rejected: {exc}", file=sys.stderr)
            _outputs(args.github_output, {"error": str(exc).replace("\n", " ")})
            return 3
        config = load_config(args.config)
        from regmon.scout.sweep import rebuild_review

        rebuild_review(config, Path(args.data_dir), sources_config=Path(args.sources_config), latest_path=Path(args.latest))
        verb = "Added regulator" if summary["created"] else "Updated regulator"
        print(f"{verb} {summary['regulator_id']}" + (f" with channel {summary['channel_id']}" if summary["channel_id"] else ""))
        _outputs(args.github_output, {"regulator_id": summary["regulator_id"], "created": str(summary["created"]).lower(),
                                      "channel_id": summary["channel_id"], "active": str(summary["active"]).lower()})
        if args.output:
            Path(args.output).write_text(json.dumps(summary, indent=1), encoding="utf-8")
        return 0

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
