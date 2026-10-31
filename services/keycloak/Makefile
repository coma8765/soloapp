SERVICE := keycloak
PROJECT_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
DOCKER ?= docker
PYTHON ?= python3
IMAGE_PREFIX ?= soloapp
TAG ?= dev
.PHONY: build test
build:
	$(DOCKER) buildx build --platform linux/amd64 --load --target runtime -t $(IMAGE_PREFIX)/$(SERVICE):$(TAG) -f $(PROJECT_ROOT)/services/keycloak/deploy/Dockerfile $(PROJECT_ROOT)
test:
	$(PYTHON) -m unittest discover -s $(PROJECT_ROOT)/services/keycloak/tests -v
