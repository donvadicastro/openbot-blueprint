// Dependency-free validation for the JSON Schema keywords used by our schema.
// The published schema can also be consumed by any Draft 2020-12 validator.
export interface Schema {
  $ref?: string;
  $defs?: Record<string, Schema>;
  type?: string;
  enum?: unknown[];
  const?: unknown;
  minLength?: number;
  pattern?: string;
  minimum?: number;
  minItems?: number;
  uniqueItems?: boolean;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  oneOf?: Schema[];
}

export function validateSchema(value: unknown, schema: Schema, root: Schema = schema, path = '$'): string[] {
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/\$defs\//, '');
    const target = root.$defs?.[name];
    if (!target) throw new Error(`Unsupported schema reference: ${schema.$ref}`);
    return validateSchema(value, target, root, path);
  }
  if (schema.oneOf) {
    const branches = schema.oneOf.map(branch => validateSchema(value, branch, root, path));
    if (branches.filter(errors => !errors.length).length !== 1) {
      return [`${path}: must match exactly one runtime variant`, ...branches.flat()];
    }
  }
  const errors: string[] = [];
  const fail = (message: string) => errors.push(`${path}: ${message}`);
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (schema.type && type !== schema.type) return [`${path}: expected ${schema.type}, got ${type}`];
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}`);
  if (schema.const !== undefined && value !== schema.const) fail(`must equal ${schema.const}`);
  if (typeof value === 'string') {
    if (schema.minLength && value.trim().length < schema.minLength) fail('must not be blank');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`must match ${schema.pattern}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) fail(`must be >= ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) fail(`needs at least ${schema.minItems} item(s)`);
    if (schema.uniqueItems && new Set(value.map(x => JSON.stringify(x))).size !== value.length) fail('duplicate items');
    if (schema.items) {
      const itemSchema = schema.items;
      value.forEach((item: unknown, i: number) => errors.push(...validateSchema(item, itemSchema, root, `${path}[${i}]`)));
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (property) errors.push(...validateSchema(item, property, root, `${path}.${key}`));
      else if (schema.additionalProperties === false) fail(`unknown property ${key}`);
    }
  }
  return errors;
}
