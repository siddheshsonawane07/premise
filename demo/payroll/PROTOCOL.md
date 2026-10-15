# The second test: Tallyroll, fixed before it runs

Written and committed on 2026-10-16, **before any Tallyroll session ran.** The git history shows
this file landing before the capture, the answer key and the measurement.

## Why a second test

The Tilldesk numbers in the README are weaker than they look:
- The same author made the app, the prompts and the answer key while building Premise.
- Premise changed after its results were seen. The `session` tier was added once it found 5 of 7.
- A fifth session was added afterwards.
- One Tilldesk prompt steered how a figure was written ("one paise literal"), and the app's
  CLAUDE.md showed the exact spelling of the figure (`50_000_00`).

This test fixes everything in advance and reports whatever comes out.

## What is fixed

**The app.** Tallyroll, an invented payroll service for employers in India and the US, in a
fresh repository with no code. Its `CLAUDE.md`, in full:

> # Tallyroll
>
> An invented payroll service for employers in India and the US. Synthetic demo data only.
>
> - TypeScript, Node 22, tests with vitest (`npm test`).
> - Money is an integer in the smallest unit: paise for INR, cents for USD.
> - Indian payroll code lives in `src/in/`, US payroll in `src/us/`, HR tools for both countries in
>   `src/hr/`, reports in `src/reports/`. Tests go in `test/`.

It gives no example of how to write a figure, and says nothing about Premise.

**The rules**, recorded by the compliance member before the first session
([`demo/payroll.ts`](../payroll.ts)). All three are real and public:

| Rule | Figure | Declared scope |
|---|---|---|
| `in-epf-ceiling`: EPF and EPS wage ceiling | ₹15,000 a month | `src/in` |
| `in-esi-ceiling`: ESI coverage ceiling | ₹21,000 a month | `src/in` |
| `us-flsa-salary`: FLSA exemption salary level | $684 a week | `src/us` |

**The sessions:** five, in this order, each a fresh headless Claude Code session in the Tallyroll
repository, with the member's own key. The prompts, verbatim:

1. **Asha:** "Add Indian payroll: calculate an employee's monthly EPF contributions, the employee's share and the employer's share split between EPF and EPS, from basic wages, following the statutory wage ceiling. Add tests."
2. **Ben:** "Add US payroll: decide whether a salaried employee is exempt from overtime under the FLSA salary level test, and calculate weekly gross pay including overtime for non-exempt employees. Add tests."
3. **Asha:** "Add ESI contributions for Indian employees, and a payslip formatter for Indian employees that shows the PF, pension and ESI lines, with a short note under each line explaining when it applies. Add tests."
4. **Ben:** "Add an onboarding check that looks at a new hire's offered salary and tells HR what statutory coverage applies: for an Indian hire, PF and ESI; for a US hire, whether the role can be overtime-exempt. Add tests."
5. **Asha:** "Add a monthly compliance summary that takes a list of employees from both countries and counts how many are covered by mandatory PF, how many by ESI, and how many US employees are paid enough to be overtime-exempt. Output CSV. Add tests."

Each session runs as:

```
claude -p "<prompt>" --permission-mode acceptEdits \
  --allowedTools "Read,Write,Edit,Glob,Grep,mcp__premise,Bash(npm test),Bash(npx vitest run)" < /dev/null
```

The repository is committed after each session, as a developer would.

**The change measured.**
- **Main:** `in-epf-ceiling` goes from ₹15,000 to ₹25,000 a month. The Union Cabinet approved
  this on 2026-09-16, and the notification is pending.
- **Second:** `us-flsa-salary` goes from $684 to $844 a week, the level of the vacated 2024 rule.

**The answer key.** After the fifth session, and before any Premise query is run for measurement,
every file in `src/` and `test/` is read. A file goes in the key if its behaviour, output or text
would be wrong once the figure changes. That includes figures derived from it: EPS is 8.33% of
wages up to the ceiling, so a hard-coded ₹1,250 counts. The key is committed before the
measurement.

**The methods compared**, the same as for Tilldesk:
- `grep` for every spelling of the old figure (`figureSpellings` in `src/core/rules.ts`);
- the rule's declared folders;
- Premise (`findAffected`, the function a rule change runs);
- `grep` and Premise together.

**No change to Premise's code** between this commit and the committed measurement. If a session
fails because of a Premise bug, the bug is fixed, the whole run is restarted from an empty
repository and team, and the restart is reported with the results.

## Restarts

**Restart 1, 2026-10-16 00:49 IST: session 1 stopped without writing code.** Premise held the EPF
wage ceiling but not the contribution rates (12% from each side, 8.33% of it to EPS), and its
reply for a rule it does not hold was "Ask the user; do not guess the figure." The agent obeyed.
It wrote nothing and listed the rates it needed. No team's registry holds every figure, so this is
a Premise bug, not a quirk of the test. Two fixes:
- **The not-found reply now offers a path.** An agent that can cite a source records the figure
  with `record_rule`, passing the file it is writing, and uses it. The rule stays a draft until the
  compliance member confirms or corrects it, and the file is linked to it, so a correction finds
  the file. With no citable source, the agent still asks.
- **A developer's agent can no longer record a *final* rule** through `record_rule`. Before this
  fix it could, which bypassed the rule that only compliance makes anything final.

The prompts, rules and scoring are unchanged. The Tallyroll repository was reset to its empty
commit, the team rebuilt and the capture discarded before the rerun.

## Results

Not yet run.
