(function(input) {
  if (!state.configs[input.file]) return 'file not found: ' + input.file;
  lockAllFieldsInFile(input.file);
  return 'locked all fields in ' + input.file;
})
