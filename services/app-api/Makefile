.DEFAULT_GOAL := build
SERVICE_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
PROJECT_ROOT := $(abspath $(SERVICE_DIR)/../..)
DOCKER ?= docker
IMAGE_PREFIX ?= soloapp
TAG ?= dev

.PHONY: build test test-image codegen check-codegen
PYTHON ?= $(PROJECT_ROOT)/.venv-codegen/bin/python
codegen:
	$(PYTHON) $(PROJECT_ROOT)/libs/api_codegen/generate_nest.py
check-codegen:
	$(PYTHON) $(PROJECT_ROOT)/libs/api_codegen/generate_nest.py --check
build:
	$(DOCKER) build --target runtime -f "$(SERVICE_DIR)/deploy/Dockerfile" -t "$(IMAGE_PREFIX)/app-api:$(TAG)" "$(PROJECT_ROOT)"

test-image:
	$(DOCKER) build --target tests -f "$(SERVICE_DIR)/deploy/Dockerfile" -t "$(IMAGE_PREFIX)/app-api-tests:$(TAG)" "$(PROJECT_ROOT)"

test: test-image
	$(DOCKER) run --rm "$(IMAGE_PREFIX)/app-api-tests:$(TAG)"
