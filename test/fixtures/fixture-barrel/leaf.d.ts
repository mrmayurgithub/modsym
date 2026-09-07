export declare function widget(opts?: WidgetOptions): Widget;
export interface WidgetOptions {
  size?: number;
}
export interface Widget {
  render(): string;
}
