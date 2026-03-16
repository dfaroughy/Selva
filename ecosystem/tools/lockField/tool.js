(function(input) {
  const path = normalizePath(input.path);
  const key = input.file + ':' + JSON.stringify(path);
  state.lockedFields.add(key);
  return 'locked ' + input.file + ':' + path.join('.');
})
