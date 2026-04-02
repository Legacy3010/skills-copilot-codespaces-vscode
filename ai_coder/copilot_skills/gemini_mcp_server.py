import json
import os
import subprocess
import sys


AUTH_ERROR_HINT = (
    "Gemini CLI is not authenticated. Configure "
    "C:/Users/<user>/.gemini/settings.json or set GEMINI_API_KEY."
)


def resolve_gemini_path(base_dir=None):
    base_dir = base_dir or os.path.dirname(__file__)
    executable = "gemini.cmd" if os.name == "nt" else "gemini"
    return os.path.join(base_dir, "node_modules", ".bin", executable)


def format_cli_error(error_text):
    error_text = (error_text or "").strip()
    if not error_text:
        return "Gemini CLI request failed."

    if "Auth method" in error_text or "GEMINI_API_KEY" in error_text:
        return AUTH_ERROR_HINT

    return error_text


def gemini_ask(prompt, runner=subprocess.run, base_dir=None):
    prompt = (prompt or "").strip()
    if not prompt:
        return {"error": "Prompt is required for gemini_ask."}

    gemini_path = resolve_gemini_path(base_dir)

    try:
        result = runner(
            [gemini_path, "-p", prompt],
            capture_output=True,
            text=True,
            check=True,
        )
    except FileNotFoundError:
        return {
            "error": (
                "Gemini CLI executable was not found. Run `npm install` in "
                "ai_coder/copilot_skills first."
            )
        }
    except subprocess.CalledProcessError as exc:
        return {"error": format_cli_error(exc.stderr or exc.stdout)}

    output = (result.stdout or "").strip()
    if not output:
        return {"error": "Gemini CLI returned no output."}

    return {"output": output}


def handle_request(request):
    tool = request.get("tool")
    if tool != "gemini_ask":
        return {"error": f"Unsupported tool: {tool}"}

    return gemini_ask(request.get("prompt", ""))


def process_input_line(line):
    try:
        request = json.loads(line)
    except json.JSONDecodeError:
        return {"error": "Invalid JSON request."}

    if not isinstance(request, dict):
        return {"error": "Request body must be a JSON object."}

    return handle_request(request)


def main(stdin=None, stdout=None):
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout

    for line in stdin:
        response = process_input_line(line)
        stdout.write(json.dumps(response) + "\n")
        stdout.flush()


if __name__ == "__main__":
    main()
