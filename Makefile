# Aggregate entry point; actual service recipes live in libs/build/service.mk.
.DEFAULT_GOAL := build
PROJECT_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
PYTHON ?= $(if $(wildcard $(PROJECT_ROOT)/.venv-codegen/bin/python),$(PROJECT_ROOT)/.venv-codegen/bin/python,python3)
SERVICES := auth whoami client-notify client-gateway
BUILD_TARGETS := $(addprefix build-,$(SERVICES))
TEST_TARGETS := $(addprefix test-,$(SERVICES))
TEST_IMAGE_TARGETS := $(addprefix test-image-,$(SERVICES))
CODEGEN_TARGETS := $(addprefix codegen-,$(SERVICES))
CHECK_TARGETS := $(addprefix check-codegen-,$(SERVICES))

.PHONY: all build test test-image codegen check-codegen help $(SERVICES) $(BUILD_TARGETS) $(TEST_TARGETS) $(TEST_IMAGE_TARGETS) $(CODEGEN_TARGETS) $(CHECK_TARGETS)
all: build
build: $(BUILD_TARGETS) build-nginx build-web build-keycloak build-soloapp build-whisper
test: test-codegen $(TEST_TARGETS) test-soloapp test-whisper
test-image: $(TEST_IMAGE_TARGETS)
codegen: $(CODEGEN_TARGETS) codegen-nginx codegen-web codegen-soloapp
check-codegen: $(CHECK_TARGETS) check-codegen-nginx check-codegen-web check-codegen-soloapp

$(SERVICES): %: build-%

$(BUILD_TARGETS): build-%:
	$(MAKE) -C "$(PROJECT_ROOT)/services/$*" build
$(TEST_TARGETS): test-%:
	$(MAKE) -C "$(PROJECT_ROOT)/services/$*" test
$(TEST_IMAGE_TARGETS): test-image-%:
	$(MAKE) -C "$(PROJECT_ROOT)/services/$*" test-image
$(CODEGEN_TARGETS): codegen-%:
	$(MAKE) -C "$(PROJECT_ROOT)/services/$*" codegen
$(CHECK_TARGETS): check-codegen-%:
	$(MAKE) -C "$(PROJECT_ROOT)/services/$*" check-codegen

help:
	@printf '%s\n' 'make [build]        Build runtime images for auth and whoami' 'make auth / whoami Build one service' 'make test          Build and run testsuite for both services' 'make test-auth     Test only auth (also: test-whoami)' 'make codegen       Regenerate service API DTOs/routes and nginx policies' 'make check-codegen Check generated API sources and nginx policies' 'make -C services/auth build  Use a service Makefile directly' 'Overrides: DOCKER=docker PYTHON=python3 IMAGE_PREFIX=soloapp TAG=dev'

.PHONY: nginx build-nginx
nginx: build-nginx
build-nginx:
	$(MAKE) -C "$(PROJECT_ROOT)/services/nginx" build

.PHONY: codegen-nginx check-codegen-nginx test-codegen
codegen-nginx:
	$(MAKE) -C "$(PROJECT_ROOT)/services/nginx" codegen
check-codegen-nginx:
	$(MAKE) -C "$(PROJECT_ROOT)/services/nginx" check-codegen
test-codegen:
	$(PYTHON) -m unittest discover -s libs/api_codegen/tests -v

.PHONY: public-check
public-check:
	$(PYTHON) infra/publication/check.py

.PHONY: codegen-web check-codegen-web build-web test-web
codegen-web:
	$(PYTHON) libs/api_codegen/generate_dart.py
check-codegen-web:
	$(PYTHON) libs/api_codegen/generate_dart.py --check
build-web test-web:
	$(MAKE) -C services/web $(subst -web,,$@)

.PHONY: release-images build-controller
release-images:
	bash infra/registry/build.sh "$(shell git rev-parse HEAD)" "$(PROJECT_ROOT)/work/release-images"
build-controller:
	docker buildx build --platform linux/amd64 --load -t soloapp/deploy-controller:1 infra/cd
	docker save -o work/deploy-controller.tar soloapp/deploy-controller:1

.PHONY: app-api build-app-api test-app-api test-image-app-api
app-api: build-app-api
build-app-api test-app-api test-image-app-api:
	$(MAKE) -C "$(PROJECT_ROOT)/services/app-api" $(patsubst %-app-api,%,$@)

.PHONY: check-dashboards deploy-dashboards
check-dashboards:
	$(PYTHON) infra/observability/dashboards/generate.py --check
deploy-dashboards: check-dashboards check-alerts
	ansible-playbook infra/observability/deploy.yaml --tags stores

.PHONY: check-alerts test-alerts
check-alerts:
	$(PYTHON) -m libs.monitoring.alerts --output work/alert-tests/rules.yaml
test-alerts: check-alerts
	cp infra/observability/tests/alerts.test.yaml work/alert-tests/tests.yaml
	docker run --rm --entrypoint /bin/promtool -v "$(PROJECT_ROOT)/work/alert-tests:/tests:ro" prom/prometheus:v3.15.1 check rules /tests/rules.yaml
	docker run --rm --entrypoint /bin/promtool -v "$(PROJECT_ROOT)/work/alert-tests:/tests:ro" prom/prometheus:v3.15.1 test rules /tests/tests.yaml

.PHONY: check-quality check-python check-cpp check-javascript check-dart
check-quality: check-python check-cpp check-javascript check-dart
	actionlint .github/workflows/ci.yaml .github/workflows/deploy.yaml
check-python:
	$(PYTHON) infra/ci/check.py python
check-cpp:
	$(PYTHON) infra/ci/check.py cpp-format
	$(PYTHON) infra/ci/check.py cpp-analysis
check-javascript:
	npm --prefix services/app-api run format:check
	npm --prefix services/app-api run lint
	services/app-api/node_modules/.bin/prettier --check infra/telegram-relay/src infra/telegram-relay/tests
	services/app-api/node_modules/.bin/oxlint infra/telegram-relay/src infra/telegram-relay/tests
check-dart:
	$(PYTHON) infra/ci/check.py dart-format

.PHONY: keycloak build-keycloak test-keycloak
keycloak: build-keycloak
build-keycloak test-keycloak:
	$(MAKE) -C "$(PROJECT_ROOT)/services/keycloak" $(patsubst %-keycloak,%,$@)

.PHONY: codegen-soloapp check-codegen-soloapp build-soloapp test-soloapp
codegen-soloapp:
	$(PYTHON) libs/api_codegen/generate_javascript.py
check-codegen-soloapp:
	$(PYTHON) libs/api_codegen/generate_javascript.py --check
build-soloapp test-soloapp:
	$(MAKE) -C services/soloapp_app $(subst -soloapp,,$@)

.PHONY: build-whisper test-whisper
build-whisper test-whisper:
	$(MAKE) -C services/whisper $(subst -whisper,,$@)
