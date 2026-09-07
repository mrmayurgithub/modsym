declare function create$1(): TupleSchema;
declare function create$2(): ArraySchema;
interface TupleSchema { kind: "tuple"; }
interface ArraySchema { kind: "array"; }
export interface Schema { validate(value: unknown): boolean; }
export { create$1 as tuple, create$2 as array, Schema };
