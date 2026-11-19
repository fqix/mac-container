// Command arguments. No vscode dependency.

/**
 * A command's extra argument when it is an options object: a plain object with at least one of `keys`. From the
 * explorer and editor menus VS Code passes the selection (a list of URIs) there instead, which must not be taken for
 * options; neither must anything else.
 */
export function optionsArgument<T extends object>(
  value: unknown,
  keys: readonly (keyof T & string)[],
): Partial<T> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return keys.some(key => key in value) ? (value as Partial<T>) : undefined;
}
