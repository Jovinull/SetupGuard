import type { AnyAdapter } from './adapter.js';

/**
 * Ordered set of adapters available to a run.
 *
 * Registration is explicit: the CLI, the future VS Code extension and the
 * future GitHub Action each decide which adapters to load. There is no
 * implicit filesystem-based plug-in discovery in v0.1 — loading third-party
 * code would need a trust model that does not exist yet
 * (`Notes/09-seguranca-e-confiabilidade.md`).
 */
export class AdapterRegistry {
  readonly #adapters = new Map<string, AnyAdapter>();

  constructor(adapters: readonly AnyAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: AnyAdapter): this {
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`Adapter "${adapter.id}" is already registered`);
    }
    assertNamespacedCheckIds(adapter);
    this.#adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: string): AnyAdapter | undefined {
    return this.#adapters.get(id);
  }

  list(): AnyAdapter[] {
    return [...this.#adapters.values()];
  }

  get size(): number {
    return this.#adapters.size;
  }
}

/**
 * Check ids must be prefixed with their adapter id. This keeps ids collision-free
 * across third-party adapters and lets any interface map a finding back to the
 * code that produced it.
 */
function assertNamespacedCheckIds(adapter: AnyAdapter): void {
  const seen = new Set<string>();
  for (const check of adapter.checks) {
    if (!check.id.startsWith(`${adapter.id}/`)) {
      throw new Error(
        `Check "${check.id}" must be namespaced as "${adapter.id}/<name>" by adapter "${adapter.id}"`,
      );
    }
    if (seen.has(check.id)) {
      throw new Error(`Adapter "${adapter.id}" declares duplicate check id "${check.id}"`);
    }
    seen.add(check.id);
  }
}
