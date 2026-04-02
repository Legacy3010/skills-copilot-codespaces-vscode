import io
import json
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import gemini_mcp_server


class GeminiMcpServerTests(unittest.TestCase):
    def test_gemini_ask_returns_output_on_success(self):
        def runner(*args, **kwargs):
            return SimpleNamespace(stdout="hello\n")

        response = gemini_mcp_server.gemini_ask(
            "Say hello",
            runner=runner,
            base_dir="D:/repo/ai_coder/copilot_skills",
        )

        self.assertEqual(response, {"output": "hello"})

    def test_gemini_ask_requires_prompt(self):
        response = gemini_mcp_server.gemini_ask("   ")

        self.assertEqual(
            response,
            {"error": "Prompt is required for gemini_ask."},
        )

    def test_gemini_ask_surfaces_auth_hint(self):
        error = subprocess.CalledProcessError(
            1,
            ["gemini"],
            stderr=(
                "Please set an Auth method in settings.json OR specify "
                "GEMINI_API_KEY env variable"
            ),
        )

        def failing_runner(*args, **kwargs):
            raise error

        response = gemini_mcp_server.gemini_ask(
            "Say hello",
            runner=failing_runner,
            base_dir="D:/repo/ai_coder/copilot_skills",
        )

        self.assertEqual(
            response,
            {"error": gemini_mcp_server.AUTH_ERROR_HINT},
        )

    def test_gemini_ask_reports_missing_binary(self):
        def missing_runner(*args, **kwargs):
            raise FileNotFoundError()

        response = gemini_mcp_server.gemini_ask(
            "Say hello",
            runner=missing_runner,
            base_dir="D:/repo/ai_coder/copilot_skills",
        )

        self.assertIn("npm install", response["error"])

    def test_process_input_line_rejects_invalid_json(self):
        response = gemini_mcp_server.process_input_line("not-json\n")

        self.assertEqual(response, {"error": "Invalid JSON request."})

    def test_process_input_line_rejects_non_object_payloads(self):
        response = gemini_mcp_server.process_input_line('["gemini_ask"]\n')

        self.assertEqual(
            response,
            {"error": "Request body must be a JSON object."},
        )

    def test_handle_request_rejects_unknown_tools(self):
        response = gemini_mcp_server.handle_request({"tool": "unknown"})

        self.assertEqual(response, {"error": "Unsupported tool: unknown"})

    def test_main_writes_json_response_per_line(self):
        stdin = io.StringIO(
            json.dumps({"tool": "gemini_ask", "prompt": "Say hello"}) + "\n"
        )
        stdout = io.StringIO()

        with patch.object(
            gemini_mcp_server,
            "gemini_ask",
            return_value={"output": "hello"},
        ):
            gemini_mcp_server.main(stdin=stdin, stdout=stdout)

        self.assertEqual(stdout.getvalue(), '{"output": "hello"}\n')


if __name__ == "__main__":
    unittest.main()
