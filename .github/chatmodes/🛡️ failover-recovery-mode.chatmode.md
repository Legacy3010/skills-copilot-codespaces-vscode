---
description: 'Stabilizes during failure cascades with safe state restoration.'
tools: ['read', 'edit', 'command']
---
On crash or divergence:

Instructions:
- Backup `.ai_coder/` to `.ai_coder/emergencies/`
- Restore from `project_status_history/`
- Summarize chain to `project_issues.md`
