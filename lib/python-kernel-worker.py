import ast
import base64
import contextlib
import io
import json
import os
import sys
import traceback

os.environ.setdefault("MPLBACKEND", "Agg")

_SELVA_MATPLOTLIB = None
_SELVA_PLT = None
try:
    import matplotlib as _SELVA_MATPLOTLIB

    try:
        _SELVA_MATPLOTLIB.use("Agg", force=True)
    except Exception:
        pass

    try:
        import matplotlib.pyplot as _SELVA_PLT

        _SELVA_PLT.show = lambda *args, **kwargs: None
    except Exception:
        _SELVA_PLT = None
except Exception:
    _SELVA_MATPLOTLIB = None
    _SELVA_PLT = None


SELVA_GLOBALS = {"__name__": "__main__"}


def _capture_open_figures(stdout_buffer):
    if _SELVA_PLT is None:
        return

    current_output = stdout_buffer.getvalue()
    if "IMG:" in current_output:
        return

    fig_nums = list(_SELVA_PLT.get_fignums())
    for fig_num in fig_nums:
        fig = _SELVA_PLT.figure(fig_num)
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=120, bbox_inches="tight")
        buf.seek(0)
        print("IMG:" + base64.b64encode(buf.getvalue()).decode())

    if fig_nums:
        _SELVA_PLT.close("all")


def _execute_cell(source):
    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()
    suppress_display = source.rstrip().endswith(";")

    try:
        tree = ast.parse(source, filename="<selva-cell>", mode="exec")
        last_expr = None
        if (not suppress_display) and tree.body and isinstance(tree.body[-1], ast.Expr):
            last_expr = tree.body.pop().value
        ast.fix_missing_locations(tree)

        with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
            exec(compile(tree, "<selva-cell>", "exec"), SELVA_GLOBALS, SELVA_GLOBALS)
            if last_expr is not None:
                expr = ast.Expression(last_expr)
                ast.fix_missing_locations(expr)
                value = eval(
                    compile(expr, "<selva-cell>", "eval"),
                    SELVA_GLOBALS,
                    SELVA_GLOBALS,
                )
                if value is not None:
                    print(repr(value))
            _capture_open_figures(stdout_buffer)
    except Exception:
        traceback.print_exc(file=stderr_buffer)
        if _SELVA_PLT is not None:
            try:
                _SELVA_PLT.close("all")
            except Exception:
                pass
        return {
            "ok": False,
            "stdout": stdout_buffer.getvalue(),
            "stderr": stderr_buffer.getvalue(),
        }

    return {
        "ok": True,
        "stdout": stdout_buffer.getvalue(),
        "stderr": stderr_buffer.getvalue(),
    }


for raw_line in sys.stdin:
    line = raw_line.strip()
    if not line:
        continue

    response = {"id": "", "ok": False, "stdout": "", "stderr": ""}
    try:
        message = json.loads(line)
        response["id"] = str(message.get("id", ""))
        msg_type = str(message.get("type", "execute"))

        if msg_type == "shutdown":
            response["ok"] = True
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
            break

        if msg_type != "execute":
            raise ValueError(f"Unsupported message type: {msg_type}")

        code_b64 = str(message.get("code_b64", ""))
        source = base64.b64decode(code_b64).decode("utf-8")
        response.update(_execute_cell(source))
    except Exception:
        response["stderr"] = traceback.format_exc()

    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()
