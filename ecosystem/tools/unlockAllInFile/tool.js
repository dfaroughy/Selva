(function(input) {
  if (!state.configs[input.file]) return 'file not found: ' + input.file;
  for (const key of [...state.lockedFields]) {
    if (key.startsWith(input.file + ':')) state.lockedFields.delete(key);
  }
  return 'unlocked all fields in ' + input.file;
})
