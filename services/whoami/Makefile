SERVICE := whoami
SERVICE_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
PROJECT_ROOT := $(abspath $(SERVICE_DIR)/../..)
DOCKERFILE := $(PROJECT_ROOT)/services/whoami/deploy/Dockerfile
include $(PROJECT_ROOT)/libs/build/service.mk
