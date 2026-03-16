(function(input) {
  const path = normalizePath(input.path);
  const config = state.configs[input.file];
  if (!config) return 'file not found: ' + input.file;
  const existing = getNestedValue(config.current, path);
  if (existing === undefined) return 'path not found: ' + JSON.stringify(path);
  const orig = getNestedValue(config.original, path);
  let coerced = input.value;
  if (typeof orig === 'number' && typeof input.value !== 'number') {
    const n = Number(input.value); coerced = isNaN(n) ? input.value : n;
  } else if (typeof orig === 'boolean' && typeof input.value !== 'boolean') {
    coerced = String(input.value).toLowerCase() === 'true';
  }
  setNestedValue(config.current, path, coerced);
  return input.file + ':' + path.join('.') + ' = ' + JSON.stringify(coerced);
})
