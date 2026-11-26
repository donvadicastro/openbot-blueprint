export function greeting(name) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('A name is required.');
  return `Hello, ${name.trim()}!`;
}
