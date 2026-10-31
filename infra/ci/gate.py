"""A missing, cancelled, skipped or failed mandatory job must block merging."""

import json
import os

EXPECTED = {"source", "quality", "services", "app-api", "web", "gateway", "keycloak", "soloapp"}


def check_results(needs):
    if set(needs) != EXPECTED:
        raise ValueError("Required job set does not match the CI contract")
    unsuccessful = [name for name, job in needs.items() if job.get("result") != "success"]
    if unsuccessful:
        raise ValueError("Required jobs did not succeed: " + ", ".join(sorted(unsuccessful)))


if __name__ == "__main__":
    check_results(json.loads(os.environ["NEEDS"]))
    print("Every required CI job succeeded")
