/** Accept stable Bun releases at or above the tested minimum. */
export function isSupportedBunVersion(actual: string, minimum: string): boolean {
  const parse = (version: string): number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    return match ? match.slice(1).map(Number) : undefined;
  };
  const current = parse(actual);
  const floor = parse(minimum);
  if (!current || !floor) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]! > floor[index]!) return true;
    if (current[index]! < floor[index]!) return false;
  }
  return true;
}
