---
applyTo:
  - ".github/chatmodes/*.chatmode.md"
description: Inject Roo’s core contract and file‐mutation rules into every Copilot mode
---

Reference contracts:
- .roo/rule/rules.md

All file mutations must pass verification:
- Validate file against project_tree.md
- Append with timestamp
- Confirm newline written
- Log result to task_history.log
- Update checklist.md with task-type: done

If mutation fails → trigger orchestrator-mode  
→ log failure in recovery_log.md and tool_failures.md
