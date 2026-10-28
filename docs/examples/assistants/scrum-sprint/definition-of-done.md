# Definition of done (docs and code changes)

A story is done only when all of this is true. The reviewer checks it, the product owner confirms the acceptance criteria.

1. Every acceptance criterion of the story is met and each one can be shown (a command output, a page, a test).
2. Code: the change has a test that fails without it; existing tests pass; no unrelated changes in the diff.
3. Docs: every changed behaviour is described; code samples run; links work; the wording follows the style guide (short sentences, no marketing).
4. The diff is small enough to review in one sitting; a story that needs a large unrelated refactor is split, not stretched.
5. Nothing is committed, pushed or deployed by the team agent: the result is a change set in `/files/out/work/<story id>/` with a short `CHANGES.md` (what, why, how it was checked).
6. The reviewer has approved it in writing, with the list of checks made.

Not done means not counted: a story missing any point goes back to implementation or is carried over to the backlog with the reason.
