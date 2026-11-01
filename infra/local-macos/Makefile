PYTHON ?= ../../.venv-codegen/bin/python
.PHONY: start status
start:
	cd /tmp && colima start --profile soloapp-local --cpu 8 --memory 12 --disk 48 --vm-type vz --runtime docker --kubernetes --activate=false --mount none --ssh-config=false --k3s-arg=--disable=traefik --k3s-arg=--secrets-encryption
status:
	kubectl --context colima-soloapp-local -n soloapp get pods,svc,pvc

.PHONY: deploy lan-refresh
deploy:
	cd ../.. && ansible-playbook infra/local-macos/deploy.yaml
lan-refresh:
	$(PYTHON) refresh-lan.py $(LAN_IP)

.PHONY: update check update-plan
update:
	./update-local.sh $(ARGS)
check:
	./update-local.sh --check-only
update-plan:
	./update-local.sh --plan
