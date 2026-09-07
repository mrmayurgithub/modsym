interface MakerOptions {
  prefix?: string;
}
declare function make(options?: MakerOptions): Maker;
declare function make(name: string, options?: MakerOptions): Maker;
declare const readyMade: Maker;
interface Maker {
  build(): string;
}
export { make, readyMade, type Maker, type MakerOptions };
