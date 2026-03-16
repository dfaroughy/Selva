(function(input) {
  const path = normalizePath(input.path);
  if (!state.pinned[input.file]) state.pinned[input.file] = [];
  const k = pathKey(path);
  if (!state.pinned[input.file].some(p => pathKey(p) === k)) {
    state.pinned[input.file].push([...path]);
    savePinned();
  }
  return 'pinned ' + input.file + ':' + path.join('.');
})
