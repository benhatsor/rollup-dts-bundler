/**
 * rollup-dts-bundler
 * @license MIT
 */
import type { Plugin as Plugin_2 } from 'rollup';

declare function dts(opts?: DtsOptions): Plugin_2;
export default dts;

export declare interface DtsOptions {
    /**
     * Path to a tsconfig.json (relative to cwd, or absolute). If omitted, each
     * entry uses its own nearest tsconfig, and entries under different configs
     * are processed separately.
     */
    tsconfig?: string;
    /**
     * npm package names whose declarations should be inlined into the output
     * instead of left as external imports — useful for re-exporting types from
     * internal workspace packages.
     */
    bundledPackages?: string[];
}

export { }
