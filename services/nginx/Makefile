ROOT := $(abspath ../..)
IMAGE_PREFIX ?= soloapp
TAG ?= dev
IMAGE ?= $(IMAGE_PREFIX)/nginx:$(TAG)
DOCKER ?= docker
.PHONY: all build image
all: image
build: image
image:
	$(DOCKER) build -f $(ROOT)/services/nginx/deploy/Dockerfile -t $(IMAGE) $(ROOT)

PYTHON ?= $(if $(wildcard $(ROOT)/.venv-codegen/bin/python),$(ROOT)/.venv-codegen/bin/python,python3)
.PHONY: codegen check-codegen
codegen:
	$(PYTHON) $(ROOT)/libs/api_codegen/generate_nginx.py
check-codegen:
	$(PYTHON) $(ROOT)/libs/api_codegen/generate_nginx.py --check
