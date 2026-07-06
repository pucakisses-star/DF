/**
 * Rawcode utilities and the collision-avoiding ID allocator.
 */
import { PorterError } from './formats';

/** A rawcode is exactly 4 printable ASCII characters. */
export function isRawcode(value: string): boolean {
  return value.length === 4 && /^[\x21-\x7e]{4}$/.test(value);
}

/**
 * Does this string look like a comma-separated list of rawcodes?
 * (This is how object fields store ability lists, trained-unit lists, etc.)
 */
export function isRawcodeList(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  return value.split(',').every((token) => isRawcode(token));
}

const ALLOC_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Allocates fresh rawcodes that collide with nothing already seen.
 *
 * Generated IDs keep the original's first character (World Editor convention:
 * 'h' human unit, 'A' ability, 'I' item, ...) followed by three characters
 * from [0-9A-Z] that always include at least one digit — standard Blizzard
 * rawcodes are letters-only, so generated IDs can never shadow a stock object.
 */
export class IdAllocator {
  private used = new Set<string>();

  constructor(used?: Iterable<string>) {
    if (used) {
      for (const id of used) {
        this.used.add(id);
      }
    }
  }

  has(id: string): boolean {
    return this.used.has(id);
  }

  /** Reserve an ID chosen outside the allocator (e.g. kept source IDs, manifest entries). */
  claim(id: string): void {
    this.used.add(id);
  }

  allocate(likeId: string): string {
    if (!isRawcode(likeId)) {
      throw new PorterError(`Cannot allocate an ID similar to invalid rawcode ${JSON.stringify(likeId)}`);
    }
    const prefix = likeId[0];
    for (let n = 0; n < ALLOC_CHARS.length ** 3; n++) {
      const c1 = ALLOC_CHARS[Math.floor(n / (ALLOC_CHARS.length * ALLOC_CHARS.length)) % ALLOC_CHARS.length];
      const c2 = ALLOC_CHARS[Math.floor(n / ALLOC_CHARS.length) % ALLOC_CHARS.length];
      const c3 = ALLOC_CHARS[n % ALLOC_CHARS.length];
      if (!/\d/.test(c1 + c2 + c3)) {
        continue;
      }
      const candidate = prefix + c1 + c2 + c3;
      if (!this.used.has(candidate)) {
        this.used.add(candidate);
        return candidate;
      }
    }
    throw new PorterError(`Rawcode space exhausted for prefix '${prefix}'`);
  }
}
