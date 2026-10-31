ROOT := $(abspath ../..)
DOCKER ?= docker
IMAGE ?= soloapp/soloapp-app:dev
REVISION ?= $(shell git -C $(ROOT) rev-parse HEAD)
BUNDLE ?= /tmp/soloapp-$(REVISION).tar.gz
.PHONY: build test codegen codegen-check package
build:
	$(DOCKER) build -f deploy/Dockerfile -t $(IMAGE) $(ROOT)
test:
	$(DOCKER) build --target build -f deploy/Dockerfile -t $(IMAGE)-test $(ROOT)
codegen:
	python3 $(ROOT)/libs/api_codegen/generate_javascript.py
codegen-check:
	python3 $(ROOT)/libs/api_codegen/generate_javascript.py --check
package: codegen-check
	python3 deploy/package.py $(REVISION) $(BUNDLE)
