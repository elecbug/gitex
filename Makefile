.DEFAULT_GOAL := help

NPM ?= npm

.PHONY: help install build watch test test-extension package clean

help:
	@printf '%s\n' \
		'Usage: make <target> (Node.js 22+, npm, and GNU Make)' \
		'  install         Install development dependencies with npm ci' \
		'  build           Compile TypeScript' \
		'  watch           Recompile when source files change' \
		'  test            Compile and run core tests' \
		'  test-extension  Run tests in a separate VS Code instance' \
		'  package         Compile and create the current-version VSIX' \
		'  clean           Remove compiled output and generated VSIX files'

install:
	$(NPM) ci

build:
	$(NPM) run compile

watch:
	$(NPM) run watch

test:
	$(NPM) test

test-extension:
	$(NPM) run test:extension

package:
	$(NPM) run package

clean:
	$(RM) -r out
	$(RM) gitex-*.vsix
