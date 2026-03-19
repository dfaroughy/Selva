/**
 * Type-preserving value coercion for YAML config fields.
 * Ensures that setting a number field with a string "0.01" stays a number,
 * and setting a boolean field with "true" stays a boolean.
 */
function coerceValue(existing, newValue) {
  if (typeof existing === 'number' && typeof newValue !== 'number') {
    const num = Number(newValue);
    return Number.isNaN(num) ? newValue : num;
  }
  if (typeof existing === 'boolean' && typeof newValue !== 'boolean') {
    return String(newValue).toLowerCase() === 'true';
  }
  return newValue;
}

module.exports = { coerceValue };
