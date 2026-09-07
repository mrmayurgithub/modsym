declare const got: Got;
export default got;
export { got };
export { default as Options } from './core/options.js';
export interface Got {
  (url: string): Promise<string>;
}
