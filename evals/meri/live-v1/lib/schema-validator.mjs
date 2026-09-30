function typeMatches(value, expected) {
  if (expected === 'null') return value === null;
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'integer') return Number.isInteger(value);
  return typeof value === expected;
}

function pointerValue(root, pointer) {
  if (!pointer.startsWith('#/')) throw new Error(`unsupported schema reference ${pointer}`);
  return pointer.slice(2).split('/').reduce((value, part) => value?.[part.replace(/~1/gu, '/').replace(/~0/gu, '~')], root);
}

export function validateJsonSchema(value, schema, { path = '$', rootSchema = schema } = {}) {
  const errors = [];
  const visit = (current, rule, currentPath) => {
    if (!rule || typeof rule !== 'object') {
      errors.push(`${currentPath}: malformed schema rule`);
      return;
    }
    if (rule.$ref) {
      const target = pointerValue(rootSchema, rule.$ref);
      if (!target) errors.push(`${currentPath}: unresolved schema reference ${rule.$ref}`);
      else visit(current, target, currentPath);
      return;
    }
    if (Array.isArray(rule.allOf)) for (const child of rule.allOf) visit(current, child, currentPath);
    if (Array.isArray(rule.anyOf)) {
      const alternatives = rule.anyOf.map((child) => validateJsonSchema(current, child, { path: currentPath, rootSchema }));
      if (!alternatives.some((alternative) => alternative.length === 0)) errors.push(`${currentPath}: does not match any allowed shape`);
      return;
    }
    if (Object.hasOwn(rule, 'const') && !Object.is(current, rule.const)) errors.push(`${currentPath}: must equal ${JSON.stringify(rule.const)}`);
    if (Array.isArray(rule.enum) && !rule.enum.some((candidate) => Object.is(current, candidate))) {
      errors.push(`${currentPath}: must be one of ${rule.enum.map((item) => JSON.stringify(item)).join(', ')}`);
    }
    if (rule.type) {
      const expectedTypes = Array.isArray(rule.type) ? rule.type : [rule.type];
      if (!expectedTypes.some((expected) => typeMatches(current, expected))) {
        errors.push(`${currentPath}: expected ${expectedTypes.join('|')}`);
        return;
      }
    }
    if (typeof current === 'string') {
      if (Number.isInteger(rule.minLength) && current.length < rule.minLength) errors.push(`${currentPath}: string is too short`);
      if (rule.pattern && !(new RegExp(rule.pattern, 'u')).test(current)) errors.push(`${currentPath}: does not match ${rule.pattern}`);
    }
    if (typeof current === 'number') {
      if (typeof rule.minimum === 'number' && current < rule.minimum) errors.push(`${currentPath}: is below minimum ${rule.minimum}`);
      if (typeof rule.maximum === 'number' && current > rule.maximum) errors.push(`${currentPath}: exceeds maximum ${rule.maximum}`);
    }
    if (Array.isArray(current)) {
      if (Number.isInteger(rule.minItems) && current.length < rule.minItems) errors.push(`${currentPath}: requires at least ${rule.minItems} items`);
      if (rule.items) current.forEach((item, index) => visit(item, rule.items, `${currentPath}[${index}]`));
    }
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      const properties = rule.properties ?? {};
      for (const required of rule.required ?? []) {
        if (!Object.hasOwn(current, required)) errors.push(`${currentPath}.${required}: required property is missing`);
      }
      for (const [key, child] of Object.entries(current)) {
        if (Object.hasOwn(properties, key)) visit(child, properties[key], `${currentPath}.${key}`);
        else if (rule.additionalProperties === false) errors.push(`${currentPath}.${key}: additional property is not allowed`);
        else if (rule.additionalProperties && typeof rule.additionalProperties === 'object') visit(child, rule.additionalProperties, `${currentPath}.${key}`);
      }
    }
  };
  visit(value, schema, path);
  return errors;
}
