import ast
import base64
import contextlib
import io
import json
import os
import signal
import sys
import traceback

os.environ.setdefault("MPLBACKEND", "Agg")

# Defer SIGINT at module level: signals arriving during imports or between
# executions are recorded but do not kill the worker.  SIGINT is temporarily
# restored to the default handler inside _execute_cell so that user code
# (e.g. time.sleep) can be interrupted normally.  Any deferred interrupt
# is delivered when the next execution starts.
_pending_interrupt = False

def _deferred_sigint_handler(sig, frame):
    global _pending_interrupt
    _pending_interrupt = True

signal.signal(signal.SIGINT, _deferred_sigint_handler)

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


class StreamingStdout:
    """Wraps stdout to capture output AND emit stream messages."""

    def __init__(self, request_id):
        self.request_id = request_id
        self.buffer = io.StringIO()

    def write(self, text):
        self.buffer.write(text)
        if text:
            try:
                msg = json.dumps({"id": self.request_id, "type": "stream", "text": text})
                sys.__stdout__.write(msg + "\n")
                sys.__stdout__.flush()
            except (IOError, OSError):
                pass

    def flush(self):
        pass

    def getvalue(self):
        return self.buffer.getvalue()


def _execute_cell(source, request_id=""):
    stdout_buffer = StreamingStdout(request_id)
    stderr_buffer = io.StringIO()
    suppress_display = source.rstrip().endswith(";")

    try:
        tree = ast.parse(source, filename="<selva-cell>", mode="exec")
        last_expr = None
        if (not suppress_display) and tree.body and isinstance(tree.body[-1], ast.Expr):
            last_expr = tree.body.pop().value
        ast.fix_missing_locations(tree)

        with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
            # Restore default SIGINT handler so user code can be interrupted
            global _pending_interrupt
            signal.signal(signal.SIGINT, signal.default_int_handler)
            try:
                # Deliver any SIGINT that arrived while we were not in execution
                if _pending_interrupt:
                    _pending_interrupt = False
                    raise KeyboardInterrupt()
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
            finally:
                # Re-defer SIGINT before leaving user code context
                signal.signal(signal.SIGINT, _deferred_sigint_handler)
                _pending_interrupt = False
            _capture_open_figures(stdout_buffer)
    except BaseException as error:
        if isinstance(error, KeyboardInterrupt):
            stderr_buffer.write("KeyboardInterrupt\n")
        else:
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
        response.update(_execute_cell(source, request_id=response["id"]))
    except BaseException as error:
        if isinstance(error, KeyboardInterrupt):
            response["stderr"] = "KeyboardInterrupt\n"
        else:
            response["stderr"] = traceback.format_exc()

    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()
