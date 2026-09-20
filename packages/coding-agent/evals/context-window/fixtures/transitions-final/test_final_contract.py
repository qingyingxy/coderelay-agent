"""Independent contract derived from transitions PR 665 and issue 715."""

import asyncio
import ast
import inspect
import os
from pathlib import Path
from unittest.mock import Mock

import pytest
import transitions
from transitions import Machine, State
from transitions.extensions import HierarchicalMachine
from transitions.extensions.asyncio import AsyncMachine, HierarchicalAsyncMachine


@pytest.fixture(autouse=True)
def verify_target_import():
    expected = Path(os.environ["TRANSITIONS_TARGET"]).resolve()
    assert Path(transitions.__file__).resolve().is_relative_to(expected)


def parallel_states(callbacks):
    return ["A", {"name": "B", "on_final": callbacks["B"], "parallel": [
        {"name": "X", "final": True},
        {"name": "Y", "initial": "start", "on_final": callbacks["Y"],
         "children": ["start", {"name": "done", "final": True}],
         "transitions": [["finish_Y", "start", "done"]]},
        {"name": "Z", "initial": "start", "on_final": callbacks["Z"],
         "children": ["start", {"name": "done", "final": True}],
         "transitions": [["finish_Z", "start", "done"]]},
    ]}]


def test_final_flag_default_and_public_signature():
    assert State("ordinary").final is False
    assert State("done", final=True).final is True
    assert "on_final" in inspect.signature(Machine).parameters


def test_public_stub_parameters_include_final_contract():
    root = Path(transitions.__file__).resolve().parent
    for relative, name, required in [
        ("core.pyi", "State", {"final"}),
        ("core.pyi", "Machine", {"on_final"}),
        ("extensions/nesting.pyi", "NestedState", {"final", "on_final"}),
        ("extensions/asyncio.pyi", "AsyncMachine", {"on_final"}),
    ]:
        module = ast.parse((root / relative).read_text())
        cls = next(node for node in module.body if isinstance(node, ast.ClassDef) and node.name == name)
        init = next(node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == "__init__")
        parameters = {arg.arg for arg in [*init.args.posonlyargs, *init.args.args, *init.args.kwonlyargs]}
        assert required <= parameters, (relative, name, required - parameters)


@pytest.mark.parametrize("machine_cls", [Machine, HierarchicalMachine])
def test_sync_terminal_entry_reentry_and_nonterminal(machine_cls):
    callback = Mock()
    machine = machine_cls(states=["A", {"name": "B", "final": True}], initial="A", on_final=callback)
    callback.assert_not_called()
    machine.to_B()
    assert callback.call_count == 1
    machine.to_A()
    assert callback.call_count == 1
    machine.to_B()
    assert callback.call_count == 2


@pytest.mark.parametrize("machine_cls", [Machine, HierarchicalMachine])
def test_failed_condition_does_not_finalize(machine_cls):
    callback = Mock()
    machine = machine_cls(states=["A", {"name": "B", "final": True}], initial="A", on_final=callback)
    machine.add_transition("blocked", "A", "B", conditions=lambda: False)
    assert machine.blocked() is False
    assert machine.state == "A"
    callback.assert_not_called()


def test_nested_parent_and_machine_finalize_together():
    parent, complete = Mock(), Mock()
    machine = HierarchicalMachine(states=["A", {"name": "B", "initial": "start", "on_final": parent,
        "children": ["start", {"name": "done", "final": True}]}], initial="A", on_final=complete)
    machine.to_B()
    parent.assert_not_called()
    complete.assert_not_called()
    machine.to_B_done()
    assert parent.call_count == complete.call_count == 1


@pytest.mark.parametrize("order", [("Y", "Z"), ("Z", "Y")])
def test_parallel_all_regions_required_in_either_order(order):
    callbacks = {name: Mock() for name in ["B", "Y", "Z", "machine"]}
    machine = HierarchicalMachine(states=parallel_states(callbacks), initial="A", on_final=callbacks["machine"])
    machine.to_B()
    assert all(callback.call_count == 0 for callback in callbacks.values())
    getattr(machine, "finish_" + order[0])()
    assert callbacks[order[0]].call_count == 1
    assert callbacks[order[1]].call_count == 0
    assert callbacks["B"].call_count == callbacks["machine"].call_count == 0
    getattr(machine, "finish_" + order[1])()
    assert all(callback.call_count == 1 for callback in callbacks.values())


@pytest.mark.parametrize("machine_cls", [AsyncMachine, HierarchicalAsyncMachine])
def test_async_callback_awaited_and_reentry(machine_cls):
    async def run():
        finished = []

        async def callback():
            await asyncio.sleep(0)
            finished.append("finished")

        machine = machine_cls(states=["A", {"name": "B", "final": True}], initial="A", on_final=callback)
        assert finished == []
        await machine.to_B()
        assert finished == ["finished"]
        await machine.to_A()
        assert finished == ["finished"]
        await machine.to_B()
        assert finished == ["finished", "finished"]

    asyncio.run(run())


@pytest.mark.parametrize("order", [("Y", "Z"), ("Z", "Y")])
def test_async_parallel_all_regions_required(order):
    async def run():
        calls = {name: 0 for name in ["B", "Y", "Z", "machine"]}

        def callback_for(name):
            async def callback():
                await asyncio.sleep(0)
                calls[name] += 1
            return callback

        callbacks = {name: callback_for(name) for name in calls}
        machine = HierarchicalAsyncMachine(states=parallel_states(callbacks), initial="A", on_final=callbacks["machine"])
        await machine.to_B()
        assert all(count == 0 for count in calls.values())
        await getattr(machine, "finish_" + order[0])()
        assert calls[order[0]] == 1
        assert calls["B"] == calls["machine"] == calls[order[1]] == 0
        await getattr(machine, "finish_" + order[1])()
        assert all(count == 1 for count in calls.values())

    asyncio.run(run())
