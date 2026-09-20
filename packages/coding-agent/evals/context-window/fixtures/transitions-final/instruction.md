# Final-State Callback Consistency

Extend this pre-feature version of transitions with final-state callbacks.

Requirements:

1. State accepts `final`, defaulting to false. Machine accepts `on_final` using
   its existing callback conventions. Entering a final state invokes the final
   callback; entering a non-final state does not. Leaving and re-entering a
   final state invokes the callback again for that new entry.
2. Failed transition conditions must not change state or invoke final callbacks.
3. NestedState supports `final` and `on_final`. HierarchicalMachine propagates
   completion from final children to their parent and the machine as appropriate.
4. Parallel states are complete only when all active regions are final. Completing
   the last-declared region first must not cause premature or duplicate machine
   completion. Support both orders of completing two unfinished regions when a
   third region is already final.
5. AsyncMachine and HierarchicalAsyncMachine preserve the same semantics and
   await asynchronous final callbacks before the transition finishes.
6. Public type stubs declare the new parameters. Preserve existing core, state,
   nested, async, threading and parallel behavior.

Implement this as one coherent feature using existing project conventions.
Add meaningful local tests and run the relevant regressions. Distinguish code
changes from verified behavior and report checks that could not run. Reference
implementation patches and independent acceptance results are unavailable to
the implementing agent.
