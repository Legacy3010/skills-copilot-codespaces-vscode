import argparse
import json
import subprocess
import sys

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


TIMESTAMP_FORMAT = "%Y-%m-%d %H:%M:%S UTC"


@dataclass(frozen=True)
class TaskSpec:
    task_id: str
    summary: str
    description: str
    target_file: str
    report_file: str
    test_command: list[str]
    operation: dict[str, str]


@dataclass(frozen=True)
class RunnerResult:
    success: bool
    report_file: Path
    target_file: Path
    test_output: str


class RooTaskRunner:
    def __init__(self, repo_root: Path):
        self.repo_root = repo_root.resolve()
        self.ai_root = self.repo_root / "ai_coder"
        self.context_dir = self.ai_root / "context"
        self.goals_dir = self.ai_root / "goals"
        self.logs_dir = self.ai_root / "logs"
        self.reports_dir = self.ai_root / "reports"
        self.status_dir = self.ai_root / "status"

    def run_task(self, task_file: Path) -> RunnerResult:
        task = self.load_task(task_file)
        task_path = self.normalize_task_path(task_file)
        return self.execute_task(task, task_path=task_path, queued_task=False)

    def run_next_task(self) -> RunnerResult:
        task_file = self.select_next_task_file()
        task = self.load_task(task_file)
        task_path = self.normalize_task_path(task_file)
        self.record_step(
            mode="Orchestrator",
            task_summary=task.summary,
            tool="select_next_task",
            target_file="ai_coder/status/checklist.md",
            outcome=f"Selected queued task file {task_path}.",
            task_type="todo",
            trace=(
                "<thinking> Selected the next pending checklist task for "
                f"{task.task_id}. </thinking>"
            ),
            context_summary=(
                f"Selected queued task {task.task_id} from checklist."
            ),
        )
        self.append_queue_status(
            task.task_id,
            task_path,
            task_type="in_progress",
            note="Picked automatically from checklist queue.",
        )
        return self.execute_task(task, task_path=task_path, queued_task=True)

    def execute_task(
        self,
        task: TaskSpec,
        task_path: str,
        queued_task: bool,
    ) -> RunnerResult:
        memory = self.load_memory()
        started_at = self.timestamp()
        plan = self.build_plan(task)

        self.write_current_task_lock(
            task,
            status="in_progress",
            mode="Architect",
            started_at=started_at,
            updated_at=started_at,
            note="Planning task execution.",
        )
        self.record_step(
            mode="Architect",
            task_summary=task.summary,
            tool="plan_task",
            target_file="ai_coder/context/current_task.lock",
            outcome="Created deterministic execution plan.",
            task_type="todo",
            trace=f"<thinking> Planning steps: {' | '.join(plan)} </thinking>",
            context_summary=(
                f"Planned task {task.task_id} using mission and context files."
            ),
        )

        try:
            self.write_current_task_lock(
                task,
                status="in_progress",
                mode="Code",
                started_at=started_at,
                updated_at=self.timestamp(),
                note="Applying file edit.",
            )
            code_outcome = self.apply_operation(task)
            self.record_step(
                mode="Code",
                task_summary=task.summary,
                tool=task.operation["type"],
                target_file=task.target_file,
                outcome=code_outcome,
                task_type="done",
                trace=(
                    "<thinking> Applying deterministic file mutation to "
                    f"{task.target_file}. </thinking>"
                ),
                context_summary=(
                    f"Edited {task.target_file} during task {task.task_id}."
                ),
            )

            self.write_current_task_lock(
                task,
                status="in_progress",
                mode="Test",
                started_at=started_at,
                updated_at=self.timestamp(),
                note="Running validation command.",
            )
            test_result = subprocess.run(
                task.test_command,
                cwd=self.repo_root,
                capture_output=True,
                text=True,
                check=False,
            )
            test_output = self.format_test_output(test_result)
            self.append_test_outcome(task, test_result, test_output)

            if test_result.returncode != 0:
                raise RuntimeError(
                    "Validation command failed with exit code "
                    f"{test_result.returncode}."
                )

            self.record_step(
                mode="Test",
                task_summary=task.summary,
                tool="run_validation",
                target_file="ai_coder/status/test_outcomes.md",
                outcome=(
                    "Validation command succeeded: "
                    f"{' '.join(task.test_command)}"
                ),
                task_type="done",
                trace=(
                    "<thinking> Validation succeeded for task "
                    f"{task.task_id}. </thinking>"
                ),
                context_summary=(
                    f"Validation passed for task {task.task_id}."
                ),
            )

            self.write_current_task_lock(
                task,
                status="completed",
                mode="Report",
                started_at=started_at,
                updated_at=self.timestamp(),
                note="Writing task report.",
            )
            report_file = self.write_report(task, plan, memory, test_output)
            self.record_step(
                mode="Report",
                task_summary=task.summary,
                tool="write_report",
                target_file=str(report_file.relative_to(self.repo_root)),
                outcome="Wrote task report and closed task lock.",
                task_type="done",
                trace=(
                    "<thinking> Reported successful completion for task "
                    f"{task.task_id}. </thinking>"
                ),
                context_summary=(
                    f"Reported successful completion for task {task.task_id}."
                ),
            )
            if queued_task:
                self.append_queue_status(
                    task.task_id,
                    task_path,
                    task_type="done",
                    note="Queued task completed successfully.",
                )

            return RunnerResult(
                success=True,
                report_file=report_file,
                target_file=self.resolve_repo_path(task.target_file),
                test_output=test_output,
            )
        except Exception as exc:
            self.handle_failure(task, started_at, exc)
            if queued_task:
                self.append_queue_status(
                    task.task_id,
                    task_path,
                    task_type="blocked",
                    note=f"Queued task blocked: {exc}",
                )
            report_file = self.write_report(
                task,
                plan,
                memory,
                str(exc),
                success=False,
            )
            return RunnerResult(
                success=False,
                report_file=report_file,
                target_file=self.resolve_repo_path(task.target_file),
                test_output=str(exc),
            )

    def select_next_task_file(self) -> Path:
        queue_entries = self.parse_checklist_queue()
        for entry in queue_entries:
            if entry["task_type"] == "todo":
                return self.resolve_repo_path(entry["task_file"])

        raise ValueError("No pending checklist tasks found.")

    def parse_checklist_queue(self) -> list[dict[str, str]]:
        checklist_text = self.read_if_exists(self.status_dir / "checklist.md")
        entries: dict[str, dict[str, str]] = {}
        order: list[str] = []

        for line in checklist_text.splitlines():
            if "Queue Task:" not in line or "task-type:" not in line:
                continue

            entry = self.parse_queue_line(line)
            task_id = entry["task_id"]
            if task_id not in entries:
                order.append(task_id)
            entries[task_id] = entry

        return [entries[task_id] for task_id in order]

    def parse_queue_line(self, line: str) -> dict[str, str]:
        _, payload = line.split("Queue Task:", 1)
        task_id_part, payload = payload.split(", File:", 1)
        file_part, payload = payload.split(", task-type:", 1)
        task_type_part, _, note_part = payload.partition(", Note:")
        return {
            "task_id": task_id_part.strip(),
            "task_file": file_part.strip(),
            "task_type": task_type_part.strip(),
            "note": note_part.strip(),
        }

    def append_queue_status(
        self,
        task_id: str,
        task_file: str,
        task_type: str,
        note: str,
    ) -> None:
        self.append_text(
            self.status_dir / "checklist.md",
            (
                f"[{self.timestamp()}] Queue Task: {task_id}, "
                f"File: {task_file}, "
                f"task-type: {task_type}, Note: {note}"
            ),
        )

    def load_task(self, task_file: Path) -> TaskSpec:
        data = json.loads(task_file.read_text(encoding="utf-8"))
        required = {
            "task_id",
            "summary",
            "description",
            "target_file",
            "report_file",
            "test_command",
            "operation",
        }
        missing = sorted(required - data.keys())
        if missing:
            raise ValueError(
                f"Task file is missing required fields: {', '.join(missing)}"
            )

        if (
            not isinstance(data["test_command"], list)
            or not data["test_command"]
        ):
            raise ValueError("test_command must be a non-empty list.")

        operation = data["operation"]
        if operation.get("type") not in {"append_text", "replace_text"}:
            raise ValueError(
                "operation.type must be append_text or replace_text."
            )

        return TaskSpec(
            task_id=data["task_id"],
            summary=data["summary"],
            description=data["description"],
            target_file=data["target_file"],
            report_file=data["report_file"],
            test_command=[str(value) for value in data["test_command"]],
            operation=operation,
        )

    def load_memory(self) -> dict[str, str]:
        return {
            "mission": self.read_if_exists(
                self.goals_dir / "permanent_mission.md"
            ),
            "context_log": self.read_if_exists(
                self.context_dir / "context_log.md"
            ),
            "project_tree": self.read_if_exists(
                self.context_dir / "project_tree.md"
            ),
        }

    def build_plan(self, task: TaskSpec) -> list[str]:
        return [
            "Load mission and persistent context.",
            f"Apply {task.operation['type']} to {task.target_file}.",
            f"Run validation command: {' '.join(task.test_command)}.",
            f"Write completion report to {task.report_file}.",
        ]

    def apply_operation(self, task: TaskSpec) -> str:
        target_file = self.resolve_repo_path(task.target_file)
        target_file.parent.mkdir(parents=True, exist_ok=True)
        operation_type = task.operation["type"]

        if operation_type == "append_text":
            content = task.operation["content"]
            self.append_text(target_file, content)
            return f"Appended {len(content)} characters to {task.target_file}."

        existing = self.read_if_exists(target_file)
        old_text = task.operation.get("old_text", "")
        new_text = task.operation.get("new_text", "")
        if old_text not in existing:
            raise ValueError(
                f"Text to replace was not found in {task.target_file}."
            )

        updated = existing.replace(old_text, new_text, 1)
        target_file.write_text(updated, encoding="utf-8")
        return f"Replaced text in {task.target_file}."

    def handle_failure(
        self,
        task: TaskSpec,
        started_at: str,
        error: Exception,
    ) -> None:
        error_message = str(error)
        self.write_current_task_lock(
            task,
            status="blocked",
            mode="Debug",
            started_at=started_at,
            updated_at=self.timestamp(),
            note=error_message,
        )
        self.record_step(
            mode="Debug",
            task_summary=task.summary,
            tool="capture_failure",
            target_file="ai_coder/logs/tool_failures.md",
            outcome=error_message,
            task_type="blocked",
            trace=(
                "<thinking> Task execution failed and Roo entered a blocked "
                "state. </thinking>"
            ),
            context_summary=(
                f"Task {task.task_id} failed: {error_message}"
            ),
        )
        self.append_text(
            self.logs_dir / "tool_failures.md",
            (
                f"[{self.timestamp()}] Task {task.task_id} failed: "
                f"{error_message}"
            ),
        )
        self.append_text(
            self.logs_dir / "recovery_log.md",
            (
                f"[{self.timestamp()}] Recovery required for {task.task_id}: "
                f"{error_message}"
            ),
        )

    def write_report(
        self,
        task: TaskSpec,
        plan: list[str],
        memory: dict[str, str],
        test_output: str,
        success: bool = True,
    ) -> Path:
        report_file = self.resolve_repo_path(task.report_file)
        report_file.parent.mkdir(parents=True, exist_ok=True)
        status = "completed" if success else "blocked"
        content = "\n".join(
            [
                "# Roo Task Report",
                "",
                f"- Task ID: {task.task_id}",
                f"- Status: {status}",
                f"- Summary: {task.summary}",
                f"- Target File: {task.target_file}",
                f"- Generated At: {self.timestamp()}",
                "",
                "## Plan",
                "",
                *[f"- {item}" for item in plan],
                "",
                "## Mission Snapshot",
                "",
                memory["mission"].strip() or "Mission file is empty.",
                "",
                "## Context Snapshot",
                "",
                memory["context_log"].strip() or "Context log is empty.",
                "",
                "## Validation Output",
                "",
                "```text",
                test_output.strip() or "No validation output recorded.",
                "```",
                "",
            ]
        )
        report_file.write_text(content, encoding="utf-8")
        return report_file

    def append_test_outcome(
        self,
        task: TaskSpec,
        result: subprocess.CompletedProcess[str],
        output: str,
    ) -> None:
        status = "passed" if result.returncode == 0 else "failed"
        entry = "\n".join(
            [
                f"[{self.timestamp()}] Task {task.task_id} {status}",
                f"Command: {' '.join(task.test_command)}",
                output.strip() or "No test output captured.",
                "",
            ]
        )
        self.append_text(self.status_dir / "test_outcomes.md", entry)

    def record_step(
        self,
        mode: str,
        task_summary: str,
        tool: str,
        target_file: str,
        outcome: str,
        task_type: str,
        trace: str,
        context_summary: str,
    ) -> None:
        timestamp = self.timestamp()
        self.append_text(
            self.logs_dir / "execution_trace.log",
            f"[{timestamp}] {mode}: {trace}",
        )
        self.append_text(
            self.logs_dir / "task_history.log",
            "\n".join(
                [
                    f"=== ACTION @ {timestamp} ===",
                    f"Mode: {mode}",
                    f"Task: {task_summary}",
                    f"Tool: {tool}",
                    f"Target file: {target_file}",
                    "Trigger: Roo task runner execution",
                    f"Outcome: {outcome}",
                ]
            ),
        )
        self.append_text(
            self.status_dir / "checklist.md",
            (
                f"[{timestamp}] Mode: {mode}, Task: {task_summary}, "
                f"Tool: {tool}, File: {target_file}, Status: ✅, "
                f"task-type: {task_type}"
            ),
        )
        self.append_text(
            self.context_dir / "context_log.md",
            f"{timestamp} - {context_summary}",
        )
        self.append_text(
            self.status_dir / "mode_switches.log",
            f"[{timestamp}] Mode: {mode}, Reason: {outcome}",
        )

    def write_current_task_lock(
        self,
        task: TaskSpec,
        status: str,
        mode: str,
        started_at: str,
        updated_at: str,
        note: str,
    ) -> None:
        content = "\n".join(
            [
                "# Current Task Lock",
                "",
                f"task_id: {task.task_id}",
                f"status: {status}",
                f"mode: {mode}",
                f"summary: {task.summary}",
                f"description: {task.description}",
                f"target_file: {task.target_file}",
                f"report_file: {task.report_file}",
                f"started_at: {started_at}",
                f"updated_at: {updated_at}",
                f"note: {note}",
                "",
            ]
        )
        (self.context_dir / "current_task.lock").write_text(
            content,
            encoding="utf-8",
        )

    def resolve_repo_path(self, relative_path: str) -> Path:
        resolved = (self.repo_root / relative_path).resolve()
        if (
            self.repo_root != resolved
            and self.repo_root not in resolved.parents
        ):
            raise ValueError(f"Path escapes repository root: {relative_path}")
        return resolved

    def append_text(self, file_path: Path, text: str) -> None:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        existing = self.read_if_exists(file_path)
        base = "" if not existing.strip() else existing.rstrip("\n") + "\n"
        payload = text if text.endswith("\n") else text + "\n"
        file_path.write_text(base + payload, encoding="utf-8")

    def read_if_exists(self, file_path: Path) -> str:
        if file_path.exists():
            return file_path.read_text(encoding="utf-8")
        return ""

    def normalize_task_path(self, task_file: Path) -> str:
        task_path = task_file.resolve()
        if self.repo_root in task_path.parents:
            relative = task_path.relative_to(self.repo_root)
            return str(relative).replace("\\", "/")
        return str(task_file).replace("\\", "/")

    def format_test_output(
        self,
        result: subprocess.CompletedProcess[str],
    ) -> str:
        parts = []
        if result.stdout:
            parts.append(result.stdout.strip())
        if result.stderr:
            parts.append(result.stderr.strip())
        return "\n".join(part for part in parts if part)

    def timestamp(self) -> str:
        return datetime.now(timezone.utc).strftime(TIMESTAMP_FORMAT)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Run a deterministic Roo task by loading mission/context, "
            "editing a file, running validation, and writing logs."
        )
    )
    task_group = parser.add_mutually_exclusive_group(required=True)
    task_group.add_argument(
        "--task-file",
        help=(
            "Path to the JSON task definition relative to the repository root."
        ),
    )
    task_group.add_argument(
        "--next-task",
        action="store_true",
        help="Run the next pending queued task found in checklist.md.",
    )
    parser.add_argument(
        "--repo-root",
        default=None,
        help="Optional repository root. Defaults to the parent of ai_coder/.",
    )
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    script_root = Path(__file__).resolve().parent.parent
    repo_root = (
        Path(args.repo_root).resolve() if args.repo_root else script_root
    )
    runner = RooTaskRunner(repo_root)
    if args.next_task:
        result = runner.run_next_task()
    else:
        result = runner.run_task(repo_root / args.task_file)
    if result.success:
        print(f"Task completed. Report: {result.report_file}")
        return 0

    print(f"Task blocked. Report: {result.report_file}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
