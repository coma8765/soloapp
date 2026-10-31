ROOT := $(abspath ../..)
IMAGE ?= soloapp/whisper:dev
.PHONY: build test
build:
	docker build -f deploy/Dockerfile -t $(IMAGE) $(ROOT)
test:
	python3 -m unittest discover -s tests -v
