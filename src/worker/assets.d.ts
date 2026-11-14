/** Vite asset imports used by the Worker bundle. */

declare module "*.woff?inline" {
  const dataUri: string;
  export default dataUri;
}
