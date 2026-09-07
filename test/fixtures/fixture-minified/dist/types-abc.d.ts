declare const L: Mutator;
export { L as mutateAlias };
declare const mutate: ScopedMutator;
export { mutate as L };
interface ScopedMutator {
  (key: string): void;
}
interface Mutator {
  (key: string): void;
}
