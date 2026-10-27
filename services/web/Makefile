.DEFAULT_GOAL := build
ROOT := ../..
FLUTTER ?= $(if $(wildcard .fvm/flutter_sdk/bin/flutter),.fvm/flutter_sdk/bin/flutter,flutter)
VERSION ?= development
.PHONY: build test codegen check-codegen
build:
	$(FLUTTER) pub get --enforce-lockfile
	$(FLUTTER) build web --release --no-web-resources-cdn --dart-define=APP_VERSION=$(VERSION)
test:
	$(FLUTTER) analyze
	$(FLUTTER) test
codegen check-codegen:
	$(MAKE) -C $(ROOT) $@-web
