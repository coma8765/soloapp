.PHONY: deploy verify failover
ROOT := $(abspath ../..)
deploy:
	cd "$(ROOT)" && ansible-playbook infra/observability/deploy.yaml
verify:
	cd "$(ROOT)" && python3 infra/observability/tests/verify.py
# Explicit, disruptive fault test with automatic restoration.
failover:
	cd "$(ROOT)" && python3 infra/observability/tests/failover.py
