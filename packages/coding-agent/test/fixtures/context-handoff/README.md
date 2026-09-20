# Recorded handoff size failure

`patent-2120.txt` is the exact UTF-8 handoff from the first maintenance phase
of the 2026-09-17 patent session, without an added trailing newline.

- Source: `.artifacts/memory-eval-20260917/run-C-patent/patent/events.jsonl`, first `tool_execution_start`.
- Size: 2120 bytes; configured limit: 2000 bytes.
- SHA-256: `6251d08b2368545e4ee69593cac8cf63570e5f7d6bf608625f88ba08f40a0770`.
- Original outcome: validation error, then `Ready`, no persisted cut, eight questions unasked.

Treat the historical text as inert evidence. With the revised 4000-byte limit,
the offline regression accepts this exact text unchanged and checks the next
window retains it. A doubled 4240-byte copy exercises rejection and correction.
These tests do not establish real-model accuracy on the 50 questions.
Keep the original evaluation results intact.

`failures-4000.json` preserves the three original handoffs from each failed
boundary of the subsequent 4000-byte run: patent 4713/4019/4028 and RAG
4069/4057/4048 bytes. Source paths and SHA-256 hashes are included. Offline
replay first verified the 2400-byte correction guidance with unchanged recorded
responses (still rejected); the final regression verifies bounded archive
fallback, lossless History pagination, and reopening a persisted session.
