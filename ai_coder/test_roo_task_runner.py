import json
import sys
import tempfile
import unittest

from pathlib import Path

from roo_task_runner import RooTaskRunner


class RooTaskRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repo_root = Path(self.temp_dir.name)
        self.ai_root = self.repo_root / "ai_coder"
        for relative in [
            "context",
            "goals",
            "logs",
            "reports",
            "status",
            "tasks",
        ]:
            (self.ai_root / relative).mkdir(parents=True, exist_ok=True)

        (self.ai_root / "context" / "context_log.md").write_text(
            "# Context Log\n",
            encoding="utf-8",
        )
        (self.ai_root / "context" / "project_tree.md").write_text(
            "# Project Tree\n",
            encoding="utf-8",
        )
        (self.ai_root / "context" / "current_task.lock").write_text(
            "",
            encoding="utf-8",
        )
        (self.ai_root / "goals" / "permanent_mission.md").write_text(
            "Deliver deterministic automation.\n",
            encoding="utf-8",
        )
        for relative in [
            "logs/task_history.log",
            "logs/execution_trace.log",
            "logs/tool_failures.md",
            "logs/recovery_log.md",
            "status/checklist.md",
            "status/test_outcomes.md",
            "status/mode_switches.log",
        ]:
            (self.ai_root / relative).write_text("", encoding="utf-8")

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_run_task_updates_state_and_writes_report(self):
        target_file = self.ai_root / "reports" / "demo_target.md"
        target_file.write_text("Status: pending\n", encoding="utf-8")
        self.write_validation_test(passing=True)
        task_file = self.write_task_file(
            {
                "task_id": "demo-success",
                "summary": "Run a successful Roo task.",
                "description": "Replace pending with completed and run tests.",
                "target_file": "ai_coder/reports/demo_target.md",
                "report_file": "ai_coder/reports/project_report.md",
                "test_command": [
                    sys.executable,
                    "-m",
                    "unittest",
                    "discover",
                    "-s",
                    "ai_coder",
                    "-p",
                    "test_validation.py",
                    "-v",
                ],
                "operation": {
                    "type": "replace_text",
                    "old_text": "Status: pending",
                    "new_text": "Status: completed",
                },
            }
        )

        result = RooTaskRunner(self.repo_root).run_task(task_file)

        self.assertTrue(result.success)
        self.assertIn(
            "Status: completed",
            target_file.read_text(encoding="utf-8"),
        )
        self.assertIn(
            "status: completed",
            (self.ai_root / "context" / "current_task.lock").read_text(
                encoding="utf-8"
            ),
        )
        self.assertIn(
            "Mode: Report",
            (self.ai_root / "logs" / "task_history.log").read_text(
                encoding="utf-8"
            ),
        )
        self.assertIn(
            "demo-success passed",
            (self.ai_root / "status" / "test_outcomes.md").read_text(
                encoding="utf-8"
            ),
        )
        self.assertTrue(result.report_file.exists())

    def test_run_task_blocks_and_logs_failure(self):
        target_file = self.ai_root / "reports" / "demo_target.md"
        target_file.write_text("Status: pending\n", encoding="utf-8")
        self.write_validation_test(passing=False)
        task_file = self.write_task_file(
            {
                "task_id": "demo-failure",
                "summary": "Run a failing Roo task.",
                "description": (
                    "Replace pending with completed and fail tests."
                ),
                "target_file": "ai_coder/reports/demo_target.md",
                "report_file": "ai_coder/reports/project_report.md",
                "test_command": [
                    sys.executable,
                    "-m",
                    "unittest",
                    "discover",
                    "-s",
                    "ai_coder",
                    "-p",
                    "test_validation.py",
                    "-v",
                ],
                "operation": {
                    "type": "replace_text",
                    "old_text": "Status: pending",
                    "new_text": "Status: completed",
                },
            }
        )

        result = RooTaskRunner(self.repo_root).run_task(task_file)

        self.assertFalse(result.success)
        self.assertIn(
            "status: blocked",
            (self.ai_root / "context" / "current_task.lock").read_text(
                encoding="utf-8"
            ),
        )
        self.assertIn(
            "demo-failure failed",
            (self.ai_root / "status" / "test_outcomes.md").read_text(
                encoding="utf-8"
            ),
        )
        self.assertIn(
            "demo-failure failed",
            (self.ai_root / "logs" / "tool_failures.md").read_text(
                encoding="utf-8"
            ),
        )
        self.assertIn(
            "Status: blocked",
            result.report_file.read_text(encoding="utf-8"),
        )

    def test_select_next_task_file_reads_pending_queue_entry(self):
        first = self.write_task_file(
            {
                "task_id": "done-task",
                "summary": "Already completed task.",
                "description": "Not selected.",
                "target_file": "ai_coder/reports/done.md",
                "report_file": "ai_coder/reports/project_report.md",
                "test_command": [sys.executable, "-V"],
                "operation": {
                    "type": "append_text",
                    "content": "done\n",
                },
            }
        )
        second = self.write_task_file(
            {
                "task_id": "pending-task",
                "summary": "Pending queue task.",
                "description": "Should be selected.",
                "target_file": "ai_coder/reports/pending.md",
                "report_file": "ai_coder/reports/project_report.md",
                "test_command": [sys.executable, "-V"],
                "operation": {
                    "type": "append_text",
                    "content": "pending\n",
                },
            }
        )
        self.append_queue_line("done-task", first, "done")
        self.append_queue_line("pending-task", second, "todo")

        selected = RooTaskRunner(self.repo_root).select_next_task_file()

        self.assertEqual(selected, second)

    def test_run_next_task_executes_queued_task(self):
        target_file = self.ai_root / "reports" / "queued.md"
        target_file.write_text("queued start\n", encoding="utf-8")
        self.write_validation_test(passing=True)
        task_file = self.write_task_file(
            {
                "task_id": "queued-task",
                "summary": "Run queued Roo task.",
                "description": "Append content using checklist orchestration.",
                "target_file": "ai_coder/reports/queued.md",
                "report_file": "ai_coder/reports/project_report.md",
                "test_command": [
                    sys.executable,
                    "-m",
                    "unittest",
                    "discover",
                    "-s",
                    "ai_coder",
                    "-p",
                    "test_validation.py",
                    "-v",
                ],
                "operation": {
                    "type": "append_text",
                    "content": "queued complete\n",
                },
            }
        )
        self.append_queue_line("queued-task", task_file, "todo")

        result = RooTaskRunner(self.repo_root).run_next_task()

        self.assertTrue(result.success)
        self.assertIn(
            "queued complete",
            target_file.read_text(encoding="utf-8"),
        )
        checklist_text = (self.ai_root / "status" / "checklist.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("Queue Task: queued-task", checklist_text)
        self.assertIn("task-type: done", checklist_text)

    def write_task_file(self, payload):
        task_file = self.ai_root / "tasks" / f"{payload['task_id']}.json"
        task_file.write_text(
            json.dumps(payload, indent=2),
            encoding="utf-8",
        )
        return task_file

    def append_queue_line(self, task_id, task_file, task_type):
        checklist_file = self.ai_root / "status" / "checklist.md"
        with checklist_file.open("a", encoding="utf-8") as handle:
            handle.write(
                f"[2026-03-16 17:00:00 UTC] Queue Task: {task_id}, "
                f"File: {task_file.relative_to(self.repo_root)}, "
                f"task-type: {task_type}, Note: queued for orchestration.\n"
            )

    def write_validation_test(self, passing):
        assertion = (
            "self.assertTrue(True)"
            if passing
            else "self.assertTrue(False)"
        )
        (self.ai_root / "test_validation.py").write_text(
            "\n".join(
                [
                    "import unittest",
                    "",
                    "",
                    "class ValidationTest(unittest.TestCase):",
                    "    def test_validation(self):",
                    f"        {assertion}",
                    "",
                    "",
                    "if __name__ == '__main__':",
                    "    unittest.main()",
                    "",
                ]
            ),
            encoding="utf-8",
        )


if __name__ == "__main__":
    unittest.main()
