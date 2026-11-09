# Voice interface research: frontend decisions

Research date: 2026-11-09. Neeraj reports that the live assistant works, and requested a more usable frontend. Two headed Google passes used four queries; four selected sources were extracted through cdp-cli. The user explicitly allowed a one-time browser-budget override. The detailed query, selection and extraction artifacts are under `tmp/research-web-critical/voice-frontend/` and are local, disposable evidence.

## Critical findings

- **Voice is useful but not self-explanatory.** [Nielsen Norman Group's study](https://www.nngroup.com/articles/intelligent-assistant-usability/) observed 17 people using earlier-generation assistants, finding difficulties with discovery and complex requests. That dated, small study is not a benchmark for the current model; it motivates example questions and a visible non-voice route, not a claim that Mira shares its measured error rate.
- **A visual refresh alone cannot prove accessibility.** [A systematic review of voice assistant usability](https://pmc.ncbi.nlm.nih.gov/articles/PMC9063617/) examines effectiveness, efficiency and satisfaction across published studies. The reviewed products and settings differ; our desktop/mobile browser checks cannot substitute for testing with diverse users.
- **Explain tasks and make errors recoverable.** [A study of conversational AI interfaces for older users](https://www.mdpi.com/2076-3417/16/11/5214) identifies understandable functions, clear feedback and error-tolerant interaction as priorities. Its population and mobile-app context limit generalization; the design keeps explicit session setup, status and accessible manual controls rather than claiming age-inclusive usability has been established.
- **Interruption and status matter, but need real evidence.** [Orbix's voice design discussion](https://orbix.studio/blogs/voice-user-interface-design) recommends clear voice feedback and control. It is a commercial design source, not independent proof of outcomes. The page preserves an explicit end-call action and existing live status; true interruption and acoustic quality remain matters for user testing.

Alternatives considered: a voice-only screen would hide recovery and write confirmation; an all-controls dashboard would retain competing visual priorities. The selected voice-first view keeps lower-frequency service tools available without changing their authority. The UI discloses provider use, potential charges and that no person is connected.

## Evidence boundaries

This was a bounded study (four Google queries, four extracted pages and one HN thread), not the 20–40-page medium-depth coverage described by the research skill. No claim of comprehensive research or verified language accuracy is made. The user separately confirmed voice works; no recording of that session or assessment of accents, accessibility, interruptions or latency was supplied.

A second headed search pass located a [2020 Hacker News discussion by speech practitioners](https://news.ycombinator.com/item?id=24897279). Several comments describe frustration after failures and difficulty discovering voice capabilities; these are anecdotes about older products, not representative measurements or evidence of Mira's model performance. They reinforce visible examples and a manual route.
