(function(input) {
  const file = input.file;
  const type = input.fileType;
  if (!state.configs[file] && !state.files.includes(file)) return 'file not found: ' + file;
  if (type !== 'config' && type !== 'data') return 'invalid type: ' + type;
  const oldType = state.fileTypes[file];
  state.fileTypes[file] = type;
  if (type === 'data' && oldType !== 'data') {
    lockAllFieldsInFile(file);
    if (state.activeConfigFile === file) {
      const configFiles = state.files.filter(f => state.fileTypes[f] !== 'data');
      state.activeConfigFile = configFiles[0] || null;
    }
    if (!state.activeDataFile) state.activeDataFile = file;
  } else if (type === 'config' && oldType === 'data') {
    for (const key of [...state.lockedFields]) {
      if (key.startsWith(file + ':')) state.lockedFields.delete(key);
    }
    if (state.activeDataFile === file) {
      const dataFiles = state.files.filter(f => state.fileTypes[f] === 'data');
      state.activeDataFile = dataFiles.find(f => f !== file) || null;
    }
    if (!state.activeConfigFile) state.activeConfigFile = file;
  }
  state.activeFile = state.activeConfigFile || state.activeDataFile;
  return file + ' \u2192 ' + type;
})
