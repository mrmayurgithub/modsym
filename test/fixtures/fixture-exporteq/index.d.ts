declare namespace tool {
  interface Options {
    verbose?: boolean;
  }
}
declare function tool(options?: tool.Options): tool.Handle;
declare namespace tool {
  interface Handle {
    close(): void;
  }
}
export = tool;
