SERVICE := client-notify
SERVICE_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
PROJECT_ROOT := $(abspath $(SERVICE_DIR)/../..)
include $(PROJECT_ROOT)/libs/build/service.mk

# RabbitMQ is isolated and removed after tests; PostgreSQL is managed by testsuite.
test: test-image
	$(PYTHON) tests/run.py --engine "$(DOCKER)" --image "$(TEST_IMAGE)"
