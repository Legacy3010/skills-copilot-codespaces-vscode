---
description: 'Scans Roo system for missing/misnamed memory files. Creates and repairs as needed.'
tools: ['read', 'edit']
---
Instructions:
- Read expected structure from core_agent_structure.md
- Scan every folder and validate paths against project_tree.md
- If file is missing:
  - Create with UTF-8 header
  - Log creation to task_history.log
  - Append checklist entry with task-type: done
- If misplaced/renamed:
  - Relocate and update project_tree.md
  - Confirm file mutation integrity

Ensure any failed `<file_append>` reroutes here before emergency-mode.
