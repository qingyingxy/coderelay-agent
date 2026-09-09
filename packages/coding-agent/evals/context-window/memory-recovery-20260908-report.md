# Historical Memory Recovery Evaluation (2026-09-08)

## Scope

This report records a private, self-built text-replay evaluation, not a public
benchmark or a guarantee against forgetting. No product implementation was
changed for this expansion. Original conversations, questions, answer keys,
model responses, and local experiment scripts remain outside version control.

- A: native Pi `session.compact()`, no custom summary instructions or history tools.
- C: window cutting with `new_context`, followed by native `history` lookup.
- Five forced maintenance stages per completed conversation, at identical batch boundaries.
- All questions for a conversation asked together once after final maintenance.
- Questions and answer keys excluded from maintenance inputs; no history-call count cap.
- Original user/assistant roles preserved; tool outputs and image content excluded.
- Single attempt per group and conversation; failed requests not retried.

## Results

The original three-conversation batch was reused unchanged. Four new conversations
added 32 facts, giving seven conversations and 50 facts overall.

| Batch | A completed conversations | A correct / answered facts | C completed conversations | C correct / answered facts |
| --- | ---: | ---: | ---: | ---: |
| Original | 3/3 | 7/18 | 3/3 | 18/18 |
| Expansion | 1/4 | 4/8 | 4/4 | 32/32 |
| Combined | 4/7 | 11/26 | 7/7 | 50/50 |

Three A maintenance requests timed out before final questions were asked, leaving
24 facts unassessed. These are not incorrect answers or evidence of forgetting.
Within the four conversations completed by both groups, A scored 11/26 (42.3%)
and C scored 26/26 (100%). This complete-case subset has selection limitations.

All 50 C facts had supporting original evidence actually returned by history,
not merely present in an on-disk archive. Semantic answers were manually graded
against frozen answer keys. Strict verbatim citation matching passed 41/50;
quotation-wrapper and formatting failures were retained separately. Two incorrect
A expansion answers had relevant information still present in the final summary:
answer-use failure must not be equated with information loss.

## Estimated Model Costs

| Expansion group | Maintenance USD | Query planning USD | Final answers USD | Known total USD | Unknown-request reserve USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 0.8922760 | 0 | 0.0402420 | 0.9325180 | 1.1040000 |
| C | 0.8236240 | 0.2270416 | 0.0491824 | 1.0998480 | 0 |

Expansion known estimated spend: USD 2.0323660. Combined known estimated spend:
USD 4.0098964. Three timed-out requests lack usage, with USD 0.368 reserved each;
the USD 1.104 reserve is not a confirmed charge. Known totals include successful
requests within failed maintenance phases. Both groups stayed within their
separate USD 6 expansion budgets, including unknown-request reservations.

C's seven completed conversations cost an estimated USD 1.8538604. In the matched
four-conversation subset, A cost USD 1.5656520 and C USD 0.9850672. These observations
do not establish general cost savings; unmatched failures remain in total spending.

## Configuration and Limits

- Configured provider/model: `qingyingxy/gpt-5.6-terra`, medium reasoning, 128000 context, 4000 output-token cap.
- USD per million tokens: input 2, output 12, cache read 0.2, cache write 2.5. Costs are usage estimates, not invoices or subscription-quota percentages.
- Provider timeout: 120 seconds; phase timeout: 20 minutes; retries disabled.
- Retained capacities were not matched. This compares complete mechanisms, not compression algorithms under equal storage budgets.
- Fact ages: 29 crossed five maintenance stages, 14 crossed four, six crossed three, and one crossed one. Later repetitions can refresh facts; not all facts survived five unrefreshed windows.
- Seven conversations are not seven independent projects. Convenience sampling, shared projects, and single attempts limit generalization.
- Replay truncation caps were 18000 user characters and 6000 assistant characters. This was not full-session replay or natural context saturation.
- Expansion normalization additionally redacted URL credentials and removed environment, attachment, and interrupted-turn wrappers.
- C recovery used host-authorized isolated Direct execution, as maintenance already did, to prevent historical deletion questions from triggering live-task routing. Provider-request tool whitelists were checked. This harness difference from the original batch is disclosed.
- C started before A and executions overlapped; caching and provider timing can affect cost. A timeouts do not establish an algorithmic reliability defect.

## Audit Trail

Private local artifacts retain frozen inputs, per-question judgments, actual
history results, snapshots, successful usage, and all failures. They are not
published with this report. The final expansion auditor is `audit-final.ts` in
the ignored local expansion artifact directory; no model calls are needed to audit.

Expansion input hash: `ab0ae84ac86232607a040ed55bdeccb7a042054f78ef2d3a3e79a49f2ca618e4`.
Original input hash: `1a44e3c355fd3e0e3cd94339035bfd90074ee2d78dbcdbae6c3332f175bcab28`.

Local faux trajectories, input hashes, actual maintenance counts, tool whitelists,
evidence availability, and budget arithmetic were checked. The evaluation-time
`npm run check` exited zero but reported an existing Biome access-denied diagnostic
and npm configuration warnings; it was not a warning-free verification.
