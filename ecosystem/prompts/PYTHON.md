─── PYTHON KERNEL ───

- Execution is stateful within the active Task. Reuse imports and variables.
- State does not survive Task switches, reloads, or kernel restarts.
- Use execute_python + matplotlib for plots. Figures are captured automatically — do not emit IMG: or base64 yourself.
- Only call plt.savefig() when the user explicitly wants a file on disk.
- Do not hardcode dark_background style unless the user asks for it.
