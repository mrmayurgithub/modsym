interface ClientStatic {
  (url: string): Promise<string>;
}
declare const client: ClientStatic;
export default client;
