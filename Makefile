# Aggregate entry point; actual service recipes live in libs/build/service.mk.
.DEFAULT_GOAL := build
PROJECT_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
PYTHON ?= $(if $(wildcard $(PROJECT_ROOT)/.venv-codegen/bin/python),$(PROJECT_ROOT)/.venv-codegen/bin/python,python3)
SERVICES := auth whoami
BUILD_TARGETS := $(addprefix build-,$(SERVICES))
TEST_TARGETS := $(addprefix test-,$(SERVICES))
TEST_IMAGE_TARGETS := $(addprefix test-image-,$(SERVICES))
CODEGEN_TARGETS := $(addprefix codegen-,$(SERVICES))
CHECK_TARGETS := $(addprefix check-codegen-,$(SERVICES))

.PHONY: all build test test-image codegen check-codegen help $(SERVICES) $(BUILD_TARGETS) $(TEST_TARGETS) $(TEST_IMAGE_TARGETS) $(CODEGEN_TARGETS) $(CHECK_TARGETS)
all: build
build: $(BUILD_TARGETS) build-nginx
test: test-codegen $(TEST_TARGETS)
test-image: $(TEST_IMAGE_TARGETS)
codegen: $(CODEGEN_TARGETS) codegen-nginx
check-codegen: $(CHECK_TARGETS) check-codegen-nginx

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
