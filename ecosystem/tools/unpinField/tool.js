(function(input) {
  const path = normalizePath(input.path);
  const k = pathKey(path);
  if (state.pinned[input.file]) {
    state.pinned[input.file] = state.pinned[input.file].filter(p => pathKey(p) !== k);
    savePinned();
  }
  return 'unpinned ' + input.file + ':' + path.join('.');
})
