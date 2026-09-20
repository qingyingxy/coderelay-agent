# FeatureBench Environment Validation

This entry point prepares one pinned Pandas GroupBy task and runs the official
FeatureBench reference-restoration verifier. It does not expose a real model,
run an A/C matrix, or change Pi memory settings.

Task: `pandas-dev__pandas.82fa2715.test_all_methods.c74b49a1.lv1`.
Dataset: `LiberCoders/FeatureBench`, `v1.0`, `fast`.
Parquet SHA256:
`e8a704f83d673e1cc78086eefb76bd56461ead8a65ca06fd6972f7363be8a775`.
The version matches the published long trajectory; its full user instruction
matches the extracted 103993-byte task statement exactly.

## Prerequisites

- WSL Ubuntu and Docker available to `qingying`.
- Isolated Python environment:
  `/home/qingying/.local/share/pi-featurebench/venv`.
- `featurebench==0.2.3` installed there; dependency versions are captured per run.
- Pinned parquet at `.artifacts/featurebench-v1.0-fast.parquet`.
- Official image `libercoders/featurebench-specs_pandas-instance_15f634a6`,
  approximately 12GB compressed. Image tags can change; record the actual digest.

## Prepare And Verify

From WSL, preparation only:

```sh
/home/qingying/.local/share/pi-featurebench/venv/bin/python /mnt/e/code/pi/packages/coding-agent/evals/context-window/run_featurebench_environment.py --parquet /mnt/e/code/pi/.artifacts/featurebench-v1.0-fast.parquet --output /mnt/e/code/pi/.artifacts/featurebench-pandas-prepare-next
```

Add `--execute-smoke` with a fresh output directory for reference restoration
and official F2P/P2P testing. The default mode is `oracle`. It uses the official
`preprocess_hf_patch` and `run_instance` implementation, without any Agent or
model-generated solution. Original repository-specific timeouts apply.

`--mode masked --execute-smoke` submits only a harmless fixture patch to the
masked task. It is a negative observation mode, not a positive environment
acceptance gate; inspect its raw results separately.

Outputs separate `agent-input/instruction.md` from
`verifier-private/instance.json`. The private record contains the corruption
patch (which exposes reference code) and test restoration data. Never mount
that directory into an Agent container or include it in a model prompt.

## Acceptance

`environment-report.json` must show `oraclePassed: true`. This requires official
completion/resolution, nonzero successful F2P and P2P counts, zero failed cases,
and nonempty output logs for the feature test and all five regression files.
An image/setup failure, zero collected tests or missing test log cannot pass.
Preserve failed attempts in their own output directories.

The public task statement includes all interface descriptions. Do not replace
it with only the short task summary. Preparation produces no paid calls;
the validation entry point has no paid-model option or credentials parameter.

## Agent Integration Boundary

An oracle pass establishes that the reference task can be independently tested.
It does not establish model success or natural context-window behavior.
FeatureBench uses `/testbed` and restores from `/root/my_repo` in the verifier;
future Agent transport must use a separately prepared masked workspace and
exclude reference backups, mask patches and hidden tests. The current environment
entry point does not launch Pi model inference and is not a drop-in Pier task.
