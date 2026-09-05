# UnicDB — Makefile (TASK-001 scaffold)
# Targets: build, watch, test, package, db-up, db-down.
# Docker compose file is owned by TASK-003; this Makefile references it read-only.

.PHONY: build watch test test-integration package db-up db-down clean

build:
	npm run compile

watch:
	npm run watch

test:
	npm test

test-integration:
	npm run test:integration

package: build
	npm run package

db-up:
	docker compose -f docker/docker-compose.yml up -d

db-down:
	docker compose -f docker/docker-compose.yml down

clean:
	rm -rf dist *.vsix
