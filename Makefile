# _ROADMAP (generated ROADMAP.md from the bd graph)
DOCEXPAND ?= bun ~/.claude/skills/_TOOLING/_DOC_GEN/Tools/DocExpand.ts
DOCGEN_CONFIG ?= .claude/skill-data/DocGen.json

.PHONY: roadmap roadmap-extract roadmap-validate
roadmap-extract: ; $(DOCEXPAND) --config $(DOCGEN_CONFIG) --introspect
roadmap: roadmap-extract ; $(DOCEXPAND) --config $(DOCGEN_CONFIG)
roadmap-validate: ; $(DOCEXPAND) --config $(DOCGEN_CONFIG) --validate
