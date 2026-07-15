/**
 * Hermetic snapshot fixture for §5 #20 (real-corpus anchor).
 *
 * SNAPSHOT of `projectSourcePage()` output for the real LogSeq source page
 * "AI Agent Memory Empowered by Knowledge Graphs (Book Notes)"
 * (~/Logseq/MyGraph/pages/AI Agent Memory Empowered by Knowledge Graphs (Book Notes).md),
 * captured 2026-07-15 per the P0 probe (docs/6ji.8-p0-probe.md) which measured this exact
 * page at 16 bands / 16 refs / 0 in-region (all 16 findings land outside every
 * `parseRegions` heading, i.e. they all belong to the synthetic ROOT region).
 *
 * This is a byte snapshot, NOT a live read — the test suite must never touch
 * ~/Logseq at test time. If the source page changes, this fixture (and the
 * P0 probe numbers it encodes) must be re-snapshotted deliberately.
 */
export const AI_AGENT_MEMORY_PROJECTED = `- AI Agent Memory Empowered by Knowledge Graphs (book, ASIN:B0FS9WMYP2)
- It traces an evolution static→dynamic→temporal→event graphs, with event graphs (event nodes + temporal/causal relations) as the basis for episodic memory in agents. _(well-supported)_ [^ai-agent-memory-empowered-by-knowledge-graphs-evolution-of-knowledge-graphs-event-graphs-and-episodic-memory]
  - kind:: method
  - locator:: Evolution of Knowledge Graphs / Event Graphs and Episodic Memory
- It introduces pragmatics (meaning beyond semantics) and uses bigraphs to model context in episodic memory, tying context to the Semantic-Spacetime representation. _(supported)_ [^ai-agent-memory-empowered-by-knowledge-graphs-pragmatics-and-context-bigraphs-for-context]
  - kind:: method
  - locator:: Pragmatics and Context / Bigraphs for Context
- Its thesis peak: causal relations matter more than temporal or semantic ones; it builds causal DAGs and 'causal subspaces' as contextual memory domains, reorienting analysis toward 'why' over where/when/who. _(well-supported)_ [^ai-agent-memory-empowered-by-knowledge-graphs-semantic-spacetime-and-causality-relations]
  - locator:: Semantic Spacetime and Causality Relations
- It distinguishes unlearning from mere memory pruning — unlearning is more complex than learning and belongs to the reflection process, not simple deletion. _(well-supported)_ [^ai-agent-memory-empowered-by-knowledge-graphs-unlearning-in-ai-agents-a-philosophical-deep-dive]
  - locator:: Unlearning in AI Agents: A Philosophical Deep Dive
- It treats forgetting as essential ('the problem with perfect memory'): memory systems need adaptive, importance- and relevance-driven forgetting/pruning mechanisms, with ethical considerations. _(well-supported)_ [^ai-agent-memory-empowered-by-knowledge-graphs-forgetting-in-ai-agent-memory-systems]
  - locator:: Forgetting in AI Agent Memory Systems
- For time travel it surveys append-only logs, functional persistent structures with structural sharing (Datomic-style), and distinguishes event-based from state-based time tracking for property graphs. _(well-supported)_ [^ai-agent-memory-empowered-by-knowledge-graphs-time-traveling-for-knowledge-graphs]
  - kind:: method
  - locator:: Time Traveling for Knowledge Graphs
- It proposes multilayered graphs to model entity states over time, with skip lists connecting layers for efficient cross-time traversal. _(well-supported)_ [^ai-agent-memory-empowered-by-knowledge-graphs-multilayered-graphs-skip-lists-for-layer-connection]
  - kind:: method
  - locator:: Multilayered Graphs / Skip Lists for Layer Connection
- Its Entity-State-Relation model makes entity state first-class: Entity nodes, State nodes (state at a time), and Transition edges (state-changing events) form version-control-like state chains for time travel over an entity's history. _(well-supported)_ [^ai-agent-memory-empowered-by-knowledge-graphs-entity-state-relation-model-a-time-machine-in-graphs]
  - kind:: method
  - locator:: Entity State Relation Model: A Time Machine in Graphs
- It models time structurally as a Time Tree layered over the graph — root to Year/month to finer granularity, with next/previous links — enabling temporal navigation and abstract/partial time references rather than only exact timestamps. _(well-supported)_ [^ai-agent-memory-empowered-by-knowledge-graphs-time-as-a-structure-time-trees]
  - kind:: method
  - locator:: Time as a Structure: Time Trees
- Semantic Spacetime reduces all relations to four link types: NEAR/SIMILAR-TO (proximity), LEADS-TO (causal), CONTAINS (hierarchical), and EXPRESSES-PROPERTY (attributive). _(well-supported)_ [^ai-agent-memory-empowered-by-knowledge-graphs-semantic-spacetime-the-four-fundamental-relationships]
  - kind:: definition
  - locator:: Semantic Spacetime: The Four Fundamental Relationships
- It advocates representing all relations (even binary) as nodes, so relationships carry rich properties and participate in higher-order relationships — approximating metagraph expressiveness on ordinary graph databases. _(well-supported)_ [^ai-agent-memory-empowered-by-knowledge-graphs-relations-as-nodes]
  - kind:: method
  - locator:: Relations as Nodes
- It holds subject-predicate-object triples too limited; multi-entity facts should be modeled as meta-nodes connected to every participating entity (a node-centric stand-in for true hyperedges) so existing graph DBs suffice. _(well-supported)_ [^ai-agent-memory-empowered-by-knowledge-graphs-meta-nodes-as-a-compromise-for-hyper-edges]
  - kind:: method
  - locator:: Meta Nodes as a Compromise for Hyper Edges
- Its foundational premise is an on-device, embeddable, privacy-first 'sovereign small-data' memory engine; it explicitly rejects server databases like Neo4j/PostgreSQL as a mismatch for hardware-constrained edge deployment. _(well-supported)_ [^ai-agent-memory-empowered-by-knowledge-graphs-why-build-our-memory-system]
  - locator:: Why Build Our Memory System
- It defines true memory by five properties: multi-modal structures, active reconstruction (not verbatim recall), associative networks, adaptive forgetting, and hierarchical organization. _(well-supported)_ [^ai-agent-memory-empowered-by-knowledge-graphs-what-makes-memory-truly-memory]
  - kind:: definition
  - locator:: What Makes Memory Truly Memory?
- The book argues AI agent memory is not RAG: true memory requires episodic context, association-building, understanding (not just retrieval), and a forgetting mechanism — capabilities RAG lacks. _(well-supported)_ [^ai-agent-memory-empowered-by-knowledge-graphs-ai-memory-is-not-rag]
  - locator:: AI Memory is Not RAG
- It uses Allen's interval algebra to express temporal relations between events (before, overlaps, during, etc.) as the framework for event-to-event temporal reasoning. _(well-supported)_ [^ai-agent-memory-empowered-by-knowledge-graphs-temporal-intervals-allen-s-algebra]
  - kind:: definition
  - locator:: Temporal Intervals: Allen's Algebra
- Citations
- [^ai-agent-memory-empowered-by-knowledge-graphs-evolution-of-knowledge-graphs-event-graphs-and-episodic-memory]: AI Agent Memory Empowered by Knowledge Graphs — Evolution of Knowledge Graphs / Event Graphs and Episodic Memory · finding:: ce0b4af3-16cc-40c9-a85b-1ced20b10d13
- [^ai-agent-memory-empowered-by-knowledge-graphs-pragmatics-and-context-bigraphs-for-context]: AI Agent Memory Empowered by Knowledge Graphs — Pragmatics and Context / Bigraphs for Context · finding:: dc23f460-1ebd-420b-89a5-2bd2f05d6c31
- [^ai-agent-memory-empowered-by-knowledge-graphs-semantic-spacetime-and-causality-relations]: AI Agent Memory Empowered by Knowledge Graphs — Semantic Spacetime and Causality Relations · finding:: a1f6e6c8-ffeb-488a-8e70-67ca9c96bc76
- [^ai-agent-memory-empowered-by-knowledge-graphs-unlearning-in-ai-agents-a-philosophical-deep-dive]: AI Agent Memory Empowered by Knowledge Graphs — Unlearning in AI Agents: A Philosophical Deep Dive · finding:: b3ca5840-fcde-4189-a505-9aeb92e4cdd3
- [^ai-agent-memory-empowered-by-knowledge-graphs-forgetting-in-ai-agent-memory-systems]: AI Agent Memory Empowered by Knowledge Graphs — Forgetting in AI Agent Memory Systems · finding:: 9685fab7-a695-4b8f-9892-dbbbb32d703d
- [^ai-agent-memory-empowered-by-knowledge-graphs-time-traveling-for-knowledge-graphs]: AI Agent Memory Empowered by Knowledge Graphs — Time Traveling for Knowledge Graphs · finding:: 883d3b23-b986-45eb-af58-2ac38e22c616
- [^ai-agent-memory-empowered-by-knowledge-graphs-multilayered-graphs-skip-lists-for-layer-connection]: AI Agent Memory Empowered by Knowledge Graphs — Multilayered Graphs / Skip Lists for Layer Connection · finding:: 45938eb5-dbec-4fed-94ae-0294c6dfb811
- [^ai-agent-memory-empowered-by-knowledge-graphs-entity-state-relation-model-a-time-machine-in-graphs]: AI Agent Memory Empowered by Knowledge Graphs — Entity State Relation Model: A Time Machine in Graphs · finding:: 46e99958-d2cb-42be-851e-763b0a4e06ae
- [^ai-agent-memory-empowered-by-knowledge-graphs-time-as-a-structure-time-trees]: AI Agent Memory Empowered by Knowledge Graphs — Time as a Structure: Time Trees · finding:: 16a05a28-ba79-41ca-8f67-6664251adbaf
- [^ai-agent-memory-empowered-by-knowledge-graphs-semantic-spacetime-the-four-fundamental-relationships]: AI Agent Memory Empowered by Knowledge Graphs — Semantic Spacetime: The Four Fundamental Relationships · finding:: e1b49d6d-616c-455a-b3fc-96a4aeeebf3e
- [^ai-agent-memory-empowered-by-knowledge-graphs-relations-as-nodes]: AI Agent Memory Empowered by Knowledge Graphs — Relations as Nodes · finding:: 18353921-d2c2-4915-9f29-47b9b37e6dc7
- [^ai-agent-memory-empowered-by-knowledge-graphs-meta-nodes-as-a-compromise-for-hyper-edges]: AI Agent Memory Empowered by Knowledge Graphs — Meta Nodes as a Compromise for Hyper Edges · finding:: 2fc3180a-e843-4774-ab08-4a789bb0a08d
- [^ai-agent-memory-empowered-by-knowledge-graphs-why-build-our-memory-system]: AI Agent Memory Empowered by Knowledge Graphs — Why Build Our Memory System · finding:: d1b3f37b-0d80-4823-8528-5b5a0c90fd6a
- [^ai-agent-memory-empowered-by-knowledge-graphs-what-makes-memory-truly-memory]: AI Agent Memory Empowered by Knowledge Graphs — What Makes Memory Truly Memory? · finding:: 64868648-6a18-484b-b9ce-53646db05024
- [^ai-agent-memory-empowered-by-knowledge-graphs-ai-memory-is-not-rag]: AI Agent Memory Empowered by Knowledge Graphs — AI Memory is Not RAG · finding:: c0da4f02-cc1c-4993-83ea-9c221815db23
- [^ai-agent-memory-empowered-by-knowledge-graphs-temporal-intervals-allen-s-algebra]: AI Agent Memory Empowered by Knowledge Graphs — Temporal Intervals: Allen's Algebra · finding:: 55753407-dde8-4b54-8955-6eeb18bdf332

## Backports shipped (round 2, 2026-05-29)
- <span class="kb-unresolved" title="Not published">KG-Memory Book Round-2 Backports (epic 2kn)</span> — epic 2kn COMPLETE 5/5. Per-feature: <span class="kb-unresolved" title="Not published">Active Forgetting Pass (MAINTAIN decay loop)</span>, <span class="kb-unresolved" title="Not published">Reified Relations-as-Nodes (Fact nodes)</span>, <span class="kb-unresolved" title="Not published">Entity State Chains (time-travel over supersession)</span>, <span class="kb-unresolved" title="Not published">Causal-Cone Recall (causal DAG analysis)</span>.`;

/** P0-measured expectations this snapshot must preserve (docs/6ji.8-p0-probe.md). */
export const AI_AGENT_MEMORY_EXPECTED = { total: 16, cited: 16, rootTotal: 16 };
