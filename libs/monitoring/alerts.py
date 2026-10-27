"""Compose service-owned Prometheus rules; optionally export for promtool."""

import argparse
from pathlib import Path

import yaml

from libs.monitoring.dashboards import ROOT, UniqueKeys


def load_rules(root=ROOT):
    config = yaml.load((root / "infra/observability/defaults.yaml").read_text(), Loader=UniqueKeys)
    groups = []
    names = set()
    for source in config["alert_rule_files"]:
        path = (root / source).resolve()
        if not path.is_relative_to(root.resolve()) or path.suffix != ".yaml":
            raise ValueError("Invalid rule source")
        document = yaml.load(path.read_text(), Loader=UniqueKeys)
        for group in document["groups"]:
            if group["name"] in names:
                raise ValueError("Duplicate rule group")
            names.add(group["name"])
            for rule in group["rules"]:
                if not rule.get("expr"):
                    raise ValueError("Missing expression")
                if "alert" in rule and rule.get("labels", {}).get("project") != "soloapp":
                    raise ValueError("Missing project label")
            groups.append(group)
    return {"groups": groups}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = load_rules()
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(yaml.safe_dump(result, sort_keys=False, allow_unicode=True))
    print(f"Validated {len(result['groups'])} rule groups")


if __name__ == "__main__":
    main()
