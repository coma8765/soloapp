#!/usr/bin/env python3
"""Validate YAML sources; optionally export Grafana JSON for external tooling."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from libs.monitoring.dashboards import main

if __name__ == "__main__":
    main()
