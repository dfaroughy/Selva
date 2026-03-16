(function(input) {
  const path = normalizePath(input.path);
  const key = input.file + ':' + JSON.stringify(path);
  state.lockedFields.delete(key);
  return 'unlocked ' + input.file + ':' + path.join('.');
})
