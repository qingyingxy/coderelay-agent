# QuixBugs provenance

- Dataset: QuixBugs
- Upstream task: `rpn_eval`
- Repository: https://github.com/jkoppel/QuixBugs
- Revision: `4257f44b0ff1181dedaedee6a447e133219fcebf`
- License: MIT
- Upstream source: `python_programs/rpn_eval.py`
- Upstream cases: `json_testcases/rpn_eval.json`

The defective implementation and official test vectors are preserved. The pytest loader was replaced with Python standard-library `unittest`, and the verifier applies a 15-second process timeout for deterministic local execution. The corrected implementation is stored outside the copied evaluation workspace and is used only for offline Task Set validation.
